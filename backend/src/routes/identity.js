import crypto from "crypto";
import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { User } from "../models.js";
import { ah } from "../middleware/auth.js";
import { config } from "../config.js";
import { issueOtp, verifyOtp } from "../services/otp.js";
import { PAN_REGEX, normaliseEmail, normalisePan } from "../services/identity.js";
import { resolveIdentity } from "../services/identityStore.js";
import { CONSENT_TEXT, SIGNED_CONSENTS, consentMessage } from "../services/consentText.js";
import { checkSignedConsent, recordSignedConsent } from "../services/consents.js";
import { signForIdentity } from "../services/attestationBuilder.js";
import { checkIdentityProof, identityProofMessage } from "../services/walletProof.js";
import { logAudit } from "../services/audit.js";
import { employerSchema, saveEmployerContact } from "./profile.js";

const address = z.string().refine(ethers.isAddress, "not an address").transform((a) => a.toLowerCase());
// OTPs for identity emails are keyed by a hash, so the inbox address is not stored in clear.
const emailKey = (email) => crypto.createHash("sha256").update(`identity:${normaliseEmail(email)}`).digest("hex");

const verifySchema = z
  .object({
    wallet: address,
    method: z.enum(["email", "id"]),
    email: z.string().trim().toLowerCase().email().optional(),
    otp: z.string().regex(/^\d{6}$/).optional(),
    idNumber: z.string().transform(normalisePan).pipe(z.string().regex(PAN_REGEX, "ID format is AAAAA9999A")).optional(),
    monthlyIncomeInr: z.coerce.number().min(0).max(10_000_000).default(10000),
    payoutFrequency: z.enum(["weekly", "biweekly"]).default("weekly"),
    proof: z.object({ message: z.string(), signature: z.string() }),
    consents: z
      .array(z.object({ type: z.enum(SIGNED_CONSENTS), granted: z.boolean(), signature: z.string().min(10), signedAt: z.string() }))
      .length(SIGNED_CONSENTS.length),
    employer: employerSchema.optional(),
  })
  .refine((v) => (v.method === "email" ? v.email && v.otp : v.idNumber), { message: "email + otp or idNumber required" })
  .refine((v) => new Set(v.consents.map((c) => c.type)).size === SIGNED_CONSENTS.length, { message: "one decision per consent" })
  .refine((v) => !v.consents.find((c) => c.type === "platform_notice" && c.granted) || v.employer, {
    message: "a platform contact is required for the platform-notice consent",
  });

/**
 * Wallet-first identity verification (no account needed): email + OTP, or a simulated ID
 * number. Refuses banned and duplicate identities and returns the issuer-signed attestation
 * for IdentityRegistry.register().
 */
export function identityRoutes({ chain }) {
  const r = Router();

  /** Full consent texts and the exact messages to sign for this wallet. */
  r.get(
    "/consent-text",
    ah(async (req, res) => {
      const wallet = req.query.wallet ? address.parse(req.query.wallet) : null;
      // The client signs the messages for this exact time (returned as signedAt).
      const signedAt = new Date().toISOString();
      const consents = Object.fromEntries(
        Object.entries(CONSENT_TEXT).map(([type, c]) => [
          type,
          {
            ...c,
            ...(wallet
              ? { messages: { agree: consentMessage(type, wallet, true, signedAt), decline: consentMessage(type, wallet, false, signedAt) } }
              : {}),
          },
        ])
      );
      res.json({ consents, signedAt, ...(wallet ? { proofMessage: identityProofMessage(wallet, signedAt) } : {}) });
    })
  );

  /**
   * Changes a signed consent without an account session: the consent signature itself
   * proves the wallet (it covers the wallet, the decision and the time).
   */
  r.post(
    "/consent",
    ah(async (req, res) => {
      const body = z
        .object({ wallet: address, type: z.enum(SIGNED_CONSENTS), granted: z.boolean(), signature: z.string().min(10), signedAt: z.string() })
        .parse(req.body);
      const account = await User.findOne({ wallet: body.wallet });
      await recordSignedConsent({ ...body, userId: account?._id ?? null });
      res.json({ ok: true });
    })
  );

  r.post(
    "/otp",
    ah(async (req, res) => {
      const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).parse(req.body);
      const code = await issueOtp({ identifier: emailKey(email) }, "identity");
      res.json({ sent: true, ...(config.isTest ? { devOtp: code } : {}) });
    })
  );

  r.post(
    "/verify",
    ah(async (req, res) => {
      const body = verifySchema.parse(req.body);
      checkIdentityProof({ wallet: body.wallet, ...body.proof });

      if (body.method === "email") {
        const otp = await verifyOtp({ identifier: emailKey(body.email) }, "identity", body.otp);
        if (!otp.ok) return res.status(400).json({ error: otp.reason });
      }
      // Check every consent signature before anything is stored.
      for (const c of body.consents) await checkSignedConsent({ wallet: body.wallet, ...c });
      const account = await User.findOne({ wallet: body.wallet });
      const { identity, inherited } = await resolveIdentity({
        type: body.method === "email" ? "email" : "pan",
        value: body.method === "email" ? body.email : body.idNumber,
        wallet: body.wallet,
        chain,
        userId: account?._id ?? null,
        cluster: { deviceHash: req.get("x-device-fingerprint")?.slice(0, 128), fundingWallet: body.wallet },
      });
      for (const c of body.consents) {
        await recordSignedConsent({ wallet: body.wallet, userId: account?._id ?? null, ...c });
      }
      if (body.employer) await saveEmployerContact({ wallet: body.wallet, userId: account?._id ?? null, ...body.employer });
      if (account && !account.identity) {
        await User.updateOne({ _id: account._id }, { identity: identity._id, identityHash: identity.identityHash });
      }

      const signed = await signForIdentity({
        wallet: body.wallet,
        identity,
        income: { assessedMonthlyInr: body.monthlyIncomeInr, stabilityBand: "variable", payoutFrequency: body.payoutFrequency, declaredDebtInr: 0 },
        chain,
        userId: account?._id ?? null,
      });
      await logAudit("identity", "identity_verified", {
        wallet: body.wallet,
        data: { method: body.method, identityHash: identity.identityHash, inherited },
      });
      res.json({ identityHash: identity.identityHash, inherited, ...signed });
    })
  );

  return r;
}
