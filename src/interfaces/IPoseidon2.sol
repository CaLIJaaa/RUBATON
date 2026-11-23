// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice circomlib Poseidon with exactly two BN254 scalar-field inputs.
interface IPoseidon2 {
    function poseidon(uint256[2] calldata inputs) external view returns (uint256);
}
