import React, { useState } from 'react';
import { ethers } from 'ethers';

const DepositForm = ({ lendingPoolContract, fetchBalances }) => {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);

  const handleDeposit = async (e) => {
    e.preventDefault();
    if (!lendingPoolContract || !amount) return;
    setLoading(true);
    try {
      const tx = await lendingPoolContract.deposit({ value: ethers.parseEther(amount) });
      await tx.wait();
      alert('Deposit successful!');
      setAmount('');
      if (fetchBalances) fetchBalances();
    } catch (err) {
      console.error(err);
      alert('Deposit failed.');
    }
    setLoading(false);
  };

  return (
    <div className="card">
      <h3>Deposit ETH</h3>
      <form onSubmit={handleDeposit}>
        <input 
          type="number" 
          step="0.001" 
          placeholder="Amount in ETH" 
          value={amount} 
          onChange={(e) => setAmount(e.target.value)} 
          disabled={loading}
        />
        <button type="submit" disabled={loading || !amount}>
          {loading ? 'Depositing...' : 'Deposit'}
        </button>
      </form>
    </div>
  );
};

export default DepositForm;
