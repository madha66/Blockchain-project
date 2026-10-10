import { ethers } from 'ethers';

import LendingPoolABI from '../contracts/LendingPool.json';
import CreditScoreABI from '../contracts/CreditScore.json';
import GLPTokenABI from '../contracts/GLPToken.json';

export const CONTRACT_ADDRESSES = {
  LendingPool: import.meta.env.VITE_LENDING_POOL_ADDRESS || '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  CreditScore: import.meta.env.VITE_CREDIT_SCORE_ADDRESS || '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  GLPToken: import.meta.env.VITE_GLP_TOKEN_ADDRESS || '0x5FbDB2315678afecb367f032d93F642f64180aa3',
};

export const getContract = (name, providerOrSigner) => {
  let abi;
  if (name === 'LendingPool') abi = LendingPoolABI.abi;
  else if (name === 'CreditScore') abi = CreditScoreABI.abi;
  else if (name === 'GLPToken') abi = GLPTokenABI.abi;

  const address = CONTRACT_ADDRESSES[name];
  return new ethers.Contract(address, abi, providerOrSigner);
};

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
 * Exact locked rate is confirmed on-chain at loan origination.
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
  if (creditScore >= 90) surchargeBps = 0n;
  else if (creditScore >= 75) surchargeBps = 50n;
  else if (creditScore >= 60) surchargeBps = 100n;

  return poolRateBps + surchargeBps;
};
