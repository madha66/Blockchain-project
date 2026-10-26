// EIP-712 MemberAttestation signing shared by deploy.js and demoScenarios.js.
// The backend has its own copy (backend/src/services/attester.js) with the same types.
import { ethers } from "ethers";

// Hardhat account #19: the local trusted issuer (ISSUER_ROLE / ATTESTER_ROLE). Test key only.
export const DEFAULT_ISSUER_KEY = "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e";

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

export function issuerWallet() {
  return new ethers.Wallet(process.env.ISSUER_PRIVATE_KEY || DEFAULT_ISSUER_KEY);
}

/**
 * Signs an attestation for `wallet` and submits it from that wallet's signer.
 * Returns the member id. Skips wallets that are already registered.
 */
export async function registerWithIssuer(registry, walletSigner, fields) {
  const address = await walletSigner.getAddress();
  const existing = await registry.memberOf(address);
  if (existing !== 0n) return existing;

  const provider = walletSigner.provider;
  const { chainId } = await provider.getNetwork();
  const latest = await provider.getBlock("latest");
  const attestation = {
    wallet: address,
    idHash: fields.idHash,
    incomeTierWei: fields.incomeTierWei ?? ethers.parseEther("0.3"),
    declaredDebtWei: fields.declaredDebtWei ?? 0n,
    payoutPeriodDays: fields.payoutPeriodDays ?? 7,
    clusterId: fields.clusterId ?? ethers.id(`cluster-${address}`),
    cohortId: fields.cohortId ?? 202643,
    nonce: BigInt(ethers.hexlify(ethers.randomBytes(16))),
    expiry: BigInt(latest.timestamp + 365 * 86400),
  };
  const domain = { name: "GigLendIdentity", version: "1", chainId, verifyingContract: await registry.getAddress() };
  const signature = await issuerWallet().signTypedData(domain, ATTESTATION_TYPES, attestation);
  await (await registry.connect(walletSigner).register(attestation, signature)).wait();
  return registry.memberOf(address);
}
