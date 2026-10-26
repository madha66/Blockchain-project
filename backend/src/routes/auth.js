import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models.js";
import { ah, clearSession, requireSession, setSession, SESSION_COOKIE } from "../middleware/auth.js";
import { issueOtp, verifyOtp } from "../services/otp.js";
import { createNonce, verifySiwe } from "../services/siwe.js";
import { logAuthEvent } from "../services/audit.js";
import { computeStep } from "../services/signupState.js";
import { config } from "../config.js";
import { publicUser } from "./serialise.js";

const loginSchema = z
  .object({
    identifier: z.string().min(3),
    password: z.string().optional(),
    otp: z.string().regex(/^\d{6}$/).optional(),
  })
  .refine((v) => v.password || v.otp, { message: "password or otp required" });

const findByIdentifier = (identifier) => {
  const id = identifier.trim().toLowerCase();
  return User.findOne({ $or: [{ email: id }, { phone: identifier.replace(/\s+/g, "") }] });
};

export function authRoutes() {
  const r = Router();

  /**
   * Step 1 of login: email/phone + password (or a login OTP). A user with a linked wallet
   * gets a short "preauth" session and must then sign in with Ethereum.
   */
  r.post(
    "/login",
    ah(async (req, res) => {
      const body = loginSchema.parse(req.body);
      const user = await findByIdentifier(body.identifier);
      let ok = false;
      if (user && body.password) ok = await bcrypt.compare(body.password, user.passwordHash);
      if (user && !ok && body.otp) ok = (await verifyOtp(user.id, "login", body.otp)).ok;
      if (!ok) {
        await logAuthEvent("login_failed", user?.id ?? null);
        return res.status(401).json({ error: "INVALID_CREDENTIALS" });
      }

      const step = await computeStep(user.id);
      if (user.wallet && step >= 3) {
        setSession(res, user.id, "preauth");
        await logAuthEvent("login_password_ok", user.id);
        return res.json({ next: "siwe", wallet: user.wallet });
      }
      setSession(res, user.id, "signup");
      await logAuthEvent("login_resume_signup", user.id);
      return res.json({ next: "signup", step });
    })
  );

  r.post(
    "/otp/request",
    ah(async (req, res) => {
      const { identifier } = z.object({ identifier: z.string().min(3) }).parse(req.body);
      const user = await findByIdentifier(identifier);
      let devOtp;
      if (user) {
        devOtp = await issueOtp(user.id, "login");
        await logAuthEvent("login_otp_issued", user.id);
      }
      // Same response whether or not the account exists (no enumeration).
      res.json({ sent: true, ...(config.isTest && devOtp ? { devOtp } : {}) });
    })
  );

  r.post(
    "/siwe/nonce",
    requireSession("preauth", "signup", "full"),
    ah(async (req, res) => {
      const purpose = req.sessionScope === "preauth" ? "login" : "link";
      const nonce = await createNonce(req.user.id, purpose);
      res.json({ nonce, purpose, domain: config.siweDomain, chainId: config.chainId });
    })
  );

  /**
   * Step 2 of login: the SIWE signer must be the wallet linked to this account.
   */
  r.post(
    "/siwe/verify",
    requireSession("preauth"),
    ah(async (req, res) => {
      const { message, signature } = z.object({ message: z.string(), signature: z.string() }).parse(req.body);
      const result = await verifySiwe({ message, signature, userId: req.user.id, purpose: "login" });
      if (!result.ok) {
        await logAuthEvent("siwe_failed", req.user.id);
        return res.status(401).json({ error: result.reason });
      }
      if (result.address !== req.user.wallet) {
        await logAuthEvent("siwe_wallet_mismatch", req.user.id);
        return res.status(401).json({ error: "WALLET_MISMATCH" });
      }
      setSession(res, req.user.id, "full");
      await logAuthEvent("login_ok", req.user.id);
      res.json({ ok: true, user: await publicUser(req.user.id) });
    })
  );

  r.post(
    "/logout",
    ah(async (req, res) => {
      clearSession(res);
      res.json({ ok: true });
    })
  );

  // Logged-out callers get {user: null} rather than a 401, so the SPA can probe quietly.
  r.get(
    "/me",
    (req, res, next) => (req.cookies?.[SESSION_COOKIE] ? next() : res.json({ scope: null, user: null })),
    requireSession("signup", "preauth", "full"),
    ah(async (req, res) => {
      res.json({ scope: req.sessionScope, user: await publicUser(req.user.id) });
    })
  );

  return r;
}
