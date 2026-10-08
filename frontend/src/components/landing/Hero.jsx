import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import './Hero.css';

const Hero = ({ wallet }) => {
  const navigate = useNavigate();
  const { account, connectWallet } = wallet;

  return (
    <section className="hero" id="hero">
      {/* Background elements */}
      <div className="hero-bg">
        <div className="hero-gradient-orb hero-orb-1"></div>
        <div className="hero-gradient-orb hero-orb-2"></div>
        <div className="hero-grid-pattern"></div>
      </div>

      <div className="container hero-container">
        <motion.div
          className="hero-content"
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
        >
          <span className="section-label">DECENTRALIZED LENDING</span>
          <h1 className="hero-title">
            Powering Transparent{' '}
            <span className="hero-highlight">
              Decentralized
              <svg className="hero-highlight-ring" viewBox="0 0 320 80" fill="none" xmlns="http://www.w3.org/2000/svg">
                <ellipse cx="160" cy="40" rx="155" ry="35" stroke="#f0b90b" strokeWidth="2" strokeDasharray="6 4" opacity="0.5"/>
              </svg>
            </span>{' '}
            Lending
          </h1>
          <p className="hero-description">
            Borrow, lend and track digital assets through a transparent blockchain-powered lending ecosystem. Every transaction is recorded on-chain.
          </p>
          <div className="hero-buttons">
            <button className="btn btn-gold btn-lg" onClick={() => navigate('/app')}>
              Explore GigLend
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
            {!account && (
              <button className="btn btn-outline btn-lg" onClick={connectWallet}>
                Connect Wallet
              </button>
            )}
          </div>
          <div className="hero-stats">
            <div className="hero-stat">
              <span className="hero-stat-value">24/7</span>
              <span className="hero-stat-label">Transparent Lending</span>
            </div>
            <div className="hero-stat-divider"></div>
            <div className="hero-stat">
              <span className="hero-stat-value">5%</span>
              <span className="hero-stat-label">Flat Interest Rate</span>
            </div>
            <div className="hero-stat-divider"></div>
            <div className="hero-stat">
              <span className="hero-stat-value">On-Chain</span>
              <span className="hero-stat-label">Transaction Records</span>
            </div>
          </div>
        </motion.div>

        <motion.div
          className="hero-visual"
          initial={{ opacity: 0, x: 60 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          <div className="hero-artwork">
            {/* Main card */}
            <div className="hero-wallet-card">
              <div className="hero-wallet-header">
                <div className="hero-wallet-logo">
                  <svg viewBox="0 0 32 32" width="24" height="24" fill="none">
                    <circle cx="16" cy="16" r="14" stroke="#f0b90b" strokeWidth="2"/>
                    <path d="M10 16 L16 10 L22 16 L16 22 Z" fill="#f0b90b"/>
                  </svg>
                  <span>GigLend Wallet</span>
                </div>
                <span className="badge badge-success">Connected</span>
              </div>
              <div className="hero-wallet-balance">
                <span className="hero-wallet-balance-label">Illustrative Balance</span>
                <span className="hero-wallet-balance-value">2.840 <small>ETH</small></span>
              </div>
              <div className="hero-wallet-grid">
                <div className="hero-wallet-stat">
                  <span className="label">Supplied</span>
                  <span className="value text-success">1.200 ETH</span>
                </div>
                <div className="hero-wallet-stat">
                  <span className="label">Borrowed</span>
                  <span className="value text-gold">0.450 ETH</span>
                </div>
                <div className="hero-wallet-stat">
                  <span className="label">Available</span>
                  <span className="value">1.190 ETH</span>
                </div>
                <div className="hero-wallet-stat">
                  <span className="label">Credit Score</span>
                  <span className="value text-gold">70/100</span>
                </div>
              </div>
            </div>

            {/* Floating badges */}
            <div className="hero-float-badge hero-float-1 animate-float">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f0b90b" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              SECURED
            </div>
            <div className="hero-float-badge hero-float-2 animate-float-slow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00c087" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
              ON-CHAIN
            </div>

            {/* Decorative elements */}
            <div className="hero-coin hero-coin-1 animate-float">
              <svg viewBox="0 0 48 48" width="48" height="48">
                <circle cx="24" cy="24" r="22" fill="#1a1500" stroke="#f0b90b" strokeWidth="2"/>
                <text x="24" y="28" textAnchor="middle" fill="#f0b90b" fontSize="16" fontWeight="bold" fontFamily="Outfit">G</text>
              </svg>
            </div>
            <div className="hero-coin hero-coin-2 animate-float-slow">
              <svg viewBox="0 0 36 36" width="36" height="36">
                <circle cx="18" cy="18" r="16" fill="none" stroke="#f0b90b" strokeWidth="1.5" opacity="0.4"/>
                <circle cx="18" cy="18" r="10" fill="#f0b90b" opacity="0.15"/>
              </svg>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default Hero;
