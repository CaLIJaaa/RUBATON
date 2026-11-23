// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only six-decimal token with no-return transfers and issuer bans.
/// It models the relevant integration behavior, not every historical USDT detail.
contract MockUSDT {
    // Standard ERC-20 metadata getter names must remain unchanged.
    // forge-lint: disable-next-line(screaming-snake-case-const)
    string public constant name = "Mock Tether USD";
    // forge-lint: disable-next-line(screaming-snake-case-const)
    string public constant symbol = "USDT";
    // forge-lint: disable-next-line(screaming-snake-case-const)
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address account, uint256 amount) external {
        totalSupply += amount;
        balanceOf[account] += amount;
        emit Transfer(address(0), account, amount);
    }

    function setBlacklisted(address account, bool value) external {
        blacklisted[account] = value;
    }

    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "USDT: reset approval");
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    function transfer(address to, uint256 amount) external {
        _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(!blacklisted[from] && !blacklisted[to], "USDT: blacklisted");
        require(to != address(0), "USDT: zero recipient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
