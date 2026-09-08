import hre from "hardhat";
import fs from "fs";
import path from "path";

const FRONTEND_CONTRACTS_DIR = path.resolve("frontend/src/contracts");
const FRONTEND_HELPERS_PATH = path.resolve("frontend/src/utils/contractHelpers.js");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  // 1. Deploy GLPToken
  const GLPToken = await hre.ethers.getContractFactory("GLPToken");
  const glpToken = await GLPToken.deploy();
  await glpToken.waitForDeployment();
  const glpTokenAddress = await glpToken.getAddress();
  console.log("GLPToken deployed to:", glpTokenAddress);

  // 2. Deploy CreditScore
  const CreditScore = await hre.ethers.getContractFactory("CreditScore");
  const creditScore = await CreditScore.deploy();
  await creditScore.waitForDeployment();
  const creditScoreAddress = await creditScore.getAddress();
  console.log("CreditScore deployed to:", creditScoreAddress);

  // 3. Deploy LendingPool
  const LendingPool = await hre.ethers.getContractFactory("LendingPool");
  const lendingPool = await LendingPool.deploy(glpTokenAddress, creditScoreAddress);
  await lendingPool.waitForDeployment();
  const lendingPoolAddress = await lendingPool.getAddress();
  console.log("LendingPool deployed to:", lendingPoolAddress);

  // 4. Setup permissions
  await glpToken.setLendingPool(lendingPoolAddress);
  console.log("LendingPool set as owner in GLPToken");

  await creditScore.setLendingPool(lendingPoolAddress);
  console.log("LendingPool set as owner in CreditScore");

  console.log("\nDeployment complete.");
  console.log("-----------------------------------------");
  console.log("GLPToken:", glpTokenAddress);
  console.log("CreditScore:", creditScoreAddress);
  console.log("LendingPool:", lendingPoolAddress);

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Auto-sync frontend: copy fresh ABIs + update contract addresses
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[Auto-sync] Copying ABIs to frontend...");

  const contracts = [
    { name: "GLPToken",     artifact: "contracts/GLPToken.sol/GLPToken.json" },
    { name: "CreditScore",  artifact: "contracts/CreditScore.sol/CreditScore.json" },
    { name: "LendingPool",  artifact: "contracts/LendingPool.sol/LendingPool.json" },
  ];

  fs.mkdirSync(FRONTEND_CONTRACTS_DIR, { recursive: true });

  for (const { name, artifact } of contracts) {
    const src = path.resolve("artifacts", artifact);
    const dest = path.join(FRONTEND_CONTRACTS_DIR, `${name}.json`);
    fs.copyFileSync(src, dest);
    console.log(`[Auto-sync] Copied ${name}.json`);
  }

  console.log("[Auto-sync] Updating contractHelpers.js addresses...");
  const helpers = fs.readFileSync(FRONTEND_HELPERS_PATH, "utf8");
  const updated = helpers.replace(
    /export const CONTRACT_ADDRESSES = \{[\s\S]*?\};/,
    `export const CONTRACT_ADDRESSES = {\n  LendingPool: '${lendingPoolAddress}',\n  CreditScore: '${creditScoreAddress}',\n  GLPToken: '${glpTokenAddress}',\n};`
  );
  fs.writeFileSync(FRONTEND_HELPERS_PATH, updated, "utf8");
  console.log("[Auto-sync] contractHelpers.js updated with new addresses.");
  console.log("[Auto-sync] Done! Frontend is fully in sync.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
