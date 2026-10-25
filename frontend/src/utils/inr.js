import { ethers } from 'ethers';

// Must match scripts/config.js and the backend: ₹1,000 ≈ 0.01 ETH.
export const INR_PER_ETH_DEMO = Number(import.meta.env.VITE_INR_PER_ETH_DEMO || 100000);

export const weiToInr = (wei) => Number(ethers.formatEther(wei ?? 0n)) * INR_PER_ETH_DEMO;

export const formatInr = (rupees) =>
  `₹${Math.round(rupees).toLocaleString('en-IN')}`;

/** "0.0100 ETH (≈ ₹1,000)" */
export const ethWithInr = (wei, digits = 4) =>
  `${Number(ethers.formatEther(wei ?? 0n)).toFixed(digits)} ETH (≈ ${formatInr(weiToInr(wei))})`;
