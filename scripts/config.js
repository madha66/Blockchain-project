// Shared deploy/test configuration for GigLend.
// Every policy number lives here as [name, value, min, max] and is written into PolicyConfig,
// where admin changes are bounds-checked and emit ParameterUpdated.
// Rupee figures are benchmarks only; they become wei through INR_PER_ETH_DEMO and never
// appear in Solidity.
import { ethers } from "ethers";

// ₹1,000 ≈ 0.01 ETH
export const INR_PER_ETH_DEMO = 100000;

export const inr = (rupees) =>
  (ethers.parseEther("1") * BigInt(Math.round(rupees * 100))) / BigInt(INR_PER_ETH_DEMO * 100);

const ETH = (v) => ethers.parseEther(String(v));

export const PARAMS = [
  // ── Time ──────────────────────────────────────────────────────────────
  ["secondsPerDay", 86400n, 1n, 86400n],

  // ── Tiers (completed loans + score) ───────────────────────────────────
  ["tierBuilderLoans", 1n, 0n, 100n],
  ["tierStandardLoans", 2n, 0n, 100n],
  ["tierTrustedLoans", 4n, 0n, 100n],
  ["tierPrimeLoans", 8n, 0n, 100n],
  ["tierStandardScore", 600n, 300n, 900n],
  ["tierTrustedScore", 700n, 300n, 900n],
  ["tierPrimeScore", 800n, 300n, 900n],

  // ── Loan shape ────────────────────────────────────────────────────────
  ["minInstallments", 2n, 1n, 12n],
  ["maxInstallments", 12n, 2n, 52n],
  ["penaltyFreeExitDays", 1n, 1n, 7n],
  ["maxActiveLoans", 100n, 1n, 200n],

  // ── Prevention: credit-builder first ─────────────────────────────────
  ["builderLoansRequired", 1n, 1n, 2n],
  ["builderMaxWei", inr(2000), inr(100), ETH(10)],
  ["firstUnsecuredCapWei", inr(1000), inr(100), ETH(10)],
  ["stakeAgeRequiredDays", 90n, 0n, 365n],
  ["unsecuredStakeCoverBps", 5000n, 0n, 10000n],

  // ── Prevention: capped ladder + fast climber ──────────────────────────
  ["ladderMultiplierBps", 15000n, 10000n, 20000n],
  ["ladderEarlyMultiplierBps", 12500n, 10000n, 20000n],
  ["ladderEarlySteps", 2n, 0n, 10n],
  ["ladderStepCapWei", inr(5000), inr(100), ETH(10)],
  ["fastClimberWindowDays", 60n, 0n, 365n],

  // ── Prevention: affordability ─────────────────────────────────────────
  ["burdenBps", 3500n, 1000n, 5000n],
  ["misdeclaredLimitCutBps", 5000n, 0n, 10000n],

  // ── Prevention: repayment follows income ──────────────────────────────
  ["sweepBps", 2000n, 1500n, 3000n],

  // ── Prevention: concentration and cohort screens ──────────────────────
  ["maxUtilizationBps", 9000n, 5000n, 9500n],
  ["perLoanCapBps", 200n, 10n, 10000n],
  ["clusterCapBps", 500n, 10n, 10000n],
  ["weeklyGrowthCapBps", 1000n, 10n, 10000n],
  ["cohortFpdThresholdBps", 2000n, 100n, 10000n],
  ["cohortMinSample", 5n, 1n, 1000n],

  // ── Lifecycle stages ──────────────────────────────────────────────────
  ["graceDaysShort", 3n, 1n, 7n],
  ["graceDaysLong", 7n, 3n, 14n],
  ["onsetEndDay", 10n, 5n, 20n],
  ["defaultDayShort", 30n, 15n, 60n],
  ["defaultDayLong", 45n, 30n, 90n],
  ["longLoanDays", 90n, 30n, 365n],

  // ── Fees and bounty ───────────────────────────────────────────────────
  ["lateFeeFlatWei", inr(50), 0n, inr(1000)],
  ["lateFeeCapBps", 1000n, 0n, 2500n],
  ["bountyShareBps", 1000n, 0n, 5000n],
  ["holidayFeeWei", inr(20), 0n, inr(500)],

  // ── Provisions (carried value by stage) ───────────────────────────────
  ["carryOnsetBps", 9000n, 0n, 10000n],
  ["carrySignificantBps", 5000n, 0n, 10000n],

  // ── Restructuring ─────────────────────────────────────────────────────
  ["termPremiumBps", 200n, 0n, 2000n],
  ["incomeDropBps", 8000n, 1000n, 10000n],
  ["maxRestructuresPer12m", 2n, 0n, 4n],
  ["restructureWindowDays", 365n, 30n, 730n],
  ["restructureScoreBps", 6000n, 0n, 10000n],

  // ── Systemic shock mode ───────────────────────────────────────────────
  ["shockExtraGraceDays", 7n, 0n, 30n],
  ["shockMaxDays", 60n, 1n, 180n],

  // ── Default, recovery, settlement ─────────────────────────────────────
  ["reserveFactorBps", 1000n, 0n, 5000n],
  ["residualSweepBps", 5000n, 0n, 10000n],
  ["discountHardshipBps", 2500n, 0n, 5000n],
  ["discountStrategicBps", 500n, 0n, 2500n],
  ["discountFraudBps", 0n, 0n, 0n],
  ["coolingHardshipDays", 30n, 0n, 365n],
  ["coolingStrategicDays", 365n, 30n, 1095n],
  ["appealWindowDays", 21n, 7n, 60n],
  ["workoutMaxDays", 180n, 30n, 180n],
  ["fraudThinStakeDays", 30n, 0n, 180n],
  ["maxQueueLength", 50n, 1n, 200n],

  // ── Credit score (300–900) ────────────────────────────────────────────
  ["scoreBase", 550n, 300n, 900n],
  ["installmentPoints", 4n, 0n, 50n],
  ["loanPoints", 15n, 0n, 100n],
  ["stakeAgeMaxPoints", 30n, 0n, 100n],
  ["stakeAgeFullDays", 365n, 1n, 1095n],
  ["lateMarkPoints", 10n, 0n, 100n],
  ["restructurePoints", 5n, 0n, 100n],
  ["misdeclaredPoints", 40n, 0n, 200n],
  ["weightOnTimeBps", 10000n, 0n, 10000n],
  ["weightGraceBps", 6000n, 0n, 10000n],
  ["weightLateBps", 2000n, 0n, 10000n],
  ["scarStrategicPoints", 90n, 0n, 300n],
  ["scarHardshipPoints", 60n, 0n, 300n],
  ["scarFloorBps", 3000n, 0n, 10000n],
  ["scarDecayDays", 730n, 30n, 1825n],
  ["settleScarBps", 7000n, 3000n, 10000n],
  ["workoutScarBps", 6000n, 3000n, 10000n],
];

export const paramKey = (name) => ethers.encodeBytes32String(name);

/**
 * Writes every parameter into a PolicyConfig in batches.
 * `overrides` lets tests and demos replace demo values (bounds stay the same).
 */
export async function defineAllParams(policyConfig, overrides = {}) {
  const rows = PARAMS.map(([name, value, min, max]) => {
    const v = overrides[name] !== undefined ? BigInt(overrides[name]) : value;
    return [paramKey(name), v, min, max];
  });
  const BATCH = 30;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const tx = await policyConfig.defineParams(
      slice.map((r) => r[0]),
      slice.map((r) => r[1]),
      slice.map((r) => r[2]),
      slice.map((r) => r[3])
    );
    await tx.wait();
  }
}
