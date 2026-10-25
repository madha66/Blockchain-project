import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, describeError } from '../utils/api';
import '../components/auth/auth.css';

const LoginPage = ({ wallet }) => {
  const { login, completeSiweLogin } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '/app/dashboard';

  const [mode, setMode] = useState('password');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [stage, setStage] = useState('credentials'); // credentials | siwe
  const [linkedWallet, setLinkedWallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submitCredentials = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await login(mode === 'password' ? { identifier, password } : { identifier, otp });
      if (res.next === 'signup') {
        navigate('/signup');
      } else {
        setLinkedWallet(res.wallet);
        setStage('siwe');
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const requestOtp = async () => {
    setError('');
    try {
      await api('/auth/otp/request', { method: 'POST', body: { identifier } });
      setOtpSent(true);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const signIn = async () => {
    setBusy(true);
    setError('');
    try {
      if (!wallet.signer) {
        await wallet.connectWallet();
        return;
      }
      if (wallet.account?.toLowerCase() !== linkedWallet) {
        setError(`MetaMask is on ${wallet.account.slice(0, 6)}…; switch to your linked wallet ${linkedWallet.slice(0, 6)}…${linkedWallet.slice(-4)}.`);
        return;
      }
      await completeSiweLogin(wallet.signer);
      navigate(next);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link to="/" className="auth-brand">GigLend</Link>
        <h1 className="auth-title">{stage === 'siwe' ? 'Confirm with your wallet' : 'Log in'}</h1>

        {stage === 'credentials' ? (
          <form onSubmit={submitCredentials} className="auth-form">
            <div className="auth-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'password'}
                className={mode === 'password' ? 'active' : ''} onClick={() => setMode('password')}>Password</button>
              <button type="button" role="tab" aria-selected={mode === 'otp'}
                className={mode === 'otp' ? 'active' : ''} onClick={() => setMode('otp')}>One-time code</button>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="identifier">Email or mobile number</label>
              <input id="identifier" className="form-input" value={identifier} autoComplete="username"
                onChange={(e) => setIdentifier(e.target.value)} required />
            </div>
            {mode === 'password' ? (
              <div className="form-group">
                <label className="form-label" htmlFor="password">Password</label>
                <input id="password" type="password" className="form-input" value={password} autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)} required />
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label" htmlFor="otp">Code</label>
                <div className="auth-row">
                  <input id="otp" className="form-input" inputMode="numeric" maxLength={6} value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required />
                  <button type="button" className="btn btn-outline btn-sm" onClick={requestOtp} disabled={!identifier}>
                    {otpSent ? 'Resend' : 'Send code'}
                  </button>
                </div>
                {otpSent && <p className="auth-hint">Mock OTP: check the backend console.</p>}
              </div>
            )}
            {error && <div className="auth-error" role="alert">{error}</div>}
            <button className="btn btn-gold w-full" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
          </form>
        ) : (
          <div className="auth-form">
            <p className="auth-hint">
              Sign a message with the wallet linked to your account
              ({linkedWallet.slice(0, 6)}…{linkedWallet.slice(-4)}). Signing is free and sends no transaction.
            </p>
            {error && <div className="auth-error" role="alert">{error}</div>}
            <button className="btn btn-gold w-full" onClick={signIn} disabled={busy}>
              {!wallet.account ? 'Connect MetaMask' : busy ? 'Waiting for signature…' : 'Sign in with Ethereum'}
            </button>
          </div>
        )}
        <p className="auth-footer">New to GigLend? <Link to="/signup">Sign up</Link></p>
      </div>
    </div>
  );
};

export default LoginPage;
