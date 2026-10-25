import { ethers } from "ethers";
import { config } from "../config.js";

const LOAN_MANAGER_ABI = ["function hasOpenLoan(uint256 memberId) view returns (bool)"];
const REGISTRY_ABI = ["function memberByIdHash(bytes32) view returns (uint256)"];

/**
 * Thin chain adapter. Every method degrades gracefully when no node or address is configured,
 * so the auth flow works before contracts are deployed. Tests inject a stub instead.
 */
export function createChain({ rpcUrl = config.rpcUrl, addresses = config.addresses } = {}) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });

  return {
    provider,

    async now() {
      try {
        const block = await provider.getBlock("latest");
        return Number(block.timestamp);
      } catch {
        return Math.floor(Date.now() / 1000);
      }
    },

    async memberIdForIdHash(idHash) {
      if (!addresses.IdentityRegistry) return 0n;
      try {
        const reg = new ethers.Contract(addresses.IdentityRegistry, REGISTRY_ABI, provider);
        return await reg.memberByIdHash(idHash);
      } catch {
        return 0n;
      }
    },

    async hasOpenLoanForIdHash(idHash) {
      if (!addresses.LoanManager) return false;
      const memberId = await this.memberIdForIdHash(idHash);
      if (memberId === 0n) return false;
      try {
        const lm = new ethers.Contract(addresses.LoanManager, LOAN_MANAGER_ABI, provider);
        return await lm.hasOpenLoan(memberId);
      } catch {
        return false;
      }
    },
  };
}
