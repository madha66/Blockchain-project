import { ethers } from "ethers";
import { config } from "../config.js";

const LOAN_MANAGER_ABI = ["function hasOpenLoan(uint256 memberId) view returns (bool)"];
const REGISTRY_ABI = [
  "function memberByIdHash(bytes32) view returns (uint256)",
  "function isIdentityBanned(bytes32) view returns (bool)",
  "function identityOf(address) view returns (bytes32)",
  "function memberOf(address) view returns (uint256)",
  "function isVerified(address) view returns (bool)",
  "function isBanned(address) view returns (bool)",
];
const POOL_ABI = ["function expelled(address) view returns (bool)"];
const DEFAULTS_ABI = ["function claimOf(uint256) view returns (uint256)", "function settlementQuote(uint256) view returns (uint256)"];

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

    async isIdentityBanned(idHash) {
      if (!addresses.IdentityRegistry) return false;
      try {
        const reg = new ethers.Contract(addresses.IdentityRegistry, REGISTRY_ABI, provider);
        return await reg.isIdentityBanned(idHash);
      } catch {
        return false;
      }
    },

    async identityOf(wallet) {
      if (!addresses.IdentityRegistry) return null;
      try {
        const reg = new ethers.Contract(addresses.IdentityRegistry, REGISTRY_ABI, provider);
        return await reg.identityOf(wallet);
      } catch {
        return null;
      }
    },

    /** Verification, ban, expulsion and debt for one wallet, read live from the chain. */
    async walletStatus(wallet) {
      const empty = { memberId: "0", verified: false, banned: false, expelled: false, identityHash: null, outstandingWei: "0", settlementQuoteWei: "0" };
      if (!addresses.IdentityRegistry) return empty;
      try {
        const reg = new ethers.Contract(addresses.IdentityRegistry, REGISTRY_ABI, provider);
        const [memberId, verified, banned, idHash] = await Promise.all([
          reg.memberOf(wallet),
          reg.isVerified(wallet),
          reg.isBanned(wallet),
          reg.identityOf(wallet),
        ]);
        const expelled = addresses.LendingPool
          ? await new ethers.Contract(addresses.LendingPool, POOL_ABI, provider).expelled(wallet)
          : false;
        let outstanding = 0n;
        let quote = 0n;
        if (memberId !== 0n && addresses.DefaultManager) {
          const dm = new ethers.Contract(addresses.DefaultManager, DEFAULTS_ABI, provider);
          [outstanding, quote] = await Promise.all([dm.claimOf(memberId), dm.settlementQuote(memberId)]);
        }
        return {
          memberId: memberId.toString(),
          verified,
          banned,
          expelled,
          identityHash: idHash === ethers.ZeroHash ? null : idHash,
          outstandingWei: outstanding.toString(),
          settlementQuoteWei: quote.toString(),
        };
      } catch {
        return empty;
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
