import { SiweMessage, generateNonce } from "siwe";
import { prisma } from "../db.js";
import { config } from "../config.js";

const NONCE_TTL_MS = 5 * 60 * 1000;

export async function createNonce(userId, purpose) {
  const nonce = generateNonce();
  await prisma.siweNonce.create({
    data: { nonce, userId, purpose, expiresAt: new Date(Date.now() + NONCE_TTL_MS) },
  });
  return nonce;
}

/**
 * Verifies an EIP-4361 message + signature against a single-use nonce issued to this user.
 * Returns the lowercase signing address.
 */
export async function verifySiwe({ message, signature, userId, purpose }) {
  let parsed;
  try {
    parsed = new SiweMessage(message);
  } catch {
    return { ok: false, reason: "SIWE_MALFORMED" };
  }
  const record = await prisma.siweNonce.findUnique({ where: { nonce: parsed.nonce } });
  if (!record || record.userId !== userId || record.purpose !== purpose) return { ok: false, reason: "SIWE_NONCE_UNKNOWN" };
  if (record.usedAt) return { ok: false, reason: "SIWE_NONCE_USED" };
  if (record.expiresAt.getTime() < Date.now()) return { ok: false, reason: "SIWE_NONCE_EXPIRED" };
  if (parsed.domain !== config.siweDomain) return { ok: false, reason: "SIWE_DOMAIN_MISMATCH" };
  if (Number(parsed.chainId) !== config.chainId) return { ok: false, reason: "SIWE_CHAIN_MISMATCH" };

  try {
    const result = await parsed.verify({ signature, nonce: record.nonce, domain: config.siweDomain });
    if (!result.success) return { ok: false, reason: "SIWE_BAD_SIGNATURE" };
  } catch {
    return { ok: false, reason: "SIWE_BAD_SIGNATURE" };
  }
  await prisma.siweNonce.update({ where: { nonce: record.nonce }, data: { usedAt: new Date() } });
  return { ok: true, address: parsed.address.toLowerCase() };
}
