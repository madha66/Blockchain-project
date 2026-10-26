# GigLend V3: community lending for gig workers

GigLend is a testnet prototype of a lending pool for gig workers. Lenders deposit ETH for GLP
shares; verified members borrow in small installment loans that follow their payout cycle.
V3 adds **signup and login with a verified identity** (one real person, one record) and the
**default-handling policy** in [`docs/Defaulter_handling.pdf`](docs/Defaulter_handling.pdf):
prevent, detect early, cure cheaply, recover only from locked value, book losses in steps,
and treat each default by type with an appeal.
V3.1 adds **community expulsion voting** for members who leave a default unpaid, an
**identity and access layer** (verified identity to deposit, borrow or vote; banned identities
can never return), **debt enforcement** (frozen GLP, set-off on expulsion), a
**consent-based platform notice** with a dispute window, and a **MongoDB Atlas** backend.

> This is a testnet prototype. Rupee amounts and Indian rules are design benchmarks, not
> compliance targets. KYC, OTP, income and payout data all come from **mock** providers.
> Returns are never guaranteed, and the reserve is a loss buffer, not a guarantee.

Design and decisions: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) ·
deviations, parameter values and limitations: [`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md).

---

## Architecture

```
frontend/ (React + Vite + ethers v6)
   │  REST + httpOnly JWT cookie (/api proxied)    │  ethers (MetaMask or the dev wallet)
   ▼                                               ▼
backend/ (Express + Mongoose/MongoDB Atlas)       contracts/ (Solidity 0.8.24, cancun, viaIR + optimizer)
 • signup wizard, mock OTP, SIWE login             • PolicyConfig      every policy number, bounded setters
 • mock KYC → idHash, encrypted selfie             • IdentityRegistry  members, EIP-712 attestations, tiers,
 • income assessment, declared EMIs                                    clusters, cohorts, shock mode, cooling-off
 • consent log (timestamped)                       • LoanManager       installment loans, Builder escrow, stake
 • EIP-712 attester                                                    locks, SafeRepay pulls, income sweep, stages,
 • chain watcher → early-warning signals                               late fee, collect, restructure (+ LoanOpsLib)
 • notifier: 08:00–19:00, named contact,           • RiskEngine        pricing + every prevention rule (quote)
   grievance line, inbox                           • DefaultManager    classification, 4-step waterfall, claims,
 • admin + demo endpoints                                              settlement, workout, appeal, scar
 • identity verify (email+OTP / simulated ID)      • DefaulterGovernance expel / reinstate votes on GLP snapshots
 • signed consents, notices, disputes, audit log
 • chain indexer → MongoDB mirrors + escalation
                                                   • LendingPool       deposits, provisioned poolValue(), FIFO
                                                                       withdrawal queue, fair-price stake burn
                                                   • GLPToken          ERC20Votes shares; locked balance cannot move;
                                                                       frozen while the holder owes a default claim
                                                   • CreditScore       300–900 by memberId, scars with 30% floor
                                                   • ReserveFund       ring-fenced loss buffer
                                                   • SafeRepayVault    prefunded autopay with borrower limits
                                                   • MockPayoutRouter  mock gig payouts, inflow history
                                                   • PortfolioLens     Pool-page disclosures
```

- Contracts reference each other through addresses set once at deploy
  ([`scripts/lib/protocol.js`](scripts/lib/protocol.js) is the single source of wiring and roles).
- Roles use OpenZeppelin `AccessControl`: `ADMIN_ROLE`, `ATTESTER_ROLE`, `DISPUTE_ROLE`, plus
  internal `LOAN_ROLE` / `POOL_ROLE` / `LOCKER_ROLE` / `DEFAULT_ROLE` / `ROUTER_ROLE`. Locally the
  deployer holds the admin roles. **In production `ADMIN_ROLE` and `DISPUTE_ROLE` belong behind a
  Safe multisig.**
- Only `LoanManager` and `DefaultManager` move pool cash for loans, call `CreditScore`, or draw
  on `ReserveFund`.
- No personal data goes on-chain. The chain holds hashes, tiers, flags, cluster/cohort IDs and
  timestamps only.

## How the policy maps to code

| Policy (PDF) | Where |
|---|---|
| One person, one record; a new wallet inherits history | `IdentityRegistry.register` (idHash → member), `unlinkWallet` (no open loan) |
| Credit-builder first, capped ladder, fast-climber hold, 35% burden, cohort pause, 2% / 5% / weekly caps, 90% utilisation | `RiskEngine.quote` / `limits` |
| Stake locked for the life of a loan | `GLPToken._update`, `LoanOpsLib.lockStake` |
| Repayment follows income (sweep), autopay by default | `MockPayoutRouter.payout` → `LoanManager.applySweep`; `SafeRepayVault` + `LoanManager.autopay` |
| Stages computed on read, no keeper | `LoanManager.stageOf` |
| Flat capped late fee once per installment; Grace has no fee | `LoanManager._accrueLate` |
| `collect` (Significant) and `markDefault` (day 30/45) with bounty | `LoanManager.collect`, `DefaultManager.markDefault` |
| Payment holiday, tenure stretch, 1 per loan, 2 per 12 months | `LoanOpsLib.restructure` |
| Systemic-shock mode | `IdentityRegistry.setShockMode` |
| Classification, waterfall, residual claim, settlement, workout, appeal | `DefaultManager` |
| Cooling-off starts at settlement; re-entry via Builder | `DefaultManager._onClaimCleared`, `RiskEngine.limits` |
| Book losses in steps (100 / 90 / 50 / 0%) | `LoanManager.carriedValue` → `LendingPool.poolValue` |
| Withdrawal queue paid pro rata | `LendingPool.withdraw` / `_processQueue` |
| Score 300–900 and a scar that fades to a 30% floor | `CreditScore` |
| Early warning, named contact, contact hours | `backend/src/services/{earlyWarning,notifier,watcher}.js` |
| Expel / reinstate by member vote | `DefaulterGovernance` |
| Verified identity to deposit, borrow or vote; banned identities never return | `IdentityRegistry.isVerified` / `banIdentity`, `LendingPool.deposit`, `RiskEngine` |
| Frozen GLP and set-off on expulsion | `GLPToken._update` (`Debt outstanding`), `DefaultManager.seizeStakeForClaim` |
| Reminders, consent-gated platform notice, disputes | `backend/src/services/{indexer,notices,consents}.js` |

---

## Local setup

Prerequisites: Node.js 20+ (tested on 24), npm, MetaMask (optional; see the dev wallet below).

```bash
npm install
```

```bash
cd backend && npm install && cp .env.example .env && cd ..
```

Fill in `backend/.env` (it is git-ignored; the code reads every secret from `process.env` only):

- `MONGODB_URI` and `MONGODB_DB`: the Atlas connection string from **Atlas → Connect → Drivers**.
  **Atlas → Network Access must allow your current IP address**, or the connection times out.
- `ISSUER_PRIVATE_KEY`: the trusted identity issuer. Locally this is Hardhat account #19
  (`0x8626…1199`); `deploy.js` grants it `ATTESTER_ROLE`.
- `ID_ENCRYPTION_KEY`: 32 random bytes as hex. It encrypts stored identifiers (AES-256-GCM) and
  derives the identity-hash salt, so keep it stable once members exist.
- `RPC_URL=http://127.0.0.1:8545`, `CHAIN_ID=31337`.

Check the database connection (prints `connected` or the error, never the URI):

```bash
cd backend && npm run db:ping
```

```bash
cd frontend && npm install && cd ..
```

Run each of the following in its own terminal, in order:

```bash
npx hardhat node
```

```bash
npm run deploy:local
```

`deploy:local` deploys and wires every contract, grants roles, writes ABIs and
`frontend/src/contracts/addresses.json`, and writes the addresses into `backend/.env`.

```bash
cd backend && npm start
```

`npm start` runs the API and, in the same process, the chain indexer (event mirrors, reminders,
notice timeline). To run the indexer on its own, set `INDEXER_IN_PROCESS=false` and run:

```bash
cd backend && npm run indexer
```

After a fresh chain, run `npm run db:reset` so old wallets, identities and mirrors do not linger
(the indexer also rebuilds its mirrors when it finds the chain was restarted).

```bash
cd frontend && npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to the backend on port 4000.

### Seed the demo (optional)

With the node, backend and a fresh deploy running:

```bash
cd backend && npm run seed:demo
```

```bash
npm run demo:scenarios
```

`seed:demo` signs up five accounts through the real API (OTP, SIWE, KYC, income, consent,
on-chain registration). `demo:scenarios` then lends 20 ETH, runs credit-builder loans, moves
chain time about 130 days and produces one **Hardship**, one **Strategic** and one **Fraud**
default, plus one borrower in good standing:

| Login (password `demo-password-1`) | Hardhat account | Story |
|---|---|---|
| `90f79b@demo.giglend.test` (Asha) | #3 | Hardship default → workout plan |
| `15d34a@demo.giglend.test` (Vikram) | #4 | Strategic default (payouts kept arriving) |
| `996550@demo.giglend.test` (Ravi) | #5 | Fraud: first-payment default with no stake; barred |
| `14dc79@demo.giglend.test` (Meena) | #7 | Open Unsecured loan with autopay |
| `f39fd6@demo.giglend.test` (Ops Admin) | #0 | Holds ADMIN_ROLE + DISPUTE_ROLE → Admin console |

### Wallets

- **MetaMask:** add network `http://127.0.0.1:8545`, chain ID `31337`, and import the Hardhat
  test key of the account you want (they are printed by `npx hardhat node`; test keys only).
- **Dev wallet (no MetaMask):** in the Vite dev server only, open any page with
  `?devwallet=<n>` (for example `http://localhost:5173/login?devwallet=3`). It forwards wallet
  requests to the local node, whose Hardhat accounts are unlocked. Use `?devwallet=off` to
  turn it off. It does nothing in production builds.

### Time travel and keepers

```bash
node scripts/timeTravel.js help
```

```bash
node scripts/timeTravel.js advance 11
```

```bash
node scripts/timeTravel.js status 5
```

```bash
node scripts/timeTravel.js 31
```

The last form advances 31 days and calls `markDefault` on every loan past its default day.
`collect <loanId>` and `default <loanId>` run single keeper actions. The in-app **Demo panel**
does the same from the browser: mock payouts, +N days, the notifier, `collect`, `markDefault`.
Days are policy days (`PolicyConfig.secondsPerDay`), so lowering that parameter compresses
the whole timeline for a live demo.

---

## Identity, governance and debt rules

### Identity and access (IAM)

- **Verified identity is required to deposit, borrow or vote.** `IdentityRegistry.isVerified(wallet)`
  is true when the wallet is registered, its EIP-712 attestation from the trusted issuer has not
  expired, and its identity is not banned.
- **Two ways to verify**, on the **Identity** page or through the sign-up wizard: email + one-time
  code, or a simulated ID number (PAN format). `POST /api/identity/verify` checks a wallet
  signature, refuses banned and duplicate identities, records the signed consents and returns
  the issuer-signed attestation, which the wallet submits with `IdentityRegistry.register`.
- **One identity per wallet, one wallet per identity.** The identity hash is
  `keccak256(salt ‖ normalised identifier)` with `salt = HMAC-SHA256(ID_ENCRYPTION_KEY, type:identifier)`;
  the identifier itself is stored only encrypted.
- **A banned identity can never register again** (`Identity banned`), from any wallet.
  Only the governance contract can call `banIdentity` / `unbanIdentity`.

### Voting rules (`DefaulterGovernance`)

| Rule | Value |
|---|---|
| Who can be proposed for expulsion | A member with an unpaid default claim, not already expelled |
| Who can propose | A verified member holding GLP, not the target; one open proposal per target |
| Voting power | GLP held at the snapshot block (the block before the proposal). GLP self-delegates on receipt, so no delegation step is needed; GLP moved after the snapshot does not count twice |
| Who can vote | Verified members with GLP at the snapshot; the target and expelled wallets cannot |
| Voting period | 3 policy days (`secondsPerDay`-scaled, so time travel and compressed days work) |
| Quorum | 20% of GLP supply at the snapshot |
| To pass | More than 50% of votes cast (an exact tie fails) |
| Cancel | Anyone, once the target has cleared the debt |
| Execute a passed expulsion | Bans the identity, marks the wallet expelled, applies its GLP to the debt |
| Reinstate | A separate proposal, allowed only once the debt is settled; lifts the ban; the CreditScore history stays |

### Debt enforcement

- Expelled or unverified wallets cannot deposit or borrow. **Repaying and settling always stay open.**
- On expulsion, the wallet's GLP is applied to the debt at the pool's fair share price and burned
  (`DefaultManager.seizeStakeForClaim`). Any GLP left over stays with the wallet.
- While a default claim is unpaid, GLP is **frozen**: `withdraw` and transfers revert with
  `Debt outstanding`. GLP also stays locked during an active loan.

### Consent-based reminders and platform notices

1. **Day 0** after a default: a reminder in the member's inbox. **Day 3**: a second reminder.
2. **On expulsion**: a platform notice is created as *pending*, with a **7-day dispute window**
   (chain time). The member can dispute it from the Identity page (wallet-signed).
3. After the window, the notice becomes **sent** only if no dispute is upheld, the debt is still
   unpaid, and the member gave the **platform-notice consent** and named a platform contact.
   Without that consent it is marked *not sent: no consent*. A disputed notice waits for the admin decision.
4. Every step goes to the audit log (Admin page).

The two consents (**platform notice** and **payout deduction**) are optional, shown in full, and
signed with the wallet (EIP-191 `personal_sign`, with a timestamp so an old decision cannot be
replayed). Members can view and withdraw them at any time. Notice text is neutral and factual.
**GigLend never names a defaulter publicly and never contacts family, friends or phone contacts.**

> **Compliance:** any third-party notice and any payout deduction must comply with India's
> digital lending regulations (RBI Digital Lending Directions, including the recovery and
> grievance rules) and the **Digital Personal Data Protection Act, 2023**. This prototype only
> **simulates** sending: the notice sender is an interface whose default implementation does
> nothing, and "sent" means the notice is stored in MongoDB and shown on the Admin page.

## A demo walk-through

1. **Sign up** (`/signup`): account → mock OTP (printed in the backend console) → link wallet
   with SIWE → PAN-format string + Aadhaar last 4 + selfie → gig platform, payouts and every EMI →
   consent → **Register on-chain** (submits the signed EIP-712 attestation).
2. **Borrow** a credit-builder loan: the money stays in escrow. Repay every installment and it
   is released to you.
3. After 90 days of stake, take a first **Unsecured** loan of ₹1,000 (0.01 ETH) with 50% stake
   cover. The Borrow page explains every limit and shows a live key fact statement.
4. Miss an installment and use **+1 / +4 / +11 / +30 days** on the Demo panel. The Loans page
   timeline moves Grace → Onset → Significant → Default. The pool value drops by stage, and
   notices arrive in the inbox (only between 08:00 and 19:00 local time; otherwise queued).
5. **Restructure** (before due or in Onset), or let it default: see the classification, the
   waterfall in the Transactions ledger, the settlement quote, the workout or the appeal.
6. Try a **fresh wallet with the same PAN**: KYC refuses while the old wallet is active. After
   the old wallet is unlinked, the new one joins the same member record, with the default and the
   cooling-off still in place.
7. **Governance** (after `demo:scenarios`): as Vikram (`?devwallet=4`), open **Identity** and agree
   to the platform-notice consent with a platform contact. As the lender (`?devwallet=0`), open
   **Governance**, propose Vikram's expulsion and vote. Advance 3 days
   (`node scripts/timeTravel.js advance 3`) and **Execute**: Vikram sees the expelled banner,
   deposits and borrowing close, and a pending notice appears. Vikram can dispute it; the Admin
   page upholds or rejects the dispute. After 7 more days the notice is *sent* (simulated).
   Vikram repays from the banner, and a **reinstatement** proposal restores the wallet.
8. **Verify a new wallet** (`?devwallet=12`) on the **Identity** page with a simulated ID number.
   Re-using an ID that is linked to another wallet, or one that was banned, is refused.

---

## Policy parameters

Every number below lives in `PolicyConfig`, is changed only through a bounds-checked
`setParam` that emits `ParameterUpdated`, and is editable on the Admin page. Rupee figures are
converted with `INR_PER_ETH_DEMO = 100000` (₹1,000 ≈ 0.01 ETH) in `scripts/config.js` and the
frontend/backend config. No rupee amount appears in Solidity.

| Parameter | Demo value | Bounds |
|---|---|---|
| `secondsPerDay` | 86400 s | 1 s – 86400 s |
| `tierBuilderLoans` | 1 | 0 – 100 |
| `tierStandardLoans` | 2 | 0 – 100 |
| `tierTrustedLoans` | 4 | 0 – 100 |
| `tierPrimeLoans` | 8 | 0 – 100 |
| `tierStandardScore` | 600 | 300 – 900 |
| `tierTrustedScore` | 700 | 300 – 900 |
| `tierPrimeScore` | 800 | 300 – 900 |
| `minInstallments` | 2 | 1 – 12 |
| `maxInstallments` | 12 | 2 – 52 |
| `penaltyFreeExitDays` | 1 d | 1 d – 7 d |
| `maxActiveLoans` | 100 | 1 – 200 |
| `builderLoansRequired` | 1 | 1 – 2 |
| `builderMaxWei` | 0.02 ETH (≈ ₹2,000) | 0.001 ETH (≈ ₹100) – 10 ETH (≈ ₹10,00,000) |
| `firstUnsecuredCapWei` | 0.01 ETH (≈ ₹1,000) | 0.001 ETH (≈ ₹100) – 10 ETH (≈ ₹10,00,000) |
| `stakeAgeRequiredDays` | 90 d | 0 d – 365 d |
| `unsecuredStakeCoverBps` | 50% | 0% – 100% |
| `ladderMultiplierBps` | 150% | 100% – 200% |
| `ladderEarlyMultiplierBps` | 125% | 100% – 200% |
| `ladderEarlySteps` | 2 | 0 – 10 |
| `ladderStepCapWei` | 0.05 ETH (≈ ₹5,000) | 0.001 ETH (≈ ₹100) – 10 ETH (≈ ₹10,00,000) |
| `fastClimberWindowDays` | 60 d | 0 d – 365 d |
| `burdenBps` | 35% | 10% – 50% |
| `misdeclaredLimitCutBps` | 50% | 0% – 100% |
| `sweepBps` | 20% | 15% – 30% |
| `maxUtilizationBps` | 90% | 50% – 95% |
| `perLoanCapBps` | 2% | 0.1% – 100% |
| `clusterCapBps` | 5% | 0.1% – 100% |
| `weeklyGrowthCapBps` | 10% | 0.1% – 100% |
| `cohortFpdThresholdBps` | 20% | 1% – 100% |
| `cohortMinSample` | 5 | 1 – 1000 |
| `graceDaysShort` | 3 d | 1 d – 7 d |
| `graceDaysLong` | 7 d | 3 d – 14 d |
| `onsetEndDay` | 10 d | 5 d – 20 d |
| `defaultDayShort` | 30 d | 15 d – 60 d |
| `defaultDayLong` | 45 d | 30 d – 90 d |
| `longLoanDays` | 90 d | 30 d – 365 d |
| `lateFeeFlatWei` | 0.0005 ETH (≈ ₹50) | 0 ETH (≈ ₹0) – 0.01 ETH (≈ ₹1,000) |
| `lateFeeCapBps` | 10% | 0% – 25% |
| `bountyShareBps` | 10% | 0% – 50% |
| `holidayFeeWei` | 0.0002 ETH (≈ ₹20) | 0 ETH (≈ ₹0) – 0.005 ETH (≈ ₹500) |
| `carryOnsetBps` | 90% | 0% – 100% |
| `carrySignificantBps` | 50% | 0% – 100% |
| `termPremiumBps` | 2% | 0% – 20% |
| `incomeDropBps` | 80% | 10% – 100% |
| `maxRestructuresPer12m` | 2 | 0 – 4 |
| `restructureWindowDays` | 365 d | 30 d – 730 d |
| `shockExtraGraceDays` | 7 d | 0 d – 30 d |
| `shockMaxDays` | 60 d | 1 d – 180 d |
| `reserveFactorBps` | 10% | 0% – 50% |
| `residualSweepBps` | 50% | 0% – 100% |
| `discountHardshipBps` | 25% | 0% – 50% |
| `discountStrategicBps` | 5% | 0% – 25% |
| `discountFraudBps` | 0% | 0% – 0% |
| `coolingHardshipDays` | 30 d | 0 d – 365 d |
| `coolingStrategicDays` | 365 d | 30 d – 1095 d |
| `appealWindowDays` | 21 d | 7 d – 60 d |
| `workoutMaxDays` | 180 d | 30 d – 180 d |
| `fraudThinStakeDays` | 30 d | 0 d – 180 d |
| `maxQueueLength` | 50 | 1 – 200 |
| `scoreBase` | 550 | 300 – 900 |
| `installmentPoints` | 4 pts | 0 pts – 50 pts |
| `loanPoints` | 15 pts | 0 pts – 100 pts |
| `stakeAgeMaxPoints` | 30 pts | 0 pts – 100 pts |
| `stakeAgeFullDays` | 365 d | 1 d – 1095 d |
| `lateMarkPoints` | 10 pts | 0 pts – 100 pts |
| `restructurePoints` | 5 pts | 0 pts – 100 pts |
| `misdeclaredPoints` | 40 pts | 0 pts – 200 pts |
| `weightOnTimeBps` | 100% | 0% – 100% |
| `weightGraceBps` | 60% | 0% – 100% |
| `weightLateBps` | 20% | 0% – 100% |
| `scarStrategicPoints` | 90 pts | 0 pts – 300 pts |
| `scarHardshipPoints` | 60 pts | 0 pts – 300 pts |
| `scarFloorBps` | 30% | 0% – 100% |
| `scarDecayDays` | 730 d | 30 d – 1825 d |
| `settleScarBps` | 70% | 30% – 100% |
| `workoutScarBps` | 60% | 30% – 100% |

---

## Tests

```bash
npx hardhat test
```

```bash
cd backend && npm test
```

Backend tests run on **mongodb-memory-server** and never touch the Atlas cluster (the first run
downloads a MongoDB binary).

| Suite | Covers |
|---|---|
| `test/GigLendV2.test.js`, `EconomicInvariants.test.js`, `crossClientSync.test.js` | The 29 V2 tests migrated to the new engine: virtual-offset shares, inflation attack, 90% cap (same-block race), rate lock, interest-first repayment with a 10% reserve cut, refunds, fair-price stake set-off at the exact share threshold, claim recovery, event sync |
| `test/IdentityRegistry.test.js` | Bounded parameters, attestation replay / expiry / wrong signer / tampering, re-attestation, one active wallet per identity, inheritance |
| `test/LoanEngine.test.js` | Locked GLP cannot move, stake cover and guarantors, Builder escrow released only on full repayment, SafeRepay limits, income sweep, contract sizes |
| `test/Prevention.test.js` | Builder-first, 90-day stake, ₹1,000 first cap, 1.5× ladder and early steps, fast-climber hold, 35% burden, misdeclared debt, 2% / 5% / weekly caps, cohort pause, score events |
| `test/Lifecycle.test.js` | Stage boundaries, Grace without fee or score effect, one non-compounding late fee per installment, `collect` timing and bounty, restructures and limits, shock mode never touching principal |
| `test/DefaultRecovery.test.js` | Dust-stake attacker earns nothing, the three default types, appeal and reclassify, waterfall order, settlement and cooling-off, residual sweep, workout, new-wallet inheritance, second default, scar floor |
| `test/PoolAccounting.test.js` | Stage provisions and cure, lower price for a Significant-stage withdrawal, pro rata queue, disclosures |
| `test/Governance.test.js` | Bans and IAM views, proposer and voter rules, snapshot weight without double voting, quorum and tie edges, execution bans and seizes GLP, banned identity cannot re-register, expelled wallets can only repay or settle, frozen GLP, reinstatement |
| `backend/test/auth.test.js` | OTP flow, SIWE login with wallet mismatch rejected, nonce replay, resumable wizard, duplicate idHash attaches to the existing identity, attestation signature |
| `backend/test/identityNotices.test.js` | Identity verification, banned and duplicate identities refused, one identity per wallet, signed consents and replay protection, consent required before a notice is sent, dispute window, dispute outcomes, neutral wording |
| `backend/test/notifier.test.js` | Quiet hours and queueing, named contact and grievance line on every message, help first, retention, early-warning signals |

---

## Limitations (prototype)

- **Bounded loop:** `poolValue()` iterates at most `maxActiveLoans` (100) open loans. A
  production pool would need checkpointed provisions or an off-chain-proven aggregate.
- **Mock oracles:** KYC, OTP, income and payouts are mocks. The attester is a single local key.
  Production would use zk identity (e.g. Anon Aadhaar), Account Aggregator data and a
  regulated partner for credit-bureau reporting.
- **Single-key admin:** the deployer holds `ADMIN_ROLE` / `DISPUTE_ROLE` locally. Production needs a
  Safe multisig and published dispute procedures.
- **One open loan per member**, native ETH only, simple interest, demo-sized amounts.
- **EIP-7702 autopay** (delegating a plain wallet to SafeRepay limits) is future work. The prototype
  uses a prefunded vault.
- **Simulated identity:** an email OTP or a made-up ID number will not stop a determined Sybil
  attacker with many emails. Production needs a real KYC or zk identity provider; the ban only
  holds as long as one person maps to one identifier.
- **Governance is plutocratic:** votes follow GLP, so a large lender can decide alone (as in the
  demo). Production would add a cap per voter, a timelock and an appeal path.
- **Notices are simulated:** nothing is emailed; see the compliance note above.
- **Reorg handling** rolls mirrored events back and re-reads wallet flags from the chain, but
  inbox messages already delivered are not withdrawn.
- Full list of deviations from the PDF: [`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md).

---

## 👥 Team Contributions

- **Poovannaraajan (23BCE0759):** Smart Contracts (`LendingPool.sol`, `GLPToken.sol`, `InterestLib.sol`), mathematical modeling of virtual offsets, Hardhat test suites.
- **Madhan Kumar (23BCB0065):** Frontend Architecture (React + Vite), UI components, Ethers.js integration, cross-client event synchronization (`useEventSync.js`).
- **Sanjay Jaishankar (23BCB0078):** Credit Scoring Engine (`CreditScore.sol`), default settlement waterfall (Approach A), risk modeling, unit test coverage.
