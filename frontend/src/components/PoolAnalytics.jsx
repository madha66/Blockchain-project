import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';

const PoolAnalytics = ({ lendingPoolContract, glpTokenContract, account }) => {
  const [totalLoans, setTotalLoans] = useState('0');
  const [glpBalance, setGlpBalance] = useState('0');

  useEffect(() => {
    if (lendingPoolContract && glpTokenContract && account) {
      const fetchStats = async () => {
        try {
          const loans = await lendingPoolContract.totalActiveLoans();
          setTotalLoans(ethers.formatEther(loans));

          const bal = await glpTokenContract.balanceOf(account);
          setGlpBalance(ethers.formatEther(bal));
        } catch (e) {
          console.error(e);
        }
      };
      fetchStats();
    }
  }, [lendingPoolContract, glpTokenContract, account]);

  return (
    <div className="card">
      <h3>Pool Analytics</h3>
      <p>Total Active Loans: {totalLoans} ETH</p>
      <p>Your GLP Balance: {glpBalance} GLP</p>
    </div>
  );
};

export default PoolAnalytics;
