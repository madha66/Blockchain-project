// Consent wording shown in full before signing. The wallet signs (EIP-191 personal_sign) the
// exact message built by consentMessage(), so a stored signature proves which text was agreed.
export const CONSENT_TEXT = {
  platform_notice: {
    version: "platform_notice-v1",
    title: "Notice to my gig platform if I am expelled",
    text:
      "If I default on a GigLend loan and the member community votes to expel me, GigLend may send one " +
      "factual notice to the gig platform I name below. The notice states only my outstanding balance, " +
      "that my membership was ended by a member vote, and how to contact GigLend. It is sent no earlier " +
      "than 7 days after the vote, and not at all if I raise a dispute that is upheld or clear my debt " +
      "first. GigLend will not contact my family, friends, phone contacts or anyone else, and will never " +
      "publish my name. I can withdraw this consent at any time from my profile; withdrawal stops any " +
      "notice that has not yet been sent.",
  },
  payout_deduction: {
    version: "payout_deduction-v1",
    title: "Payout deductions toward an outstanding balance",
    text:
      "If I have an outstanding GigLend balance after a default, I agree that GigLend may ask the gig " +
      "platform I name below to deduct part of my future payouts toward that balance, within any limit " +
      "set by the platform and by law. Deductions stop as soon as the balance is cleared. I can withdraw " +
      "this consent at any time from my profile.",
  },
};

export const SIGNED_CONSENTS = Object.keys(CONSENT_TEXT);

/** The exact string the wallet signs for a consent decision. */
export function consentMessage(type, wallet, granted) {
  const c = CONSENT_TEXT[type];
  if (!c) throw new Error(`Unknown consent type ${type}`);
  return [
    `GigLend consent: ${c.title}`,
    `Version: ${c.version}`,
    `Wallet: ${wallet.toLowerCase()}`,
    "",
    c.text,
    "",
    `Decision: ${granted ? "I AGREE" : "I DO NOT AGREE"}`,
  ].join("\n");
}
