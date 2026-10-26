import { Consent, Contact, GigProfile, Identity, User } from "../models.js";
import { computeStep } from "../services/signupState.js";
import { config } from "../config.js";

const latestConsents = (consents) => {
  const out = {};
  for (const c of [...consents].sort((a, b) => a.timestamp - b.timestamp)) out[c.type] = c.granted;
  return out;
};

/**
 * The user as the frontend sees it. Raw KYC values are never returned.
 */
export async function publicUser(userId) {
  const u = await User.findById(userId);
  if (!u) return null;
  const identity = u.identity ? await Identity.findById(u.identity) : null;
  const contact = identity?.contact ? await Contact.findById(identity.contact) : null;
  const gig = await GigProfile.findOne({ user: u._id });
  const or = [{ user: u._id }];
  if (u.wallet) or.push({ wallet: u.wallet });
  const consents = await Consent.find({ $or: or });
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    wallet: u.wallet ?? null,
    isAdmin: u.role === "admin" || (u.wallet ? config.adminWallets.includes(u.wallet) : false),
    contactVerified: u.contactVerified,
    signupStep: await computeStep(u._id),
    verified: u.verified,
    expelled: u.expelled,
    banned: u.banned,
    identity: identity
      ? {
          idHash: identity.identityHash,
          identifierType: identity.identifierType,
          panMasked: identity.identifierMasked,
          cohortId: identity.cohortId,
          clusterId: identity.clusterOverride ? "admin-assigned" : identity.clusterId,
          contactName: contact?.name ?? null,
          activeWallet: identity.linkedWallet,
          banned: identity.banned,
        }
      : null,
    income: gig
      ? {
          platform: gig.platform,
          payoutFrequency: gig.payoutFrequency,
          assessedMonthlyInr: gig.assessedMonthlyInr,
          declaredDebtInr: gig.declaredDebtInr,
          stabilityBand: gig.stabilityBand,
        }
      : null,
    consents: latestConsents(consents),
  };
}
