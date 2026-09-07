// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract GLPToken is ERC20, Ownable {
    address public lendingPool;

    constructor() ERC20("GigLendingPool", "GLP") Ownable(msg.sender) {}

    function setLendingPool(address _lendingPool) external onlyOwner {
        require(lendingPool == address(0), "Lending pool already set");
        lendingPool = _lendingPool;
    }

    modifier onlyLendingPool() {
        require(msg.sender == lendingPool, "Only LendingPool can call");
        _;
    }

    function mint(address to, uint256 amount) external onlyLendingPool {
        _mint(to, amount);
    }

    function burnFrom(address account, uint256 amount) external onlyLendingPool {
        _burn(account, amount);
    }
}
