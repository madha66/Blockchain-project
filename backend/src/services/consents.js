import { ethers } from "ethers";
import { Consent } from "../models.js";
import { CONSENT_TEXT, consentMessage } from "./consentText.js";
import { logAudit } from "./audit.js";

export const CONSENT_MAX_AGE_MS = 10 * 60 * 1000;

const refuse = (code) => Object.assign(new Error(code), { status: 400, code });

/**
 * Checks a signed consent decision without storing it: the signature must be the wallet's
 * personal_sign of the exact consent message (text, decision and time), signed in the last
 * 10 minutes and later than the wallet's previous decision of the same type (no replays).
 */
export async function checkSignedConsent({ wallet, type, granted, signature, signedAt, now = Date.now() }) {
  const w = wallet.toLowerCase();
  const at = Date.parse(signedAt);
  if (!Number.isFinite(at) || now - at > CONSENT_MAX_AGE_MS || at - now > 60_000) throw refuse("CONSENT_EXPIRED");
  let signer = null;
  try {
    signer = ethers.verifyMessage(consentMessage(type, w, granted, signedAt), signature).toLowerCase();
  } catch {
    signer = null;
  }
  if (signer !== w) throw refuse("CONSENT_SIGNATURE_INVALID");
  const previous = await latestConsent(w, type);
  if (previous?.signature === signature || (previous?.signedAt && Date.parse(previous.signedAt) > at)) {
    throw refuse("CONSENT_REPLAYED");
  }
}

/** Records a signed consent decision after checking it. */
export async function recordSignedConsent({ wallet, userId = null, type, granted, signature, signedAt }) {
  const w = wallet.toLowerCase();
  await checkSignedConsent({ wallet: w, type, granted, signature, signedAt });
  const row = await Consent.create({
    wallet: w,
    user: userId,
    type,
    granted,
    textVersion: CONSENT_TEXT[type].version,
    signature,
    signedAt,
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
