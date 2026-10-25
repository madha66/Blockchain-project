// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IdentityRegistry.sol";
import "./interfaces/IGigLend.sol";

interface ISweepTarget {
    function sweepQuote(address worker, uint256 payout) external view returns (uint256 toLoan);
    function applySweep(address worker) external payable;
}

interface IClaimTarget {
    function claimOf(uint256 memberId) external view returns (uint256);
    function applyRecovery(uint256 memberId) external payable;
}

/**
 * @title MockPayoutRouter
 * @notice Stands in for a gig platform's payout rail. Each payout is recorded (cumulative
 *         inflow checkpoints per worker, used by early warning and default classification),
 *         then split: the income sweep goes to the open installment, the residual-claim sweep
 *         goes to an outstanding claim, and the rest is forwarded to the worker.
 */
contract MockPayoutRouter is AccessControl, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct Checkpoint {
        uint64 timestamp;
        uint192 cumulative;
    }

    IdentityRegistry public immutable registry;
    PolicyConfig public immutable config;
    ISweepTarget public loanManager;
    IClaimTarget public defaultManager;

    mapping(address => Checkpoint[]) private _checkpoints;
    mapping(address => uint256[2]) private _last; // [latest, previous]

    event PayoutRouted(address indexed worker, uint256 amount, uint256 sweptToLoan, uint256 sweptToClaim, uint256 forwarded);

    constructor(address admin, IdentityRegistry _registry, PolicyConfig _config) {
        registry = _registry;
        config = _config;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    function setLoanManager(address lm) external onlyRole(ADMIN_ROLE) {
        require(address(loanManager) == address(0), "Already set");
        loanManager = ISweepTarget(lm);
    }

    function setDefaultManager(address dm) external onlyRole(ADMIN_ROLE) {
        require(address(defaultManager) == address(0), "Already set");
        defaultManager = IClaimTarget(dm);
    }

    /**
     * @notice A platform payout to `worker` (mock). Anyone may call it on the local chain.
     */
    function payout(address worker) external payable nonReentrant {
        require(msg.value > 0, "Empty payout");
        require(worker != address(0), "Bad worker");
        _record(worker, msg.value);

        uint256 remaining = msg.value;
        uint256 toLoan;
        uint256 toClaim;

        if (address(loanManager) != address(0)) {
            toLoan = loanManager.sweepQuote(worker, msg.value);
            if (toLoan > remaining) toLoan = remaining;
            if (toLoan > 0) {
                loanManager.applySweep{value: toLoan}(worker);
                remaining -= toLoan;
            }
        }

        uint256 memberId = registry.memberOf(worker);
        if (memberId != 0 && address(defaultManager) != address(0)) {
            uint256 claim = defaultManager.claimOf(memberId);
            if (claim > 0) {
                toClaim = (msg.value * config.get("residualSweepBps")) / 10000;
                if (toClaim > claim) toClaim = claim;
                if (toClaim > remaining) toClaim = remaining;
                if (toClaim > 0) {
                    defaultManager.applyRecovery{value: toClaim}(memberId);
                    remaining -= toClaim;
                }
            }
        }

        if (remaining > 0) {
            (bool ok, ) = worker.call{value: remaining}("");
            require(ok, "Forward failed");
        }
        emit PayoutRouted(worker, msg.value, toLoan, toClaim, remaining);
    }

    function _record(address worker, uint256 amount) internal {
        Checkpoint[] storage cps = _checkpoints[worker];
        uint256 prev = cps.length == 0 ? 0 : cps[cps.length - 1].cumulative;
        cps.push(Checkpoint(uint64(block.timestamp), uint192(prev + amount)));
        _last[worker][1] = _last[worker][0];
        _last[worker][0] = amount;
    }

    function totalInflow(address worker) public view returns (uint256) {
        Checkpoint[] storage cps = _checkpoints[worker];
        return cps.length == 0 ? 0 : cps[cps.length - 1].cumulative;
    }

    /**
     * @notice Sum of payouts received at or after `since`.
     */
    function inflowSince(address worker, uint256 since) external view returns (uint256) {
        Checkpoint[] storage cps = _checkpoints[worker];
        uint256 n = cps.length;
        if (n == 0) return 0;
        // Binary search for the last checkpoint strictly before `since`.
        uint256 lo = 0;
        uint256 hi = n;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (cps[mid].timestamp < since) lo = mid + 1;
            else hi = mid;
        }
        uint256 before = lo == 0 ? 0 : cps[lo - 1].cumulative;
        return cps[n - 1].cumulative - before;
    }

    function lastPayouts(address worker) external view returns (uint256 latest, uint256 previous) {
        return (_last[worker][0], _last[worker][1]);
    }

    function payoutCount(address worker) external view returns (uint256) {
        return _checkpoints[worker].length;
    }
}
