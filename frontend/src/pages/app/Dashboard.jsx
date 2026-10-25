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
import { useBorrower, displayLimit, STAGE_NAMES } from '../../hooks/useBorrower';
import { TIER_NAMES } from '../../hooks/useMembership';
import { fmtEth } from '../../utils/inr';
import './Dashboard.css';

const Dashboard = ({ wallet, contracts, eventSync }) => {
  const { account, provider } = wallet;
  const { lendingPool, glpToken, reserveFund, loanManager } = contracts;
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [ethBalance, setEthBalance] = useState('0.0000');
  const [glpBalance, setGlpBalance] = useState('0.0000');
  const [poolLiquidity, setPoolLiquidity] = useState('0.0000');
  const [insuranceReserve, setInsuranceReserve] = useState('0.0000');
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

      // 3. Pool: free cash, reserve (loss buffer), outstanding loans
      if (lendingPool) {
        try {
          setPoolLiquidity(fmtEth(await lendingPool.freeCash()));
          if (reserveFund) setInsuranceReserve(fmtEth(await provider.getBalance(await reserveFund.getAddress())));
          if (loanManager) setTotalPoolLoans(fmtEth(await loanManager.totalOutstanding()));
        } catch (e) {
          console.warn('Pool details fetch failed', e);
        }
      }
    } catch (err) {
      console.error('Error in fetchDashboardData:', err);
    } finally {
      setLoading(false);
    }
  }, [account, provider, lendingPool, glpToken, reserveFund, loanManager]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData, eventSync?.syncTick]);

  const borrower = useBorrower(contracts, account, eventSync?.syncTick);
  const score = borrower.score ?? 300;
  const registered = borrower.memberId !== 0n;
  const borrowLimit = fmtEth(displayLimit(borrower.limits));
  const activeLoan = fmtEth(borrower.loan?.outstandingPrincipal ?? 0n);
  const dueAmount = fmtEth(borrower.amountDue);
  const tierIndex = borrower.member ? Number(borrower.member.tier) : 0;
  const currentTier = { label: registered ? `${TIER_NAMES[tierIndex]} tier` : 'Not registered', tier: tierIndex };
  const stageLabel = borrower.stage === null ? '' : STAGE_NAMES[borrower.stage];

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
            <span className="badge badge-gold" style={{ fontSize: '0.8rem', verticalAlign: 'middle' }}>v3</span>
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
          <p className="stat-desc">
            {registered
              ? borrower.limits?.unsecuredAllowed
                ? `Unsecured ladder limit · score ${score}/900`
                : `Builder loan cap · ${borrower.limits?.unsecuredHold || 'credit-builder first'}`
              : 'Sign up and register to borrow'}
          </p>
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
            {borrower.loan ? `Due now: ${dueAmount} ETH · stage: ${stageLabel}` : 'No open loan'}
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
                    {registered ? score : '—'}<span className="score-max">/900</span>
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
                <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, (score - 300) / 6))}%` }}></div>
              </div>

              {/* Tiers: completed loans plus score */}
              <div className="score-tiers-list">
                {[
                  ['New', 'First loan is a Builder loan'],
                  ['Builder', '1 completed loan'],
                  ['Standard', '2 loans · score 600+'],
                  ['Trusted', '4 loans · score 700+'],
                  ['Prime', '8 loans · score 800+'],
                ].map(([name, rule], i) => (
                  <div key={name} className={`score-tier-item ${registered && tierIndex === i ? 'active' : ''}`}>
                    <div className="tier-range">{name}</div>
                    <div className="tier-limit">{rule}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="protocol-tip-box">
              <HiInformationCircle size={22} />
              <div className="protocol-tip-content">
                <h4>How to Increase Your Score</h4>
                <p>
                  Pay installments on time (100% credit; within grace 60%; late 20%), finish loans, and keep your
                  stake. Limits grow at most 1.5× per completed loan. A default leaves a scar that fades over two years
                  but never fully disappears.
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
                <span className="pool-metric-label">Reserve (loss buffer, not a guarantee)</span>
                <span className="pool-metric-value" style={{ color: 'var(--brand-primary)' }}>
                  {insuranceReserve} ETH
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
                    LoanManager, LendingPool, IdentityRegistry & CreditScore active
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
                    <strong>Open loan:</strong> {activeLoan} ETH outstanding, {dueAmount} ETH due now (stage: {stageLabel}). See the Loans page for the schedule and help options.
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
                    {borrower.claim && borrower.claim.amount > 0n ? (
                      <><strong>Default balance open:</strong> {fmtEth(borrower.claim.amount)} ETH remains after a default. The Loans page shows your settlement amount{Number(borrower.claim.dtype) === 1 ? ' and workout plan' : ''}.</>
                    ) : registered ? (
                      <><strong>No open loan.</strong> Your borrowing options are on the Borrow page.</>
                    ) : (
                      <><strong>Not registered yet.</strong> Sign up and verify to borrow; lending is open to everyone.</>
                    )}
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
