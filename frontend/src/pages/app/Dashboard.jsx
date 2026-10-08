import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { 
  HiTrendingUp, 
  HiTrendingDown, 
  HiCreditCard, 
  HiShieldCheck, 
  HiSparkles, 
  HiArrowRight, 
  HiRefresh,
  HiExclamationCircle,
  HiCheckCircle,
  HiInformationCircle
} from 'react-icons/hi';
import './Dashboard.css';

const Dashboard = ({ wallet, contracts }) => {
  const { account, provider } = wallet;
  const { lendingPool, creditScore, glpToken } = contracts;
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [ethBalance, setEthBalance] = useState('0.0000');
  const [glpBalance, setGlpBalance] = useState('0.0000');
  const [score, setScore] = useState(50);
  const [borrowLimit, setBorrowLimit] = useState('0.5000');
  const [activeLoan, setActiveLoan] = useState('0.0000');
  const [dueAmount, setDueAmount] = useState('0.0000');
  const [poolLiquidity, setPoolLiquidity] = useState('0.0000');
  const [totalPoolLoans, setTotalPoolLoans] = useState('0.0000');

  const fetchDashboardData = useCallback(async () => {
    if (!account || !provider) return;
    try {
      setLoading(true);

      // 1. User ETH balance
      const bal = await provider.getBalance(account);
      setEthBalance(Number(ethers.formatEther(bal)).toFixed(4));

      // 2. User GLP balance
      if (glpToken) {
        try {
          const glpBal = await glpToken.balanceOf(account);
          setGlpBalance(Number(ethers.formatEther(glpBal)).toFixed(4));
        } catch (e) {
          console.warn('GLP balance fetch failed', e);
        }
      }

      // 3. Credit Score & Limit
      if (creditScore) {
        try {
          const userScore = await creditScore.getScore(account);
          setScore(Number(userScore));
          const limit = await creditScore.getBorrowLimit(account);
          setBorrowLimit(Number(ethers.formatEther(limit)).toFixed(4));
        } catch (e) {
          console.warn('Credit score fetch failed', e);
        }
      }

      // 4. Lending Pool: active loan & due amount & pool liquidity
      if (lendingPool) {
        try {
          const poolAddr = await lendingPool.getAddress();
          const poolBal = await provider.getBalance(poolAddr);
          setPoolLiquidity(Number(ethers.formatEther(poolBal)).toFixed(4));

          const userLoan = await lendingPool.activeLoans(account);
          setActiveLoan(Number(ethers.formatEther(userLoan)).toFixed(4));

          const due = await lendingPool.getRepaymentAmount(account);
          setDueAmount(Number(ethers.formatEther(due)).toFixed(4));

          const totalLoans = await lendingPool.totalActiveLoans();
          setTotalPoolLoans(Number(ethers.formatEther(totalLoans)).toFixed(4));
        } catch (e) {
          console.warn('Pool details fetch failed', e);
        }
      }
    } catch (err) {
      console.error('Error in fetchDashboardData:', err);
    } finally {
      setLoading(false);
    }
  }, [account, provider, lendingPool, creditScore, glpToken]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  // Determine credit tier label
  const getTierLabel = (scoreVal) => {
    if (scoreVal >= 91) return { label: 'Elite Tier', tier: 4 };
    if (scoreVal >= 76) return { label: 'Tier 3 (Advanced)', tier: 3 };
    if (scoreVal >= 61) return { label: 'Tier 2 (Standard)', tier: 2 };
    return { label: 'Initial Tier', tier: 1 };
  };

  const currentTier = getTierLabel(score);

  // Utilization calculation
  const totalValue = Number(poolLiquidity) + Number(totalPoolLoans);
  const utilization = totalValue > 0 ? ((Number(totalPoolLoans) / totalValue) * 100).toFixed(1) : '0.0';

  return (
    <div className="dashboard-container">
      {/* Header */}
      <div className="dashboard-header">
        <div className="dashboard-title-group">
          <h1>
            <span>Dashboard</span>
            <span className="badge badge-gold" style={{ fontSize: '0.8rem', verticalAlign: 'middle' }}>v2.0</span>
          </h1>
          <p className="dashboard-subtitle">
            Manage your decentralized micro-loans, staked liquidity, and credit reputation.
          </p>
        </div>

        <div className="dashboard-actions-top">
          <button 
            className="btn btn-outline btn-sm" 
            onClick={fetchDashboardData}
            disabled={loading}
            title="Refresh on-chain metrics"
          >
            <HiRefresh className={loading ? 'spinning' : ''} />
            <span>Refresh</span>
          </button>
          <Link to="/app/lend" className="btn btn-gold btn-sm">
            Deposit ETH
          </Link>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="dashboard-stats-grid">
        {/* Wallet Balance */}
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Wallet Balance</span>
            <div className="stat-icon"><HiCreditCard size={18} /></div>
          </div>
          <div className="stat-value">
            {ethBalance}<span className="stat-unit">ETH</span>
          </div>
          <p className="stat-desc">Liquid funds in connected wallet</p>
        </div>

        {/* Deposit Balance */}
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Lended Balance</span>
            <div className="stat-icon"><HiTrendingUp size={18} /></div>
          </div>
          <div className="stat-value">
            {glpBalance}<span className="stat-unit">GLP</span>
          </div>
          <p className="stat-desc">Earning interest in lending pool</p>
        </div>

        {/* Borrow Limit */}
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Borrow Limit</span>
            <div className="stat-icon"><HiShieldCheck size={18} /></div>
          </div>
          <div className="stat-value">
            {borrowLimit}<span className="stat-unit">ETH</span>
          </div>
          <p className="stat-desc">Based on credit rating ({score}/100)</p>
        </div>

        {/* Active Loan */}
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Outstanding Loan</span>
            <div className="stat-icon" style={{ color: Number(activeLoan) > 0 ? 'var(--warning)' : 'var(--text-secondary)' }}>
              <HiTrendingDown size={18} />
            </div>
          </div>
          <div className="stat-value" style={{ color: Number(activeLoan) > 0 ? 'var(--warning)' : 'inherit' }}>
            {activeLoan}<span className="stat-unit">ETH</span>
          </div>
          <p className="stat-desc">
            {Number(dueAmount) > 0 ? `Total due: ${dueAmount} ETH (5% fee)` : 'No active debts'}
          </p>
        </div>
      </div>

      {/* Main 2-Column Section */}
      <div className="dashboard-grid-2col">
        {/* Left Column: Credit & Quick Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Credit Score Card */}
          <div className="panel-card">
            <div className="panel-title-group">
              <h2 className="panel-title">
                <HiSparkles style={{ color: 'var(--gold-primary)' }} />
                On-Chain Credit Reputation
              </h2>
              <span className="score-badge">{currentTier.label}</span>
            </div>

            <div className="score-widget-box">
              <div className="score-widget-top">
                <div>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Reputation Score</span>
                  <div className="score-large-number">
                    {score}<span className="score-max">/100</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Maximum Loan</span>
                  <div style={{ fontSize: '1.4rem', fontWeight: '700', color: 'var(--success)' }}>
                    {borrowLimit} ETH
                  </div>
                </div>
              </div>

              {/* Progress bar */}
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.min(score, 100)}%` }}></div>
              </div>

              {/* Score Tiers */}
              <div className="score-tiers-list">
                <div className={`score-tier-item ${score <= 60 ? 'active' : ''}`}>
                  <div className="tier-range">0–60 Score</div>
                  <div className="tier-limit">0.5 ETH</div>
                </div>
                <div className={`score-tier-item ${score >= 61 && score <= 75 ? 'active' : ''}`}>
                  <div className="tier-range">61–75 Score</div>
                  <div className="tier-limit">1.5 ETH</div>
                </div>
                <div className={`score-tier-item ${score >= 76 && score <= 90 ? 'active' : ''}`}>
                  <div className="tier-range">76–90 Score</div>
                  <div className="tier-limit">3.0 ETH</div>
                </div>
                <div className={`score-tier-item ${score >= 91 ? 'active' : ''}`}>
                  <div className="tier-range">91–100 Score</div>
                  <div className="tier-limit">5.0 ETH</div>
                </div>
              </div>
            </div>

            <div className="protocol-tip-box">
              <HiInformationCircle size={22} />
              <div className="protocol-tip-content">
                <h4>How to Increase Your Score</h4>
                <p>
                  Borrow responsibly and repay promptly. Each successful repayment elevates your credit standing, unlocking up to 5.0 ETH in collateral-free borrowing power.
                </p>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="panel-card">
            <div className="panel-title-group">
              <h2 className="panel-title">Quick Actions</h2>
            </div>

            <div className="quick-actions-grid">
              <div className="quick-action-btn" onClick={() => navigate('/app/lend')}>
                <div className="quick-action-icon"><HiTrendingUp size={22} /></div>
                <div className="quick-action-text">
                  <h4>Lend ETH</h4>
                  <p>Deposit ETH to mint GLP & earn yield</p>
                </div>
              </div>

              <div className="quick-action-btn" onClick={() => navigate('/app/borrow')}>
                <div className="quick-action-icon"><HiTrendingDown size={22} /></div>
                <div className="quick-action-text">
                  <h4>Borrow ETH</h4>
                  <p>Instant draw against credit limit</p>
                </div>
              </div>

              <div className="quick-action-btn" onClick={() => navigate('/app/loans')}>
                <div className="quick-action-icon"><HiCreditCard size={22} /></div>
                <div className="quick-action-text">
                  <h4>Repay Loan</h4>
                  <p>Manage and settle active obligations</p>
                </div>
              </div>

              <div className="quick-action-btn" onClick={() => navigate('/app/pool')}>
                <div className="quick-action-icon"><HiShieldCheck size={22} /></div>
                <div className="quick-action-text">
                  <h4>Pool Analytics</h4>
                  <p>Inspect TVL, reserves, & contracts</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Pool Utilization & Network status */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Protocol Pool Health */}
          <div className="panel-card">
            <div className="panel-title-group">
              <h2 className="panel-title">Protocol Pool Health</h2>
              <Link to="/app/pool" className="btn btn-ghost btn-sm" style={{ padding: '4px 8px' }}>
                View Pool <HiArrowRight />
              </Link>
            </div>

            <div className="pool-metrics-list">
              <div className="pool-metric-row">
                <span className="pool-metric-label">Available Liquidity</span>
                <span className="pool-metric-value" style={{ color: 'var(--success)' }}>
                  {poolLiquidity} ETH
                </span>
              </div>

              <div className="pool-metric-row">
                <span className="pool-metric-label">Total Active Borrowed</span>
                <span className="pool-metric-value" style={{ color: 'var(--warning)' }}>
                  {totalPoolLoans} ETH
                </span>
              </div>

              <div className="pool-metric-row">
                <span className="pool-metric-label">Total Protocol Value</span>
                <span className="pool-metric-value">
                  {totalValue.toFixed(4)} ETH
                </span>
              </div>

              {/* Utilization progress */}
              <div className="utilization-box">
                <div className="utilization-header">
                  <span>Pool Capital Utilization</span>
                  <strong style={{ color: 'var(--gold-primary)' }}>{utilization}%</strong>
                </div>
                <div className="progress-track">
                  <div 
                    className="progress-fill" 
                    style={{ width: `${Math.min(Number(utilization), 100)}%` }}
                  ></div>
                </div>
              </div>
            </div>
          </div>

          {/* Active Status & Security Banner */}
          <div className="panel-card">
            <div className="panel-title-group">
              <h2 className="panel-title">Account Security</h2>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <HiCheckCircle size={20} style={{ color: 'var(--success)' }} />
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: '600' }}>MetaMask Connected</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                    {account}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <HiCheckCircle size={20} style={{ color: 'var(--success)' }} />
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: '600' }}>Smart Contracts Loaded</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    LendingPool, CreditScore & GLPToken active
                  </div>
                </div>
              </div>

              {Number(activeLoan) > 0 ? (
                <div style={{ 
                  background: 'rgba(255, 176, 32, 0.1)', 
                  border: '1px solid var(--warning)', 
                  padding: '12px', 
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  gap: '10px',
                  alignItems: 'center'
                }}>
                  <HiExclamationCircle size={24} style={{ color: 'var(--warning)', flexShrink: 0 }} />
                  <div style={{ fontSize: '0.82rem', color: '#ffcc80' }}>
                    <strong>Action Required:</strong> You have an outstanding loan of {activeLoan} ETH. Settle to avoid interest accumulation.
                  </div>
                </div>
              ) : (
                <div style={{ 
                  background: 'rgba(0, 192, 135, 0.08)', 
                  border: '1px solid rgba(0, 192, 135, 0.25)', 
                  padding: '12px', 
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  gap: '10px',
                  alignItems: 'center'
                }}>
                  <HiCheckCircle size={24} style={{ color: 'var(--success)', flexShrink: 0 }} />
                  <div style={{ fontSize: '0.82rem', color: 'var(--success)' }}>
                    <strong>Good Standing:</strong> Zero active debts. Full borrowing allowance is available.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
