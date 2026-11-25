// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test token whose issuer can block an address, like a sanctioned stablecoin.
contract BlockableToken is ERC20 {
    address public immutable issuer;
    mapping(address account => bool blocked) public blocked;

    error Blocked(address account);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        issuer = msg.sender;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setBlocked(address account, bool value) external {
        require(msg.sender == issuer, "issuer only");
        blocked[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}
