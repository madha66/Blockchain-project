import { ethers } from "ethers";

/**
 * cohortId = signup ISO week as YYYYWW (e.g. 202643).
 */
export function isoWeekCohort(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() * 100 + week;
}

/**
 * Mock cluster: wallets that share a phone prefix, device fingerprint and funding wallet land in
 * the same cluster. An admin override wins (used for demo fixtures).
 */
export function clusterIdFor({ phone, deviceHash, fundingWallet, override }) {
  if (override) return ethers.id(`override:${override}`);
  const digits = String(phone || "").replace(/\D/g, "");
  const prefix = digits.slice(-10, -5); // first 5 of the 10-digit national number
  return ethers.id(`${prefix}|${deviceHash || "nodevice"}|${(fundingWallet || "nofunder").toLowerCase()}`);
}
