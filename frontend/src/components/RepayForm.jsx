import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';

const RepayForm = ({ lendingPoolContract, account, fetchBalances }) => {
  const [dueAmount, setDueAmount] = useState('0');
  const [repayAmount, setRepayAmount] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (lendingPoolContract && account) {
      const getDue = async () => {
        try {
          const amt = await lendingPoolContract.getRepaymentAmount(account);
          setDueAmount(amt.toString());
        } catch (e) {
          console.error(e);
        }
      };
      getDue();
    }
  }, [lendingPoolContract, account, fetchBalances]);

  if (!lendingPoolContract || dueAmount === '0') {
    return null; // Hide repay form if no active loan
  }

  const handleRepay = async (e) => {
    e.preventDefault();
    if (!lendingPoolContract || !repayAmount || Number(repayAmount) <= 0) return;
    
    setLoading(true);
    try {
      const tx = await lendingPoolContract.repay({ value: ethers.parseEther(repayAmount) });
      await tx.wait();
      alert('Repayment successful! Outstanding loan has been reduced.');
      setRepayAmount('');
      if (fetchBalances) fetchBalances();
    } catch (err) {
      console.error(err);
      alert('Repayment failed: ' + (err.reason || err.message));
    }
    setLoading(false);
  };

  const setFullAmount = () => {
    setRepayAmount(ethers.formatEther(dueAmount));
  };

  return (
    <div className="card">
      <h3>Repay Loan</h3>
      <p>
        Outstanding (with 5% interest): <strong>{ethers.formatEther(dueAmount)} ETH</strong>
      </p>
      <form onSubmit={handleRepay}>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          <input
            type="number"
            step="0.0001"
            placeholder="Amount to repay in ETH"
            value={repayAmount}
            onChange={(e) => setRepayAmount(e.target.value)}
            disabled={loading}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={setFullAmount}
            disabled={loading}
            style={{ padding: '6px 12px', fontSize: '0.85rem' }}
          >
            Pay Full
          </button>
        </div>
        <button type="submit" disabled={loading || !repayAmount || Number(repayAmount) <= 0}>
          {loading ? 'Processing...' : '💳 Submit Repayment'}
        </button>
      </form>
    </div>
  );
};

export default RepayForm;
