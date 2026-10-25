import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";

export const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * Creates a 6-digit mock OTP, stores only its hash (5-minute expiry) and prints it to the
 * server console in place of a real SMS/email gateway. Returns the code for tests only.
 */
export async function issueOtp(userId, purpose) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = await bcrypt.hash(code, 8);
  await prisma.otp.create({
    data: { userId, purpose, codeHash, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });
  console.log(`[mock-otp] user=${userId} purpose=${purpose} code=${code}`);
  return code;
}

/**
 * Checks the latest unconsumed OTP for the user and purpose. Consumes it on success.
 */
export async function verifyOtp(userId, purpose, code) {
  const otp = await prisma.otp.findFirst({
    where: { userId, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) return { ok: false, reason: "OTP_NOT_FOUND" };
  if (otp.expiresAt.getTime() < Date.now()) return { ok: false, reason: "OTP_EXPIRED" };
  if (otp.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "OTP_LOCKED" };

  const match = await bcrypt.compare(String(code), otp.codeHash);
  if (!match) {
    await prisma.otp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: "OTP_INVALID" };
  }
  await prisma.otp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  return { ok: true };
}
