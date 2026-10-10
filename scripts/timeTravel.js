import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION & CONTRACT RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const CONTRACT_HELPERS_PATH = path.resolve("frontend/src/utils/contractHelpers.js");
const LENDING_POOL_ARTIFACT_PATH = path.resolve("frontend/src/contracts/LendingPool.json");

/**
 * Dynamically resolves deployed contract addresses from contractHelpers.js
 */
export function getDeployedAddresses() {
  try {
    if (fs.existsSync(CONTRACT_HELPERS_PATH)) {
      const content = fs.readFileSync(CONTRACT_HELPERS_PATH, "utf8");
      const lpMatch = content.match(/LendingPool:\s*(?:import\.meta\.env\.\w+\s*\|\|\s*)?['"](0x[a-fA-F0-9]{40})['"]/);
      const csMatch = content.match(/CreditScore:\s*(?:import\.meta\.env\.\w+\s*\|\|\s*)?['"](0x[a-fA-F0-9]{40})['"]/);
      const glpMatch = content.match(/GLPToken:\s*(?:import\.meta\.env\.\w+\s*\|\|\s*)?['"](0x[a-fA-F0-9]{40})['"]/);

      if (lpMatch) {
        return {
          lendingPool: lpMatch[1],
          creditScore: csMatch ? csMatch[1] : null,
          glpToken: glpMatch ? glpMatch[1] : null,
        };
      }
    }
  } catch (err) {
    // fallback
  }

  // Fallback defaults for local Hardhat node deployment
  return {
    lendingPool: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    creditScore: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    glpToken: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  };
}

/**
 * Resolves the LendingPool ABI from frontend artifacts
 */
export function getLendingPoolAbi() {
  if (fs.existsSync(LENDING_POOL_ARTIFACT_PATH)) {
    const json = JSON.parse(fs.readFileSync(LENDING_POOL_ARTIFACT_PATH, "utf8"));
    return json.abi;
  }
  return [
    "function loans(address) view returns (uint256 principal, uint256 originationTime, uint256 dueDate, uint256 lastAccrualTime, uint256 accruedInterest, uint256 interestRateBps, uint256 tenureDays)",
    "function GRACE_PERIOD_DAYS() view returns (uint256)",
    "function secondsPerDay() view returns (uint256)",
    "function isDefaulter(address) view returns (bool)",
    "function markDefault(address borrower) external",
    "event DefaultSettled(address indexed borrower, uint256 sharesBurned, uint256 principalExtinguished, uint256 reserveCovered, uint256 writtenOffPrincipal, uint256 writtenOffInterest)"
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE EXPORTED FUNCTIONS FOR REVIEW / DEMO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advances the blockchain timestamp by a given number of days.
 * @param {number} days Number of days to fast-forward (default: 11 days).
 * @param {string} rpcUrl JSON-RPC endpoint.
 * @returns {Promise<{ previousTimestamp: number, newTimestamp: number, secondsAdded: number }>}
 */
export async function advanceBlockchainTime(days = 11, rpcUrl = RPC_URL) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const blockBefore = await provider.getBlock("latest");
  const previousTimestamp = blockBefore.timestamp;
  const secondsToAdd = Math.floor(days * 86400);

  console.log("\n============================================================");
  console.log(`⏱️  TIME TRAVEL INITIATED: Advancing ${days} Days (${secondsToAdd.toLocaleString()} seconds)`);
  console.log("============================================================");
  console.log(`Current Block: #${blockBefore.number}`);
  console.log(`Previous Time: ${new Date(previousTimestamp * 1000).toLocaleString()} (Unix: ${previousTimestamp})`);

  // Hardhat EVM RPC calls
  await provider.send("evm_increaseTime", [secondsToAdd]);
  await provider.send("evm_mine", []);

  const blockAfter = await provider.getBlock("latest");
  const newTimestamp = blockAfter.timestamp;

  console.log(`\n✅ Time Travel Successful!`);
  console.log(`New Block:     #${blockAfter.number}`);
  console.log(`New Time:      ${new Date(newTimestamp * 1000).toLocaleString()} (Unix: ${newTimestamp})`);
  console.log(`Delta:         +${((newTimestamp - previousTimestamp) / 86400).toFixed(2)} days\n`);

  return {
    previousTimestamp,
    newTimestamp,
    secondsAdded: newTimestamp - previousTimestamp,
  };
}

/**
 * Checks on-chain loan status for a borrower address.
 * @param {string} borrowerAddress Address of the borrower.
 * @param {string} rpcUrl JSON-RPC endpoint.
 */
export async function checkLoanStatus(borrowerAddress, rpcUrl = RPC_URL) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const addresses = getDeployedAddresses();
  const poolAbi = getLendingPoolAbi();
  const pool = new ethers.Contract(addresses.lendingPool, poolAbi, provider);

  const block = await provider.getBlock("latest");
  const now = block.timestamp;

  const loan = await pool.loans(borrowerAddress);
  const isDef = await pool.isDefaulter(borrowerAddress);

  const principal = loan.principal;
  const dueDate = Number(loan.dueDate);
  const tenureDays = Number(loan.tenureDays);
  const rateBps = Number(loan.interestRateBps);

  console.log(`------------------------------------------------------------`);
  console.log(`📋 Loan Status for Borrower: ${borrowerAddress}`);
  console.log(`------------------------------------------------------------`);
  console.log(`Defaulter Status:    ${isDef ? "🔴 YES (Marked in Default)" : "🟢 No (Good Standing)"}`);
  console.log(`Active Principal:    ${ethers.formatEther(principal)} ETH`);

  if (principal === 0n) {
    console.log(`No active unpaid loan found for this borrower.`);
    return { isActive: false, isDefaulter: isDef, canLiquidate: false };
  }

  const gracePeriodDays = 3; // Standard V2 grace period
  const gracePeriodEnd = dueDate + (gracePeriodDays * 86400);
  const isOverdue = now > dueDate;
  const pastGracePeriod = now > gracePeriodEnd;

  console.log(`Interest Rate (APR): ${(rateBps / 100).toFixed(2)}%`);
  console.log(`Tenure Duration:     ${tenureDays} days`);
  console.log(`Due Date:            ${new Date(dueDate * 1000).toLocaleString()}`);
  console.log(`Grace Period Ends:   ${new Date(gracePeriodEnd * 1000).toLocaleString()}`);
  console.log(`Current Block Time:  ${new Date(now * 1000).toLocaleString()}`);
  console.log(`Is Overdue:          ${isOverdue ? "⚠️ YES" : "✅ No"}`);
  console.log(`Past Grace Period:   ${pastGracePeriod ? "🚨 YES (ELIGIBLE FOR DEFAULT LIQUIDATION)" : "⏳ In Grace Period"}`);

  return {
    isActive: true,
    principal: ethers.formatEther(principal),
    isOverdue,
    pastGracePeriod,
    canLiquidate: pastGracePeriod && !isDef,
    isDefaulter: isDef,
  };
}

/**
 * Liquidates an overdue loan past grace period by calling markDefault.
 * @param {string} borrowerAddress Address of the borrower to liquidate.
 * @param {string} rpcUrl JSON-RPC endpoint.
 */
export async function liquidateDefault(borrowerAddress, rpcUrl = RPC_URL) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  // Account #1 (deployer / liquidator)
  const signer = await provider.getSigner(0);
  const addresses = getDeployedAddresses();
  const poolAbi = getLendingPoolAbi();
  const pool = new ethers.Contract(addresses.lendingPool, poolAbi, signer);

  console.log(`\n============================================================`);
  console.log(`⚡ EXECUTING ON-CHAIN DEFAULT LIQUIDATION`);
  console.log(`============================================================`);
  console.log(`Liquidator Signer: ${await signer.getAddress()}`);
  console.log(`Target Borrower:   ${borrowerAddress}`);
  console.log(`Pool Contract:     ${addresses.lendingPool}`);

  try {
    const tx = await pool.markDefault(borrowerAddress);
    console.log(`Transaction sent:  ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Mined in Block: #${receipt.blockNumber}`);

    // Parse DefaultSettled event
    const iface = new ethers.Interface(poolAbi);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === "DefaultSettled") {
          console.log("\n------------------------------------------------------------");
          console.log("🎉 DEFAULT SETTLED (Approach A Waterfall Breakdown):");
          console.log("------------------------------------------------------------");
          console.log(`• Borrower:               ${parsed.args[0]}`);
          console.log(`• GLP Shares Burned:      ${ethers.formatEther(parsed.args[1])} GLP (Stage 1 Set-Off)`);
          console.log(`• Principal Extinguished: ${ethers.formatEther(parsed.args[2])} ETH`);
          console.log(`• Insurance Reserve Used: ${ethers.formatEther(parsed.args[3])} ETH (Stage 2)`);
          console.log(`• Socialized Loss:        ${ethers.formatEther(parsed.args[4])} ETH (Stage 3)`);
          console.log(`• Accrued Interest W/O:   ${ethers.formatEther(parsed.args[5])} ETH`);
          console.log("------------------------------------------------------------\n");
          return { success: true, receipt, event: parsed.args };
        }
      } catch (e) {
        // Not a pool log
      }
    }

    return { success: true, receipt };
  } catch (error) {
    console.error(`\n❌ markDefault failed:`, error.message || error);
    return { success: false, error };
  }
}

/**
 * Combined function: Advances time AND immediately executes default liquidation.
 * Perfect for one-click reviewer/panelist demonstrations!
 * @param {number} days Days to fast forward (default: 11).
 * @param {string} borrowerAddress Target borrower address (optional, auto-detects if omitted).
 */
export async function timeTravelAndLiquidate(days = 11, borrowerAddress = null) {
  // 1. Advance Time
  await advanceBlockchainTime(days);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // 2. Identify Target Borrower
  let target = borrowerAddress;
  if (!target) {
    // Check known test accounts
    const testAccounts = [
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // Account A
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Account B
    ];

    for (const acc of testAccounts) {
      const status = await checkLoanStatus(acc);
      if (status.isActive && status.pastGracePeriod) {
        target = acc;
        break;
      }
    }
  } else {
    await checkLoanStatus(target);
  }

  // 3. Liquidate if an eligible borrower exists
  if (target) {
    console.log(`\nLiquidating identified overdue borrower: ${target}`);
    await liquidateDefault(target);
  } else {
    console.log("\nℹ️  No overdue borrower past grace period was found to liquidate.");
    console.log("Tip: If you want to test liquidation, create a loan in the browser first, then re-run this script!");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ? args[0].toLowerCase() : "auto";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`
GigLend V2 — Time Travel & Default Liquidation Panel Demo Tool
=============================================================
Usage:
  node scripts/timeTravel.js [days] [borrowerAddress]

Examples:
  node scripts/timeTravel.js                  # Advances 11 days & auto-liquidates overdue loan
  node scripts/timeTravel.js 11               # Advances 11 days & auto-liquidates
  node scripts/timeTravel.js 14 0x7099...79C8 # Advances 14 days & liquidates Account B
  node scripts/timeTravel.js status 0xf39F... # Checks loan status for a borrower without advancing time
`);
    return;
  }

  if (command === "status") {
    const target = args[1] || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    await checkLoanStatus(target);
    return;
  }

  // Parse days argument
  let days = 11;
  let targetBorrower = null;

  if (args[0] && !isNaN(Number(args[0]))) {
    days = Number(args[0]);
  }

  if (args[1] && ethers.isAddress(args[1])) {
    targetBorrower = args[1];
  } else if (args[0] && ethers.isAddress(args[0])) {
    targetBorrower = args[0];
  }

  await timeTravelAndLiquidate(days, targetBorrower);
}

// Run if called directly via CLI
if (process.argv[1] && (process.argv[1].endsWith("timeTravel.js") || process.argv[1].endsWith("timeTravel"))) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
