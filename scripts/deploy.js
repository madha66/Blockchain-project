import hre from "hardhat";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { deployProtocol } from "./lib/protocol.js";
import { issuerWallet, registerWithIssuer } from "./lib/attest.js";
import { INR_PER_ETH_DEMO } from "./config.js";

const FRONTEND_CONTRACTS_DIR = path.resolve("frontend/src/contracts");
const BACKEND_ENV_PATH = path.resolve("backend/.env");
const BACKEND_ENV_EXAMPLE = path.resolve("backend/.env.example");

// Trusted identity issuer: Hardhat account #19 locally (backend ISSUER_PRIVATE_KEY).
const ISSUER_ADDRESS = issuerWallet().address;

// Demo lenders and keepers registered at deploy time. Accounts #0, #3, #4, #5, #7 are signed up
// through the backend by seed:demo, and #10-#18 are kept free for manual sign-up tests.
const DEMO_REGISTRATIONS = [1, 2, 6, 8];

const BACKEND_ENV_KEYS = {
  IdentityRegistry: "IDENTITY_REGISTRY_ADDRESS",
  LoanManager: "LOAN_MANAGER_ADDRESS",
  DefaultManager: "DEFAULT_MANAGER_ADDRESS",
  LendingPool: "LENDING_POOL_ADDRESS",
  SafeRepayVault: "SAFE_REPAY_VAULT_ADDRESS",
  MockPayoutRouter: "PAYOUT_ROUTER_ADDRESS",
  PolicyConfig: "POLICY_CONFIG_ADDRESS",
  CreditScore: "CREDIT_SCORE_ADDRESS",
  GLPToken: "GLP_TOKEN_ADDRESS",
  ReserveFund: "RESERVE_FUND_ADDRESS",
  DefaulterGovernance: "GOVERNANCE_ADDRESS",
};

async function deployAll() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Issuer:        ", ISSUER_ADDRESS);
  // Locally the deployer holds ADMIN_ROLE and DISPUTE_ROLE. Production: a Safe multisig.
  const contracts = await deployProtocol(hre.ethers, { admin: deployer, attester: ISSUER_ADDRESS, log: true });
  const byName = {
    PolicyConfig: contracts.config,
    IdentityRegistry: contracts.registry,
    GLPToken: contracts.glp,
    CreditScore: contracts.score,
    LendingPool: contracts.pool,
    ReserveFund: contracts.reserve,
    SafeRepayVault: contracts.vault,
    MockPayoutRouter: contracts.router,
    LoanManager: contracts.loanManager,
    RiskEngine: contracts.risk,
    DefaultManager: contracts.defaultManager,
    PortfolioLens: contracts.lens,
    DefaulterGovernance: contracts.governance,
  };
  const addresses = {};
  for (const [name, c] of Object.entries(byName)) addresses[name] = await c.getAddress();
  return { contracts: byName, addresses };
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
  const { contracts, addresses } = await deployAll();
  const signers = await hre.ethers.getSigners();
  for (const index of DEMO_REGISTRATIONS) {
    const signer = signers[index];
    if (!signer) continue;
    const memberId = await registerWithIssuer(contracts.IdentityRegistry, signer, {
      idHash: ethers.id(`giglend-demo-account-${index}`),
      incomeTierWei: ethers.parseEther("1"),
    });
    console.log(`Registered demo account #${index} ${signer.address} as member #${memberId}`);
  }
  const { chainId } = await hre.ethers.provider.getNetwork();
  syncFrontend(addresses, Number(chainId));
  syncBackendEnv(addresses, Number(chainId));
  console.log("\nDeployment complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
