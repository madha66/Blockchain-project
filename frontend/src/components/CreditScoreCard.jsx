import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';

const CreditScoreCard = ({ creditScoreContract, account }) => {
  const [score, setScore] = useState(50);
  const [borrowLimit, setBorrowLimit] = useState('0.5');

  useEffect(() => {
    if (creditScoreContract && account) {
      const getStats = async () => {
        try {
          const s = await creditScoreContract.getScore(account);
          setScore(Number(s));

          const limit = await creditScoreContract.getBorrowLimit(account);
          setBorrowLimit(ethers.formatEther(limit));
        } catch (e) {
          console.error(e);
        }
      };
      getStats();
    }
  }, [creditScoreContract, account]);

  return (
    <div className="card">
      <h3>Your Credit Score</h3>
      <div className="score-display">
        <h1>{score} / 100</h1>
      </div>
      <p style={{ margin: '4px 0 12px 0', fontSize: '0.95rem' }}>
        Current Borrow Limit: <strong style={{ color: '#4caf50' }}>{borrowLimit} ETH</strong>
      </p>
      <div style={{ fontSize: '0.8rem', color: '#aaa', background: '#252525', padding: '8px', borderRadius: '4px' }}>
        <strong>Score Tiers & Borrow Limits:</strong>
        <br />• 0–60 (Initial): <strong>0.5 ETH</strong>
        <br />• 61–75 (Tier 2): <strong>1.5 ETH</strong>
        <br />• 76–90 (Tier 3): <strong>3.0 ETH</strong>
        <br />• 91–100 (Elite): <strong>5.0 ETH</strong>
      </div>
    </div>
  );
};

export default CreditScoreCard;
