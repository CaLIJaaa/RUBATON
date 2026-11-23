// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Design boundary for a future verifier, NOT wired into RubaVault.
/// @dev A real migration must bind proofs to deposits, withdrawals, the AMM rules,
/// and data availability. Replacing a state hash alone is insufficient.
interface IStateTransitionVerifier {
    function verifyTransition(
        bytes32 previousStateRoot,
        bytes32 newStateRoot,
        bytes32 receiptsRoot,
        bytes calldata publicInputs,
        bytes calldata proof
    ) external view returns (bool);
}
