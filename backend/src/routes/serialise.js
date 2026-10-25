import { prisma } from "../db.js";
import { computeStep } from "../services/signupState.js";

const latestConsents = (consents) => {
  const out = {};
  for (const c of [...consents].sort((a, b) => a.createdAt - b.createdAt)) out[c.kind] = c.granted;
  return out;
};

/**
 * The user as the frontend sees it. Raw KYC values are never returned.
 */
export async function publicUser(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { identity: { include: { contact: true } }, gigProfile: true, consents: true },
  });
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    wallet: u.wallet,
    isAdmin: u.isAdmin,
    contactVerified: u.contactVerified,
    signupStep: await computeStep(u.id),
    identity: u.identity
      ? {
          idHash: u.identity.idHash,
          panMasked: u.identity.panMasked,
          cohortId: u.identity.cohortId,
          clusterId: u.identity.clusterOverride ? "admin-assigned" : u.identity.clusterId,
          contactName: u.identity.contact.name,
          activeWallet: u.identity.activeWallet,
        }
      : null,
    income: u.gigProfile
      ? {
          platform: u.gigProfile.platform,
          payoutFrequency: u.gigProfile.payoutFrequency,
          assessedMonthlyInr: u.gigProfile.assessedMonthlyInr,
          declaredDebtInr: u.gigProfile.declaredDebtInr,
          stabilityBand: u.gigProfile.stabilityBand,
        }
      : null,
    consents: latestConsents(u.consents),
  };
}
