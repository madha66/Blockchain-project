import { AttestationRecord, GigProfile, Identity, User } from "../models.js";
import { config } from "../config.js";
import { incomeTierWei, inrToWei } from "./income.js";
import { clusterIdFor } from "./cohort.js";
import { signAttestation, serialiseAttestation } from "./attester.js";

const incomplete = () => {
  const err = new Error("Signup incomplete");
  err.status = 400;
  err.code = "SIGNUP_INCOMPLETE";
  return err;
};

/**
 * Signs a MemberAttestation for a wallet and its identity. Expiry is measured from chain
 * time, so time-travel demos do not expire it early.
 */
export async function signForIdentity({ wallet, identity, income, chain, userId = null }) {
  const now = await chain.now();
  const expiry = now + config.attestationValidityDays * 86400;
  const clusterId = identity.clusterOverride ? clusterIdFor({ override: identity.clusterOverride }) : identity.clusterId;

  const signed = await signAttestation({
    wallet,
    idHash: identity.identityHash,
    incomeTierWei: incomeTierWei(income.assessedMonthlyInr, income.stabilityBand),
    declaredDebtWei: inrToWei(income.declaredDebtInr ?? 0),
    payoutPeriodDays: income.payoutFrequency === "biweekly" ? 14 : 7,
    clusterId,
    cohortId: identity.cohortId,
    expiry,
  });
  await AttestationRecord.create({ user: userId, wallet, nonce: signed.attestation.nonce.toString(), expiry });
  return {
    attestation: serialiseAttestation(signed.attestation),
    signature: signed.signature,
    domain: signed.domain,
  };
}

/** Attestation for a user who finished the sign-up wizard. */
export async function buildAttestation(userId, chain) {
  const user = await User.findById(userId);
  const identity = user?.identity ? await Identity.findById(user.identity) : null;
  const gig = user ? await GigProfile.findOne({ user: user._id }) : null;
  if (!user?.wallet || !identity || !gig) throw incomplete();
  return signForIdentity({ wallet: user.wallet, identity, income: gig, chain, userId: user._id });
}
