// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./PolicyConfig.sol";
import "./IdentityRegistry.sol";
import "./libraries/LoanTypes.sol";

/**
 * @title CreditScore
 * @notice CIBIL-like 300–900 score keyed by memberId, so a new wallet for the same identity
 *         inherits it. Positive inputs: completed installments weighted by timeliness, completed
 *         loans, stake age. Negative inputs: late marks, restructures, misdeclared debt and
 *         default scars that fade over two years to a permanent 30% floor.
 *         Every change emits ScoreChanged(memberId, delta, reasonCode) and can be disputed.
 */
contract CreditScore is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");
    bytes32 public constant DISPUTE_ROLE = keccak256("DISPUTE_ROLE");

    uint256 public constant MIN_SCORE = 300;
    uint256 public constant MAX_SCORE = 900;
    uint256 public constant MAX_SCARS = 4;

    struct Stats {
        uint256 installmentWeightBps; // sum of weights (10000 = one on-time installment)
        uint32 completedLoans;
        uint32 lateMarks;
        uint32 restructures;
        int256 manualAdjustment;      // dispute resolutions
    }

    struct Scar {
        uint256 size;      // points at full strength
        uint64 startedAt;
        uint8 dtype;
    }

    PolicyConfig public immutable config;
    IdentityRegistry public immutable registry;

    mapping(uint256 => Stats) public stats;
    mapping(uint256 => Scar[]) private _scars;
    uint256 public disputeCount;

    event ScoreChanged(uint256 indexed memberId, int256 delta, bytes32 indexed reasonCode);
    event ScoreDisputed(uint256 indexed memberId, uint256 indexed disputeId, bytes32 reasonCode, bytes32 detailHash);
    event ScoreAdjusted(uint256 indexed memberId, int256 delta, uint256 indexed disputeId);

    constructor(address admin, PolicyConfig _config, IdentityRegistry _registry) {
        config = _config;
        registry = _registry;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(DISPUTE_ROLE, admin);
    }

    function _p(bytes32 key) internal view returns (uint256) {
        return config.get(key);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Recorders (LoanManager / DefaultManager)
    // ─────────────────────────────────────────────────────────────────────

    function recordInstallment(uint256 memberId, uint256 weightBps) external onlyRole(LOAN_ROLE) {
        stats[memberId].installmentWeightBps += weightBps;
        emit ScoreChanged(memberId, int256((_p("installmentPoints") * weightBps) / 10000), "INSTALLMENT_PAID");
    }

    function recordLoanCompleted(uint256 memberId) external onlyRole(LOAN_ROLE) {
        stats[memberId].completedLoans += 1;
        emit ScoreChanged(memberId, int256(_p("loanPoints")), "LOAN_COMPLETED");
    }

    function recordLateMark(uint256 memberId) external onlyRole(LOAN_ROLE) {
        stats[memberId].lateMarks += 1;
        emit ScoreChanged(memberId, -int256(_p("lateMarkPoints")), "LATE_INSTALLMENT");
    }

    function recordRestructure(uint256 memberId) external onlyRole(LOAN_ROLE) {
        stats[memberId].restructures += 1;
        emit ScoreChanged(memberId, -int256(_p("restructurePoints")), "RESTRUCTURE_USED");
    }

    /**
     * @notice Adds a default scar. A second default hits harder (full strategic size).
     */
    function addScar(uint256 memberId, LoanTypes.DefaultType dtype) external onlyRole(LOAN_ROLE) {
        Scar[] storage s = _scars[memberId];
        uint256 size = _scarSize(dtype, s.length);
        if (s.length < MAX_SCARS) {
            s.push(Scar(size, uint64(block.timestamp), uint8(dtype)));
        } else {
            s[MAX_SCARS - 1] = Scar(size, uint64(block.timestamp), uint8(dtype));
        }
        emit ScoreChanged(memberId, -int256(size), "DEFAULT_SCAR");
    }

    /**
     * @notice Re-sizes the latest scar after an appeal reclassifies the default.
     */
    function resizeScar(uint256 memberId, LoanTypes.DefaultType dtype) external onlyRole(LOAN_ROLE) {
        Scar[] storage s = _scars[memberId];
        require(s.length > 0, "No scar");
        Scar storage last = s[s.length - 1];
        uint256 newSize = _scarSize(dtype, s.length - 1);
        int256 delta = int256(last.size) - int256(newSize);
        last.size = newSize;
        last.dtype = uint8(dtype);
        emit ScoreChanged(memberId, delta, "SCAR_RECLASSIFIED");
    }

    /**
     * @notice Shrinks the latest scar to keepBps of its size (settlement or completed workout).
     *         Never removes it: keepBps is bounded below by the policy floor.
     */
    function shrinkScar(uint256 memberId, uint256 keepBps, bytes32 reason) external onlyRole(LOAN_ROLE) {
        Scar[] storage s = _scars[memberId];
        if (s.length == 0) return;
        Scar storage last = s[s.length - 1];
        uint256 floorBps = _p("scarFloorBps");
        if (keepBps < floorBps) keepBps = floorBps;
        uint256 newSize = (last.size * keepBps) / 10000;
        int256 delta = int256(last.size) - int256(newSize);
        last.size = newSize;
        emit ScoreChanged(memberId, delta, reason);
    }

    function _scarSize(LoanTypes.DefaultType dtype, uint256 priorScars) internal view returns (uint256) {
        if (dtype == LoanTypes.DefaultType.Hardship && priorScars == 0) return _p("scarHardshipPoints");
        return _p("scarStrategicPoints");
    }

    // ─────────────────────────────────────────────────────────────────────
    // Disputes
    // ─────────────────────────────────────────────────────────────────────

    /// @notice A member disputes a score change (reason code + hash of off-chain details).
    function disputeScore(bytes32 reasonCode, bytes32 detailHash) external returns (uint256 disputeId) {
        uint256 memberId = registry.memberOf(msg.sender);
        require(memberId != 0, "Not registered");
        disputeId = ++disputeCount;
        emit ScoreDisputed(memberId, disputeId, reasonCode, detailHash);
    }

    function adjustScore(uint256 memberId, int256 delta, uint256 disputeId) external onlyRole(DISPUTE_ROLE) {
        stats[memberId].manualAdjustment += delta;
        emit ScoreAdjusted(memberId, delta, disputeId);
        emit ScoreChanged(memberId, delta, "DISPUTE_ADJUSTMENT");
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Current strength of one scar: linear fade from full size to floor over
     *         scarDecayDays, then flat at the floor forever.
     */
    function scarStrength(uint256 size, uint64 startedAt) public view returns (uint256) {
        uint256 floor = (size * _p("scarFloorBps")) / 10000;
        uint256 decay = _p("scarDecayDays") * config.secondsPerDay();
        uint256 elapsed = block.timestamp - startedAt;
        if (elapsed >= decay) return floor;
        return size - ((size - floor) * elapsed) / decay;
    }

    function totalScar(uint256 memberId) public view returns (uint256 total) {
        Scar[] storage s = _scars[memberId];
        for (uint256 i = 0; i < s.length; i++) total += scarStrength(s[i].size, s[i].startedAt);
    }

    function scarsOf(uint256 memberId) external view returns (Scar[] memory) {
        return _scars[memberId];
    }

    function stakeAgePoints(uint256 memberId) public view returns (uint256) {
        uint64 since = registry.getMember(memberId).stakeSince;
        if (since == 0 || since >= block.timestamp) return 0;
        uint256 full = _p("stakeAgeFullDays") * config.secondsPerDay();
        uint256 age = block.timestamp - since;
        if (age >= full) return _p("stakeAgeMaxPoints");
        return (_p("stakeAgeMaxPoints") * age) / full;
    }

    function getScore(uint256 memberId) public view returns (uint256) {
        Stats storage st = stats[memberId];
        int256 score = int256(_p("scoreBase"));
        score += int256((_p("installmentPoints") * st.installmentWeightBps) / 10000);
        score += int256(_p("loanPoints") * st.completedLoans);
        score += int256(stakeAgePoints(memberId));
        score -= int256(_p("lateMarkPoints") * st.lateMarks);
        score -= int256(_p("restructurePoints") * st.restructures);
        if (registry.getMember(memberId).misdeclaredDebt) score -= int256(_p("misdeclaredPoints"));
        score -= int256(totalScar(memberId));
        score += st.manualAdjustment;
        if (score < int256(MIN_SCORE)) return MIN_SCORE;
        if (score > int256(MAX_SCORE)) return MAX_SCORE;
        return uint256(score);
    }

    function scoreOfWallet(address wallet) external view returns (uint256) {
        uint256 memberId = registry.memberOf(wallet);
        return memberId == 0 ? 0 : getScore(memberId);
    }
}
