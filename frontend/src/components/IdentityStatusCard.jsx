import React from 'react';
import { Link } from 'react-router-dom';
import { ethers } from 'ethers';
import '../pages/app/Governance.css';

const eth = (wei) => `${Number(ethers.formatEther(wei ?? 0n)).toFixed(4)} ETH`;

/** Compact verification / expulsion status for the Dashboard and Wallet pages. */
const IdentityStatusCard = ({ status }) => {
  if (!status || status.loading) return null;
  const standing = status.expelled ? 'Expelled' : status.banned ? 'Identity banned' : status.defaulter ? 'Unpaid default' : 'Good standing';
  return (
    <div className="dark-card gov-card" style={{ marginBottom: 20 }}>
      <div className="gov-rules">
        <div className="gov-rule">
          <span>Identity</span>
          <strong style={{ color: status.verified ? 'var(--success)' : 'var(--warning)' }}>
            {status.verified ? 'Verified' : status.banned ? 'Banned' : status.memberId > 0n ? 'Attestation expired' : 'Not verified'}
          </strong>
        </div>
        <div className="gov-rule">
          <span>Membership</span>
          <strong style={{ color: status.expelled || status.banned ? 'var(--danger)' : status.defaulter ? 'var(--warning)' : 'var(--text-primary)' }}>
            {standing}
          </strong>
        </div>
        <div className="gov-rule">
          <span>Outstanding debt</span>
          <strong>{eth(status.outstanding)}</strong>
        </div>
        <div className="gov-rule" style={{ display: 'flex', alignItems: 'center' }}>
          <Link className="btn btn-ghost btn-sm" to="/app/verify">
            {status.verified ? 'Identity & consents' : 'Verify identity'}
          </Link>
        </div>
      </div>
    </div>
  );
};

export default IdentityStatusCard;
