# Implementation plan: login/signup + default handling (GigLend V2 → V3)

Source documents: `docs/CLAUDE_CODE_PROMPT.md` (the task) and `docs/Defaulter_handling.pdf` (the policy).
Branch: `feature/auth-defaulter-handling`. One commit per phase, all tests green at each commit.

Baseline before work: 29 Hardhat tests passing (`GigLendV2`, `EconomicInvariants`, `crossClientSync`).

---

## 1. Contract layout

The prompt puts almost everything in `LoanManager`. One contract with all of that would break the
24 KB EIP-170 limit, so the logic is split by responsibility. Each split is listed in
`IMPLEMENTATION_NOTES.md`.

| Contract | Responsibility | Callable by |
|---|---|---|
| `PolicyConfig` | Every policy number as a named `bytes32` key with a min/max bound. `setParam` checks the bound and emits `ParameterUpdated`. Holds `secondsPerDay`. `keys()` lists all keys for the admin page. | `ADMIN_ROLE` writes, anyone reads |
| `IdentityRegistry` | Members, EIP-712 `MemberAttestation`, `memberOf[wallet]`, `memberByIdHash`, tiers, `clusterFlagged`, cohort first-loan/FPD counters and pauses, `coolingOffUntil`, `permanentlyBarred`, `defaultCount`, `stakeSince`, `isEligible` | `ATTESTER_ROLE` signs; `LOAN_ROLE` (LoanManager, DefaultManager, LendingPool) updates member state; `DISPUTE_ROLE` flags clusters |
| `GLPToken` | ERC-20 share token plus `locked[account]`. `_update` blocks moving or burning locked balance. | `POOL_ROLE` mints and burns; `LOCKER_ROLE` locks and unlocks |
| `LendingPool` | Deposits, withdrawals, FIFO withdrawal queue paid pro rata, `poolValue()` = free cash + `LoanManager.carriedValue()`, stake burn at fair price, disbursement, residual sweep on deposits | Lenders; `LOAN_ROLE` moves loan cash |
| `ReserveFund` | Ring-fenced loss buffer: 10% of repaid interest, late fees, recoveries. Pays `cover()` to the pool and bounties. | `LOAN_ROLE` only for outflows |
| `CreditScore` | Score from 300 to 900 keyed by `memberId`: weighted installments, completed loans, stake age, late marks, restructures, misdeclared-debt penalty, scars (decay to a 30% floor) | `LOAN_ROLE` records; `DISPUTE_ROLE` adjusts |
| `RiskEngine` | Read-only prevention rules: credit-builder-first, ladder, fast climber, 35% burden, per-loan/cluster/weekly-growth/utilisation caps, cohort pause. Also returns the limit breakdown for the Borrow page. | view |
| `LoanManager` | Loan IDs, installments, Builder escrow, stake/guarantor locks, repayment waterfall, income sweep, SafeRepay pulls, `stageOf`, lazy late fee and `InstallmentMissed`, `collect`, `requestRestructure`, `setShockMode`, `carriedValue()`, 1-day penalty-free exit. `markDefault` forwards to `DefaultManager`. | borrowers, anyone (collect / autopay / markDefault) |
| `DefaultManager` | `classify`, the 4-step waterfall, residual claims, `settleClaim`, `settlementQuote`, `startWorkout` / `payWorkout`, `appeal` / `reclassify`, cooling-off at settlement, scars | anyone / borrower / `DISPUTE_ROLE` |
| `SafeRepayVault` | Per-borrower prefunded vault with max pull per installment, a protected minimum balance and an expiry | borrower; `LOAN_ROLE` pulls |
| `MockPayoutRouter` | Mock gig payouts. Records cumulative inflow checkpoints per worker (`inflowSince`) and the last payout amounts, then routes the sweep share to the loan or claim and forwards the rest. | anyone (mock platform) |
| `InterestLib` | Kept as is (kinked model). Adds an amortisation helper; risk-surcharge bands rescaled to 300–900. | library |

All contracts use OpenZeppelin `AccessControl`. The deployer holds `ADMIN_ROLE`, `ATTESTER_ROLE` (backend key) and
`DISPUTE_ROLE`. Production would put `ADMIN_ROLE` behind a Safe multisig (documented, not built).
Rupee amounts never appear in Solidity: `scripts/config.js` converts ₹ to wei with `INR_PER_ETH_DEMO = 100000`
(₹1,000 = 0.01 ETH). The frontend and backend use the same constant.

### Loan model
- `Loan` struct as in prompt section 4, plus schedule fields: `startAt`, `scheduleShift`, `interestRemaining`,
  `curInterestPortion`, `curPrincipalPortion`, `curInterestPaid`, `curPrincipalPaid`, `lateFeeChargedFor`,
  `restructureEndsAt`, `escrow`, `status`.
- Simple interest over the whole tenure is split evenly across `n` installments. The last installment absorbs
  rounding. Each period equals the member's attested payout period (7 or 14 days). `n` must be in [min, max].
- Payment order: fees, then the current installment's interest, then its principal, then the next installment.
  Any excess is refunded. 10% of interest goes to `ReserveFund`. Late and restructure fees also go to `ReserveFund`,
  which pays the bounty.
- One open loan per member, which keeps the wallet-unlink rule simple.

### Pool value and the stake price
- `poolValue = pool.balance + Σ carried(loan)`. Active and Grace loans carry at 100%, Onset at 90%, Significant at 50%.
  Builder loans always carry at 100% because the escrow backs them. Defaulted loans leave the set and carry at 0%.
- Locked stake is applied at the "fair" price, which leaves out the impaired loan's own carry (V2 Approach A).
- Deposits and withdrawals price shares off `poolValue()`, which keeps the 10^6 virtual offset.

---

## 2. Backend (`backend/`)

Express, Prisma (SQLite, portable schema), zod, bcryptjs, jsonwebtoken (httpOnly cookie), siwe, ethers v6,
express-rate-limit, multer. Tests use vitest and supertest.

- `src/app.js` builds the app factory (used by tests). `src/server.js` starts the listener, the chain watcher and the notifier loop.
- Routes:
  - `/api/auth`: signup account, OTP verify/resend, SIWE nonce/verify, login (password or OTP), then SIWE, logout, `/me`
  - `/api/signup`: wallet, kyc, income, consent, status
  - `/api/attestation`
  - `/api/profile`
  - `/api/notifications`
  - `/api/admin`
  - `/api/demo`: mock payouts, time travel (local chain only)
- Services:
  - `otp`: hashed, 5-minute expiry, printed to console
  - `siwe`
  - `identity`: PAN normalisation, `idHash = keccak256(PAN ‖ ID_PEPPER)`, AES-256-GCM selfie at rest
  - `income`: assessed income and stability band
  - `cluster` / `cohort`
  - `attester`: EIP-712
  - `notifier`: quiet hours, named contact, grievance line, help first
  - `earlyWarning`: pure signal functions
  - `watcher`: chain polling
- Personal data stays in SQLite only. On-chain data is limited to hashes, tiers, flags, IDs and timestamps.
  Auth event logs hold userId and event names, never email or phone.

## 3. Frontend

- `AuthContext`, `ProtectedRoute`, and a wallet-mismatch banner that blocks actions.
- Navbar: Sign up / Log in buttons and a profile menu.
- New pages: `SignupPage` (5-step wizard), `LoginPage`, `ProfilePage`, `NotificationsPage` (inbox and bell), `AdminPage`, `DemoPage`.
- Updated pages: Borrow (Builder vs Unsecured, limit breakdown, key fact statement), Loans (stage timeline, schedule, restructure first, quote, workout, appeal), Pool (disclosures, both arrears figures, queue position), Lend (queued withdrawals), Dashboard and Transactions (new events).
- `useEventSync` subscribes to every contract address.
- Vite proxies `/api` to the backend so cookies stay same-origin.

---

## 4. Phases (each ends with a commit and green tests)

1. **Identity and auth.** `PolicyConfig`, `IdentityRegistry` and their tests (replay, expiry, wrong signer, idHash
   inheritance, re-attestation). Backend scaffold with signup wizard, OTP, SIWE, mock KYC, income, consent,
   attestation, login, rate limits, and tests for OTP, SIWE mismatch and duplicate idHash. Frontend: AuthContext,
   Signup/Login/Profile pages, Navbar, route guards, mismatch warning. The existing 29 tests stay untouched.
2. **Loan engine refactor.** `LoanManager` with IDs and installments. `GLPToken` lock hook. `LendingPool` slimmed to the
   pool role. `ReserveFund`, `SafeRepayVault`, `MockPayoutRouter` with income sweep, Builder escrow. Migrate the 29
   tests to the new API: same economic assertions (virtual offset, inflation attack, 90% cap, rate lock, reserve cut,
   interest first, refunds, events). The legacy `borrow`/`repay` ABI is removed because keeping it would not be cheap.
   New tests: locked GLP, Builder escrow release.
3. **Prevention.** `RiskEngine` (credit-builder-first, ladder, fast climber, burden, caps, cohort pause) and
   `CreditScore` rescaled to 300–900 by memberId. Tests that each rule reverts with its reason. Update
   `calculateEstimatedRateBps`.
4. **Lifecycle.** `stageOf`, lazy late fee (once per installment), `InstallmentMissed`, grace with no fee or score
   effect, `collect` with bounty, payment holiday, tenure stretch, guardrails, shock mode. Tests: bounty timing, second
   restructure reverts, shock mode keeps principal, late fee never compounds.
5. **Default and recovery.** `DefaultManager`: classify, waterfall, guarantor, residual claim and 50% sweep,
   settlement quote, `settleClaim`, workout, appeal/reclassify, cooling-off at settlement, scars. Tests: the 3 type
   fixtures, appeal, dust-stake no profit, cooling-off, new-wallet inheritance, scar floor, residual sweep.
6. **Pool accounting.** `poolValue()` provisions, withdrawal queue paid pro rata, disclosures view
   (`portfolioStats`). Tests: provision math, Significant withdrawal price, queue run pro rata. Pool page.
7. **Notifier and early warning.** Watcher, signals, inbox, quiet hours, named contact. Tests for quiet hours and
   message content. Notifications page and bell, Admin page, Demo panel.
8. **Docs and demo.** README, `deploy.js` (all contracts, roles, ABIs/addresses to the frontend, backend `.env`),
   `timeTravel.js` (stages, collect, markDefault), `scripts/demoScenarios.js` (Hardship, Strategic, Fraud),
   `docs/IMPLEMENTATION_NOTES.md`.

## 5. Risks and how they are handled
- **Contract size:** split as above. Check `deployedBytecode` size in a test.
- **Bounded loop in `poolValue()`:** at most `maxActiveLoans` (100) open loans. Documented as a prototype limit.
- **Time compression:** every duration is `days × secondsPerDay` read from `PolicyConfig`.
- **Prisma engines on Windows:** if the download fails, stop and ask before switching ORM.
