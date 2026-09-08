import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';

const PoolAnalytics = ({ lendingPoolContract, glpTokenContract, account }) => {
  const [poolEthBalance, setPoolEthBalance] = useState('0');
  const [totalLoans, setTotalLoans] = useState('0');
  const [totalGlpSupply, setTotalGlpSupply] = useState('0');
  const [userGlpBalance, setUserGlpBalance] = useState('0');

  const fetchStats = useCallback(async () => {
    if (!lendingPoolContract || !glpTokenContract) return;

    try {
      const lendingPoolAddr = await lendingPoolContract.getAddress();
      const provider = lendingPoolContract.runner?.provider || lendingPoolContract.runner;

      // 1. Available ETH Liquidity in Pool
      if (provider && provider.getBalance) {
        const poolBal = await provider.getBalance(lendingPoolAddr);
        setPoolEthBalance(ethers.formatEther(poolBal));
      }

      // 2. Total active loans currently borrowed from the pool
      const loans = await lendingPoolContract.totalActiveLoans();
      setTotalLoans(ethers.formatEther(loans));

      // 3. Total GLP tokens minted across all depositors
      const supply = await glpTokenContract.totalSupply();
      setTotalGlpSupply(ethers.formatEther(supply));

      // 4. Current user's GLP tokens
      if (account) {
        const userBal = await glpTokenContract.balanceOf(account);
        setUserGlpBalance(ethers.formatEther(userBal));
      }
    } catch (e) {
      console.error('Error fetching pool analytics:', e);
    }
  }, [lendingPoolContract, glpTokenContract, account]);

  useEffect(() => {
    fetchStats();

    // Listen for real-time contract events to detect loans and deposits instantly
    if (lendingPoolContract) {
      const handleEvent = () => {
        fetchStats();
      };

      lendingPoolContract.on('Borrowed', handleEvent);
      lendingPoolContract.on('Deposited', handleEvent);
      lendingPoolContract.on('Repaid', handleEvent);
      lendingPoolContract.on('Withdrawn', handleEvent);

      return () => {
        lendingPoolContract.off('Borrowed', handleEvent);
        lendingPoolContract.off('Deposited', handleEvent);
        lendingPoolContract.off('Repaid', handleEvent);
        lendingPoolContract.off('Withdrawn', handleEvent);
      };
    }
  }, [lendingPoolContract, fetchStats]);

  const poolEthNum = Number(poolEthBalance);
  const loansNum = Number(totalLoans);
  const totalPoolValue = (poolEthNum + loansNum).toFixed(4);

  return (
    <div className="card">
      <h3>Pool Analytics</h3>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
        <div style={{ background: '#262626', padding: '10px', borderRadius: '6px' }}>
          <span style={{ fontSize: '0.8rem', color: '#aaa' }}>Available Pool Liquidity</span>
          <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#4caf50', marginTop: '4px' }}>
            {poolEthNum.toFixed(4)} ETH
          </div>
        </div>

        <div style={{ background: '#262626', padding: '10px', borderRadius: '6px' }}>
          <span style={{ fontSize: '0.8rem', color: '#aaa' }}>Total Active Borrowed</span>
          <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#ff9800', marginTop: '4px' }}>
            {loansNum.toFixed(4)} ETH
          </div>
        </div>

        <div style={{ background: '#262626', padding: '10px', borderRadius: '6px' }}>
          <span style={{ fontSize: '0.8rem', color: '#aaa' }}>Total Pool Value</span>
          <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#bb86fc', marginTop: '4px' }}>
            {totalPoolValue} ETH
          </div>
        </div>

        <div style={{ background: '#262626', padding: '10px', borderRadius: '6px' }}>
          <span style={{ fontSize: '0.8rem', color: '#aaa' }}>Total GLP Supply</span>
          <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#03dac6', marginTop: '4px' }}>
            {Number(totalGlpSupply).toFixed(4)} GLP
          </div>
        </div>
      </div>

      <div style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid #333' }}>
        <p style={{ margin: '4px 0', fontSize: '0.9rem' }}>
          Your Deposit Balance: <strong>{Number(userGlpBalance).toFixed(4)} GLP</strong>
        </p>
      </div>
    </div>
  );
};

export default PoolAnalytics;
