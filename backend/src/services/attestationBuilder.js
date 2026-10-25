import { prisma } from "../db.js";
import { config } from "../config.js";
import { incomeTierWei, inrToWei } from "./income.js";
import { clusterIdFor } from "./cohort.js";
import { signAttestation, serialiseAttestation } from "./attester.js";

/**
 * Builds and signs the MemberAttestation for a user who finished the wizard.
 * Expiry is measured from chain time, so time-travel demos do not expire it early.
 */
export async function buildAttestation(userId, chain) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { identity: true, gigProfile: true },
  });
  if (!user?.wallet || !user.identity || !user.gigProfile) {
    const err = new Error("Signup incomplete");
    err.status = 400;
    err.code = "SIGNUP_INCOMPLETE";
    throw err;
  }
  const now = await chain.now();
  const expiry = now + config.attestationValidityDays * 86400;
  const clusterId = user.identity.clusterOverride
    ? clusterIdFor({ override: user.identity.clusterOverride })
    : user.identity.clusterId;

  const signed = await signAttestation({
    wallet: user.wallet,
    idHash: user.identity.idHash,
    incomeTierWei: incomeTierWei(user.gigProfile.assessedMonthlyInr, user.gigProfile.stabilityBand),
    declaredDebtWei: inrToWei(user.gigProfile.declaredDebtInr),
    payoutPeriodDays: user.gigProfile.payoutFrequency === "weekly" ? 7 : 14,
    clusterId,
    cohortId: user.identity.cohortId,
    expiry,
  });
  await prisma.attestationRecord.create({
    data: { userId, nonce: signed.attestation.nonce.toString(), expiry },
  });
  return {
    attestation: serialiseAttestation(signed.attestation),
    signature: signed.signature,
    domain: signed.domain,
  };
}
