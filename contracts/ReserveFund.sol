// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ReserveFund
 * @notice Ring-fenced loss buffer funded by borrower interest (10% of repaid interest), late
 *         fees and recoveries. It is a loss buffer, NOT a guarantee: lenders bear losses the
 *         reserve cannot cover. Outflows are limited to covering default losses into the pool
 *         and paying collect/markDefault bounties.
 */
contract ReserveFund is AccessControl, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");

    uint256 public totalReceived;
    uint256 public totalCovered;
    uint256 public totalBounties;

    event ReserveFunded(address indexed from, uint256 amount);
    event ReserveCovered(address indexed to, uint256 amount);
    event BountyPaid(address indexed to, uint256 amount);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    receive() external payable {
        totalReceived += msg.value;
        emit ReserveFunded(msg.sender, msg.value);
    }

    function fund() external payable {
        totalReceived += msg.value;
        emit ReserveFunded(msg.sender, msg.value);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice Covers up to `amount` of a default loss by sending ETH to the pool.
     */
    function cover(address to, uint256 amount) external onlyRole(LOAN_ROLE) nonReentrant returns (uint256 covered) {
        covered = amount < address(this).balance ? amount : address(this).balance;
        if (covered == 0) return 0;
        totalCovered += covered;
        (bool ok, ) = to.call{value: covered}("");
        require(ok, "Cover transfer failed");
        emit ReserveCovered(to, covered);
    }

    function payBounty(address to, uint256 amount) external onlyRole(LOAN_ROLE) nonReentrant returns (uint256 paid) {
        paid = amount < address(this).balance ? amount : address(this).balance;
        if (paid == 0) return 0;
        totalBounties += paid;
        (bool ok, ) = to.call{value: paid}("");
        require(ok, "Bounty transfer failed");
        emit BountyPaid(to, paid);
    }
}
