import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { HiScale, HiLightningBolt, HiFlag, HiUserGroup, HiAdjustments, HiMail, HiDocumentText, HiClipboardCheck } from 'react-icons/hi';
import { api, describeError } from '../../utils/api';
import { DEFAULT_TYPES } from '../../hooks/useBorrower';
import './Admin.css';

const reasonOf = (err) => err?.reason || err?.revert?.args?.[0] || err?.shortMessage || describeError(err);
const ADMIN_ROLE = ethers.id('ADMIN_ROLE');
const DISPUTE_ROLE = ethers.id('DISPUTE_ROLE');

/**
 * ADMIN_ROLE / DISPUTE_ROLE console. Every action is a transaction signed by the connected
 * wallet; the contracts enforce the roles. Production would route these through a Safe multisig.
 */
const AdminPage = ({ wallet, contracts, eventSync }) => {
  const { account } = wallet;
  const { defaultManager, loanManager, identityRegistry, policyConfig } = contracts;
  const [roles, setRoles] = useState({ admin: false, dispute: false });
  const [appeals, setAppeals] = useState([]);
  const [cohorts, setCohorts] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [params, setParams] = useState([]);
  const [log, setLog] = useState([]);
  const [notices, setNotices] = useState([]);
  const [audit, setAudit] = useState({ items: [], indexer: null });
  const [auditCategory, setAuditCategory] = useState('');
  const [resolution, setResolution] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [shock, setShock] = useState({ cohortId: '', days: '14', event: '' });
  const [cluster, setCluster] = useState('');
  const [misdeclared, setMisdeclared] = useState('');
  const [edits, setEdits] = useState({});

  const load = useCallback(async () => {
    if (!defaultManager || !identityRegistry || !policyConfig || !account) return;
    try {
      const [isAdmin, isDispute] = await Promise.all([
        policyConfig.hasRole(ADMIN_ROLE, account),
        defaultManager.hasRole(DISPUTE_ROLE, account),
      ]);
      setRoles({ admin: isAdmin, dispute: isDispute });

      const appealed = await defaultManager.queryFilter(defaultManager.filters.Appealed(), 0, 'latest');
      const open = [];
      for (const ev of appealed) {
        const loan = await loanManager.getLoan(ev.args.loanId);
        if (loan.appealOpen && !open.some((a) => a.id === loan.id)) open.push(loan);
      }
      setAppeals(open);

      const registered = await identityRegistry.queryFilter(identityRegistry.filters.MemberRegistered(), 0, 'latest');
      const ids = [...new Set(registered.map((e) => Number(e.args.cohortId)))];
      setCohorts(
        await Promise.all(
          ids.map(async (id) => ({
            id,
            first: await identityRegistry.cohortFirstLoans(id),
            fpd: await identityRegistry.cohortFirstPaymentDefaults(id),
            paused: await identityRegistry.cohortPaused(id),
            manual: await identityRegistry.cohortPausedManual(id),
            shockUntil: await identityRegistry.shockUntil(id),
          }))
        )
      );

      const flags = await identityRegistry.queryFilter(identityRegistry.filters.ClusterFlagged(), 0, 'latest');
      const last = new Map();
      for (const f of flags) last.set(f.args.clusterId, f.args.flagged);
      setFlagged([...last.entries()].filter(([, v]) => v).map(([k]) => k));

      const keys = await policyConfig.keys();
      setParams(
        await Promise.all(
          keys.map(async (k) => {
            const [value, min, max] = await policyConfig.bounds(k);
            return { key: k, name: ethers.decodeBytes32String(k), value, min, max };
          })
        )
      );
      api('/admin/message-log').then((d) => setLog(d.items)).catch(() => setLog([]));
      api('/notices').then((d) => setNotices(d.items)).catch(() => setNotices([]));
    } catch (err) {
      setMsg({ type: 'error', text: reasonOf(err) });
    }
  }, [defaultManager, loanManager, identityRegistry, policyConfig, account]);

  useEffect(() => {
    load();
  }, [load, eventSync?.syncTick]);

  const loadAudit = useCallback(() => {
    api(`/admin/audit${auditCategory ? `?category=${auditCategory}` : ''}`)
      .then(setAudit)
      .catch(() => setAudit({ items: [], indexer: null }));
  }, [auditCategory]);

  useEffect(() => {
    loadAudit();
  }, [loadAudit, eventSync?.syncTick]);

  const resolve = async (disputeId, outcome) => {
    setMsg(null);
    try {
      await api(`/admin/disputes/${disputeId}/resolve`, { method: 'POST', body: { outcome, resolution: resolution[disputeId] || undefined } });
      setMsg({ type: 'success', text: `Dispute ${outcome}.` });
      load();
      loadAudit();
    } catch (err) {
      setMsg({ type: 'error', text: describeError(err) });
    }
  };

  const run = async (fn, success) => {
    setBusy(true);
    setMsg(null);
    try {
      await (await fn()).wait();
      setMsg({ type: 'success', text: success });
      load();
    } catch (err) {
      setMsg({ type: 'error', text: reasonOf(err) });
    } finally {
      setBusy(false);
    }
  };

  if (!roles.admin && !roles.dispute) {
    return (
      <div className="adm-page">
        <h1 className="adm-title">Admin</h1>
        <div className="dark-card">This wallet holds neither ADMIN_ROLE nor DISPUTE_ROLE.</div>
      </div>
    );
  }

  return (
    <div className="adm-page">
      <div>
        <h1 className="adm-title">Admin console</h1>
        <p className="text-secondary">
          Roles: {roles.admin ? 'ADMIN_ROLE ' : ''}{roles.dispute ? 'DISPUTE_ROLE' : ''} · production would hold these in a Safe multisig.
        </p>
      </div>
      {msg && <div className={msg.type === 'error' ? 'auth-error' : 'auth-success'}>{msg.text}</div>}

      <section className="dark-card adm-card">
        <h2><HiScale /> Appeals queue</h2>
        {appeals.length === 0 ? (
          <p className="text-secondary">No open appeals.</p>
        ) : (
          <table className="adm-table">
            <thead><tr><th>Loan</th><th>Member</th><th>Classified as</th><th>On</th><th>Decision</th></tr></thead>
            <tbody>
              {appeals.map((l) => (
                <tr key={l.id.toString()}>
                  <td>#{l.id.toString()}</td>
                  <td>#{l.memberId.toString()}</td>
                  <td>{DEFAULT_TYPES[Number(l.dtype)]}</td>
                  <td>{new Date(Number(l.classifiedAt) * 1000).toLocaleDateString()}</td>
                  <td className="adm-actions">
                    {[1, 2, 3].filter((t) => t !== Number(l.dtype)).map((t) => (
                      <button key={t} className="btn btn-outline btn-sm" disabled={busy || !roles.dispute}
                        onClick={() => run(() => defaultManager.reclassify(l.id, t), `Loan #${l.id} reclassified as ${DEFAULT_TYPES[t]}.`)}>
                        → {DEFAULT_TYPES[t]}
                      </button>
                    ))}
                    <button className="btn btn-ghost btn-sm" disabled={busy || !roles.dispute}
                      onClick={() => run(() => defaultManager.dismissAppeal(l.id), `Appeal on loan #${l.id} dismissed.`)}>
                      Dismiss
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="adm-grid">
        <section className="dark-card adm-card">
          <h2><HiLightningBolt /> Systemic-shock mode</h2>
          <p className="text-secondary adm-note">
            For one event that hits a whole cohort (platform outage, city-wide disruption). Longer grace, no late fees or score effects.
            Principal is never waived. The event description is hashed as the attestation.
          </p>
          <input className="form-input" placeholder="Cohort ID (e.g. 202643)" value={shock.cohortId} onChange={(e) => setShock({ ...shock, cohortId: e.target.value })} />
          <input className="form-input" placeholder="Days (max 60)" type="number" value={shock.days} onChange={(e) => setShock({ ...shock, days: e.target.value })} />
          <input className="form-input" placeholder="Attested event, e.g. 'Swiggy outage 2026-10-25'" value={shock.event} onChange={(e) => setShock({ ...shock, event: e.target.value })} />
          <button className="btn btn-gold btn-sm" disabled={busy || !roles.admin || !shock.cohortId || !shock.event}
            onClick={async () => {
              const spd = await policyConfig.secondsPerDay();
              const latest = await wallet.provider.getBlock('latest');
              const until = BigInt(latest.timestamp) + BigInt(Math.round(Number(shock.days))) * spd;
              run(() => identityRegistry.setShockMode(Number(shock.cohortId), until, ethers.id(shock.event)), `Shock mode set for cohort ${shock.cohortId}.`);
            }}>
            Set shock mode
          </button>
        </section>

        <section className="dark-card adm-card">
          <h2><HiFlag /> Cluster flags</h2>
          <input className="form-input" placeholder="Cluster ID (0x…32 bytes)" value={cluster} onChange={(e) => setCluster(e.target.value.trim())} />
          <div className="adm-actions">
            <button className="btn btn-outline btn-sm" disabled={busy || !ethers.isHexString(cluster, 32)}
              onClick={() => run(() => identityRegistry.setClusterFlag(cluster, true), 'Cluster flagged.')}>Flag</button>
            <button className="btn btn-ghost btn-sm" disabled={busy || !ethers.isHexString(cluster, 32)}
              onClick={() => run(() => identityRegistry.setClusterFlag(cluster, false), 'Cluster cleared.')}>Clear</button>
          </div>
          {flagged.length > 0 && (
            <ul className="adm-mono">{flagged.map((c) => <li key={c}>{c.slice(0, 18)}…</li>)}</ul>
          )}
          <h3>Misdeclared debt</h3>
          <input className="form-input" placeholder="Member ID" value={misdeclared} onChange={(e) => setMisdeclared(e.target.value)} />
          <button className="btn btn-outline btn-sm" disabled={busy || !roles.admin || !misdeclared}
            onClick={() => run(() => identityRegistry.flagMisdeclaredDebt(BigInt(misdeclared), true), 'Flagged: score and limit reduced.')}>
            Flag misdeclared debt
          </button>
        </section>
      </div>

      <section className="dark-card adm-card">
        <h2><HiUserGroup /> Cohorts (sign-up week)</h2>
        <table className="adm-table">
          <thead><tr><th>Cohort</th><th>First loans</th><th>First-payment defaults</th><th>Status</th><th>Shock mode</th><th></th></tr></thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.id}>
                <td>{c.id}</td>
                <td>{c.first.toString()}</td>
                <td>{c.fpd.toString()}{c.first > 0n && ` (${((Number(c.fpd) / Number(c.first)) * 100).toFixed(0)}%)`}</td>
                <td>{c.paused ? (c.manual ? 'Paused (manual)' : 'Paused (automatic)') : 'Open'}</td>
                <td>{c.shockUntil > BigInt(Math.floor(Date.now() / 1000)) ? `until ${new Date(Number(c.shockUntil) * 1000).toLocaleDateString()}` : '—'}</td>
                <td>
                  <button className="btn btn-ghost btn-sm" disabled={busy || !roles.admin}
                    onClick={() => run(() => identityRegistry.setCohortPaused(c.id, !c.manual), c.manual ? 'Manual pause lifted.' : 'First loans paused.')}>
                    {c.manual ? 'Lift manual pause' : 'Pause first loans'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dark-card adm-card">
        <h2><HiAdjustments /> Policy parameters</h2>
        <p className="text-secondary adm-note">Every change is bounds-checked on-chain and logged as ParameterUpdated.</p>
        <table className="adm-table">
          <thead><tr><th>Parameter</th><th>Value</th><th>Bounds</th><th></th></tr></thead>
          <tbody>
            {params.map((p) => (
              <tr key={p.name}>
                <td className="adm-mono">{p.name}</td>
                <td>
                  <input className="form-input adm-param-input" value={edits[p.name] ?? p.value.toString()}
                    onChange={(e) => setEdits({ ...edits, [p.name]: e.target.value })} disabled={!roles.admin} />
                </td>
                <td className="text-secondary">{p.min.toString()} – {p.max.toString()}</td>
                <td>
                  {edits[p.name] !== undefined && edits[p.name] !== p.value.toString() && (
                    <button className="btn btn-outline btn-sm" disabled={busy}
                      onClick={() => run(() => policyConfig.setParam(p.key, BigInt(edits[p.name])), `${p.name} updated.`).then(() => setEdits({ ...edits, [p.name]: undefined }))}>
                      Save
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dark-card adm-card">
        <h2><HiDocumentText /> Platform notices and disputes</h2>
        <p className="text-secondary">
          Created when an expulsion passes. Sent only after the 7-day dispute window, if no dispute is upheld and the member
          signed the platform-notice consent. Prototype: "sent" means stored here; nothing leaves the system.
        </p>
        <table className="adm-table">
          <thead><tr><th>Wallet</th><th>Proposal</th><th>Balance</th><th>Window ends</th><th>Status</th><th>Recipient</th></tr></thead>
          <tbody>
            {notices.length === 0 && <tr><td colSpan={6}>No notices.</td></tr>}
            {notices.map((n) => (
              <React.Fragment key={n.id}>
                <tr>
                  <td className="adm-mono">{n.wallet.slice(0, 10)}…</td>
                  <td>#{n.proposalId}</td>
                  <td>{Number(ethers.formatEther(n.amountOutstandingWei || '0')).toFixed(4)} ETH</td>
                  <td>{new Date(n.disputeWindowEndsAt * 1000).toLocaleString()}</td>
                  <td>{n.status.replaceAll('_', ' ')}</td>
                  <td>{n.recipient ? `${n.recipient.platformName} (${n.recipient.contactEmail})` : '—'}</td>
                </tr>
                {n.text && (
                  <tr><td colSpan={6}><pre className="adm-mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{n.text}</pre></td></tr>
                )}
                {n.disputes.map((d) => (
                  <tr key={d.id}>
                    <td colSpan={3}>Dispute: “{d.reason}”</td>
                    <td colSpan={2}>{d.status}{d.resolution ? ` · ${d.resolution}` : ''}</td>
                    <td>
                      {d.status === 'open' && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <input
                            className="adm-input"
                            placeholder="Note (optional)"
                            value={resolution[d.id] || ''}
                            onChange={(e) => setResolution((r) => ({ ...r, [d.id]: e.target.value }))}
                          />
                          <button className="btn btn-gold btn-sm" onClick={() => resolve(d.id, 'upheld')}>Uphold</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => resolve(d.id, 'rejected')}>Reject</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dark-card adm-card">
        <h2><HiClipboardCheck /> Audit log</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {['', 'identity', 'consent', 'reminder', 'notice', 'dispute', 'governance', 'auth'].map((c) => (
            <button key={c || 'all'} className={`btn btn-sm ${auditCategory === c ? 'btn-gold' : 'btn-ghost'}`} onClick={() => setAuditCategory(c)}>
              {c || 'All'}
            </button>
          ))}
          {audit.indexer && (
            <span className="text-secondary" style={{ fontSize: '0.8rem' }}>
              Indexer at block {audit.indexer.lastBlock ?? '—'} · {audit.indexer.proposals} proposals · {audit.indexer.pendingNotices} open notices
            </span>
          )}
        </div>
        <table className="adm-table">
          <thead><tr><th>Time</th><th>Category</th><th>Event</th><th>Wallet</th><th>Details</th></tr></thead>
          <tbody>
            {audit.items.map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.createdAt).toLocaleString()}</td>
                <td>{a.category}</td>
                <td>{a.event}</td>
                <td className="adm-mono">{a.wallet ? `${a.wallet.slice(0, 10)}…` : '—'}</td>
                <td className="adm-mono" style={{ fontSize: '0.75rem' }}>{Object.keys(a.data || {}).length ? JSON.stringify(a.data) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dark-card adm-card">
        <h2><HiMail /> Message log (kept at least 6 months)</h2>
        <button className="btn btn-ghost btn-sm adm-self-start" onClick={() => api('/admin/watcher/tick', { method: 'POST' }).then(load).catch(() => {})}>
          Run the notifier now
        </button>
        <table className="adm-table">
          <thead><tr><th>Created</th><th>User</th><th>Kind</th><th>Contact</th><th>Status</th></tr></thead>
          <tbody>
            {log.map((m) => (
              <tr key={m.id}>
                <td>{new Date(m.createdAt).toLocaleString()}</td>
                <td className="adm-mono">{m.userId.slice(0, 8)}</td>
                <td>{m.kind}</td>
                <td>{m.contactName}</td>
                <td>{m.status === 'queued' ? `queued until ${new Date(m.scheduledFor).toLocaleTimeString()}` : 'sent'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
};

export default AdminPage;
