import { prisma } from "../db.js";

/**
 * Next wizard step to complete, derived from what is saved (so the wizard is resumable):
 * 1 account/OTP · 2 link wallet · 3 KYC · 4 gig & income · 5 consent · 6 done.
 */
export async function computeStep(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { gigProfile: true, consents: { where: { kind: "data_use" }, orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!user.contactVerified) return 1;
  if (!user.wallet) return 2;
  if (!user.identityId) return 3;
  if (!user.gigProfile) return 4;
  if (!user.consents[0]?.granted) return 5;
  return 6;
}

export async function refreshStep(userId) {
  const step = await computeStep(userId);
  await prisma.user.update({ where: { id: userId }, data: { signupStep: step } });
  return step;
}
