import { Router } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import { z } from "zod";
import { ethers } from "ethers";
import { Consent, GigProfile, Identity, User } from "../models.js";
import { ah, requireSession, setSession } from "../middleware/auth.js";
import { issueOtp, verifyOtp } from "../services/otp.js";
import { verifySiwe } from "../services/siwe.js";
import { logAuthEvent } from "../services/audit.js";
import { computeStep, refreshStep } from "../services/signupState.js";
import { PAN_REGEX, idHashFor, normalisePan, storeEncryptedSelfie } from "../services/identity.js";
import { resolveIdentity } from "../services/identityStore.js";
import { assessIncome, totalDeclaredDebtInr } from "../services/income.js";
import { buildAttestation } from "../services/attestationBuilder.js";
import { config } from "../config.js";
import { publicUser } from "./serialise.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const accountSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: z
    .string()
    .transform((p) => p.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\+?\d{10,13}$/, "phone must be 10–13 digits")),
  password: z.string().min(8).max(128),
});

const incomeSchema = z.object({
  platform: z.string().trim().min(2).max(40),
  workerId: z.string().trim().min(2).max(40),
  monthsActive: z.coerce.number().int().min(0).max(600),
  payoutFrequency: z.enum(["weekly", "biweekly"]),
  monthlyPayouts: z.array(z.coerce.number().min(0).max(10_000_000)).min(3).max(6),
  declaredDebts: z
    .array(z.object({ lender: z.string().trim().min(1).max(60), emiInr: z.coerce.number().min(0).max(10_000_000) }))
    .default([]),
});

const consentSchema = z.object({
  dataUse: z.literal(true, { errorMap: () => ({ message: "data-use consent is required" }) }),
  autopay: z.boolean().default(true),
  peerVisibility: z.boolean().default(false),
});

export function signupRoutes({ chain }) {
  const r = Router();
  const session = requireSession("signup", "full");

  /** Step 1: account. Email and phone are unique. A mock OTP goes to the console. */
  r.post(
    "/account",
    ah(async (req, res) => {
      const body = accountSchema.parse(req.body);
      const clash = await User.findOne({ $or: [{ email: body.email }, { phone: body.phone }] });
      if (clash) return res.status(409).json({ error: "ACCOUNT_EXISTS" });

      const user = await User.create({
        name: body.name,
        email: body.email,
        phone: body.phone,
        passwordHash: await bcrypt.hash(body.password, 10),
        deviceHash: req.get("x-device-fingerprint")?.slice(0, 128) || null,
      });
      const code = await issueOtp(user.id, "signup");
      setSession(res, user.id, "signup");
      await logAuthEvent("signup_started", user.id);
      res.status(201).json({ userId: user.id, step: 1, next: "verify-otp", ...(config.isTest ? { devOtp: code } : {}) });
    })
  );

  r.post(
    "/otp/verify",
    session,
    ah(async (req, res) => {
      const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
      const result = await verifyOtp(req.user.id, "signup", code);
      if (!result.ok) return res.status(400).json({ error: result.reason });
      await User.updateOne({ _id: req.user._id }, { contactVerified: true });
      await logAuthEvent("signup_otp_verified", req.user.id);
      res.json({ step: await refreshStep(req.user.id) });
    })
  );

  r.post(
    "/otp/resend",
    session,
    ah(async (req, res) => {
      const code = await issueOtp(req.user.id, "signup");
      res.json({ sent: true, ...(config.isTest ? { devOtp: code } : {}) });
    })
  );

  /** Step 2: link wallet via SIWE. One wallet per user; changing it needs an unlink first. */
  r.post(
    "/wallet",
    session,
    ah(async (req, res) => {
      if (!req.user.contactVerified) return res.status(400).json({ error: "VERIFY_OTP_FIRST" });
      const { message, signature } = z.object({ message: z.string(), signature: z.string() }).parse(req.body);
      const result = await verifySiwe({ message, signature, userId: req.user.id, purpose: "link" });
      if (!result.ok) return res.status(401).json({ error: result.reason });

      if (req.user.wallet && req.user.wallet !== result.address) {
        return res.status(409).json({ error: "WALLET_ALREADY_LINKED" });
      }
      const owner = await User.findOne({ wallet: result.address });
      if (owner && owner.id !== req.user.id) return res.status(409).json({ error: "WALLET_TAKEN" });

      // One identity per wallet: a wallet already registered on-chain can only be linked by the
      // account that holds that identity (so KYC cannot fail later with WALLET_HAS_IDENTITY).
      const identity = req.user.identity ? await Identity.findById(req.user.identity) : null;
      const onChain = await chain.identityOf(result.address);
      if (onChain && onChain !== ethers.ZeroHash && onChain !== identity?.identityHash) {
        await logAuthEvent("wallet_link_refused_has_identity", req.user.id);
        return res.status(409).json({ error: "WALLET_HAS_IDENTITY" });
      }

      // Re-linking after an unlink: the identity's active wallet follows, if it is free.
      if (identity) {
        if (identity.linkedWallet && identity.linkedWallet !== result.address) {
          return res.status(409).json({ error: "IDENTITY_WALLET_ACTIVE" });
        }
        identity.linkedWallet = result.address;
        await identity.save();
      }
      await User.updateOne({ _id: req.user._id }, { wallet: result.address });
      await logAuthEvent("wallet_linked", req.user.id);
      res.json({ wallet: result.address, step: await refreshStep(req.user.id) });
    })
  );

  /**
   * Back to step 2 to link a different wallet. Only before identity verification: once an
   * identity exists, changing wallets goes through unlink on the profile page.
   */
  r.post(
    "/wallet/reset",
    session,
    ah(async (req, res) => {
      if (req.user.identity) return res.status(409).json({ error: "KYC_ALREADY_DONE" });
      await User.updateOne({ _id: req.user._id }, { $unset: { wallet: 1 } });
      await logAuthEvent("wallet_reset", req.user.id);
      res.json({ step: await refreshStep(req.user.id) });
    })
  );

  /**
   * Step 3: mock KYC. PAN-format string + Aadhaar last-4 (never a full Aadhaar) + selfie.
   * A known idHash attaches this account to the existing identity (inheriting its history),
   * but only if that identity has no other active wallet.
   */
  r.post(
    "/kyc",
    session,
    upload.single("selfie"),
    ah(async (req, res) => {
      if (!req.user.wallet) return res.status(400).json({ error: "LINK_WALLET_FIRST" });
      const body = z
        .object({
          pan: z.string().transform(normalisePan).pipe(z.string().regex(PAN_REGEX, "PAN format is AAAAA9999A")),
          aadhaarRef: z.string().regex(/^\d{4}$/, "enter only the last 4 digits of Aadhaar"),
        })
        .parse(req.body);
      if (!req.file) return res.status(400).json({ error: "SELFIE_REQUIRED" });

      if (req.user.identity) {
        const current = await Identity.findById(req.user.identity);
        if (current && current.identityHash !== idHashFor(body.pan)) {
          return res.status(409).json({ error: "KYC_ALREADY_DONE" });
        }
      }
      // Banned and duplicate identities are refused here (IDENTITY_BANNED / IDENTITY_WALLET_ACTIVE).
      const { identity, inherited: attached } = await resolveIdentity({
        type: "pan",
        value: body.pan,
        wallet: req.user.wallet,
        chain,
        userId: req.user._id,
        aadhaarRef: body.aadhaarRef,
        cluster: { phone: req.user.phone, deviceHash: req.user.deviceHash, fundingWallet: req.user.fundingWallet },
        createdAt: req.user.createdAt,
      });
      const inherited = attached && String(req.user.identity) !== String(identity._id);
      identity.selfiePath = storeEncryptedSelfie(req.file.buffer, identity.id);
      await identity.save();
      await User.updateOne({ _id: req.user._id }, { identity: identity._id, identityHash: identity.identityHash });
      await logAuthEvent(inherited ? "kyc_identity_inherited" : "kyc_ok", req.user.id);
      res.json({ inherited, step: await refreshStep(req.user.id) });
    })
  );

  /** Step 4: gig and income profile, including every declared EMI. */
  r.post(
    "/income",
    session,
    ah(async (req, res) => {
      if (!req.user.identity) return res.status(400).json({ error: "KYC_FIRST" });
      const body = incomeSchema.parse(req.body);
      const assessed = assessIncome(body.monthlyPayouts);
      const data = {
        platform: body.platform,
        workerId: body.workerId,
        monthsActive: body.monthsActive,
        payoutFrequency: body.payoutFrequency,
        monthlyPayouts: body.monthlyPayouts,
        declaredDebts: body.declaredDebts,
        assessedMonthlyInr: assessed.assessedMonthlyInr,
        declaredDebtInr: Math.round(totalDeclaredDebtInr(body.declaredDebts)),
        stabilityBand: assessed.stabilityBand,
      };
      await GigProfile.updateOne({ user: req.user._id }, { $set: data }, { upsert: true });
      res.json({ ...assessed, declaredDebtInr: data.declaredDebtInr, step: await refreshStep(req.user.id) });
    })
  );

  /** Step 5: consent (timestamped, append-only). Completing it returns the signed attestation. */
  r.post(
    "/consent",
    session,
    ah(async (req, res) => {
      if ((await computeStep(req.user.id)) < 5) return res.status(400).json({ error: "PREVIOUS_STEPS_INCOMPLETE" });
      const body = consentSchema.parse(req.body);
      const base = { user: req.user._id, wallet: req.user.wallet, timestamp: new Date() };
      await Consent.insertMany([
        { ...base, type: "data_use", granted: true },
        { ...base, type: "autopay", granted: body.autopay },
        { ...base, type: "peer_visibility", granted: body.peerVisibility },
      ]);
      const step = await refreshStep(req.user.id);
      // The wallet was proven by SIWE in this session, so the session becomes a full login.
      setSession(res, req.user.id, "full");
      await logAuthEvent("signup_completed", req.user.id);
      const attestation = await buildAttestation(req.user.id, chain);
      res.json({ step, attestation, user: await publicUser(req.user.id) });
    })
  );

  r.get(
    "/status",
    session,
    ah(async (req, res) => {
      res.json({ step: await computeStep(req.user.id), user: await publicUser(req.user.id) });
    })
  );

  return r;
}
