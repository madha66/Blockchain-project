import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { HiCheckCircle, HiExclamationCircle, HiInformationCircle, HiLifebuoy, HiScale } from 'react-icons/hi2';
import { useBorrower, STAGE_NAMES, DEFAULT_TYPES, LOAN_STATUS, KIND } from '../../hooks/useBorrower';
import { ethWithInr, fmtEth } from '../../utils/inr';
import { describeError } from '../../utils/api';
import './Borrower.css';

const reasonOf = (err) => err?.reason || err?.revert?.args?.[0] || err?.shortMessage || describeError(err);
const key = (name) => ethers.encodeBytes32String(name);
const day = (ts) => new Date(Number(ts) * 1000).toLocaleDateString();
const MAX_U64 = 2n ** 64n - 1n;

const TIMELINE = ['Early warning', 'Reminder', 'Due', 'Grace', 'Onset', 'Significant', 'Default'];

/** Index into TIMELINE for the current position of an open loan. */
function timelineIndex(stage, nextDueDate, chainNow, spd) {
  if (stage === null) return -1;
  if (stage > 0) return stage + 2; // Grace=3, Onset=4, Significant=5, DefaultEligible=6
  const until = Number(nextDueDate) - chainNow;
  if (until <= Number(spd)) return 2; // due today
  if (until <= 3 * Number(spd)) return 1;
  if (until <= 7 * Number(spd)) return 0;
  return -1; // comfortably current
}

const LoansPage = ({ wallet, contracts, eventSync }) => {
  const { account, provider } = wallet;
  const { loanManager, defaultManager, safeRepayVault, policyConfig } = contracts;
  const [tick, setTick] = useState(0);
  const b = useBorrower(contracts, account, `${eventSync?.syncTick}-${tick}`);
  const [chainNow, setChainNow] = useState(Math.floor(Date.now() / 1000));
  const [spd, setSpd] = useState(86400n);
  const [appealDays, setAppealDays] = useState(21n);
  const [exitDays, setExitDays] = useState(1n);
  const [vault, setVault] = useState(null);
  const [payAmount, setPayAmount] = useState('');
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (!provider) return;
    provider.getBlock('latest').then((blk) => blk && setChainNow(blk.timestamp)).catch(() => {});
  }, [provider, eventSync?.syncTick, tick]);

  useEffect(() => {
    if (!policyConfig) return;
    Promise.all([policyConfig.secondsPerDay(), policyConfig.get(key('appealWindowDays')), policyConfig.get(key('penaltyFreeExitDays'))])
      .then(([s, a, e]) => {
        setSpd(s);
        setAppealDays(a);
        setExitDays(e);
      })
      .catch(() => {});
  }, [policyConfig]);

  useEffect(() => {
    if (!safeRepayVault || !account) return;
    Promise.all([safeRepayVault.vaults(account), safeRepayVault.available(account)])
      .then(([v, available]) => setVault({ ...v.toObject(), available }))
      .catch(() => setVault(null));
  }, [safeRepayVault, account, tick, eventSync?.syncTick]);

  useEffect(() => {
    if (!loanManager || b.loanIds.length === 0) {
      setHistory([]);
      return;
    }
    Promise.all(b.loanIds.map((id) => loanManager.getLoan(id))).then((ls) => setHistory(ls.reverse())).catch(() => {});
  }, [loanManager, b.loanIds]);

  const run = async (label, fn, success) => {
    setBusy(label);
    setStatus(null);
    try {
      await (await fn()).wait();
      setStatus({ type: 'success', text: success });
      setTick((t) => t + 1);
    } catch (err) {
      setStatus({ type: 'error', text: reasonOf(err) });
    } finally {
      setBusy('');
    }
  };

  if (b.loading) return <div className="bw-page">Loading…</div>;

  const loan = b.loan;
  const stage = b.stage;
  const tIndex = loan ? timelineIndex(stage, loan.nextDueDate, chainNow, spd) : -1;
  const canRestructure = loan && !loan.restructured && (stage === 0 || stage === 2);
  const claim = b.claim;
  const defaulted = b.lastLoan && Number(b.lastLoan.status) === 3 ? b.lastLoan : null;
  const appealDeadline = defaulted ? Number(defaulted.classifiedAt) + Number(appealDays * spd) : 0;
  const coolingUntil = b.member?.coolingOffUntil ?? 0n;
  const withinExit = loan && Number(loan.paidCount) === 0 && chainNow <= Number(loan.startAt) + Number(exitDays * spd);

  return (
    <div className="bw-page">
      <div>
        <h1 className="bw-title">My loans</h1>
        <p className="text-secondary">
          Your community contact is the same person on every loan. Asking for help early always costs less.
        </p>
      </div>

      {status && (
        <div className={`bw-alert ${status.type === 'error' ? 'bw-alert-bad' : 'bw-alert-good'}`}>
          {status.type === 'error' ? <HiExclamationCircle /> : <HiCheckCircle />} {status.text}
        </div>
      )}

      {loan && (
        <>
          <section className="dark-card bw-card">
            <h2>Loan #{loan.id.toString()} · {Number(loan.kind) === KIND.Builder ? 'Credit-builder (escrowed)' : 'Unsecured'}</h2>
            <ol className="bw-timeline" aria-label="Loan stage">
              {TIMELINE.map((name, i) => (
                <li key={name} className={i === tIndex ? 'current' : i < tIndex ? 'past' : ''}>
                  <span className="bw-dot" />
                  <span>{name}</span>
                </li>
              ))}
            </ol>
            <p className="text-secondary bw-note">
              {stage === 0 && tIndex === -1 && 'You are up to date.'}
              {stage === 0 && tIndex >= 0 && `Installment ${Number(loan.paidCount) + 1} is due on ${day(loan.nextDueDate)}.`}
              {stage === 1 && 'Grace period: no fee and no effect on your score. Autopay retries collection.'}
              {stage === 2 && 'Overdue: a one-time late fee applies to this installment. You can still ask for a payment holiday.'}
              {stage === 3 && 'Seriously overdue: your locked stake may now be applied to the missed installment and your guarantor is alerted.'}
              {stage === 4 && 'This loan can now be marked as defaulted. Please pay what is due or contact us now.'}
            </p>
          </section>

          <section className="dark-card bw-card">
            <h2><HiLifebuoy /> Need help? Options first</h2>
            <p className="text-secondary bw-note">
              One restructure per loan, at most two in 12 months, asked for before the due date or while overdue (days
              4–10). Asking early means the installment counts as a near-on-time payment for your score.
            </p>
            <div className="bw-options">
              <div className="bw-option">
                <strong>Payment holiday</strong>
                <span>Skip this installment; interest is frozen for that period; your schedule moves one cycle later; small flat fee.</span>
                <button className="btn btn-outline btn-sm" disabled={!canRestructure || !!busy}
                  onClick={() => run('holiday', () => loanManager.requestRestructure(loan.id, 1), 'Payment holiday granted. Your next installment moved one cycle later.')}>
                  Request holiday
                </button>
              </div>
              <div className="bw-option">
                <strong>Tenure stretch</strong>
                <span>If your payouts dropped for two cycles: spread the rest over more installments (a small term premium applies).</span>
                <button className="btn btn-outline btn-sm" disabled={!canRestructure || !!busy}
                  onClick={() => run('stretch', () => loanManager.requestRestructure(loan.id, 2), 'Schedule stretched. Your installments are smaller now.')}>
                  Request stretch
                </button>
              </div>
            </div>
            {loan.restructured && <p className="text-secondary bw-note">This loan has already used its restructure.</p>}
            {!loan.restructured && !canRestructure && (
              <p className="text-secondary bw-note">Restructuring opens again before the next due date, or from day 4 of being overdue.</p>
            )}
          </section>

          <section className="dark-card bw-card">
            <h2>What you owe</h2>
            <div className="bw-row"><span>Due now</span><span className="bw-row-value">{ethWithInr(b.amountDue)}</span></div>
            <div className="bw-row"><span>Next due date</span><span className="bw-row-value">{day(loan.nextDueDate)}</span></div>
            {loan.lateFeesDue > 0n && <div className="bw-row bw-row-bad"><span>Late fees</span><span className="bw-row-value">{fmtEth(loan.lateFeesDue)} ETH</span></div>}
            <div className="bw-row"><span>Outstanding principal</span><span className="bw-row-value">{ethWithInr(loan.outstandingPrincipal)}</span></div>
            <div className="bw-row"><span>Everything left on the schedule</span><span className="bw-row-value">{ethWithInr(b.payoff)}</span></div>
            <div className="bw-row"><span>Rate</span><span className="bw-row-value">{(Number(loan.rateBps) / 100).toFixed(2)}% APR, fixed</span></div>
            {Number(loan.kind) === KIND.Builder && (
              <div className="bw-row"><span>Held in escrow for you</span><span className="bw-row-value">{ethWithInr(loan.escrow)}</span></div>
            )}
            <div className="auth-row mt-2">
              <button className="btn btn-gold" disabled={!!busy || b.amountDue === 0n}
                onClick={() => run('pay', () => loanManager.repayInstallment(loan.id, { value: b.amountDue }), 'Installment paid.')}>
                Pay {fmtEth(b.amountDue)} ETH
              </button>
              <input className="form-input bw-inline-input" type="number" min="0" step="0.001" placeholder="Other amount (ETH)"
                value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
              <button className="btn btn-outline" disabled={!!busy || !payAmount}
                onClick={() => run('custom', () => loanManager.repayInstallment(loan.id, { value: ethers.parseEther(payAmount) }), 'Payment applied: fees, then interest, then principal. Any excess was refunded.')}>
                Pay amount
              </button>
              <button className="btn btn-ghost" disabled={!!busy}
                onClick={() => run('payoff', () => loanManager.repayInstallment(loan.id, { value: b.payoff }), 'Loan fully repaid.')}>
                Pay everything
              </button>
            </div>
            {withinExit && (
              <div className="bw-alert bw-alert-warn mt-2">
                <HiInformationCircle /> Changed your mind? Within {exitDays.toString()} day of disbursement you can return the
                principal with no interest or fees.
                <button className="btn btn-outline btn-sm"
                  onClick={() => run('exit', () => loanManager.exitLoan(loan.id, { value: Number(loan.kind) === KIND.Builder ? 0n : loan.principal }), 'Loan cancelled with no charges.')}>
                  Exit penalty-free
                </button>
              </div>
            )}
          </section>

          <section className="dark-card bw-card">
            <h2>Installment schedule</h2>
            <table className="bw-table">
              <thead><tr><th>#</th><th>Due</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {Array.from({ length: Number(loan.nInstallments) }, (_, i) => {
                  const number = i + 1;
                  const paid = number <= Number(loan.paidCount);
                  const offset = number - (Number(loan.paidCount) + 1);
                  const due = Number(loan.nextDueDate) + offset * Number(loan.periodDays) * Number(spd);
                  return (
                    <tr key={number} className={offset === 0 ? 'bw-current-row' : undefined}>
                      <td>{number}</td>
                      <td>{paid ? '—' : day(due)}</td>
                      <td>{fmtEth(loan.installment)} ETH</td>
                      <td>{paid ? 'Paid' : offset === 0 ? (stage > 0 ? `Overdue · ${STAGE_NAMES[stage]}` : 'Current') : 'Upcoming'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {loan.autopay && vault && (
            <section className="dark-card bw-card">
              <h2>SafeRepay vault</h2>
              <div className="bw-row"><span>Balance</span><span className="bw-row-value">{fmtEth(vault.balance)} ETH</span></div>
              <div className="bw-row"><span>Available for the next pull</span><span className="bw-row-value">{fmtEth(vault.available)} ETH</span></div>
              <div className="bw-row"><span>Protected minimum (never pulled)</span><span className="bw-row-value">{fmtEth(vault.protectedMin)} ETH</span></div>
              <div className="bw-row"><span>Max pull per installment</span><span className="bw-row-value">{fmtEth(vault.maxPull)} ETH</span></div>
              <div className="auth-row mt-2">
                <button className="btn btn-outline btn-sm" disabled={!!busy}
                  onClick={() => run('topup', () => safeRepayVault.deposit({ value: loan.installment }), 'Vault topped up.')}>
                  Top up one installment
                </button>
                <button className="btn btn-outline btn-sm" disabled={!!busy || vault.available === 0n || b.amountDue === 0n}
                  onClick={() => run('autopay', () => loanManager.autopay(loan.id), 'Installment collected from SafeRepay.')}>
                  Collect from vault now
                </button>
                <button className="btn btn-ghost btn-sm" disabled={!!busy || vault.balance === 0n}
                  onClick={() => run('withdraw', () => safeRepayVault.withdraw(vault.balance), 'Vault balance returned to your wallet.')}>
                  Withdraw vault balance
                </button>
              </div>
            </section>
          )}
        </>
      )}

      {claim && claim.amount > 0n && (
        <section className="dark-card bw-card">
          <h2><HiScale /> After default</h2>
          {defaulted && (
            <p className="text-secondary">
              Loan #{defaulted.id.toString()} was classified as <strong>{DEFAULT_TYPES[Number(defaulted.dtype)]}</strong> on {day(defaulted.classifiedAt)}.
              The rule is public: first-payment default, a flagged wallet cluster and a new, thin stake point to fraud; payouts that kept
              arriving without a request for help point to a strategic default; otherwise it is hardship.
            </p>
          )}
          {defaulted && !defaulted.appealOpen && chainNow <= appealDeadline && (
            <div className="bw-alert bw-alert-warn">
              <HiInformationCircle /> Think this is wrong? You can appeal until {day(appealDeadline)}.
              <button className="btn btn-outline btn-sm" disabled={!!busy}
                onClick={() => run('appeal', () => defaultManager.appeal(defaulted.id), 'Appeal opened. The disputes team will review the classification.')}>
                Appeal
              </button>
            </div>
          )}
          {defaulted?.appealOpen && <div className="bw-alert bw-alert-warn"><HiInformationCircle /> Your appeal is under review.</div>}

          {Number(claim.dtype) === 1 && !claim.workout && (
            <div className="bw-option">
              <strong>Hardship workout</strong>
              <span>Repay in small fixed installments over up to 6 months with no interest. Finishing it earns back part of your score.</span>
              <button className="btn btn-outline btn-sm" disabled={!!busy || !defaulted}
                onClick={() => run('workout', () => defaultManager.startWorkout(defaulted.id), 'Workout plan started.')}>
                Start workout plan
              </button>
            </div>
          )}
          {claim.workout && (
            <div className="bw-option">
              <strong>Workout plan</strong>
              <span>{claim.workoutPeriods.toString()} installments of {fmtEth(claim.workoutInstallment)} ETH, interest frozen. Next by {day(claim.workoutNextDue)}.</span>
              <button className="btn btn-gold btn-sm" disabled={!!busy}
                onClick={() => run('payworkout', () => defaultManager.payWorkout({ value: claim.workoutInstallment }), 'Workout installment paid.')}>
                Pay {fmtEth(claim.workoutInstallment)} ETH
              </button>
            </div>
          )}

          <div className="bw-row"><span>Remaining balance</span><span className="bw-row-value">{ethWithInr(claim.amount)}</span></div>
          <div className="bw-row"><span>Settle today for</span><span className="bw-row-value">{ethWithInr(b.quote)}</span></div>
          <p className="text-secondary bw-note">
            Half of any later deposit or payout routed through GigLend is applied to this balance automatically. Paying the
            settlement amount closes it; your cooling-off period starts on the day you settle.
          </p>
          <button className="btn btn-gold" disabled={!!busy}
            onClick={() => run('settle', () => defaultManager.settleClaim({ value: b.quote }), 'Settled. Your cooling-off period has started.')}>
            Settle for {fmtEth(b.quote)} ETH
          </button>
        </section>
      )}

      {!loan && !(claim && claim.amount > 0n) && (
        <section className="dark-card bw-card">
          <h2>No open loan</h2>
          {coolingUntil > BigInt(chainNow) ? (
            <p className="text-secondary">
              {coolingUntil === MAX_U64 ? 'Borrowing is paused until your balance is settled.' : `Cooling-off until ${day(coolingUntil)}. After that, you restart with a credit-builder loan.`}
            </p>
          ) : (
            <Link to="/app/borrow" className="btn btn-gold">Apply for a loan</Link>
          )}
        </section>
      )}

      {history.length > 0 && (
        <section className="dark-card bw-card">
          <h2>Loan history</h2>
          <table className="bw-table">
            <thead><tr><th>Loan</th><th>Type</th><th>Amount</th><th>Paid</th><th>Status</th></tr></thead>
            <tbody>
              {history.map((l) => (
                <tr key={l.id.toString()}>
                  <td>#{l.id.toString()}</td>
                  <td>{Number(l.kind) === KIND.Builder ? 'Builder' : 'Unsecured'}</td>
                  <td>{fmtEth(l.principal)} ETH</td>
                  <td>{l.paidCount.toString()} / {l.nInstallments.toString()}</td>
                  <td>{LOAN_STATUS[Number(l.status)]}{Number(l.status) === 3 ? ` · ${DEFAULT_TYPES[Number(l.dtype)]}` : ''}{l.restructured ? ' · restructured' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
};

export default LoansPage;
