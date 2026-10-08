import React, { useState } from 'react';
import { Outlet, NavLink, Link, useNavigate } from 'react-router-dom';
import { HiHome, HiCreditCard, HiTrendingUp, HiTrendingDown, HiCollection, HiChartBar, HiClipboardList, HiMenu, HiX, HiLogout } from 'react-icons/hi';
import './AppLayout.css';

const navItems = [
  { path: '/app/dashboard', label: 'Dashboard', icon: <HiHome size={20} /> },
  { path: '/app/wallet', label: 'Wallet', icon: <HiCreditCard size={20} /> },
  { path: '/app/lend', label: 'Lend', icon: <HiTrendingUp size={20} /> },
  { path: '/app/borrow', label: 'Borrow', icon: <HiTrendingDown size={20} /> },
  { path: '/app/loans', label: 'Loans', icon: <HiClipboardList size={20} /> },
  { path: '/app/pool', label: 'Lend Pool', icon: <HiCollection size={20} /> },
  { path: '/app/transactions', label: 'Transactions', icon: <HiChartBar size={20} /> },
];

const AppLayout = ({ wallet, contracts }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { account, connectWallet } = wallet;
  const navigate = useNavigate();

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className={`app-sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <Link to="/" className="sidebar-logo">
            <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
              <circle cx="16" cy="16" r="14" stroke="#f0b90b" strokeWidth="2" fill="none"/>
              <path d="M10 16 L16 10 L22 16 L16 22 Z" fill="#f0b90b"/>
            </svg>
            <span>GigLend</span>
          </Link>
          <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">
            <HiX size={20} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(item => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`}
              onClick={() => setSidebarOpen(false)}
            >
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="sidebar-link" onClick={() => navigate('/')}>
            <HiLogout size={20} />
            <span>Back to Home</span>
          </button>
        </div>
      </aside>

      {/* Overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* Main content */}
      <div className="app-main">
        <header className="app-header">
          <button className="app-menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <HiMenu size={22} />
          </button>

          <div className="app-header-right">
            {account ? (
              <div className="app-wallet-badge">
                <span className="app-wallet-dot"></span>
                <span className="app-wallet-address">{account.slice(0, 6)}...{account.slice(-4)}</span>
              </div>
            ) : (
              <button className="btn btn-gold btn-sm" onClick={connectWallet}>
                Connect Wallet
              </button>
            )}
          </div>
        </header>

        <main className="app-content">
          {account ? (
            <Outlet />
          ) : (
            <div className="app-connect-prompt">
              <div className="connect-prompt-card">
                <div className="connect-prompt-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f0b90b" strokeWidth="1.5"><rect x="1" y="5" width="22" height="16" rx="2"/><path d="M16 14a2 2 0 100-4 2 2 0 000 4z"/></svg>
                </div>
                <h2>Connect Your Wallet</h2>
                <p>Connect your MetaMask wallet to access the GigLend lending platform and interact with smart contracts.</p>
                <button className="btn btn-gold btn-lg" onClick={connectWallet}>
                  Connect MetaMask
                </button>
                <p className="connect-prompt-note">
                  Transactions require wallet confirmation. Never share your recovery phrase.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
