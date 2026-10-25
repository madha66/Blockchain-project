import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { HiShieldCheck, HiLockClosed, HiInformationCircle, HiCheckCircle, HiExclamationCircle } from 'react-icons/hi';
import { useBorrower, KIND } from '../../hooks/useBorrower';
import { TIER_NAMES } from '../../hooks/useMembership';
import { ethWithInr, fmtEth, formatInr, weiToInr } from '../../utils/inr';
import { describeError } from '../../utils/api';
import './Borrower.css';

const key = (name) => ethers.encodeBytes32String(name);

const reasonOf = (err) => err?.reason || err?.revert?.args?.[0] || err?.shortMessage || describeError(err);

const LimitRow = ({ label, value, note, bad }) => (
  <div className={`bw-row ${bad ? 'bw-row-bad' : ''}`}>
    <span>{label}</span>
    <span className="bw-row-value">
      {value}
      {note && <small>{note}</small>}
    </span>
  </div>
);

const BorrowPage = ({ wallet, contracts, eventSync }) => {
  const { account, provider } = wallet;
  const { loanManager, riskEngine, policyConfig, lendingPool, glpToken, identityRegistry } = contracts;
  const [tick, setTick] = useState(0);
  const b = useBorrower(contracts, account, `${eventSync?.syncTick}-${tick}`);

  const [kind, setKind] = useState(KIND.Builder);
  const [amount, setAmount] = useState('0.01');
  const [n, setN] = useState(4);
  const [guarantor, setGuarantor] = useState('');
  const [autopay, setAutopay] = useState(true);
  const [prefund, setPrefund] = useState('');
  const [params, setParams] = useState(null);
  const [stake, setStake] = useState({ free: 0n, value: 0n, pledge: 0n, pledgeValue: 0n });
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [eligibility, setEligibility] = useState({ ok: false, reason: '' });

  // Policy numbers used in the key fact statement
  useEffect(() => {
    if (!policyConfig) return;
    const names = ['minInstallments', 'maxInstallments', 'lateFeeFlatWei', 'lateFeeCapBps', 'unsecuredStakeCoverBps', 'penaltyFreeExitDays', 'graceDaysShort', 'graceDaysLong', 'sweepBps', 'holidayFeeWei'];
    Promise.all(names.map((nm) => policyConfig.get(key(nm))))
      .then((vals) => setParams(Object.fromEntries(names.map((nm, i) => [nm, vals[i]]))))
      .catch(() => setParams(null));
  }, [policyConfig]);

  useEffect(() => {
    if (b.limits?.unsecuredAllowed === false && kind === KIND.Unsecured) setKind(KIND.Builder);
  }, [b.limits, kind]);

  useEffect(() => {
    if (!identityRegistry || !account) return;
    identityRegistry.eligibility(account).then(([ok, reason]) => setEligibility({ ok, reason })).catch(() => {});
  }, [identityRegistry, account, tick, eventSync?.syncTick]);

  // Stake and guarantor pledge
  useEffect(() => {
    const load = async () => {
      if (!glpToken || !lendingPool || !account) return;
      const free = await glpToken.unlockedBalanceOf(account);
      const value = free > 0n ? await lendingPool.valueOfShares(free) : 0n;
      let pledge = 0n;
      if (guarantor && ethers.isAddress(guarantor) && loanManager) pledge = await loanManager.pledges(guarantor, account);
      const pledgeValue = pledge > 0n ? await lendingPool.valueOfShares(pledge) : 0n;
      setStake({ free, value, pledge, pledgeValue });
    };
    load().catch(() => {});
  }, [glpToken, lendingPool, loanManager, account, guarantor, tick]);

  const amountWei = useMemo(() => {
    try {
      return amount && Number(amount) > 0 ? ethers.parseEther(amount) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  // Live quote: pricing plus every prevention rule; a revert names the rule that fails.
  useEffect(() => {
    if (!riskEngine || b.memberId === 0n || amountWei === 0n) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    riskEngine
      .quote(b.memberId, kind, amountWei, n)
      .then(([rateBps, totalInterest, installment]) => {
        if (!cancelled) {
          setQuote({ rateBps, totalInterest, installment });
          setQuoteError('');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setQuote(null);
          setQuoteError(reasonOf(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [riskEngine, b.memberId, kind, amountWei, n, eventSync?.syncTick]);

  const period = b.member ? Number(b.member.payoutPeriodDays) : 7;
  const lateFee = quote && params ? (params.lateFeeFlatWei < (quote.installment * params.lateFeeCapBps) / 10000n ? params.lateFeeFlatWei : (quote.installment * params.lateFeeCapBps) / 10000n) : 0n;
  const coverNeeded = kind === KIND.Unsecured && params ? (amountWei * params.unsecuredStakeCoverBps) / 10000n : 0n;
  const coverOk = stake.value + stake.pledgeValue >= coverNeeded;
  const longLoan = n * period > 90;
  const grace = params ? (longLoan || (b.member && Number(b.member.tier) >= 3) ? params.graceDaysLong : params.graceDaysShort) : 3n;

  const schedule = useMemo(() => {
    if (!quote) return [];
    const now = Date.now();
    const perInterest = quote.totalInterest / BigInt(n);
    const perPrincipal = amountWei / BigInt(n);
    return Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      date: new Date(now + (i + 1) * period * 86400 * 1000),
      interest: i === n - 1 ? quote.totalInterest - perInterest * BigInt(n - 1) : perInterest,
      principal: i === n - 1 ? amountWei - perPrincipal * BigInt(n - 1) : perPrincipal,
    }));
  }, [quote, n, period, amountWei]);

  const submit = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const g = guarantor && ethers.isAddress(guarantor) ? guarantor : ethers.ZeroAddress;
      const value = autopay && prefund ? ethers.parseEther(prefund) : 0n;
      const tx = await loanManager.openLoan(kind, amountWei, n, g, autopay, { value });
      setStatus({ type: 'info', text: 'Transaction sent. Waiting for confirmation…' });
      await tx.wait();
      setStatus({
        type: 'success',
        text: kind === KIND.Builder
          ? 'Builder loan opened. The amount is held in escrow and released to you when every installment is paid.'
          : 'Loan opened and sent to your wallet. Your stake is locked until it is repaid.',
      });
      setTick((t) => t + 1);
    } catch (err) {
      setStatus({ type: 'error', text: reasonOf(err) });
    } finally {
      setBusy(false);
    }
  };

  if (b.loading) return <div className="bw-page">Loading…</div>;

  if (b.loan) {
    return (
      <div className="bw-page">
        <h1 className="bw-title">Borrow</h1>
        <div className="dark-card bw-card">
          <h2>You have an open loan</h2>
          <p className="text-secondary">
            Loan #{b.loan.id.toString()}: {ethWithInr(b.loan.outstandingPrincipal)} outstanding, {fmtEth(b.amountDue)} ETH due now.
            One loan at a time keeps repayments manageable.
          </p>
          <Link to="/app/loans" className="btn btn-gold mt-2">Go to my loan</Link>
        </div>
      </div>
    );
  }

  const L = b.limits;
  return (
    <div className="bw-page">
      <div>
        <h1 className="bw-title">Borrow</h1>
        <p className="text-secondary">
          Member #{b.memberId.toString()} · {b.member ? TIER_NAMES[Number(b.member.tier)] : ''} tier · score {b.score}/900 ·
          installments every {period} days to match your payouts
        </p>
      </div>

      {!eligibility.ok && (
        <div className="bw-alert bw-alert-bad">
          <HiLockClosed /> <span>Borrowing is not available right now: {eligibility.reason}.</span>
        </div>
      )}

      <div className="bw-grid">
        <section className="dark-card bw-card">
          <h2>1. Choose the loan type</h2>
          <div className="bw-kinds">
            <button type="button" className={`bw-kind ${kind === KIND.Builder ? 'active' : ''}`} onClick={() => setKind(KIND.Builder)}>
              <strong>Credit-builder loan</strong>
              <span>
                The amount is held in escrow and released to you when you finish repaying. It builds your record at no
                risk to lenders. Every member starts here, and re-entry after a default always starts here.
              </span>
            </button>
            <button
              type="button"
              className={`bw-kind ${kind === KIND.Unsecured ? 'active' : ''}`}
              disabled={!L?.unsecuredAllowed}
              onClick={() => setKind(KIND.Unsecured)}
            >
              <strong>Unsecured loan</strong>
              <span>
                Paid to your wallet now. Needs a completed Builder loan, 90 days of stake and 50% stake cover (yours or
                a guarantor's). Your first one is capped at ₹1,000.
              </span>
              {!L?.unsecuredAllowed && <em className="bw-hold"><HiLockClosed /> {L?.unsecuredHold}</em>}
            </button>
          </div>

          <h2>2. Amount and schedule</h2>
          <div className="bw-fields">
            <label className="form-group">
              <span className="form-label">Amount (ETH)</span>
              <input className="form-input" type="number" min="0" step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <small className="text-secondary">≈ {formatInr(weiToInr(amountWei))}</small>
            </label>
            <label className="form-group">
              <span className="form-label">Installments (every {period} days)</span>
              <select className="form-input" value={n} onChange={(e) => setN(Number(e.target.value))}>
                {Array.from(
                  { length: Number(params?.maxInstallments ?? 12n) - Number(params?.minInstallments ?? 2n) + 1 },
                  (_, i) => Number(params?.minInstallments ?? 2n) + i
                ).map((k) => (
                  <option key={k} value={k}>{k} installments · {k * period} days</option>
                ))}
              </select>
            </label>
          </div>

          {kind === KIND.Unsecured && (
            <>
              <h2>3. Stake cover</h2>
              <LimitRow label="Required cover (50% of the loan)" value={ethWithInr(coverNeeded)} />
              <LimitRow label="Your unlocked stake" value={`${fmtEth(stake.free)} GLP ≈ ${fmtEth(stake.value)} ETH`} bad={!coverOk} />
              <label className="form-group">
                <span className="form-label">Guarantor address (optional)</span>
                <input className="form-input" placeholder="0x…" value={guarantor} onChange={(e) => setGuarantor(e.target.value.trim())} />
                <small className="text-secondary">
                  {guarantor && ethers.isAddress(guarantor)
                    ? stake.pledge > 0n
                      ? `This guarantor has pledged ${fmtEth(stake.pledge)} GLP for you.`
                      : 'This address has not pledged GLP for you yet. They pledge from their own Borrow page.'
                    : 'A guarantor pledges their own GLP, which is locked for the life of your loan.'}
                </small>
              </label>
              <p className="text-secondary bw-note">All of your unlocked GLP is locked while the loan is open and returned when you finish repaying.</p>
            </>
          )}

          <h2>{kind === KIND.Unsecured ? '4.' : '3.'} Autopay (SafeRepay)</h2>
          <label className="auth-consent">
            <input type="checkbox" checked={autopay} onChange={(e) => setAutopay(e.target.checked)} />
            <span>
              <strong>Use SafeRepay and the income sweep (recommended)</strong>
              <span className="auth-hint">
                {Number(params?.sweepBps ?? 2000n) / 100}% of each payout routed through GigLend goes to your next installment, and
                your SafeRepay vault pays installments within the limits you set. You can turn this off.
              </span>
            </span>
          </label>
          {autopay && (
            <label className="form-group">
              <span className="form-label">Prefund SafeRepay now (ETH, optional)</span>
              <input className="form-input" type="number" min="0" step="0.001" value={prefund} onChange={(e) => setPrefund(e.target.value)} />
            </label>
          )}
        </section>

        <aside className="bw-side">
          <section className="dark-card bw-card">
            <h2><HiShieldCheck /> Your limit, and why</h2>
            {L ? (
              <>
                <LimitRow label="Builder loan cap" value={ethWithInr(L.builderCap)} />
                <LimitRow
                  label="Unsecured ladder limit"
                  value={L.unsecuredAllowed ? ethWithInr(L.unsecuredCap) : 'Not yet available'}
                  note="≤ 1.5× your largest completed loan, smaller early steps"
                  bad={!L.unsecuredAllowed}
                />
                <LimitRow
                  label="Max installment (35% of income, minus EMIs)"
                  value={`${fmtEth(L.maxMonthlyInstallment)} ETH / month`}
                  note={quote ? `This loan: ${fmtEth((quote.installment * 30n) / BigInt(period))} ETH / month` : undefined}
                />
                <LimitRow label="Per-loan cap (2% of pool)" value={ethWithInr(L.perLoanCap)} />
                <LimitRow label="Room in your wallet cluster (5%)" value={ethWithInr(L.clusterRoom)} />
                <LimitRow label="Room in this week's growth cap" value={ethWithInr(L.weeklyRoom)} />
                <LimitRow label="Pool room under the 90% cap" value={ethWithInr(L.liquidityRoom)} />
                {L.fastClimberHeld && (
                  <div className="bw-alert bw-alert-warn"><HiExclamationCircle /> Two limit steps in 60 days: you are held at your current step for now.</div>
                )}
                {L.cohortPaused && (
                  <div className="bw-alert bw-alert-bad"><HiExclamationCircle /> First loans in your sign-up cohort are paused while first-payment defaults are reviewed.</div>
                )}
              </>
            ) : (
              <p className="text-secondary">Limits are unavailable.</p>
            )}
          </section>

          <section className="dark-card bw-card bw-kfs">
            <h2><HiInformationCircle /> Key fact statement</h2>
            {quote ? (
              <>
                <LimitRow label="Annual rate (APR, fixed)" value={`${(Number(quote.rateBps) / 100).toFixed(2)}%`} />
                <LimitRow label="Installment" value={`${ethWithInr(quote.installment, 6)} × ${n}`} />
                <LimitRow label="Total interest" value={ethWithInr(quote.totalInterest, 6)} />
                <LimitRow label="Total you repay" value={ethWithInr(amountWei + quote.totalInterest, 6)} />
                <LimitRow label="Late fee" value={ethWithInr(lateFee, 6)} note={`Once per overdue installment from day ${Number(grace) + 1}, never compounding`} />
                <LimitRow label="Grace period" value={`${grace} days, no fee`} />
                <LimitRow label="Penalty-free exit" value={`${params?.penaltyFreeExitDays ?? 1n} day`} note="Return the principal with no interest or fees" />
                <LimitRow label="Help available" value="Payment holiday or tenure stretch" note={`One per loan; holiday fee ${fmtEth(params?.holidayFeeWei ?? 0n)} ETH`} />
                <details className="bw-schedule">
                  <summary>Installment schedule</summary>
                  <table>
                    <thead><tr><th>#</th><th>Due (approx.)</th><th>Interest</th><th>Principal</th></tr></thead>
                    <tbody>
                      {schedule.map((r) => (
                        <tr key={r.number}>
                          <td>{r.number}</td>
                          <td>{r.date.toLocaleDateString()}</td>
                          <td>{fmtEth(r.interest, 6)}</td>
                          <td>{fmtEth(r.principal, 6)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </>
            ) : (
              <div className="bw-alert bw-alert-bad">
                <HiExclamationCircle /> {quoteError || 'Enter an amount to see your terms.'}
              </div>
            )}

            {status && (
              <div className={`bw-alert ${status.type === 'error' ? 'bw-alert-bad' : status.type === 'success' ? 'bw-alert-good' : 'bw-alert-warn'}`}>
                {status.type === 'success' ? <HiCheckCircle /> : <HiInformationCircle />} {status.text}
              </div>
            )}
            <button
              className="btn btn-gold w-full"
              disabled={busy || !quote || !eligibility.ok || (kind === KIND.Unsecured && !coverOk) || !provider}
              onClick={submit}
            >
              {busy ? 'Confirm in MetaMask…' : kind === KIND.Builder ? 'Open credit-builder loan' : 'Borrow now'}
            </button>
          </section>

          <GuaranteePanel contracts={contracts} account={account} onChange={() => setTick((t) => t + 1)} />
        </aside>
      </div>
    </div>
  );
};

/** Guarantors pledge their own GLP for someone else's next loan. */
const GuaranteePanel = ({ contracts, account, onChange }) => {
  const { loanManager, glpToken } = contracts;
  const [borrower, setBorrower] = useState('');
  const [shares, setShares] = useState('');
  const [pledged, setPledged] = useState(0n);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!loanManager || !ethers.isAddress(borrower)) {
      setPledged(0n);
      return;
    }
    loanManager.pledges(account, borrower).then(setPledged).catch(() => setPledged(0n));
  }, [loanManager, account, borrower, msg]);

  const act = async (fn) => {
    setMsg('');
    try {
      await (await fn()).wait();
      setMsg('Done.');
      onChange();
    } catch (err) {
      setMsg(reasonOf(err));
    }
  };

  return (
    <section className="dark-card bw-card">
      <h2>Guarantee a friend's loan</h2>
      <p className="text-secondary bw-note">
        Your pledged GLP is locked until their loan is repaid. If they default, it is applied after their own stake.
      </p>
      <input className="form-input mb-1" placeholder="Borrower address 0x…" value={borrower} onChange={(e) => setBorrower(e.target.value.trim())} />
      <input className="form-input mb-1" placeholder="GLP to pledge" type="number" min="0" value={shares} onChange={(e) => setShares(e.target.value)} />
      <div className="auth-row">
        <button className="btn btn-outline btn-sm" disabled={!ethers.isAddress(borrower) || !shares || !glpToken}
          onClick={() => act(() => loanManager.offerGuarantee(borrower, ethers.parseEther(shares)))}>Pledge</button>
        {pledged > 0n && (
          <button className="btn btn-ghost btn-sm" onClick={() => act(() => loanManager.withdrawGuarantee(borrower))}>
            Withdraw unused pledge ({fmtEth(pledged)} GLP)
          </button>
        )}
      </div>
      {msg && <p className="text-secondary bw-note">{msg}</p>}
    </section>
  );
};

export default BorrowPage;
