import React, { useState, useEffect } from 'react';

const CreditScoreCard = ({ creditScoreContract, account }) => {
  const [score, setScore] = useState(0);

  useEffect(() => {
    if (creditScoreContract && account) {
      const getScore = async () => {
        try {
          const s = await creditScoreContract.getScore(account);
          setScore(s.toString());
        } catch (e) {
          console.error(e);
        }
      };
      getScore();
    }
  }, [creditScoreContract, account]);

  return (
    <div className="card">
      <h3>Your Credit Score</h3>
      <div className="score-display">
        <h1>{score} / 100</h1>
      </div>
      <p>
        Score affects borrowing limits. 
        <br/>
        41-60: 0.05 ETH | 61-80: 0.1 ETH | 81-100: 0.2 ETH
      </p>
    </div>
  );
};

export default CreditScoreCard;
