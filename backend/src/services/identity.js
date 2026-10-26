import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { config } from "../config.js";

export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const normalisePan = (pan) => String(pan).replace(/\s+/g, "").toUpperCase();
export const normaliseEmail = (email) => String(email).trim().toLowerCase();
const normalise = (type, value) => (type === "email" ? normaliseEmail(value) : normalisePan(value));

function encryptionKey() {
  const hex = config.idEncryptionKey;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex || "")) throw new Error("ID_ENCRYPTION_KEY must be 32 bytes of hex");
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

/**
 * Per-identity salt = HMAC-SHA256(ID_ENCRYPTION_KEY, type:identifier). It is deterministic, so
 * the same person always maps to the same hash (duplicates and bans are detectable), but the
 * hash cannot be brute-forced from a list of PANs or emails without the server key.
 */
export function saltFor(type, value) {
  return crypto.createHmac("sha256", encryptionKey()).update(`${type}:${normalise(type, value)}`).digest("hex");
}

/**
 * identityHash = keccak256(salt ‖ normalised identifier). Only this hash goes on-chain.
 */
export function identityHashFor(type, value) {
  const salt = saltFor(type, value);
  const hash = ethers.keccak256(ethers.concat([`0x${salt}`, ethers.toUtf8Bytes(normalise(type, value))]));
  return { identityHash: hash, salt };
}

/** Kept for callers that only deal in PANs. */
export const idHashFor = (pan) => identityHashFor("pan", pan).identityHash;

/** AES-256-GCM, stored as iv:tag:ciphertext (hex). */
export function encryptIdentifier(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("hex")).join(":");
}

export function decryptIdentifier(stored) {
  const [iv, tag, enc] = stored.split(":").map((h) => Buffer.from(h, "hex"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export const maskPan = (pan) => {
  const p = normalisePan(pan);
  return `${p.slice(0, 2)}${"x".repeat(p.length - 4)}${p.slice(-2)}`;
};

export const maskEmail = (email) => {
  const [local, domain] = normaliseEmail(email).split("@");
  return `${local.slice(0, 1)}${"x".repeat(Math.max(local.length - 1, 1))}@${domain}`;
};

export const maskIdentifier = (type, value) => (type === "email" ? maskEmail(value) : maskPan(value));

// Selfies are encrypted at rest with AES-256-GCM under a key derived from ID_ENCRYPTION_KEY.
const selfieKey = () => crypto.createHmac("sha256", encryptionKey()).update("giglend-selfie-v1").digest();

export function storeEncryptedSelfie(buffer, ownerId) {
  const dir = path.resolve(config.uploadsDir);
  fs.mkdirSync(dir, { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", selfieKey(), iv);
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const file = path.join(dir, `${ownerId}-${crypto.randomBytes(6).toString("hex")}.selfie.enc`);
  fs.writeFileSync(file, Buffer.concat([iv, tag, enc]));
  return file;
}

export function readEncryptedSelfie(file) {
  const raw = fs.readFileSync(file);
  const decipher = crypto.createDecipheriv("aes-256-gcm", selfieKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}
