import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { 
  HiTrendingUp, 
  HiDownload, 
  HiInformationCircle, 
  HiCheckCircle, 
  HiExclamationCircle,
  HiLightningBolt,
  HiShieldCheck 
} from 'react-icons/hi';
import './LendPage.css';

const LendPage = ({ wallet, contracts }) => {
  const { account, provider } = wallet;
  const { lendingPool, glpToken } = contracts;

  const [activeTab, setActiveTab] = useState('deposit'); // 'deposit' | 'withdraw'
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [ethBalance, setEthBalance] = useState('0.0000');
  const [glpBalance, setGlpBalance] = useState('0.0000');
  const [dueAmount, setDueAmount] = useState('0.0000');
  const [poolLiquidity, setPoolLiquidity] = useState('0.0000');
  const [statusMsg, setStatusMsg] = useState(null);

  const fetchBalances = useCallback(async () => {
    if (!account || !provider) return;
    try {
      const bal = await provider.getBalance(account);
      setEthBalance(Number(ethers.formatEther(bal)).toFixed(4));

      if (glpToken) {
        const glpBal = await glpToken.balanceOf(account);
        setGlpBalance(Number(ethers.formatEther(glpBal)).toFixed(4));
      }

      if (lendingPool) {
        const due = await lendingPool.getRepaymentAmount(account);
        setDueAmount(Number(ethers.formatEther(due)).toFixed(4));

        const poolAddr = await lendingPool.getAddress();
        const poolBal = await provider.getBalance(poolAddr);
        setPoolLiquidity(Number(ethers.formatEther(poolBal)).toFixed(4));
      }
    } catch (e) {
      console.error('Error fetching lend page balances:', e);
    }
  }, [account, provider, glpToken, lendingPool]);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  // Handle Percentage Quick Select
  const handlePercent = (pct) => {
    if (activeTab === 'deposit') {
      const maxVal = Math.max(0, Number(ethBalance) - 0.005); // leave small gas buffer
      const val = (maxVal * pct).toFixed(4);
      setAmount(val > 0 ? val : '0');
    } else {
      const val = (Number(glpBalance) * pct).toFixed(4);
      setAmount(val > 0 ? val : '0');
    }
  };

  // Submit Deposit
  const handleDeposit = async (e) => {
    e.preventDefault();
    if (!lendingPool || !amount || Number(amount) <= 0) return;

    setLoading(true);
    setStatusMsg(null);
    try {
      const tx = await lendingPool.deposit({ value: ethers.parseEther(amount) });
      setStatusMsg({ type: 'info', text: 'Transaction sent to blockchain. Awaiting confirmation...' });
      await tx.wait();
      setStatusMsg({ type: 'success', text: `Successfully deposited ${amount} ETH!` });
      setAmount('');
      fetchBalances();
    } catch (err) {
      console.error('Deposit error:', err);
      setStatusMsg({ 
        type: 'error', 
        text: 'Deposit failed: ' + (err.reason || err.shortMessage || err.message) 
      });
    } finally {
      setLoading(false);
    }
  };

  // Submit Withdraw
  const handleWithdraw = async (e) => {
    e.preventDefault();
    if (!lendingPool || !amount || Number(amount) <= 0) return;

    if (Number(amount) > Number(glpBalance)) {
      setStatusMsg({ type: 'error', text: 'Withdraw amount exceeds your GLP token balance.' });
      return;
    }

    if (Number(amount) > Number(poolLiquidity)) {
      setStatusMsg({ type: 'error', text: 'Withdraw amount exceeds current pool liquidity.' });
      return;
    }

    setLoading(true);
    setStatusMsg(null);
    try {
      const tx = await lendingPool.withdraw(ethers.parseEther(amount));
      setStatusMsg({ type: 'info', text: 'Withdrawal submitted. Burning GLP & transferring ETH...' });
      await tx.wait();
      setStatusMsg({ type: 'success', text: `Successfully withdrew ${amount} ETH!` });
      setAmount('');
      fetchBalances();
    } catch (err) {
      console.error('Withdraw error:', err);
      setStatusMsg({ 
        type: 'error', 
        text: 'Withdraw failed: ' + (err.reason || err.shortMessage || err.message) 
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="lend-container">
      {/* Header */}
      <div className="lend-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
            Lend & Earn
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Provide liquidity to the GigLend pool, mint yield-bearing GLP tokens, or redeem ETH.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="lend-tabs">
          <button 
            className={`lend-tab ${activeTab === 'deposit' ? 'active' : ''}`}
            onClick={() => { setActiveTab('deposit'); setAmount(''); setStatusMsg(null); }}
          >
            Supply / Deposit
          </button>
          <button 
            className={`lend-tab ${activeTab === 'withdraw' ? 'active' : ''}`}
            onClick={() => { setActiveTab('withdraw'); setAmount(''); setStatusMsg(null); }}
          >
            Redeem / Withdraw
          </button>
        </div>
      </div>

      {/* Grid: Form on Left, Protocol Info on Right */}
      <div className="lend-grid">
        <div className="form-box">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem' }}>
              {activeTab === 'deposit' ? 'Deposit ETH to Pool' : 'Withdraw ETH from Pool'}
            </h2>
            <span className="badge badge-gold">
              {activeTab === 'deposit' ? 'Mints GLP 1:1' : 'Burns GLP 1:1'}
            </span>
          </div>

          {/* Active loan reminder on deposit */}
          {activeTab === 'deposit' && Number(dueAmount) > 0 && (
            <div style={{ 
              background: 'rgba(255, 176, 32, 0.08)', 
              border: '1px solid var(--warning)', 
              borderRadius: 'var(--radius-md)', 
              padding: '12px 16px',
              display: 'flex',
              gap: '12px',
              alignItems: 'center'
            }}>
              <HiExclamationCircle size={22} style={{ color: 'var(--warning)', flexShrink: 0 }} />
              <div style={{ fontSize: '0.85rem', color: '#ffb020' }}>
                You currently have an active debt of <strong>{dueAmount} ETH</strong>. Any deposit will first automatically pay down your outstanding loan before minting new GLP tokens.
              </div>
            </div>
          )}

          {/* Form */}
          <form onSubmit={activeTab === 'deposit' ? handleDeposit : handleWithdraw}>
            <div className="input-container">
              <div className="input-top">
                <span>{activeTab === 'deposit' ? 'Amount to Supply' : 'Amount to Redeem'}</span>
                <span>
                  Available:{' '}
                  <strong>{activeTab === 'deposit' ? `${ethBalance} ETH` : `${glpBalance} GLP`}</strong>
                </span>
              </div>

              <div className="input-row">
                <input 
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="0.00"
                  className="input-field"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={loading}
                />
                <div className="token-badge">
                  <svg viewBox="0 0 32 32" width="18" height="18" fill="none">
                    <circle cx="16" cy="16" r="14" stroke="#f0b90b" strokeWidth="2" fill="none"/>
                    <path d="M10 16 L16 10 L22 16 L16 22 Z" fill="#f0b90b"/>
                  </svg>
                  <span>{activeTab === 'deposit' ? 'ETH' : 'GLP'}</span>
                </div>
              </div>

              <div className="percent-selector">
                <button type="button" className="percent-btn" onClick={() => handlePercent(0.25)}>25%</button>
                <button type="button" className="percent-btn" onClick={() => handlePercent(0.50)}>50%</button>
                <button type="button" className="percent-btn" onClick={() => handlePercent(0.75)}>75%</button>
                <button type="button" className="percent-btn" onClick={() => handlePercent(1.00)}>Max</button>
              </div>
            </div>

            {/* Breakdown summary */}
            <div className="breakdown-box" style={{ marginTop: '20px' }}>
              <div className="breakdown-item">
                <span>Conversion Rate</span>
                <strong>1 ETH = 1.000 GLP</strong>
              </div>
              <div className="breakdown-item">
                <span>{activeTab === 'deposit' ? 'You Receive (Est.)' : 'ETH Received (Est.)'}</span>
                <strong style={{ color: 'var(--gold-primary)' }}>
                  {amount && Number(amount) > 0 ? Number(amount).toFixed(4) : '0.0000'}{' '}
                  {activeTab === 'deposit' ? 'GLP' : 'ETH'}
                </strong>
              </div>
              <div className="breakdown-item">
                <span>Protocol Fee</span>
                <strong style={{ color: 'var(--success)' }}>0.00% (Zero Protocol Fee)</strong>
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

            {/* Submit Button */}
            <button 
              type="submit" 
              className="btn btn-gold btn-lg" 
              style={{ width: '100%', marginTop: '24px' }}
              disabled={loading || !amount || Number(amount) <= 0}
            >
              {loading ? (
                <span>Processing On-Chain...</span>
              ) : activeTab === 'deposit' ? (
                <span>Confirm ETH Deposit</span>
              ) : (
                <span>Confirm GLP Withdrawal</span>
              )}
            </button>
          </form>
        </div>

        {/* Info Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="lend-info-card">
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <HiLightningBolt style={{ color: 'var(--gold-primary)' }} />
              Pool Liquidity Status
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '10px', borderBottom: '1px solid var(--border-primary)' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Available ETH Pool Reserve</span>
                <strong style={{ color: 'var(--success)' }}>{poolLiquidity} ETH</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '10px', borderBottom: '1px solid var(--border-primary)' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Your Staked GLP Balance</span>
                <strong style={{ color: 'var(--gold-primary)' }}>{glpBalance} GLP</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Interest Accrual</span>
                <strong style={{ color: 'var(--text-primary)' }}>5.0% Fixed on Loans</strong>
              </div>
            </div>
          </div>

          <div className="lend-info-card">
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <HiShieldCheck style={{ color: 'var(--gold-primary)' }} />
              How GLP Liquidity Works
            </h3>

            <ul style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              <li style={{ display: 'flex', gap: '10px' }}>
                <span style={{ color: 'var(--gold-primary)', fontWeight: 'bold' }}>1.</span>
                <span>Depositing ETH automatically mints GLP ERC-20 proof-of-deposit tokens to your address.</span>
              </li>
              <li style={{ display: 'flex', gap: '10px' }}>
                <span style={{ color: 'var(--gold-primary)', fontWeight: 'bold' }}>2.</span>
                <span>Having a GLP deposit activates your borrower status, qualifying you for micro-loans.</span>
              </li>
              <li style={{ display: 'flex', gap: '10px' }}>
                <span style={{ color: 'var(--gold-primary)', fontWeight: 'bold' }}>3.</span>
                <span>You can redeem GLP back into ETH at any time, subject to pool liquidity availability.</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LendPage;
