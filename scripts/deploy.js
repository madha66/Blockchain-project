import hre from "hardhat";
import fs from "fs";
import path from "path";
import { defineAllParams } from "./config.js";

const FRONTEND_CONTRACTS_DIR = path.resolve("frontend/src/contracts");
const BACKEND_ENV_PATH = path.resolve("backend/.env");
const BACKEND_ENV_EXAMPLE = path.resolve("backend/.env.example");

// Hardhat account #9 — the backend's mock attester (backend/.env.example ATTESTER_PRIVATE_KEY).
const ATTESTER_ADDRESS = process.env.ATTESTER_ADDRESS || "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";

const BACKEND_ENV_KEYS = {
  IdentityRegistry: "IDENTITY_REGISTRY_ADDRESS",
  LoanManager: "LOAN_MANAGER_ADDRESS",
  DefaultManager: "DEFAULT_MANAGER_ADDRESS",
  LendingPool: "LENDING_POOL_ADDRESS",
  SafeRepayVault: "SAFE_REPAY_VAULT_ADDRESS",
  MockPayoutRouter: "PAYOUT_ROUTER_ADDRESS",
  PolicyConfig: "POLICY_CONFIG_ADDRESS",
  CreditScore: "CREDIT_SCORE_ADDRESS",
};

async function deployContract(name, args = []) {
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`${name.padEnd(18)} ${address}`);
  return contract;
}

/**
 * Deploys and wires the protocol. Returns { contracts, addresses }.
 */
async function deployAll({ overrides = {}, log = true } = {}) {
  const [deployer] = await hre.ethers.getSigners();
  if (log) console.log("Deploying with:", deployer.address);

  const policyConfig = await deployContract("PolicyConfig", [deployer.address]);
  await defineAllParams(policyConfig, overrides);

  const identityRegistry = await deployContract("IdentityRegistry", [
    deployer.address,
    ATTESTER_ADDRESS,
    await policyConfig.getAddress(),
  ]);

  const glpToken = await deployContract("GLPToken");
  const creditScore = await deployContract("CreditScore");
  const lendingPool = await deployContract("LendingPool", [
    await glpToken.getAddress(),
    await creditScore.getAddress(),
  ]);

  await (await glpToken.setLendingPool(await lendingPool.getAddress())).wait();
  await (await creditScore.setLendingPool(await lendingPool.getAddress())).wait();

  const contracts = { PolicyConfig: policyConfig, IdentityRegistry: identityRegistry, GLPToken: glpToken, CreditScore: creditScore, LendingPool: lendingPool };
  const addresses = {};
  for (const [name, c] of Object.entries(contracts)) addresses[name] = await c.getAddress();
  return { contracts, addresses };
}

function syncFrontend(addresses, chainId) {
  fs.mkdirSync(FRONTEND_CONTRACTS_DIR, { recursive: true });
  for (const name of Object.keys(addresses)) {
    const artifact = hre.artifacts.readArtifactSync(name);
    fs.writeFileSync(
      path.join(FRONTEND_CONTRACTS_DIR, `${name}.json`),
      JSON.stringify({ contractName: name, abi: artifact.abi }, null, 2)
    );
  }
  fs.writeFileSync(
    path.join(FRONTEND_CONTRACTS_DIR, "addresses.json"),
    JSON.stringify({ chainId, ...addresses }, null, 2) + "\n"
  );
  console.log(`[sync] ABIs and addresses.json written to ${FRONTEND_CONTRACTS_DIR}`);
}

function syncBackendEnv(addresses, chainId) {
  let env = fs.existsSync(BACKEND_ENV_PATH)
    ? fs.readFileSync(BACKEND_ENV_PATH, "utf8")
    : fs.existsSync(BACKEND_ENV_EXAMPLE)
      ? fs.readFileSync(BACKEND_ENV_EXAMPLE, "utf8")
      : "";
  const set = (key, value) => {
    const line = `${key}=${value}`;
    env = new RegExp(`^${key}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${env.trimEnd()}\n${line}\n`;
  };
  for (const [name, key] of Object.entries(BACKEND_ENV_KEYS)) {
    if (addresses[name]) set(key, addresses[name]);
  }
  set("CHAIN_ID", chainId);
  fs.writeFileSync(BACKEND_ENV_PATH, env);
  console.log(`[sync] contract addresses written to ${BACKEND_ENV_PATH}`);
}

async function main() {
  const { addresses } = await deployAll();
  const { chainId } = await hre.ethers.provider.getNetwork();
  syncFrontend(addresses, Number(chainId));
  syncBackendEnv(addresses, Number(chainId));
  console.log("\nDeployment complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
