import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useWallet } from './hooks/useWallet';
import { useContract } from './hooks/useContract';
import { useEventSync } from './hooks/useEventSync';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/auth/ProtectedRoute';
import LandingPage from './pages/LandingPage';
import SignupPage from './pages/SignupPage';
import LoginPage from './pages/LoginPage';
import AppLayout from './pages/app/AppLayout';
import Dashboard from './pages/app/Dashboard';
import LendPage from './pages/app/LendPage';
import BorrowPage from './pages/app/BorrowPage';
import WalletPage from './pages/app/WalletPage';
import LoansPage from './pages/app/LoansPage';
import PoolPage from './pages/app/PoolPage';
import TransactionsPage from './pages/app/TransactionsPage';
import ProfilePage from './pages/app/ProfilePage';
import NotificationsPage from './pages/app/NotificationsPage';
import AdminPage from './pages/app/AdminPage';
import DemoPage from './pages/app/DemoPage';

function App() {
  const wallet = useWallet();
  const { account, provider, signer } = wallet;
  const runner = signer || provider;

  const contracts = {
    lendingPool: useContract('LendingPool', runner),
    creditScore: useContract('CreditScore', runner),
    glpToken: useContract('GLPToken', runner),
    identityRegistry: useContract('IdentityRegistry', runner),
    policyConfig: useContract('PolicyConfig', runner),
    loanManager: useContract('LoanManager', runner),
    defaultManager: useContract('DefaultManager', runner),
    riskEngine: useContract('RiskEngine', runner),
    safeRepayVault: useContract('SafeRepayVault', runner),
    payoutRouter: useContract('MockPayoutRouter', runner),
    reserveFund: useContract('ReserveFund', runner),
    portfolioLens: useContract('PortfolioLens', runner),
  };
  const eventSync = useEventSync(provider, account);
  const props = { wallet, contracts, eventSync };

  const borrowerOnly = (element) => (
    <ProtectedRoute contracts={contracts} wallet={wallet} requireRegistered>
      {element}
    </ProtectedRoute>
  );
  const loggedInOnly = (element) => (
    <ProtectedRoute contracts={contracts} wallet={wallet}>
      {element}
    </ProtectedRoute>
  );

  return (
    <AuthProvider account={account}>
      <Routes>
        <Route path="/" element={<LandingPage wallet={wallet} />} />
        <Route path="/signup" element={<SignupPage {...props} />} />
        <Route path="/login" element={<LoginPage {...props} />} />
        <Route path="/app" element={<AppLayout {...props} />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard {...props} />} />
          <Route path="lend" element={<LendPage {...props} />} />
          <Route path="borrow" element={borrowerOnly(<BorrowPage {...props} />)} />
          <Route path="wallet" element={<WalletPage {...props} />} />
          <Route path="loans" element={borrowerOnly(<LoansPage {...props} />)} />
          <Route path="pool" element={<PoolPage {...props} />} />
          <Route path="transactions" element={<TransactionsPage {...props} />} />
          <Route path="profile" element={loggedInOnly(<ProfilePage {...props} />)} />
          <Route path="notifications" element={loggedInOnly(<NotificationsPage {...props} />)} />
          <Route path="admin" element={loggedInOnly(<AdminPage {...props} />)} />
          <Route path="demo" element={loggedInOnly(<DemoPage {...props} />)} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}

export default App;
