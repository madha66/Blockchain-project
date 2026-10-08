import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HiMenu, HiX } from 'react-icons/hi';
import './Navbar.css';

const Navbar = ({ wallet }) => {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const { account, connectWallet } = wallet;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  const navLinks = [
    { label: 'Home', href: '#hero' },
    { label: 'About', href: '#features' },
    { label: 'How It Works', href: '#how-it-works' },
    { label: 'Lend Pool', href: '#lend-pool' },
    { label: 'FAQ', href: '#faq' },
  ];

  const scrollToSection = (e, href) => {
    e.preventDefault();
    setMobileOpen(false);
    const el = document.querySelector(href);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const handleLaunch = () => {
    setMobileOpen(false);
    navigate('/app');
  };

  return (
    <nav className={`navbar ${scrolled ? 'navbar-scrolled' : ''}`} role="navigation" aria-label="Main navigation">
      <div className="navbar-container container">
        <Link to="/" className="navbar-logo" aria-label="GigLend Home">
          <div className="logo-icon">
            <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="32">
              <circle cx="16" cy="16" r="14" stroke="#f0b90b" strokeWidth="2" fill="none"/>
              <path d="M10 16 L16 10 L22 16 L16 22 Z" fill="#f0b90b"/>
            </svg>
          </div>
          <span className="logo-text">GigLend</span>
        </Link>

        <ul className="navbar-links hide-mobile">
          {navLinks.map(link => (
            <li key={link.label}>
              <a href={link.href} onClick={(e) => scrollToSection(e, link.href)}>{link.label}</a>
            </li>
          ))}
        </ul>

        <div className="navbar-actions hide-mobile">
          {account ? (
            <button className="btn btn-gold btn-sm" onClick={handleLaunch}>
              Launch App
            </button>
          ) : (
            <button className="btn btn-gold btn-sm" onClick={connectWallet}>
              Connect Wallet
            </button>
          )}
        </div>

        <button
          className="navbar-hamburger"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <HiX size={24} /> : <HiMenu size={24} />}
        </button>
      </div>

      {/* Mobile Menu */}
      <div className={`mobile-menu ${mobileOpen ? 'mobile-menu-open' : ''}`} role="dialog" aria-label="Mobile navigation">
        <div className="mobile-menu-content">
          <ul className="mobile-nav-links">
            {navLinks.map(link => (
              <li key={link.label}>
                <a href={link.href} onClick={(e) => scrollToSection(e, link.href)}>{link.label}</a>
              </li>
            ))}
            <li>
              <a href="#" onClick={(e) => { e.preventDefault(); handleLaunch(); }}>Dashboard</a>
            </li>
          </ul>
          <div className="mobile-menu-actions">
            {account ? (
              <>
                <div className="mobile-wallet-info">
                  <span className="mobile-wallet-dot"></span>
                  {account.slice(0, 6)}...{account.slice(-4)}
                </div>
                <button className="btn btn-gold w-full" onClick={handleLaunch}>
                  Launch App
                </button>
              </>
            ) : (
              <button className="btn btn-gold w-full" onClick={() => { connectWallet(); setMobileOpen(false); }}>
                Connect Wallet
              </button>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
