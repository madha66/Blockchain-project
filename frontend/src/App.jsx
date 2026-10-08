import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useWallet } from './hooks/useWallet';
import { useContract } from './hooks/useContract';
import LandingPage from './pages/LandingPage';
import AppLayout from './pages/app/AppLayout';
import Dashboard from './pages/app/Dashboard';
import LendPage from './pages/app/LendPage';
import BorrowPage from './pages/app/BorrowPage';
import WalletPage from './pages/app/WalletPage';
import LoansPage from './pages/app/LoansPage';
import PoolPage from './pages/app/PoolPage';
import TransactionsPage from './pages/app/TransactionsPage';

function App() {
  const wallet = useWallet();
  const { account, provider, signer } = wallet;

  const lendingPool = useContract('LendingPool', signer || provider);
  const creditScore = useContract('CreditScore', signer || provider);
  const glpToken = useContract('GLPToken', signer || provider);

  const contracts = { lendingPool, creditScore, glpToken };

  return (
    <Routes>
      <Route path="/" element={<LandingPage wallet={wallet} />} />
      <Route path="/app" element={<AppLayout wallet={wallet} contracts={contracts} />}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard wallet={wallet} contracts={contracts} />} />
        <Route path="lend" element={<LendPage wallet={wallet} contracts={contracts} />} />
        <Route path="borrow" element={<BorrowPage wallet={wallet} contracts={contracts} />} />
        <Route path="wallet" element={<WalletPage wallet={wallet} contracts={contracts} />} />
        <Route path="loans" element={<LoansPage wallet={wallet} contracts={contracts} />} />
        <Route path="pool" element={<PoolPage wallet={wallet} contracts={contracts} />} />
        <Route path="transactions" element={<TransactionsPage wallet={wallet} contracts={contracts} />} />
      </Route>
    </Routes>
  );
}

export default App;
