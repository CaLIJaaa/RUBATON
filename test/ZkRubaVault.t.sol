// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RubaVault} from "../src/RubaVault.sol";
import {ZkRubaVault} from "../src/ZkRubaVault.sol";
import {IPoseidon2} from "../src/interfaces/IPoseidon2.sol";
import {IZkTransitionVerifier} from "../src/interfaces/IZkTransitionVerifier.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

/// @dev Unit-test boundary only. This is deliberately NOT a Poseidon implementation.
contract UnitMockPoseidon2 is IPoseidon2 {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256) {
        return uint256(keccak256(abi.encode(inputs)))
            % 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    }
}

/// @dev Tests the verifier call boundary, not witness validity or real Groth16 verification.
/// Real-proof integration tests must deploy the generated verifier and real Poseidon.
contract UnitMockTransitionVerifier is IZkTransitionVerifier {
    bytes32 public expectedSignals;
    bool public accepted = true;
    bool public failCall;

    function configure(bytes32 expected, bool accept, bool fail) external {
        expectedSignals = expected;
        accepted = accept;
        failCall = fail;
    }

    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[13] calldata signals
    ) external view returns (bool) {
        require(!failCall, "unit verifier failure");
        return accepted && keccak256(abi.encode(signals)) == expectedSignals;
    }
}

contract UnitOutOfFieldPoseidon2 is IPoseidon2 {
    function poseidon(uint256[2] calldata) external pure returns (uint256) {
        return 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    }
}

abstract contract ZkRubaVaultFixture is Test {
    uint256 internal constant OPERATOR_KEY = 0xa11ce;
    uint256 internal constant ALICE_KEY = 0xa11;
    uint256 internal constant BOB_KEY = 0xb0b;
    uint256 internal constant POOL_KEY_COMMIT = 123;
    ZkRubaVault internal vault;
    UnitMockPoseidon2 internal poseidon;
    UnitMockTransitionVerifier internal verifier;
    MockERC20 internal ruba;
    MockUSDT internal usdt;
    address internal operator;
    address internal alice;
    address internal bob;
    address internal payer;

    struct Transition {
        uint256[13] signals;
        ZkRubaVault.OperationMetadata[8] operations;
        ZkRubaVault.AccountDA[8] accountDA;
        ZkRubaVault.PoolDA poolDA;
        ZkRubaVault.Groth16Proof proof;
        ZkRubaVault.PublicationAuthorization authorization;
    }

    function setUp() public {
        operator = vm.addr(OPERATOR_KEY);
        alice = vm.addr(ALICE_KEY);
        bob = vm.addr(BOB_KEY);
        payer = makeAddr("unlisted payer");
        ruba = new MockERC20("RUBA", "RUBA", 18);
        usdt = new MockUSDT();
        poseidon = new UnitMockPoseidon2();
        verifier = new UnitMockTransitionVerifier();
        vault = new ZkRubaVault(
            address(ruba),
            address(usdt),
            address(this),
            operator,
            address(verifier),
            address(poseidon),
            POOL_KEY_COMMIT
        );
        vault.setWhitelist(alice, true);
        ruba.mint(alice, 1000 ether);
        usdt.mint(alice, 1000e6);
        vm.startPrank(alice);
        ruba.approve(address(vault), type(uint256).max);
        usdt.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _hash(uint256 left, uint256 right) internal view returns (uint256) {
        return poseidon.poseidon([left, right]);
    }

    function _signature(bytes32 digest, uint256 key) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _operation(uint256 kind, uint256 slot, uint256 key, uint256 commitment)
        internal
        view
        returns (ZkRubaVault.OperationMetadata memory op)
    {
        op.kind = kind;
        op.slot = slot;
        op.owner = vm.addr(key);
        op.commitment = commitment;
        op.signature = _signature(vault.privateOperationDigest(commitment), key);
    }

    function _base(uint256 mode) internal view returns (Transition memory t) {
        t.signals[0] = vault.domain();
        t.signals[1] = vault.stateVersion() + 1;
        t.signals[2] = mode;
        t.signals[3] = uint256(vault.stateRoot());
        t.signals[4] = _hash(t.signals[3], t.signals[1]);
        t.signals[5] = vault.inboxCursor();
        t.signals[6] = vault.inboxCursor();
        t.signals[7] = vault.nextTradeId();
        t.signals[8] = vault.nextTradeId() + mode * 4;
        t.signals[9] = mode == 0 ? 0 : _hash(_hash(11, 12), _hash(13, 14));
        t.signals[12] = POOL_KEY_COMMIT;
        t.poolDA.poolHash = 999;
        for (uint256 i; i < 6; ++i) {
            t.poolDA.poolCiphertext[i] = 300 + i;
        }
    }

    function _seal(Transition memory t) internal returns (Transition memory) {
        uint256 auth = _hash(_hash(106, vault.domain()), t.signals[1]);
        uint256 da = _hash(_hash(107, vault.domain()), t.signals[1]);
        for (uint256 i; i < 8; ++i) {
            ZkRubaVault.OperationMetadata memory op = t.operations[i];
            uint256[8] memory fields = [
                op.kind,
                op.slot,
                uint256(uint160(op.owner)),
                op.commitment,
                op.eventId,
                op.token,
                op.amount,
                op.referenceId
            ];
            for (uint256 j; j < 8; ++j) {
                auth = _hash(auth, fields[j]);
            }
            if (op.kind != 0) {
                t.accountDA[i].kind = op.kind;
                t.accountDA[i].slot = op.slot;
                t.accountDA[i].owner = op.owner;
                t.accountDA[i].newLeaf = 100 + i;
                for (uint256 j; j < 7; ++j) {
                    t.accountDA[i].ciphertext[j] = 200 + 10 * i + j;
                }
            }
            ZkRubaVault.AccountDA memory record = t.accountDA[i];
            da = _hash(da, record.kind);
            da = _hash(da, record.slot);
            da = _hash(da, uint256(uint160(record.owner)));
            da = _hash(da, record.newLeaf);
            for (uint256 j; j < 7; ++j) {
                da = _hash(da, record.ciphertext[j]);
            }
        }
        da = _hash(da, t.poolDA.poolHash);
        for (uint256 i; i < 6; ++i) {
            da = _hash(da, t.poolDA.poolCiphertext[i]);
        }
        t.signals[10] = auth;
        t.signals[11] = da;
        return _authorize(t);
    }

    function _authorize(Transition memory t) internal returns (Transition memory) {
        t.authorization.deadline = block.timestamp + 600;
        t.authorization.signerEpoch = vault.signerEpoch();
        t.authorization.signature = _signature(
            vault.zkPublicationDigest(t.signals, t.authorization.deadline, t.authorization.signerEpoch),
            OPERATOR_KEY
        );
        verifier.configure(keccak256(abi.encode(t.signals)), true, false);
        return t;
    }

    function _publish(Transition memory t) internal {
        vm.prank(payer);
        vault.publishProvenTransition(t.signals, t.operations, t.accountDA, t.poolDA, t.proof);
    }

    function _register() internal {
        Transition memory t = _base(0);
        t.operations[0] = _operation(1, 0, ALICE_KEY, 1001);
        _publish(_seal(t));
    }

    function _opening(uint256 amount, uint256 nonce, uint256 salt)
        internal
        view
        returns (ZkRubaVault.ProvenWithdrawal memory)
    {
        return ZkRubaVault.ProvenWithdrawal(alice, address(ruba), amount, nonce, nonce, salt);
    }

    function _claimCommitment(ZkRubaVault.ProvenWithdrawal memory request)
        internal
        view
        returns (uint256 digest)
    {
        digest = _hash(105, vault.domain());
        uint256[10] memory values = [
            vault.domain(),
            uint256(6),
            vault.ownerSlotPlusOne(request.account) - 1,
            uint256(uint160(request.account)),
            request.spendNonce,
            request.token == address(ruba) ? 0 : 1,
            request.amount,
            request.nonce,
            uint256(0),
            request.salt
        ];
        // domain was already folded into digest above.
        for (uint256 i = 1; i < 10; ++i) {
            digest = _hash(digest, values[i]);
        }
    }

    function _reservation(ZkRubaVault.ProvenWithdrawal memory request)
        internal
        returns (Transition memory t)
    {
        t = _base(0);
        uint256 commitment = _claimCommitment(request);
        t.operations[0] = _operation(6, vault.ownerSlotPlusOne(request.account) - 1, ALICE_KEY, commitment);
        return _seal(t);
    }

    function _redeem(ZkRubaVault.ProvenWithdrawal memory request) internal {
        vm.prank(request.account);
        vault.withdrawProven(request);
    }

    function _control(uint256 kind) internal returns (Transition memory t) {
        t = _base(0);
        t.operations[0] = _operation(kind, 0, ALICE_KEY, 2001);
        if (kind == 8) {
            t.operations[0].signature = _signature(vault.privateOperationDigest(2001), OPERATOR_KEY);
        }
        return _seal(t);
    }

    function _trade() internal returns (Transition memory t) {
        return _trade(4);
    }

    function _trade(uint256 count) internal returns (Transition memory t) {
        t = _base(1);
        t.signals[8] = t.signals[7] + count;
        uint256[4] memory leaves;
        for (uint256 i; i < 4; ++i) {
            if (i < count) {
                t.operations[i] = _operation(3, 0, ALICE_KEY, 3001 + i);
                leaves[i] = 11 + i;
            }
        }
        t.signals[9] = _hash(_hash(leaves[0], leaves[1]), _hash(leaves[2], leaves[3]));
        return _seal(t);
    }
}

contract ZkRubaVaultGenesisTest is ZkRubaVaultFixture {
    function testGenesisIsDeterministicEmptyTreeAndNotAnOperatorRoot() public view {
        uint256 computedDomain = _hash(101, 2);
        computedDomain = _hash(computedDomain, block.chainid);
        computedDomain = _hash(computedDomain, uint256(uint160(address(vault))));
        computedDomain = _hash(computedDomain, uint256(uint160(address(ruba))));
        computedDomain = _hash(computedDomain, uint256(uint160(address(usdt))));
        computedDomain = _hash(computedDomain, POOL_KEY_COMMIT);
        assertEq(vault.domain(), computedDomain);
        uint256[16] memory nodes;
        for (uint256 i; i < 16; ++i) {
            nodes[i] = _hash(102, i);
            for (uint256 j; j < 9; ++j) {
                nodes[i] = _hash(nodes[i], 0);
            }
        }
        for (uint256 width = 16; width > 1; width /= 2) {
            for (uint256 i; i < width / 2; ++i) {
                nodes[i] = _hash(nodes[2 * i], nodes[2 * i + 1]);
            }
        }
        uint256 poolHash = 103;
        for (uint256 i; i < 6; ++i) {
            poolHash = _hash(poolHash, 0);
        }
        uint256 expected = _hash(104, computedDomain);
        expected = _hash(expected, nodes[0]);
        expected = _hash(expected, poolHash);
        expected = _hash(expected, 0);
        expected = _hash(expected, 1);
        expected = _hash(expected, POOL_KEY_COMMIT);
        assertEq(vault.emptyAccountsRoot(), nodes[0]);
        assertEq(vault.genesisStateRoot(), bytes32(expected));
        assertEq(vault.stateRoot(), bytes32(expected));
        assertEq(vault.stateVersion(), 0);
        assertEq(vault.inboxCursor(), 0);
        assertEq(vault.nextTradeId(), 1);
        assertEq(vault.proofMode(), "groth16-bn254-v2");
        assertEq(vault.withdrawalMode(), "proven-reservation-v1");
        assertEq(vault.verifierCodeHash(), address(verifier).codehash);
        assertEq(vault.poseidonCodeHash(), address(poseidon).codehash);
    }

    function testConstructorRejectsMissingCodeAndNonCanonicalFieldValues() public {
        uint256 field = vault.FIELD_MODULUS();
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        new ZkRubaVault(
            address(ruba), address(usdt), address(this), operator, address(1), address(poseidon), 1
        );
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        new ZkRubaVault(
            address(ruba), address(usdt), address(this), operator, address(verifier), address(1), 1
        );
        vm.expectRevert(ZkRubaVault.FieldElementOutOfRange.selector);
        new ZkRubaVault(
            address(ruba), address(usdt), address(this), operator, address(verifier), address(poseidon), field
        );
        UnitOutOfFieldPoseidon2 bad = new UnitOutOfFieldPoseidon2();
        vm.expectRevert(ZkRubaVault.FieldElementOutOfRange.selector);
        new ZkRubaVault(
            address(ruba), address(usdt), address(this), operator, address(verifier), address(bad), 1
        );
    }

    function testLegacyPublicationAndKeccakVerificationAreDisabledEvenForOperator() public {
        RubaVault.Batch memory batch =
            RubaVault.Batch(1, vault.stateRoot(), bytes32(uint256(1)), bytes32(uint256(2)), 1, 4);
        vm.expectRevert(ZkRubaVault.LegacyPublicationDisabled.selector);
        vm.prank(operator);
        vault.publishBatch(batch);
        vm.expectRevert(ZkRubaVault.LegacyPublicationDisabled.selector);
        vault.publishSignedBatch(batch, block.timestamp + 600, 1, hex"1234");
        vm.expectRevert(ZkRubaVault.LegacyPublicationDisabled.selector);
        vault.verifyReceipt(1, bytes32(uint256(1)), new bytes32[](2));
        assertEq(vault.stateRoot(), vault.genesisStateRoot());
    }
}

contract ZkRubaVaultTransitionsTest is ZkRubaVaultFixture {
    event BatchPublished(
        uint256 indexed batchId,
        bytes32 previousStateRoot,
        bytes32 newStateRoot,
        bytes32 receiptsRoot,
        uint256 firstTradeId,
        uint256 tradeCount
    );

    function testUserPaidControlAndTradeTransitionsShareOneRootChain() public {
        assertFalse(vault.whitelist(payer));
        vm.deal(operator, 0);
        vault.setMarketPaused(true);
        _register();
        vault.setMarketPaused(false);
        assertEq(vault.stateVersion(), 1);
        assertEq(vault.ownerSlotPlusOne(alice), 1);
        assertEq(vault.slotOwners(0), alice);
        assertEq(vault.lastBatchId(), 0);
        assertEq(vault.nextTradeId(), 1);
        Transition memory trade = _trade();
        _publish(trade);
        assertEq(vault.stateVersion(), 2);
        assertEq(vault.lastBatchId(), 1);
        assertEq(vault.lastTradeId(), 4);
        assertEq(vault.nextTradeId(), 5);
        uint256[13] memory saved = vault.transitions(2);
        for (uint256 i; i < 13; ++i) {
            assertEq(saved[i], trade.signals[i]);
        }
        _publish(_control(5));
        assertEq(vault.stateVersion(), 3);
        assertEq(vault.lastBatchId(), 1);
        assertEq(vault.nextTradeId(), 5);
        _publish(_trade());
        assertEq(vault.stateVersion(), 4);
        assertEq(vault.lastBatchId(), 2);
        assertEq(vault.lastTradeId(), 8);
        assertEq(operator.balance, 0);
        assertEq(ruba.balanceOf(address(vault)), 0);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }

    function testProofFalseOrVerifierRevertRollsBackRegistrationAndRoot() public {
        Transition memory t = _base(0);
        t.operations[0] = _operation(1, 0, ALICE_KEY, 1);
        t = _seal(t);
        verifier.configure(keccak256(abi.encode(t.signals)), false, false);
        vm.expectRevert(ZkRubaVault.InvalidZkProof.selector);
        _publish(t);
        assertEq(vault.ownerSlotPlusOne(alice), 0);
        assertEq(vault.stateRoot(), vault.genesisStateRoot());
        assertEq(vault.stateVersion(), 0);
        verifier.configure(keccak256(abi.encode(t.signals)), true, true);
        vm.expectRevert(ZkRubaVault.InvalidZkProof.selector);
        _publish(t);
        assertEq(vault.slotOwners(0), address(0));
    }

    function testCannotReplayAProvenTransitionOrSkipItsStateVersion() public {
        _register();
        Transition memory t = _control(5);
        _publish(t);
        vm.expectRevert(ZkRubaVault.InvalidZkTransition.selector);
        _publish(t);
        t = _control(5);
        t.signals[1] += 1;
        t = _authorize(t);
        vm.expectRevert(ZkRubaVault.InvalidZkTransition.selector);
        _publish(t);
    }

    function testRejectsChangedDomainPreviousRootCursorTradeCounterOrPoolKey() public {
        _register();
        uint256[6] memory indices = [uint256(0), 3, 5, 7, 8, 12];
        for (uint256 i; i < indices.length; ++i) {
            Transition memory t = _control(5);
            t.signals[indices[i]] += 1;
            t = _authorize(t);
            vm.expectRevert(ZkRubaVault.InvalidZkTransition.selector);
            _publish(t);
        }
        Transition memory nonCanonical = _control(5);
        nonCanonical.signals[4] = vault.FIELD_MODULUS();
        nonCanonical = _authorize(nonCanonical);
        vm.expectRevert(ZkRubaVault.FieldElementOutOfRange.selector);
        _publish(nonCanonical);
    }

    function testControlNeedsAnOperationAndTradeCountMustMatchMetadata() public {
        _register();
        Transition memory t = _seal(_base(0));
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
        t = _base(0);
        t.operations[0] = _operation(3, 0, ALICE_KEY, 1);
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
        t = _base(1);
        for (uint256 i; i < 3; ++i) {
            t.operations[i] = _operation(3, 0, ALICE_KEY, i + 1);
        }
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
    }

    function testTradeModeRejectsEmptyOversizedAndBackwardsTradeRanges() public {
        _register();
        uint256[3] memory ends = [vault.nextTradeId(), vault.nextTradeId() + 5, uint256(0)];
        for (uint256 i; i < ends.length; ++i) {
            Transition memory t = _trade(1);
            t.signals[8] = ends[i];
            t = _authorize(t);
            vm.expectRevert(ZkRubaVault.InvalidZkTransition.selector);
            _publish(t);
        }
        assertEq(vault.lastBatchId(), 0);
        assertEq(vault.nextTradeId(), 1);
    }

    function testPartialTradeCannotUnderstateItsRealSwapCount() public {
        _register();
        Transition memory t = _trade(3);
        t.signals[8] = t.signals[7] + 1;
        t = _authorize(t);
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
        assertEq(vault.lastBatchId(), 0);
        assertEq(vault.nextTradeId(), 1);
    }

    function testPartialTradeRejectsMissingReceiptsRoot() public {
        _register();
        Transition memory t = _trade(1);
        t.signals[9] = 0;
        t = _authorize(t);
        vm.expectRevert(ZkRubaVault.InvalidZkTransition.selector);
        _publish(t);
    }

    function testPartialTradeRejectsReplayAndStaleControlTransition() public {
        _register();
        Transition memory stale = _control(5);
        Transition memory prepared = _trade(2);
        _publish(prepared);
        vm.expectRevert(ZkRubaVault.InvalidZkTransition.selector);
        _publish(prepared);
        vm.expectRevert(ZkRubaVault.InvalidZkTransition.selector);
        _publish(stale);
        assertEq(vault.lastBatchId(), 1);
        assertEq(vault.nextTradeId(), 3);
    }

    function testPartialBatchesAdvanceTradeIdsByActualCountAcrossControlTransitions() public {
        _register();
        uint256 expectedNext = 1;
        for (uint256 count = 1; count <= 4; ++count) {
            Transition memory t = _trade(count);
            uint256 batchId = vault.lastBatchId() + 1;
            vm.expectEmit(true, false, false, true, address(vault));
            emit BatchPublished(
                batchId,
                bytes32(t.signals[3]),
                bytes32(t.signals[4]),
                bytes32(t.signals[9]),
                expectedNext,
                count
            );
            _publish(t);
            (,,,, uint256 firstTradeId, uint256 tradeCount) = vault.batches(batchId);
            assertEq(firstTradeId, expectedNext);
            assertEq(tradeCount, count);
            expectedNext += count;
            assertEq(vault.nextTradeId(), expectedNext);
            assertEq(vault.lastTradeId(), expectedNext - 1);
            assertEq(vault.lastBatchId(), batchId);
            _publish(_control(5));
            assertEq(vault.nextTradeId(), expectedNext);
            assertEq(vault.lastBatchId(), batchId);
        }
        assertEq(vault.MIN_ZK_TRADES_PER_BATCH(), 1);
        assertEq(vault.MAX_ZK_TRADES_PER_BATCH(), 4);
    }

    function testFuzz_PartialBatchStoresOnlyActualTradeCount(uint256 requestedCount) public {
        _register();
        uint256 count = bound(requestedCount, 1, 4);
        _publish(_trade(count));
        (,,,, uint256 firstTradeId, uint256 tradeCount) = vault.batches(1);
        assertEq(firstTradeId, 1);
        assertEq(tradeCount, count);
        assertEq(vault.nextTradeId(), 1 + count);
    }

    function testOrderedPoseidonReceiptsCannotUseAnotherTradeIndex() public {
        _register();
        _publish(_trade());
        uint256[4] memory leaves = [uint256(11), 12, 13, 14];
        for (uint256 i; i < 4; ++i) {
            uint256[2] memory siblings = [leaves[i ^ 1], i < 2 ? _hash(13, 14) : _hash(11, 12)];
            assertTrue(vault.verifyZkReceipt(1, i + 1, leaves[i], siblings));
            assertFalse(vault.verifyZkReceipt(1, (i ^ 1) + 1, leaves[i], siblings));
        }
        assertFalse(vault.verifyZkReceipt(1, 5, 11, [uint256(12), _hash(13, 14)]));
        assertFalse(vault.verifyZkReceipt(0, 1, 11, [uint256(12), _hash(13, 14)]));
    }

    function testPartialReceiptsVerifyRealLeavesButNeverPaddedLeaves() public {
        _register();
        for (uint256 count = 1; count < 4; ++count) {
            Transition memory t = _trade(count);
            uint256 firstTradeId = t.signals[7];
            _publish(t);
            uint256[4] memory leaves;
            for (uint256 i; i < count; ++i) {
                leaves[i] = 11 + i;
            }
            for (uint256 i; i < 4; ++i) {
                uint256[2] memory siblings =
                    [leaves[i ^ 1], i < 2 ? _hash(leaves[2], leaves[3]) : _hash(leaves[0], leaves[1])];
                // Even a mathematically valid path to padding is not a real trade receipt.
                bool verified =
                    vault.verifyZkReceipt(vault.lastBatchId(), firstTradeId + i, leaves[i], siblings);
                assertEq(verified, i < count);
            }
        }
    }
}

contract ZkRubaVaultAuthorizationAndDaTest is ZkRubaVaultFixture {
    function testOperationAndPublicationDigestsMatchIndependentV2Eip712Encoding() public view {
        bytes32 domainType =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 operationDomain = keccak256(
            abi.encode(
                domainType, keccak256("RubaZkOperation"), keccak256("2"), block.chainid, address(vault)
            )
        );
        bytes32 operationHash =
            keccak256(abi.encode(keccak256("PrivateOperation(uint256 commitment)"), uint256(1234)));
        assertEq(
            vault.privateOperationDigest(1234),
            keccak256(abi.encodePacked(hex"1901", operationDomain, operationHash))
        );
        uint256[13] memory signals;
        for (uint256 i; i < 13; ++i) {
            signals[i] = i + 1;
        }
        bytes32 publicationDomain = keccak256(
            abi.encode(
                domainType, keccak256("RubaZkPublication"), keccak256("2"), block.chainid, address(vault)
            )
        );
        bytes32 publicationHash = keccak256(
            abi.encode(
                keccak256("ZkPublication(uint256 headerDigest,uint256 deadline,uint256 signerEpoch)"),
                keccak256(abi.encode(signals)),
                uint256(1600),
                uint256(1)
            )
        );
        assertEq(
            vault.zkPublicationDigest(signals, 1600, 1),
            keccak256(abi.encodePacked(hex"1901", publicationDomain, publicationHash))
        );
    }

    function testRegistrationRejectsUnlistedOwnerEvenWhenPublisherIsWhitelisted() public {
        Transition memory t = _base(0);
        t.operations[0] = _operation(1, 0, BOB_KEY, 1234);
        t = _seal(t);
        vault.setWhitelist(payer, true);
        vm.expectRevert(RubaVault.NotWhitelisted.selector);
        _publish(t);
        assertEq(vault.ownerSlotPlusOne(bob), 0);
        assertEq(vault.slotOwners(0), address(0));
        assertEq(vault.stateRoot(), vault.genesisStateRoot());
        assertEq(vault.stateVersion(), 0);
    }

    function testRegistrationRejectsRevokedOwnerThenSucceedsAfterReadmissionWithUnlistedPublisher() public {
        Transition memory t = _base(0);
        t.operations[0] = _operation(1, 0, ALICE_KEY, 1234);
        t = _seal(t);
        vault.setWhitelist(alice, false);
        vm.expectRevert(RubaVault.NotWhitelisted.selector);
        _publish(t);
        vault.setWhitelist(alice, true);
        _publish(t);
        assertFalse(vault.whitelist(payer));
        assertEq(vault.ownerSlotPlusOne(alice), 1);
        assertEq(vault.slotOwners(0), alice);
    }

    function testRegistrationRequiresOwnerSignatureAndCannotReuseOwnerOrSlot() public {
        Transition memory t = _base(0);
        t.operations[0] = _operation(1, 0, ALICE_KEY, 1234);
        t.operations[0].signature = _signature(vault.privateOperationDigest(1234), BOB_KEY);
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidOperationAuthorization.selector);
        _publish(t);
        assertEq(vault.ownerSlotPlusOne(alice), 0);
        _register();
        t = _base(0);
        t.operations[0] = _operation(1, 1, ALICE_KEY, 1234);
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidRegistration.selector);
        _publish(t);
        t = _base(0);
        vault.setWhitelist(bob, true);
        t.operations[0] = _operation(1, 0, BOB_KEY, 1234);
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidRegistration.selector);
        _publish(t);
    }

    function testExistingSlotOwnerCannotBeChangedAndRefundIsDisabledEvenWithOperatorSignature() public {
        _register();
        Transition memory t = _base(0);
        t.operations[0] = _operation(5, 0, BOB_KEY, 12);
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidRegistration.selector);
        _publish(t);
        t = _control(8);
        t.operations[0].signature = _signature(vault.privateOperationDigest(2001), ALICE_KEY);
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
        t = _control(8);
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
        assertEq(vault.stateVersion(), 1);
    }

    function testUserMetadataCannotLeakPrivateParametersAndPaddingMustBeZeroSuffix() public {
        _register();
        Transition memory t = _control(5);
        t.operations[0].amount = 1;
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
        t = _base(0);
        t.operations[1] = _operation(5, 0, ALICE_KEY, 1);
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
        t = _control(5);
        t.operations[7].commitment = 1;
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
    }

    function testActualDaCiphertextLeavesAndPoolDataAreBoundToThePublicDigest() public {
        _register();
        Transition memory t = _control(5);
        t.accountDA[0].ciphertext[0] += 1;
        vm.expectRevert(ZkRubaVault.InvalidDataAvailability.selector);
        _publish(t);
        t = _control(5);
        t.accountDA[0].newLeaf += 1;
        vm.expectRevert(ZkRubaVault.InvalidDataAvailability.selector);
        _publish(t);
        t = _control(5);
        t.poolDA.poolCiphertext[5] += 1;
        vm.expectRevert(ZkRubaVault.InvalidDataAvailability.selector);
        _publish(t);
        t = _control(5);
        t.accountDA[0].owner = bob;
        vm.expectRevert(ZkRubaVault.InvalidDataAvailability.selector);
        _publish(t);
        t = _control(5);
        t.accountDA[7].ciphertext[0] = 1;
        vm.expectRevert(ZkRubaVault.InvalidDataAvailability.selector);
        _publish(t);
    }

    function testAuthDigestCannotBeSubstitutedAndFieldElementsAreNeverReduced() public {
        _register();
        Transition memory t = _control(5);
        t.signals[10] += 1;
        t = _authorize(t);
        vm.expectRevert(ZkRubaVault.InvalidOperationMetadata.selector);
        _publish(t);
        t = _control(5);
        t.accountDA[0].newLeaf = vault.FIELD_MODULUS();
        vm.expectRevert(ZkRubaVault.FieldElementOutOfRange.selector);
        _publish(t);
    }

    function testProofOnlyPublicationDoesNotRequireOperatorPermitDeadlineOrEpoch() public {
        _register();
        Transition memory t = _control(5);
        t.authorization.signature = _signature(
            vault.zkPublicationDigest(t.signals, t.authorization.deadline, t.authorization.signerEpoch),
            BOB_KEY
        );
        vm.warp(t.authorization.deadline + 1);
        vault.setOperator(bob);
        _publish(t);
        t = _control(5);
        vm.expectRevert(ZkRubaVault.LegacyPublicationDisabled.selector);
        vault.publishZkTransition(t.signals, t.operations, t.accountDA, t.poolDA, t.proof, t.authorization);
    }
}

contract ZkRubaVaultInboxAndWithdrawalTest is ZkRubaVaultFixture {
    function testAggregateDepositCapRollsBackAndSuccessfulWithdrawalFreesCapacity() public {
        _register();
        uint256 amount = uint256(1) << 95;
        ruba.mint(alice, amount * 2);
        vm.prank(alice);
        vault.deposit(address(ruba), amount);
        uint256 balanceBefore = ruba.balanceOf(alice);
        uint256 custodyBefore = ruba.balanceOf(address(vault));
        uint256 depositIdBefore = vault.nextDepositId();
        uint256 inboxIdBefore = vault.nextInboxEventId();
        vm.expectRevert(RubaVault.InvalidAmount.selector);
        vm.prank(alice);
        vault.deposit(address(ruba), amount);
        assertEq(ruba.balanceOf(alice), balanceBefore);
        assertEq(ruba.balanceOf(address(vault)), custodyBefore);
        assertEq(vault.nextDepositId(), depositIdBefore);
        assertEq(vault.nextInboxEventId(), inboxIdBefore);
        (uint256 missingKind,,,,) = vault.inbox(inboxIdBefore);
        assertEq(missingKind, 0);

        uint256 payout = uint256(1) << 94;
        ZkRubaVault.ProvenWithdrawal memory request = _opening(payout, 1, 451);
        _publish(_reservation(request));
        _redeem(request);
        vm.prank(alice);
        vault.deposit(address(ruba), amount);
        assertEq(ruba.balanceOf(address(vault)), amount * 2 - payout);
        assertEq(vault.nextDepositId(), depositIdBefore + 1);
        assertEq(vault.nextInboxEventId(), inboxIdBefore + 2);
        (uint256 kind,, uint256 tokenIndex, uint256 creditedAmount,) = vault.inbox(inboxIdBefore + 1);
        assertEq(kind, 2);
        assertEq(tokenIndex, 0);
        assertEq(creditedAmount, amount);
    }

    function testOversizedDepositRevertsWithoutChangingCustodyOrCanonicalInbox() public {
        _register();
        uint256 oversized = uint256(1) << 96;
        ruba.mint(alice, oversized);
        uint256 balanceBefore = ruba.balanceOf(alice);
        uint256 custodyBefore = ruba.balanceOf(address(vault));
        uint256 depositIdBefore = vault.nextDepositId();
        uint256 inboxIdBefore = vault.nextInboxEventId();
        vm.startPrank(alice);
        ruba.approve(address(vault), oversized);
        vm.expectRevert(RubaVault.InvalidAmount.selector);
        vault.deposit(address(ruba), oversized);
        vm.stopPrank();
        assertEq(ruba.balanceOf(alice), balanceBefore);
        assertEq(ruba.balanceOf(address(vault)), custodyBefore);
        assertEq(vault.nextDepositId(), depositIdBefore);
        assertEq(vault.nextInboxEventId(), inboxIdBefore);
        assertEq(vault.inboxCursor(), 0);
        (uint256 kind,,,,) = vault.inbox(inboxIdBefore);
        assertEq(kind, 0);
    }

    function _depositAndRegistration() internal returns (Transition memory t) {
        _register();
        vm.prank(alice);
        vault.deposit(address(ruba), 10 ether);
        t = _base(0);
        t.operations[0] = ZkRubaVault.OperationMetadata(2, 0, alice, 2, 1, 0, 10 ether, 1, "");
        t.signals[6] = 1;
        return _seal(t);
    }

    function testOnlySuccessfulTransfersAppendCanonicalInboxRecords() public {
        Transition memory t = _depositAndRegistration();
        (uint256 kind, address account, uint256 tokenIndex, uint256 amount, uint256 ref) = vault.inbox(1);
        assertEq(kind, 2);
        assertEq(account, alice);
        assertEq(tokenIndex, 0);
        assertEq(amount, 10 ether);
        assertEq(ref, 1);
        assertEq(vault.nextInboxEventId(), 2);
        assertEq(vault.inboxCursor(), 0);
        vm.expectRevert(RubaVault.InvalidAmount.selector);
        vm.prank(alice);
        vault.deposit(address(ruba), 0);
        assertEq(vault.nextInboxEventId(), 2);
        _publish(t);
        assertEq(vault.inboxCursor(), 1);
        assertEq(vault.stateVersion(), 2);
    }

    function testAcceptedDepositCanBeCreditedAndWithdrawnAfterOwnerAccessIsRevoked() public {
        Transition memory depositTransition = _depositAndRegistration();
        vault.setWhitelist(alice, false);
        vault.setMarketPaused(true);
        _publish(depositTransition);
        assertEq(vault.inboxCursor(), 1);
        ZkRubaVault.ProvenWithdrawal memory request = _opening(10 ether, 1, 912);
        _publish(_reservation(request));
        _redeem(request);
        Transition memory settlement = _base(0);
        settlement.operations[0] = ZkRubaVault.OperationMetadata(7, 0, alice, 123, 2, 0, 10 ether, 1, "");
        settlement.signals[6] = 2;
        _publish(_seal(settlement));
        assertEq(vault.inboxCursor(), 2);
        assertEq(ruba.balanceOf(address(vault)), 0);
        assertEq(ruba.balanceOf(alice), 1000 ether);
    }

    function testInboxOwnerTokenAmountReferenceAndSequenceCannotBeInvented() public {
        Transition memory t = _depositAndRegistration();
        t.operations[0].amount += 1;
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidInboxMessage.selector);
        _publish(t);
        t.operations[0].amount -= 1;
        t.operations[0].referenceId = 2;
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidInboxMessage.selector);
        _publish(t);
        t.operations[0].referenceId = 1;
        t.operations[0].token = 1;
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidInboxMessage.selector);
        _publish(t);
        t.operations[0].token = 0;
        t.operations[0].eventId = 2;
        t = _seal(t);
        vm.expectRevert(ZkRubaVault.InvalidInboxMessage.selector);
        _publish(t);
        assertEq(vault.inboxCursor(), 0);
        assertEq(vault.ownerSlotPlusOne(alice), 1);
    }

    function testAcceptedReservationPaysOwnerWithoutWhitelistOrMarketPermissionAndIsOneUse() public {
        _publish(_depositAndRegistration());
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3 ether, 1, 911);
        uint256 commitment = _claimCommitment(request);
        vm.expectRevert(ZkRubaVault.UnacceptedWithdrawal.selector);
        _redeem(request);
        _publish(_reservation(request));
        (address claimOwner, uint256 slot, uint256 version) = vault.withdrawalClaims(commitment);
        assertEq(claimOwner, alice);
        assertEq(slot, 0);
        assertEq(version, 3);
        vault.setWhitelist(alice, false);
        vault.setMarketPaused(true);
        vm.expectRevert(RubaVault.UnauthorizedAccount.selector);
        vm.prank(bob);
        vault.withdrawProven(request);
        assertEq(vault.nextInboxEventId(), 2);
        bytes32 rootBefore = vault.stateRoot();
        _redeem(request);
        assertEq(vault.stateVersion(), 3, "payout does not set an unproven private root");
        assertEq(vault.stateRoot(), rootBefore);
        assertEq(ruba.balanceOf(address(vault)), 7 ether);
        assertEq(vault.nextInboxEventId(), 3);
        (uint256 kind, address account, uint256 tokenIndex, uint256 amount, uint256 ref) = vault.inbox(2);
        assertEq(kind, 7);
        assertEq(account, alice);
        assertEq(tokenIndex, 0);
        assertEq(amount, 3 ether);
        assertEq(ref, 1);
        assertTrue(vault.spentWithdrawalCommitments(commitment));
        assertTrue(vault.usedWithdrawalNonces(alice, 1));
        vm.expectRevert(RubaVault.WithdrawalAlreadyUsed.selector);
        _redeem(request);
        assertEq(vault.nextInboxEventId(), 3);
    }

    function testSettlementMustConsumeTheActualSequentialWithdrawalMessage() public {
        _publish(_depositAndRegistration());
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3 ether, 1, 191);
        _publish(_reservation(request));
        _redeem(request);
        Transition memory t = _base(0);
        t.operations[0] = ZkRubaVault.OperationMetadata(7, 0, alice, 123, 2, 0, 3 ether, 1, "");
        t.signals[6] = 2;
        t = _seal(t);
        _publish(t);
        assertEq(vault.inboxCursor(), 2);
        assertEq(vault.stateVersion(), 4);
        assertEq(vault.lastBatchId(), 0);
    }
}

contract ZkRubaVaultProvenWithdrawalsTest is ZkRubaVaultFixture {
    function _funded() internal {
        _register();
        vm.startPrank(alice);
        vault.deposit(address(ruba), 20 ether);
        vault.deposit(address(usdt), 20e6);
        vm.stopPrank();
        Transition memory t = _base(0);
        t.operations[0] = ZkRubaVault.OperationMetadata(2, 0, alice, 51, 1, 0, 20 ether, 1, "");
        t.operations[1] = ZkRubaVault.OperationMetadata(2, 0, alice, 52, 2, 1, 20e6, 2, "");
        t.signals[6] = 2;
        _publish(_seal(t));
    }

    function testDepositRequiresWhitelistAndAcceptedRegistration() public {
        vm.expectRevert(ZkRubaVault.InvalidRegistration.selector);
        vm.prank(alice);
        vault.deposit(address(ruba), 1 ether);
        assertEq(vault.nextDepositId(), 1);
        assertEq(vault.nextInboxEventId(), 1);
        _register();
        vm.prank(alice);
        vault.deposit(address(ruba), 1 ether);
        assertEq(vault.nextInboxEventId(), 2);
        vault.setWhitelist(bob, true);
        vm.expectRevert(ZkRubaVault.InvalidRegistration.selector);
        vm.prank(bob);
        vault.deposit(address(ruba), 1);
        vault.setMarketPaused(true);
        vm.expectRevert(RubaVault.MarketPaused.selector);
        vm.prank(alice);
        vault.deposit(address(ruba), 1);
        assertEq(vault.nextInboxEventId(), 2);
    }

    function testDepositRejectsUnlistedUnregisteredOwnerWithoutMovingTokens() public {
        vault.setWhitelist(alice, false);
        vm.expectRevert(RubaVault.NotWhitelisted.selector);
        vm.prank(alice);
        vault.deposit(address(ruba), 1 ether);
        assertEq(ruba.balanceOf(alice), 1000 ether);
        assertEq(ruba.balanceOf(address(vault)), 0);
        assertEq(vault.nextDepositId(), 1);
        assertEq(vault.nextInboxEventId(), 1);
    }

    function testDepositRejectsRevokedRegisteredOwnerAndReadmissionAllowsDeposit() public {
        _register();
        vault.setWhitelist(alice, false);
        bytes32 rootBefore = vault.stateRoot();
        vm.expectRevert(RubaVault.NotWhitelisted.selector);
        vm.prank(alice);
        vault.deposit(address(ruba), 1 ether);
        assertEq(ruba.balanceOf(alice), 1000 ether);
        assertEq(ruba.balanceOf(address(vault)), 0);
        assertEq(vault.nextDepositId(), 1);
        assertEq(vault.nextInboxEventId(), 1);
        assertEq(vault.stateRoot(), rootBefore);
        vault.setWhitelist(alice, true);
        vm.prank(alice);
        vault.deposit(address(ruba), 1 ether);
        assertEq(ruba.balanceOf(address(vault)), 1 ether);
        assertEq(vault.nextInboxEventId(), 2);
    }

    function testSwapAndAddLiquidityStillRequireOwnerAccessButRemovalAndReservationDoNot() public {
        _register();
        vault.setWhitelist(alice, false);
        Transition memory t = _trade();
        vm.expectRevert(RubaVault.NotWhitelisted.selector);
        _publish(t);
        t = _control(4);
        vm.expectRevert(RubaVault.NotWhitelisted.selector);
        _publish(t);
        vault.setWhitelist(alice, true);
        vault.setMarketPaused(true);
        t = _trade();
        vm.expectRevert(RubaVault.MarketPaused.selector);
        _publish(t);
        t = _control(4);
        vm.expectRevert(RubaVault.MarketPaused.selector);
        _publish(t);
        vault.setWhitelist(alice, false);
        _publish(_control(5));
        _publish(_reservation(_opening(1 ether, 2, 102)));
        assertEq(vault.stateVersion(), 3);
    }

    function testLegacyOperatorWithdrawalCannotBypassClaimsEvenWithAValidSignature() public {
        _funded();
        RubaVault.Withdrawal memory oldRequest =
            RubaVault.Withdrawal(alice, address(ruba), 1 ether, 1, block.timestamp + 600, 1);
        bytes memory signature = _signature(vault.withdrawalDigest(oldRequest), OPERATOR_KEY);
        vm.expectRevert(ZkRubaVault.LegacyWithdrawalDisabled.selector);
        vm.prank(alice);
        vault.withdraw(oldRequest, signature);
        assertEq(ruba.balanceOf(address(vault)), 20 ether);
        assertFalse(vault.usedWithdrawalNonces(alice, 1));
    }

    function testInvalidProofCannotCreateWithdrawalClaim() public {
        _funded();
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3 ether, 1, 103);
        uint256 commitment = _claimCommitment(request);
        Transition memory t = _reservation(request);
        verifier.configure(keccak256(abi.encode(t.signals)), false, false);
        vm.expectRevert(ZkRubaVault.InvalidZkProof.selector);
        _publish(t);
        (address owner,,) = vault.withdrawalClaims(commitment);
        assertEq(owner, address(0));
        vm.expectRevert(ZkRubaVault.UnacceptedWithdrawal.selector);
        _redeem(request);
    }

    function testOpeningCannotChangeAmountTokenNonceSaltOrOwner() public {
        _funded();
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3 ether, 1, 104);
        _publish(_reservation(request));
        request.amount += 1;
        vm.expectRevert(ZkRubaVault.UnacceptedWithdrawal.selector);
        _redeem(request);
        request.amount -= 1;
        request.token = address(usdt);
        vm.expectRevert(ZkRubaVault.UnacceptedWithdrawal.selector);
        _redeem(request);
        request.token = address(ruba);
        request.nonce = 2;
        request.spendNonce = 2;
        vm.expectRevert(ZkRubaVault.UnacceptedWithdrawal.selector);
        _redeem(request);
        request.nonce = 1;
        request.spendNonce = 1;
        request.salt += 1;
        vm.expectRevert(ZkRubaVault.UnacceptedWithdrawal.selector);
        _redeem(request);
        request.salt -= 1;
        vm.expectRevert(RubaVault.UnauthorizedAccount.selector);
        vm.prank(bob);
        vault.withdrawProven(request);
        _redeem(request);
    }

    function testOpeningBoundsAndNonceEqualityAreEnforcedBeforePayment() public {
        _funded();
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3 ether, 1, 105);
        request.nonce = 2;
        _publish(_reservation(request)); // The unchanged circuit does not require nonce==spendNonce.
        vm.expectRevert(ZkRubaVault.InvalidWithdrawalOpening.selector);
        _redeem(request);
        request.nonce = uint256(1) << 64;
        request.spendNonce = request.nonce;
        vm.expectRevert(ZkRubaVault.InvalidWithdrawalOpening.selector);
        _redeem(request);
        request.nonce = 1;
        request.spendNonce = 1;
        request.salt = 0;
        vm.expectRevert(ZkRubaVault.InvalidWithdrawalOpening.selector);
        _redeem(request);
        request.salt = vault.FIELD_MODULUS();
        vm.expectRevert(ZkRubaVault.FieldElementOutOfRange.selector);
        _redeem(request);
        request.salt = 105;
        request.amount = uint256(1) << 96;
        vm.expectRevert(RubaVault.InvalidAmount.selector);
        _redeem(request);
        request.amount = 0;
        vm.expectRevert(RubaVault.InvalidAmount.selector);
        _redeem(request);
        request.amount = 1;
        request.token = address(0x1234);
        vm.expectRevert(RubaVault.UnsupportedToken.selector);
        _redeem(request);
        assertFalse(vault.usedWithdrawalNonces(alice, 1));
        assertEq(ruba.balanceOf(address(vault)), 20 ether);
    }

    function testOldClaimSurvivesLaterRootsOperatorRotationAndTimeButHonorsTokenPause() public {
        _funded();
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3 ether, 1, 106);
        _publish(_reservation(request));
        uint256 commitment = _claimCommitment(request);
        (,, uint256 acceptedVersion) = vault.withdrawalClaims(commitment);
        Transition memory later = _base(0);
        vault.setWhitelist(bob, true);
        later.operations[0] = _operation(1, 1, BOB_KEY, 1106);
        _publish(_seal(later));
        assertGt(vault.stateVersion(), acceptedVersion);
        vault.setOperator(bob);
        vault.setWhitelist(alice, false);
        vault.setMarketPaused(true);
        vm.warp(block.timestamp + 365 days);
        vault.setTokenWithdrawalsPaused(address(ruba), true);
        vm.expectRevert(RubaVault.TokenWithdrawalsPaused.selector);
        _redeem(request);
        assertFalse(vault.spentWithdrawalCommitments(commitment));
        vault.setTokenWithdrawalsPaused(address(ruba), false);
        _redeem(request);
        assertTrue(vault.spentWithdrawalCommitments(commitment));
    }

    function testTokenPayoutFailureRollsBackBothNullifiersBalancesAndInbox() public {
        _funded();
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3e6, 1, 107);
        request.token = address(usdt);
        _publish(_reservation(request));
        uint256 commitment = _claimCommitment(request);
        uint256 inboxBefore = vault.nextInboxEventId();
        uint256 balanceBefore = usdt.balanceOf(alice);
        usdt.setBlacklisted(alice, true);
        vm.expectRevert("USDT: blacklisted");
        _redeem(request);
        assertFalse(vault.spentWithdrawalCommitments(commitment));
        assertFalse(vault.usedWithdrawalNonces(alice, 1));
        assertEq(vault.nextInboxEventId(), inboxBefore);
        assertEq(usdt.balanceOf(alice), balanceBefore);
        assertEq(usdt.balanceOf(address(vault)), 20e6);
        usdt.setBlacklisted(alice, false);
        _redeem(request);
        assertEq(usdt.balanceOf(address(vault)), 17e6);
    }

    function testTwoDistinctSpendNoncesCreateSeparatelyRedeemableOneUseClaims() public {
        _funded();
        ZkRubaVault.ProvenWithdrawal memory first = _opening(3 ether, 1, 108);
        _publish(_reservation(first));
        ZkRubaVault.ProvenWithdrawal memory second = _opening(4 ether, 2, 109);
        _publish(_reservation(second));
        _redeem(second);
        _redeem(first);
        assertEq(ruba.balanceOf(address(vault)), 13 ether);
        assertTrue(vault.spentWithdrawalCommitments(_claimCommitment(first)));
        assertTrue(vault.spentWithdrawalCommitments(_claimCommitment(second)));
        assertTrue(vault.usedWithdrawalNonces(alice, 1));
        assertTrue(vault.usedWithdrawalNonces(alice, 2));
    }

    function testAtomicOpeningFailureRollsBackProofRootAndClaimThenValidRetryPaysOnce() public {
        _funded();
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3 ether, 1, 110);
        uint256 commitment = _claimCommitment(request);
        Transition memory t = _reservation(request);
        uint256 versionBefore = vault.stateVersion();
        bytes32 rootBefore = vault.stateRoot();
        request.amount += 1;
        vm.expectRevert(ZkRubaVault.UnacceptedWithdrawal.selector);
        vm.prank(alice);
        vault.publishProvenTransitionAndWithdraw(
            t.signals, t.operations, t.accountDA, t.poolDA, t.proof, request
        );
        assertEq(vault.stateVersion(), versionBefore);
        assertEq(vault.stateRoot(), rootBefore);
        (address owner,,) = vault.withdrawalClaims(commitment);
        assertEq(owner, address(0));
        request.amount -= 1;
        vm.prank(alice);
        vault.publishProvenTransitionAndWithdraw(
            t.signals, t.operations, t.accountDA, t.poolDA, t.proof, request
        );
        assertEq(vault.stateVersion(), versionBefore + 1);
        assertTrue(vault.spentWithdrawalCommitments(commitment));
        assertEq(ruba.balanceOf(address(vault)), 17 ether);
    }

    function testAtomicTokenFailureAlsoRollsBackTheAcceptedTransition() public {
        _funded();
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3e6, 1, 112);
        request.token = address(usdt);
        uint256 commitment = _claimCommitment(request);
        Transition memory t = _reservation(request);
        uint256 versionBefore = vault.stateVersion();
        bytes32 rootBefore = vault.stateRoot();
        uint256 inboxBefore = vault.nextInboxEventId();
        usdt.setBlacklisted(alice, true);
        vm.expectRevert("USDT: blacklisted");
        vm.prank(alice);
        vault.publishProvenTransitionAndWithdraw(
            t.signals, t.operations, t.accountDA, t.poolDA, t.proof, request
        );
        assertEq(vault.stateVersion(), versionBefore);
        assertEq(vault.stateRoot(), rootBefore);
        assertEq(vault.nextInboxEventId(), inboxBefore);
        assertFalse(vault.spentWithdrawalCommitments(commitment));
        assertFalse(vault.usedWithdrawalNonces(alice, 1));
        (address owner,,) = vault.withdrawalClaims(commitment);
        assertEq(owner, address(0));
        assertEq(usdt.balanceOf(address(vault)), 20e6);
    }

    function testProvenPayoutBlocksTokenReentrancyWithoutDuplicatingClaimOrInbox() public {
        ReentrantToken hooked = new ReentrantToken();
        ruba = hooked;
        vault = new ZkRubaVault(
            address(hooked),
            address(usdt),
            address(this),
            operator,
            address(verifier),
            address(poseidon),
            POOL_KEY_COMMIT
        );
        vault.setWhitelist(alice, true);
        _register();
        hooked.mint(alice, 10 ether);
        vm.startPrank(alice);
        hooked.approve(address(vault), 10 ether);
        vault.deposit(address(hooked), 10 ether);
        vm.stopPrank();
        ZkRubaVault.ProvenWithdrawal memory request = _opening(3 ether, 1, 111);
        _publish(_reservation(request));
        hooked.setCallback(address(vault), abi.encodeCall(ZkRubaVault.withdrawProven, (request)), true, false);
        _redeem(request);
        assertFalse(hooked.callbackSucceeded());
        assertEq(bytes4(hooked.callbackError()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertTrue(vault.spentWithdrawalCommitments(_claimCommitment(request)));
        assertEq(vault.nextInboxEventId(), 3);
        assertEq(hooked.balanceOf(address(vault)), 7 ether);
    }
}
