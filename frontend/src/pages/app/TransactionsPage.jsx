import React, { useState } from 'react';
import { 
  HiChartBar, 
  HiDuplicate, 
  HiCheck, 
  HiCheckCircle,
  HiClock
} from 'react-icons/hi';
import './TransactionsPage.css';

const TransactionsPage = ({ wallet, contracts, eventSync }) => {
  const [filter, setFilter] = useState('all');
  const [copiedId, setCopiedId] = useState(null);

  const rawEvents = eventSync?.events || [];

  const handleCopy = (hash, id) => {
    navigator.clipboard.writeText(hash);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const filtered = filter === 'all' 
    ? rawEvents 
    : rawEvents.filter(tx => tx.type === filter);

  return (
    <div className="tx-container">
      {/* Header */}
      <div className="tx-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
            Transaction History (Blockchain Ledger)
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Comprehensive immutable ledger of all smart contract calls, loans, and liquidity events confirmed on-chain.
          </p>
        </div>
      </div>

      {/* Controls / Filter Pills */}
      <div className="tx-controls">
        <div className="tx-filter-pills">
          <button 
            className={`tx-filter-pill ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All Activity
          </button>
          <button 
            className={`tx-filter-pill ${filter === 'deposit' ? 'active' : ''}`}
            onClick={() => setFilter('deposit')}
          >
            Deposits
          </button>
          <button 
            className={`tx-filter-pill ${filter === 'borrow' ? 'active' : ''}`}
            onClick={() => setFilter('borrow')}
          >
            Borrows
          </button>
          <button 
            className={`tx-filter-pill ${filter === 'repay' ? 'active' : ''}`}
            onClick={() => setFilter('repay')}
          >
            Repayments
          </button>
          <button 
            className={`tx-filter-pill ${filter === 'withdraw' ? 'active' : ''}`}
            onClick={() => setFilter('withdraw')}
          >
            Withdrawals
          </button>
          <button 
            className={`tx-filter-pill ${filter === 'default' ? 'active' : ''}`}
            onClick={() => setFilter('default')}
          >
            Defaults
          </button>
          <button 
            className={`tx-filter-pill ${filter === 'recovery' ? 'active' : ''}`}
            onClick={() => setFilter('recovery')}
          >
            Recoveries
          </button>
        </div>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Showing <strong>{filtered.length}</strong> confirmed blockchain events
        </div>
      </div>

      {/* Table Card */}
      <div className="tx-table-card">
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-secondary)' }}>
            <HiClock size={36} style={{ marginBottom: '8px', opacity: 0.5 }} />
            <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: '4px' }}>No Confirmed Events Found</h3>
            <p style={{ fontSize: '0.88rem' }}>
              Confirmed blockchain events matching the selected filter will appear here in real-time as transactions are mined.
            </p>
          </div>
        ) : (
          <table className="tx-table">
            <thead>
              <tr>
                <th>Transaction Hash</th>
                <th>Action / Event</th>
                <th>Account</th>
                <th>Volume</th>
                <th>Details</th>
                <th>Timestamp</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tx) => (
                <tr key={tx.id}>
                  <td>
                    <div className="tx-hash">
                      <span>{tx.txHash ? `${tx.txHash.slice(0, 10)}...${tx.txHash.slice(-6)}` : 'N/A'}</span>
                      {tx.txHash && (
                        <button 
                          className="copy-btn" 
                          onClick={() => handleCopy(tx.txHash, tx.id)}
                          title="Copy transaction hash"
                        >
                          {copiedId === tx.id ? <HiCheck size={16} style={{ color: 'var(--success)' }} /> : <HiDuplicate size={16} />}
                        </button>
                      )}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className={`event-type-badge event-${tx.type}`}>{tx.type}</span>
                      <span style={{ fontWeight: 500 }}>{tx.name}</span>
                    </div>
                  </td>
                  <td>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                      {tx.user ? `${tx.user.slice(0, 6)}...${tx.user.slice(-4)}` : 'Pool'}
                    </span>
                  </td>
                  <td>
                    <strong style={{ color: 'var(--text-primary)' }}>{tx.amount}</strong>
                  </td>
                  <td>
                    <span style={{ color: 'var(--gold-primary)', fontSize: '0.82rem' }}>{tx.details}</span>
                  </td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                    {tx.timestamp}
                  </td>
                  <td>
                    <span style={{ 
                      display: 'inline-flex', 
                      alignItems: 'center', 
                      gap: '4px', 
                      color: 'var(--success)', 
                      fontSize: '0.82rem', 
                      fontWeight: 600 
                    }}>
                      <HiCheckCircle size={16} />
                      Block #{tx.blockNumber}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default TransactionsPage;
