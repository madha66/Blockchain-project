import hre from "hardhat";

const { ethers } = hre;

let nonceCounter = 1n;

export const idHashOf = (pan, pepper = "test-pepper") =>
  ethers.keccak256(ethers.toUtf8Bytes(`${pan.trim().toUpperCase()}${pepper}`));

/**
 * Builds and signs a MemberAttestation with the given attester signer (EIP-712).
 */
export async function signAttestation(registry, attester, fields) {
  const network = await ethers.provider.getNetwork();
  const latest = await ethers.provider.getBlock("latest");
  const attestation = {
    wallet: fields.wallet,
    idHash: fields.idHash,
    incomeTierWei: fields.incomeTierWei ?? ethers.parseEther("0.3"),
    declaredDebtWei: fields.declaredDebtWei ?? 0n,
    payoutPeriodDays: fields.payoutPeriodDays ?? 7,
    clusterId: fields.clusterId ?? ethers.id(`cluster-${fields.wallet}`),
    cohortId: fields.cohortId ?? 202643,
    nonce: fields.nonce ?? nonceCounter++,
    expiry: fields.expiry ?? BigInt(latest.timestamp) + 365n * 86400n,
  };
  const domain = {
    name: "GigLendIdentity",
    version: "1",
    chainId: network.chainId,
    verifyingContract: await registry.getAddress(),
  };
  const types = {
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
  const signature = await attester.signTypedData(domain, types, attestation);
  return { attestation, signature };
}

/**
 * Signs and submits an attestation from `wallet`. Returns the memberId.
 */
export async function registerMember(registry, attester, wallet, fields = {}) {
  const { attestation, signature } = await signAttestation(registry, attester, {
    wallet: wallet.address,
    idHash: fields.idHash ?? idHashOf(`PAN-${wallet.address}`),
    ...fields,
  });
  await (await registry.connect(wallet).register(attestation, signature)).wait();
  return registry.memberOf(wallet.address);
}
