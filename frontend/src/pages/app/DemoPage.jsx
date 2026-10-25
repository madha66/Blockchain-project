import React, { useEffect, useState } from 'react';
import { HiClock, HiCurrencyRupee, HiCog } from 'react-icons/hi';
import { api, describeError } from '../../utils/api';
import { STAGE_NAMES } from '../../hooks/useBorrower';
import { fmtEth } from '../../utils/inr';
import './Admin.css';

const reasonOf = (err) => err?.reason || err?.revert?.args?.[0] || err?.shortMessage || describeError(err);

/**
 * Local-chain demo controls: mock gig payouts, chain time travel, keeper actions.
 */
const DemoPage = ({ wallet, contracts }) => {
  const { account } = wallet;
  const { loanManager } = contracts;
  const [target, setTarget] = useState(account || '');
  const [payout, setPayout] = useState('0.01');
  const [chain, setChain] = useState(null);
  const [loanId, setLoanId] = useState('');
  const [loanInfo, setLoanInfo] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const refreshTime = () => api('/demo/chain-time').then(setChain).catch(() => setChain(null));
  useEffect(() => {
    refreshTime();
  }, []);
  useEffect(() => {
    if (account && !target) setTarget(account);
  }, [account, target]);

  const lookup = async (id = loanId) => {
    if (!loanManager || !id) return;
    try {
      const loan = await loanManager.getLoan(BigInt(id));
      const stage = Number(loan.status) === 1 ? Number(await loanManager.stageOf(BigInt(id))) : null;
      setLoanInfo({ loan, stage });
    } catch (err) {
      setLoanInfo(null);
      setMsg({ type: 'error', text: reasonOf(err) });
    }
  };

  const call = async (fn, text) => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await fn();
      setMsg({ type: 'success', text: typeof text === 'function' ? text(out) : text });
      refreshTime();
      if (loanId) lookup();
    } catch (err) {
      setMsg({ type: 'error', text: reasonOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const travel = (days) =>
    call(() => api('/demo/time-travel', { method: 'POST', body: { days } }), (r) => `Moved chain time forward ${days} day(s). Notifier ran for ${r.watcher?.users ?? 0} member(s).`);

  const chainDate = chain ? new Date(chain.chainTime * 1000) : null;

  return (
    <div className="adm-page">
      <div>
        <h1 className="adm-title">Demo panel</h1>
        <p className="text-secondary">Local Hardhat chain only. Payouts come from a mock gig platform account.</p>
      </div>
      {msg && <div className={msg.type === 'error' ? 'auth-error' : 'auth-success'}>{msg.text}</div>}

      <div className="adm-grid">
        <section className="dark-card adm-card">
          <h2><HiCurrencyRupee /> Send a mock payout</h2>
          <p className="text-secondary adm-note">
            Routed through MockPayoutRouter: the income sweep pays toward an open installment, 50% goes to any default claim, the rest reaches the worker.
          </p>
          <input className="form-input" placeholder="Worker wallet 0x…" value={target} onChange={(e) => setTarget(e.target.value.trim())} />
          <input className="form-input" type="number" min="0" step="0.001" value={payout} onChange={(e) => setPayout(e.target.value)} />
          <button className="btn btn-gold btn-sm adm-self-start" disabled={busy || !target}
            onClick={() => call(() => api('/demo/payout', { method: 'POST', body: { wallet: target, amountEth: payout } }), `Paid ${payout} ETH to ${target.slice(0, 8)}…`)}>
            Send payout
          </button>
        </section>

        <section className="dark-card adm-card">
          <h2><HiClock /> Time travel</h2>
          <p className="text-secondary adm-note">
            Chain time: {chainDate ? chainDate.toLocaleString() : 'unknown'}. Stages are computed from chain time, so jumping ahead moves loans through Grace, Onset, Significant and default.
          </p>
          <div className="adm-actions">
            {[1, 3, 4, 7, 11, 30, 31, 90].map((d) => (
              <button key={d} className="btn btn-outline btn-sm" disabled={busy} onClick={() => travel(d)}>+{d} day{d > 1 ? 's' : ''}</button>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm adm-self-start" disabled={busy}
            onClick={() => call(() => api('/demo/tick', { method: 'POST' }), (r) => `Notifier ran for ${r.users ?? 0} member(s).`)}>
            Run the notifier now
          </button>
        </section>
      </div>

      <section className="dark-card adm-card">
        <h2><HiCog /> Keeper actions (anyone may call these)</h2>
        <div className="adm-actions">
          <input className="form-input adm-param-input" placeholder="Loan ID" value={loanId} onChange={(e) => setLoanId(e.target.value)} />
          <button className="btn btn-outline btn-sm" onClick={() => lookup()}>Look up</button>
        </div>
        {loanInfo && (
          <p className="text-secondary">
            Loan #{loanInfo.loan.id.toString()} · {fmtEth(loanInfo.loan.outstandingPrincipal)} ETH outstanding ·{' '}
            {loanInfo.stage === null ? ['', 'active', 'repaid', 'defaulted', 'exited'][Number(loanInfo.loan.status)] : STAGE_NAMES[loanInfo.stage]}
          </p>
        )}
        <div className="adm-actions">
          <button className="btn btn-outline btn-sm" disabled={busy || !loanId}
            onClick={() => call(async () => (await loanManager.accrueLate(BigInt(loanId))).wait(), 'Late status materialised (InstallmentMissed / LateFeeCharged).')}>
            Accrue late status
          </button>
          <button className="btn btn-outline btn-sm" disabled={busy || !loanId}
            onClick={() => call(async () => (await loanManager.collect(BigInt(loanId))).wait(), 'Stake applied to the missed installment; bounty paid.')}>
            collect()
          </button>
          <button className="btn btn-outline btn-sm" disabled={busy || !loanId}
            onClick={() => call(async () => (await loanManager.markDefault(BigInt(loanId))).wait(), 'Loan marked as defaulted and classified; waterfall applied.')}>
            markDefault()
          </button>
          <button className="btn btn-outline btn-sm" disabled={busy || !loanId}
            onClick={() => call(async () => (await loanManager.autopay(BigInt(loanId))).wait(), 'SafeRepay pull applied.')}>
            autopay()
          </button>
        </div>
        <p className="text-secondary adm-note">collect() only works in Significant and markDefault() only from the default day, so a keeper bounty can never pull either forward.</p>
      </section>
    </div>
  );
};

export default DemoPage;
