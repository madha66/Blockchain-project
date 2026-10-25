# Task: Add login/signup and default handling to GigLend V2

You are working in the GigLend V2 repository. It has Hardhat and Solidity 0.8.20 contracts in `contracts/` and a React, Vite and ethers v6 frontend in `frontend/`. Implement two linked features:

1. **Signup and login with verified identity.** One real person gets exactly one member record. A new wallet cannot escape an old default.
2. **The full default-handling policy** in `docs/Defaulter_handling.pdf` (copy the PDF there before starting). The policy covers prevention, early warning, cheap cures, recovery from locked value, booking losses in steps, and handling each default by type with an appeal.

This is a **testnet prototype**. Rupee amounts and Indian rules in the PDF are benchmarks, not compliance targets. All KYC, OTP, income and payout data comes from **mock** providers.

Read this whole prompt and the PDF first. Then read every file in `contracts/`, `test/`, `scripts/` and `frontend/src/`. Then write a plan in `docs/IMPLEMENTATION_PLAN.md` and work phase by phase. The phases are in section 9.

---

## 0. Ground rules

- Create a branch: `git checkout -b feature/auth-defaulter-handling`. Three files are already modified locally: `frontend/src/contracts/*.json` and `frontend/src/utils/contractHelpers.js`. They are deploy output. Commit them separately first, with the message "chore: sync local deploy artifacts", or ask me.
- Commit at the end of every phase, with all tests passing. Do not push unless I ask.
- **No personal data on-chain, ever.** On-chain data is limited to hashes, tiers, flags, cluster/cohort IDs and timestamps.
- Keep what already works and is tested in V2:
  - the 10^6 wei virtual-offset share math
  - the kinked rate model (`InterestLib`)
  - the 90% utilisation cap
  - the 10% reserve cut of repaid interest
  - interest paid before principal, with refunds of any overpayment
  - the events that feed `useEventSync`
- Every policy number below must be a named parameter with a **bounded admin setter**: min/max enforced, and an event emitted on change. Use `secondsPerDay` everywhere so demos can compress time. Keep the existing `scripts/timeTravel.js` working and extend it.
- Rupee figures are converted to ETH through one config constant, `INR_PER_ETH_DEMO` (in deploy config and the frontend). Default it so ₹1,000 ≈ 0.01 ETH. Never hard-code rupee amounts in Solidity.
- Watch contract size: split contracts as described below and keep `viaIR` plus the optimizer.

---

## 1. Gaps in today's V2 that must be closed

1. **Borrower stake isn't locked.** A borrower can `withdraw` or transfer GLP after borrowing, so stage 1 of the default waterfall recovers nothing. Lock stake while any loan is open, and make locked GLP non-transferable.
2. **The cooldown starts at the wrong time.** `penalizeDefault` starts the cooldown at default. It must start at **settlement**.
3. **A fresh wallet does better than a rehabilitated one.** A new wallet starts at score 50 with a 0.5 ETH limit. Identity binding (section 3) plus credit-builder-first re-entry fixes this.
4. **The score can be gamed.** Every partial repayment counts as a repayment, and late penalties stack per partial payment. Count **completed installments and loans**, and apply **one** late mark per overdue installment.
5. **`simulatedIncome` is unused.** Replace it with the attested income from signup.
6. **`markDefault` has no caller incentive.** Add the bounty from section 6.

---

## 2. Target architecture

```
frontend (React)
   │  REST + JWT        │  ethers (MetaMask)
   ▼                    ▼
backend/ (Node + Express + Prisma + SQLite)       contracts/
 • auth: email/phone OTP + SIWE                   • IdentityRegistry.sol    (members, attestations, clusters, cohorts, scar)
 • mock KYC, income, declared debts               • LendingPool.sol         (deposits, withdrawals, withdrawal queue, poolValue w/ provisions)
 • EIP-712 attester (signs member attestations)   • LoanManager.sol         (loan ids, installments, stages, collect, restructure, markDefault, classify, claims, workouts, appeals, shock mode)
 • event watcher → early-warning signals          • ReserveFund.sol         (ring-fenced loss buffer)
 • notifier (in-app inbox, contact-hour rules)    • StakeVault (or inside LendingPool): locked borrower + guarantor GLP
 • mock payout feeder                             • MockPayoutRouter.sol    (gig payouts flow through here → income sweep)
 • disputes / admin endpoints                     • GLPToken.sol            (add lock-aware transfer hook)
                                                  • CreditScore.sol         (rescaled score + scar + ladder)
                                                  • libraries/InterestLib.sol (keep; add amortisation helper)
```

- **Database:** use SQLite through Prisma so it runs with no setup. Keep the schema portable to PostgreSQL.
- **Admin:** use OpenZeppelin `AccessControl` with `ADMIN_ROLE`, `ATTESTER_ROLE` and `DISPUTE_ROLE`. Document that production would put `ADMIN_ROLE` behind a multisig (Safe). Locally, the deployer holds the roles.
- **Wiring:** contracts reference each other through addresses set once in deploy. `LoanManager` is the only contract allowed to move pool funds for loans, call into `CreditScore`, and draw from `ReserveFund`.

---

## 3. Signup, login and identity (one person, one record)

### Backend (`backend/`)
- Stack: Express, Prisma (SQLite), zod validation, bcrypt/argon2, jsonwebtoken, `siwe`, and ethers v6 for EIP-712 signing. Put `.env.example` in `backend/` with `JWT_SECRET`, `ATTESTER_PRIVATE_KEY` (a Hardhat test key), `ID_PEPPER` and `RPC_URL`.
- **Signup wizard endpoints** (each step saved, resumable):
  1. **Account:** name, email, phone, password. A mock OTP is printed to the server console and stored hashed with a 5-minute expiry. Email and phone are unique.
  2. **Link wallet:** SIWE (EIP-4361) nonce, then the user signs, then the server verifies. A wallet links to exactly one user, and the link cannot change while a loan is open.
  3. **Mock KYC:** the user enters a PAN-format string and an Aadhaar last-4/reference (never store a full Aadhaar), and uploads a selfie stored locally and encrypted at rest. `idHash = keccak256(normalisedPAN ‖ ID_PEPPER)`. **If the `idHash` already exists, the new wallet is attached to the same member record** (it inherits the history). A second active wallet is not allowed. The old one must be unlinked first, and only when it has no open loan.
  4. **Gig and income profile:** platform, worker ID, months active, payout frequency (weekly/biweekly), 3–6 mock monthly payout figures, and **all declared existing debts** (EMIs). The server computes assessed monthly income and an income-stability band.
  5. **Consent:** data use, autopay (SafeRepay/income sweep, on by default with opt-out), and an optional lending-circle peer-visibility opt-in. Store consent records with timestamps (DPDP-style).
- **Cluster and cohort assignment (mock):**
  - `cohortId` = signup ISO week.
  - `clusterId` = a hash of linked signals: the same phone prefix plus device fingerprint plus funding wallet, or simply an admin-assigned value for demo fixtures.
- **Attestation:** after a successful step 5, the server signs an EIP-712 `MemberAttestation{wallet, idHash, incomeTierWei, declaredDebtWei, payoutPeriodDays, clusterId, cohortId, nonce, expiry}` with the attester key. The user submits it on-chain to `IdentityRegistry.register(attestation, sig)`, and the contract verifies it with ECDSA. Re-attestation updates income, debts and expiry.
- **Login:** email/phone + password (or OTP), **then** a SIWE signature. The session is valid only if the signing wallet equals the linked wallet. JWT is held in an httpOnly cookie. Logout and `/me` endpoints are included.
- Rate-limit auth routes. Log auth events without personal data.

### Contract: `IdentityRegistry.sol`
- `Member { bytes32 idHash; address wallet; uint64 joinedAt; uint64 stakeSince; uint8 tier; uint256 incomeWei; uint256 declaredDebtWei; uint32 payoutPeriodDays; bytes32 clusterId; uint32 cohortId; uint32 completedLoans; uint32 restructuresLast12m; uint64 coolingOffUntil; bool permanentlyBarred; uint8 defaultCount; }`
- `memberOf[wallet] → memberId` and `memberByIdHash[idHash] → memberId`. All default state lives on the **member**, not the wallet.
- Tiers: `New`, `Builder`, `Standard`, `Trusted`, `Prime`, derived from completed loans and score. Thresholds are parameters.
- `clusterFlagged[clusterId]`, settable by `LoanManager` on a fraud default and by `DISPUTE_ROLE`.
- `isEligible(wallet)` checks: registered, attestation not expired, not barred, and past `coolingOffUntil`.

### Frontend
- `Navbar.jsx`: **Sign up** and **Log in** buttons, and a profile menu when logged in.
- New pages: `SignupPage.jsx` (5-step wizard with a progress bar), `LoginPage.jsx`, `ProfilePage.jsx` (verification status, tier, income band, consent toggles, named contact).
- `AuthContext` + `ProtectedRoute`:
  - `/app/borrow` and `/app/loans` require login, a linked wallet and on-chain registration.
  - Lending stays open to everyone.
- If MetaMask switches to a wallet that doesn't match the session, warn and block actions.

---

## 4. Loans become installment loans with IDs

Replace the single per-address loan in `LendingPool` with `LoanManager`:

- `Loan { uint256 id; uint256 memberId; address borrower; LoanKind kind /*Builder|Unsecured*/; uint256 principal; uint256 outstandingPrincipal; uint256 rateBps; uint32 periodDays; uint16 nInstallments; uint16 paidCount; uint256 installment; uint64 nextDueDate; uint64 firstMissedAt; uint256 lateFeesDue; uint256 stakeLocked; address guarantor; uint256 guarantorStakeLocked; bool askedForHelp; bool restructured; RestructureOption activeRestructure; DefaultType dtype; uint64 classifiedAt; bool appealOpen; }`
- Installments are fixed, amortised from simple interest, and **match the member's payout period** (weekly/biweekly). Tenure is limited to a window of whole periods (e.g. 2–12 periods). Rate locking at origination stays.
- `repayInstallment()` is payable. Money goes to late fees first, then interest, then principal, with refunds kept. A completed installment increments `paidCount` and resets `firstMissedAt` if the loan is now current.
- **Keep the old `borrow`/`repay` ABI** only if it is cheap. Otherwise remove it and update all callers and tests.

---

## 5. Prevention (checked before money leaves the pool)

Implement each rule as a check in `LoanManager.openLoan(...)`, with a clear revert string:

| Control | Rule |
|---|---|
| **Credit-builder first** | A member's first loan(s) are `Builder`: funds are held in **escrow at 100%** and released to the borrower only when it is fully repaid. A first `Unsecured` loan is allowed only after 1–2 completed Builder loans **and** 90 days of stake (`stakeSince`). It is capped at the ₹1,000-equivalent and needs **50% stake cover**. Re-entry after any default is always through a Builder loan. |
| **Capped ladder** | Next limit ≤ 1.5× the largest completed loan, with smaller early steps and a per-step cap. **Fast-climber flag:** two limit steps within 60 days followed by a larger request means the member is held at the current step. |
| **Total debt burden** | Installment, expressed monthly, ≤ **35%** of attested income, minus declared debts. A debt found to be misdeclared (admin flag) lowers score and limit. |
| **Repayment follows income** | Installments are scheduled on the payout cycle. An **income sweep** takes a configurable 15–30% of each payout routed through `MockPayoutRouter` and applies it to the next installment. |
| **Rule-bound flexibility** | Fixed installment, at most one priced restructure per loan (section 7), and restructure use recorded in the score. |
| **Cohort fraud screen** | Track the first-payment-default rate per `cohortId`. When it is above a threshold, **auto-pause first loans for that cohort**. A 5% exposure cap per `clusterId`, a 2% of liquidity cap per loan, and a weekly growth cap of about 10% of liquidity. All are parameters, so demo values must let a small local pool work. |
| **Autopay by default** | **SafeRepay** = an on-chain vault per borrower: the borrower pre-funds it with limits (max pull per installment, protected minimum balance, expiry). `collect()` and installment pulls draw from it. It is set up at disbursement and is opt-out. Document EIP-7702 delegation as future work. |
| **Stake lock** | The borrower's GLP stake (and any guarantor's) is locked in the vault for the life of the loan. GLP `_update` must block transfers or burns of locked balance. |

---

## 6. Default lifecycle and stages (computed, no keeper)

Stage is computed from timestamps on read:

```solidity
enum Stage { Active, Grace, Onset, Significant, DefaultEligible }
enum DefaultType { None, Hardship, Strategic, Fraud }

function stageOf(uint256 loanId) public view returns (Stage) {
    Loan storage l = loans[loanId];
    if (block.timestamp <= l.nextDueDate) return Stage.Active;
    uint256 daysLate = (block.timestamp - l.nextDueDate) / secondsPerDay;
    if (daysLate <= graceDays(l))      return Stage.Grace;        // 3, or 7 for Trusted/Prime or loans > 3 months
    if (daysLate <= ONSET_END_DAY)     return Stage.Onset;        // 10
    if (daysLate <  defaultDay(l))     return Stage.Significant;  // 30, or 45 for loans > 3 months
    return Stage.DefaultEligible;
}
```

What each stage does:
- **Early warning** (up to 7 days before due) and **Reminder** (3 days before due) are handled by the backend notifier (section 8).
- **Due date:** the income sweep or SafeRepay pull runs. Plain wallets pay by hand. Partial payments are accepted.
- **Grace** (days 1–3, or up to 7): collection is retried. **No fee and no score effect.** The loan is carried at 100%.
- **Onset** (days 4–10): a **flat, capped late fee, charged once per overdue installment and never compounding**. The score effect starts. The loan is carried at 90%.
- **Significant** (day 11 to 29, or to 44): `collect(loanId)` may apply locked stake to the missed installment, and the guarantor is alerted. The loan is carried at 50%.
- **DefaultEligible** (day 30, or 45): anyone may call `markDefault(loanId)`. The loan is carried at 0%.

### Functions (from the PDF)

| Function | Caller | Allowed when | Effect |
|---|---|---|---|
| `collect(loanId)` | anyone | stage == Significant and an installment is unpaid | applies locked stake to the missed installment; pays bounty |
| `requestRestructure(loanId, option)` | borrower | before due or in Onset; once per loan; ≤ 2 per member per 12 months | reschedules; emits `RestructureGranted`; sets `askedForHelp` |
| `markDefault(loanId)` | anyone | stage == DefaultEligible and no restructure in force | classifies, runs the waterfall, records the residual claim, pays bounty |
| `settleClaim()` payable | borrower | residual claim > 0 | refills reserve first, then pool; on full settlement sets `coolingOffUntil` **now** |
| `settlementQuote(member)` view | anyone | after default | discounted payoff by default type |
| `startWorkout(loanId)` | borrower | dtype == Hardship | capped installment plan, interest frozen, ≤ 6 months |
| `appeal(loanId)` | borrower | within 21 days of classification | opens a dispute; `DISPUTE_ROLE` may `reclassify` |
| `setShockMode(cohortId, until)` | admin with attested event hash | any time | longer grace and no late fees or score effects for that cohort; **never touches principal** |

**Bounty:** `bountyShare` = 10% of the late fee, paid to the `collect`/`markDefault` caller. Both functions **must revert before their day**, so a bounty can never pull a default forward.

### Classification (public, logged and appealable)

```solidity
function classify(Loan storage l, Member storage m) internal view returns (DefaultType) {
    uint8 fraudFlags;
    if (m.completedLoans == 0 && l.paidCount == 0) fraudFlags++;            // first-payment default
    if (clusterFlagged[m.clusterId])               fraudFlags++;            // linked wallets
    if (block.timestamp - m.stakeSince < 30 days)  fraudFlags++;            // new, thin stake
    if (fraudFlags >= 2) return DefaultType.Fraud;
    bool incomeKeptFlowing = payouts.inflowSince(l.borrower, l.firstMissedAt) >= l.installment;
    if (incomeKeptFlowing && !l.askedForHelp) return DefaultType.Strategic;
    return DefaultType.Hardship;
}
```

`30 days` must use `secondsPerDay`. `payouts` is `MockPayoutRouter`, which records cumulative inflow per borrower with timestamps.

| Type | Treatment | Max settlement discount | Cooling-off **after settlement** |
|---|---|---|---|
| Hardship | workout plan; smaller scar; path back via a Builder loan | 25% | 30 days after workout or settlement |
| Strategic | full scar; borrowing locked; stake and guarantor stake applied in full | 5% | 12 months |
| Fraud | stake applied; cluster flagged; no rehabilitation | 0% | permanent (`permanentlyBarred`) |

---

## 7. Restructuring and hardship

- **Payment holiday** (before due, or in Onset): skip one installment, interest frozen for that period, tenure +1 period, small flat fee.
- **Tenure stretch** (attested income dropped for ≥ 2 payouts): re-amortise the remaining balance up to the window maximum, with the term premium applied.
- **Hardship workout** (after a Hardship default): small fixed installments, interest frozen, ≤ 6 months. Completing it earns back part of the score.
- **Systemic-shock mode:** see `setShockMode` above.
- **Guardrails:**
  - At most 1 restructure per loan and 2 per member in 12 months.
  - A published **no-waiver rule**: shock mode and workouts never reduce principal.
  - Asking early gives a lighter score effect: the installment counts as late-within-grace (60% weight) instead of late (20%).
  - The Pool page reports arrears **twice**, with and without restructured loans.

---

## 8. Early warning and contact (backend notifier)

The backend watches chain events and `MockPayoutRouter` data. It writes **in-app notices** to an inbox table, shown in a new `NotificationsPage`/bell. Email and SMS are mock console output.

| Signal | Trigger (parameter) | Response |
|---|---|---|
| Payout inflows falling | last 30 days < 70% of the 90-day average | nudge from the named contact; restructure option shown |
| Sweep shortfall | sweep below the installment share for 2 payouts in a row | same, plus an offer to switch periodicity |
| Wallet running dry | SafeRepay balance < next installment, 3 days before due | top-up reminder |
| Fast climber | 2 limit steps in 60 days, then a larger request | hold at the current step |
| Cohort first-payment default | rate above threshold | pause first loans for the cohort (call admin fn) |

Contact rules, enforced in code and covered by unit tests:
- Each member is assigned **one named community contact** (seeded staff names) that stays the same across loans. Every message carries that name.
- Messages go out only between **08:00 and 19:00 local time**; anything outside that window is queued.
- No third-party contact, no public posts, no threats. Every notice states the grievance contact.
- **Help first, facts second:** each message leads with the restructure option, then states the amount and date plainly.
- During Grace, only collection retries happen. Personal contact resumes at Onset.
- Every message is logged and kept for at least 6 months.

---

## 9. Recovery, loss absorption and pool value

**Waterfall at `markDefault`:**
1. Borrower's locked stake at fair share price (existing Stage 1 math, now actually locked).
2. Guarantor's locked stake, if the loan has a guarantor.
3. `ReserveFund` (existing Stage 2).
4. Lenders pro rata through a lower share price. The remainder becomes the member's **residual claim** (existing Stage 3 memorandum, now on the member).

**After default:**
- **Residual claim:** 50% (`residualSweepShare`) of any later deposit, swept payout or incoming stake by that member is applied to the claim automatically.
- **Recoveries** refill the reserve first, then the pool (keep the `settleWrittenOffDebt` ordering and rename it to `settleClaim`).
- **Settlement offer:** paying the lump sum at the type's discount closes the claim.
- **Cooling-off starts at settlement**, and re-entry is always through a Builder loan.

**Book losses in steps (new): `poolValue()`**
- Share math uses `poolValue = freeCash + Σ carried(loan)`. Carried values by stage: Active/Grace 100%, Onset 90%, Significant 50%, Defaulted 0%. The carry is restored if the loan cures.
- Iterate a **bounded active-loan set** (e.g. a max of 100 open loans, as a parameter) and document this as a prototype limitation.
- Deposits and withdrawals must use `poolValue()`. A withdrawal during Significant gets the lower share price.

**Other protections:**
- `ReserveFund`: 10% of repaid interest, ring-fenced for losses only.
- **Withdrawal queue:** when free cash is short, withdrawals enter a FIFO queue paid pro rata as cash returns (Maple 2.0 style), instead of reverting.
- Concentration limits as in section 5.
- **Disclosure:** the Pool page shows non-performing loans by stage, realised losses per month, reserve size, and arrears with and without restructures. The copy must say the reserve is "a loss buffer funded by borrower interest, **not a guarantee**", and that returns are never guaranteed.

---

## 10. Reputation: score and scar

- Rescale `CreditScore` to **300–900**, CIBIL-like, so the PDF's ~90-point scar makes sense. Re-derive tiers, limits and risk-surcharge bands, and update `frontend/src/utils/contractHelpers.js` (`calculateEstimatedRateBps`) to match.
- **Positive inputs:** completed installments (weighted on-time 100%, late-within-grace 60%, late 20%), completed loans, and stake age.
- **Scar:** about 90 points at full strength, fading linearly over 2 years (in `secondsPerDay` units) to a **permanent floor of 30%** of its size.
  - Settlement shrinks the scar but never removes it.
  - A Hardship scar is smaller than a Strategic one.
  - A **second default ends unsecured borrowing** (Builder only).
- Every score change emits `ScoreChanged(memberId, delta, reasonCode)` and can be disputed.
- All score state is keyed by **memberId**, so a new wallet for the same `idHash` inherits it.

---

## 11. Events

Emit at least the following:
- `InstallmentMissed`, `LateFeeCharged`, `StakeApplied`, `RestructureGranted`
- `LoanDefaulted(loanId, defaultType, stakeUsed, guarantorUsed, reserveUsed, lenderLoss)`
- `ClaimSettled`, `WorkoutStarted`, `CoolingOffSet`, `Appealed`, `Reclassified`, `ShockModeSet`
- `MemberRegistered`, `WalletLinked`, `ScoreChanged`, `BountyPaid`, `WithdrawalQueued`, `WithdrawalPaid`, `ParameterUpdated`

Update `useEventSync.js` to subscribe to **all** new contract addresses and render the new event types on the Transactions and Dashboard pages.

---

## 12. Frontend work (summary)

- **Auth:** pages and context from section 3.
- **Borrow page:**
  - Builder vs Unsecured explained, and the limit broken down (ladder, 35% burden, cluster/cohort caps), with the reason for any hold.
  - Required stake cover, an optional guarantor address, and the SafeRepay setup step.
  - A key-fact-statement-style quote: APR, installment schedule, total cost, late fee, and a 1-day penalty-free exit.
- **Loans page:**
  - A stage timeline (Early warning → Reminder → Due → Grace → Onset → Significant → Default) with the current stage highlighted.
  - The installment schedule, restructure options shown **before** the amount owed, settlement quote, workout, and an appeal button with the deadline.
- **Pool page:** the disclosures from section 9 and the withdrawal queue position.
- **Admin page** (`ADMIN_ROLE`/`DISPUTE_ROLE` only): appeals queue with reclassify, shock mode, cluster flags, cohort pause status, and parameter view.
- **Notifications:** an inbox with the named contact on each notice.
- **Demo panel** (local chain only): send mock payouts to a borrower, plus time-travel buttons that call the backend/`timeTravel.js`.

---

## 13. Tests that must pass (Hardhat + backend)

Update or replace the existing 29 tests so the suite stays green. In addition, the tests from the PDF:
- [ ] Dust-stake borrow-and-vanish leaves the attacker with **no profit**.
- [ ] `markDefault()` and `collect()` revert before their day, so a bounty can never pull a default forward.
- [ ] A second restructure on the same loan reverts, and shock mode never reduces principal.
- [ ] `poolValue()` applies the stage provisions, and a withdrawal during Significant gets the lower share price.
- [ ] Full settlement sets `coolingOffUntil`, and borrowing reverts until it passes.
- [ ] Each default type (Hardship, Strategic, Fraud) is produced by its own fixture, and an appeal can reclassify.
- [ ] A new wallet tied to an attested identity inherits that identity's default record.

Plus:
- [ ] Locked GLP cannot be withdrawn or transferred while a loan is open.
- [ ] A Builder loan's escrow is released only on full repayment.
- [ ] The 35% burden, 1.5× ladder, fast-climber hold, cluster 5% cap and cohort pause each revert with the correct reason.
- [ ] The late fee is charged once per installment and never compounds. Grace has no fee and no score effect.
- [ ] Residual sweep: 50% of a defaulter's later deposit goes to the claim.
- [ ] A withdrawal queue run is paid pro rata.
- [ ] Scar decays to exactly the 30% floor and never below it.
- [ ] Attestation signature replay, expiry and wrong-signer cases are rejected.
- [ ] Backend (vitest/jest + supertest):
  - OTP flow
  - SIWE login with wallet mismatch rejected
  - duplicate `idHash` attaches to the existing member
  - notifier quiet hours
  - every message carries the named contact and grievance line

---

## 14. Phases (commit after each, tests green)

1. **Identity and auth:** backend scaffold, signup/login, SIWE, mock KYC, `IdentityRegistry`, attestations, frontend auth pages, route guards.
2. **Loan engine refactor:** `LoanManager` with loan IDs, installments, stake lock in GLP, Builder escrow, SafeRepay vault, `MockPayoutRouter` and income sweep. Migrate existing tests.
3. **Prevention:** ladder, burden, fast-climber, cohort/cluster/concentration caps, rescaled `CreditScore`.
4. **Lifecycle:** stages, late fee, collect, bounty, restructures, shock mode.
5. **Default and recovery:** classification, 4-step waterfall, guarantor, residual claim and sweep, settlement quote, workout, appeal/reclassify, cooling-off at settlement, scar.
6. **Pool accounting:** `poolValue()` provisions, withdrawal queue, disclosures.
7. **Notifier and early warning**, inbox UI, admin page, demo panel.
8. **Docs and demo:**
   - Update `README.md` (architecture, new setup steps for `backend/`, parameters table, limitations).
   - Update `scripts/deploy.js` (deploy and wire everything, grant roles, copy ABIs and addresses for all contracts into the frontend, write backend `.env` addresses).
   - Update `timeTravel.js`.
   - Add `scripts/demoScenarios.js`, which seeds one Hardship, one Strategic and one Fraud borrower end to end.

## 15. Done means

- `npx hardhat test` and the backend tests pass.
- `npx hardhat node`, then `deploy.js`, then `cd backend && npm run dev`, then `cd frontend && npm run dev` gives a working local demo where a user can:
  1. Sign up, verify and register on-chain.
  2. Take a Builder loan, repay it, then take an Unsecured loan.
  3. Miss an installment and watch the stages advance with time travel.
  4. Restructure, or default and see classification, waterfall, settlement and cooling-off.
  5. Try a fresh wallet with the same identity and be blocked.
- A short `docs/IMPLEMENTATION_NOTES.md` lists every deviation from the PDF and why, every parameter's demo value, and known prototype limitations (bounded loan set, mock oracles, single-key admin).

If something in the PDF conflicts with this prompt, or is impossible on-chain, pick the simplest faithful option, note it in `IMPLEMENTATION_NOTES.md`, and keep going. Ask me only for decisions that can't be undone.
