// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./PolicyConfig.sol";
import "./IdentityRegistry.sol";
import "./GLPToken.sol";
import "./interfaces/IGigLend.sol";
import "./libraries/LoanTypes.sol";
import "./libraries/LoanOpsLib.sol";

/**
 * @title LoanManager
 * @notice Installment loans with IDs. The only contract that moves pool funds for loans.
 *         - Builder loans: funds held in escrow at 100%, released only on full repayment.
 *         - Unsecured loans: borrower (and guarantor) GLP stake locked for the life of the loan.
 *         - Fixed installments on the member's payout cycle; fees → interest → principal.
 *         - Stage is computed from timestamps on read (no keeper). Late fees and late marks are
 *           applied lazily, once per overdue installment, whenever anyone touches the loan.
 *         Defaults, claims, workouts and appeals live in DefaultManager; prevention rules in
 *         RiskEngine (split for the 24 KB contract-size limit).
 */
contract LoanManager is AccessControl, ReentrancyGuard {
    using LoanTypes for LoanTypes.Loan;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant DEFAULT_ROLE = keccak256("DEFAULT_ROLE"); // DefaultManager
    bytes32 public constant ROUTER_ROLE = keccak256("ROUTER_ROLE");   // MockPayoutRouter

    struct MemberStats {
        uint256 largestCompleted;
        uint256 largestCompletedUnsecured;
        uint32 builderCompleted;
        uint64 lastStepAt;
        uint64 prevStepAt;
        uint32 builderSinceDefault;
        bool hadDefault;
    }

    /// @dev Stage parameters loaded once per call so loops stay cheap.
    struct StageParams {
        uint256 spd;
        uint256 graceShort;
        uint256 graceLong;
        uint256 onsetEnd;
        uint256 defaultShort;
        uint256 defaultLong;
        uint256 longLoanDays;
        uint256 shockExtra;
    }

    PolicyConfig public immutable config;
    IdentityRegistry public immutable registry;
    GLPToken public immutable glp;
    ILendingPoolV3 public pool;
    ICreditScore public score;
    ISafeRepayVault public vault;
    address payable public reserve;
    IPayoutRouter public payouts;
    IRiskEngine public risk; // RiskEngine (quote + prevention)
    IDefaultManager public defaults;

    uint256 public loanCount;
    mapping(uint256 => LoanTypes.Loan) internal _loans;
    mapping(uint256 => uint256) public openLoanOf;            // memberId => loanId
    mapping(uint256 => uint256[]) internal _loansOfMember;
    uint256[] internal _activeIds;
    mapping(uint256 => uint256) internal _activeIndex;          // loanId => index + 1
    uint256 public totalOutstanding;
    mapping(bytes32 => uint256) public clusterExposure;
    uint64 public growthWindowStart;
    uint256 public originatedInWindow;
    mapping(uint256 => MemberStats) public memberStats;
    mapping(address => mapping(address => uint256)) public pledges; // guarantor => borrower => shares

    event LoanOpened(
        uint256 indexed loanId,
        uint256 indexed memberId,
        address indexed borrower,
        LoanTypes.LoanKind kind,
        uint256 principal,
        uint256 rateBps,
        uint16 nInstallments,
        uint32 periodDays,
        uint256 installment
    );
    // Kept from V2 for useEventSync.
    event Borrowed(address indexed user, uint256 amount, uint256 tenureDays, uint256 interestRateBps);
    event Repaid(address indexed user, uint256 amount, uint256 principalPaid, uint256 interestPaid, uint256 refund);
    event InstallmentPaid(uint256 indexed loanId, uint16 number, uint256 weightBps);
    event LoanRepaid(uint256 indexed loanId, uint256 indexed memberId);
    event LoanExited(uint256 indexed loanId, uint256 indexed memberId);
    event EscrowReleased(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event InstallmentMissed(uint256 indexed loanId, uint16 number, uint64 dueDate);
    event LateFeeCharged(uint256 indexed loanId, uint16 number, uint256 fee);
    event StakeApplied(uint256 indexed loanId, address indexed account, uint256 sharesBurned, uint256 value, bool guarantor);
    event BountyPaid(address indexed caller, uint256 indexed loanId, uint256 amount);
    event RestructureGranted(
        uint256 indexed loanId,
        LoanTypes.RestructureOption option,
        uint64 nextDueDate,
        uint256 installment,
        uint16 nInstallments,
        uint256 fee
    );
    event GuaranteeOffered(address indexed guarantor, address indexed borrower, uint256 shares);
    event GuaranteeWithdrawn(address indexed guarantor, address indexed borrower, uint256 shares);
    event SweepApplied(uint256 indexed loanId, uint256 amount, uint256 expected);
    event AutopayCollected(uint256 indexed loanId, uint256 amount);

    constructor(address admin, PolicyConfig _config, IdentityRegistry _registry, GLPToken _glp) {
        config = _config;
        registry = _registry;
        glp = _glp;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /**
     * @notice One-time wiring of the other protocol contracts.
     */
    function wire(
        address _pool,
        address _score,
        address _vault,
        address payable _reserve,
        address _payouts,
        address _risk,
        address _defaults
    ) external onlyRole(ADMIN_ROLE) {
        require(address(pool) == address(0), "Already wired");
        pool = ILendingPoolV3(_pool);
        score = ICreditScore(_score);
        vault = ISafeRepayVault(_vault);
        reserve = _reserve;
        payouts = IPayoutRouter(_payouts);
        risk = IRiskEngine(_risk);
        defaults = IDefaultManager(_defaults);
    }

    function _p(bytes32 key) internal view returns (uint256) {
        return config.get(key);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Origination
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Opens an installment loan. All prevention checks run before money leaves the pool.
     * @param kind Builder (escrowed) or Unsecured.
     * @param amount Principal in wei.
     * @param nInstallments Number of installments on the member's payout cycle.
     * @param guarantor Optional guarantor who pledged GLP via offerGuarantee (or address(0)).
     * @param autopayOn SafeRepay + income sweep (opt-out). msg.value prefunds the vault.
     */
    function openLoan(
        LoanTypes.LoanKind kind,
        uint256 amount,
        uint16 nInstallments,
        address guarantor,
        bool autopayOn
    ) external payable nonReentrant returns (uint256 loanId) {
        uint256 memberId = registry.memberOf(msg.sender);
        require(memberId != 0, "Not registered");
        {
            (bool ok, string memory reason) = registry.eligibility(msg.sender);
            require(ok, reason);
        }
        require(openLoanOf[memberId] == 0, "Existing loan must be repaid");
        require(msg.value == 0 || autopayOn, "Prefund needs autopay");

        IdentityRegistry.Member memory m = registry.getMember(memberId);
        // Pricing, utilisation cap and every prevention rule; reverts with the failing reason.
        (uint256 rateBps, uint256 totalInterest, uint256 installment) =
            risk.quote(memberId, kind, amount, nInstallments);

        loanId = ++loanCount;
        LoanTypes.Loan storage l = _loans[loanId];
        l.id = loanId;
        l.memberId = memberId;
        l.borrower = msg.sender;
        l.kind = kind;
        l.status = LoanTypes.LoanStatus.Active;
        l.principal = amount;
        l.outstandingPrincipal = amount;
        l.rateBps = rateBps;
        l.periodDays = m.payoutPeriodDays;
        l.nInstallments = nInstallments;
        l.installment = installment;
        l.startAt = uint64(block.timestamp);
        l.nextDueDate = uint64(block.timestamp + uint256(m.payoutPeriodDays) * _p("secondsPerDay"));
        l.interestRemaining = totalInterest;
        l.tierAtOpen = m.tier;
        l.cohortId = m.cohortId;
        l.autopay = autopayOn;
        _startInstallment(l);

        LoanOpsLib.lockStake(l, pledges, _deps(), guarantor);
        _recordOrigination(l, m);

        if (kind == LoanTypes.LoanKind.Builder) {
            l.escrow = amount;
            pool.disburse(address(this), amount);
        } else {
            pool.disburse(msg.sender, amount);
        }

        if (autopayOn) {
            vault.setupFor(
                msg.sender,
                installment + _p("lateFeeFlatWei"),
                uint64(l.nextDueDate + uint256(nInstallments + 1) * m.payoutPeriodDays * _p("secondsPerDay"))
            );
            if (msg.value > 0) vault.depositFor{value: msg.value}(msg.sender);
        }

        emit LoanOpened(loanId, memberId, msg.sender, kind, amount, rateBps, nInstallments, m.payoutPeriodDays, installment);
        emit Borrowed(msg.sender, amount, uint256(nInstallments) * m.payoutPeriodDays, rateBps);
    }

    function _recordOrigination(LoanTypes.Loan storage l, IdentityRegistry.Member memory m) internal {
        uint256 maxActive = _p("maxActiveLoans");
        require(_activeIds.length < maxActive, "Active loan set full");
        _activeIds.push(l.id);
        _activeIndex[l.id] = _activeIds.length;
        openLoanOf[l.memberId] = l.id;

        if (_loansOfMember[l.memberId].length == 0 && m.completedLoans == 0) {
            registry.recordFirstLoan(m.cohortId);
        }
        _loansOfMember[l.memberId].push(l.id);

        totalOutstanding += l.principal;
        clusterExposure[m.clusterId] += l.principal;

        uint256 week = 7 * _p("secondsPerDay");
        if (block.timestamp >= uint256(growthWindowStart) + week) {
            growthWindowStart = uint64(block.timestamp);
            originatedInWindow = 0;
        }
        originatedInWindow += l.principal;

        MemberStats storage ms = memberStats[l.memberId];
        if (ms.largestCompleted > 0 && l.principal > ms.largestCompleted) {
            ms.prevStepAt = ms.lastStepAt;
            ms.lastStepAt = uint64(block.timestamp);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Guarantees
    // ─────────────────────────────────────────────────────────────────────

    /// @notice A guarantor locks GLP for a borrower's next loan.
    function offerGuarantee(address borrower, uint256 shares) external nonReentrant {
        require(shares > 0, "Zero shares");
        require(borrower != msg.sender, "Self-guarantee not allowed");
        glp.lock(msg.sender, shares);
        pledges[msg.sender][borrower] += shares;
        emit GuaranteeOffered(msg.sender, borrower, shares);
    }

    /// @notice Releases a pledge that no loan has used.
    function withdrawGuarantee(address borrower) external nonReentrant {
        uint256 shares = pledges[msg.sender][borrower];
        require(shares > 0, "No pledge");
        delete pledges[msg.sender][borrower];
        glp.unlock(msg.sender, shares);
        emit GuaranteeWithdrawn(msg.sender, borrower, shares);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Repayment
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Pays toward a loan: late fees, then the current installment's interest, then its
     *         principal, then later installments. Any excess is refunded to the payer.
     */
    function repayInstallment(uint256 loanId) external payable nonReentrant {
        LoanTypes.Loan storage l = _loans[loanId];
        require(l.status == LoanTypes.LoanStatus.Active, "No active loan");
        require(msg.value > 0, "Repayment amount must be > 0");

        (uint256 used, uint256 principalPaid, uint256 interestPaid, uint256 feesPaid) = _applyPayment(l, msg.value);
        _routeCash(principalPaid, interestPaid, feesPaid);

        uint256 refund = msg.value - used;
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            require(ok, "Refund failed");
        }
        emit Repaid(l.borrower, msg.value, principalPaid, interestPaid, refund);
    }

    /**
     * @notice Anyone may trigger a SafeRepay pull for the amount currently due.
     */
    function autopay(uint256 loanId) external nonReentrant {
        LoanTypes.Loan storage l = _loans[loanId];
        require(l.status == LoanTypes.LoanStatus.Active, "No active loan");
        require(l.autopay, "Autopay off");
        _accrueLate(l);
        uint256 due = _amountDue(l);
        require(due > 0, "Nothing due");
        uint256 pulled = vault.pull(l.borrower, due);
        require(pulled > 0, "Nothing to collect");
        (uint256 used, uint256 principalPaid, uint256 interestPaid, uint256 feesPaid) = _applyPayment(l, pulled);
        _routeCash(principalPaid, interestPaid, feesPaid);
        if (pulled > used) vault.depositFor{value: pulled - used}(l.borrower);
        emit AutopayCollected(loanId, used);
        emit Repaid(l.borrower, used, principalPaid, interestPaid, 0);
    }

    /**
     * @notice Income sweep share of a payout for `worker` (0 if no open autopay loan).
     */
    function sweepQuote(address worker, uint256 payoutAmount) external view returns (uint256) {
        uint256 loanId = openLoanOf[registry.memberOf(worker)];
        if (loanId == 0) return 0;
        LoanTypes.Loan storage l = _loans[loanId];
        if (!l.autopay) return 0;
        uint256 share = (payoutAmount * _p("sweepBps")) / 10000;
        uint256 due = _amountDue(l) + _pendingLateFee(l);
        return share < due ? share : due;
    }

    function applySweep(address worker) external payable onlyRole(ROUTER_ROLE) nonReentrant {
        uint256 loanId = openLoanOf[registry.memberOf(worker)];
        require(loanId != 0, "No open loan");
        LoanTypes.Loan storage l = _loans[loanId];
        (uint256 used, uint256 principalPaid, uint256 interestPaid, uint256 feesPaid) = _applyPayment(l, msg.value);
        _routeCash(principalPaid, interestPaid, feesPaid);
        if (msg.value > used) {
            (bool ok, ) = worker.call{value: msg.value - used}("");
            require(ok, "Sweep refund failed");
        }
        emit SweepApplied(loanId, used, l.installment);
        emit Repaid(l.borrower, used, principalPaid, interestPaid, 0);
    }

    /**
     * @notice Penalty-free exit within penaltyFreeExitDays of disbursement: return the principal
     *         with no interest or fees (Builder: the escrow simply returns to the pool).
     */
    function exitLoan(uint256 loanId) external payable nonReentrant {
        LoanTypes.Loan storage l = _loans[loanId];
        require(l.status == LoanTypes.LoanStatus.Active, "No active loan");
        require(msg.sender == l.borrower, "Not borrower");
        require(l.paidCount == 0 && l.outstandingPrincipal == l.principal, "Repayments already made");
        require(block.timestamp <= l.startAt + _p("penaltyFreeExitDays") * _p("secondsPerDay"), "Exit window closed");

        uint256 owed = l.kind == LoanTypes.LoanKind.Builder ? 0 : l.principal;
        require(msg.value >= owed, "Return the full principal");

        l.status = LoanTypes.LoanStatus.Exited;
        _releaseLoan(l);
        uint256 toPool = owed + l.escrow;
        l.escrow = 0;
        l.outstandingPrincipal = 0;
        _sendToPool(toPool);
        if (msg.value > owed) {
            (bool ok, ) = msg.sender.call{value: msg.value - owed}("");
            require(ok, "Refund failed");
        }
        emit LoanExited(loanId, l.memberId);
    }

    function _applyPayment(LoanTypes.Loan storage l, uint256 value)
        internal
        returns (uint256 used, uint256 principalPaid, uint256 interestPaid, uint256 feesPaid)
    {
        _accrueLate(l);

        feesPaid = value < l.lateFeesDue ? value : l.lateFeesDue;
        l.lateFeesDue -= feesPaid;
        value -= feesPaid;

        while (value > 0 && l.status == LoanTypes.LoanStatus.Active) {
            uint256 owed = l.curInterestPortion - l.curInterestPaid;
            uint256 pay = value < owed ? value : owed;
            l.curInterestPaid += pay;
            l.interestRemaining -= pay;
            interestPaid += pay;
            value -= pay;

            owed = l.curPrincipalPortion - l.curPrincipalPaid;
            pay = value < owed ? value : owed;
            l.curPrincipalPaid += pay;
            l.outstandingPrincipal -= pay;
            principalPaid += pay;
            value -= pay;

            if (l.curInterestPaid == l.curInterestPortion && l.curPrincipalPaid == l.curPrincipalPortion) {
                _completeInstallment(l);
            } else {
                break;
            }
        }

        if (principalPaid > 0) {
            totalOutstanding -= principalPaid;
            bytes32 cluster = registry.getMember(l.memberId).clusterId;
            clusterExposure[cluster] = clusterExposure[cluster] > principalPaid ? clusterExposure[cluster] - principalPaid : 0;
        }
        used = feesPaid + interestPaid + principalPaid;
    }

    /// @dev Fees and the reserve cut of interest go to ReserveFund; the rest returns to the pool.
    function _routeCash(uint256 principalPaid, uint256 interestPaid, uint256 feesPaid) internal {
        uint256 reserveCut = (interestPaid * _p("reserveFactorBps")) / 10000;
        uint256 toReserve = feesPaid + reserveCut;
        if (toReserve > 0) {
            (bool ok, ) = reserve.call{value: toReserve}("");
            require(ok, "Reserve transfer failed");
        }
        _sendToPool(principalPaid + interestPaid - reserveCut);
    }

    function _sendToPool(uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = address(pool).call{value: amount}("");
        require(ok, "Pool transfer failed");
        pool.onCashIn();
    }

    function _completeInstallment(LoanTypes.Loan storage l) internal {
        uint16 number = l.paidCount + 1;
        uint256 weight = _timelinessWeight(l, number);
        l.paidCount = number;
        score.recordInstallment(l.memberId, weight);
        emit InstallmentPaid(l.id, number, weight);

        if (l.paidCount >= l.nInstallments || (l.outstandingPrincipal == 0 && l.interestRemaining == 0)) {
            _closeRepaid(l);
            return;
        }
        l.nextDueDate += uint64(uint256(l.periodDays) * _p("secondsPerDay"));
        if (block.timestamp <= l.nextDueDate) l.firstMissedAt = 0;
        _startInstallment(l);
    }

    /// @dev On time 100%, late within grace (or covered by an early restructure request) 60%, late 20%.
    function _timelinessWeight(LoanTypes.Loan storage l, uint16 number) internal view returns (uint256) {
        if (block.timestamp <= l.nextDueDate || _shockActive(l)) return _p("weightOnTimeBps");
        if (l.helpFor == number) return _p("weightGraceBps");
        StageParams memory sp = _stageParams();
        uint256 daysLate = (block.timestamp - l.nextDueDate) / sp.spd;
        return daysLate <= _graceDays(l, sp) ? _p("weightGraceBps") : _p("weightLateBps");
    }

    function _startInstallment(LoanTypes.Loan storage l) internal {
        uint256 k = l.nInstallments - l.paidCount;
        if (k == 0) return;
        l.curInterestPortion = k == 1 ? l.interestRemaining : l.interestRemaining / k;
        l.curPrincipalPortion = k == 1 ? l.outstandingPrincipal : l.outstandingPrincipal / k;
        l.curInterestPaid = 0;
        l.curPrincipalPaid = 0;
    }

    function _closeRepaid(LoanTypes.Loan storage l) internal {
        l.status = LoanTypes.LoanStatus.Repaid;
        l.curInterestPortion = 0;
        l.curPrincipalPortion = 0;
        _releaseLoan(l);

        MemberStats storage ms = memberStats[l.memberId];
        if (l.principal > ms.largestCompleted) ms.largestCompleted = l.principal;
        if (l.kind == LoanTypes.LoanKind.Builder) {
            ms.builderCompleted += 1;
            ms.builderSinceDefault += 1;
        } else if (l.principal > ms.largestCompletedUnsecured) {
            ms.largestCompletedUnsecured = l.principal;
        }
        score.recordLoanCompleted(l.memberId);
        registry.recordLoanCompleted(l.memberId);

        if (l.escrow > 0) {
            uint256 e = l.escrow;
            l.escrow = 0;
            (bool ok, ) = l.borrower.call{value: e}("");
            require(ok, "Escrow release failed");
            emit EscrowReleased(l.id, l.borrower, e);
        }
        emit LoanRepaid(l.id, l.memberId);
    }

    /// @dev Removes the loan from the open set and unlocks any remaining stake.
    function _releaseLoan(LoanTypes.Loan storage l) internal {
        openLoanOf[l.memberId] = 0;
        _removeActive(l.id);
        if (l.status == LoanTypes.LoanStatus.Exited) {
            totalOutstanding -= l.outstandingPrincipal;
            bytes32 cluster = registry.getMember(l.memberId).clusterId;
            clusterExposure[cluster] -= l.outstandingPrincipal;
        }
        if (l.stakeLocked > 0) {
            glp.unlock(l.borrower, l.stakeLocked);
            l.stakeLocked = 0;
        }
        if (l.guarantorStakeLocked > 0) {
            glp.unlock(l.guarantor, l.guarantorStakeLocked);
            l.guarantorStakeLocked = 0;
        }
    }

    function _removeActive(uint256 loanId) internal {
        uint256 idx = _activeIndex[loanId];
        if (idx == 0) return;
        uint256 lastId = _activeIds[_activeIds.length - 1];
        _activeIds[idx - 1] = lastId;
        _activeIndex[lastId] = idx;
        _activeIds.pop();
        delete _activeIndex[loanId];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Lifecycle: stages, late fees, collect, restructure, shock mode
    // ─────────────────────────────────────────────────────────────────────

    function _stageParams() internal view returns (StageParams memory sp) {
        sp.spd = _p("secondsPerDay");
        sp.graceShort = _p("graceDaysShort");
        sp.graceLong = _p("graceDaysLong");
        sp.onsetEnd = _p("onsetEndDay");
        sp.defaultShort = _p("defaultDayShort");
        sp.defaultLong = _p("defaultDayLong");
        sp.longLoanDays = _p("longLoanDays");
        sp.shockExtra = _p("shockExtraGraceDays");
    }

    function _isLongLoan(LoanTypes.Loan storage l, StageParams memory sp) internal view returns (bool) {
        return uint256(l.nInstallments) * l.periodDays > sp.longLoanDays;
    }

    /// @dev 3 days, or 7 for Trusted/Prime members or loans over 3 months; plus shock extension.
    function _graceDays(LoanTypes.Loan storage l, StageParams memory sp) internal view returns (uint256 g) {
        g = (l.tierAtOpen >= 3 || _isLongLoan(l, sp)) ? sp.graceLong : sp.graceShort;
        if (_shockActive(l)) g += sp.shockExtra;
    }

    /// @dev Day 30, or 45 for loans over 3 months.
    function _defaultDay(LoanTypes.Loan storage l, StageParams memory sp) internal view returns (uint256) {
        return _isLongLoan(l, sp) ? sp.defaultLong : sp.defaultShort;
    }

    function _shockActive(LoanTypes.Loan storage l) internal view returns (bool) {
        return registry.shockUntil(l.cohortId) > block.timestamp;
    }

    function _stage(LoanTypes.Loan storage l, StageParams memory sp) internal view returns (LoanTypes.Stage) {
        if (block.timestamp <= l.nextDueDate) return LoanTypes.Stage.Active;
        uint256 daysLate = (block.timestamp - l.nextDueDate) / sp.spd;
        if (daysLate <= _graceDays(l, sp)) return LoanTypes.Stage.Grace;
        if (daysLate <= sp.onsetEnd) return LoanTypes.Stage.Onset;
        if (daysLate < _defaultDay(l, sp)) return LoanTypes.Stage.Significant;
        return LoanTypes.Stage.DefaultEligible;
    }

    function stageOf(uint256 loanId) public view returns (LoanTypes.Stage) {
        LoanTypes.Loan storage l = _loans[loanId];
        require(l.status == LoanTypes.LoanStatus.Active, "Loan not active");
        return _stage(l, _stageParams());
    }

    function _lateFeeFor(LoanTypes.Loan storage l) internal view returns (uint256) {
        uint256 flat = _p("lateFeeFlatWei");
        uint256 cap = (l.installment * _p("lateFeeCapBps")) / 10000;
        return flat < cap ? flat : cap;
    }

    /// @dev Late fee not yet materialised (for views): due once the stage reaches Onset.
    function _pendingLateFee(LoanTypes.Loan storage l) internal view returns (uint256) {
        if (l.status != LoanTypes.LoanStatus.Active || block.timestamp <= l.nextDueDate) return 0;
        uint16 number = l.paidCount + 1;
        if (l.lateFeeChargedFor >= number || l.helpFor == number || _shockActive(l)) return 0;
        if (uint8(_stage(l, _stageParams())) < uint8(LoanTypes.Stage.Onset)) return 0;
        return _lateFeeFor(l);
    }

    /**
     * @dev Materialises InstallmentMissed, the flat capped late fee (once per installment, never
     *      compounding) and the late score mark. Grace: nothing. Shock mode: no fee, no mark.
     */
    function _accrueLate(LoanTypes.Loan storage l) internal {
        if (l.status != LoanTypes.LoanStatus.Active || block.timestamp <= l.nextDueDate) return;
        uint16 number = l.paidCount + 1;
        if (l.firstMissedAt == 0) l.firstMissedAt = l.nextDueDate;
        if (l.missedFor < number) {
            l.missedFor = number;
            emit InstallmentMissed(l.id, number, l.nextDueDate);
        }
        if (_shockActive(l) || l.helpFor == number) return;
        if (uint8(_stage(l, _stageParams())) < uint8(LoanTypes.Stage.Onset)) return;

        if (l.lateFeeChargedFor < number) {
            uint256 fee = _lateFeeFor(l);
            l.lateFeesDue += fee;
            l.lateFeeChargedFor = number;
            emit LateFeeCharged(l.id, number, fee);
        }
        if (l.lateMarkedFor < number) {
            l.lateMarkedFor = number;
            score.recordLateMark(l.memberId);
        }
    }

    /// @notice Anyone may materialise late status (keeper-less).
    function accrueLate(uint256 loanId) external {
        _accrueLate(_loans[loanId]);
    }

    /**
     * @notice Significant stage only: applies locked stake (borrower first, then guarantor) to
     *         the missed installment and pays the caller a bounty from the late fee. Reverts
     *         before the stage begins, so the bounty can never pull collection forward.
     */
    function collect(uint256 loanId) external nonReentrant {
        LoanTypes.Loan storage l = _loans[loanId];
        require(l.status == LoanTypes.LoanStatus.Active, "No active loan");
        _accrueLate(l);
        require(_stage(l, _stageParams()) == LoanTypes.Stage.Significant, "Not in Significant stage");

        uint256 due = _amountDue(l);
        require(due > 0, "Nothing due");
        uint256 excluded = _carried(l, _stageParams());

        (uint256 shares, uint256 value) = pool.burnStake(l.borrower, l.stakeLocked, due, excluded);
        l.stakeLocked -= shares;
        if (shares > 0) emit StakeApplied(loanId, l.borrower, shares, value, false);

        if (value < due && l.guarantorStakeLocked > 0) {
            (uint256 gShares, uint256 gValue) = pool.burnStake(l.guarantor, l.guarantorStakeLocked, due - value, excluded);
            l.guarantorStakeLocked -= gShares;
            value += gValue;
            if (gShares > 0) emit StakeApplied(loanId, l.guarantor, gShares, gValue, true);
        }
        require(value > 0, "No stake to apply");

        // Stake value stays in the pool: principal reduces the loan asset, interest accrues to
        // remaining shareholders. Fees and the reserve cut move from pool cash to the reserve.
        (, , uint256 interestPaid, uint256 feesPaid) = _applyPayment(l, value);
        pool.transferToReserve(feesPaid + (interestPaid * _p("reserveFactorBps")) / 10000);

        uint256 bounty = (feesPaid * _p("bountyShareBps")) / 10000;
        if (bounty > 0) {
            uint256 paid = IReserveFund(reserve).payBounty(msg.sender, bounty);
            emit BountyPaid(msg.sender, loanId, paid);
        }
    }

    /**
     * @notice One priced restructure per loan (PaymentHoliday or TenureStretch), asked for
     *         before the due date or during Onset. See LoanOpsLib.restructure.
     */
    function requestRestructure(uint256 loanId, LoanTypes.RestructureOption option) external nonReentrant {
        LoanTypes.Loan storage l = _loans[loanId];
        require(l.status == LoanTypes.LoanStatus.Active, "No active loan");
        require(msg.sender == l.borrower, "Not borrower");
        LoanTypes.Stage s = _stage(l, _stageParams());
        require(s == LoanTypes.Stage.Active || s == LoanTypes.Stage.Onset, "Restructure only before due or in Onset");
        LoanOpsLib.restructure(l, _deps(), option);
    }

    function _deps() internal view returns (LoanOpsLib.Deps memory) {
        return LoanOpsLib.Deps(config, registry, score, payouts, pool, glp);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Default hand-off (DefaultManager)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Permissionless entry point; DefaultManager enforces the timing and pays the bounty.
    function markDefault(uint256 loanId) external {
        defaults.markDefaultFor(loanId, msg.sender);
    }

    /**
     * @notice Closes a loan as defaulted and hands any Builder escrow to DefaultManager.
     *         Locked stake stays locked for the waterfall.
     */
    function closeDefaulted(uint256 loanId) external onlyRole(DEFAULT_ROLE) nonReentrant returns (LoanTypes.Loan memory snapshot) {
        LoanTypes.Loan storage l = _loans[loanId];
        require(l.status == LoanTypes.LoanStatus.Active, "No active loan");
        _accrueLate(l);
        snapshot = l;
        l.status = LoanTypes.LoanStatus.Defaulted;
        openLoanOf[l.memberId] = 0;
        _removeActive(loanId);
        totalOutstanding -= l.outstandingPrincipal;
        bytes32 cluster = registry.getMember(l.memberId).clusterId;
        clusterExposure[cluster] = clusterExposure[cluster] > l.outstandingPrincipal ? clusterExposure[cluster] - l.outstandingPrincipal : 0;
        l.stakeLocked = 0;
        l.guarantorStakeLocked = 0;
        MemberStats storage ms = memberStats[l.memberId];
        ms.hadDefault = true;
        ms.builderSinceDefault = 0;
        if (l.escrow > 0) {
            uint256 e = l.escrow;
            l.escrow = 0;
            (bool ok, ) = msg.sender.call{value: e}("");
            require(ok, "Escrow transfer failed");
        }
    }

    function setDefaultInfo(uint256 loanId, LoanTypes.DefaultType dtype, uint64 classifiedAt, bool appealOpen)
        external
        onlyRole(DEFAULT_ROLE)
    {
        LoanTypes.Loan storage l = _loans[loanId];
        l.dtype = dtype;
        l.classifiedAt = classifiedAt;
        l.appealOpen = appealOpen;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────

    function getLoan(uint256 loanId) external view returns (LoanTypes.Loan memory) {
        return _loans[loanId];
    }

    function loansOfMember(uint256 memberId) external view returns (uint256[] memory) {
        return _loansOfMember[memberId];
    }

    function activeLoanIds() external view returns (uint256[] memory) {
        return _activeIds;
    }

    function hasOpenLoan(uint256 memberId) external view returns (bool) {
        return openLoanOf[memberId] != 0;
    }

    function _amountDue(LoanTypes.Loan storage l) internal view returns (uint256) {
        if (l.status != LoanTypes.LoanStatus.Active) return 0;
        return l.lateFeesDue + (l.curInterestPortion - l.curInterestPaid) + (l.curPrincipalPortion - l.curPrincipalPaid);
    }

    /// @notice Fees plus what remains of the current installment (including a pending late fee).
    function amountDue(uint256 loanId) external view returns (uint256) {
        LoanTypes.Loan storage l = _loans[loanId];
        return _amountDue(l) + _pendingLateFee(l);
    }

    /// @notice Everything left on the schedule (fees + principal + scheduled interest).
    function payoffAmount(uint256 loanId) external view returns (uint256) {
        LoanTypes.Loan storage l = _loans[loanId];
        if (l.status != LoanTypes.LoanStatus.Active) return 0;
        return l.lateFeesDue + _pendingLateFee(l) + l.outstandingPrincipal + l.interestRemaining;
    }

    function _carried(LoanTypes.Loan storage l, StageParams memory sp) internal view returns (uint256) {
        if (l.status != LoanTypes.LoanStatus.Active) return 0;
        if (l.kind == LoanTypes.LoanKind.Builder) return l.outstandingPrincipal; // escrow-backed
        LoanTypes.Stage s = _stage(l, sp);
        if (s == LoanTypes.Stage.Active || s == LoanTypes.Stage.Grace) return l.outstandingPrincipal;
        if (s == LoanTypes.Stage.Onset) return (l.outstandingPrincipal * _p("carryOnsetBps")) / 10000;
        if (s == LoanTypes.Stage.Significant) return (l.outstandingPrincipal * _p("carrySignificantBps")) / 10000;
        return 0;
    }

    function carriedOf(uint256 loanId) external view returns (uint256) {
        return _carried(_loans[loanId], _stageParams());
    }

    /**
     * @notice Σ carried value over the bounded active-loan set (≤ maxActiveLoans).
     */
    function carriedValue() external view returns (uint256 total) {
        StageParams memory sp = _stageParams();
        for (uint256 i = 0; i < _activeIds.length; i++) {
            total += _carried(_loans[_activeIds[i]], sp);
        }
    }

    receive() external payable {
        require(msg.sender == address(pool) || msg.sender == address(vault), "Unexpected ETH");
    }
}
