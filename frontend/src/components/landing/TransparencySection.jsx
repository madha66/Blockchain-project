import React from 'react';
import { motion } from 'framer-motion';
import { HiClock, HiShieldCheck, HiSearch, HiDatabase } from 'react-icons/hi';

const TransparencySection = () => {
  const chips = [
    { icon: <HiClock size={16} />, label: 'Transaction History' },
    { icon: <HiShieldCheck size={16} />, label: 'Wallet Security' },
    { icon: <HiSearch size={16} />, label: 'Loan Tracking' },
    { icon: <HiDatabase size={16} />, label: 'Asset Records' },
  ];

  return (
    <section className="section transparency-section">
      <div className="container">
        <div className="transparency-grid">
          <motion.div
            className="transparency-visual"
            initial={{ opacity: 0, x: -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
          >
            <div className="transparency-artwork">
              <div className="artwork-blockchain">
                <svg viewBox="0 0 300 300" width="100%" height="100%">
                  {/* Central node */}
                  <circle cx="150" cy="150" r="40" fill="#1a1500" stroke="#f0b90b" strokeWidth="2"/>
                  <text x="150" y="155" textAnchor="middle" fill="#f0b90b" fontSize="14" fontWeight="bold" fontFamily="Outfit">GLP</text>
                  
                  {/* Surrounding nodes */}
                  <circle cx="60" cy="80" r="20" fill="#161616" stroke="#333" strokeWidth="1.5"/>
                  <text x="60" y="84" textAnchor="middle" fill="#aaa" fontSize="8" fontFamily="Inter">DEP</text>
                  
                  <circle cx="240" cy="80" r="20" fill="#161616" stroke="#333" strokeWidth="1.5"/>
                  <text x="240" y="84" textAnchor="middle" fill="#aaa" fontSize="8" fontFamily="Inter">BOR</text>
                  
                  <circle cx="60" cy="220" r="20" fill="#161616" stroke="#333" strokeWidth="1.5"/>
                  <text x="60" y="224" textAnchor="middle" fill="#aaa" fontSize="8" fontFamily="Inter">REP</text>
                  
                  <circle cx="240" cy="220" r="20" fill="#161616" stroke="#333" strokeWidth="1.5"/>
                  <text x="240" y="224" textAnchor="middle" fill="#aaa" fontSize="8" fontFamily="Inter">WDR</text>
                  
                  {/* Connection lines */}
                  <line x1="80" y1="90" x2="115" y2="130" stroke="#f0b90b" strokeWidth="1" opacity="0.3" strokeDasharray="4 3"/>
                  <line x1="220" y1="90" x2="185" y2="130" stroke="#f0b90b" strokeWidth="1" opacity="0.3" strokeDasharray="4 3"/>
                  <line x1="80" y1="210" x2="115" y2="170" stroke="#f0b90b" strokeWidth="1" opacity="0.3" strokeDasharray="4 3"/>
                  <line x1="220" y1="210" x2="185" y2="170" stroke="#f0b90b" strokeWidth="1" opacity="0.3" strokeDasharray="4 3"/>
                </svg>
              </div>
              <div className="artwork-stat-card animate-float-slow">
                <div className="artwork-stat-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00c087" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div>
                  <div className="artwork-stat-title">ON-CHAIN</div>
                  <div className="artwork-stat-text">Every transaction recorded</div>
                </div>
              </div>
            </div>
          </motion.div>

          <motion.div
            className="transparency-content"
            initial={{ opacity: 0, x: 40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <span className="section-label">TRANSACTIONS</span>
            <h2 className="section-title">Every Lending Transaction is Recorded On-Chain</h2>
            <p className="section-subtitle">
              Deposits, withdrawals, borrowing and repayments are all represented through transparent blockchain transactions. Each action emits an on-chain event that can be independently verified.
            </p>
            <div className="transparency-chips">
              {chips.map((chip, i) => (
                <div className="chip" key={i}>
                  <span className="chip-icon">{chip.icon}</span>
                  {chip.label}
                </div>
              ))}
            </div>
            <a href="#" className="btn btn-gold" onClick={(e) => { e.preventDefault(); document.querySelector('#how-it-works')?.scrollIntoView({behavior:'smooth'}); }}>
              Explore Transactions
            </a>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default TransparencySection;
