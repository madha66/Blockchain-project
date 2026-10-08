import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { 
  HiTrendingDown, 
  HiShieldCheck, 
  HiExclamationCircle, 
  HiCheckCircle, 
  HiInformationCircle,
  HiArrowRight,
  HiSparkles 
} from 'react-icons/hi';
import './BorrowPage.css';

const BorrowPage = ({ wallet, contracts }) => {
  const { account, provider } = wallet;
  const { lendingPool, creditScore, glpToken } = contracts;
  const navigate = useNavigate();

  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [borrowLimit, setBorrowLimit] = useState('0.5000');
  const [score, setScore] = useState(50);
  const [glpBalance, setGlpBalance] = useState('0.0000');
  const [activeLoan, setActiveLoan] = useState('0.0000');
  const [dueAmount, setDueAmount] = useState('0.0000');
  const [poolLiquidity, setPoolLiquidity] = useState('0.0000');
  const [statusMsg, setStatusMsg] = useState(null);

  const fetchBorrowData = useCallback(async () => {
    if (!account || !provider) return;
    try {
      // 1. GLP Balance
      if (glpToken) {
        const bal = await glpToken.balanceOf(account);
        setGlpBalance(Number(ethers.formatEther(bal)).toFixed(4));
      }

      // 2. Credit Score & Borrow Limit
      if (creditScore) {
        const s = await creditScore.getScore(account);
        setScore(Number(s));
        const limit = await creditScore.getBorrowLimit(account);
        setBorrowLimit(Number(ethers.formatEther(limit)).toFixed(4));
      }

      // 3. Lending Pool status
      if (lendingPool) {
        const loans = await lendingPool.activeLoans(account);
        setActiveLoan(Number(ethers.formatEther(loans)).toFixed(4));

        const due = await lendingPool.getRepaymentAmount(account);
        setDueAmount(Number(ethers.formatEther(due)).toFixed(4));

        const poolAddr = await lendingPool.getAddress();
        const poolBal = await provider.getBalance(poolAddr);
        setPoolLiquidity(Number(ethers.formatEther(poolBal)).toFixed(4));
      }
    } catch (e) {
      console.error('Error fetching borrow data:', e);
    }
  }, [account, provider, glpToken, creditScore, lendingPool]);

  useEffect(() => {
    fetchBorrowData();
  }, [fetchBorrowData]);

  const hasDeposit = Number(glpBalance) > 0;
  const hasActiveLoan = Number(activeLoan) > 0;

  const handleBorrow = async (e) => {
    e.preventDefault();
    if (!lendingPool || !amount || Number(amount) <= 0) return;

    if (!hasDeposit) {
      setStatusMsg({ type: 'error', text: 'You must deposit ETH into the lending pool first before borrowing.' });
      return;
    }

    if (hasActiveLoan) {
      setStatusMsg({ type: 'error', text: 'Existing loan must be repaid before taking another loan.' });
      return;
    }

    if (Number(amount) > Number(borrowLimit)) {
      setStatusMsg({ type: 'error', text: `Borrow amount exceeds your credit limit of ${borrowLimit} ETH.` });
      return;
    }

    if (Number(amount) > Number(poolLiquidity)) {
      setStatusMsg({ type: 'error', text: `Borrow amount exceeds pool available liquidity of ${poolLiquidity} ETH.` });
      return;
    }

    setLoading(true);
    setStatusMsg(null);
    try {
      const tx = await lendingPool.borrow(ethers.parseEther(amount));
      setStatusMsg({ type: 'info', text: 'Borrow transaction submitted. Waiting for blockchain confirmation...' });
      await tx.wait();
      setStatusMsg({ type: 'success', text: `Loan approved! ${amount} ETH transferred to your wallet.` });
      setAmount('');
      fetchBorrowData();
    } catch (err) {
      console.error('Borrow failed:', err);
      setStatusMsg({ 
        type: 'error', 
        text: 'Borrow failed: ' + (err.reason || err.shortMessage || err.message || 'Check pool liquidity or contract constraints.') 
      });
    } finally {
      setLoading(false);
    }
  };

  // Calculations for preview
  const numAmount = Number(amount) || 0;
  const interestFee = (numAmount * 0.05).toFixed(4);
  const totalRepayAmount = (numAmount * 1.05).toFixed(4);

  return (
    <div className="borrow-container">
      {/* Header */}
      <div className="borrow-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
            Borrow Micro-Loans
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Instant collateral-free micro-lending governed by on-chain credit scoring algorithms.
          </p>
        </div>
      </div>

      {/* Conditional Warning / Blocker 1: Has Active Loan */}
      {hasActiveLoan ? (
        <div className="borrow-alert-card">
          <div className="borrow-alert-icon" style={{ background: 'rgba(255, 176, 32, 0.15)', color: 'var(--warning)' }}>
            <HiExclamationCircle size={36} />
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem' }}>Active Loan Detected</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '500px', lineHeight: 1.6 }}>
            You currently have an outstanding loan of <strong>{activeLoan} ETH</strong> (Total due with 5% interest: <strong>{dueAmount} ETH</strong>). The protocol requires settling existing loans before requesting a new loan.
          </p>
          <button 
            className="btn btn-gold btn-lg" 
            onClick={() => navigate('/app/loans')}
            style={{ marginTop: '8px' }}
          >
            <span>Proceed to Repay Loan</span>
            <HiArrowRight />
          </button>
        </div>
      ) : !hasDeposit ? (
        /* Conditional Warning / Blocker 2: No Deposit Yet */
        <div className="borrow-alert-card">
          <div className="borrow-alert-icon" style={{ background: 'var(--gold-glow)', color: 'var(--gold-primary)' }}>
            <HiShieldCheck size={36} />
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem' }}>Deposit Required to Qualify</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '500px', lineHeight: 1.6 }}>
            To activate borrowing privileges and establish your credit profile, you must first deposit ETH into the GigLend pool. Deposits can be withdrawn anytime after loan settlement.
          </p>
          <button 
            className="btn btn-gold btn-lg" 
            onClick={() => navigate('/app/lend')}
            style={{ marginTop: '8px' }}
          >
            <span>Make Initial Deposit</span>
            <HiArrowRight />
          </button>
        </div>
      ) : (
        /* Active Borrow Form Grid */
        <div className="borrow-grid">
          <div className="form-box">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem' }}>
                Request Loan
              </h2>
              <span className="badge badge-gold">5.0% Fixed Interest</span>
            </div>

            <form onSubmit={handleBorrow}>
              <div className="input-container">
                <div className="input-top">
                  <span>Borrow Amount</span>
                  <span>
                    Limit: <strong style={{ color: 'var(--gold-primary)' }}>{borrowLimit} ETH</strong>
                  </span>
                </div>

                <div className="input-row">
                  <input 
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    className="input-field"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={loading}
                  />
                  <button 
                    type="button" 
                    className="btn btn-outline btn-sm"
                    onClick={() => setAmount(borrowLimit)}
                    style={{ padding: '6px 12px' }}
                  >
                    Max
                  </button>
                </div>
              </div>

              {/* Loan Terms Breakdown */}
              <div className="breakdown-box" style={{ marginTop: '20px' }}>
                <div className="breakdown-item">
                  <span>Requested Principal</span>
                  <strong>{numAmount.toFixed(4)} ETH</strong>
                </div>
                <div className="breakdown-item">
                  <span>Fixed Interest Fee (5%)</span>
                  <strong style={{ color: 'var(--warning)' }}>+{interestFee} ETH</strong>
                </div>
                <div className="breakdown-item" style={{ borderTop: '1px solid var(--border-primary)', paddingTop: '10px', marginTop: '4px' }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Total Repayment Due</span>
                  <strong style={{ color: 'var(--gold-primary)', fontSize: '1.1rem' }}>
                    {totalRepayAmount} ETH
                  </strong>
                </div>
                <div className="breakdown-item">
                  <span>Disbursement Speed</span>
                  <strong style={{ color: 'var(--success)' }}>Instant (Automated)</strong>
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
                disabled={loading || !amount || Number(amount) <= 0 || Number(amount) > Number(borrowLimit)}
              >
                {loading ? 'Processing Loan Disbursement...' : `Borrow ${numAmount > 0 ? numAmount.toFixed(3) : ''} ETH`}
              </button>
            </form>
          </div>

          {/* Right Column: Credit Tiers & Guidelines */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="credit-tier-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <HiSparkles style={{ color: 'var(--gold-primary)' }} />
                  Credit Score Tiers
                </h3>
                <span className="score-badge">Your Score: {score}</span>
              </div>

              <table className="tier-table">
                <thead>
                  <tr>
                    <th>Score Tier</th>
                    <th>Borrow Limit</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={score <= 60 ? 'active-tier' : ''}>
                    <td>0 – 60 (Initial)</td>
                    <td>0.5 ETH</td>
                    <td>{score <= 60 ? 'Current' : 'Unlocked'}</td>
                  </tr>
                  <tr className={score >= 61 && score <= 75 ? 'active-tier' : ''}>
                    <td>61 – 75 (Tier 2)</td>
                    <td>1.5 ETH</td>
                    <td>{score >= 61 && score <= 75 ? 'Current' : (score > 75 ? 'Unlocked' : 'Locked')}</td>
                  </tr>
                  <tr className={score >= 76 && score <= 90 ? 'active-tier' : ''}>
                    <td>76 – 90 (Tier 3)</td>
                    <td>3.0 ETH</td>
                    <td>{score >= 76 && score <= 90 ? 'Current' : (score > 90 ? 'Unlocked' : 'Locked')}</td>
                  </tr>
                  <tr className={score >= 91 ? 'active-tier' : ''}>
                    <td>91 – 100 (Elite)</td>
                    <td>5.0 ETH</td>
                    <td>{score >= 91 ? 'Current' : 'Locked'}</td>
                  </tr>
                </tbody>
              </table>

              <div className="protocol-tip-box" style={{ marginTop: '10px' }}>
                <HiInformationCircle size={20} />
                <div className="protocol-tip-content">
                  <h4>Automated Reputation Algorithm</h4>
                  <p>
                    Every on-time repayment directly increases your on-chain credit score, unlocking higher tiers without needing excessive collateral.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BorrowPage;
