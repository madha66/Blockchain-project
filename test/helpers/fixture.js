import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { deployProtocol } from "../../scripts/lib/protocol.js";
import { registerMember, idHashOf, signAttestation } from "./identity.js";

const { ethers } = hre;

export const Kind = { Builder: 0, Unsecured: 1 };
export const Status = { None: 0, Active: 1, Repaid: 2, Defaulted: 3, Exited: 4 };
export const Stage = { Active: 0, Grace: 1, Onset: 2, Significant: 3, DefaultEligible: 4 };
export const DType = { None: 0, Hardship: 1, Strategic: 2, Fraud: 3 };
export const Option = { None: 0, PaymentHoliday: 1, TenureStretch: 2 };

export const ONE_ETH = ethers.parseEther("1");
export const VIRTUAL_OFFSET = 1_000_000n;

// Loosened prevention caps so V2-sized loans (0.1–0.5 ETH) fit a 1–10 ETH test pool.
// Every value stays inside its PolicyConfig bounds.
export const LOOSE = {
  builderMaxWei: ethers.parseEther("10"),
  firstUnsecuredCapWei: ethers.parseEther("10"),
  ladderStepCapWei: ethers.parseEther("10"),
  perLoanCapBps: 10000,
  clusterCapBps: 10000,
  weeklyGrowthCapBps: 10000,
  stakeAgeRequiredDays: 0,
};

const fixtures = new Map();

/**
 * Deploys and wires the full protocol. Signers: [admin, attester, ...users].
 * Each distinct parameter set is deployed once and then restored from an EVM snapshot.
 */
export function deployGigLend(overrides = {}) {
  const key = JSON.stringify(overrides, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  if (!fixtures.has(key)) {
    const fixture = () => deployFresh(overrides);
    Object.defineProperty(fixture, "name", { value: `gigLend_${fixtures.size}` });
    fixtures.set(key, fixture);
  }
  return loadFixture(fixtures.get(key));
}

async function deployFresh(overrides) {
  const signers = await ethers.getSigners();
  const [admin, attester] = signers;
  const c = await deployProtocol(ethers, { admin, attester: attester.address, overrides });
  const spd = await c.config.secondsPerDay();
  return { ...c, admin, attester, users: signers.slice(2), spd };
}

/**
 * Registers `user` with a generous income tier (burden never bites unless a test sets it).
 */
export async function register(ctx, user, fields = {}) {
  return registerMember(ctx.registry, ctx.attester, user, {
    incomeTierWei: ethers.parseEther("100"),
    ...fields,
  });
}

export { idHashOf, signAttestation };

export async function advanceDays(ctx, days) {
  await ethers.provider.send("evm_increaseTime", [Number(BigInt(Math.round(days * 1000)) * ctx.spd / 1000n)]);
  await ethers.provider.send("evm_mine", []);
}

export async function advanceTo(timestamp) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
  await ethers.provider.send("evm_mine", []);
}

export const now = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);

export function findEvent(receipt, contract, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed.args;
    } catch {
      // other contract
    }
  }
  return undefined;
}

export function findEvents(receipt, contract, name) {
  const out = [];
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) out.push(parsed.args);
    } catch {
      // other contract
    }
  }
  return out;
}

/**
 * Opens a loan and returns { loanId, receipt }.
 */
export async function openLoan(ctx, user, { kind = Kind.Builder, amount, n = 2, guarantor = ethers.ZeroAddress, autopay = false, value = 0n } = {}) {
  const tx = await ctx.loanManager.connect(user).openLoan(kind, amount, n, guarantor, autopay, { value });
  const receipt = await tx.wait();
  const ev = findEvent(receipt, ctx.loanManager, "LoanOpened");
  return { loanId: ev.loanId, receipt };
}

/** Pays the whole remaining schedule. */
export async function payOff(ctx, user, loanId) {
  const amount = await ctx.loanManager.payoffAmount(loanId);
  const tx = await ctx.loanManager.connect(user).repayInstallment(loanId, { value: amount });
  return tx.wait();
}

/** Completes one small Builder loan so the member may take Unsecured loans. */
export async function qualify(ctx, user, amount = ethers.parseEther("0.01")) {
  const { loanId } = await openLoan(ctx, user, { kind: Kind.Builder, amount });
  await payOff(ctx, user, loanId);
}

export const gasCost = (receipt) => receipt.gasUsed * receipt.gasPrice;
