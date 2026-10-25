import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { HiLockClosed, HiIdentification } from 'react-icons/hi';
import { useAuth } from '../../context/AuthContext';
import { useMembership } from '../../hooks/useMembership';
import './auth.css';

const Gate = ({ icon, title, children }) => (
  <div className="auth-gate">
    <div className="auth-gate-card">
      <div className="auth-gate-icon">{icon}</div>
      <h2>{title}</h2>
      {children}
    </div>
  </div>
);

/**
 * Borrowing routes need a full login, a linked wallet that MetaMask is using, and an
 * on-chain IdentityRegistry registration. Lending routes are not wrapped.
 */
const ProtectedRoute = ({ children, contracts, wallet, requireRegistered = false }) => {
  const { isLoggedIn, loading, user, scope, walletMismatch } = useAuth();
  const location = useLocation();
  const membership = useMembership(contracts?.identityRegistry, wallet?.account);

  if (loading) return <div className="auth-gate-loading">Checking your session…</div>;

  if (!isLoggedIn) {
    return (
      <Gate icon={<HiLockClosed size={40} />} title="Log in to borrow">
        <p>Borrowing needs a verified GigLend account. Lending stays open to everyone.</p>
        <div className="auth-gate-actions">
          <Link className="btn btn-gold" to={`/login?next=${encodeURIComponent(location.pathname)}`}>
            Log in
          </Link>
          <Link className="btn btn-outline" to={scope === 'signup' ? '/signup' : '/signup'}>
            {scope === 'signup' ? 'Resume sign-up' : 'Sign up'}
          </Link>
        </div>
      </Gate>
    );
  }

  if (!user?.wallet || user.signupStep < 6) {
    return (
      <Gate icon={<HiIdentification size={40} />} title="Finish verification">
        <p>Link your wallet and complete verification before borrowing.</p>
        <Link className="btn btn-gold" to="/signup">Continue sign-up</Link>
      </Gate>
    );
  }

  if (walletMismatch) {
    return (
      <Gate icon={<HiLockClosed size={40} />} title="Wrong wallet">
        <p>
          MetaMask is on a different wallet from the one linked to your account
          ({user.wallet.slice(0, 6)}…{user.wallet.slice(-4)}). Switch accounts in MetaMask to continue.
        </p>
      </Gate>
    );
  }

  if (requireRegistered && !membership.loading && membership.memberId === 0n) {
    return (
      <Gate icon={<HiIdentification size={40} />} title="Register on-chain">
        <p>Your verification is done. Submit your signed attestation to the identity registry to start borrowing.</p>
        <Link className="btn btn-gold" to="/app/profile">Go to profile</Link>
      </Gate>
    );
  }

  return children;
};

export default ProtectedRoute;
