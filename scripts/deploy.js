import hre from "hardhat";

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

  console.log("Deployment complete.");
  console.log("-----------------------------------------");
  console.log("GLPToken:", glpTokenAddress);
  console.log("CreditScore:", creditScoreAddress);
  console.log("LendingPool:", lendingPoolAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
