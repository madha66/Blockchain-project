import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { HiBadgeCheck, HiDocumentText, HiIdentification, HiMail, HiScale } from 'react-icons/hi';
import { api, describeError } from '../../utils/api';
import './Governance.css';

const eth = (wei) => `${Number(ethers.formatEther(BigInt(wei ?? 0))).toFixed(4)} ETH`;
const reasonOf = (err) => err?.reason || err?.revert?.args?.[0] || err?.shortMessage || describeError(err);
const CONSENT_TYPES = ['platform_notice', 'payout_deduction'];

// Must match backend/src/services/walletProof.js disputeMessage().
const disputeMessage = (noticeId, wallet, reason) =>
  ['GigLend notice dispute', `Notice: ${noticeId}`, `Wallet: ${wallet.toLowerCase()}`, '', `Reason: ${reason}`].join('\n');

const NOTICE_STATUS = {
  pending: 'Pending: dispute window open',
  disputed: 'Disputed: waiting for a decision',
  sent: 'Sent to your platform (simulated)',
  not_sent_no_consent: 'Not sent: no platform-notice consent',
  cancelled: 'Cancelled',
};

/**
 * Identity verification (email + OTP, or a simulated ID number), consent signing and
 * on-chain registration, plus the wallet's consents and any platform notices.
 */
const VerifyPage = ({ wallet, contracts, walletStatus }) => {
  const { account, signer } = wallet;
  const { identityRegistry } = contracts;
  const [texts, setTexts] = useState(null);
  const [overview, setOverview] = useState(null);
  const [method, setMethod] = useState('email');
  const [form, setForm] = useState({ email: '', otp: '', idNumber: '', monthlyIncomeInr: '30000', payoutFrequency: 'weekly', platformName: '', contactEmail: '' });
  const [decisions, setDecisions] = useState({ platform_notice: null, payout_deduction: null });
  const [otpSent, setOtpSent] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [disputeReason, setDisputeReason] = useState({});

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const load = useCallback(async () => {
    if (!account) return;
    api(`/identity/consent-text?wallet=${account}`).then(setTexts).catch(() => setTexts(null));
    api(`/users/${account}`).then(setOverview).catch(() => setOverview(null));
  }, [account]);

  useEffect(() => {
    load();
  }, [load, walletStatus?.verified, walletStatus?.expelled]);

  const run = async (label, fn) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ type: 'error', text: reasonOf(err) });
    } finally {
      setBusy('');
    }
  };

  const sendOtp = () =>
    run('otp', async () => {
      await api('/identity/otp', { method: 'POST', body: { email: form.email } });
      setOtpSent(true);
      setMsg({ type: 'success', text: 'Code sent. In this local demo it is printed in the backend console.' });
    });

  /** Signs the consents for one fresh timestamp, as the backend expects. */
  const signConsents = async (wanted) => {
    const fresh = await api(`/identity/consent-text?wallet=${account}`);
    const consents = [];
    for (const type of Object.keys(wanted)) {
      const granted = wanted[type];
      const message = fresh.consents[type].messages[granted ? 'agree' : 'decline'];
      consents.push({ type, granted, signedAt: fresh.signedAt, signature: await signer.signMessage(message) });
    }
    return { fresh, consents };
  };

  const verify = () =>
    run('verify', async () => {
      if (CONSENT_TYPES.some((t) => decisions[t] === null)) throw new Error('Choose agree or do not agree for both consents.');
      const { fresh, consents } = await signConsents(decisions);
      const proof = { message: fresh.proofMessage, signature: await signer.signMessage(fresh.proofMessage) };
      const body = {
        wallet: account,
        method,
        monthlyIncomeInr: Number(form.monthlyIncomeInr || 0),
        payoutFrequency: form.payoutFrequency,
        proof,
        consents,
        ...(method === 'email' ? { email: form.email, otp: form.otp } : { idNumber: form.idNumber }),
        ...(decisions.platform_notice ? { employer: { platformName: form.platformName, contactEmail: form.contactEmail } } : {}),
      };
      const res = await api('/identity/verify', { method: 'POST', body });
      setBusy('register');
      await (await identityRegistry.register(res.attestation, res.signature)).wait();
      setMsg({ type: 'success', text: 'Verified and registered on-chain. Deposits, borrowing and voting are open to this wallet.' });
      walletStatus?.reload();
      load();
    });

  const changeConsent = (type, granted) =>
    run(`consent-${type}`, async () => {
      const employer = type === 'platform_notice' && granted && form.platformName && form.contactEmail
        ? { platformName: form.platformName, contactEmail: form.contactEmail }
        : undefined;
      if (type === 'platform_notice' && granted && !employer && !overview?.hasPlatformContact) {
        throw new Error('Enter your gig platform and its contact email first.');
      }
      const { consents } = await signConsents({ [type]: granted });
      await api('/identity/consent', { method: 'POST', body: { wallet: account, ...consents[0], employer } });
      setMsg({ type: 'success', text: `Consent ${granted ? 'given' : 'withdrawn'} and recorded with your signature.` });
      load();
    });

  const dispute = (notice) =>
    run(`dispute-${notice.id}`, async () => {
      const reason = (disputeReason[notice.id] || '').trim();
      if (reason.length < 5) throw new Error('Describe the problem in a few words.');
      const signature = await signer.signMessage(disputeMessage(notice.id, account, reason));
      await api('/disputes', { method: 'POST', body: { noticeId: notice.id, wallet: account, reason, signature } });
      setMsg({ type: 'success', text: 'Dispute filed. The notice is on hold until it is reviewed.' });
      load();
    });

  const consentRows = overview?.consents || {};
  const verified = walletStatus?.verified;
  const blocked = walletStatus?.banned || walletStatus?.expelled;

  return (
    <div className="verify-page">
      <div>
        <h1 className="gov-title">Identity & consents</h1>
        <p className="gov-sub">
          One verified identity per wallet. Only a salted hash of your identifier goes on-chain; the identifier itself is
          stored encrypted.
        </p>
      </div>
      {msg && <div className={msg.type === 'error' ? 'auth-error' : 'auth-success'}>{msg.text}</div>}

      <section className="dark-card gov-card">
        <h2><HiBadgeCheck /> Status</h2>
        {walletStatus?.loading ? (
          <span className="gov-empty">Checking…</span>
        ) : (
          <div className="gov-rules">
            <div className="gov-rule"><span>Identity</span><strong>{verified ? 'Verified' : walletStatus?.banned ? 'Banned' : walletStatus?.memberId > 0n ? 'Attestation expired' : 'Not verified'}</strong></div>
            <div className="gov-rule"><span>Member</span><strong>{walletStatus?.memberId > 0n ? `#${walletStatus.memberId}` : '—'}</strong></div>
            <div className="gov-rule"><span>Membership</span><strong>{walletStatus?.expelled ? 'Expelled' : walletStatus?.banned ? 'Identity banned' : walletStatus?.defaulter ? 'Unpaid default' : 'In good standing'}</strong></div>
            <div className="gov-rule"><span>Outstanding debt</span><strong>{eth(walletStatus?.outstanding)}</strong></div>
          </div>
        )}
      </section>

      {!verified && !blocked && (
        <section className="dark-card gov-card">
          <h2><HiIdentification /> Verify your identity</h2>
          <div className="verify-steps">
            {['1 · Identifier', '2 · Consents', '3 · Sign', '4 · Register on-chain'].map((s, i) => (
              <span key={s} className={`verify-step ${(i === 0) || (i === 1 && (otpSent || method === 'id')) || busy ? 'verify-step-on' : ''}`}>{s}</span>
            ))}
          </div>

          <div className="verify-method">
            <button className={`btn btn-sm ${method === 'email' ? 'btn-gold' : 'btn-ghost'}`} onClick={() => setMethod('email')}>
              <HiMail /> Email + one-time code
            </button>
            <button className={`btn btn-sm ${method === 'id' ? 'btn-gold' : 'btn-ghost'}`} onClick={() => setMethod('id')}>
              <HiIdentification /> Simulated ID number
            </button>
          </div>

          <div className="verify-grid">
            {method === 'email' ? (
              <>
                <label className="verify-field">Email
                  <input type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" />
                </label>
                <label className="verify-field">One-time code
                  <input value={form.otp} onChange={set('otp')} placeholder="6 digits" maxLength={6} disabled={!otpSent} />
                </label>
                <div className="verify-field" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost btn-sm" onClick={sendOtp} disabled={!form.email || busy === 'otp'}>
                    {otpSent ? 'Send a new code' : 'Send code'}
                  </button>
                </div>
              </>
            ) : (
              <label className="verify-field">ID number (PAN format, simulated)
                <input value={form.idNumber} onChange={set('idNumber')} placeholder="ABCDE1234F" maxLength={10} />
              </label>
            )}
            <label className="verify-field">Monthly gig income (₹)
              <input type="number" min="0" value={form.monthlyIncomeInr} onChange={set('monthlyIncomeInr')} />
            </label>
            <label className="verify-field">Payout frequency
              <select value={form.payoutFrequency} onChange={set('payoutFrequency')}>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every two weeks</option>
              </select>
            </label>
          </div>

          {texts &&
            CONSENT_TYPES.map((type) => (
              <div className="consent-box" key={type}>
                <h3>{texts.consents[type].title}</h3>
                <p className="consent-text">{texts.consents[type].text}</p>
                <span className="consent-meta">Text version {texts.consents[type].version} · signed with your wallet (personal_sign)</span>
                <div className="consent-choice">
                  <button className={`btn btn-sm ${decisions[type] === true ? 'btn-gold' : 'btn-ghost'}`} onClick={() => setDecisions((d) => ({ ...d, [type]: true }))}>I agree</button>
                  <button className={`btn btn-sm ${decisions[type] === false ? 'btn-gold' : 'btn-ghost'}`} onClick={() => setDecisions((d) => ({ ...d, [type]: false }))}>I do not agree</button>
                </div>
                {type === 'platform_notice' && decisions.platform_notice && (
                  <div className="verify-grid">
                    <label className="verify-field">Gig platform
                      <input value={form.platformName} onChange={set('platformName')} placeholder="e.g. Swiggy" />
                    </label>
                    <label className="verify-field">Platform contact email
                      <input type="email" value={form.contactEmail} onChange={set('contactEmail')} placeholder="partner-support@platform.com" />
                    </label>
                  </div>
                )}
              </div>
            ))}
          <p className="verify-note">
            Neither consent is required to join. Without the platform-notice consent, GigLend never contacts your platform.
            Nobody else (family, friends, phone contacts) is ever contacted, and names are never published.
          </p>
          <div className="gov-actions">
            <button className="btn btn-gold" onClick={verify} disabled={Boolean(busy) || !signer}>
              {busy === 'verify' ? 'Signing…' : busy === 'register' ? 'Registering on-chain…' : 'Sign and verify'}
            </button>
          </div>
        </section>
      )}

      {verified && (
        <div className="verify-done"><HiBadgeCheck size={22} /> This wallet is verified.</div>
      )}

      <section className="dark-card gov-card">
        <h2><HiDocumentText /> Your signed consents</h2>
        {CONSENT_TYPES.map((type) => {
          const row = consentRows[type];
          return (
            <div key={type} className="gov-proposal-head">
              <div>
                <strong>{texts?.consents?.[type]?.title ?? type}</strong>
                <div className="consent-meta">
                  {row ? `${row.granted ? 'Agreed' : 'Not agreed'} · ${row.textVersion} · ${new Date(row.timestamp).toLocaleString()}${row.signed ? ' · signed' : ''}` : 'No decision recorded'}
                </div>
              </div>
              <div className="consent-choice">
                {type === 'platform_notice' && !row?.granted && (
                  <>
                    <input className="adm-input" placeholder="Gig platform" value={form.platformName} onChange={set('platformName')} />
                    <input className="adm-input" placeholder="Platform contact email" value={form.contactEmail} onChange={set('contactEmail')} />
                  </>
                )}
                {row?.granted ? (
                  <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => changeConsent(type, false)}>Withdraw</button>
                ) : (
                  <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => changeConsent(type, true)}>Agree</button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {overview?.notices?.length > 0 && (
        <section className="dark-card gov-card">
          <h2><HiScale /> Notices about this wallet</h2>
          {overview.notices.map((n) => {
            const open = n.status === 'pending'; // the backend checks the window against chain time
            return (
              <div key={n.id} className="gov-proposal">
                <div className="gov-proposal-head">
                  <h3>After proposal #{n.proposalId}</h3>
                  <span className="gov-pill">{NOTICE_STATUS[n.status] ?? n.status}</span>
                </div>
                <div className="gov-stats">
                  <span>Balance at expulsion <strong>{eth(n.amountOutstandingWei)}</strong></span>
                  <span>Dispute window ends <strong>{new Date(n.disputeWindowEndsAt * 1000).toLocaleString()}</strong> (chain time)</span>
                </div>
                {open && (
                  <>
                    <label className="verify-field">Why is this notice wrong?
                      <textarea rows={2} value={disputeReason[n.id] || ''} onChange={(e) => setDisputeReason((r) => ({ ...r, [n.id]: e.target.value }))} />
                    </label>
                    <div className="gov-actions">
                      <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => dispute(n)}>Sign and file dispute</button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
};

export default VerifyPage;
