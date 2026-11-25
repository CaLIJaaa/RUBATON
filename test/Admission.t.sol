// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RubaVault} from "../src/RubaVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

contract AdmissionTest is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 internal constant DESK_KEY = 0xdE5c;
    uint256 internal constant OTHER_KEY = 0xBAD;

    RubaVault internal vault;
    RubaVault internal otherVault;
    MockERC20 internal ruba;
    MockUSDT internal usdt;
    address internal desk;
    address internal alice;
    address internal bob;
    bytes32 internal kycHash;
    bytes32 internal consentHash;

    event Admitted(address indexed account, bytes32 kycHash, bytes32 consentHash, uint256 indexed nonce);

    function setUp() public {
        desk = vm.addr(DESK_KEY);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        ruba = new MockERC20("Mock RUBA", "RUBA", 18);
        usdt = new MockUSDT();
        vault = new RubaVault(address(ruba), address(usdt), address(this), makeAddr("operator"));
        otherVault = new RubaVault(address(ruba), address(usdt), address(this), makeAddr("operator"));
        vault.setAdmissionSigner(desk);
        otherVault.setAdmissionSigner(desk);
        kycHash = keccak256(abi.encode("KYC-0001", bytes32(uint256(0x5a17))));
        consentHash = keccak256(bytes("Accept RUBA sanctions risk v1"));
        ruba.mint(alice, 100 ether);
        vm.prank(alice);
        ruba.approve(address(vault), type(uint256).max);
    }

    function _admission(address account, uint256 nonce) internal view returns (RubaVault.Admission memory) {
        return RubaVault.Admission(account, kycHash, consentHash, block.timestamp + 1 hours, nonce);
    }

    function _digest(RubaVault target, RubaVault.Admission memory admission) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("RubaVault"), keccak256("1"), block.chainid, address(target)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                target.ADMISSION_TYPEHASH(),
                admission.account,
                admission.kycHash,
                admission.consentHash,
                admission.deadline,
                admission.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _sign(RubaVault target, RubaVault.Admission memory admission, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(target, admission));
        return abi.encodePacked(r, s, v);
    }

    function testParticipantAdmitsWithDeskApproval() public {
        RubaVault.Admission memory admission = _admission(alice, 7);
        bytes memory signature = _sign(vault, admission, DESK_KEY);
        assertEq(vault.admissionDigest(admission), _digest(vault, admission));

        vm.expectEmit(true, true, false, true, address(vault));
        emit Admitted(alice, kycHash, consentHash, 7);
        vm.prank(alice);
        vault.admit(admission, signature);

        assertTrue(vault.whitelist(alice));
        assertEq(vault.kycHashOf(alice), kycHash);
        assertEq(vault.consentHashOf(alice), consentHash);
        assertTrue(vault.usedAdmissionNonces(7));

        vm.prank(alice);
        vault.deposit(address(ruba), 1 ether);
        assertEq(ruba.balanceOf(address(vault)), 1 ether);
    }

    function testApprovalFromOtherKeyIsRejected() public {
        RubaVault.Admission memory admission = _admission(alice, 1);
        bytes memory signature = _sign(vault, admission, OTHER_KEY);
        vm.prank(alice);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vault.admit(admission, signature);
        assertFalse(vault.whitelist(alice));
    }

    function testExpiredApprovalIsRejected() public {
        RubaVault.Admission memory admission = _admission(alice, 1);
        bytes memory signature = _sign(vault, admission, DESK_KEY);
        vm.warp(admission.deadline + 1);
        vm.prank(alice);
        vm.expectRevert(RubaVault.ExpiredAdmission.selector);
        vault.admit(admission, signature);
    }

    function testNonceIsSingleUse() public {
        RubaVault.Admission memory admission = _admission(alice, 3);
        bytes memory signature = _sign(vault, admission, DESK_KEY);
        vm.prank(alice);
        vault.admit(admission, signature);

        RubaVault.Admission memory forBob = _admission(bob, 3);
        bytes memory bobSignature = _sign(vault, forBob, DESK_KEY);
        vm.prank(bob);
        vm.expectRevert(RubaVault.AdmissionAlreadyUsed.selector);
        vault.admit(forBob, bobSignature);
        vm.prank(alice);
        vm.expectRevert(RubaVault.AdmissionAlreadyUsed.selector);
        vault.admit(admission, signature);
    }

    function testApprovalIsBoundToVaultAndChain() public {
        RubaVault.Admission memory admission = _admission(alice, 4);
        bytes memory forOtherVault = _sign(otherVault, admission, DESK_KEY);
        vm.prank(alice);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vault.admit(admission, forOtherVault);

        bytes memory signature = _sign(vault, admission, DESK_KEY);
        uint256 chainId = block.chainid;
        vm.chainId(chainId + 1);
        vm.prank(alice);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vault.admit(admission, signature);
        vm.chainId(chainId);
        vm.prank(alice);
        vault.admit(admission, signature);
        assertTrue(vault.whitelist(alice));
        assertFalse(otherVault.whitelist(alice));
    }

    function testOnlyTheAccountCanUseItsApproval() public {
        RubaVault.Admission memory admission = _admission(alice, 5);
        bytes memory signature = _sign(vault, admission, DESK_KEY);
        vm.prank(bob);
        vm.expectRevert(RubaVault.UnauthorizedAccount.selector);
        vault.admit(admission, signature);
    }

    function testConsentAndKycAreRequired() public {
        RubaVault.Admission memory noConsent = _admission(alice, 6);
        noConsent.consentHash = bytes32(0);
        bytes memory signature = _sign(vault, noConsent, DESK_KEY);
        vm.prank(alice);
        vm.expectRevert(RubaVault.InvalidAdmission.selector);
        vault.admit(noConsent, signature);

        RubaVault.Admission memory noKyc = _admission(alice, 6);
        noKyc.kycHash = bytes32(0);
        signature = _sign(vault, noKyc, DESK_KEY);
        vm.prank(alice);
        vm.expectRevert(RubaVault.InvalidAdmission.selector);
        vault.admit(noKyc, signature);
    }

    function testExclusionBlocksOldApprovalUntilOwnerReturnsAccess() public {
        RubaVault.Admission memory first = _admission(alice, 8);
        bytes memory firstSignature = _sign(vault, first, DESK_KEY);
        vm.prank(alice);
        vault.admit(first, firstSignature);

        vault.setWhitelist(alice, false);
        RubaVault.Admission memory second = _admission(alice, 9);
        bytes memory signature = _sign(vault, second, DESK_KEY);
        vm.prank(alice);
        vm.expectRevert(RubaVault.AdmissionBlocked.selector);
        vault.admit(second, signature);
        assertFalse(vault.whitelist(alice));

        vault.setWhitelist(alice, true);
        vault.setWhitelist(alice, false);
        vault.setWhitelist(alice, true);
        assertFalse(vault.admissionBlocked(alice));
    }

    function testSignerRules() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setAdmissionSigner(alice);
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        vault.setAdmissionSigner(address(this));
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        vault.setAdmissionSigner(address(ruba));

        vault.setAdmissionSigner(address(0));
        RubaVault.Admission memory admission = _admission(alice, 10);
        bytes memory signature = _sign(vault, admission, DESK_KEY);
        vm.prank(alice);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vault.admit(admission, signature);
    }
}
