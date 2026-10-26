import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { HiBan, HiExclamation, HiIdentification } from 'react-icons/hi';
import '../pages/app/Governance.css';

const eth = (wei) => `${Number(ethers.formatEther(wei ?? 0n)).toFixed(4)} ETH`;
const reasonOf = (err) => err?.reason || err?.revert?.args?.[0] || err?.shortMessage || err?.message || String(err);

/**
 * App-wide status: expelled or banned (debt, settle button, what is closed), an unpaid
 * default balance, or a wallet that still needs identity verification.
 */
const StatusBanner = ({ status, contracts }) => {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  if (!status || status.loading) return null;

  const settle = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await (await contracts.defaultManager.settleClaim({ value: status.settlementQuote })).wait();
      setMsg('Balance settled. Your GLP is released; a member can now propose your reinstatement.');
      status.reload();
    } catch (err) {
      setMsg(reasonOf(err));
    } finally {
      setBusy(false);
    }
  };

  const debtLine = status.outstanding > 0n && (
    <span>
      Outstanding balance <strong>{eth(status.outstanding)}</strong>
      {status.settlementQuote > 0n && status.settlementQuote < status.outstanding && <> · settles today for <strong>{eth(status.settlementQuote)}</strong></>}
    </span>
  );
  const settleButton = status.outstanding > 0n && (
    <button className="btn btn-gold btn-sm" onClick={settle} disabled={busy}>
      {busy ? 'Settling…' : `Repay ${eth(status.settlementQuote)}`}
    </button>
  );

  if (status.expelled || status.banned) {
    return (
      <div className="status-banner status-banner-danger" role="alert">
        <HiBan size={22} />
        <div className="status-banner-body">
          <strong>
            {status.expelled ? 'This wallet was expelled by a member vote.' : 'This identity is banned from registering.'}
          </strong>
          <span>Deposits, new loans and voting are closed. Repaying and settling stay open.</span>
          {debtLine}
          {status.outstanding === 0n && status.expelled && (
            <span>Your debt is cleared. Any verified member can now propose your reinstatement on the Governance page.</span>
          )}
          {msg && <span className="status-banner-msg">{msg}</span>}
        </div>
        <div className="status-banner-actions">
          {settleButton}
          <Link className="btn btn-ghost btn-sm" to="/app/verify">Notices & disputes</Link>
        </div>
      </div>
    );
  }

  if (status.defaulter) {
    return (
      <div className="status-banner status-banner-warning" role="status">
        <HiExclamation size={22} />
        <div className="status-banner-body">
          <strong>You have an unpaid default balance.</strong>
          {debtLine}
          <span>Your GLP stays frozen until it is cleared. Members may vote to expel a wallet that leaves it unpaid.</span>
          {msg && <span className="status-banner-msg">{msg}</span>}
        </div>
        <div className="status-banner-actions">
          {settleButton}
          <Link className="btn btn-ghost btn-sm" to="/app/loans">Loans page</Link>
        </div>
      </div>
    );
  }

  if (!status.verified) {
    return (
      <div className="status-banner status-banner-info" role="status">
        <HiIdentification size={22} />
        <div className="status-banner-body">
          <strong>{status.memberId > 0n ? 'Your identity attestation has expired.' : 'Verify your identity to use the pool.'}</strong>
          <span>A verified identity is needed to deposit, borrow or vote. One identity per wallet.</span>
        </div>
        <div className="status-banner-actions">
          <Link className="btn btn-gold btn-sm" to="/app/verify">Verify identity</Link>
        </div>
      </div>
    );
  }
  return null;
};

export default StatusBanner;
