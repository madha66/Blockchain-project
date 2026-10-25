import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HiBadgeCheck, HiExclamationCircle, HiUserCircle } from 'react-icons/hi';
import { useAuth } from '../../context/AuthContext';
import { useMembership, TIER_NAMES } from '../../hooks/useMembership';
import { api, describeError } from '../../utils/api';
import { ethWithInr, formatInr } from '../../utils/inr';
import { RegisterOnChain } from '../SignupPage';
import '../../components/auth/auth.css';

const CONSENT_LABELS = {
  data_use: 'Use of my data for loan assessment',
  autopay: 'Autopay (SafeRepay and income sweep)',
  peer_visibility: 'Lending-circle peer visibility',
};

const Row = ({ label, children }) => (
  <div className="profile-row">
    <span className="profile-label">{label}</span>
    <span className="profile-value">{children}</span>
  </div>
);

const ProfilePage = ({ wallet, contracts }) => {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [tick, setTick] = useState(0);
  const membership = useMembership(contracts.identityRegistry, wallet.account, tick);
  const [score, setScore] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!contracts.creditScore || membership.memberId === 0n) return;
      try {
        setScore(Number(await contracts.creditScore.getScore(membership.memberId)));
      } catch {
        setScore(null);
      }
    };
    load();
  }, [contracts.creditScore, membership.memberId]);

  if (!user) return null;

  const toggleConsent = async (kind, granted) => {
    setError('');
    try {
      await api('/profile/consent', { method: 'POST', body: { kind, granted } });
      await refresh();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const unlink = async () => {
    if (!window.confirm('Unlink this wallet? You can link a new wallet to the same identity afterwards.')) return;
    setBusy(true);
    setError('');
    try {
      await api('/profile/unlink-wallet', { method: 'POST' });
      if (membership.memberId !== 0n && contracts.identityRegistry) {
        const tx = await contracts.identityRegistry.unlinkWallet();
        await tx.wait();
      }
      await refresh();
      navigate('/signup');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const m = membership.member;

  return (
    <div className="profile-page">
      <div className="profile-header">
        <HiUserCircle size={56} className="text-gold" />
        <div>
          <h1>{user.name}</h1>
          <p className="text-secondary">{user.email} · {user.phone}</p>
        </div>
      </div>

      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="profile-grid">
        <section className="dark-card profile-card">
          <h2>Verification</h2>
          <Row label="Contact verified">{user.contactVerified ? <span className="text-success">Yes</span> : 'No'}</Row>
          <Row label="Linked wallet">{user.wallet ? `${user.wallet.slice(0, 8)}…${user.wallet.slice(-6)}` : 'None'}</Row>
          <Row label="Identity (PAN)">{user.identity?.panMasked || 'Not verified'}</Row>
          <Row label="On-chain member">
            {membership.memberId !== 0n ? (
              <span className="text-success"><HiBadgeCheck /> #{membership.memberId.toString()}</span>
            ) : (
              <span className="text-danger"><HiExclamationCircle /> Not registered</span>
            )}
          </Row>
          <Row label="Borrowing eligibility">
            {membership.eligible ? <span className="text-success">Eligible</span> : membership.reason}
          </Row>
          {membership.memberId === 0n && user.signupStep === 6 && (
            <RegisterOnChain wallet={wallet} contracts={contracts} onRegistered={() => setTick((t) => t + 1)} />
          )}
          {membership.memberId !== 0n && (
            <details className="profile-details">
              <summary>Refresh attestation (updates income, debts and expiry)</summary>
              <RegisterOnChain wallet={wallet} contracts={contracts} onRegistered={() => setTick((t) => t + 1)} />
            </details>
          )}
        </section>

        <section className="dark-card profile-card">
          <h2>Credit standing</h2>
          <Row label="Tier">{m ? TIER_NAMES[Number(m.tier)] : '—'}</Row>
          <Row label="Score (300–900)">{score ?? '—'}</Row>
          <Row label="Completed loans">{m ? m.completedLoans.toString() : '—'}</Row>
          <Row label="Attested income tier">{m ? ethWithInr(m.incomeWei, 3) : '—'}</Row>
          <Row label="Income band">{user.income?.stabilityBand ?? '—'}</Row>
          <Row label="Assessed income">{user.income ? `${formatInr(user.income.assessedMonthlyInr)}/month` : '—'}</Row>
          <Row label="Declared EMIs">{user.income ? `${formatInr(user.income.declaredDebtInr)}/month` : '—'}</Row>
          <Row label="Payout cycle">{user.income?.payoutFrequency ?? '—'}</Row>
          {m && m.coolingOffUntil > 0n && (
            <Row label="Cooling-off until">
              {m.coolingOffUntil > 10n ** 15n ? 'Until the claim is settled' : new Date(Number(m.coolingOffUntil) * 1000).toLocaleString()}
            </Row>
          )}
        </section>

        <section className="dark-card profile-card">
          <h2>Your community contact</h2>
          <p className="profile-contact">{user.identity?.contactName ?? 'Assigned after verification'}</p>
          <p className="auth-hint">
            The same person contacts you about every loan, only between 08:00 and 19:00. We never contact your family,
            friends or employer.
          </p>
        </section>

        <section className="dark-card profile-card">
          <h2>Consent</h2>
          {Object.entries(CONSENT_LABELS).map(([kind, label]) => (
            <label key={kind} className="auth-consent">
              <input type="checkbox" checked={Boolean(user.consents?.[kind])}
                onChange={(e) => toggleConsent(kind, e.target.checked)} />
              <span><strong>{label}</strong></span>
            </label>
          ))}
          <p className="auth-hint">Every change is stored with a timestamp.</p>
        </section>

        <section className="dark-card profile-card">
          <h2>Wallet</h2>
          <p className="auth-hint">
            Moving to a new wallet keeps your history: the identity stays the same. You cannot unlink while a loan is open.
          </p>
          <button className="btn btn-outline" onClick={unlink} disabled={busy || !user.wallet}>
            {busy ? 'Unlinking…' : 'Unlink this wallet'}
          </button>
        </section>
      </div>
    </div>
  );
};

export default ProfilePage;
