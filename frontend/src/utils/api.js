// Backend REST client. Cookies carry the httpOnly session; Vite proxies /api to the backend.

export class ApiError extends Error {
  constructor(status, code, issues) {
    super(code);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

const ERROR_TEXT = {
  INVALID_CREDENTIALS: 'Email/phone or password is incorrect.',
  WALLET_MISMATCH: 'This wallet is not the one linked to your account. Switch MetaMask to your linked wallet.',
  ACCOUNT_EXISTS: 'An account with this email or phone already exists.',
  OTP_INVALID: 'That code is not correct.',
  OTP_EXPIRED: 'That code has expired. Request a new one.',
  OTP_LOCKED: 'Too many attempts. Request a new code.',
  WALLET_TAKEN: 'This wallet is already linked to another account.',
  WALLET_ALREADY_LINKED: 'Your account already has a wallet. Unlink it from your profile first.',
  IDENTITY_WALLET_ACTIVE:
    'This identity already has an active wallet. Unlink the old wallet (it must have no open loan) and try again.',
  OPEN_LOAN: 'You cannot unlink your wallet while a loan is open.',
  WALLET_HAS_IDENTITY:
    'This wallet is already registered on-chain with a different identity (one identity per wallet). Link a wallet that has not been registered. In the local demo, Hardhat accounts #10–#18 are free; #1, #2, #6 and #8 are registered at deploy.',
  IDENTITY_BANNED: 'This identity was banned by a member vote and cannot register again.',
  KYC_ALREADY_DONE: 'Identity verification is already done for this account.',
  CONSENT_SIGNATURE_INVALID: 'The consent signature does not match this wallet. Please sign again.',
  CONSENT_EXPIRED: 'The consent signature is too old. Please sign again.',
  CONSENT_REPLAYED: 'A newer consent decision is already recorded.',
  PROOF_EXPIRED: 'The wallet signature expired. Please try again.',
  PROOF_BAD_SIGNATURE: 'The wallet signature does not match this wallet.',
  DISPUTE_WINDOW_CLOSED: 'The 7-day dispute window for this notice has closed.',
  DISPUTE_SIGNATURE_INVALID: 'The dispute must be signed by the wallet the notice is about.',
  SELFIE_REQUIRED: 'Please add a selfie photo.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  NOT_AUTHENTICATED: 'Please log in.',
};

export const describeError = (err) => {
  if (err instanceof ApiError) {
    if (err.code === 'VALIDATION' && err.issues?.length) return err.issues.map((i) => i.message).join(' · ');
    return ERROR_TEXT[err.code] || err.code;
  }
  return err?.shortMessage || err?.reason || err?.message || String(err);
};

export async function api(path, { method = 'GET', body, form, headers } = {}) {
  const init = { method, credentials: 'include', headers: { ...(headers || {}) } };
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'BACKEND_UNREACHABLE');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP_${res.status}`, data.issues);
  return data;
}

/**
 * Coarse device fingerprint for mock cluster assignment (hash only, nothing raw is sent).
 */
export async function deviceFingerprint() {
  const raw = [navigator.userAgent, screen.width, screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
