import React, { useState } from 'react';
import { motion } from 'framer-motion';

const SubscribeSection = () => {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (email) {
      setSubmitted(true);
      setEmail('');
      setTimeout(() => setSubmitted(false), 4000);
    }
  };

  return (
    <section className="section subscribe-section">
      <div className="container section-center">
        <motion.div
          className="subscribe-card"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          <div className="subscribe-bg-orb"></div>
          <span className="section-label">STAY CONNECTED</span>
          <h2 className="section-title">Stay Updated With GigLend</h2>
          <p className="section-subtitle" style={{ marginLeft: 'auto', marginRight: 'auto', marginBottom: '32px' }}>
            Follow the development of our blockchain-powered decentralized lending ecosystem.
          </p>
          
          {submitted ? (
            <div className="subscribe-success">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00c087" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Thank you! Your interest has been noted.</span>
            </div>
          ) : (
            <form className="subscribe-form" onSubmit={handleSubmit}>
              <input
                type="email"
                className="form-input subscribe-input"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                aria-label="Email address"
              />
              <button type="submit" className="btn btn-gold">
                SUBSCRIBE
              </button>
            </form>
          )}
          <p className="subscribe-note">
            <em>Note: This is a frontend-only form for the academic prototype. No emails are stored.</em>
          </p>
        </motion.div>
      </div>
    </section>
  );
};

export default SubscribeSection;
