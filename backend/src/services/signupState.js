import { Consent, GigProfile, User } from "../models.js";

/**
 * Next wizard step to complete, derived from what is saved (so the wizard is resumable):
 * 1 account/OTP · 2 link wallet · 3 KYC · 4 gig & income · 5 consent · 6 done.
 */
export async function computeStep(userId) {
  const user = await User.findById(userId);
  if (!user.contactVerified) return 1;
  if (!user.wallet) return 2;
  if (!user.identity) return 3;
  if (!(await GigProfile.exists({ user: user._id }))) return 4;
  const dataUse = await Consent.findOne({ user: user._id, type: "data_use" }).sort({ timestamp: -1, _id: -1 });
  if (!dataUse?.granted) return 5;
  return 6;
}

export async function refreshStep(userId) {
  const step = await computeStep(userId);
  await User.updateOne({ _id: userId }, { signupStep: step });
  return step;
}
