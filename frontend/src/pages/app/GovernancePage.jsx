import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { HiScale, HiUserRemove, HiUserAdd, HiInformationCircle } from 'react-icons/hi';
import { describeError } from '../../utils/api';
import './Governance.css';

const eth = (wei) => `${Number(ethers.formatEther(wei ?? 0n)).toFixed(4)} ETH`;
const glp = (wei) => `${Number(ethers.formatEther(wei ?? 0n)).toFixed(4)} GLP`;
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const reasonOf = (err) => err?.reason || err?.revert?.args?.[0] || err?.shortMessage || describeError(err);
const STATE = ['None', 'Active', 'Succeeded', 'Defeated', 'Executed', 'Cancelled'];
const PILL = { Active: 'gov-pill-active', Succeeded: 'gov-pill-passed', Executed: 'gov-pill-passed', Defeated: 'gov-pill-failed', Cancelled: '' };

function countdown(seconds) {
  if (seconds <= 0) return 'Voting closed';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${d ? `${d}d ` : ''}${h || d ? `${h}h ` : ''}${m}m ${s}s left`;
}

/**
 * Community governance over defaulters: propose expulsion (or reinstatement once the debt is
 * settled), vote with GLP held at the proposal's snapshot block, then execute or cancel.
 */
const GovernancePage = ({ wallet, contracts, eventSync, walletStatus }) => {
  const { account } = wallet;
  const { governance, identityRegistry, lendingPool, defaultManager, loanManager, glpToken, policyConfig } = contracts;
  const [rules, setRules] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [defaulters, setDefaulters] = useState([]);
  const [expelled, setExpelled] = useState([]);
  const [power, setPower] = useState(0n);
  const [chainOffset, setChainOffset] = useState(0); // chain time minus wall-clock time
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    if (!governance || !identityRegistry || !lendingPool || !defaultManager || !loanManager || !glpToken) return;
    try {
      const provider = governance.runner?.provider ?? governance.runner;
      const latest = await provider.getBlock('latest');
      setChainOffset(Number(latest.timestamp) - Math.floor(Date.now() / 1000));

      const [periodDays, quorumBps, passBps, spd] = await Promise.all([
        governance.votingPeriodDays(),
        governance.quorumBps(),
        governance.passThresholdBps(),
        policyConfig ? policyConfig.secondsPerDay() : 86400n,
      ]);
      setRules({ periodDays, quorumBps, passBps, spd });
      if (account) setPower(await glpToken.getVotes(account));

      // Proposals, live from the chain.
      const count = Number(await governance.proposalCount());
      const list = [];
      for (let id = count; id >= 1; id--) {
        const [p, state, quorum] = await Promise.all([governance.getProposal(id), governance.state(id), governance.quorum(id)]);
        const [voted, myWeight, targetOwes] = await Promise.all([
          account ? governance.hasVoted(id, account) : false,
          account ? glpToken.getPastVotes(account, p.snapshotBlock) : 0n,
          lendingPool.isDefaulter(p.target),
        ]);
        list.push({ ...p.toObject(), kind: Number(p.kind), state: STATE[Number(state)], quorum, voted, myWeight, targetOwes });
      }
      setProposals(list);

      // Defaulters: borrowers of defaulted loans who still owe and are not yet expelled.
      const defaultedLoans = await defaultManager.queryFilter(defaultManager.filters.LoanDefaulted(), 0, 'latest');
      const borrowers = new Map();
      for (const ev of defaultedLoans) {
        const loan = await loanManager.getLoan(ev.args.loanId);
        borrowers.set(loan.borrower.toLowerCase(), loan.memberId);
      }
      const rows = [];
      for (const [addr, memberId] of borrowers) {
        const [owes, isExpelled, claim, open] = await Promise.all([
          lendingPool.isDefaulter(addr),
          lendingPool.expelled(addr),
          defaultManager.claimOf(memberId),
          governance.openProposalOf(addr),
        ]);
        if (owes && !isExpelled) rows.push({ wallet: addr, memberId, claim, open });
      }
      setDefaulters(rows);

      const expelledEvents = await lendingPool.queryFilter(lendingPool.filters.WalletExpelled(), 0, 'latest');
      const lastState = new Map();
      for (const ev of expelledEvents) lastState.set(ev.args.wallet.toLowerCase(), ev.args.expelled);
      const out = [];
      for (const [addr, isOut] of lastState) {
        if (!isOut) continue;
        const [owes, open] = await Promise.all([lendingPool.isDefaulter(addr), governance.openProposalOf(addr)]);
        out.push({ wallet: addr, owes, open });
      }
      setExpelled(out);
    } catch (err) {
      setMsg({ type: 'error', text: reasonOf(err) });
    }
  }, [governance, identityRegistry, lendingPool, defaultManager, loanManager, glpToken, policyConfig, account]);

  useEffect(() => {
    load();
  }, [load, eventSync?.syncTick]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const run = (label, fn, success) => async () => {
    setBusy(label);
    setMsg(null);
    try {
      await (await fn()).wait();
      setMsg({ type: 'success', text: success });
      walletStatus?.reload();
      load();
    } catch (err) {
      setMsg({ type: 'error', text: reasonOf(err) });
    } finally {
      setBusy('');
    }
  };

  if (!governance) {
    return <div className="gov-page"><div className="dark-card gov-card">DefaulterGovernance is not deployed. Run scripts/deploy.js.</div></div>;
  }

  const canAct = walletStatus?.verified && !walletStatus?.expelled && !walletStatus?.banned;
  const chainNow = now + chainOffset;
  const policyDays = (seconds) => (rules ? (Number(seconds) / Number(rules.spd)).toFixed(1) : '…');

  return (
    <div className="gov-page">
      <div>
        <h1 className="gov-title">Governance</h1>
        <p className="gov-sub">
          Members vote on expelling wallets that leave a default unpaid, and on reinstating them once the debt is settled.
          Votes are weighted by GLP held at the proposal's snapshot block.
        </p>
      </div>
      {msg && <div className={msg.type === 'error' ? 'auth-error' : 'auth-success'}>{msg.text}</div>}

      <section className="dark-card gov-card">
        <h2><HiInformationCircle /> Voting rules</h2>
        {rules && (
          <div className="gov-rules">
            <div className="gov-rule"><span>Voting period</span><strong>{String(rules.periodDays)} policy days</strong></div>
            <div className="gov-rule"><span>Quorum</span><strong>{Number(rules.quorumBps) / 100}% of GLP supply</strong></div>
            <div className="gov-rule"><span>To pass</span><strong>More than {Number(rules.passBps) / 100}% of votes cast</strong></div>
            <div className="gov-rule"><span>Your voting power</span><strong>{glp(power)}</strong></div>
          </div>
        )}
        {!canAct && (
          <p className="verify-note">
            {walletStatus?.expelled || walletStatus?.banned
              ? 'Expelled wallets cannot propose or vote.'
              : 'Only verified members can propose or vote. Verify your identity first.'}
          </p>
        )}
      </section>

      <section className="dark-card gov-card">
        <h2><HiScale /> Proposals</h2>
        {proposals.length === 0 && <span className="gov-empty">No proposals yet.</span>}
        {proposals.map((p) => {
          const cast = p.forVotes + p.againstVotes;
          const forPct = cast > 0n ? Number((p.forVotes * 10000n) / cast) / 100 : 0;
          const quorumPct = p.quorum > 0n ? Math.min(100, Number((cast * 10000n) / p.quorum) / 100) : 0;
          const left = Number(p.endTime) - chainNow;
          const isTarget = account && p.target.toLowerCase() === account.toLowerCase();
          const key = String(p.id);
          return (
            <div key={key} className="gov-proposal">
              <div className="gov-proposal-head">
                <h3>
                  #{key} · {p.kind === 0 ? 'Expel' : 'Reinstate'} <span className="gov-mono">{short(p.target)}</span>
                </h3>
                <span className={`gov-pill ${PILL[p.state] ?? ''}`}>{p.state}</span>
              </div>
              <div className="gov-bar" aria-label={`For ${forPct}%`}>
                <div className="gov-bar-for" style={{ width: `${forPct}%` }} />
                <div className="gov-bar-against" style={{ width: `${cast > 0n ? 100 - forPct : 0}%` }} />
              </div>
              <div className="gov-stats">
                <span>For <strong>{glp(p.forVotes)}</strong></span>
                <span>Against <strong>{glp(p.againstVotes)}</strong></span>
                <span>Proposer <span className="gov-mono">{short(p.proposer)}</span></span>
                <span>Snapshot block <strong>{String(p.snapshotBlock)}</strong></span>
              </div>
              <div>
                <div className="gov-stats" style={{ marginBottom: 6 }}>
                  <span>Quorum <strong>{glp(cast)}</strong> of {glp(p.quorum)} ({quorumPct.toFixed(1)}%)</span>
                  {p.state === 'Active' && <span><strong>{countdown(left)}</strong> (≈ {policyDays(Math.max(0, left))} policy days)</span>}
                </div>
                <div className="gov-quorum"><div className="gov-quorum-fill" style={{ width: `${quorumPct}%` }} /></div>
              </div>
              <div className="gov-actions">
                {p.state === 'Active' && canAct && !isTarget && !p.voted && p.myWeight > 0n && (
                  <>
                    <button className="btn btn-gold btn-sm" disabled={Boolean(busy)} onClick={run(`for-${key}`, () => governance.vote(p.id, true), `Voted for proposal #${key}`)}>
                      Vote for ({glp(p.myWeight)})
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={run(`against-${key}`, () => governance.vote(p.id, false), `Voted against proposal #${key}`)}>
                      Vote against
                    </button>
                  </>
                )}
                {p.state === 'Active' && p.voted && <span className="gov-empty">You voted.</span>}
                {p.state === 'Active' && canAct && !p.voted && p.myWeight === 0n && !isTarget && (
                  <span className="gov-empty">You held no GLP at the snapshot block, so you cannot vote on this one.</span>
                )}
                {(p.state === 'Succeeded' || (p.state === 'Defeated' && !p.executed)) && (
                  <button className="btn btn-gold btn-sm" disabled={Boolean(busy)} onClick={run(`exec-${key}`, () => governance.execute(p.id), `Proposal #${key} executed`)}>
                    Execute
                  </button>
                )}
                {p.kind === 0 && !p.executed && !p.cancelled && !p.targetOwes && (
                  <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={run(`cancel-${key}`, () => governance.cancel(p.id), `Proposal #${key} cancelled`)}>
                    Cancel (debt cleared)
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <section className="dark-card gov-card">
        <h2><HiUserRemove /> Wallets with an unpaid default</h2>
        {defaulters.length === 0 ? (
          <span className="gov-empty">No member currently owes a default balance.</span>
        ) : (
          <div className="gov-table-wrap">
            <table className="gov-table">
              <thead><tr><th>Wallet</th><th>Member</th><th>Outstanding</th><th></th></tr></thead>
              <tbody>
                {defaulters.map((d) => (
                  <tr key={d.wallet}>
                    <td className="gov-mono">{d.wallet}</td>
                    <td>#{String(d.memberId)}</td>
                    <td>{eth(d.claim)}</td>
                    <td>
                      {d.open > 0n ? (
                        <span className="gov-empty">Proposal #{String(d.open)} open</span>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={!canAct || Boolean(busy) || d.wallet === account?.toLowerCase()}
                          onClick={run(`expel-${d.wallet}`, () => governance.proposeExpel(d.wallet), 'Expulsion proposal created')}
                        >
                          Propose expulsion
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dark-card gov-card">
        <h2><HiUserAdd /> Expelled wallets</h2>
        {expelled.length === 0 ? (
          <span className="gov-empty">No wallet is expelled.</span>
        ) : (
          <div className="gov-table-wrap">
            <table className="gov-table">
              <thead><tr><th>Wallet</th><th>Debt</th><th></th></tr></thead>
              <tbody>
                {expelled.map((x) => (
                  <tr key={x.wallet}>
                    <td className="gov-mono">{x.wallet}</td>
                    <td>{x.owes ? 'Still owed' : 'Settled'}</td>
                    <td>
                      {x.open > 0n ? (
                        <span className="gov-empty">Proposal #{String(x.open)} open</span>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={!canAct || x.owes || Boolean(busy)}
                          title={x.owes ? 'Reinstatement needs the debt settled first' : undefined}
                          onClick={run(`reinstate-${x.wallet}`, () => governance.proposeReinstate(x.wallet), 'Reinstatement proposal created')}
                        >
                          Propose reinstatement
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default GovernancePage;
