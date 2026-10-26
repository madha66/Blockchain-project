import crypto from "crypto";
import { ethers } from "ethers";
import { config } from "../config.js";

export const ATTESTATION_TYPES = {
  MemberAttestation: [
    { name: "wallet", type: "address" },
    { name: "idHash", type: "bytes32" },
    { name: "incomeTierWei", type: "uint256" },
    { name: "declaredDebtWei", type: "uint256" },
    { name: "payoutPeriodDays", type: "uint32" },
    { name: "clusterId", type: "bytes32" },
    { name: "cohortId", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
};

// Trusted issuer (Hardhat account #19 locally). Its address holds ATTESTER_ROLE on IdentityRegistry.
export const issuerWallet = () => new ethers.Wallet(config.issuerKey);
export const attesterWallet = issuerWallet;

export function attestationDomain(chainId = config.chainId, verifyingContract = config.addresses.IdentityRegistry) {
  return {
    name: "GigLendIdentity",
    version: "1",
    chainId,
    verifyingContract: verifyingContract || ethers.ZeroAddress,
  };
}

/**
 * Signs an EIP-712 MemberAttestation with the issuer key. The user submits it to
 * IdentityRegistry.register(attestation, sig).
 */
export async function signAttestation(fields, { chainId, verifyingContract } = {}) {
  const attestation = {
    wallet: ethers.getAddress(fields.wallet),
    idHash: fields.idHash,
    incomeTierWei: BigInt(fields.incomeTierWei),
    declaredDebtWei: BigInt(fields.declaredDebtWei),
    payoutPeriodDays: Number(fields.payoutPeriodDays),
    clusterId: fields.clusterId,
    cohortId: Number(fields.cohortId),
    nonce: fields.nonce ?? BigInt("0x" + crypto.randomBytes(16).toString("hex")),
    expiry: BigInt(fields.expiry),
  };
  const domain = attestationDomain(chainId, verifyingContract);
  const signature = await attesterWallet().signTypedData(domain, ATTESTATION_TYPES, attestation);
  return { attestation, signature, domain };
}

/** JSON-safe copy (bigints as strings) for API responses. */
export const serialiseAttestation = (a) =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
