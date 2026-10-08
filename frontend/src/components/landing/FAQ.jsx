import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './LandingSections.css';

const faqData = [
  {
    q: 'What is GigLend?',
    a: 'GigLend is a blockchain-based decentralized micro-lending protocol designed as an academic prototype. It enables transparent peer-to-pool lending where borrowing limits are determined by an on-chain credit score algorithm rather than traditional collateral.',
  },
  {
    q: 'How does blockchain support GigLend?',
    a: 'The Ethereum blockchain serves as the permanent, auditable data layer. Smart contracts automatically handle deposits, borrowing, repayment and withdrawals. Every transaction emits an on-chain event that anyone can verify.',
  },
  {
    q: 'How does lending work?',
    a: 'Users deposit ETH into the lending pool and receive GLP (GigLendingPool) tokens in a 1:1 ratio. These GLP tokens represent your share of the pool. The deposited ETH becomes available for borrowers.',
  },
  {
    q: 'How does borrowing work?',
    a: 'To borrow, you must first deposit ETH into the pool. Your credit score (starting at 50/100) determines your borrowing limit. You can borrow up to your limit and must repay the principal plus 5% flat interest.',
  },
  {
    q: 'How are transactions recorded?',
    a: 'All transactions (Deposit, Borrow, Repay, Withdraw) emit Solidity events on the blockchain. These events are immutable and can be independently verified through any block explorer.',
  },
  {
    q: 'What happens when a loan is repaid?',
    a: 'When you repay a loan, the smart contract clears your outstanding balance and the CreditScore contract updates your repayment history. Your credit score increases, unlocking higher borrow limits for future loans.',
  },
  {
    q: 'How does the credit score system work?',
    a: 'The credit score ranges from 0-100. New users start at 50. Each successful repayment adds up to 10 points (max 30 from repayments). Additional points come from total ETH repaid (max 20 points). Higher scores unlock larger borrow limits up to 5 ETH.',
  },
  {
    q: 'How do I connect my wallet?',
    a: 'Install the MetaMask browser extension, then click "Connect Wallet" on GigLend. Approve the connection request in MetaMask. For local development, connect to the Hardhat local node (localhost:8545).',
  },
  {
    q: 'What blockchain network does GigLend use?',
    a: 'GigLend supports both a local Hardhat development node and the Ethereum Sepolia testnet. For production-like testing, deploy to Sepolia using the provided deployment scripts.',
  },
];

const FAQ = () => {
  const [openIndex, setOpenIndex] = useState(null);

  const toggle = (i) => {
    setOpenIndex(openIndex === i ? null : i);
  };

  return (
    <section className="section faq-section" id="faq">
      <div className="container">
        <div className="faq-layout">
          <motion.div
            className="faq-header"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.5 }}
          >
            <span className="section-label">FAQ</span>
            <h2 className="section-title">Frequently Asked<br />Questions</h2>
            <p className="section-subtitle">
              Everything you need to know about the GigLend protocol and how it works.
            </p>
          </motion.div>

          <div className="faq-list">
            {faqData.map((item, i) => (
              <motion.div
                key={i}
                className={`faq-item ${openIndex === i ? 'faq-item-open' : ''}`}
                initial={{ opacity: 0, y: 15 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.3, delay: i * 0.05 }}
              >
                <button
                  className="faq-question"
                  onClick={() => toggle(i)}
                  aria-expanded={openIndex === i}
                  aria-controls={`faq-answer-${i}`}
                >
                  <span>{item.q}</span>
                  <span className="faq-toggle">{openIndex === i ? '−' : '+'}</span>
                </button>
                <AnimatePresence>
                  {openIndex === i && (
                    <motion.div
                      id={`faq-answer-${i}`}
                      className="faq-answer"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      role="region"
                    >
                      <p>{item.a}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default FAQ;
