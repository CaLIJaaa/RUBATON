// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";

contract ReentrantToken is MockERC20 {
    address public callbackTarget;
    bytes public callbackData;
    bytes public callbackError;
    bool public callbackSucceeded;
    bool public onTransfer;
    bool public onTransferFrom;

    constructor() MockERC20("Reentrant test token", "HOOK", 18) {}

    function setCallback(address target, bytes calldata data, bool transferHook, bool transferFromHook)
        external
    {
        callbackTarget = target;
        callbackData = data;
        onTransfer = transferHook;
        onTransferFrom = transferFromHook;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (onTransfer) _callback();
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (onTransferFrom) _callback();
        return super.transferFrom(from, to, amount);
    }

    function _callback() internal {
        (callbackSucceeded, callbackError) = callbackTarget.call(callbackData);
    }
}
