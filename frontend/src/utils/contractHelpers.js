import { ethers } from 'ethers';

import DEPLOYED from '../contracts/addresses.json';

// Every ABI copied in by scripts/deploy.js (frontend/src/contracts/<Name>.json).
const ABI_MODULES = import.meta.glob('../contracts/*.json', { eager: true });
const ABIS = Object.fromEntries(
  Object.entries(ABI_MODULES)
    .map(([file, mod]) => [file.split('/').pop().replace('.json', ''), (mod.default || mod).abi])
    .filter(([, abi]) => Array.isArray(abi))
);

// LendingPool → VITE_LENDING_POOL_ADDRESS, GLPToken → VITE_GLP_TOKEN_ADDRESS
const envAddress = (name) =>
  import.meta.env[
    `VITE_${name.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toUpperCase()}_ADDRESS`
  ];

// Addresses come from addresses.json (written by deploy.js); VITE_<NAME>_ADDRESS overrides.
export const CONTRACT_ADDRESSES = Object.fromEntries(
  Object.keys({ ...DEPLOYED, ...ABIS })
    .filter((name) => name !== 'chainId' && name !== 'inrPerEthDemo')
    .map((name) => [name, envAddress(name) || DEPLOYED[name] || null])
);

export const hasContract = (name) => Boolean(ABIS[name] && CONTRACT_ADDRESSES[name]);

export const getContract = (name, providerOrSigner) => {
  if (!hasContract(name)) return null;
  return new ethers.Contract(CONTRACT_ADDRESSES[name], ABIS[name], providerOrSigner);
};

export const getAbi = (name) => ABIS[name];

/**
 * Returns a dedicated provider for cross-client event synchronization.
 * Prioritizes WebSocket provider if VITE_RPC_WS_URL is provided,
 * otherwise falls back to HTTP provider or browser provider.
 */
export const getSyncProvider = (fallbackBrowserProvider) => {
  const wsUrl = import.meta.env.VITE_RPC_WS_URL;
  if (wsUrl) {
    try {
      const wsProvider = new ethers.WebSocketProvider(wsUrl);
      return { provider: wsProvider, mode: 'ws' };
    } catch (err) {
      console.warn('Failed to establish WebSocket provider, falling back to HTTP:', err);
    }
  }

  const httpUrl = import.meta.env.VITE_RPC_HTTP_URL || 'http://127.0.0.1:8545';
  try {
    const httpProvider = new ethers.JsonRpcProvider(httpUrl);
    return { provider: httpProvider, mode: 'http' };
  } catch {
    if (fallbackBrowserProvider) {
      return { provider: fallbackBrowserProvider, mode: 'browser' };
    }
    return { provider: null, mode: 'none' };
  }
};

/**
 * Client-side calculation helper mirroring InterestLib.sol for live preview before borrow submission.
 * `creditScore` is on the 300–900 scale. The exact locked rate comes from RiskEngine.quote and is
 * fixed on-chain at loan origination.
 */
export const calculateEstimatedRateBps = (proposedBorrowWei, currentFreeCashWei, currentActiveLoansWei, creditScore) => {
  const BASE_RATE_BPS = 400n; // 4.00%
  const OPTIMAL_BPS = 8000n;  // 80.00%
  const SLOPE1_BPS = 500n;    // 5.00%
  const SLOPE2_BPS = 2500n;   // 25.00%

  const postActive = currentActiveLoansWei + proposedBorrowWei;
  const totalCapital = currentFreeCashWei + currentActiveLoansWei;

  let poolRateBps = BASE_RATE_BPS;
  if (totalCapital > 0n && postActive > 0n) {
    const utilBps = (postActive * 10000n) / totalCapital;
    if (utilBps <= OPTIMAL_BPS) {
      poolRateBps = BASE_RATE_BPS + (utilBps * SLOPE1_BPS) / OPTIMAL_BPS;
    } else {
      const excess = utilBps - OPTIMAL_BPS;
      const excessRange = 10000n - OPTIMAL_BPS;
      poolRateBps = BASE_RATE_BPS + SLOPE1_BPS + (excess * SLOPE2_BPS) / excessRange;
    }
  }

  let surchargeBps = 200n;
  if (creditScore >= 800) surchargeBps = 0n;
  else if (creditScore >= 700) surchargeBps = 50n;
  else if (creditScore >= 600) surchargeBps = 100n;

  return poolRateBps + surchargeBps;
};
