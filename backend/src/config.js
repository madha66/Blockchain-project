import "dotenv/config";

const env = process.env;

// Hardhat account #19: the local trusted issuer. Test key only; set ISSUER_PRIVATE_KEY in .env.
const DEFAULT_ISSUER_KEY = "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e";

export const config = {
  port: Number(env.PORT || 4000),
  // MongoDB (Atlas in development, mongodb-memory-server in tests). Never logged.
  mongoUri: env.MONGODB_URI || "",
  mongoDb: env.MONGODB_DB || "giglend",
  jwtSecret: env.JWT_SECRET || "dev-insecure-secret",
  issuerKey: env.ISSUER_PRIVATE_KEY || DEFAULT_ISSUER_KEY,
  // 32 bytes, hex. Encrypts stored identifiers and derives the per-identity hash salt.
  idEncryptionKey: env.ID_ENCRYPTION_KEY || "",
  rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
  chainId: Number(env.CHAIN_ID || 31337),
  siweDomain: env.SIWE_DOMAIN || "localhost:5173",
  frontendOrigin: env.FRONTEND_ORIGIN || "http://localhost:5173",
  inrPerEth: Number(env.INR_PER_ETH_DEMO || 100000),
  isTest: env.NODE_ENV === "test",
  authRateLimit: Number(env.AUTH_RATE_LIMIT || 60),
  uploadsDir: env.UPLOADS_DIR || "uploads",
  attestationValidityDays: Number(env.ATTESTATION_VALIDITY_DAYS || 365),
  indexerStartBlock: Number(env.INDEXER_START_BLOCK || 0),
  // Wallets treated as admins in the UI (on-chain roles are still enforced by the contracts).
  adminWallets: (env.ADMIN_WALLETS || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean),
  addresses: {
    IdentityRegistry: env.IDENTITY_REGISTRY_ADDRESS || "",
    LoanManager: env.LOAN_MANAGER_ADDRESS || "",
    DefaultManager: env.DEFAULT_MANAGER_ADDRESS || "",
    LendingPool: env.LENDING_POOL_ADDRESS || "",
    SafeRepayVault: env.SAFE_REPAY_VAULT_ADDRESS || "",
    MockPayoutRouter: env.PAYOUT_ROUTER_ADDRESS || "",
    PolicyConfig: env.POLICY_CONFIG_ADDRESS || "",
    CreditScore: env.CREDIT_SCORE_ADDRESS || "",
    GLPToken: env.GLP_TOKEN_ADDRESS || "",
    ReserveFund: env.RESERVE_FUND_ADDRESS || "",
    DefaulterGovernance: env.GOVERNANCE_ADDRESS || "",
  },
};

// Shown on every member-facing notice (RBI recovery-directions benchmark).
export const GRIEVANCE_LINE =
  "Grievance officer: Meera Iyer, grievance@giglend.test, 1800-000-0000 (mock). Unresolved after 30 days? You may escalate.";

// Seeded community contacts; each member keeps one for life.
export const STAFF_CONTACTS = [
  { name: "Priya Sharma", role: "Community contact" },
  { name: "Arjun Mehta", role: "Community contact" },
  { name: "Kavya Nair", role: "Community contact" },
  { name: "Rahul Verma", role: "Community contact" },
];
