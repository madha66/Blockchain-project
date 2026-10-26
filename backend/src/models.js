// Mongoose models. Personal data (name, email, phone, identifiers, selfies) lives only here,
// never on-chain. Identifiers are stored encrypted (AES-256-GCM); wallets are lowercase.
import mongoose from "mongoose";

const { Schema, model, models } = mongoose;
const lower = { type: String, lowercase: true, trim: true };
const def = (name, schema) => models[name] || model(name, schema);

// ── Accounts and identity ───────────────────────────────────────────────────

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    contactVerified: { type: Boolean, default: false },
    signupStep: { type: Number, default: 1 },
    wallet: lower,
    identityHash: { type: String, default: null },
    identity: { type: Schema.Types.ObjectId, ref: "Identity", default: null },
    verified: { type: Boolean, default: false }, // on-chain registration seen by the indexer
    verifiedAt: { type: Date, default: null },
    expelled: { type: Boolean, default: false },
    banned: { type: Boolean, default: false },
    role: { type: String, enum: ["member", "admin"], default: "member" },
    timezone: { type: String, default: "Asia/Kolkata" },
    deviceHash: { type: String, default: null },
    fundingWallet: { type: String, default: null },
  },
  { timestamps: true }
);
// One wallet per user; users without a wallet yet are allowed.
userSchema.index({ wallet: 1 }, { unique: true, partialFilterExpression: { wallet: { $type: "string" } } });
userSchema.index({ identityHash: 1 });
export const User = def("User", userSchema);

const identitySchema = new Schema(
  {
    identityHash: { type: String, required: true, unique: true },
    salt: { type: String, required: true },
    identifierType: { type: String, enum: ["pan", "email"], required: true },
    identifierEnc: { type: String, required: true }, // iv:tag:ciphertext (hex), AES-256-GCM
    identifierMasked: { type: String, required: true },
    aadhaarRef: { type: String, default: null }, // last 4 digits only
    selfiePath: { type: String, default: null },
    clusterId: { type: String, required: true },
    clusterOverride: { type: String, default: null },
    cohortId: { type: Number, required: true },
    linkedWallet: { ...lower, default: null },
    contact: { type: Schema.Types.ObjectId, ref: "Contact" },
    banned: { type: Boolean, default: false },
    bannedAt: { type: Date, default: null },
    reinstatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
identitySchema.index({ linkedWallet: 1 });
export const Identity = def("Identity", identitySchema);

export const Contact = def(
  "Contact",
  new Schema({ name: { type: String, unique: true, required: true }, role: String }, { timestamps: true })
);

const otpSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    identifier: { type: String, default: null }, // for /api/identity email codes (hashed)
    purpose: { type: String, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);
otpSchema.index({ user: 1, purpose: 1, createdAt: -1 });
otpSchema.index({ identifier: 1, purpose: 1, createdAt: -1 });
export const Otp = def("Otp", otpSchema);

export const SiweNonce = def(
  "SiweNonce",
  new Schema(
    {
      nonce: { type: String, unique: true, required: true },
      user: { type: Schema.Types.ObjectId, ref: "User", required: true },
      purpose: String,
      expiresAt: Date,
      usedAt: { type: Date, default: null },
    },
    { timestamps: true }
  )
);

export const GigProfile = def(
  "GigProfile",
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: "User", unique: true, required: true },
      platform: String,
      workerId: String,
      monthsActive: Number,
      payoutFrequency: { type: String, enum: ["weekly", "biweekly"] },
      monthlyPayouts: [Number],
      declaredDebts: [{ lender: String, emiInr: Number }],
      assessedMonthlyInr: Number,
      declaredDebtInr: Number,
      stabilityBand: String,
    },
    { timestamps: true }
  )
);

// ── Consent and contacts ────────────────────────────────────────────────────

// Append-only: the latest row per (wallet/user, type) is the current choice.
const consentSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    wallet: { ...lower, default: null },
    type: {
      type: String,
      enum: ["data_use", "autopay", "peer_visibility", "platform_notice", "payout_deduction"],
      required: true,
    },
    granted: { type: Boolean, required: true },
    textVersion: { type: String, default: null },
    signature: { type: String, default: null }, // EIP-191 personal_sign of the exact text + decision
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
consentSchema.index({ wallet: 1, type: 1, timestamp: -1 });
consentSchema.index({ user: 1, type: 1, timestamp: -1 });
export const Consent = def("Consent", consentSchema);

const employerContactSchema = new Schema(
  {
    wallet: { ...lower, default: null },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    platformName: { type: String, required: true },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    verified: { type: Boolean, default: false },
  },
  { timestamps: true }
);
employerContactSchema.index({ wallet: 1 });
employerContactSchema.index({ user: 1 });
export const EmployerContact = def("EmployerContact", employerContactSchema);

export const AttestationRecord = def(
  "AttestationRecord",
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: "User", default: null },
      wallet: lower,
      nonce: { type: String, unique: true },
      expiry: Number,
    },
    { timestamps: true }
  )
);

// ── Messages, notices, disputes, audit ──────────────────────────────────────

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: String,
    title: String,
    body: String,
    contactName: String,
    status: { type: String, enum: ["queued", "sent"], default: "queued" },
    dedupeKey: { type: String, default: undefined },
    scheduledFor: { type: Date, default: Date.now },
    sentAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);
notificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
notificationSchema.index({ user: 1, status: 1, sentAt: -1 });
notificationSchema.index({ status: 1, scheduledFor: 1 });
export const Notification = def("Notification", notificationSchema);

// Third-party (employer/platform) notice after expulsion. Prototype: "sent" = stored here.
const noticeSchema = new Schema(
  {
    wallet: { ...lower, required: true },
    memberId: Number,
    proposalId: Number,
    status: {
      type: String,
      enum: ["pending", "disputed", "sent", "not_sent_no_consent", "cancelled"],
      default: "pending",
    },
    amountOutstandingWei: String,
    text: String,
    recipient: { platformName: String, contactEmail: String },
    disputeWindowEndsAt: Number, // chain timestamp
    createdChainTs: Number,
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);
noticeSchema.index({ wallet: 1, proposalId: 1 }, { unique: true });
noticeSchema.index({ status: 1, disputeWindowEndsAt: 1 });
export const Notice = def("Notice", noticeSchema);

export const Dispute = def(
  "Dispute",
  new Schema(
    {
      notice: { type: Schema.Types.ObjectId, ref: "Notice", required: true },
      wallet: { ...lower, required: true },
      reason: { type: String, required: true },
      status: { type: String, enum: ["open", "upheld", "rejected"], default: "open" },
      resolution: { type: String, default: null },
      resolvedAt: { type: Date, default: null },
    },
    { timestamps: true }
  )
);

const auditSchema = new Schema(
  {
    category: {
      type: String,
      enum: ["auth", "consent", "reminder", "notice", "dispute", "identity", "governance"],
      required: true,
    },
    event: { type: String, required: true },
    wallet: { ...lower, default: null },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    data: { type: Schema.Types.Mixed, default: {} }, // never personal data
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditSchema.index({ createdAt: -1 });
auditSchema.index({ category: 1, createdAt: -1 });
export const AuditLog = def("AuditLog", auditSchema);

// ── On-chain mirrors (written by the indexer) ───────────────────────────────

const eventFields = {
  txHash: { type: String, required: true },
  logIndex: { type: Number, required: true },
  blockNumber: { type: Number, required: true },
  blockHash: String,
  chainTs: Number,
};
const mirror = (name, fields, extraIndexes = []) => {
  const schema = new Schema({ ...eventFields, ...fields }, { timestamps: true });
  schema.index({ txHash: 1, logIndex: 1 }, { unique: true });
  schema.index({ blockNumber: 1 });
  for (const idx of extraIndexes) schema.index(idx);
  return def(name, schema);
};

export const LoanEvent = mirror(
  "Loan",
  {
    loanId: Number,
    memberId: Number,
    wallet: lower,
    kind: Number,
    principalWei: String,
    rateBps: Number,
    nInstallments: Number,
    periodDays: Number,
    installmentWei: String,
  },
  [{ wallet: 1 }, { loanId: 1 }]
);
export const Repayment = mirror(
  "Repayment",
  { wallet: lower, amountWei: String, principalWei: String, interestWei: String, refundWei: String },
  [{ wallet: 1 }]
);
export const DefaultEvent = mirror(
  "Default",
  {
    loanId: Number,
    memberId: Number,
    wallet: lower,
    defaultType: Number,
    stakeUsedWei: String,
    guarantorUsedWei: String,
    reserveUsedWei: String,
    lenderLossWei: String,
    reminder0At: { type: Date, default: null },
    reminder3At: { type: Date, default: null },
  },
  [{ wallet: 1 }, { memberId: 1 }]
);
export const DebtSettlement = mirror(
  "DebtSettlement",
  { memberId: Number, wallet: lower, kind: String, amountWei: String, discountWei: String, fullySettled: Boolean },
  [{ memberId: 1 }]
);
export const Proposal = mirror(
  "Proposal",
  {
    proposalId: { type: Number, required: true },
    kind: { type: String, enum: ["expel", "reinstate"] },
    target: lower,
    proposer: lower,
    snapshotBlock: Number,
    endTime: Number,
    forVotesWei: { type: String, default: "0" },
    againstVotesWei: { type: String, default: "0" },
    status: { type: String, enum: ["active", "executed", "defeated", "cancelled"], default: "active" },
    passed: { type: Boolean, default: null },
    closedAtChainTs: Number,
  },
  [{ proposalId: 1 }, { target: 1 }]
);
export const Vote = mirror(
  "Vote",
  { proposalId: Number, voter: lower, support: Boolean, weightWei: String },
  [{ proposalId: 1, voter: 1 }]
);
export const CreditSnapshot = def(
  "CreditSnapshot",
  (() => {
    const s = new Schema(
      { wallet: lower, memberId: Number, score: Number, limitWei: String, chainTs: Number, reason: String },
      { timestamps: true }
    );
    s.index({ wallet: 1, chainTs: -1 });
    return s;
  })()
);

// Indexer bookkeeping and early-warning inputs.
export const Cursor = def(
  "Cursor",
  new Schema({ _id: String, lastBlock: Number, recentHashes: [{ number: Number, hash: String }] }, { timestamps: true })
);
export const PayoutRecord = mirror("PayoutRecord", { wallet: lower, amountWei: String, sweptWei: String }, [{ wallet: 1 }]);
export const SweepRecord = mirror(
  "SweepRecord",
  { wallet: lower, loanId: Number, amountWei: String, expectedWei: String },
  [{ loanId: 1 }]
);

export const MIRRORS = [LoanEvent, Repayment, DefaultEvent, DebtSettlement, Proposal, Vote, PayoutRecord, SweepRecord];
