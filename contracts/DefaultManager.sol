// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./PolicyConfig.sol";
import "./IdentityRegistry.sol";
import "./GLPToken.sol";
import "./interfaces/IGigLend.sol";
import "./libraries/LoanTypes.sol";

interface ILoanPayoff {
    function payoffAmount(uint256 loanId) external view returns (uint256);
}

/**
 * @title DefaultManager
 * @notice Everything after day 30 (or 45): a public, logged, appealable classification
 *         (Hardship / Strategic / Fraud), the loss waterfall
 *           1. borrower's locked stake at fair share price
 *           2. guarantor's locked stake
 *           3. ReserveFund
 *           4. lenders pro rata through a lower share price, remainder kept as a residual claim,
 *         residual-claim recovery (reserve refilled first, then the pool), discounted settlement,
 *         hardship workouts, appeals and cooling-off that starts at settlement.
 *         No-waiver rule: nothing here reduces principal except a settlement the member pays for
 *         at the published discount for their default type.
 */
contract DefaultManager is AccessControl, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant DISPUTE_ROLE = keccak256("DISPUTE_ROLE");

    struct Claim {
        uint256 amount;           // total still owed (includes reserveDrawn)
        uint256 reserveDrawn;     // part owed back to the reserve (repaid first)
        uint256 loanId;
        LoanTypes.DefaultType dtype;
        bool workout;
        uint32 workoutPeriods;
        uint256 workoutInstallment;
        uint64 workoutNextDue;
        uint64 workoutEndsAt;
    }

    PolicyConfig public immutable config;
    IdentityRegistry public immutable registry;
    GLPToken public immutable glp;
    ILoanManager public loanManager;
    ILendingPoolV3 public pool;
    address payable public reserve;
    ICreditScore public score;
    IPayoutRouter public payouts;

    mapping(uint256 => Claim) public claims;
    uint256 public totalLenderLoss;
    uint256 public totalReserveUsed;
    uint256 public totalStakeApplied;
    uint256 public totalRecovered;
    mapping(uint256 => uint256) public realisedLossByMonth; // month index (30 policy days) => wei
    mapping(uint8 => uint256) public defaultsByType;

    event LoanDefaulted(
        uint256 indexed loanId,
        LoanTypes.DefaultType defaultType,
        uint256 stakeUsed,
        uint256 guarantorUsed,
        uint256 reserveUsed,
        uint256 lenderLoss
    );
    event Classified(uint256 indexed loanId, LoanTypes.DefaultType dtype, uint8 fraudFlags, bool incomeKeptFlowing, bool askedForHelp);
    event ClaimRecorded(uint256 indexed memberId, uint256 indexed loanId, uint256 amount, uint256 reserveDrawn);
    event ClaimRecovered(uint256 indexed memberId, uint256 amount, uint256 reserveReplenished, uint256 toPool);
    event ClaimSettled(uint256 indexed memberId, uint256 paid, uint256 discount, bool fullySettled);
    event WorkoutStarted(uint256 indexed memberId, uint256 indexed loanId, uint256 installment, uint32 periods, uint64 endsAt);
    event WorkoutCompleted(uint256 indexed memberId, uint256 indexed loanId);
    event Appealed(uint256 indexed loanId, uint256 indexed memberId, uint64 deadline);
    event Reclassified(uint256 indexed loanId, LoanTypes.DefaultType oldType, LoanTypes.DefaultType newType);
    event AppealDismissed(uint256 indexed loanId);
    event BountyPaid(address indexed caller, uint256 indexed loanId, uint256 amount);

    constructor(address admin, PolicyConfig _config, IdentityRegistry _registry, GLPToken _glp) {
        config = _config;
        registry = _registry;
        glp = _glp;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(DISPUTE_ROLE, admin);
    }

    function wire(address _loanManager, address _pool, address payable _reserve, address _score, address _payouts)
        external
        onlyRole(ADMIN_ROLE)
    {
        require(address(loanManager) == address(0), "Already wired");
        loanManager = ILoanManager(_loanManager);
        pool = ILendingPoolV3(_pool);
        reserve = _reserve;
        score = ICreditScore(_score);
        payouts = IPayoutRouter(_payouts);
    }

    function _p(bytes32 key) internal view returns (uint256) {
        return config.get(key);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Classification
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice The public classification rule. Fraud needs two of: first-payment default,
     *         flagged cluster, new/thin stake. Strategic: payouts kept arriving (≥ one installment
     *         since the first miss) and the borrower never asked for help. Otherwise Hardship.
     */
    function classify(LoanTypes.Loan memory l, IdentityRegistry.Member memory m)
        public
        view
        returns (LoanTypes.DefaultType dtype, uint8 fraudFlags, bool incomeKeptFlowing)
    {
        if (m.completedLoans == 0 && l.paidCount == 0) fraudFlags++;
        if (registry.clusterFlagged(m.clusterId)) fraudFlags++;
        if (m.stakeSince == 0 || block.timestamp - m.stakeSince < _p("fraudThinStakeDays") * _p("secondsPerDay")) {
            fraudFlags++;
        }
        incomeKeptFlowing = payouts.inflowSince(l.borrower, l.firstMissedAt) >= l.installment;
        if (fraudFlags >= 2) return (LoanTypes.DefaultType.Fraud, fraudFlags, incomeKeptFlowing);
        if (incomeKeptFlowing && !l.askedForHelp) return (LoanTypes.DefaultType.Strategic, fraudFlags, incomeKeptFlowing);
        return (LoanTypes.DefaultType.Hardship, fraudFlags, incomeKeptFlowing);
    }

    function previewClassification(uint256 loanId) external view returns (LoanTypes.DefaultType dtype, uint8 fraudFlags, bool incomeKeptFlowing) {
        LoanTypes.Loan memory l = loanManager.getLoan(loanId);
        return classify(l, registry.getMember(l.memberId));
    }

    // ─────────────────────────────────────────────────────────────────────
    // markDefault + waterfall
    // ─────────────────────────────────────────────────────────────────────

    function markDefault(uint256 loanId) external nonReentrant {
        _markDefault(loanId, msg.sender);
    }

    /// @notice Entry point used by LoanManager.markDefault (bounty goes to the original caller).
    function markDefaultFor(uint256 loanId, address caller) external nonReentrant {
        require(msg.sender == address(loanManager), "Only LoanManager");
        _markDefault(loanId, caller);
    }

    struct Waterfall {
        uint256 principal;
        uint256 interest;
        uint256 fees;
        uint256 stakeUsed;
        uint256 guarantorUsed;
        uint256 reserveUsed;
        uint256 lenderLoss;
    }

    function _markDefault(uint256 loanId, address caller) internal {
        LoanTypes.Loan memory l = loanManager.getLoan(loanId);
        require(l.status == LoanTypes.LoanStatus.Active, "No active loan");
        loanManager.accrueLate(loanId);
        require(loanManager.stageOf(loanId) == LoanTypes.Stage.DefaultEligible, "Default day not reached");
        require(l.restructureEndsAt <= block.timestamp, "Restructure in force");

        IdentityRegistry.Member memory m = registry.getMember(l.memberId);
        (LoanTypes.DefaultType dtype, uint8 flags, bool flowing) = classify(l, m);

        l = loanManager.closeDefaulted(loanId); // escrow (Builder) arrives here; stake stays locked
        Waterfall memory w;
        w.principal = l.outstandingPrincipal;
        w.interest = _overdueInterest(l);
        w.fees = l.lateFeesDue;

        if (l.kind == LoanTypes.LoanKind.Builder) {
            _settleFromEscrow(l, w);
        } else {
            _applyStakes(l, w);
        }

        // Keeper bounty (10% of the late fee) is paid before the reserve is drawn, so it is
        // always funded; the bounty cannot pull a default forward because timing is enforced above.
        uint256 bounty = (l.lateFeesDue * _p("bountyShareBps")) / 10000;
        if (bounty > 0) {
            uint256 paid = IReserveFund(reserve).payBounty(caller, bounty);
            emit BountyPaid(caller, loanId, paid);
        }

        // 3. Reserve covers remaining principal (the lenders' asset).
        if (w.principal > 0) {
            w.reserveUsed = IReserveFund(reserve).cover(address(pool), w.principal);
            w.principal -= w.reserveUsed;
            if (w.reserveUsed > 0) pool.onCashIn();
        }
        // 4. What is left falls on lenders through the share price; the member keeps a claim.
        w.lenderLoss = w.principal;

        uint256 claimAmount = w.principal + w.interest + w.fees + w.reserveUsed;
        _recordClaim(l, dtype, claimAmount, w.reserveUsed);
        _applyConsequences(l, m, dtype, claimAmount);

        totalLenderLoss += w.lenderLoss;
        totalReserveUsed += w.reserveUsed;
        totalStakeApplied += w.stakeUsed + w.guarantorUsed;
        realisedLossByMonth[block.timestamp / (30 * _p("secondsPerDay"))] += w.lenderLoss;
        defaultsByType[uint8(dtype)] += 1;

        emit Classified(loanId, dtype, flags, flowing, l.askedForHelp);
        emit LoanDefaulted(loanId, dtype, w.stakeUsed, w.guarantorUsed, w.reserveUsed, w.lenderLoss);
    }

    /**
     * @notice The debt markDefault would collect now: outstanding principal, interest of every
     *         installment already past due, and late fees (including one not yet materialised).
     */
    function defaultDebt(uint256 loanId) external view returns (uint256 principal, uint256 interest, uint256 fees) {
        LoanTypes.Loan memory l = loanManager.getLoan(loanId);
        principal = l.outstandingPrincipal;
        interest = _overdueInterest(l);
        uint256 payoff = ILoanPayoff(address(loanManager)).payoffAmount(loanId);
        fees = payoff - l.outstandingPrincipal - l.interestRemaining;
    }

    /// @dev Interest of every installment already past due (future scheduled interest is not owed).
    function _overdueInterest(LoanTypes.Loan memory l) internal view returns (uint256) {
        uint256 current = l.curInterestPortion - l.curInterestPaid;
        uint256 k = l.nInstallments - l.paidCount;
        if (k <= 1 || block.timestamp <= l.nextDueDate) return current;
        uint256 period = uint256(l.periodDays) * _p("secondsPerDay");
        uint256 overdue = 1 + (block.timestamp - l.nextDueDate) / period;
        if (overdue > k) overdue = k;
        uint256 rest = l.interestRemaining - current;
        return current + ((overdue - 1) * rest) / (k - 1);
    }

    /// @dev Builder loans: the escrow covers the debt; any surplus goes back to the borrower.
    function _settleFromEscrow(LoanTypes.Loan memory l, Waterfall memory w) internal {
        uint256 escrow = l.escrow; // snapshot taken before LoanManager handed the escrow over
        uint256 p = w.principal < escrow ? w.principal : escrow;
        escrow -= p;
        uint256 i = w.interest < escrow ? w.interest : escrow;
        escrow -= i;
        uint256 f = w.fees < escrow ? w.fees : escrow;
        escrow -= f;
        w.principal -= p;
        w.interest -= i;
        w.fees -= f;
        w.stakeUsed = p + i + f;

        uint256 reserveCut = (i * _p("reserveFactorBps")) / 10000;
        _send(reserve, f + reserveCut);
        _send(payable(address(pool)), p + i - reserveCut);
        pool.onCashIn();
        if (escrow > 0) _send(payable(l.borrower), escrow);
        _releaseStake(l.borrower, l.stakeLocked);
        _releaseStake(l.guarantor, l.guarantorStakeLocked);
    }

    /// @dev Steps 1 and 2: locked borrower stake, then guarantor stake, at the fair share price.
    function _applyStakes(LoanTypes.Loan memory l, Waterfall memory w) internal {
        uint256 debt = w.principal + w.interest + w.fees;
        (uint256 s, uint256 v) = pool.burnStake(l.borrower, l.stakeLocked, debt, 0);
        _releaseStake(l.borrower, l.stakeLocked - s);
        w.stakeUsed = v;
        uint256 covered = v;

        if (covered < debt && l.guarantor != address(0)) {
            (uint256 gs, uint256 gv) = pool.burnStake(l.guarantor, l.guarantorStakeLocked, debt - covered, 0);
            _releaseStake(l.guarantor, l.guarantorStakeLocked - gs);
            w.guarantorUsed = gv;
            covered += gv;
        } else {
            _releaseStake(l.guarantor, l.guarantorStakeLocked);
        }

        // Stake value is applied to principal first, then interest, then fees. It stays in the pool
        // as a gain for remaining lenders; the reserve's share moves out as cash.
        uint256 p = covered < w.principal ? covered : w.principal;
        covered -= p;
        uint256 i = covered < w.interest ? covered : w.interest;
        covered -= i;
        uint256 f = covered < w.fees ? covered : w.fees;
        w.principal -= p;
        w.interest -= i;
        w.fees -= f;
        pool.transferToReserve(f + (i * _p("reserveFactorBps")) / 10000);
    }

    function _releaseStake(address account, uint256 shares) internal {
        if (account != address(0) && shares > 0) glp.unlock(account, shares);
    }

    function _recordClaim(LoanTypes.Loan memory l, LoanTypes.DefaultType dtype, uint256 amount, uint256 reserveDrawn) internal {
        Claim storage c = claims[l.memberId];
        c.amount += amount;
        c.reserveDrawn += reserveDrawn;
        c.loanId = l.id;
        c.dtype = dtype;
        c.workout = false;
        loanManager.setDefaultInfo(l.id, dtype, uint64(block.timestamp), false);
        emit ClaimRecorded(l.memberId, l.id, amount, reserveDrawn);
    }

    function _applyConsequences(
        LoanTypes.Loan memory l,
        IdentityRegistry.Member memory m,
        LoanTypes.DefaultType dtype,
        uint256 claimAmount
    ) internal {
        registry.recordDefault(l.memberId);
        if (m.completedLoans == 0 && l.paidCount == 0) registry.recordFirstPaymentDefault(m.cohortId);
        score.addScar(l.memberId, dtype);
        if (dtype == LoanTypes.DefaultType.Fraud) {
            registry.setBarred(l.memberId, true);
            registry.setClusterFlag(m.clusterId, true);
        }
        if (claimAmount > 0) {
            // Locked until the claim is settled; cooling-off proper starts at settlement.
            registry.setCoolingOff(l.memberId, type(uint64).max);
        } else {
            registry.setCoolingOff(l.memberId, _coolingOffUntil(dtype));
        }
    }

    function _coolingOffUntil(LoanTypes.DefaultType dtype) internal view returns (uint64) {
        uint256 spd = _p("secondsPerDay");
        if (dtype == LoanTypes.DefaultType.Strategic) return uint64(block.timestamp + _p("coolingStrategicDays") * spd);
        if (dtype == LoanTypes.DefaultType.Fraud) return type(uint64).max;
        return uint64(block.timestamp + _p("coolingHardshipDays") * spd);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Residual claim: recovery, settlement, workout
    // ─────────────────────────────────────────────────────────────────────

    function claimOf(uint256 memberId) external view returns (uint256) {
        return claims[memberId].amount;
    }

    function discountBps(LoanTypes.DefaultType dtype) public view returns (uint256) {
        if (dtype == LoanTypes.DefaultType.Hardship) return _p("discountHardshipBps");
        if (dtype == LoanTypes.DefaultType.Strategic) return _p("discountStrategicBps");
        return _p("discountFraudBps");
    }

    /**
     * @notice Lump sum that closes the claim today, discounted by default type.
     */
    function settlementQuote(uint256 memberId) public view returns (uint256) {
        Claim storage c = claims[memberId];
        return (c.amount * (10000 - discountBps(c.dtype))) / 10000;
    }

    /**
     * @notice Applies a recovery (residual sweep of deposits and payouts, or any payment) to a
     *         member's claim: the reserve is refilled first, then the pool.
     */
    function applyRecovery(uint256 memberId) external payable nonReentrant {
        uint256 used = _recover(memberId, msg.value);
        if (msg.value > used) _send(payable(msg.sender), msg.value - used);
        if (claims[memberId].amount == 0 && used > 0) _onClaimCleared(memberId);
    }

    /**
     * @notice Pays toward the caller's own claim. Paying at least settlementQuote closes it at the
     *         type's discount; a smaller amount is a partial payment with no discount.
     */
    function settleClaim() external payable nonReentrant {
        uint256 memberId = registry.memberOf(msg.sender);
        Claim storage c = claims[memberId];
        require(c.amount > 0, "No claim to settle");
        require(msg.value > 0, "Amount must be > 0");

        uint256 quote = settlementQuote(memberId);
        if (msg.value >= quote) {
            uint256 discount = c.amount - quote;
            uint256 used = _recover(memberId, quote);
            // The discount is written off (any unrecovered reserve draw included).
            c.reserveDrawn = 0;
            c.amount = 0;
            emit ClaimSettled(memberId, used, discount, true);
            if (msg.value > used) _send(payable(msg.sender), msg.value - used);
            _onClaimCleared(memberId);
        } else {
            uint256 used = _recover(memberId, msg.value);
            emit ClaimSettled(memberId, used, 0, false);
            if (msg.value > used) _send(payable(msg.sender), msg.value - used);
            if (c.amount == 0) _onClaimCleared(memberId);
        }
    }

    function _recover(uint256 memberId, uint256 value) internal returns (uint256 used) {
        Claim storage c = claims[memberId];
        used = value < c.amount ? value : c.amount;
        if (used == 0) return 0;
        c.amount -= used;

        uint256 toReserve = used < c.reserveDrawn ? used : c.reserveDrawn;
        c.reserveDrawn -= toReserve;
        uint256 toPool = used - toReserve;
        // As in V2's settleWrittenOffDebt: the reserve factor also applies to memo recoveries.
        uint256 reserveFactorCut = (toPool * _p("reserveFactorBps")) / 10000;
        _send(reserve, toReserve + reserveFactorCut);
        if (toPool > reserveFactorCut) {
            _send(payable(address(pool)), toPool - reserveFactorCut);
            pool.onCashIn();
        }
        totalRecovered += used;
        emit ClaimRecovered(memberId, used, toReserve, toPool - reserveFactorCut);
    }

    function _onClaimCleared(uint256 memberId) internal {
        Claim storage c = claims[memberId];
        bool viaWorkout = c.workout;
        LoanTypes.DefaultType dtype = c.dtype;
        c.workout = false;
        c.reserveDrawn = 0;
        registry.setCoolingOff(memberId, _coolingOffUntil(dtype));
        if (dtype != LoanTypes.DefaultType.Fraud) {
            score.shrinkScar(
                memberId,
                viaWorkout ? _p("workoutScarBps") : _p("settleScarBps"),
                viaWorkout ? bytes32("WORKOUT_COMPLETED") : bytes32("CLAIM_SETTLED")
            );
        }
        if (viaWorkout) emit WorkoutCompleted(memberId, c.loanId);
    }

    /**
     * @notice Hardship only: small fixed installments on the payout cycle, no interest, at most
     *         workoutMaxDays (6 months). Completing it earns back part of the scar and starts
     *         the 30-day cooling-off.
     */
    function startWorkout(uint256 loanId) external nonReentrant {
        uint256 memberId = registry.memberOf(msg.sender);
        Claim storage c = claims[memberId];
        require(memberId != 0 && c.loanId == loanId, "Not your defaulted loan");
        require(c.dtype == LoanTypes.DefaultType.Hardship, "Workout is for hardship defaults");
        require(c.amount > 0, "No claim");
        require(!c.workout, "Workout already active");

        uint32 period = registry.getMember(memberId).payoutPeriodDays;
        uint256 spd = _p("secondsPerDay");
        uint32 periods = uint32(_p("workoutMaxDays") / period);
        if (periods == 0) periods = 1;
        c.workout = true;
        c.workoutPeriods = periods;
        c.workoutInstallment = (c.amount + periods - 1) / periods;
        c.workoutNextDue = uint64(block.timestamp + uint256(period) * spd);
        c.workoutEndsAt = uint64(block.timestamp + uint256(periods) * period * spd);
        emit WorkoutStarted(memberId, loanId, c.workoutInstallment, periods, c.workoutEndsAt);
    }

    function payWorkout() external payable nonReentrant {
        uint256 memberId = registry.memberOf(msg.sender);
        Claim storage c = claims[memberId];
        require(c.workout, "No active workout");
        require(msg.value > 0, "Amount must be > 0");
        uint256 used = _recover(memberId, msg.value);
        if (msg.value > used) _send(payable(msg.sender), msg.value - used);
        uint256 period = uint256(registry.getMember(memberId).payoutPeriodDays) * _p("secondsPerDay");
        uint256 periodsPaid = used / c.workoutInstallment;
        c.workoutNextDue += uint64((periodsPaid == 0 ? 0 : periodsPaid) * period);
        if (c.amount == 0) _onClaimCleared(memberId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Appeals (21-day window, DISPUTE_ROLE decides)
    // ─────────────────────────────────────────────────────────────────────

    function appeal(uint256 loanId) external {
        LoanTypes.Loan memory l = loanManager.getLoan(loanId);
        require(l.status == LoanTypes.LoanStatus.Defaulted, "Loan not defaulted");
        require(registry.memberOf(msg.sender) == l.memberId, "Not your loan");
        require(!l.appealOpen, "Appeal already open");
        uint64 deadline = uint64(l.classifiedAt + _p("appealWindowDays") * _p("secondsPerDay"));
        require(block.timestamp <= deadline, "Appeal window closed");
        loanManager.setDefaultInfo(loanId, l.dtype, l.classifiedAt, true);
        emit Appealed(loanId, l.memberId, deadline);
    }

    function reclassify(uint256 loanId, LoanTypes.DefaultType newType) external onlyRole(DISPUTE_ROLE) {
        LoanTypes.Loan memory l = loanManager.getLoan(loanId);
        require(l.appealOpen, "No open appeal");
        require(newType != LoanTypes.DefaultType.None, "Invalid type");
        LoanTypes.DefaultType oldType = l.dtype;
        loanManager.setDefaultInfo(loanId, newType, l.classifiedAt, false);

        Claim storage c = claims[l.memberId];
        if (c.loanId == loanId) c.dtype = newType;
        IdentityRegistry.Member memory m = registry.getMember(l.memberId);
        if (oldType == LoanTypes.DefaultType.Fraud && newType != LoanTypes.DefaultType.Fraud) {
            registry.setBarred(l.memberId, false);
            if (c.amount == 0) registry.setCoolingOff(l.memberId, _coolingOffUntil(newType));
        } else if (newType == LoanTypes.DefaultType.Fraud) {
            registry.setBarred(l.memberId, true);
            registry.setClusterFlag(m.clusterId, true);
        }
        score.resizeScar(l.memberId, newType);
        emit Reclassified(loanId, oldType, newType);
    }

    function dismissAppeal(uint256 loanId) external onlyRole(DISPUTE_ROLE) {
        LoanTypes.Loan memory l = loanManager.getLoan(loanId);
        require(l.appealOpen, "No open appeal");
        loanManager.setDefaultInfo(loanId, l.dtype, l.classifiedAt, false);
        emit AppealDismissed(loanId);
    }

    // ─────────────────────────────────────────────────────────────────────

    function _send(address payable to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Transfer failed");
    }

    receive() external payable {
        require(msg.sender == address(loanManager), "Unexpected ETH");
    }
}
