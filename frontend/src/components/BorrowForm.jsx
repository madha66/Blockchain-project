import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';

const BorrowForm = ({ lendingPoolContract, creditScoreContract, glpTokenContract, account, fetchBalances }) => {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasActiveLoan, setHasActiveLoan] = useState(false);
  const [borrowLimit, setBorrowLimit] = useState('0.5');
  const [userDeposit, setUserDeposit] = useState('0');

  useEffect(() => {
    if (lendingPoolContract && account) {
      const checkLoanAndDeposit = async () => {
        try {
          // Check active loan
          const activeAmt = await lendingPoolContract.activeLoans(account);
          if (activeAmt > 0) setHasActiveLoan(true);
          else setHasActiveLoan(false);

          // Check credit limit
          if (creditScoreContract) {
            const limit = await creditScoreContract.getBorrowLimit(account);
            setBorrowLimit(ethers.formatEther(limit));
          }

          // Check deposit (GLP token balance)
          if (glpTokenContract) {
            const bal = await glpTokenContract.balanceOf(account);
            setUserDeposit(ethers.formatEther(bal));
          }
        } catch (e) {
          console.error(e);
        }
      };
      checkLoanAndDeposit();
    }
  }, [lendingPoolContract, creditScoreContract, glpTokenContract, account, fetchBalances]);

  if (hasActiveLoan) {
    return null; // Hide borrow form if they already have an active loan
  }

  const hasDeposit = Number(userDeposit) > 0;

  const handleBorrow = async (e) => {
    e.preventDefault();
    if (!lendingPoolContract || !amount || Number(amount) <= 0) return;

    if (!hasDeposit) {
      alert('You must deposit ETH into the lending pool first before you can borrow.');
      return;
    }
    
    if (Number(amount) > Number(borrowLimit)) {
      alert(`Borrow amount exceeds your current credit limit of ${borrowLimit} ETH.`);
      return;
    }

    setLoading(true);
    try {
      const tx = await lendingPoolContract.borrow(ethers.parseEther(amount));
      await tx.wait();
      alert('Loan approved and disbursed!');
      setAmount('');
      if (fetchBalances) fetchBalances();
    } catch (err) {
      console.error(err);
      alert('Borrow failed: ' + (err.reason || err.message || 'Check pool liquidity or deposit requirement.'));
    }
    setLoading(false);
  };

  const setMaxBorrow = () => {
    setAmount(borrowLimit);
  };

  return (
    <div className="card">
      <h3>Borrow ETH</h3>
      
      {!hasDeposit ? (
        <div style={{ background: '#3a2410', border: '1px solid #ff9800', padding: '10px', borderRadius: '6px', marginBottom: '12px', fontSize: '0.85rem', color: '#ffb74d' }}>
          ⚠️ <strong>Deposit Required:</strong> You cannot borrow until you deposit ETH into the lending pool. Please make a deposit above first to qualify.
        </div>
      ) : (
        <p style={{ fontSize: '0.85rem', color: '#aaa', margin: '4px 0 10px 0' }}>
          Max Allowed: <strong style={{ color: '#4caf50' }}>{borrowLimit} ETH</strong> (Deposit Verified: {Number(userDeposit).toFixed(3)} GLP)
        </p>
      )}

      <form onSubmit={handleBorrow}>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          <input 
            type="number" 
            step="0.01" 
            placeholder="Amount in ETH" 
            value={amount} 
            onChange={(e) => setAmount(e.target.value)} 
            disabled={loading || !hasDeposit}
            style={{ flex: 1, opacity: !hasDeposit ? 0.6 : 1 }}
          />
          <button
            type="button"
            onClick={setMaxBorrow}
            disabled={loading || !hasDeposit}
            style={{ padding: '6px 12px', fontSize: '0.85rem' }}
          >
            Max
          </button>
        </div>
        <button type="submit" disabled={loading || !amount || Number(amount) <= 0 || !hasDeposit}>
          {loading ? 'Processing...' : (!hasDeposit ? 'Deposit First to Borrow' : 'Borrow')}
        </button>
      </form>
    </div>
  );
};

export default BorrowForm;
