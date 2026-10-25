import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend, ArcElement } from 'chart.js';
import { Doughnut, Bar } from 'react-chartjs-2';
import { HiCollection, HiRefresh, HiShieldCheck, HiTrendingDown, HiSparkles, HiExclamation, HiClock } from 'react-icons/hi';
import { fmtEth, ethWithInr } from '../../utils/inr';
import './PoolPage.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend, ArcElement);

const STAGES = ['Current', 'Grace', 'Onset', 'Significant', 'Default-eligible'];
const CARRY = ['100%', '100%', '90%', '50%', '0%'];

const PoolPage = ({ wallet, contracts, eventSync }) => {
  const { account } = wallet;
  const { lendingPool, glpToken, portfolioLens, policyConfig } = contracts;

  const [loading, setLoading] = useState(false);
  const [p, setP] = useState(null);
  const [supply, setSupply] = useState(0n);
  const [userShares, setUserShares] = useState(0n);
  const [queue, setQueue] = useState({ length: 0n, ahead: 0n, own: 0n });
  const [losses, setLosses] = useState([]);
  const [error, setError] = useState('');

  const fetchPoolData = useCallback(async () => {
    if (!lendingPool || !portfolioLens) return;
    try {
      setLoading(true);
      setError('');
      const [portfolio, totalSupply, queueLength, spd] = await Promise.all([
        portfolioLens.portfolio(),
        glpToken.totalSupply(),
        lendingPool.queueLength(),
        policyConfig ? policyConfig.secondsPerDay() : 86400n,
      ]);
      setP(portfolio);
      setSupply(totalSupply);
      const [months] = await portfolioLens.lossesByMonth(6, spd);
      setLosses([...months].reverse());
      if (account) {
        const [shares, [ahead, own]] = await Promise.all([glpToken.balanceOf(account), lendingPool.queuePosition(account)]);
        setUserShares(shares);
        setQueue({ length: queueLength, ahead, own });
      } else {
        setQueue({ length: queueLength, ahead: 0n, own: 0n });
      }
    } catch (e) {
      console.error('Error fetching pool data:', e);
      setError('Pool contracts are not reachable. Is the local chain running and deploy.js up to date?');
    } finally {
      setLoading(false);
    }
  }, [lendingPool, glpToken, portfolioLens, policyConfig, account]);

  useEffect(() => {
    fetchPoolData();
  }, [fetchPoolData, eventSync?.syncTick]);

  const liveEvents = (eventSync?.events || []).slice(0, 10);
  const capital = p ? p.freeCash + p.totalOutstanding : 0n;
  const utilization = capital > 0n ? Number((p.totalOutstanding * 10000n) / capital) / 100 : 0;

  const doughnutData = {
    labels: ['Free cash', 'Loans carried', 'Provisioned (late loans)'],
    datasets: [
      {
        data: p
          ? [p.freeCash, p.carriedValue, p.provisions].map((w) => Number(ethers.formatEther(w)))
          : [1, 0, 0],
        backgroundColor: ['#f0b90b', '#00c087', '#ff4d6a'],
        borderColor: ['#0a0a0a', '#0a0a0a', '#0a0a0a'],
        borderWidth: 2,
      },
    ],
  };

  const lossData = {
    labels: losses.map((_, i) => (i === losses.length - 1 ? 'This month' : `${losses.length - 1 - i} mo ago`)),
    datasets: [
      { label: 'Realised lender losses (ETH)', data: losses.map((w) => Number(ethers.formatEther(w))), backgroundColor: '#ff4d6a' },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { color: '#a0a0a0', font: { family: 'Inter', size: 12 } } } },
  };
  const barOptions = {
    ...chartOptions,
    scales: { x: { ticks: { color: '#a0a0a0' } }, y: { ticks: { color: '#a0a0a0' }, beginAtZero: true } },
  };

  return (
    <div className="pool-container">
      <div className="pool-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>Lending pool and disclosures</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Pool value counts late loans at a discount by stage, so losses are booked in steps.
          </p>
        </div>
        <button className="btn btn-outline btn-sm" onClick={fetchPoolData} disabled={loading}>
          <HiRefresh className={loading ? 'spinning' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="pool-disclaimer" role="note">
        <HiExclamation size={20} />
        <p>
          <strong>Returns are never guaranteed.</strong> Lenders bear losses that borrower stake and the reserve do not
          cover. The reserve is a loss buffer funded by borrower interest, <strong>not a guarantee</strong>.
        </p>
      </div>

      {error && <div className="auth-error">{error}</div>}

      <div className="pool-stats-grid">
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Pool value</span>
            <div className="stat-icon"><HiCollection size={18} /></div>
          </div>
          <div className="stat-value">{fmtEth(p?.poolValue)}<span className="stat-unit">ETH</span></div>
          <p className="stat-desc">Free cash + carried value of loans</p>
        </div>
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Free cash</span>
            <div className="stat-icon" style={{ color: 'var(--success)' }}><HiShieldCheck size={18} /></div>
          </div>
          <div className="stat-value">{fmtEth(p?.freeCash)}<span className="stat-unit">ETH</span></div>
          <p className="stat-desc">Utilisation {utilization.toFixed(1)}% (cap 90%)</p>
        </div>
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Outstanding loans</span>
            <div className="stat-icon" style={{ color: 'var(--warning)' }}><HiTrendingDown size={18} /></div>
          </div>
          <div className="stat-value">{fmtEth(p?.totalOutstanding)}<span className="stat-unit">ETH</span></div>
          <p className="stat-desc">Provisions: {fmtEth(p?.provisions)} ETH</p>
        </div>
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Reserve (loss buffer)</span>
            <div className="stat-icon" style={{ color: 'var(--gold-primary)' }}><HiSparkles size={18} /></div>
          </div>
          <div className="stat-value">{fmtEth(p?.reserveBalance)}<span className="stat-unit">ETH</span></div>
          <p className="stat-desc">Not a guarantee · used so far {fmtEth(p?.totalReserveUsed)} ETH</p>
        </div>
      </div>

      <div className="pool-two-col">
        <div className="chart-card">
          <h3 className="pool-card-title">Non-performing loans by stage</h3>
          <table className="pool-table">
            <thead>
              <tr><th>Stage</th><th>Loans</th><th>Outstanding</th><th>Carried at</th></tr>
            </thead>
            <tbody>
              {STAGES.map((name, i) => (
                <tr key={name} className={i >= 2 ? 'pool-row-late' : undefined}>
                  <td>{name}</td>
                  <td>{p ? p.countByStage[i].toString() : '—'}</td>
                  <td>{p ? `${fmtEth(p.outstandingByStage[i])} ETH` : '—'}</td>
                  <td>{CARRY[i]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pool-arrears">
            <div>
              <span className="stat-label">Arrears, all loans</span>
              <strong>{fmtEth(p?.arrearsAll)} ETH</strong>
            </div>
            <div>
              <span className="stat-label">Arrears excluding restructured</span>
              <strong>{fmtEth(p?.arrearsExRestructured)} ETH</strong>
            </div>
            <div>
              <span className="stat-label">Restructured loans</span>
              <strong>{p ? p.restructuredLoans.toString() : '—'}</strong>
            </div>
          </div>
          <p className="stat-desc">Arrears are reported both ways so restructuring cannot hide portfolio stress.</p>
        </div>

        <div className="chart-card">
          <h3 className="pool-card-title">Realised losses by month</h3>
          <div className="chart-wrapper"><Bar data={lossData} options={barOptions} /></div>
          <p className="stat-desc">
            Total lender losses {fmtEth(p?.totalLenderLoss)} ETH · recovered from defaulters {fmtEth(p?.totalRecovered)} ETH
          </p>
        </div>
      </div>

      <div className="pool-two-col">
        <div className="chart-card">
          <h3 className="pool-card-title">Capital allocation</h3>
          <div className="chart-wrapper"><Doughnut data={doughnutData} options={chartOptions} /></div>
          <div style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Your shares: <strong>{fmtEth(userShares)} GLP</strong>
            {supply > 0n && p && <> · worth ≈ {ethWithInr((userShares * p.poolValue) / supply)}</>}
          </div>
        </div>

        <div className="chart-card">
          <h3 className="pool-card-title"><HiClock /> Withdrawal queue</h3>
          <p className="stat-desc">
            When free cash is short, withdrawals wait in a first-in-first-out queue and are paid pro rata as loans
            repay, so a run cannot drain the pool ahead of recognised losses.
          </p>
          <div className="pool-arrears">
            <div><span className="stat-label">Requests waiting</span><strong>{queue.length.toString()}</strong></div>
            <div><span className="stat-label">Your queued shares</span><strong>{fmtEth(queue.own)} GLP</strong></div>
            <div><span className="stat-label">Shares ahead of you</span><strong>{queue.own > 0n ? `${fmtEth(queue.ahead)} GLP` : '—'}</strong></div>
          </div>
        </div>
      </div>

      <div className="recent-events-card">
        <h3 className="pool-card-title"><HiSparkles style={{ color: 'var(--gold-primary)' }} /> Live contract events</h3>
        <div className="events-list">
          {liveEvents.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              No events yet.
            </div>
          ) : (
            liveEvents.map((evt) => (
              <div key={evt.id} className="event-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span className={`event-type-badge event-${evt.type}`}>{evt.label || evt.type}</span>
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
  );
};

export default PoolPage;
