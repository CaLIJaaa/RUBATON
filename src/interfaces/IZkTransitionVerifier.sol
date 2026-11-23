// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ABI implemented by the generated snarkjs BN254 Groth16 verifier.
interface IZkTransitionVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[13] calldata publicSignals
    ) external view returns (bool);
}
