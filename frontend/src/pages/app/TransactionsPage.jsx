import React, { useState } from 'react';
import { 
  HiChartBar, 
  HiDuplicate, 
  HiCheck, 
  HiExternalLink, 
  HiFilter,
  HiCheckCircle,
  HiArrowSmUp,
  HiArrowSmDown
} from 'react-icons/hi';
import './TransactionsPage.css';

const sampleTransactions = [
  {
    id: 'tx-1',
    hash: '0x3a4f91...8c2d',
    type: 'deposit',
    method: 'Supply Liquidity',
    amount: '1.5000 ETH',
    tokens: '+1.5000 GLP',
    date: '2026-10-07 18:42',
    status: 'Confirmed'
  },
  {
    id: 'tx-2',
    hash: '0x7e12d4...119b',
    type: 'borrow',
    method: 'Borrow Micro-Loan',
    amount: '0.5000 ETH',
    tokens: '-0.5000 ETH',
    date: '2026-10-07 16:15',
    status: 'Confirmed'
  },
  {
    id: 'tx-3',
    hash: '0x99c2b0...4e8f',
    type: 'repay',
    method: 'Repay Obligation',
    amount: '0.5250 ETH',
    tokens: 'Loan Settled',
    date: '2026-10-07 14:02',
    status: 'Confirmed'
  },
  {
    id: 'tx-4',
    hash: '0x12a884...77bc',
    type: 'withdraw',
    method: 'Redeem Pool GLP',
    amount: '0.2500 ETH',
    tokens: '-0.2500 GLP',
    date: '2026-10-06 20:30',
    status: 'Confirmed'
  }
];

const TransactionsPage = ({ wallet, contracts }) => {
  const { account } = wallet;
  const [filter, setFilter] = useState('all');
  const [copiedId, setCopiedId] = useState(null);

  const handleCopy = (hash, id) => {
    navigator.clipboard.writeText(hash);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const filtered = filter === 'all' 
    ? sampleTransactions 
    : sampleTransactions.filter(tx => tx.type === filter);

  return (
    <div className="tx-container">
      {/* Header */}
      <div className="tx-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
            Transaction History
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Comprehensive immutable ledger of all smart contract calls, loans, and liquidity events.
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
        </div>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Showing <strong>{filtered.length}</strong> recorded interactions
        </div>
      </div>

      {/* Table Card */}
      <div className="tx-table-card">
        <table className="tx-table">
          <thead>
            <tr>
              <th>Transaction Hash</th>
              <th>Action / Method</th>
              <th>Volume</th>
              <th>Result</th>
              <th>Timestamp</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(tx => (
              <tr key={tx.id}>
                <td>
                  <div className="tx-hash">
                    <span>{tx.hash}</span>
                    <button 
                      className="copy-btn" 
                      onClick={() => handleCopy(tx.hash, tx.id)}
                      title="Copy transaction hash"
                    >
                      {copiedId === tx.id ? <HiCheck size={16} style={{ color: 'var(--success)' }} /> : <HiDuplicate size={16} />}
                    </button>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={`event-type-badge event-${tx.type}`}>{tx.type}</span>
                    <span style={{ fontWeight: 500 }}>{tx.method}</span>
                  </div>
                </td>
                <td>
                  <strong style={{ color: 'var(--text-primary)' }}>{tx.amount}</strong>
                </td>
                <td>
                  <span style={{ color: 'var(--gold-primary)', fontSize: '0.85rem' }}>{tx.tokens}</span>
                </td>
                <td style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                  {tx.date}
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
                    {tx.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TransactionsPage;
