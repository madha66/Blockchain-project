import React from 'react';
import { motion } from 'framer-motion';
import { HiShieldCheck, HiGlobeAlt, HiLockClosed } from 'react-icons/hi';
import './LandingSections.css';

const features = [
  {
    icon: <HiShieldCheck size={28} />,
    title: 'Transparency',
    description: 'Every supported transaction can be verified through blockchain records. Full visibility into the lending pool and all on-chain activity.',
  },
  {
    icon: <HiGlobeAlt size={28} />,
    title: 'Decentralized',
    description: 'Blockchain technology enables transparent peer-to-pool lending without relying on a traditional centralized ledger or intermediary.',
  },
  {
    icon: <HiLockClosed size={28} />,
    title: 'Secure',
    description: 'Smart contracts provide deterministic transaction logic and transparent execution. All code is open and auditable on-chain.',
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

const FeaturesSection = () => {
  return (
    <section className="section features-section" id="features">
      <div className="container section-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5 }}
        >
          <span className="section-label">WHY GIGLEND</span>
          <h2 className="section-title">
            The Smarter Way to Experience<br />Decentralized Lending
          </h2>
        </motion.div>

        <motion.div
          className="features-grid"
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
        >
          {features.map((feature, i) => (
            <motion.div key={i} className="feature-card" variants={itemVariants}>
              <div className="card-icon">{feature.icon}</div>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </motion.div>
          ))}
        </motion.div>

        <motion.div
          className="features-cta"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.5 }}
        >
          <p>Want to know how GigLend works?</p>
          <a href="#how-it-works" className="features-link">
            Explore the protocol
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
        </motion.div>
      </div>
    </section>
  );
};

export default FeaturesSection;
