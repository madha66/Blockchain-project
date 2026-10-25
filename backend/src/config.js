import "dotenv/config";

const env = process.env;

export const config = {
  port: Number(env.PORT || 4000),
  jwtSecret: env.JWT_SECRET || "dev-insecure-secret",
  attesterKey:
    env.ATTESTER_PRIVATE_KEY || "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  idPepper: env.ID_PEPPER || "dev-pepper",
  rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
  chainId: Number(env.CHAIN_ID || 31337),
  siweDomain: env.SIWE_DOMAIN || "localhost:5173",
  frontendOrigin: env.FRONTEND_ORIGIN || "http://localhost:5173",
  inrPerEth: Number(env.INR_PER_ETH_DEMO || 100000),
  isTest: env.NODE_ENV === "test",
  authRateLimit: Number(env.AUTH_RATE_LIMIT || 60),
  uploadsDir: env.UPLOADS_DIR || "uploads",
  attestationValidityDays: Number(env.ATTESTATION_VALIDITY_DAYS || 180),
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
