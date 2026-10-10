import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { 
  HiCheckCircle, 
  HiRefresh, 
  HiArrowRight, 
  HiInformationCircle 
} from 'react-icons/hi';
import './LoansPage.css';

const LoansPage = ({ wallet, contracts, eventSync }) => {
  const { account, provider } = wallet;
  const { lendingPool, creditScore } = contracts;
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [loanDetails, setLoanDetails] = useState(null);
  const [dueAmount, setDueAmount] = useState('0.0000');
  const [accruedInterest, setAccruedInterest] = useState('0.0000');
  const [score, setScore] = useState(50);
  const [repayAmount, setRepayAmount] = useState('');
  
  // Defaulter & Recovery state
  const [isDefaulter, setIsDefaulter] = useState(false);
  const [writtenOffDebt, setWrittenOffDebt] = useState('0.0000');
  const [reserveDrawn, setReserveDrawn] = useState('0.0000');
  const [totalRecoveryDebt, setTotalRecoveryDebt] = useState('0.0000');
  const [settleDebtAmount, setSettleDebtAmount] = useState('');
  const [rehabCooldownUntil, setRehabCooldownUntil] = useState(0n);
  const [isCooldownActive, setIsCooldownActive] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  const fetchLoanData = useCallback(async () => {
    if (!account || !provider || !lendingPool) return;
    try {
      // 1. Fetch Loan Struct
      const rawLoan = await lendingPool.loans(account);
      const principal = rawLoan[0]; // principal
      const originationTime = Number(rawLoan[1]);
      const dueDate = Number(rawLoan[2]);
      const lockedRateBps = Number(rawLoan[5]);
      const tenureDays = Number(rawLoan[6]);

      if (principal > 0n) {
        setLoanDetails({
          principal: Number(ethers.formatEther(principal)).toFixed(4),
          originationDate: new Date(originationTime * 1000).toLocaleDateString(),
          dueDate: new Date(dueDate * 1000).toLocaleString(),
          gracePeriodDate: new Date((dueDate + (3 * 86400)) * 1000).toLocaleString(),
          isOverdue: Date.now() / 1000 > dueDate,
          isPastGrace: Date.now() / 1000 > (dueDate + (3 * 86400)),
          lockedAprPercent: (lockedRateBps / 100).toFixed(2),
          tenureDays,
        });

        // 2. Authoritative contract getters for total due and accrued interest
        const due = await lendingPool.getRepaymentAmount(account);
        setDueAmount(Number(ethers.formatEther(due)).toFixed(4));

        const accrued = await lendingPool.getAccruedInterest(account);
        setAccruedInterest(Number(ethers.formatEther(accrued)).toFixed(5));
      } else {
        setLoanDetails(null);
        setDueAmount('0.0000');
        setAccruedInterest('0.0000');
      }

      // 3. Credit score & cooldown
      if (creditScore) {
        const s = await creditScore.getScore(account);
        setScore(Number(s));
        const cooldown = await creditScore.rehabilitationCooldownUntil(account);
        const cdBig = BigInt(cooldown);
        setRehabCooldownUntil(cdBig);
        setIsCooldownActive(cdBig > BigInt(Math.floor(Date.now() / 1000)));
      }

      // 4. Defaulter & Debt Recovery State
      const defaulter = await lendingPool.isDefaulter(account);
      setIsDefaulter(defaulter);

      const memoDebt = await lendingPool.writtenOffDebt(account);
      const resDrawn = await lendingPool.reserveDrawn(account);
      const totalDebtWei = memoDebt + resDrawn;
      setWrittenOffDebt(Number(ethers.formatEther(memoDebt)).toFixed(4));
      setReserveDrawn(Number(ethers.formatEther(resDrawn)).toFixed(4));
      setTotalRecoveryDebt(Number(ethers.formatEther(totalDebtWei)).toFixed(4));
    } catch (e) {
      console.error('Error fetching loan data:', e);
    }
  }, [account, provider, lendingPool, creditScore]);

  useEffect(() => {
    fetchLoanData();
  }, [fetchLoanData, eventSync?.syncTick]);

  const hasDebt = loanDetails && Number(loanDetails.principal) > 0;
  const hasDefaulterDebt = Number(totalRecoveryDebt) > 0;

  // Regular Loan Repayment
  const handleRepay = async (e) => {
    e.preventDefault();
    if (!lendingPool || !repayAmount || Number(repayAmount) <= 0) return;

    setLoading(true);
    setStatusMsg(null);
    try {
      const tx = await lendingPool.repay({ value: ethers.parseEther(repayAmount) });
      setStatusMsg({ type: 'info', text: 'Repayment submitted. Processing on blockchain...' });
      await tx.wait();
      setStatusMsg({ type: 'success', text: `Repayment of ${repayAmount} ETH successful! Any excess was refunded to your wallet.` });
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

  // Settle Written-Off Debt (Rehabilitation)
  const handleSettleRecoveryDebt = async (e) => {
    e.preventDefault();
    if (!lendingPool || !settleDebtAmount || Number(settleDebtAmount) <= 0) return;

    setLoading(true);
    setStatusMsg(null);
    try {
      const tx = await lendingPool.settleWrittenOffDebt({ value: ethers.parseEther(settleDebtAmount) });
      setStatusMsg({ type: 'info', text: 'Submitting debt settlement to blockchain...' });
      await tx.wait();
      setStatusMsg({ type: 'success', text: `Successfully settled debt! Excess payment refunded.` });
      setSettleDebtAmount('');
      fetchLoanData();
    } catch (err) {
      console.error('Debt settlement error:', err);
      setStatusMsg({ 
        type: 'error', 
        text: 'Settlement failed: ' + (err.reason || err.shortMessage || err.message) 
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="loans-container">
      {/* Header */}
      <div className="loans-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
            Loans & Debt Management (V2)
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Monitor active obligations, locked origination rates, grace periods, and bad debt rehabilitation.
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

      {/* Status Message */}
      {statusMsg && (
        <div style={{
          marginBottom: '20px',
          padding: '12px 16px',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.88rem',
          background: statusMsg.type === 'error' ? 'rgba(239, 68, 68, 0.15)' : statusMsg.type === 'success' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(59, 130, 246, 0.15)',
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

      {/* Defaulter Debt Rehabilitation Banner */}
      {hasDefaulterDebt && (
        <div className="loan-status-box" style={{ marginBottom: '24px', borderColor: 'var(--danger)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', color: 'var(--danger)' }}>
              Written-Off Debt Recovery & Rehabilitation
            </h2>
            <span className="badge badge-danger">Defaulted Debt: {totalRecoveryDebt} ETH</span>
          </div>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '8px', lineHeight: 1.6 }}>
            This account defaulted on a previous loan. Protocol accounting allocates recoveries first to replenish the insurance reserve (<strong>{reserveDrawn} ETH</strong>), with remaining funds clearing memorandum debt (<strong>{writtenOffDebt} ETH</strong>). Clearing all debt restores good standing.
          </p>

          <form onSubmit={handleSettleRecoveryDebt} style={{ marginTop: '16px' }}>
            <div className="input-container">
              <div className="input-top">
                <span>Recovery Amount to Pay</span>
                <span>Owed: <strong>{totalRecoveryDebt} ETH</strong></span>
              </div>
              <div className="input-row">
                <input 
                  type="number"
                  step="0.0001"
                  min="0"
                  placeholder="0.00"
                  className="input-field"
                  value={settleDebtAmount}
                  onChange={(e) => setSettleDebtAmount(e.target.value)}
                  disabled={loading}
                />
                <button 
                  type="button" 
                  className="btn btn-outline btn-sm"
                  onClick={() => setSettleDebtAmount(totalRecoveryDebt)}
                >
                  Pay Full Debt
                </button>
              </div>
            </div>

            <button 
              type="submit" 
              className="btn btn-gold btn-lg btn-block" 
              style={{ marginTop: '16px' }}
              disabled={loading || !settleDebtAmount || Number(settleDebtAmount) <= 0}
            >
              {loading ? 'Processing Recovery...' : `Settle ${settleDebtAmount || '0.00'} ETH Debt`}
            </button>
          </form>
        </div>
      )}

      {/* Main Loan View */}
      {!hasDebt ? (
        <div className="no-debt-card">
          <div className="no-debt-icon">
            <HiCheckCircle size={44} />
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.6rem' }}>
            No Active Loans
          </h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '480px', lineHeight: 1.6 }}>
            Your account has 0.00 ETH active principal debt. Your credit reputation score is <strong>{score}/100</strong>.
            {isCooldownActive && (
              <span style={{ display: 'block', marginTop: '8px', color: 'var(--warning)' }}>
                Rehabilitation cooldown active until: {new Date(Number(rehabCooldownUntil) * 1000).toLocaleString()}
              </span>
            )}
          </p>
          <button 
            className="btn btn-gold btn-lg" 
            onClick={() => navigate('/app/borrow')}
            style={{ marginTop: '12px' }}
            disabled={isCooldownActive || isDefaulter}
          >
            <span>Request New Micro-Loan</span>
            <HiArrowRight />
          </button>
        </div>
      ) : (
        <div className="loans-grid">
          {/* Left Column: Active Obligation Breakdown */}
          <div className="loan-status-box">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem' }}>
                Active Loan Obligation
              </h2>
              <span className={`badge ${loanDetails.isPastGrace ? 'badge-danger' : loanDetails.isOverdue ? 'badge-warning' : 'badge-gold'}`}>
                {loanDetails.isPastGrace ? 'Default Eligible' : loanDetails.isOverdue ? 'In Grace Period' : 'Performing'}
              </span>
            </div>

            {/* Debt Highlight Card */}
            <div className="debt-highlight">
              <div>
                <span className="debt-sub">Total Due (Principal + Accrued Interest)</span>
                <div className="debt-number">{dueAmount} ETH</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className="debt-sub">Remaining Principal</span>
                <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: 'var(--text-primary)', marginTop: '4px' }}>
                  {loanDetails.principal} ETH
                </div>
              </div>
            </div>

            {/* V2 Loan Lifecycle Metadata Table */}
            <div style={{ marginTop: '16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '0.85rem' }}>
              <div style={{ padding: '10px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: 'var(--radius-sm)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Locked Origination APR:</span>
                <div style={{ fontWeight: 600, color: 'var(--gold-primary)', marginTop: '2px' }}>{loanDetails.lockedAprPercent}% APR</div>
              </div>
              <div style={{ padding: '10px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: 'var(--radius-sm)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Accrued Interest:</span>
                <div style={{ fontWeight: 600, marginTop: '2px' }}>{accruedInterest} ETH</div>
              </div>
              <div style={{ padding: '10px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: 'var(--radius-sm)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Due Date:</span>
                <div style={{ fontWeight: 600, marginTop: '2px' }}>{loanDetails.dueDate}</div>
              </div>
              <div style={{ padding: '10px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: 'var(--radius-sm)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Grace Period Deadline:</span>
                <div style={{ fontWeight: 600, color: loanDetails.isPastGrace ? 'var(--danger)' : 'var(--text-primary)', marginTop: '2px' }}>
                  {loanDetails.gracePeriodDate}
                </div>
              </div>
            </div>

            {/* Repayment Form */}
            <form onSubmit={handleRepay} style={{ marginTop: '20px' }}>
              <div className="input-container">
                <div className="input-top">
                  <span>Repayment Amount</span>
                  <span>Total Due: <strong>{dueAmount} ETH</strong></span>
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
                    onClick={() => setRepayAmount(dueAmount)}
                  >
                    Pay Full Due
                  </button>
                </div>
              </div>

              <div style={{ marginTop: '12px', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                *<strong>Interest-First Repayment Waterfall</strong>: Payments settle accrued interest first (with 10% contributed to the pool insurance reserve), and remaining funds extinguish principal. Any payment exceeding total due is automatically refunded to your wallet.
              </div>

              <button 
                type="submit" 
                className="btn btn-gold btn-lg btn-block" 
                style={{ marginTop: '16px' }}
                disabled={loading || !repayAmount || Number(repayAmount) <= 0}
              >
                {loading ? 'Processing Repayment...' : `Repay ${repayAmount || '0.00'} ETH`}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default LoansPage;
