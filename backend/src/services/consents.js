import { ethers } from "ethers";
import { Consent } from "../models.js";
import { CONSENT_TEXT, consentMessage } from "./consentText.js";
import { logAudit } from "./audit.js";

/**
 * Records a signed consent decision. The signature must be the wallet's personal_sign of the
 * exact consent message for this decision, so the stored row proves what was agreed.
 */
export async function recordSignedConsent({ wallet, userId = null, type, granted, signature }) {
  const w = wallet.toLowerCase();
  let signer;
  try {
    signer = ethers.verifyMessage(consentMessage(type, w, granted), signature).toLowerCase();
  } catch {
    signer = null;
  }
  if (signer !== w) {
    const err = new Error("Consent signature does not match the wallet");
    err.status = 400;
    err.code = "CONSENT_SIGNATURE_INVALID";
    throw err;
  }
  const row = await Consent.create({
    wallet: w,
    user: userId,
    type,
    granted,
    textVersion: CONSENT_TEXT[type].version,
    signature,
    timestamp: new Date(),
  });
  await logAudit("consent", granted ? "consent_granted" : "consent_declined", {
    wallet: w,
    user: userId,
    data: { type, textVersion: row.textVersion },
  });
  return row;
}

/** The current decision for a wallet (latest row wins). */
export async function latestConsent(wallet, type) {
  return Consent.findOne({ wallet: wallet.toLowerCase(), type }).sort({ timestamp: -1, _id: -1 });
}

export async function hasConsent(wallet, type) {
  return Boolean((await latestConsent(wallet, type))?.granted);
}

/** Consent history for a wallet and/or user, newest first. */
export async function consentHistory({ wallet, userId }) {
  const or = [];
  if (wallet) or.push({ wallet: wallet.toLowerCase() });
  if (userId) or.push({ user: userId });
  if (!or.length) return [];
  return Consent.find({ $or: or }).sort({ timestamp: -1, _id: -1 }).lean();
}
