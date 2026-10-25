import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { config } from "../config.js";

export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const normalisePan = (pan) => String(pan).replace(/\s+/g, "").toUpperCase();

/**
 * idHash = keccak256(normalisedPAN ‖ ID_PEPPER). Only this hash identifies a person on-chain.
 */
export function idHashFor(pan, pepper = config.idPepper) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${normalisePan(pan)}${pepper}`));
}

export const maskPan = (pan) => {
  const p = normalisePan(pan);
  return `${p.slice(0, 2)}${"x".repeat(p.length - 4)}${p.slice(-2)}`;
};

// Selfies are encrypted at rest with AES-256-GCM. The key is derived from the pepper so the
// prototype needs no extra secret; production would use a KMS-held key.
const selfieKey = () => crypto.scryptSync(config.idPepper, "giglend-selfie-v1", 32);

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
