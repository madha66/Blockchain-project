// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IdentityRegistry.sol";
import "./PolicyConfig.sol";

interface IPoolGov {
    function isDefaulter(address wallet) external view returns (bool);
    function setExpelled(address wallet, bool value) external;
}

interface IVotesToken {
    function balanceOf(address account) external view returns (uint256);
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
}

interface IDefaultSeize {
    function seizeStakeForClaim(address wallet) external returns (uint256 value);
}

/**
 * @title DefaulterGovernance
 * @notice Members vote to expel a defaulter, or to reinstate an expelled member who has
 *         settled. Expulsion bans the person's identity hash in IdentityRegistry, so no new
 *         wallet can register under it, and applies any GLP they still hold to their debt.
 *         Expulsion never cancels debt; reinstatement never erases credit history.
 *
 *         Rules (fixed at deployment):
 *         - Proposers and voters must be verified, non-banned members; proposers must hold GLP.
 *         - Voting weight = GLP votes at the snapshot block (ERC20Votes), so tokens moved after
 *           the snapshot add nothing. One vote per wallet per proposal. The target cannot vote.
 *         - Voting period = votingPeriodDays × PolicyConfig.secondsPerDay.
 *         - Passes when votes cast ≥ quorumBps of GLP supply at the snapshot and votes in
 *           favour are more than passThresholdBps of votes cast.
 */
contract DefaulterGovernance is ReentrancyGuard {
    enum Kind { Expel, Reinstate }
    enum State { None, Active, Succeeded, Defeated, Executed, Cancelled }

    struct Proposal {
        uint256 id;
        Kind kind;
        address target;
        bytes32 idHash;
        address proposer;
        uint256 snapshotBlock;
        uint64 startTime;
        uint64 endTime;
        uint256 forVotes;
        uint256 againstVotes;
        bool executed;
        bool passed;
        bool cancelled;
    }

    IdentityRegistry public immutable registry;
    PolicyConfig public immutable config;
    IPoolGov public immutable pool;
    IVotesToken public immutable glp;
    IDefaultSeize public immutable defaults;

    uint256 public immutable votingPeriodDays; // 3
    uint256 public immutable quorumBps;        // 2000 = 20% of supply at the snapshot
    uint256 public immutable passThresholdBps; // 5000: "for" must be strictly more than half

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;
    mapping(address => uint256) public openProposalOf; // target wallet => open proposal id
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event ProposalCreated(
        uint256 indexed proposalId,
        Kind kind,
        address indexed target,
        address indexed proposer,
        uint256 snapshotBlock,
        uint64 endTime
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId, Kind kind, address indexed target, bool passed);
    event ProposalCancelled(uint256 indexed proposalId, address indexed target, address caller);

    constructor(
        IdentityRegistry _registry,
        PolicyConfig _config,
        address _pool,
        address _glp,
        address _defaults,
        uint256 _votingPeriodDays,
        uint256 _quorumBps,
        uint256 _passThresholdBps
    ) {
        require(_votingPeriodDays > 0, "Bad period");
        require(_quorumBps > 0 && _quorumBps <= 10000, "Bad quorum");
        require(_passThresholdBps >= 5000 && _passThresholdBps < 10000, "Bad threshold");
        registry = _registry;
        config = _config;
        pool = IPoolGov(_pool);
        glp = IVotesToken(_glp);
        defaults = IDefaultSeize(_defaults);
        votingPeriodDays = _votingPeriodDays;
        quorumBps = _quorumBps;
        passThresholdBps = _passThresholdBps;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Proposals
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Opens a vote to expel `target`, who must be a defaulter (unpaid default claim).
    function proposeExpel(address target) external returns (uint256) {
        require(pool.isDefaulter(target), "Target is not a defaulter");
        bytes32 idHash = registry.identityOf(target);
        require(!registry.isIdentityBanned(idHash), "Already expelled");
        return _create(Kind.Expel, target, idHash);
    }

    /// @notice Opens a vote to reinstate an expelled member whose debt is fully settled.
    function proposeReinstate(address target) external returns (uint256) {
        bytes32 idHash = registry.identityOf(target);
        require(idHash != bytes32(0) && registry.isIdentityBanned(idHash), "Target is not expelled");
        require(!pool.isDefaulter(target), "Debt not settled");
        return _create(Kind.Reinstate, target, idHash);
    }

    function _create(Kind kind, address target, bytes32 idHash) internal returns (uint256 id) {
        require(registry.isVerified(msg.sender), "Proposer not verified");
        require(glp.balanceOf(msg.sender) > 0, "Proposer holds no GLP");
        require(msg.sender != target, "Cannot propose about yourself");
        require(openProposalOf[target] == 0, "Open proposal exists");

        id = ++proposalCount;
        Proposal storage p = _proposals[id];
        p.id = id;
        p.kind = kind;
        p.target = target;
        p.idHash = idHash;
        p.proposer = msg.sender;
        p.snapshotBlock = block.number - 1; // weight is fixed before anyone can react
        p.startTime = uint64(block.timestamp);
        p.endTime = uint64(block.timestamp + votingPeriodDays * config.secondsPerDay());
        openProposalOf[target] = id;
        emit ProposalCreated(id, kind, target, msg.sender, p.snapshotBlock, p.endTime);
    }

    function vote(uint256 proposalId, bool support) external {
        Proposal storage p = _proposals[proposalId];
        require(state(proposalId) == State.Active, "Voting closed");
        require(registry.isVerified(msg.sender), "Voter not verified");
        require(msg.sender != p.target && registry.identityOf(msg.sender) != p.idHash, "Target cannot vote");
        require(!hasVoted[proposalId][msg.sender], "Already voted");
        uint256 weight = glp.getPastVotes(msg.sender, p.snapshotBlock);
        require(weight > 0, "No voting power at snapshot");

        hasVoted[proposalId][msg.sender] = true;
        if (support) p.forVotes += weight;
        else p.againstVotes += weight;
        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /**
     * @notice Anyone may cancel an expulsion vote once the target has cleared all debt; it can
     *         then never be executed.
     */
    function cancel(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        require(p.id != 0 && !p.executed && !p.cancelled, "Not cancellable");
        require(p.kind == Kind.Expel && !pool.isDefaulter(p.target), "Target still owes");
        p.cancelled = true;
        openProposalOf[p.target] = 0;
        emit ProposalCancelled(proposalId, p.target, msg.sender);
    }

    /**
     * @notice After the voting period. A passed expulsion bans the identity, marks the wallet
     *         expelled and applies its GLP to the debt; a passed reinstatement lifts the ban.
     *         A defeated proposal is closed so a new one can be opened later.
     */
    function execute(uint256 proposalId) external nonReentrant {
        Proposal storage p = _proposals[proposalId];
        require(p.id != 0, "Unknown proposal");
        require(!p.executed && !p.cancelled, "Proposal closed");
        require(block.timestamp >= p.endTime, "Voting still open");

        bool passed = _passed(p);
        p.executed = true;
        p.passed = passed;
        openProposalOf[p.target] = 0;

        if (passed && p.kind == Kind.Expel) {
            require(pool.isDefaulter(p.target), "Target debt settled; cancel instead");
            registry.banIdentity(p.idHash);
            pool.setExpelled(p.target, true);
            defaults.seizeStakeForClaim(p.target);
        } else if (passed && p.kind == Kind.Reinstate) {
            require(!pool.isDefaulter(p.target), "Debt not settled");
            registry.unbanIdentity(p.idHash);
            pool.setExpelled(p.target, false);
        }
        emit ProposalExecuted(proposalId, p.kind, p.target, passed);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────

    function quorum(uint256 proposalId) public view returns (uint256) {
        return (glp.getPastTotalSupply(_proposals[proposalId].snapshotBlock) * quorumBps) / 10000;
    }

    function _passed(Proposal storage p) internal view returns (bool) {
        uint256 cast = p.forVotes + p.againstVotes;
        if (cast == 0 || cast < quorum(p.id)) return false;
        return p.forVotes * 10000 > cast * passThresholdBps;
    }

    function state(uint256 proposalId) public view returns (State) {
        Proposal storage p = _proposals[proposalId];
        if (p.id == 0) return State.None;
        if (p.cancelled) return State.Cancelled;
        if (p.executed) return p.passed ? State.Executed : State.Defeated;
        if (block.timestamp < p.endTime) return State.Active;
        return _passed(p) ? State.Succeeded : State.Defeated;
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }
}
