import React, { useState, useEffect } from 'react';
import './index.css';
import { useWallet } from './hooks/useWallet';
import { useContract } from './hooks/useContract';
import ConnectWallet from './components/ConnectWallet';
import DepositForm from './components/DepositForm';
import BorrowForm from './components/BorrowForm';
import RepayForm from './components/RepayForm';
import CreditScoreCard from './components/CreditScoreCard';
import PoolAnalytics from './components/PoolAnalytics';

function App() {
  const { account, provider, signer, connectWallet } = useWallet();
  const [refresh, setRefresh] = useState(0);

  const lendingPool = useContract('LendingPool', signer || provider);
  const creditScore = useContract('CreditScore', signer || provider);
  const glpToken = useContract('GLPToken', signer || provider);

  const fetchBalances = () => {
    setRefresh(r => r + 1); // trigger re-render in children
  };

  return (
    <div className="app-container">
      <header>
        <h1>Decentralized Micro-Lending</h1>
        <ConnectWallet account={account} connectWallet={connectWallet} />
      </header>
      
      {account ? (
        <main className="dashboard">
          <div className="column">
            <CreditScoreCard key={`score-${refresh}`} creditScoreContract={creditScore} account={account} />
            <PoolAnalytics key={`pool-${refresh}`} lendingPoolContract={lendingPool} glpTokenContract={glpToken} account={account} />
          </div>
          <div className="column">
            <DepositForm lendingPoolContract={lendingPool} account={account} fetchBalances={fetchBalances} />
            <BorrowForm lendingPoolContract={lendingPool} creditScoreContract={creditScore} glpTokenContract={glpToken} account={account} fetchBalances={fetchBalances} />
            <RepayForm lendingPoolContract={lendingPool} account={account} fetchBalances={fetchBalances} />
          </div>
        </main>
      ) : (
        <div className="welcome">
          <h2>Please connect your wallet to use the application</h2>
        </div>
      )}
    </div>
  );
}

export default App;
