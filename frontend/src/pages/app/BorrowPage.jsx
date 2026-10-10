import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { 
  HiShieldCheck, 
  HiExclamationCircle, 
  HiCheckCircle, 
  HiInformationCircle, 
  HiArrowRight, 
  HiSparkles, 
  HiClock 
} from 'react-icons/hi';
import { calculateEstimatedRateBps } from '../../utils/contractHelpers';
import './BorrowPage.css';

const SUPPORTED_TENURES = [
  { days: 7, label: '7 Days' },
  { days: 14, label: '14 Days' },
  { days: 30, label: '30 Days (Standard)' },
  { days: 60, label: '60 Days' },
  { days: 90, label: '90 Days' },
];

const BorrowPage = ({ wallet, contracts, eventSync }) => {
  const { account, provider } = wallet;
  const { lendingPool, creditScore, glpToken } = contracts;
  const navigate = useNavigate();

  const [amount, setAmount] = useState('');
  const [tenureDays, setTenureDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [borrowLimit, setBorrowLimit] = useState('0.5000');
  const [score, setScore] = useState(50);
  const [glpBalance, setGlpBalance] = useState('0.0000');
  const [activeLoan, setActiveLoan] = useState('0.0000');
  const [dueAmount, setDueAmount] = useState('0.0000');
  const [poolLiquidity, setPoolLiquidity] = useState('0.0000');
  const [insuranceReserve, setInsuranceReserve] = useState('0.0000');
  const [totalPoolLoans, setTotalPoolLoans] = useState('0.0000');
  const [isDefaulter, setIsDefaulter] = useState(false);
  const [rehabCooldownUntil, setRehabCooldownUntil] = useState(0n);
  const [isCooldownActive, setIsCooldownActive] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  const fetchBorrowData = useCallback(async () => {
    if (!account || !provider || !lendingPool) return;
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
        const cooldown = await creditScore.rehabilitationCooldownUntil(account);
        const cdBig = BigInt(cooldown);
        setRehabCooldownUntil(cdBig);
        setIsCooldownActive(cdBig > BigInt(Math.floor(Date.now() / 1000)));
      }

      // 3. Lending Pool status & reserves
      const poolAddr = await lendingPool.getAddress();
      const rawBal = await provider.getBalance(poolAddr);
      const reserve = await lendingPool.insuranceReserve();
      setInsuranceReserve(Number(ethers.formatEther(reserve)).toFixed(4));

      // Liquid free cash = balance - insuranceReserve
      const freeCash = rawBal > reserve ? rawBal - reserve : 0n;
      setPoolLiquidity(Number(ethers.formatEther(freeCash)).toFixed(4));

      const loans = await lendingPool.activeLoans(account);
      setActiveLoan(Number(ethers.formatEther(loans)).toFixed(4));

      const due = await lendingPool.getRepaymentAmount(account);
      setDueAmount(Number(ethers.formatEther(due)).toFixed(4));

      const activeTotal = await lendingPool.totalActiveLoans();
      setTotalPoolLoans(Number(ethers.formatEther(activeTotal)).toFixed(4));

      const defaulter = await lendingPool.isDefaulter(account);
      setIsDefaulter(defaulter);
    } catch (e) {
      console.error('Error fetching borrow data:', e);
    }
  }, [account, provider, glpToken, creditScore, lendingPool]);

  // Initial fetch and reactive re-fetch on cross-client events
  useEffect(() => {
    fetchBorrowData();
  }, [fetchBorrowData, eventSync?.syncTick]);

  const hasDeposit = Number(glpBalance) > 0;
  const hasActiveLoan = Number(activeLoan) > 0;

  // Real-time calculation of estimated borrow APR and interest
  const numAmount = Number(amount) || 0;
  let estimatedAprPercent = '9.12';
  let estimatedInterestEth = '0.0000';
  let estimatedTotalDueEth = '0.0000';

  if (numAmount > 0 && lendingPool) {
    try {
      const borrowWei = ethers.parseEther(amount);
      const freeCashWei = ethers.parseEther(poolLiquidity || '0');
      const activeLoansWei = ethers.parseEther(totalPoolLoans || '0');
      const rateBps = calculateEstimatedRateBps(borrowWei, freeCashWei, activeLoansWei, score);
      const apr = Number(rateBps) / 100;
      estimatedAprPercent = apr.toFixed(2);
      
      const interestWei = (borrowWei * rateBps * BigInt(tenureDays) * 86400n) / (10000n * 365n * 86400n);
      estimatedInterestEth = Number(ethers.formatEther(interestWei)).toFixed(5);
      estimatedTotalDueEth = (numAmount + Number(estimatedInterestEth)).toFixed(5);
    } catch {
      // Fallback display
    }
  }

  const handleBorrow = async (e) => {
    e.preventDefault();
    if (!lendingPool || !amount || Number(amount) <= 0) return;

    if (isDefaulter) {
      setStatusMsg({ type: 'error', text: 'Account is in default. Please settle written-off debt to rehabilitate.' });
      return;
    }

    if (isCooldownActive) {
      setStatusMsg({ type: 'error', text: `Rehabilitation cooldown active until ${new Date(Number(rehabCooldownUntil) * 1000).toLocaleString()}.` });
      return;
    }

    if (!hasDeposit) {
      setStatusMsg({ type: 'error', text: 'You must deposit ETH into the lending pool first before borrowing.' });
      return;
    }

    if (hasActiveLoan) {
      setStatusMsg({ type: 'error', text: 'Existing loan must be repaid before requesting a new loan.' });
      return;
    }

    if (Number(amount) > Number(borrowLimit)) {
      setStatusMsg({ type: 'error', text: `Borrow amount exceeds your credit limit of ${borrowLimit} ETH.` });
      return;
    }

    if (Number(amount) > Number(poolLiquidity)) {
      setStatusMsg({ type: 'error', text: `Borrow amount exceeds available pool cash of ${poolLiquidity} ETH.` });
      return;
    }

    // 90% utilization pre-check
    const borrowWei = ethers.parseEther(amount);
    const freeCashWei = ethers.parseEther(poolLiquidity || '0');
    const activeLoansWei = ethers.parseEther(totalPoolLoans || '0');
    const postActive = activeLoansWei + borrowWei;
    const totalCapital = freeCashWei + activeLoansWei;
    if (totalCapital > 0n && (postActive * 10000n) > (totalCapital * 9000n)) {
      setStatusMsg({ type: 'error', text: 'Post-borrow utilization would exceed the protocol 90% safety cap. Try a smaller amount.' });
      return;
    }

    setLoading(true);
    setStatusMsg({ type: 'info', text: 'Submitting borrow transaction to blockchain...' });
    try {
      // Call V2 borrow(amount, tenureDays) using explicit function signature
      const tx = await lendingPool["borrow(uint256,uint256)"](borrowWei, tenureDays);
      setStatusMsg({ type: 'info', text: `Transaction sent (${tx.hash.slice(0, 10)}...). Waiting for block confirmation...` });
      await tx.wait();
      setStatusMsg({ type: 'success', text: `Loan approved! ${amount} ETH transferred to your wallet for ${tenureDays} days.` });
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

  return (
    <div className="borrow-container">
      {/* Header */}
      <div className="borrow-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
            Borrow Micro-Loans (V2)
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Instant collateral-free micro-lending governed by kinked utilization curves & on-chain credit scoring.
          </p>
        </div>
      </div>

      {/* Blockers */}
      {isDefaulter ? (
        <div className="borrow-alert-card">
          <div className="borrow-alert-icon" style={{ background: 'rgba(239, 68, 68, 0.15)', color: 'var(--danger)' }}>
            <HiExclamationCircle size={36} />
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', color: 'var(--danger)' }}>Defaulter Status Active</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '500px', lineHeight: 1.6 }}>
            Your account is marked in default due to an overdue loan past grace period. You must settle written-off debt to rehabilitate.
          </p>
          <button 
            className="btn btn-gold btn-lg" 
            onClick={() => navigate('/app/loans')}
            style={{ marginTop: '8px' }}
          >
            <span>Go to Loans & Settle Debt</span>
            <HiArrowRight />
          </button>
        </div>
      ) : isCooldownActive ? (
        <div className="borrow-alert-card">
          <div className="borrow-alert-icon" style={{ background: 'rgba(255, 176, 32, 0.15)', color: 'var(--warning)' }}>
            <HiClock size={36} />
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem' }}>Rehabilitation Cooldown Active</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '500px', lineHeight: 1.6 }}>
            You have recently settled written-off debt. Protocol safety requires a 14-day rehabilitation cooldown before new loans can be issued.
            <br />
            <strong>Expires: {new Date(Number(rehabCooldownUntil) * 1000).toLocaleString()}</strong>
          </p>
        </div>
      ) : hasActiveLoan ? (
        <div className="borrow-alert-card">
          <div className="borrow-alert-icon" style={{ background: 'rgba(255, 176, 32, 0.15)', color: 'var(--warning)' }}>
            <HiExclamationCircle size={36} />
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem' }}>Active Loan Detected</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '500px', lineHeight: 1.6 }}>
            You currently have an outstanding principal of <strong>{activeLoan} ETH</strong> (Total due: <strong>{dueAmount} ETH</strong>). The protocol requires settling existing loans before requesting a new loan.
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
        <div className="borrow-alert-card">
          <div className="borrow-alert-icon" style={{ background: 'var(--gold-glow)', color: 'var(--gold-primary)' }}>
            <HiShieldCheck size={36} />
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem' }}>Deposit Required to Qualify</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '500px', lineHeight: 1.6 }}>
            To activate borrowing privileges and establish your credit profile, you must first deposit ETH into the GigLend pool. Deposits mint GLP shares and can be withdrawn after loan settlement.
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
                Request Micro-Loan
              </h2>
              <span className="badge badge-gold">Kinked Curve ({estimatedAprPercent}% APR Est.)</span>
            </div>

            <form onSubmit={handleBorrow}>
              {/* Amount Input */}
              <div className="input-container" style={{ marginTop: '16px' }}>
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
                  <span className="input-suffix">ETH</span>
                </div>
              </div>

              {/* Tenure Selection */}
              <div style={{ marginTop: '16px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  Loan Tenure (Supported 7 to 90 Days)
                </label>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {SUPPORTED_TENURES.map((t) => (
                    <button
                      key={t.days}
                      type="button"
                      onClick={() => setTenureDays(t.days)}
                      className={`btn btn-sm ${tenureDays === t.days ? 'btn-gold' : 'btn-outline'}`}
                      style={{ flex: 1, minWidth: '90px' }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Status Message */}
              {statusMsg && (
                <div style={{
                  marginTop: '16px',
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

              {/* Submit Button */}
              <button 
                type="submit" 
                className="btn btn-gold btn-lg btn-block" 
                style={{ marginTop: '20px' }}
                disabled={loading || !amount || Number(amount) <= 0}
              >
                {loading ? 'Processing on Blockchain...' : `Borrow ${amount ? amount : '0.00'} ETH`}
              </button>
            </form>
          </div>

          {/* Right Column: Dynamic Estimates Breakdown */}
          <div className="preview-box">
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <HiSparkles style={{ color: 'var(--gold-primary)' }} />
              <span>Borrowing Estimates Breakdown</span>
            </h3>

            <div className="preview-item">
              <span className="preview-label">Requested Principal</span>
              <span className="preview-value">{numAmount.toFixed(4)} ETH</span>
            </div>

            <div className="preview-item">
              <span className="preview-label">Selected Tenure</span>
              <span className="preview-value">{tenureDays} Days</span>
            </div>

            <div className="preview-item">
              <span className="preview-label">Estimated Locked APR</span>
              <span className="preview-value" style={{ color: 'var(--gold-primary)' }}>
                {estimatedAprPercent}% APR
              </span>
            </div>

            <div className="preview-item">
              <span className="preview-label">Estimated Interest Due</span>
              <span className="preview-value">{estimatedInterestEth} ETH</span>
            </div>

            <div className="preview-item">
              <span className="preview-label">Pool Insurance Reserve</span>
              <span className="preview-value">{insuranceReserve} ETH</span>
            </div>

            <div className="preview-divider" />

            <div className="preview-item total-row">
              <span className="total-label">Total Expected Repayment</span>
              <span className="total-val">{estimatedTotalDueEth} ETH</span>
            </div>

            <div style={{ marginTop: '16px', padding: '12px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              *<strong>Clearly labelled as estimates</strong>: Final APR is locked at the exact block of loan origination based on post-borrow pool utilization and your credit risk tier. 3-day grace period applies after due date.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BorrowPage;
