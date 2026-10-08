import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';

const LendPoolSection = () => {
  const navigate = useNavigate();

  return (
    <section className="section lendpool-section" id="lend-pool">
      <div className="container section-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5 }}
        >
          <span className="section-label">LEND POOL</span>
          <h2 className="section-title">The Heart of GigLend's Lending Ecosystem</h2>
          <p className="section-subtitle" style={{ marginLeft: 'auto', marginRight: 'auto', marginBottom: '48px' }}>
            Liquidity supplied to the pool enables borrowing while maintaining transparent on-chain accounting. GLP tokens represent your share.
          </p>
        </motion.div>

        <motion.div
          className="lendpool-card"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          <div className="lendpool-card-inner">
            <div className="lendpool-content">
              <h3>Supply. Borrow. Repay.</h3>
              <p>
                The lending pool accepts ETH deposits and mints GLP tokens to represent your liquidity share. Borrowers with sufficient credit scores can access pool funds and repay with a transparent 5% flat interest rate. Every action is recorded as a blockchain event.
              </p>
              <button className="btn btn-gold" onClick={() => navigate('/app/pool')}>
                Explore Lend Pool
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </button>
            </div>
            <div className="lendpool-visual">
              <div className="lendpool-stats-grid">
                <div className="lendpool-stat-item">
                  <span className="lendpool-stat-label">Total Pool</span>
                  <span className="lendpool-stat-value">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f0b90b" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M8 10h8M8 14h8"/></svg>
                    Illustrative
                  </span>
                </div>
                <div className="lendpool-stat-item">
                  <span className="lendpool-stat-label">Available</span>
                  <span className="lendpool-stat-value text-success">Live Data</span>
                </div>
                <div className="lendpool-stat-item">
                  <span className="lendpool-stat-label">Borrowed</span>
                  <span className="lendpool-stat-value text-gold">Live Data</span>
                </div>
                <div className="lendpool-stat-item">
                  <span className="lendpool-stat-label">Interest</span>
                  <span className="lendpool-stat-value">5% Flat</span>
                </div>
              </div>
              <p className="lendpool-disclaimer">Pool values update from blockchain when connected.</p>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default LendPoolSection;
