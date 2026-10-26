// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./PolicyConfig.sol";

interface ILoanStatus {
    function hasOpenLoan(uint256 memberId) external view returns (bool);
}

interface IScoreView {
    function getScore(uint256 memberId) external view returns (uint256);
}

/**
 * @title IdentityRegistry
 * @notice One real person = one member record. A verified identity is stored only as idHash
 *         (keccak256 of the normalised ID plus a server pepper). All default state lives on the
 *         member, so a new wallet attached to the same idHash inherits the full history.
 *         No personal data is stored on-chain: only hashes, tiers, flags, IDs and timestamps.
 */
contract IdentityRegistry is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");
    bytes32 public constant DISPUTE_ROLE = keccak256("DISPUTE_ROLE");
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE"); // DefaulterGovernance

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "MemberAttestation(address wallet,bytes32 idHash,uint256 incomeTierWei,uint256 declaredDebtWei,uint32 payoutPeriodDays,bytes32 clusterId,uint32 cohortId,uint256 nonce,uint64 expiry)"
    );

    enum Tier { New, Builder, Standard, Trusted, Prime }

    struct MemberAttestation {
        address wallet;
        bytes32 idHash;
        uint256 incomeTierWei;
        uint256 declaredDebtWei;
        uint32 payoutPeriodDays;
        bytes32 clusterId;
        uint32 cohortId;
        uint256 nonce;
        uint64 expiry;
    }

    struct Member {
        bytes32 idHash;
        address wallet;
        uint64 joinedAt;
        uint64 stakeSince;
        uint8 tier;
        uint256 incomeWei;
        uint256 declaredDebtWei;
        uint32 payoutPeriodDays;
        bytes32 clusterId;
        uint32 cohortId;
        uint32 completedLoans;
        uint32 restructuresLast12m;
        uint64 coolingOffUntil;
        bool permanentlyBarred;
        uint8 defaultCount;
        uint64 attestationExpiry;
        bool misdeclaredDebt;
    }

    PolicyConfig public immutable config;
    address public loanStatus;   // LoanManager, set once
    address public scoreSource;  // CreditScore, set once

    uint256 public memberCount;
    mapping(uint256 => Member) private _members;
    mapping(address => uint256) public memberOf;
    mapping(bytes32 => uint256) public memberByIdHash;
    mapping(uint256 => bool) public usedNonces;

    mapping(bytes32 => bool) public clusterFlagged;
    mapping(uint32 => bool) public cohortPausedManual;
    mapping(uint32 => uint32) public cohortFirstLoans;
    mapping(uint32 => uint32) public cohortFirstPaymentDefaults;
    mapping(uint256 => uint64[2]) private _restructureTimes;
    mapping(uint32 => uint64) public shockUntil;
    /// @notice Identities expelled by member vote. A banned identity can never register any wallet.
    mapping(bytes32 => bool) public bannedIdentity;
    mapping(uint32 => bytes32) public shockEvent;

    event MemberRegistered(uint256 indexed memberId, address indexed wallet, uint32 cohortId, bytes32 clusterId);
    event WalletLinked(uint256 indexed memberId, address indexed wallet);
    event WalletUnlinked(uint256 indexed memberId, address indexed wallet);
    event MemberReattested(uint256 indexed memberId, uint256 incomeWei, uint256 declaredDebtWei, uint64 expiry);
    event ClusterFlagged(bytes32 indexed clusterId, bool flagged);
    event CohortPauseSet(uint32 indexed cohortId, bool paused);
    event CoolingOffSet(uint256 indexed memberId, uint64 until);
    event TierChanged(uint256 indexed memberId, uint8 tier);
    event MisdeclaredDebtFlagged(uint256 indexed memberId, bool flagged);
    event StakeSinceSet(uint256 indexed memberId, uint64 stakeSince);
    event ShockModeSet(uint32 indexed cohortId, uint64 until, bytes32 eventHash);
    event IdentityBanned(bytes32 indexed idHash, uint256 indexed memberId);
    event IdentityUnbanned(bytes32 indexed idHash, uint256 indexed memberId);

    constructor(address admin, address attester, PolicyConfig _config) {
        config = _config;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(DISPUTE_ROLE, admin);
        _grantRole(ATTESTER_ROLE, attester);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring (set once)
    // ─────────────────────────────────────────────────────────────────────

    function setLoanStatus(address _loanStatus) external onlyRole(ADMIN_ROLE) {
        require(loanStatus == address(0), "Already set");
        loanStatus = _loanStatus;
    }

    function setScoreSource(address _scoreSource) external onlyRole(ADMIN_ROLE) {
        require(scoreSource == address(0), "Already set");
        scoreSource = _scoreSource;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Registration
    // ─────────────────────────────────────────────────────────────────────

    /// @notice EIP-712 domain ("GigLendIdentity", "1"). Built by hand because OZ 5.6 EIP712 needs solc 0.8.24.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("GigLendIdentity"), keccak256("1"), block.chainid, address(this))
        );
    }

    function hashAttestation(MemberAttestation calldata a) public view returns (bytes32) {
        bytes32 structHash = keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    a.wallet,
                    a.idHash,
                    a.incomeTierWei,
                    a.declaredDebtWei,
                    a.payoutPeriodDays,
                    a.clusterId,
                    a.cohortId,
                    a.nonce,
                    a.expiry
                )
            );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /**
     * @notice Registers a new member, attaches a wallet to an existing identity, or re-attests.
     */
    function register(MemberAttestation calldata a, bytes calldata sig) external returns (uint256 memberId) {
        require(a.wallet == msg.sender, "Attestation not for sender");
        require(a.expiry > block.timestamp, "Attestation expired");
        require(!usedNonces[a.nonce], "Attestation replayed");
        require(a.idHash != bytes32(0), "Empty idHash");
        require(!bannedIdentity[a.idHash], "Identity banned");
        require(a.payoutPeriodDays > 0 && a.payoutPeriodDays <= 31, "Bad payout period");

        address signer = ECDSA.recover(hashAttestation(a), sig);
        require(hasRole(ATTESTER_ROLE, signer), "Invalid attester signature");
        usedNonces[a.nonce] = true;

        uint256 byWallet = memberOf[msg.sender];
        uint256 byId = memberByIdHash[a.idHash];

        if (byWallet != 0) {
            // Re-attestation by the linked wallet: identity must match.
            require(byWallet == byId, "Wallet linked to another identity");
            memberId = byWallet;
            _applyAttestation(_members[memberId], a);
            emit MemberReattested(memberId, a.incomeTierWei, a.declaredDebtWei, a.expiry);
            return memberId;
        }

        if (byId != 0) {
            // Same person, new wallet: inherits the whole record. Only one active wallet.
            Member storage existing = _members[byId];
            require(existing.wallet == address(0), "Identity has an active wallet; unlink it first");
            existing.wallet = msg.sender;
            memberOf[msg.sender] = byId;
            _applyAttestation(existing, a);
            emit WalletLinked(byId, msg.sender);
            emit MemberReattested(byId, a.incomeTierWei, a.declaredDebtWei, a.expiry);
            return byId;
        }

        memberId = ++memberCount;
        Member storage m = _members[memberId];
        m.idHash = a.idHash;
        m.wallet = msg.sender;
        m.joinedAt = uint64(block.timestamp);
        m.clusterId = a.clusterId;
        m.cohortId = a.cohortId;
        _applyAttestation(m, a);
        memberOf[msg.sender] = memberId;
        memberByIdHash[a.idHash] = memberId;

        emit MemberRegistered(memberId, msg.sender, a.cohortId, a.clusterId);
        emit WalletLinked(memberId, msg.sender);
    }

    function _applyAttestation(Member storage m, MemberAttestation calldata a) internal {
        m.incomeWei = a.incomeTierWei;
        m.declaredDebtWei = a.declaredDebtWei;
        m.payoutPeriodDays = a.payoutPeriodDays;
        m.attestationExpiry = a.expiry;
        if (a.clusterId != bytes32(0)) m.clusterId = a.clusterId;
    }

    /**
     * @notice Unlinks the caller's wallet from its member record. Not allowed while a loan is open.
     */
    function unlinkWallet() external {
        uint256 memberId = memberOf[msg.sender];
        require(memberId != 0, "Not registered");
        require(!_hasOpenLoan(memberId), "Cannot unlink with an open loan");
        _members[memberId].wallet = address(0);
        delete memberOf[msg.sender];
        emit WalletUnlinked(memberId, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────

    function getMember(uint256 memberId) external view returns (Member memory) {
        return _members[memberId];
    }

    function memberOfWallet(address wallet) external view returns (uint256 memberId, Member memory m) {
        memberId = memberOf[wallet];
        m = _members[memberId];
    }

    function walletOf(uint256 memberId) external view returns (address) {
        return _members[memberId].wallet;
    }

    /**
     * @notice Registered, attestation current, not barred and past cooling-off.
     */
    function isEligible(address wallet) public view returns (bool) {
        (bool ok, ) = eligibility(wallet);
        return ok;
    }

    function eligibility(address wallet) public view returns (bool, string memory) {
        uint256 memberId = memberOf[wallet];
        if (memberId == 0) return (false, "Not registered");
        Member storage m = _members[memberId];
        if (bannedIdentity[m.idHash]) return (false, "Identity banned");
        if (m.attestationExpiry <= block.timestamp) return (false, "Attestation expired");
        if (m.permanentlyBarred) return (false, "Permanently barred");
        if (block.timestamp < m.coolingOffUntil) return (false, "Cooling-off active");
        return (true, "");
    }

    /**
     * @notice Verified = registered, attestation current and identity not banned. Required to
     *         deposit, borrow or vote.
     */
    function isVerified(address wallet) public view returns (bool) {
        uint256 memberId = memberOf[wallet];
        if (memberId == 0) return false;
        Member storage m = _members[memberId];
        return m.attestationExpiry > block.timestamp && !bannedIdentity[m.idHash];
    }

    /// @notice The identity hash bound to a wallet (zero if none).
    function identityOf(address wallet) public view returns (bytes32) {
        return _members[memberOf[wallet]].idHash;
    }

    function isBanned(address wallet) external view returns (bool) {
        bytes32 idHash = identityOf(wallet);
        return idHash != bytes32(0) && bannedIdentity[idHash];
    }

    function isIdentityBanned(bytes32 idHash) external view returns (bool) {
        return bannedIdentity[idHash];
    }

    /**
     * @notice Tier derived from completed loans and score; thresholds are PolicyConfig params.
     */
    function tierOf(uint256 memberId) public view returns (uint8) {
        Member storage m = _members[memberId];
        uint256 score = scoreSource == address(0) ? 0 : IScoreView(scoreSource).getScore(memberId);
        uint256 done = m.completedLoans;
        if (done >= config.get("tierPrimeLoans") && score >= config.get("tierPrimeScore")) return uint8(Tier.Prime);
        if (done >= config.get("tierTrustedLoans") && score >= config.get("tierTrustedScore")) return uint8(Tier.Trusted);
        if (done >= config.get("tierStandardLoans") && score >= config.get("tierStandardScore")) return uint8(Tier.Standard);
        if (done >= config.get("tierBuilderLoans")) return uint8(Tier.Builder);
        return uint8(Tier.New);
    }

    function restructuresInWindow(uint256 memberId) public view returns (uint32 count) {
        uint256 window = config.get("restructureWindowDays") * config.secondsPerDay();
        uint64[2] storage t = _restructureTimes[memberId];
        for (uint256 i = 0; i < 2; i++) {
            if (t[i] != 0 && block.timestamp < uint256(t[i]) + window) count++;
        }
    }

    /**
     * @notice First-payment-default pause: manual flag, or FPD rate above threshold once the
     *         cohort has enough first loans to be meaningful.
     */
    function cohortPaused(uint32 cohortId) public view returns (bool) {
        if (cohortPausedManual[cohortId]) return true;
        uint256 first = cohortFirstLoans[cohortId];
        if (first < config.get("cohortMinSample")) return false;
        return uint256(cohortFirstPaymentDefaults[cohortId]) * 10000 > first * config.get("cohortFpdThresholdBps");
    }

    function _hasOpenLoan(uint256 memberId) internal view returns (bool) {
        if (loanStatus == address(0)) return false;
        return ILoanStatus(loanStatus).hasOpenLoan(memberId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Protocol hooks (LoanManager / DefaultManager / LendingPool)
    // ─────────────────────────────────────────────────────────────────────

    function recordLoanCompleted(uint256 memberId) external onlyRole(LOAN_ROLE) {
        _members[memberId].completedLoans += 1;
        refreshTier(memberId);
    }

    function refreshTier(uint256 memberId) public onlyRole(LOAN_ROLE) {
        uint8 t = tierOf(memberId);
        if (_members[memberId].tier != t) {
            _members[memberId].tier = t;
            emit TierChanged(memberId, t);
        }
    }

    function recordRestructure(uint256 memberId) external onlyRole(LOAN_ROLE) {
        uint64[2] storage t = _restructureTimes[memberId];
        // Overwrite the older slot.
        if (t[0] <= t[1]) t[0] = uint64(block.timestamp);
        else t[1] = uint64(block.timestamp);
        _members[memberId].restructuresLast12m = restructuresInWindow(memberId);
    }

    function setCoolingOff(uint256 memberId, uint64 until) external onlyRole(LOAN_ROLE) {
        _members[memberId].coolingOffUntil = until;
        emit CoolingOffSet(memberId, until);
    }

    function setBarred(uint256 memberId, bool barred) external onlyRole(LOAN_ROLE) {
        _members[memberId].permanentlyBarred = barred;
    }

    function recordDefault(uint256 memberId) external onlyRole(LOAN_ROLE) {
        _members[memberId].defaultCount += 1;
    }

    function setStakeSince(uint256 memberId, uint64 ts) external onlyRole(LOAN_ROLE) {
        _members[memberId].stakeSince = ts;
        emit StakeSinceSet(memberId, ts);
    }

    function recordFirstLoan(uint32 cohortId) external onlyRole(LOAN_ROLE) {
        cohortFirstLoans[cohortId] += 1;
    }

    function recordFirstPaymentDefault(uint32 cohortId) external onlyRole(LOAN_ROLE) {
        cohortFirstPaymentDefaults[cohortId] += 1;
    }

    function setClusterFlag(bytes32 clusterId, bool flagged) external {
        require(hasRole(LOAN_ROLE, msg.sender) || hasRole(DISPUTE_ROLE, msg.sender), "Not authorised");
        clusterFlagged[clusterId] = flagged;
        emit ClusterFlagged(clusterId, flagged);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Governance (expulsion by member vote)
    // ─────────────────────────────────────────────────────────────────────

    function banIdentity(bytes32 idHash) external onlyRole(GOVERNANCE_ROLE) {
        require(idHash != bytes32(0), "Empty idHash");
        require(!bannedIdentity[idHash], "Already banned");
        bannedIdentity[idHash] = true;
        emit IdentityBanned(idHash, memberByIdHash[idHash]);
    }

    function unbanIdentity(bytes32 idHash) external onlyRole(GOVERNANCE_ROLE) {
        require(bannedIdentity[idHash], "Not banned");
        bannedIdentity[idHash] = false;
        emit IdentityUnbanned(idHash, memberByIdHash[idHash]);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────

    function setCohortPaused(uint32 cohortId, bool paused) external onlyRole(ADMIN_ROLE) {
        cohortPausedManual[cohortId] = paused;
        emit CohortPauseSet(cohortId, paused);
    }

    /**
     * @notice Systemic-shock mode for one cohort (platform outage, city-wide disruption),
     *         backed by an attested event hash: longer grace, no late fees and no late score
     *         effects for that cohort's loans. It never touches principal. `until` in the past
     *         ends it early. Production: ADMIN_ROLE is a Safe multisig.
     */
    function setShockMode(uint32 cohortId, uint64 until, bytes32 eventHash) external onlyRole(ADMIN_ROLE) {
        require(eventHash != bytes32(0), "Attested event required");
        require(until <= block.timestamp + config.get("shockMaxDays") * config.secondsPerDay(), "Shock window too long");
        shockUntil[cohortId] = until;
        shockEvent[cohortId] = eventHash;
        emit ShockModeSet(cohortId, until, eventHash);
    }

    function flagMisdeclaredDebt(uint256 memberId, bool flagged) external onlyRole(ADMIN_ROLE) {
        require(memberId != 0 && memberId <= memberCount, "Unknown member");
        _members[memberId].misdeclaredDebt = flagged;
        emit MisdeclaredDebtFlagged(memberId, flagged);
    }
}
