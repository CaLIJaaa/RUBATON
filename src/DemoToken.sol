// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Faucet ERC20 for the clearly labelled Demo RUBA/USDT/WETH/WBTC assets.
/// @dev Demo WETH does not wrap ETH; Demo WBTC has no Bitcoin bridge or backing.
/// Owner minting funds bootstrap roles; the public faucet always mints to its caller.
contract DemoToken is ERC20, Ownable2Step {
    uint256 public constant FAUCET_COOLDOWN = 60 seconds;
    uint256 public constant MAX_FAUCET_AMOUNT = type(uint96).max;
    uint256 public immutable FAUCET_AMOUNT;
    uint8 private immutable TOKEN_DECIMALS;

    mapping(address account => uint256 timestamp) public nextFaucetAt;

    error InvalidDecimals();
    error InvalidFaucetAmount();
    error FaucetCooldown(uint256 nextAvailableAt);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address initialOwner,
        uint256 faucetAmount
    ) ERC20(name_, symbol_) Ownable(initialOwner) {
        if (decimals_ > 18) revert InvalidDecimals();
        if (faucetAmount == 0 || faucetAmount > MAX_FAUCET_AMOUNT) revert InvalidFaucetAmount();
        TOKEN_DECIMALS = decimals_;
        FAUCET_AMOUNT = faucetAmount;
    }

    function decimals() public view override returns (uint8) {
        return TOKEN_DECIMALS;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function faucet() external returns (uint256 amount) {
        uint256 availableAt = nextFaucetAt[msg.sender];
        if (block.timestamp < availableAt) revert FaucetCooldown(availableAt);
        nextFaucetAt[msg.sender] = block.timestamp + FAUCET_COOLDOWN;
        amount = FAUCET_AMOUNT;
        _mint(msg.sender, amount);
    }
}
