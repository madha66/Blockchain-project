import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';

const BorrowForm = ({ lendingPoolContract, fetchBalances }) => {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasActiveLoan, setHasActiveLoan] = useState(false);

  useEffect(() => {
    if (lendingPoolContract) {
      const checkLoan = async () => {
        try {
          const signer = await lendingPoolContract.runner;
          if (signer) {
            const address = await signer.getAddress();
            const activeAmt = await lendingPoolContract.activeLoans(address);
            if (activeAmt > 0) setHasActiveLoan(true);
            else setHasActiveLoan(false);
          }
        } catch (e) {
          console.error(e);
        }
      };
      checkLoan();
    }
  }, [lendingPoolContract, fetchBalances]);

  if (hasActiveLoan) {
    return null; // Hide borrow form if they already have an active loan
  }

  const handleBorrow = async (e) => {
    e.preventDefault();
    if (!lendingPoolContract || !amount) return;
    setLoading(true);
    try {
      const tx = await lendingPoolContract.borrow(ethers.parseEther(amount));
      await tx.wait();
      alert('Loan approved and disbursed!');
      setAmount('');
      if (fetchBalances) fetchBalances();
    } catch (err) {
      console.error(err);
      alert('Borrow failed. Check credit score or pool balance.');
    }
    setLoading(false);
  };

  return (
    <div className="card">
      <h3>Borrow ETH</h3>
      <form onSubmit={handleBorrow}>
        <input 
          type="number" 
          step="0.001" 
          placeholder="Amount in ETH" 
          value={amount} 
          onChange={(e) => setAmount(e.target.value)} 
          disabled={loading}
        />
        <button type="submit" disabled={loading || !amount}>
          {loading ? 'Processing...' : 'Borrow'}
        </button>
      </form>
    </div>
  );
};

export default BorrowForm;
