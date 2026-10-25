# Implementation notes

What was built differs from `docs/Defaulter_handling.pdf` and `docs/CLAUDE_CODE_PROMPT.md` in the
places listed below. Each entry gives the choice and the reason. Where the PDF and the prompt
disagreed, or something was impossible on-chain, the simplest faithful option was taken.

## Deviations and interpretations

### Contracts and structure

1. **Solidity 0.8.20 kept; EIP-712 domain built by hand.** OpenZeppelin 5.6's `EIP712` needs
   solc 0.8.24. `IdentityRegistry.domainSeparator()` builds the same standard domain
   (`GigLendIdentity`, `1`, chainId, contract) directly.
2. **Responsibilities split for the 24 KB contract limit.** The prompt puts almost everything in
   `LoanManager`; that does not fit. So:
   - `RiskEngine.quote()` does pricing (kinked rate, amortisation, 90% cap) and every prevention
     rule. `LoanManager.openLoan` calls it, and the Borrow page uses it as a live preview.
   - `DefaultManager` holds classification, the waterfall, claims, `settleClaim`,
     `settlementQuote`, `startWorkout` / `payWorkout`, `appeal`, `reclassify`.
     `LoanManager.markDefault` remains and forwards to it, so the bounty goes to the original
     caller.
   - `LoanOpsLib` (externally linked library, runs on `LoanManager` storage via `DELEGATECALL`)
     holds restructuring and stake locking.
   - Shock mode (`setShockMode`) lives in `IdentityRegistry`, next to the other per-cohort state.
   - The "StakeVault" is the lock in `GLPToken` (`lockedBalance` + `_update` check).
   - Disclosures are a read-only `PortfolioLens`.
   - `LoanManager` is ~23.1 KB. A test checks every contract stays under 24 KB.
3. **The legacy `borrow` / `repay` ABI was removed.** Keeping it next to installment loans was not
   cheap. The 29 V2 tests were migrated to the new API with the same economic assertions. The V2
   `legacy borrow(amount)` test was replaced by penalty-free-exit tests.
4. **One open loan per member.** This keeps the "cannot unlink with an open loan" rule simple
   and the bounded loan set small.
5. **Interest is computed in policy days**, so compressing time with `secondsPerDay` does not
   change what a loan costs.

### Prevention

6. **Stake lock:** opening any loan locks *all* of the borrower's unlocked GLP for the life of
   the loan. Gap 1 says "lock stake while any loan is open". Unsecured loans must reach 50% cover
   (borrower plus guarantor pledge). The waterfall burns only what the debt needs and unlocks
   the rest.
7. **Guarantors** pledge first (`offerGuarantee`, which locks their GLP). The borrower names
   them at `openLoan`. Unused pledges can be withdrawn.
8. **Ladder:** the base is the largest completed *Unsecured* loan; the first Unsecured loan uses
   `firstUnsecuredCapWei`. The first `ladderEarlySteps` steps use 1.25×, later steps 1.5×, and
   each step is also capped at `ladderStepCapWei`.
9. **Fast climber:** a "limit step" is opening a loan larger than the member's largest completed
   loan. Two steps within `fastClimberWindowDays` hold the member at their largest completed
   amount.
10. **Burden:** `installment × 30 / periodDays + declaredDebt ≤ 35% × attested income`.
    Misdeclared debt is an admin flag. While set, it costs `misdeclaredPoints` and cuts limits by
    `misdeclaredLimitCutBps`.
11. **Cohort pause** is computed on-chain: first-payment-default rate above the threshold once
    the cohort has `cohortMinSample` first loans, or a manual admin pause. The backend needs no
    admin key for it.
12. **Concentration caps** are measured against `poolValue()`. The weekly growth cap uses a
    rolling 7-policy-day window.
13. **Tier for grace** is the member's tier at origination (`tierAtOpen`). Reading it per loan in
    the `poolValue()` loop would cost too much gas.

### Lifecycle

14. **Grace "no score effect"** means no late mark and no fee. The prompt's weighting still
    applies, so an installment completed in Grace earns 60% of on-time credit.
15. **Late fee and late mark are applied lazily** (`_accrueLate`) whenever anyone touches the loan
    (repay, autopay, collect, markDefault or the public `accrueLate`), once per installment and
    keyed by installment number. Views include a pending fee.
16. **Fees go to `ReserveFund`** (late and holiday fees). The keeper bounty (10% of the late fee) is
    paid by the reserve **before** the reserve covers principal, so the incentive is always
    funded while the reserve has any balance.
17. **Payment holiday** is allowed before due (stage Active) or in Onset, not in Grace, following the
    PDF's "Before due, or in Onset". A restructure is "in force" until the next due date after it;
    `markDefault` checks this.
18. **Tenure stretch** needs the last two router payouts each below `incomeDropBps` (80%) of the
    attested per-period income. It re-amortises to `maxInstallments` with `termPremiumBps`.
19. **Asking early** (any restructure) makes that installment count as late-within-grace (60%)
    and suppresses its Onset fee and late mark.

### Default and recovery

20. **Debt at default** is outstanding principal, interest of every installment already past due,
    and fees. Future scheduled interest is not owed. Claims do not accrue interest.
21. **Classification** is re-read after late state is materialised, so `firstMissedAt` is the real
    first miss. (A bug where pre-miss payouts could count as "income kept flowing" was found and
    fixed; there is a regression test.) `thin stake` also covers members with no stake at all.
22. **Stake is applied up to the whole debt** for every default type: principal first, then
    interest, then fees. The PDF's "applied in full" for Strategic is therefore true for all
    types. The difference between types is the discount, cooling-off, workout and scar.
23. **Builder defaults:** the escrow covers the debt and any surplus goes back to the borrower. The
    default is still classified and scarred.
24. **Cooling-off:** at default the member is locked (`coolingOffUntil = max`) until the claim is
    cleared; the type's cooling-off then starts at settlement. If the waterfall clears everything
    at default, cooling-off starts then.
25. **Settlement** pays the discounted quote reserve-first. The discount also writes off any unpaid
    reserve draw. Partial payments below the quote get no discount.
26. **Recoveries** refill the reserve first, then the pool. As V2's `settleWrittenOffDebt` did, the
    10% reserve factor also applies to the pool part.
27. **Residual sweep** covers later deposits and payouts routed through `MockPayoutRouter`. GLP
    *transferred* to a defaulter is not swept.
28. **Workout:** the installment is `claim / (workoutMaxDays / period)`. Missing a workout installment
    has no extra penalty in the prototype. Finishing it keeps 60% of the scar and starts the
    30-day cooling-off.
29. **Reclassify** updates the type, bar, cluster flag and scar size. It does not move an
    already-started cooling-off, except when it lifts a fraud bar after settlement.
30. **Scar size:** Strategic/Fraud 90, Hardship 60. A second default always uses the full size.
    Settlement keeps 70%, a workout 60%, and the 30% floor always applies.

### Pool

31. **Builder loans carry at 100%** in every stage (escrow-backed). Only Unsecured loans are
    provisioned.
32. **Withdrawal queue:** queued shares move into the pool's custody and keep sharing gains and
    losses. Each processing run pays every request the same fraction at the current price.
    Requests can be cancelled. The queue is bounded by `maxQueueLength`. New withdrawals join the
    back of the queue whenever it is non-empty.

### Backend and frontend

33. **bcryptjs** (pure-JS bcrypt) avoids native builds on Windows. SQLite via Prisma; the schema
    uses only portable types.
34. **OTP:** printed to the server console and stored as a bcrypt hash. Tests receive it in the
    response only under `NODE_ENV=test`. Seed scripts issue their own OTP through the service.
35. **Income:** assessed = min(mean, median) of the monthly payouts. Stability band from the
    coefficient of variation, with a haircut of 0/10/25%. The attested income is a ₹5,000 tier,
    never the exact figure.
36. **Cluster:** hash of phone prefix + device fingerprint + funding wallet. The funding wallet is
    not collected yet, so it is a constant. An admin override (demo fixtures) takes effect on the
    next attestation.
37. **Contact hours use wall-clock time** in the member's time zone (default Asia/Kolkata). Loan
    timing uses chain time, so time travel works. Guarantor alerts reach guarantors who have an
    account.
38. **Admin UI access** comes from `ADMIN_WALLETS` in the backend. The contracts enforce the roles.
39. **Dev wallet:** `?devwallet=<n>` in the Vite dev server bridges to unlocked Hardhat accounts,
    for MetaMask-free demos and UI testing. It is disabled in production builds.
40. **Selfies** are encrypted with AES-256-GCM using a key derived from `ID_PEPPER`. Production
    would use a KMS-held key.

## Parameters (demo values)

All in `scripts/config.js` → `PolicyConfig`. `INR_PER_ETH_DEMO = 100000` (₹1,000 ≈ 0.01 ETH).

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

## Known prototype limitations

- **Bounded active-loan set:** `poolValue()` loops over at most `maxActiveLoans` (100) open loans,
  and each loan's stage is computed on read. Origination reverts once the set is full.
- **Mock oracles:** KYC, OTP, income, declared debts and payouts are mocks. One local attester key
  signs every attestation (Hardhat account #9).
- **Single-key admin:** the deployer holds `ADMIN_ROLE` and `DISPUTE_ROLE`. Production: a Safe
  multisig, an attested-event process for shock mode, and a dispute committee.
- **Native ETH only**; simple interest; demo-sized amounts; one open loan per member.
- **Autopay** is a prefunded vault. EIP-7702 delegation of a plain wallet to the same limits is
  future work.
- **No credit-bureau reporting:** production would report through a regulated partner.
- **Notifier channels** are an in-app inbox plus mock email/SMS console lines.
- **Tested locally only** (Hardhat 31337); public-network latency and reorgs are not evaluated.
