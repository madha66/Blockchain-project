import { Router } from "express";
import { z } from "zod";
import { Consent, EmployerContact, Identity, User } from "../models.js";
import { ah, requireSession, setSession } from "../middleware/auth.js";
import { logAudit, logAuthEvent } from "../services/audit.js";
import { buildAttestation } from "../services/attestationBuilder.js";
import { refreshStep } from "../services/signupState.js";
import { consentHistory, recordSignedConsent } from "../services/consents.js";
import { SIGNED_CONSENTS } from "../services/consentText.js";
import { publicUser } from "./serialise.js";

export const employerSchema = z.object({
  platformName: z.string().trim().min(2).max(60),
  contactEmail: z.string().trim().toLowerCase().email(),
});

/** Saves the platform contact a consented notice may go to (one per wallet; never shown to others). */
export async function saveEmployerContact({ wallet, userId = null, platformName, contactEmail }) {
  await EmployerContact.updateOne(
    { wallet: wallet.toLowerCase() },
    { $set: { platformName, contactEmail, user: userId } },
    { upsert: true }
  );
  await logAudit("consent", "employer_contact_saved", { wallet, user: userId, data: { platformName } });
}

export function profileRoutes({ chain }) {
  const r = Router();
  r.use(requireSession("full"));

  r.get(
    "/",
    ah(async (req, res) => {
      const history = await consentHistory({ wallet: req.user.wallet, userId: req.user._id });
      const employer = req.user.wallet ? await EmployerContact.findOne({ wallet: req.user.wallet }).lean() : null;
      res.json({
        user: await publicUser(req.user._id),
        consentHistory: history.map((c) => ({
          kind: c.type,
          granted: c.granted,
          textVersion: c.textVersion,
          signed: Boolean(c.signature),
          createdAt: c.timestamp,
        })),
        employerContact: employer ? { platformName: employer.platformName, contactEmail: employer.contactEmail } : null,
      });
    })
  );

  r.post(
    "/consent",
    ah(async (req, res) => {
      const { kind, granted } = z
        .object({ kind: z.enum(["data_use", "autopay", "peer_visibility"]), granted: z.boolean() })
        .parse(req.body);
      await Consent.create({ user: req.user._id, wallet: req.user.wallet, type: kind, granted, timestamp: new Date() });
      await logAudit("consent", granted ? "consent_granted" : "consent_declined", { user: req.user._id, data: { type: kind } });
      res.json({ user: await publicUser(req.user._id) });
    })
  );

  /** Platform-notice and payout-deduction consents: the wallet signs the full text. */
  r.post(
    "/consent/signed",
    ah(async (req, res) => {
      if (!req.user.wallet) return res.status(400).json({ error: "NO_WALLET" });
      const body = z
        .object({ type: z.enum(SIGNED_CONSENTS), granted: z.boolean(), signature: z.string().min(10) })
        .parse(req.body);
      await recordSignedConsent({ wallet: req.user.wallet, userId: req.user._id, ...body });
      res.json({ user: await publicUser(req.user._id) });
    })
  );

  r.put(
    "/employer-contact",
    ah(async (req, res) => {
      if (!req.user.wallet) return res.status(400).json({ error: "NO_WALLET" });
      const body = employerSchema.parse(req.body);
      await saveEmployerContact({ wallet: req.user.wallet, userId: req.user._id, ...body });
      res.json({ ok: true });
    })
  );

  /** Fresh attestation (re-attestation updates income, debts and expiry on-chain). */
  r.post(
    "/attestation",
    ah(async (req, res) => {
      res.json(await buildAttestation(req.user._id, chain));
    })
  );

  /**
   * Unlinks the wallet so the identity can move to a new one. Refused while a loan is open.
   * The user must also call IdentityRegistry.unlinkWallet() on-chain from the old wallet.
   */
  r.post(
    "/unlink-wallet",
    ah(async (req, res) => {
      if (!req.user.wallet) return res.status(400).json({ error: "NO_WALLET" });
      const identity = req.user.identity ? await Identity.findById(req.user.identity) : null;
      if (identity && (await chain.hasOpenLoanForIdHash(identity.identityHash))) {
        return res.status(409).json({ error: "OPEN_LOAN" });
      }
      await User.updateOne({ _id: req.user._id }, { $unset: { wallet: 1 } });
      if (identity) await Identity.updateOne({ _id: identity._id }, { linkedWallet: null });
      await logAuthEvent("wallet_unlinked", req.user._id);
      setSession(res, req.user.id, "signup");
      res.json({ step: await refreshStep(req.user._id) });
    })
  );

  return r;
}
