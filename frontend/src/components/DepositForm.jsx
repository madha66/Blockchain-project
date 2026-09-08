import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';

const DepositForm = ({ lendingPoolContract, account, fetchBalances }) => {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [dueAmount, setDueAmount] = useState('0');

  useEffect(() => {
    if (lendingPoolContract && account) {
      const checkDue = async () => {
        try {
          const due = await lendingPoolContract.getRepaymentAmount(account);
          setDueAmount(due.toString());
        } catch (e) {
          console.error(e);
        }
      };
      checkDue();
    }
  }, [lendingPoolContract, account, fetchBalances]);

  const handleDeposit = async (e) => {
    e.preventDefault();
    if (!lendingPoolContract || !amount || Number(amount) <= 0) return;
    setLoading(true);
    try {
      const tx = await lendingPoolContract.deposit({ value: ethers.parseEther(amount) });
      await tx.wait();
      alert('Deposit transaction successful!');
      setAmount('');
      if (fetchBalances) fetchBalances();
    } catch (err) {
      console.error(err);
      alert('Deposit failed: ' + (err.reason || err.message));
    }
    setLoading(false);
  };

  return (
    <div className="card">
      <h3>Deposit ETH</h3>
      {dueAmount !== '0' && (
        <p style={{ fontSize: '0.85em', color: '#ffcc00', marginBottom: '8px' }}>
          ℹ️ You have an active loan of <strong>{ethers.formatEther(dueAmount)} ETH</strong>. Depositing ETH will first reduce your outstanding loan before minting GLP tokens.
        </p>
      )}
      <form onSubmit={handleDeposit}>
        <input 
          type="number" 
          step="0.001" 
          placeholder="Amount in ETH" 
          value={amount} 
          onChange={(e) => setAmount(e.target.value)} 
          disabled={loading}
        />
        <button type="submit" disabled={loading || !amount || Number(amount) <= 0}>
          {loading ? 'Depositing...' : 'Deposit'}
        </button>
      </form>
    </div>
  );
};

export default DepositForm;
