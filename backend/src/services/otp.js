import crypto from "crypto";
import bcrypt from "bcryptjs";
import { Otp } from "../models.js";

export const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// An OTP belongs either to an account (userId) or to an identifier being verified (email).
const ownerFilter = (owner) =>
  typeof owner === "object" && owner?.identifier ? { identifier: owner.identifier } : { user: owner };

/**
 * Creates a 6-digit mock OTP, stores only its hash (5-minute expiry) and prints it to the
 * server console in place of a real SMS/email gateway. Returns the code for tests only.
 */
export async function issueOtp(owner, purpose) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = await bcrypt.hash(code, 8);
  await Otp.create({ ...ownerFilter(owner), purpose, codeHash, expiresAt: new Date(Date.now() + OTP_TTL_MS) });
  const who = owner?.identifier ? "identifier" : `user=${owner}`;
  console.log(`[mock-otp] ${who} purpose=${purpose} code=${code}`);
  return code;
}

/**
 * Checks the latest unconsumed OTP for the owner and purpose. Consumes it on success.
 */
export async function verifyOtp(owner, purpose, code) {
  const otp = await Otp.findOne({ ...ownerFilter(owner), purpose, consumedAt: null }).sort({ createdAt: -1 });
  if (!otp) return { ok: false, reason: "OTP_NOT_FOUND" };
  if (otp.expiresAt.getTime() < Date.now()) return { ok: false, reason: "OTP_EXPIRED" };
  if (otp.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "OTP_LOCKED" };

  const match = await bcrypt.compare(String(code), otp.codeHash);
  if (!match) {
    await Otp.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    return { ok: false, reason: "OTP_INVALID" };
  }
  await Otp.updateOne({ _id: otp._id }, { consumedAt: new Date() });
  return { ok: true };
}
