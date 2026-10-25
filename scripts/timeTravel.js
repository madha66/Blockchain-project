import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION & CONTRACT RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const CONTRACTS_DIR = path.resolve("frontend/src/contracts");
const ADDRESSES_PATH = path.join(CONTRACTS_DIR, "addresses.json");

export const STAGES = ["Active", "Grace", "Onset", "Significant", "DefaultEligible"];
export const STATUS = ["None", "Active", "Repaid", "Defaulted", "Exited"];
export const DTYPES = ["None", "Hardship", "Strategic", "Fraud"];

/**
 * Deployed addresses written by scripts/deploy.js (frontend/src/contracts/addresses.json).
 * The lowercase keys keep the V2 shape for older callers.
 */
export function getDeployedAddresses() {
  if (!fs.existsSync(ADDRESSES_PATH)) {
    throw new Error("frontend/src/contracts/addresses.json not found. Run scripts/deploy.js first.");
  }
  const a = JSON.parse(fs.readFileSync(ADDRESSES_PATH, "utf8"));
  return { ...a, lendingPool: a.LendingPool, creditScore: a.CreditScore, glpToken: a.GLPToken };
}

export function contract(name, runner) {
  const addresses = getDeployedAddresses();
  const { abi } = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, `${name}.json`), "utf8"));
  return new ethers.Contract(addresses[name], abi, runner);
}

const fmt = (wei) => `${Number(ethers.formatEther(wei)).toFixed(4)} ETH`;
const when = (ts) => new Date(Number(ts) * 1000).toLocaleString();

// ─────────────────────────────────────────────────────────────────────────────
// CORE EXPORTED FUNCTIONS FOR REVIEW / DEMO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advances chain time by `days` policy days (PolicyConfig.secondsPerDay, so compressed
 * demo time works too).
 */
export async function advanceBlockchainTime(days = 11, rpcUrl = RPC_URL) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let spd = 86400;
  try {
    spd = Number(await contract("PolicyConfig", provider).secondsPerDay());
  } catch {
    // not deployed yet: plain days
  }
  const before = await provider.getBlock("latest");
  const seconds = Math.floor(days * spd);
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
  const after = await provider.getBlock("latest");

  console.log(`\n⏱️  Advanced ${days} day(s) (${seconds.toLocaleString()} s, secondsPerDay=${spd})`);
  console.log(`   ${when(before.timestamp)}  →  ${when(after.timestamp)}  (block #${after.number})\n`);
  return { previousTimestamp: before.timestamp, newTimestamp: after.timestamp, secondsAdded: after.timestamp - before.timestamp };
}

/**
 * Prints one loan (by id) or a borrower's open/latest loan (by address).
 */
export async function checkLoanStatus(target, rpcUrl = RPC_URL) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const lm = contract("LoanManager", provider);
  const registry = contract("IdentityRegistry", provider);

  let loanId;
  if (ethers.isAddress(target)) {
    const memberId = await registry.memberOf(target);
    if (memberId === 0n) {
      console.log(`${target} is not a registered member.`);
      return { isActive: false };
    }
    loanId = await lm.openLoanOf(memberId);
    if (loanId === 0n) {
      const ids = await lm.loansOfMember(memberId);
      if (ids.length === 0) {
        console.log(`Member #${memberId} has no loans.`);
        return { isActive: false };
      }
      loanId = ids[ids.length - 1];
    }
  } else {
    loanId = BigInt(target);
  }

  const l = await lm.getLoan(loanId);
  const active = Number(l.status) === 1;
  const stage = active ? STAGES[Number(await lm.stageOf(loanId))] : null;
  console.log("------------------------------------------------------------");
  console.log(`📋 Loan #${loanId} · member #${l.memberId} · ${l.borrower}`);
  console.log(`   Kind:        ${Number(l.kind) === 0 ? "Builder (escrowed)" : "Unsecured"}`);
  console.log(`   Status:      ${STATUS[Number(l.status)]}${Number(l.status) === 3 ? ` · ${DTYPES[Number(l.dtype)]}` : ""}`);
  console.log(`   Outstanding: ${fmt(l.outstandingPrincipal)} of ${fmt(l.principal)} · ${l.paidCount}/${l.nInstallments} paid`);
  if (active) {
    console.log(`   Next due:    ${when(l.nextDueDate)}`);
    console.log(`   Stage:       ${stage}`);
    console.log(`   Due now:     ${fmt(await lm.amountDue(loanId))}`);
  }
  console.log("------------------------------------------------------------");
  return { isActive: active, loanId, stage, canDefault: stage === "DefaultEligible", canCollect: stage === "Significant" };
}

async function keeper(rpcUrl) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return provider.getSigner(Number(process.env.KEEPER_INDEX || 6)); // Hardhat account #6 by default
}

/** Applies locked stake to a Significant-stage installment (pays the keeper a bounty). */
export async function collectLoan(loanId, rpcUrl = RPC_URL) {
  const lm = contract("LoanManager", await keeper(rpcUrl));
  const receipt = await (await lm.collect(loanId)).wait();
  console.log(`✅ collect(${loanId}) mined in block #${receipt.blockNumber}`);
  return receipt;
}

/** Marks a DefaultEligible loan as defaulted and prints the waterfall. */
export async function liquidateDefault(loanId, rpcUrl = RPC_URL) {
  const signer = await keeper(rpcUrl);
  const lm = contract("LoanManager", signer);
  const dm = contract("DefaultManager", signer);
  try {
    const receipt = await (await lm.markDefault(loanId)).wait();
    for (const log of receipt.logs) {
      let parsed;
      try {
        parsed = dm.interface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed?.name === "LoanDefaulted") {
        const a = parsed.args;
        console.log(`\n🔻 Loan #${a.loanId} defaulted · classified ${DTYPES[Number(a.defaultType)]}`);
        console.log(`   1. Borrower stake:  ${fmt(a.stakeUsed)}`);
        console.log(`   2. Guarantor stake: ${fmt(a.guarantorUsed)}`);
        console.log(`   3. Reserve:         ${fmt(a.reserveUsed)}`);
        console.log(`   4. Lender loss:     ${fmt(a.lenderLoss)}\n`);
      }
    }
    return { success: true, receipt };
  } catch (error) {
    console.error(`❌ markDefault(${loanId}) failed: ${error.shortMessage || error.message}`);
    return { success: false, error };
  }
}

/**
 * Advances time, then marks every DefaultEligible open loan as defaulted (or just the
 * given borrower's loan).
 */
export async function timeTravelAndLiquidate(days = 31, borrower = null) {
  await advanceBlockchainTime(days);
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const lm = contract("LoanManager", provider);
  const ids = borrower ? [(await checkLoanStatus(borrower)).loanId].filter(Boolean) : [...(await lm.activeLoanIds())];
  let defaulted = 0;
  for (const id of ids) {
    const status = await checkLoanStatus(id.toString());
    if (status.canDefault) {
      await liquidateDefault(id);
      defaulted += 1;
    }
  }
  if (defaulted === 0) console.log("ℹ️  No loan is past its default day yet.");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const [cmd = "auto", a1] = process.argv.slice(2);

  switch (cmd.toLowerCase()) {
    case "help":
    case "--help":
    case "-h":
      console.log(`
GigLend — time travel and keeper tool (local Hardhat chain)
Usage:
  node scripts/timeTravel.js [days] [borrower]   advance (default 31 days), then markDefault eligible loans
  node scripts/timeTravel.js advance <days>      only advance time
  node scripts/timeTravel.js status <loanId|address>
  node scripts/timeTravel.js collect <loanId>    apply stake in the Significant stage
  node scripts/timeTravel.js default <loanId>    markDefault from the default day
Days are policy days (PolicyConfig.secondsPerDay).
`);
      return;
    case "advance":
      await advanceBlockchainTime(Number(a1 || 1));
      return;
    case "status":
      await checkLoanStatus(a1 || "1");
      return;
    case "collect":
      await collectLoan(BigInt(a1));
      return;
    case "default":
      await liquidateDefault(BigInt(a1));
      return;
    default: {
      const days = !isNaN(Number(cmd)) ? Number(cmd) : 31;
      const borrower = ethers.isAddress(a1 || "") ? a1 : ethers.isAddress(cmd) ? cmd : null;
      await timeTravelAndLiquidate(days, borrower);
    }
  }
}

if (process.argv[1] && /timeTravel(\.js)?$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
