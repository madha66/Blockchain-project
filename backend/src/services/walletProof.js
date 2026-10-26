import { ethers } from "ethers";

export const PROOF_MAX_AGE_MS = 10 * 60 * 1000;

/** Message a wallet signs to prove it is asking for identity verification itself. */
export const identityProofMessage = (wallet, issuedAt) =>
  [
    "GigLend identity verification",
    `Wallet: ${wallet.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
    "",
    "I confirm this wallet is mine and that I am verifying one identity for it.",
  ].join("\n");

/** Message a member signs to dispute a pending platform notice. */
export const disputeMessage = (noticeId, wallet, reason) =>
  ["GigLend notice dispute", `Notice: ${noticeId}`, `Wallet: ${wallet.toLowerCase()}`, "", `Reason: ${reason}`].join("\n");

const refuse = (code) => Object.assign(new Error(code), { status: 401, code });

export function recoverSigner(message, signature) {
  try {
    return ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    return null;
  }
}

/** Checks an identity proof: signed by `wallet`, built for it, and fresh. */
export function checkIdentityProof({ wallet, message, signature, now = Date.now() }) {
  const match = /^Issued at: (.+)$/m.exec(message || "");
  const issued = match ? Date.parse(match[1]) : NaN;
  if (!match || message !== identityProofMessage(wallet, match[1])) throw refuse("PROOF_MALFORMED");
  if (!(now - issued <= PROOF_MAX_AGE_MS && issued - now <= 60_000)) throw refuse("PROOF_EXPIRED");
  if (recoverSigner(message, signature) !== wallet.toLowerCase()) throw refuse("PROOF_BAD_SIGNATURE");
}
