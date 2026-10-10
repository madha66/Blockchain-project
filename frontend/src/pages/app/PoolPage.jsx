import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  ArcElement
} from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import { 
  HiCollection, 
  HiRefresh, 
  HiShieldCheck, 
  HiTrendingDown, 
  HiSparkles 
} from 'react-icons/hi';
import './PoolPage.css';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  ArcElement
);

const PoolPage = ({ wallet, contracts, eventSync }) => {
  const { account, provider } = wallet;
  const { lendingPool, glpToken } = contracts;

  const [loading, setLoading] = useState(false);
  const [poolEth, setPoolEth] = useState('0.0000');
  const [insuranceReserve, setInsuranceReserve] = useState('0.0000');
  const [totalLoans, setTotalLoans] = useState('0.0000');
  const [totalGlpSupply, setTotalGlpSupply] = useState('0.0000');
  const [userDeposit, setUserDeposit] = useState('0.0000');

  const fetchPoolData = useCallback(async () => {
    if (!lendingPool) return;
    try {
      setLoading(true);
      const poolAddr = await lendingPool.getAddress();
      const prov = lendingPool.runner?.provider || provider;

      if (prov) {
        const rawBal = await prov.getBalance(poolAddr);
        const reserve = await lendingPool.insuranceReserve();
        setInsuranceReserve(Number(ethers.formatEther(reserve)).toFixed(4));

        const freeCash = rawBal > reserve ? rawBal - reserve : 0n;
        setPoolEth(Number(ethers.formatEther(freeCash)).toFixed(4));
      }

      const loans = await lendingPool.totalActiveLoans();
      setTotalLoans(Number(ethers.formatEther(loans)).toFixed(4));

      if (glpToken) {
        const supply = await glpToken.totalSupply();
        setTotalGlpSupply(Number(ethers.formatEther(supply)).toFixed(4));

        if (account) {
          const userBal = await glpToken.balanceOf(account);
          setUserDeposit(Number(ethers.formatEther(userBal)).toFixed(4));
        }
      }
    } catch (e) {
      console.error('Error fetching pool data:', e);
    } finally {
      setLoading(false);
    }
  }, [lendingPool, glpToken, account, provider]);

  useEffect(() => {
    fetchPoolData();
  }, [fetchPoolData, eventSync?.syncTick]);

  const liveEvents = (eventSync?.events || []).slice(0, 10);

  const totalPoolVal = (Number(poolEth) + Number(totalLoans)).toFixed(4);
  const utilization = Number(totalPoolVal) > 0 ? ((Number(totalLoans) / Number(totalPoolVal)) * 100).toFixed(1) : '0.0';

  // Doughnut Chart Data (Liquidity vs Borrowed)
  const doughnutData = {
    labels: ['Available Liquidity (ETH)', 'Active Loans (ETH)'],
    datasets: [
      {
        data: [Math.max(Number(poolEth), 0.001), Math.max(Number(totalLoans), 0)],
        backgroundColor: ['#f0b90b', '#ffb020'],
        borderColor: ['#0a0a0a', '#0a0a0a'],
        borderWidth: 2,
      },
    ],
  };

  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: '#a0a0a0', font: { family: 'Inter', size: 12 } }
      }
    }
  };

  return (
    <div className="pool-container">
      {/* Header */}
      <div className="pool-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
            Lending Pool Liquidity & Analytics
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Real-time on-chain reserves, protocol utilization metrics, and live transaction events.
          </p>
        </div>

        <button 
          className="btn btn-outline btn-sm" 
          onClick={fetchPoolData}
          disabled={loading}
        >
          <HiRefresh className={loading ? 'spinning' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Stats Grid */}
      <div className="pool-stats-grid">
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Available Liquidity</span>
            <div className="stat-icon" style={{ color: 'var(--success)' }}><HiShieldCheck size={18} /></div>
          </div>
          <div className="stat-value">{poolEth}<span className="stat-unit">ETH</span></div>
          <p className="stat-desc">Free cash (Reserve: {insuranceReserve} ETH)</p>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Total Active Borrowed</span>
            <div className="stat-icon" style={{ color: 'var(--warning)' }}><HiTrendingDown size={18} /></div>
          </div>
          <div className="stat-value">{totalLoans}<span className="stat-unit">ETH</span></div>
          <p className="stat-desc">Currently lent out to users</p>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Total Pool Value</span>
            <div className="stat-icon"><HiCollection size={18} /></div>
          </div>
          <div className="stat-value">{totalPoolVal}<span className="stat-unit">ETH</span></div>
          <p className="stat-desc">Reserves + outstanding debts</p>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">GLP Token Supply</span>
            <div className="stat-icon" style={{ color: 'var(--gold-primary)' }}><HiSparkles size={18} /></div>
          </div>
          <div className="stat-value">{totalGlpSupply}<span className="stat-unit">GLP</span></div>
          <p className="stat-desc">Total proof-of-deposit tokens</p>
        </div>
      </div>

      {/* Grid: Chart & Real-Time Event Feed */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: '24px' }}>
        {/* Doughnut Chart */}
        <div className="chart-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem' }}>
              Capital Allocation
            </h3>
            <span className="badge badge-gold">
              Utilization: {utilization}%
            </span>
          </div>

          <div className="chart-wrapper">
            <Doughnut data={doughnutData} options={doughnutOptions} />
          </div>

          <div style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Your Deposit Share: <strong>{userDeposit} GLP</strong>
          </div>
        </div>

        {/* Live Event Stream */}
        <div className="recent-events-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <HiSparkles style={{ color: 'var(--gold-primary)' }} />
              Live Contract Event Log
            </h3>
            <span className="badge badge-gold" style={{ fontSize: '0.75rem' }}>
              Real-Time Feed
            </span>
          </div>

          <div className="events-list">
            {liveEvents.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                No blockchain events recorded yet. Connect and interact to see live updates.
              </div>
            ) : (
              liveEvents.map((evt) => (
                <div key={evt.id} className="event-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span className={`event-type-badge event-${evt.type}`}>{evt.type}</span>
                    <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                      {evt.user ? `${evt.user.slice(0, 6)}...${evt.user.slice(-4)}` : 'Pool'}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 600, color: 'var(--gold-primary)' }}>{evt.amount}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{evt.timestamp}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PoolPage;
