import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { QRCodeSVG } from 'qrcode.react';
import { 
  HiDuplicate, 
  HiCheck, 
  HiRefresh, 
  HiGlobeAlt, 
  HiShieldCheck,
  HiTrendingUp,
  HiTrendingDown
} from 'react-icons/hi';
import { CONTRACT_ADDRESSES } from '../../utils/contractHelpers';
import './WalletPage.css';

const WalletPage = ({ wallet, contracts }) => {
  const { account, provider } = wallet;
  const { lendingPool, glpToken } = contracts;

  const [copied, setCopied] = useState(false);
  const [copiedContract, setCopiedContract] = useState(null);
  const [loading, setLoading] = useState(false);
  const [ethBalance, setEthBalance] = useState('0.0000');
  const [glpBalance, setGlpBalance] = useState('0.0000');
  const [activeLoan, setActiveLoan] = useState('0.0000');
  const [networkInfo, setNetworkInfo] = useState({ name: 'Ethereum / Localhost', chainId: '31337' });

  const fetchWalletDetails = useCallback(async () => {
    if (!account || !provider) return;
    try {
      setLoading(true);

      // ETH Balance
      const bal = await provider.getBalance(account);
      setEthBalance(Number(ethers.formatEther(bal)).toFixed(4));

      // GLP Balance
      if (glpToken) {
        const glp = await glpToken.balanceOf(account);
        setGlpBalance(Number(ethers.formatEther(glp)).toFixed(4));
      }

      // Active Debt
      if (lendingPool) {
        const debt = await lendingPool.getRepaymentAmount(account);
        setActiveLoan(Number(ethers.formatEther(debt)).toFixed(4));
      }

      // Network
      const net = await provider.getNetwork();
      setNetworkInfo({
        name: net.name === 'unknown' ? 'Local Hardhat (Chain 31337)' : net.name,
        chainId: net.chainId.toString()
      });
    } catch (e) {
      console.error('Error fetching wallet data:', e);
    } finally {
      setLoading(false);
    }
  }, [account, provider, glpToken, lendingPool]);

  useEffect(() => {
    fetchWalletDetails();
  }, [fetchWalletDetails]);

  const handleCopy = (text, type = 'account') => {
    navigator.clipboard.writeText(text);
    if (type === 'account') {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopiedContract(type);
      setTimeout(() => setCopiedContract(null), 2000);
    }
  };

  const netEquity = (Number(glpBalance) - Number(activeLoan)).toFixed(4);

  return (
    <div className="wallet-container">
      {/* Header */}
      <div className="wallet-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
            Wallet & Assets
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '4px' }}>
            Inspect on-chain balances, public keys, smart contract registries, and network telemetry.
          </p>
        </div>

        <button 
          className="btn btn-outline btn-sm" 
          onClick={fetchWalletDetails}
          disabled={loading}
        >
          <HiRefresh className={loading ? 'spinning' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="wallet-grid">
        {/* Left Column: QR & Public Key */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="wallet-card-main">
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem' }}>
              Connected Public Key
            </h3>

            {/* QR Code */}
            <div className="qr-wrapper">
              <QRCodeSVG 
                value={account || ''} 
                size={180}
                bgColor="#ffffff"
                fgColor="#0a0a0a"
                level="M"
              />
            </div>

            {/* Address & Copy */}
            <div className="address-pill">
              <span>{account ? `${account.slice(0, 10)}...${account.slice(-8)}` : 'Not Connected'}</span>
              <button 
                className="copy-btn" 
                onClick={() => handleCopy(account)}
                title="Copy full public address"
              >
                {copied ? <HiCheck size={18} style={{ color: 'var(--success)' }} /> : <HiDuplicate size={18} />}
              </button>
            </div>

            {/* Network pill */}
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '8px', 
              fontSize: '0.85rem', 
              color: 'var(--text-secondary)' 
            }}>
              <HiGlobeAlt style={{ color: 'var(--gold-primary)' }} />
              <span>Network: <strong>{networkInfo.name}</strong></span>
              <span className="badge badge-gold" style={{ padding: '2px 8px', fontSize: '0.75rem' }}>
                ID {networkInfo.chainId}
              </span>
            </div>
          </div>

          {/* Smart Contracts Registry */}
          <div className="contract-addresses-box">
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <HiShieldCheck style={{ color: 'var(--gold-primary)' }} />
              Protocol Contracts
            </h3>

            {Object.entries(CONTRACT_ADDRESSES).map(([name, addr]) => (
              <div key={name} className="contract-row">
                <div>
                  <div className="contract-name">{name}</div>
                  <div className="contract-val">{addr.slice(0, 10)}...{addr.slice(-6)}</div>
                </div>
                <button 
                  className="copy-btn" 
                  onClick={() => handleCopy(addr, name)}
                  title={`Copy ${name} address`}
                >
                  {copiedContract === name ? <HiCheck size={16} style={{ color: 'var(--success)' }} /> : <HiDuplicate size={16} />}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Right Column: Asset Breakdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="wallet-assets-list">
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem' }}>
              Your Holdings
            </h3>

            {/* Native ETH */}
            <div className="asset-item">
              <div className="asset-left">
                <div className="asset-icon-box">
                  <svg viewBox="0 0 32 32" width="22" height="22" fill="none">
                    <circle cx="16" cy="16" r="14" stroke="#f0b90b" strokeWidth="2" fill="none"/>
                    <path d="M10 16 L16 10 L22 16 L16 22 Z" fill="#f0b90b"/>
                  </svg>
                </div>
                <div>
                  <div className="asset-name">Ethereum</div>
                  <div className="asset-symbol">ETH (Native Gas & Base Asset)</div>
                </div>
              </div>
              <div className="asset-right">
                <div className="asset-amount">{ethBalance} ETH</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Liquid Wallet Balance</div>
              </div>
            </div>

            {/* Staked GLP */}
            <div className="asset-item">
              <div className="asset-left">
                <div className="asset-icon-box" style={{ background: 'rgba(0, 192, 135, 0.1)', color: 'var(--success)' }}>
                  <HiTrendingUp size={22} />
                </div>
                <div>
                  <div className="asset-name">GigLend Pool Token</div>
                  <div className="asset-symbol">GLP (ERC-20 Staked Liquidity)</div>
                </div>
              </div>
              <div className="asset-right">
                <div className="asset-amount" style={{ color: 'var(--gold-primary)' }}>{glpBalance} GLP</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Mints 1:1 with ETH deposits</div>
              </div>
            </div>

            {/* Active Debt Liability */}
            <div className="asset-item">
              <div className="asset-left">
                <div className="asset-icon-box" style={{ background: 'rgba(255, 77, 106, 0.1)', color: 'var(--danger)' }}>
                  <HiTrendingDown size={22} />
                </div>
                <div>
                  <div className="asset-name">Outstanding Loan Liability</div>
                  <div className="asset-symbol">Repayment Obligation (5% Interest)</div>
                </div>
              </div>
              <div className="asset-right">
                <div className="asset-amount" style={{ color: Number(activeLoan) > 0 ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                  {activeLoan} ETH
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                  {Number(activeLoan) > 0 ? 'Principal + Interest Due' : 'Zero Active Debt'}
                </div>
              </div>
            </div>

            {/* Net Protocol Equity */}
            <div style={{ 
              marginTop: '12px',
              padding: '16px',
              background: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-gold)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Net Protocol Position</span>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--gold-primary)' }}>
                  {netEquity} ETH
                </div>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', textAlign: 'right' }}>
                (GLP Balance minus Active Loans)
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WalletPage;
