import { ethers } from "ethers";
import { config } from "../config.js";

const INCOME_TIER_STEP_INR = 5000;

/**
 * ₹ → wei through the single demo conversion constant.
 */
export function inrToWei(rupees, inrPerEth = config.inrPerEth) {
  return (ethers.parseEther("1") * BigInt(Math.round(rupees * 100))) / BigInt(inrPerEth * 100);
}

export function weiToInr(wei, inrPerEth = config.inrPerEth) {
  return Number((BigInt(wei) * BigInt(inrPerEth)) / 10n ** 14n) / 10000;
}

/**
 * Assesses monthly income from 3–6 mock monthly payout figures.
 * Assessed income is the lower of mean and median, so one good month cannot inflate it.
 * Stability band uses the coefficient of variation.
 */
export function assessIncome(monthlyPayouts) {
  const xs = monthlyPayouts.map(Number);
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sorted = [...xs].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;

  let stabilityBand = "volatile";
  if (cv < 0.15) stabilityBand = "stable";
  else if (cv < 0.35) stabilityBand = "variable";

  return {
    assessedMonthlyInr: Math.round(Math.min(mean, median)),
    stabilityBand,
    coefficientOfVariation: Number(cv.toFixed(3)),
  };
}

// Haircut by stability band before the income is attested.
const BAND_FACTOR = { stable: 1, variable: 0.9, volatile: 0.75 };

/**
 * Income goes on-chain only as a tier (rounded down to ₹5,000 steps), never the exact figure.
 */
export function incomeTierWei(assessedMonthlyInr, stabilityBand) {
  const adjusted = assessedMonthlyInr * (BAND_FACTOR[stabilityBand] ?? 0.75);
  const tierInr = Math.floor(adjusted / INCOME_TIER_STEP_INR) * INCOME_TIER_STEP_INR;
  return inrToWei(tierInr);
}

export const totalDeclaredDebtInr = (debts) => debts.reduce((a, d) => a + Number(d.emiInr || 0), 0);
