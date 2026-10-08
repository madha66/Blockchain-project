import React from 'react';
import { Link } from 'react-router-dom';
import { HiExternalLink } from 'react-icons/hi';
import './Footer.css';

const Footer = () => {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <Link to="/" className="footer-logo">
              <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
                <circle cx="16" cy="16" r="14" stroke="#f0b90b" strokeWidth="2" fill="none"/>
                <path d="M10 16 L16 10 L22 16 L16 22 Z" fill="#f0b90b"/>
              </svg>
              <span>GigLend</span>
            </Link>
            <p className="footer-tagline">Decentralized Lending. Transparent by Design.</p>
            <p className="footer-description">
              A blockchain-powered micro-lending protocol built as an academic research prototype.
            </p>
          </div>

          <div className="footer-column">
            <h4>Platform</h4>
            <ul>
              <li><a href="#hero">Home</a></li>
              <li><Link to="/app/lend">Lend</Link></li>
              <li><Link to="/app/borrow">Borrow</Link></li>
              <li><Link to="/app/pool">Lend Pool</Link></li>
              <li><Link to="/app/wallet">Wallet</Link></li>
            </ul>
          </div>

          <div className="footer-column">
            <h4>Resources</h4>
            <ul>
              <li><a href="#how-it-works">How It Works</a></li>
              <li><Link to="/app/transactions">Transactions</Link></li>
              <li><a href="#faq">FAQ</a></li>
              <li><a href="https://github.com" target="_blank" rel="noopener noreferrer">GitHub <HiExternalLink size={12} /></a></li>
            </ul>
          </div>

          <div className="footer-column">
            <h4>Project</h4>
            <ul>
              <li><a href="#features">About GigLend</a></li>
              <li><a href="#lend-pool">Research</a></li>
              <li><a href="#faq">Contact</a></li>
            </ul>
          </div>
        </div>

        <div className="footer-bottom">
          <p>&copy; {new Date().getFullYear()} GigLend. All rights reserved.</p>
          <div className="footer-bottom-links">
            <span>Privacy Policy</span>
            <span>Terms & Conditions</span>
            <span className="badge badge-gold">Academic Prototype</span>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
