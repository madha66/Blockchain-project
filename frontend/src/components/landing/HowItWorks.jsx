import React from 'react';
import { motion } from 'framer-motion';
import { HiWifi, HiSwitchVertical, HiSearch, HiCheckCircle } from 'react-icons/hi';

const steps = [
  {
    num: '01',
    icon: <HiWifi size={28} />,
    title: 'Connect Wallet',
    description: 'Connect your Web3 wallet (MetaMask) to access the GigLend ecosystem and interact with the smart contracts.',
  },
  {
    num: '02',
    icon: <HiSwitchVertical size={28} />,
    title: 'Supply or Borrow',
    description: 'Deposit ETH to receive GLP tokens and earn pool shares, or borrow according to your credit score and available liquidity.',
  },
  {
    num: '03',
    icon: <HiSearch size={28} />,
    title: 'Track Your Loan',
    description: 'Monitor your active borrowing position, credit score, repayment amount, and GLP token balance in real time.',
  },
  {
    num: '04',
    icon: <HiCheckCircle size={28} />,
    title: 'Repay & Complete',
    description: 'Repay the principal plus 5% flat interest to complete the lending cycle. Your credit score improves with each repayment.',
  },
];

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.15 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

const HowItWorks = () => {
  return (
    <section className="section how-section" id="how-it-works">
      <div className="container section-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5 }}
        >
          <span className="section-label">HOW IT WORKS</span>
          <h2 className="section-title">Simple Lending. Transparent Transactions.</h2>
          <p className="section-subtitle" style={{ marginLeft: 'auto', marginRight: 'auto', marginBottom: '48px' }}>
            GigLend simplifies decentralized lending into four straightforward steps, all powered by smart contracts on Ethereum.
          </p>
        </motion.div>

        <motion.div
          className="steps-grid"
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
        >
          {steps.map((step, i) => (
            <motion.div key={i} className="step-card" variants={itemVariants}>
              <div className="step-number">{step.num}</div>
              <div className="step-icon">{step.icon}</div>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

export default HowItWorks;
