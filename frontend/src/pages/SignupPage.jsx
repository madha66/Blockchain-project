import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HiCheckCircle, HiPlus, HiTrash } from 'react-icons/hi';
import { useAuth } from '../context/AuthContext';
import { api, describeError, deviceFingerprint } from '../utils/api';
import { signSiwe } from '../utils/siwe';
import { formatInr } from '../utils/inr';
import '../components/auth/auth.css';

const STEPS = ['Account', 'Link wallet', 'Verify identity', 'Gig & income', 'Consent'];

const ProgressBar = ({ step }) => (
  <div className="wizard-progress" aria-label={`Step ${Math.min(step, 5)} of 5`}>
    {STEPS.map((label, i) => {
      const n = i + 1;
      const state = n < step ? 'done' : n === step ? 'current' : 'todo';
      return (
        <div key={label} className={`wizard-step wizard-step-${state}`}>
          <span className="wizard-dot">{state === 'done' ? <HiCheckCircle size={18} /> : n}</span>
          <span className="wizard-label">{label}</span>
        </div>
      );
    })}
    <div className="wizard-bar">
      <div className="wizard-bar-fill" style={{ width: `${(Math.min(step - 1, 5) / 5) * 100}%` }} />
    </div>
  </div>
);

const ErrorNote = ({ error }) => (error ? <div className="auth-error" role="alert">{error}</div> : null);

// ── Step 1: account + OTP ──────────────────────────────────────────────────
const AccountStep = ({ onDone, awaitingOtp }) => {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [otp, setOtp] = useState('');
  const [sent, setSent] = useState(awaitingOtp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const createAccount = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/signup/account', {
        method: 'POST',
        body: form,
        headers: { 'x-device-fingerprint': await deviceFingerprint() },
      });
      setSent(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/signup/otp/verify', { method: 'POST', body: { code: otp } });
      await onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <form onSubmit={verify} className="auth-form">
        <p className="auth-hint">
          We sent a 6-digit code. In this prototype it is printed in the backend console (mock OTP), valid for 5 minutes.
        </p>
        <div className="form-group">
          <label className="form-label" htmlFor="otp">Verification code</label>
          <input id="otp" className="form-input" inputMode="numeric" maxLength={6} value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required />
        </div>
        <ErrorNote error={error} />
        <div className="auth-row">
          <button className="btn btn-gold" disabled={busy || otp.length !== 6}>Verify</button>
          <button type="button" className="btn btn-ghost" disabled={busy}
            onClick={() => api('/signup/otp/resend', { method: 'POST' }).catch((err) => setError(describeError(err)))}>
            Resend code
          </button>
        </div>
      </form>
    );
  }

  const field = (key, label, type = 'text', extra = {}) => (
    <div className="form-group">
      <label className="form-label" htmlFor={key}>{label}</label>
      <input id={key} type={type} className="form-input" value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })} required {...extra} />
    </div>
  );

  return (
    <form onSubmit={createAccount} className="auth-form">
      {field('name', 'Full name', 'text', { autoComplete: 'name' })}
      {field('email', 'Email', 'email', { autoComplete: 'email' })}
      {field('phone', 'Mobile number', 'tel', { autoComplete: 'tel', placeholder: '9876543210' })}
      {field('password', 'Password (8+ characters)', 'password', { minLength: 8, autoComplete: 'new-password' })}
      <ErrorNote error={error} />
      <button className="btn btn-gold w-full" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
    </form>
  );
};

// ── Step 2: link wallet (SIWE) ────────────────────────────────────────────
const WalletStep = ({ wallet, onDone }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const link = async () => {
    setBusy(true);
    setError('');
    try {
      if (!wallet.signer) {
        await wallet.connectWallet();
        return;
      }
      const signed = await signSiwe(wallet.signer, 'Link this wallet to my GigLend account.');
      await api('/signup/wallet', { method: 'POST', body: signed });
      await onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-form">
      <p className="auth-hint">
        Sign a message with MetaMask to prove you own the wallet. One wallet links to one account, and it cannot
        change while a loan is open.
      </p>
      {wallet.account && (
        <div className="auth-wallet-pill">{wallet.account.slice(0, 8)}…{wallet.account.slice(-6)}</div>
      )}
      <ErrorNote error={error} />
      <button className="btn btn-gold w-full" onClick={link} disabled={busy}>
        {!wallet.account ? 'Connect MetaMask' : busy ? 'Waiting for signature…' : 'Sign and link wallet'}
      </button>
    </div>
  );
};

// ── Step 3: mock KYC ───────────────────────────────────────────────────────
const KycStep = ({ onDone }) => {
  const [pan, setPan] = useState('');
  const [aadhaarRef, setAadhaarRef] = useState('');
  const [selfie, setSelfie] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inherited, setInherited] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('pan', pan);
      form.append('aadhaarRef', aadhaarRef);
      if (selfie) form.append('selfie', selfie);
      const res = await api('/signup/kyc', { method: 'POST', form });
      if (res.inherited) {
        setInherited(true);
        setTimeout(onDone, 1800);
      } else {
        await onDone();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="auth-form">
      <p className="auth-hint">
        Mock KYC for the testnet prototype. Only a salted hash of your PAN goes on-chain, never the number.
        Enter just the last 4 digits of Aadhaar; we never store a full Aadhaar.
      </p>
      <div className="form-group">
        <label className="form-label" htmlFor="pan">PAN (format AAAAA9999A)</label>
        <input id="pan" className="form-input" value={pan} maxLength={10}
          onChange={(e) => setPan(e.target.value.toUpperCase())} pattern="[A-Za-z]{5}[0-9]{4}[A-Za-z]" required />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="aadhaar">Aadhaar last 4 digits</label>
        <input id="aadhaar" className="form-input" inputMode="numeric" maxLength={4} value={aadhaarRef}
          onChange={(e) => setAadhaarRef(e.target.value.replace(/\D/g, ''))} required />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="selfie">Selfie (stored encrypted)</label>
        <input id="selfie" type="file" accept="image/*" capture="user" className="form-input"
          onChange={(e) => setSelfie(e.target.files?.[0] || null)} required />
      </div>
      {inherited && (
        <div className="auth-success">
          This identity already has a GigLend record. Your new wallet joins it and keeps its full history.
        </div>
      )}
      <ErrorNote error={error} />
      <button className="btn btn-gold w-full" disabled={busy}>{busy ? 'Verifying…' : 'Verify identity'}</button>
    </form>
  );
};

// ── Step 4: gig & income profile ───────────────────────────────────────────
const IncomeStep = ({ onDone }) => {
  const [form, setForm] = useState({ platform: 'Swiggy', workerId: '', monthsActive: 12, payoutFrequency: 'weekly' });
  const [payouts, setPayouts] = useState(['', '', '']);
  const [debts, setDebts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api('/signup/income', {
        method: 'POST',
        body: {
          ...form,
          monthsActive: Number(form.monthsActive),
          monthlyPayouts: payouts.map(Number),
          declaredDebts: debts.filter((d) => d.lender).map((d) => ({ lender: d.lender, emiInr: Number(d.emiInr || 0) })),
        },
      });
      setResult(res);
      setTimeout(onDone, 1500);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="auth-form">
      <div className="auth-grid-2">
        <div className="form-group">
          <label className="form-label" htmlFor="platform">Platform</label>
          <select id="platform" className="form-input" value={form.platform}
            onChange={(e) => setForm({ ...form, platform: e.target.value })}>
            {['Swiggy', 'Zomato', 'Uber', 'Ola', 'Rapido', 'Urban Company', 'Zepto', 'Other'].map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="workerId">Worker ID</label>
          <input id="workerId" className="form-input" value={form.workerId}
            onChange={(e) => setForm({ ...form, workerId: e.target.value })} required />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="months">Months active</label>
          <input id="months" type="number" min={0} className="form-input" value={form.monthsActive}
            onChange={(e) => setForm({ ...form, monthsActive: e.target.value })} required />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="freq">Payout frequency</label>
          <select id="freq" className="form-input" value={form.payoutFrequency}
            onChange={(e) => setForm({ ...form, payoutFrequency: e.target.value })}>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
          </select>
        </div>
      </div>

      <div className="form-group">
        <span className="form-label">Monthly payouts, last 3–6 months (₹, mock data)</span>
        <div className="auth-chip-inputs">
          {payouts.map((v, i) => (
            <input key={i} className="form-input" type="number" min={0} aria-label={`Month ${i + 1} payout`} value={v}
              onChange={(e) => setPayouts(payouts.map((p, j) => (j === i ? e.target.value : p)))} required />
          ))}
        </div>
        <div className="auth-row">
          {payouts.length < 6 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPayouts([...payouts, ''])}>
              <HiPlus /> Add month
            </button>
          )}
          {payouts.length > 3 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPayouts(payouts.slice(0, -1))}>
              <HiTrash /> Remove month
            </button>
          )}
        </div>
      </div>

      <div className="form-group">
        <span className="form-label">Existing loans and EMIs (declare all of them)</span>
        {debts.map((d, i) => (
          <div key={i} className="auth-grid-2 auth-debt-row">
            <input className="form-input" placeholder="Lender" aria-label="Lender" value={d.lender}
              onChange={(e) => setDebts(debts.map((x, j) => (j === i ? { ...x, lender: e.target.value } : x)))} />
            <div className="auth-row">
              <input className="form-input" type="number" min={0} placeholder="EMI ₹/month" aria-label="Monthly EMI"
                value={d.emiInr}
                onChange={(e) => setDebts(debts.map((x, j) => (j === i ? { ...x, emiInr: e.target.value } : x)))} />
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove debt"
                onClick={() => setDebts(debts.filter((_, j) => j !== i))}><HiTrash /></button>
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDebts([...debts, { lender: '', emiInr: '' }])}>
          <HiPlus /> Add a loan/EMI
        </button>
        <p className="auth-hint">A debt found to be undeclared lowers your score and limit.</p>
      </div>

      {result && (
        <div className="auth-success">
          Assessed income {formatInr(result.assessedMonthlyInr)}/month · stability: {result.stabilityBand}
          {result.declaredDebtInr > 0 && <> · declared EMIs {formatInr(result.declaredDebtInr)}/month</>}
        </div>
      )}
      <ErrorNote error={error} />
      <button className="btn btn-gold w-full" disabled={busy}>{busy ? 'Saving…' : 'Save income profile'}</button>
    </form>
  );
};

// ── Step 5: consent ────────────────────────────────────────────────────────
const ConsentStep = ({ onDone }) => {
  const [consent, setConsent] = useState({ dataUse: false, autopay: true, peerVisibility: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api('/signup/consent', { method: 'POST', body: consent });
      await onDone(res.attestation);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const box = (key, title, text, required = false) => (
    <label className="auth-consent">
      <input type="checkbox" checked={consent[key]} onChange={(e) => setConsent({ ...consent, [key]: e.target.checked })}
        required={required} />
      <span>
        <strong>{title}{required && ' (required)'}</strong>
        <span className="auth-hint">{text}</span>
      </span>
    </label>
  );

  return (
    <form onSubmit={submit} className="auth-form">
      {box('dataUse', 'Use of my data',
        'GigLend may use my verification and mock payout data to assess loans. Only hashes, tiers and flags go on-chain.', true)}
      {box('autopay', 'Autopay (SafeRepay and income sweep)',
        'On by default. A share of each payout and my SafeRepay balance pay installments automatically. I can opt out any time.')}
      {box('peerVisibility', 'Lending-circle visibility (optional)',
        'Members of a lending circle I join may see my repayment status. Nobody outside the circle ever will.')}
      <p className="auth-hint">Each choice is saved with a timestamp. You can change it later on your profile.</p>
      <ErrorNote error={error} />
      <button className="btn btn-gold w-full" disabled={busy || !consent.dataUse}>{busy ? 'Saving…' : 'Finish verification'}</button>
    </form>
  );
};

// ── Final: register attestation on-chain ──────────────────────────────────
export const RegisterOnChain = ({ wallet, contracts, attestation, onRegistered }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(attestation);

  const register = async () => {
    setBusy(true);
    setError('');
    try {
      const signed = current || (await api('/profile/attestation', { method: 'POST' }));
      setCurrent(signed);
      const registry = contracts.identityRegistry;
      if (!registry) throw new Error('IdentityRegistry is not deployed. Run scripts/deploy.js.');
      const tx = await registry.register(signed.attestation, signed.signature);
      await tx.wait();
      onRegistered?.();
    } catch (err) {
      setCurrent(null); // a used or expired attestation is replaced on retry
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-form">
      <p className="auth-hint">
        GigLend has signed an attestation of your verified identity hash, income tier, declared debts, payout period,
        cluster and cohort. Submit it to the IdentityRegistry contract from your linked wallet.
      </p>
      <ErrorNote error={error} />
      <button className="btn btn-gold w-full" onClick={register} disabled={busy || !wallet.signer}>
        {busy ? 'Registering…' : 'Register on-chain'}
      </button>
    </div>
  );
};

const SignupPage = ({ wallet, contracts }) => {
  const { user, scope, refresh } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [attestation, setAttestation] = useState(null);
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    if (user && (scope === 'signup' || scope === 'full')) setStep(user.signupStep);
  }, [user, scope]);

  const advance = async (att) => {
    if (att) setAttestation(att);
    const me = await refresh();
    if (me?.user) setStep(me.user.signupStep);
  };

  const titles = {
    1: 'Create your account',
    2: 'Link your wallet',
    3: 'Verify your identity',
    4: 'Your gig work and income',
    5: 'Your consent',
    6: registered ? 'You are all set' : 'Register on-chain',
  };

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <Link to="/" className="auth-brand">GigLend</Link>
        <h1 className="auth-title">{titles[step]}</h1>
        <ProgressBar step={step} />
        {step === 1 && <AccountStep onDone={advance} awaitingOtp={Boolean(user && !user.contactVerified)} />}
        {step === 2 && <WalletStep wallet={wallet} onDone={advance} />}
        {step === 3 && <KycStep onDone={advance} />}
        {step === 4 && <IncomeStep onDone={advance} />}
        {step === 5 && <ConsentStep onDone={advance} />}
        {step === 6 && !registered && (
          <RegisterOnChain wallet={wallet} contracts={contracts} attestation={attestation}
            onRegistered={() => setRegistered(true)} />
        )}
        {step === 6 && registered && (
          <div className="auth-form">
            <div className="auth-success">Registered. Your first loan will be a credit-builder loan.</div>
            <button className="btn btn-gold w-full" onClick={() => navigate('/app/dashboard')}>Go to dashboard</button>
          </div>
        )}
        {step === 1 && (
          <p className="auth-footer">Already have an account? <Link to="/login">Log in</Link></p>
        )}
      </div>
    </div>
  );
};

export default SignupPage;
