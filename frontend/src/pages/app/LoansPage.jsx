import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { 
  HiClipboardList, 
  HiCheckCircle, 
  HiExclamationCircle, 
  HiRefresh, 
  HiArrowRight, 
  HiInformationCircle,
  HiShieldCheck 
} from 'react-icons/hi';
import './LoansPage.css';

const LoansPage = ({ wallet, contracts }) => {
  const { account, provider } = wallet;
  const { lendingPool, creditScore } = contracts;
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [activeLoan, setActiveLoan] = useState('0.0000');
  const [dueAmount, setDueAmount] = useState('0.0000');
  const [score, setScore] = useState(50);
  const [repayAmount, setRepayAmount] = useState('');
  const [statusMsg, setStatusMsg] = useState(null);

  const fetchLoanData = useCallback(async () => {
    if (!account || !provider) return;
    try {
      if (lendingPool) {
        const principal = await lendingPool.activeLoans(account);
        setActiveLoan(Number(ethers.formatEther(principal)).toFixed(4));

        const due = await lendingPool.getRepaymentAmount(account);
        setDueAmount(Number(ethers.formatEther(due)).toFixed(4));
      }

      if (creditScore) {
        const s = await creditScore.getScore(account);
        setScore(Number(s));
      }
    } catch (e) {
      console.error('Error fetching loan data:', e);
    }
  }, [account, provider, lendingPool, creditScore]);

  useEffect(() => {
    fetchLoanData();
  }, [fetchLoanData]);

  const hasDebt = Number(dueAmount) > 0;

  const handleRepay = async (e) => {
    e.preventDefault();
    if (!lendingPool || !repayAmount || Number(repayAmount) <= 0) return;

    setLoading(true);
    setStatusMsg(null);
    try {
      const tx = await lendingPool.repay({ value: ethers.parseEther(repayAmount) });
      setStatusMsg({ type: 'info', text: 'Repayment submitted on-chain. Processing confirmation...' });
      await tx.wait();
      setStatusMsg({ type: 'success', text: `Repayment of ${repayAmount} ETH successful! Debt reduced.` });
      setRepayAmount('');
      fetchLoanData();
    } catch (err) {
      console.error('Repayment error:', err);
      setStatusMsg({ 
        type: 'error', 
        text: 'Repayment failed: ' + (err.reason || err.shortMessage || err.message) 
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePayFull = () => {
    setRepayAmount(dueAmount);
  };

  return (
    <div className="loans-container">
      {/* Header */}
      <div className="loans-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
            Loans & Debt Management
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Monitor active obligations, settle outstanding micro-loans, and build credit reputation.
          </p>
        </div>

        <button 
          className="btn btn-outline btn-sm" 
          onClick={fetchLoanData}
          disabled={loading}
        >
          <HiRefresh className={loading ? 'spinning' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {!hasDebt ? (
        /* Zero Debt State */
        <div className="no-debt-card">
          <div className="no-debt-icon">
            <HiCheckCircle size={44} />
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.6rem' }}>
            No Active Loans
          </h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '480px', lineHeight: 1.6 }}>
            Your account is in excellent standing with 0.00 ETH outstanding debt. Your current credit reputation score is <strong>{score}/100</strong>.
          </p>
          <button 
            className="btn btn-gold btn-lg" 
            onClick={() => navigate('/app/borrow')}
            style={{ marginTop: '12px' }}
          >
            <span>Request New Micro-Loan</span>
            <HiArrowRight />
          </button>
        </div>
      ) : (
        /* Active Loan & Repay Grid */
        <div className="loans-grid">
          {/* Left Column: Repay Form */}
          <div className="loan-status-box">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem' }}>
                Active Obligation
              </h2>
              <span className="badge badge-warning" style={{ background: 'rgba(255, 176, 32, 0.1)', color: 'var(--warning)', border: '1px solid var(--warning)' }}>
                Active Debt
              </span>
            </div>

            {/* Debt Highlight Card */}
            <div className="debt-highlight">
              <div>
                <span className="debt-sub">Total Due (Principal + 5% Fee)</span>
                <div className="debt-number">{dueAmount} ETH</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className="debt-sub">Original Principal</span>
                <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: 'var(--text-primary)', marginTop: '4px' }}>
                  {activeLoan} ETH
                </div>
              </div>
            </div>

            <form onSubmit={handleRepay}>
              <div className="input-container">
                <div className="input-top">
                  <span>Repayment Amount</span>
                  <span>
                    Total Due: <strong>{dueAmount} ETH</strong>
                  </span>
                </div>

                <div className="input-row">
                  <input 
                    type="number"
                    step="0.0001"
                    min="0"
                    placeholder="0.00"
                    className="input-field"
                    value={repayAmount}
                    onChange={(e) => setRepayAmount(e.target.value)}
                    disabled={loading}
                  />
                  <button 
                    type="button" 
                    className="btn btn-outline btn-sm"
                    onClick={handlePayFull}
                    style={{ padding: '6px 12px' }}
                  >
                    Pay Full
                  </button>
                </div>
              </div>

              {/* Status Message */}
              {statusMsg && (
                <div style={{
                  marginTop: '16px',
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.88rem',
                  background: statusMsg.type === 'error' ? 'var(--danger-bg)' : statusMsg.type === 'success' ? 'var(--success-bg)' : 'var(--info-bg)',
                  border: `1px solid ${statusMsg.type === 'error' ? 'var(--danger)' : statusMsg.type === 'success' ? 'var(--success)' : 'var(--info)'}`,
                  color: statusMsg.type === 'error' ? 'var(--danger)' : statusMsg.type === 'success' ? 'var(--success)' : 'var(--info)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  {statusMsg.type === 'success' ? <HiCheckCircle size={20} /> : <HiInformationCircle size={20} />}
                  <span>{statusMsg.text}</span>
                </div>
              )}

              <button 
                type="submit" 
                className="btn btn-gold btn-lg" 
                style={{ width: '100%', marginTop: '24px' }}
                disabled={loading || !repayAmount || Number(repayAmount) <= 0}
              >
                {loading ? 'Confirming On-Chain Repayment...' : `Submit Repayment of ${Number(repayAmount || 0).toFixed(4)} ETH`}
              </button>
            </form>
          </div>

          {/* Right Column: Benefits & Credit Impacts */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="lend-info-card">
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <HiShieldCheck style={{ color: 'var(--gold-primary)' }} />
                Repayment Impact
              </h3>

              <ul style={{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <li style={{ display: 'flex', gap: '10px' }}>
                  <HiCheckCircle size={18} style={{ color: 'var(--success)', flexShrink: 0, marginTop: '2px' }} />
                  <span><strong>Credit Score Boost:</strong> Full repayment immediately triggers credit score rewards.</span>
                </li>
                <li style={{ display: 'flex', gap: '10px' }}>
                  <HiCheckCircle size={18} style={{ color: 'var(--success)', flexShrink: 0, marginTop: '2px' }} />
                  <span><strong>Higher Limits:</strong> Advance to higher borrowing limits (up to 5.0 ETH).</span>
                </li>
                <li style={{ display: 'flex', gap: '10px' }}>
                  <HiCheckCircle size={18} style={{ color: 'var(--success)', flexShrink: 0, marginTop: '2px' }} />
                  <span><strong>Collateral Freedom:</strong> Unlocks withdrawal privileges for your deposited GLP tokens.</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LoansPage;
