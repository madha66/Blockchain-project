import React, { useState, useEffect } from 'react';

const RepayForm = ({ lendingPoolContract, account, fetchBalances }) => {
  const [dueAmount, setDueAmount] = useState('0');
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
  }, [lendingPoolContract, account, fetchBalances]); // Add fetchBalances to dependency array so it updates on refresh

  if (!lendingPoolContract || dueAmount === '0') {
    return null; // Hide the repay form completely if they owe nothing!
  }

  const handleRepay = async () => {
    if (!lendingPoolContract || dueAmount === '0') return;
    setLoading(true);
    try {
      const tx = await lendingPoolContract.repay({ value: dueAmount });
      await tx.wait();
      alert('Repayment successful!');
      setDueAmount('0');
      if (fetchBalances) fetchBalances();
    } catch (err) {
      console.error(err);
      alert('Repayment failed.');
    }
    setLoading(false);
  };

  return (
    <div className="card">
      <h3>Repay Loan</h3>
      <p>Outstanding Amount: {Number(dueAmount) / 1e18} ETH</p>
      <button onClick={handleRepay} disabled={loading || dueAmount === '0'}>
        {loading ? 'Repaying...' : 'Repay Full Amount'}
      </button>
    </div>
  );
};

export default RepayForm;
