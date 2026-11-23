// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RubaVault} from "../src/RubaVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

abstract contract RubaVaultFixture is Test {
    RubaVault internal vault;
    MockERC20 internal ruba;
    MockUSDT internal usdt;
    uint256 internal constant OPERATOR_KEY = 0xa11ce;
    address internal operator;
    address internal alice;
    address internal bob;

    event Deposited(
        uint256 indexed depositId, address indexed account, address indexed token, uint256 amount
    );
    event Withdrawn(
        address indexed account,
        address indexed token,
        uint256 amount,
        uint256 indexed nonce,
        uint256 signerEpoch
    );

    function setUp() public {
        operator = vm.addr(OPERATOR_KEY);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        ruba = new MockERC20("Mock RUBA", "RUBA", 18);
        usdt = new MockUSDT();
        vault = new RubaVault(address(ruba), address(usdt), address(this), operator);
        vault.setWhitelist(alice, true);
        vault.setWhitelist(bob, true);
        ruba.mint(alice, 1_000_000 ether);
        usdt.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        ruba.approve(address(vault), type(uint256).max);
        usdt.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _fundVault() internal {
        vm.startPrank(alice);
        vault.deposit(address(ruba), 1000 ether);
        vault.deposit(address(usdt), 1000e6);
        vm.stopPrank();
    }

    function _request(address account, address token, uint256 amount, uint256 nonce)
        internal
        view
        returns (RubaVault.Withdrawal memory)
    {
        return
            RubaVault.Withdrawal(account, token, amount, nonce, block.timestamp + 3600, vault.signerEpoch());
    }

    function _sign(RubaVault target, RubaVault.Withdrawal memory request, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, target.withdrawalDigest(request));
        return abi.encodePacked(r, s, v);
    }

    function _batch(uint256 id, bytes32 previous, bytes32 next, bytes32 receipts, uint256 first)
        internal
        pure
        returns (RubaVault.Batch memory)
    {
        return RubaVault.Batch(id, previous, next, receipts, first, 4);
    }

    function _expectInvalidBatch(RubaVault.Batch memory batch) internal {
        vm.expectRevert(RubaVault.InvalidBatch.selector);
        vm.prank(operator);
        vault.publishBatch(batch);
    }

    function _hashPair(bytes32 first, bytes32 second) internal pure returns (bytes32) {
        return first < second
            ? keccak256(abi.encodePacked(first, second))
            : keccak256(abi.encodePacked(second, first));
    }
}

contract RubaVaultDepositsTest is RubaVaultFixture {
    function testDepositRubaEmitsMonotonicIdsAndCustodiesExactAmount() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit Deposited(1, alice, address(ruba), 100 ether);
        vm.prank(alice);
        assertEq(vault.deposit(address(ruba), 100 ether), 1);
        vm.prank(alice);
        assertEq(vault.deposit(address(usdt), 25e6), 2);
        assertEq(vault.nextDepositId(), 3);
        assertEq(ruba.balanceOf(address(vault)), 100 ether);
        assertEq(usdt.balanceOf(address(vault)), 25e6);
    }

    function testDepositSupportsNoReturnUsdt() public {
        vm.prank(alice);
        vault.deposit(address(usdt), 123_456_789);
        assertEq(usdt.balanceOf(address(vault)), 123_456_789);
        assertEq(ruba.decimals(), 18);
        assertEq(usdt.decimals(), 6);
    }

    function testDepositRejectsNonWhitelistedAccount() public {
        vault.setWhitelist(alice, false);
        vm.expectRevert(RubaVault.NotWhitelisted.selector);
        vm.prank(alice);
        vault.deposit(address(ruba), 1 ether);
    }

    function testDepositRejectsPausedMarket() public {
        vault.setMarketPaused(true);
        vm.expectRevert(RubaVault.MarketPaused.selector);
        vm.prank(alice);
        vault.deposit(address(ruba), 1 ether);
    }

    function testDepositRejectsUnknownTokenAndZeroAmount() public {
        vm.expectRevert(RubaVault.UnsupportedToken.selector);
        vm.prank(alice);
        vault.deposit(address(0xbeef), 1);
        vm.expectRevert(RubaVault.InvalidAmount.selector);
        vm.prank(alice);
        vault.deposit(address(ruba), 0);
    }

    function testDepositFailedTransferDoesNotConsumeId() public {
        usdt.setBlacklisted(address(vault), true);
        vm.expectRevert();
        vm.prank(alice);
        vault.deposit(address(usdt), 1e6);
        assertEq(vault.nextDepositId(), 1);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }

    function testDepositRejectsFeeOnTransferAndRollsBack() public {
        FeeOnTransferToken taxed = new FeeOnTransferToken();
        RubaVault taxedVault = new RubaVault(address(taxed), address(usdt), address(this), operator);
        taxedVault.setWhitelist(alice, true);
        taxed.mint(alice, 100 ether);
        vm.startPrank(alice);
        taxed.approve(address(taxedVault), 100 ether);
        vm.expectRevert(RubaVault.UnsupportedTransferBehavior.selector);
        taxedVault.deposit(address(taxed), 100 ether);
        vm.stopPrank();
        assertEq(taxed.balanceOf(alice), 100 ether);
        assertEq(taxed.balanceOf(address(taxedVault)), 0);
        assertEq(taxedVault.nextDepositId(), 1);
    }
}

contract RubaVaultWithdrawalsTest is RubaVaultFixture {
    function testWithdrawalPaysOnlyAccountAndEmitsEvent() public {
        _fundVault();
        RubaVault.Withdrawal memory request = _request(alice, address(usdt), 90e6, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        uint256 beforeBalance = usdt.balanceOf(alice);
        vm.expectEmit(true, true, true, true, address(vault));
        emit Withdrawn(alice, address(usdt), 90e6, 0, 1);
        vm.prank(alice);
        vault.withdraw(request, signature);
        assertEq(usdt.balanceOf(alice), beforeBalance + 90e6);
        assertEq(usdt.balanceOf(address(vault)), 910e6);
        assertTrue(vault.usedWithdrawalNonces(alice, 0));
    }

    function testWithdrawalRemainsAvailableAfterWhitelistRevocationAndMarketPause() public {
        _fundVault();
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 5 ether, 7);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        vault.setWhitelist(alice, false);
        vault.setMarketPaused(true);
        vm.prank(alice);
        vault.withdraw(request, signature);
        assertEq(ruba.balanceOf(address(vault)), 995 ether);
    }

    function testWithdrawalRejectsReplay() public {
        _fundVault();
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 3);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        vm.prank(alice);
        vault.withdraw(request, signature);
        vm.expectRevert(RubaVault.WithdrawalAlreadyUsed.selector);
        vm.prank(alice);
        vault.withdraw(request, signature);
    }

    function testWithdrawalNoncesAreScopedToAccount() public {
        _fundVault();
        RubaVault.Withdrawal memory first = _request(alice, address(ruba), 1 ether, 0);
        RubaVault.Withdrawal memory second = _request(bob, address(ruba), 1 ether, 0);
        bytes memory firstSignature = _sign(vault, first, OPERATOR_KEY);
        bytes memory secondSignature = _sign(vault, second, OPERATOR_KEY);
        vm.prank(alice);
        vault.withdraw(first, firstSignature);
        vm.prank(bob);
        vault.withdraw(second, secondSignature);
        assertEq(ruba.balanceOf(bob), 1 ether);
    }

    function testWithdrawalRejectsDifferentCaller() public {
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        vm.expectRevert(RubaVault.UnauthorizedAccount.selector);
        vm.prank(bob);
        vault.withdraw(request, signature);
    }

    function testWithdrawalRejectsWrongSigner() public {
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory signature = _sign(vault, request, 0xb0b);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(request, signature);
    }

    function testWithdrawalRejectsTamperedAmount() public {
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        request.amount += 1;
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(request, signature);
    }

    function testWithdrawalRejectsTamperedToken() public {
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        request.token = address(usdt);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(request, signature);
    }

    function testWithdrawalRejectsTamperedAccount() public {
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        request.account = bob;
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vm.prank(bob);
        vault.withdraw(request, signature);
    }

    function testWithdrawalRejectsTamperedNonceAndDeadline() public {
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        request.nonce = 1;
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(request, signature);
        request.nonce = 0;
        request.deadline += 1;
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(request, signature);
    }

    function testWithdrawalRejectsDifferentChain() public {
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(request, signature);
    }

    function testWithdrawalRejectsDifferentVault() public {
        RubaVault secondVault = new RubaVault(address(ruba), address(usdt), address(this), operator);
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vm.prank(alice);
        secondVault.withdraw(request, signature);
    }

    function testWithdrawalRejectsExpiredZeroAndUnknownToken() public {
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        request.deadline = block.timestamp - 1;
        vm.expectRevert(RubaVault.ExpiredWithdrawal.selector);
        vm.prank(alice);
        vault.withdraw(request, "");
        request.deadline = block.timestamp + 1;
        request.amount = 0;
        vm.expectRevert(RubaVault.InvalidAmount.selector);
        vm.prank(alice);
        vault.withdraw(request, "");
        request.amount = 1;
        request.token = address(0xbeef);
        vm.expectRevert(RubaVault.UnsupportedToken.selector);
        vm.prank(alice);
        vault.withdraw(request, "");
    }

    function testWithdrawalDeadlineIsInclusive() public {
        _fundVault();
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        request.deadline = block.timestamp;
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        vm.prank(alice);
        vault.withdraw(request, signature);
    }

    function testOperatorRotationInvalidatesOldTicketsAndAcceptsNewEpoch() public {
        _fundVault();
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory oldSignature = _sign(vault, request, OPERATOR_KEY);
        uint256 nextKey = 0xcafe;
        vault.setOperator(vm.addr(nextKey));
        assertEq(vault.signerEpoch(), 2);
        vm.expectRevert(RubaVault.InvalidSignerEpoch.selector);
        vm.prank(alice);
        vault.withdraw(request, oldSignature);
        request.signerEpoch = 2;
        bytes memory newSignature = _sign(vault, request, nextKey);
        vm.prank(alice);
        vault.withdraw(request, newSignature);
    }

    function testFrozenUsdtDoesNotPreventRubaWithdrawal() public {
        _fundVault();
        usdt.setBlacklisted(address(vault), true);
        RubaVault.Withdrawal memory frozen = _request(alice, address(usdt), 10e6, 0);
        bytes memory frozenSignature = _sign(vault, frozen, OPERATOR_KEY);
        vm.expectRevert();
        vm.prank(alice);
        vault.withdraw(frozen, frozenSignature);
        assertFalse(vault.usedWithdrawalNonces(alice, 0));

        RubaVault.Withdrawal memory healthy = _request(alice, address(ruba), 10 ether, 1);
        bytes memory healthySignature = _sign(vault, healthy, OPERATOR_KEY);
        vm.prank(alice);
        vault.withdraw(healthy, healthySignature);
        assertTrue(vault.usedWithdrawalNonces(alice, 1));
        assertEq(usdt.balanceOf(address(vault)), 1000e6);
    }

    function testTokenWithdrawalPauseIsIndependentAndReversible() public {
        _fundVault();
        RubaVault.Withdrawal memory request = _request(alice, address(usdt), 10e6, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        vault.setTokenWithdrawalsPaused(address(usdt), true);
        vm.expectRevert(RubaVault.TokenWithdrawalsPaused.selector);
        vm.prank(alice);
        vault.withdraw(request, signature);
        assertFalse(vault.withdrawalsPaused(address(ruba)));
        vault.setTokenWithdrawalsPaused(address(usdt), false);
        vm.prank(alice);
        vault.withdraw(request, signature);
    }

    function testInsufficientCustodyRollsBackNonce() public {
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), 1 ether, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        vm.expectRevert();
        vm.prank(alice);
        vault.withdraw(request, signature);
        assertFalse(vault.usedWithdrawalNonces(alice, 0));
    }

    function testFuzzDepositWithdrawCustodyConservation(uint128 amountSeed, uint128 withdrawalSeed) public {
        uint256 amount = bound(uint256(amountSeed), 1, 1_000_000 ether);
        uint256 withdrawalAmount = bound(uint256(withdrawalSeed), 1, amount);
        vm.prank(alice);
        vault.deposit(address(ruba), amount);
        RubaVault.Withdrawal memory request = _request(alice, address(ruba), withdrawalAmount, 0);
        bytes memory signature = _sign(vault, request, OPERATOR_KEY);
        vm.prank(alice);
        vault.withdraw(request, signature);
        assertEq(ruba.balanceOf(address(vault)), amount - withdrawalAmount);
        assertEq(ruba.balanceOf(alice) + ruba.balanceOf(address(vault)), 1_000_000 ether);
    }
}

contract RubaVaultAdministrationTest is RubaVaultFixture {
    function testOwnerControlsRequireOwner() public {
        vm.startPrank(alice);
        vm.expectRevert();
        vault.setWhitelist(bob, false);
        vm.expectRevert();
        vault.setMarketPaused(true);
        vm.expectRevert();
        vault.setTokenWithdrawalsPaused(address(usdt), true);
        vm.expectRevert();
        vault.setOperator(bob);
        vm.stopPrank();
    }

    function testOwnerTransferRequiresAcceptance() public {
        vault.transferOwnership(bob);
        assertEq(vault.owner(), address(this));
        assertEq(vault.pendingOwner(), bob);
        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);
    }

    function testConfigurationRejectsInvalidAddressesAndTokens() public {
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        vault.setOperator(address(0));
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        vault.setOperator(address(ruba));
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        vault.setWhitelist(address(0), true);
        vm.expectRevert(RubaVault.UnsupportedToken.selector);
        vault.setTokenWithdrawalsPaused(address(0xbeef), true);
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        new RubaVault(address(ruba), address(ruba), address(this), operator);
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        new RubaVault(address(0), address(usdt), address(this), operator);
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        new RubaVault(alice, address(usdt), address(this), operator);
    }
}

contract RubaVaultBatchesTest is RubaVaultFixture {
    function testIncompleteBatchRejectsWithoutAdvancingState() public {
        RubaVault.Batch memory batch = _batch(1, bytes32(0), keccak256("state1"), keccak256("root1"), 1);
        for (uint256 count = 1; count < 4; ++count) {
            batch.tradeCount = count;
            _expectInvalidBatch(batch);
            assertEq(vault.lastBatchId(), 0);
            assertEq(vault.lastTradeId(), 0);
            assertEq(vault.stateRoot(), bytes32(0));
            (,,,,, uint256 storedCount) = vault.batches(1);
            assertEq(storedCount, 0);
        }
        batch.tradeCount = 4;
        vm.prank(operator);
        vault.publishBatch(batch);
        assertEq(vault.lastBatchId(), 1);
        assertEq(vault.lastTradeId(), 4);
        assertEq(vault.stateRoot(), batch.newStateRoot);
    }

    function testIncompleteNextBatchDoesNotConsumeItsIdOrChangePreviousRoot() public {
        RubaVault.Batch memory first = _batch(1, bytes32(0), keccak256("state1"), keccak256("root1"), 1);
        vm.prank(operator);
        vault.publishBatch(first);
        RubaVault.Batch memory second =
            _batch(2, first.newStateRoot, keccak256("state2"), keccak256("root2"), 5);
        for (uint256 count = 1; count < 4; ++count) {
            second.tradeCount = count;
            _expectInvalidBatch(second);
            assertEq(vault.lastBatchId(), 1);
            assertEq(vault.lastTradeId(), 4);
            assertEq(vault.stateRoot(), first.newStateRoot);
        }
        second.tradeCount = 4;
        vm.prank(operator);
        vault.publishBatch(second);
        assertEq(vault.lastBatchId(), 2);
        assertEq(vault.lastTradeId(), 8);
        assertEq(vault.stateRoot(), second.newStateRoot);
    }

    function testFourTradeBatchesAreContiguousAndCannotOverlapOrSkipTrades() public {
        assertEq(vault.MIN_TRADES_PER_BATCH(), 4);
        assertEq(vault.MAX_TRADES_PER_BATCH(), 4);
        assertEq(vault.TRADES_PER_BATCH(), 4);
        bytes32 previous;
        uint256 firstTrade = 1;
        for (uint256 batchId = 1; batchId <= 4; ++batchId) {
            RubaVault.Batch memory batch = _batch(
                batchId,
                previous,
                keccak256(abi.encode("state", batchId)),
                keccak256(abi.encode("receipts", batchId)),
                firstTrade
            );
            batch.firstTradeId = firstTrade + 1;
            _expectInvalidBatch(batch);
            if (firstTrade > 1) {
                batch.firstTradeId = firstTrade - 1;
                _expectInvalidBatch(batch);
            }
            batch.firstTradeId = firstTrade;
            vm.prank(operator);
            vault.publishBatch(batch);
            _expectInvalidBatch(batch);

            assertEq(vault.lastBatchId(), batchId);
            assertEq(vault.lastTradeId(), firstTrade + 3);
            (, bytes32 storedPrevious, bytes32 storedNext,, uint256 storedFirst, uint256 storedCount) =
                vault.batches(batchId);
            assertEq(storedPrevious, previous);
            assertEq(storedNext, batch.newStateRoot);
            assertEq(storedFirst, firstTrade);
            assertEq(storedCount, 4);
            previous = batch.newStateRoot;
            firstTrade += 4;
        }
        assertEq(vault.lastTradeId(), 16);
    }

    function testReceiptProofRequiresTwoSiblingsAndCannotUseAnInternalNodeAsALeaf() public {
        bytes32[4] memory leaves = [keccak256("one"), keccak256("two"), keccak256("three"), keccak256("four")];
        bytes32 left = _hashPair(leaves[0], leaves[1]);
        bytes32 right = _hashPair(leaves[2], leaves[3]);
        RubaVault.Batch memory batch = _batch(1, bytes32(0), keccak256("state1"), _hashPair(left, right), 1);
        vm.prank(operator);
        vault.publishBatch(batch);

        assertFalse(vault.verifyReceipt(1, batch.receiptsRoot, new bytes32[](0)));
        bytes32[] memory shortProof = new bytes32[](1);
        shortProof[0] = right;
        assertFalse(vault.verifyReceipt(1, left, shortProof));
        assertFalse(vault.verifyReceipt(1, leaves[0], new bytes32[](3)));

        bytes32[] memory proof = new bytes32[](2);
        proof[0] = leaves[1];
        proof[1] = right;
        assertTrue(vault.verifyReceipt(1, leaves[0], proof));
        proof[0] = keccak256("wrong sibling");
        assertFalse(vault.verifyReceipt(1, leaves[0], proof));
        proof[0] = leaves[1];
        proof[1] = left;
        assertFalse(vault.verifyReceipt(1, leaves[0], proof));
    }

    function testBatchPublishesFourReceiptsAndVerifiesEveryLeaf() public {
        bytes32[4] memory leaves = [keccak256("one"), keccak256("two"), keccak256("three"), keccak256("four")];
        bytes32 left = _hashPair(leaves[0], leaves[1]);
        bytes32 right = _hashPair(leaves[2], leaves[3]);
        RubaVault.Batch memory batch = _batch(1, bytes32(0), keccak256("state1"), _hashPair(left, right), 1);
        vm.prank(operator);
        vault.publishBatch(batch);
        assertEq(vault.stateRoot(), batch.newStateRoot);
        assertEq(vault.lastBatchId(), 1);
        assertEq(vault.lastTradeId(), 4);
        for (uint256 i; i < 4; ++i) {
            bytes32[] memory proof = new bytes32[](2);
            proof[0] = leaves[i ^ 1];
            proof[1] = i < 2 ? right : left;
            assertTrue(vault.verifyReceipt(1, leaves[i], proof));
            assertFalse(vault.verifyReceipt(1, keccak256("forged"), proof));
        }
    }

    function testBatchesAreChainedAndCannotBeOverwritten() public {
        RubaVault.Batch memory first = _batch(1, bytes32(0), keccak256("state1"), keccak256("root1"), 1);
        vm.prank(operator);
        vault.publishBatch(first);
        vm.expectRevert(RubaVault.InvalidBatch.selector);
        vm.prank(operator);
        vault.publishBatch(first);
        RubaVault.Batch memory second =
            _batch(2, first.newStateRoot, keccak256("state2"), keccak256("root2"), 5);
        vm.prank(operator);
        vault.publishBatch(second);
        assertEq(vault.lastTradeId(), 8);
        assertEq(vault.stateRoot(), second.newStateRoot);
        (, bytes32 previousRoot, bytes32 newRoot, bytes32 receiptsRoot, uint256 firstTrade, uint256 count) =
            vault.batches(1);
        assertEq(previousRoot, bytes32(0));
        assertEq(newRoot, first.newStateRoot);
        assertEq(receiptsRoot, first.receiptsRoot);
        assertEq(firstTrade, 1);
        assertEq(count, 4);
    }

    function testBatchRejectsUnauthorizedPublisherAndInvalidShape() public {
        RubaVault.Batch memory batch = _batch(1, bytes32(0), keccak256("state"), keccak256("root"), 1);
        vm.expectRevert(RubaVault.UnauthorizedOperator.selector);
        vm.prank(alice);
        vault.publishBatch(batch);
        batch.tradeCount = 0;
        _expectInvalidBatch(batch);
        batch.tradeCount = 5;
        _expectInvalidBatch(batch);
        batch.tradeCount = 4;
        batch.previousStateRoot = keccak256("wrong previous");
        _expectInvalidBatch(batch);
        batch.previousStateRoot = bytes32(0);
        batch.firstTradeId = 2;
        _expectInvalidBatch(batch);
        batch.firstTradeId = 1;
        batch.batchId = 2;
        _expectInvalidBatch(batch);
        batch.batchId = 1;
        batch.receiptsRoot = bytes32(0);
        _expectInvalidBatch(batch);
        batch.receiptsRoot = keccak256("root");
        batch.newStateRoot = bytes32(0);
        _expectInvalidBatch(batch);
    }

    function testUnpublishedAndWrongDepthReceiptProofsFail() public view {
        bytes32[] memory proof = new bytes32[](2);
        assertFalse(vault.verifyReceipt(0, bytes32(0), proof));
        assertFalse(vault.verifyReceipt(1, bytes32(0), proof));
    }
}

contract RubaVaultSignedBatchesTest is RubaVaultFixture {
    event BatchPublished(
        uint256 indexed batchId,
        bytes32 previousStateRoot,
        bytes32 newStateRoot,
        bytes32 receiptsRoot,
        uint256 firstTradeId,
        uint256 tradeCount
    );

    function _firstBatch() internal pure returns (RubaVault.Batch memory) {
        return _batch(1, bytes32(0), keccak256("state1"), keccak256("receipts1"), 1);
    }

    function _signBatch(
        RubaVault target,
        RubaVault.Batch memory batch,
        uint256 deadline,
        uint256 epoch,
        uint256 key
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, target.batchPublicationDigest(batch, deadline, epoch));
        return abi.encodePacked(r, s, v);
    }

    function _expectInvalidSignedBatch(RubaVault.Batch memory batch) internal {
        uint256 deadline = block.timestamp + 3600;
        uint256 epoch = vault.signerEpoch();
        bytes memory signature = _signBatch(vault, batch, deadline, epoch, OPERATOR_KEY);
        vm.expectRevert(RubaVault.InvalidBatch.selector);
        vault.publishSignedBatch(batch, deadline, epoch, signature);
    }

    function testUnlistedPayerPublishesWithoutMovingTokensOrFundingOperator() public {
        _fundVault();
        address payer = makeAddr("batch payer");
        vm.deal(payer, 1 ether);
        vm.deal(operator, 0);
        assertFalse(vault.whitelist(payer));
        vault.setMarketPaused(true);
        vault.setTokenWithdrawalsPaused(address(ruba), true);
        vault.setTokenWithdrawalsPaused(address(usdt), true);

        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, batch, deadline, 1, OPERATOR_KEY);
        vm.expectEmit(true, false, false, true, address(vault));
        emit BatchPublished(1, bytes32(0), batch.newStateRoot, batch.receiptsRoot, 1, 4);
        vm.prank(payer);
        vault.publishSignedBatch(batch, deadline, 1, signature);

        assertEq(vault.lastBatchId(), 1);
        assertEq(vault.lastTradeId(), 4);
        assertEq(vault.stateRoot(), batch.newStateRoot);
        assertEq(ruba.balanceOf(address(vault)), 1000 ether);
        assertEq(usdt.balanceOf(address(vault)), 1000e6);
        assertEq(ruba.balanceOf(payer), 0);
        assertEq(usdt.balanceOf(payer), 0);
        assertEq(ruba.balanceOf(operator), 0);
        assertEq(usdt.balanceOf(operator), 0);
        assertEq(operator.balance, 0);
        assertEq(vault.nextDepositId(), 3);
    }

    function testBatchDigestMatchesExactEip712SchemaAndDomain() public view {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes32 typeHash = keccak256(
            "BatchPublication(uint256 batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount,uint256 deadline,uint256 signerEpoch)"
        );
        assertEq(vault.PUBLISH_BATCH_TYPEHASH(), typeHash);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("RubaVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                batch.batchId,
                batch.previousStateRoot,
                batch.newStateRoot,
                batch.receiptsRoot,
                batch.firstTradeId,
                batch.tradeCount,
                deadline,
                uint256(1)
            )
        );
        assertEq(
            vault.batchPublicationDigest(batch, deadline, 1),
            keccak256(abi.encodePacked(hex"1901", domain, structHash))
        );
    }

    function testSignedBatchRejectsAnotherSigner() public {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, batch, deadline, 1, 0xb0b);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vault.publishSignedBatch(batch, deadline, 1, signature);
        assertEq(vault.lastBatchId(), 0);
    }

    function testSignedBatchRejectsMalformedSignature() public {
        RubaVault.Batch memory batch = _firstBatch();
        vm.expectRevert();
        vault.publishSignedBatch(batch, block.timestamp + 3600, 1, hex"1234");
        assertEq(vault.lastBatchId(), 0);
    }

    function testSignedBatchExpiresWithoutConsumingTheBatch() public {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, batch, deadline, 1, OPERATOR_KEY);
        vm.warp(deadline + 1);
        vm.expectRevert(RubaVault.ExpiredBatchPublication.selector);
        vault.publishSignedBatch(batch, deadline, 1, signature);
        assertEq(vault.lastBatchId(), 0);
        assertEq(vault.lastTradeId(), 0);
        assertEq(vault.stateRoot(), bytes32(0));

        deadline = block.timestamp + 3600;
        signature = _signBatch(vault, batch, deadline, 1, OPERATOR_KEY);
        vault.publishSignedBatch(batch, deadline, 1, signature);
        assertEq(vault.lastBatchId(), 1);
    }

    function testSignedBatchDeadlineIsInclusive() public {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, batch, deadline, 1, OPERATOR_KEY);
        vm.warp(deadline);
        vault.publishSignedBatch(batch, deadline, 1, signature);
        assertEq(vault.lastBatchId(), 1);
    }

    function testRotationRevokesOldEpochAndOldSigner() public {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory oldSignature = _signBatch(vault, batch, deadline, 1, OPERATOR_KEY);
        uint256 nextOperatorKey = 0xb0b;
        vault.setOperator(vm.addr(nextOperatorKey));
        vm.expectRevert(RubaVault.InvalidSignerEpoch.selector);
        vault.publishSignedBatch(batch, deadline, 1, oldSignature);

        bytes memory wrongSigner = _signBatch(vault, batch, deadline, 2, OPERATOR_KEY);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vault.publishSignedBatch(batch, deadline, 2, wrongSigner);
        bytes memory newSignature = _signBatch(vault, batch, deadline, 2, nextOperatorKey);
        vault.publishSignedBatch(batch, deadline, 2, newSignature);
        assertEq(vault.lastBatchId(), 1);
    }

    function testEpochInvalidatesOldAuthorizationEvenIfOperatorAddressIsUnchanged() public {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, batch, deadline, 1, OPERATOR_KEY);
        vault.setOperator(operator);
        vm.expectRevert(RubaVault.InvalidSignerEpoch.selector);
        vault.publishSignedBatch(batch, deadline, 1, signature);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vault.publishSignedBatch(batch, deadline, 2, signature);
    }

    function testSignedBatchCannotBeReplayedOnAnotherVault() public {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, batch, deadline, 1, OPERATOR_KEY);
        RubaVault otherVault = new RubaVault(address(ruba), address(usdt), address(this), operator);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        otherVault.publishSignedBatch(batch, deadline, 1, signature);
        assertEq(otherVault.lastBatchId(), 0);
        assertEq(vault.lastBatchId(), 0);
    }

    function testSignedBatchCannotBeReplayedOnAnotherChain() public {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, batch, deadline, 1, OPERATOR_KEY);
        uint256 originalChainId = block.chainid;
        vm.chainId(originalChainId + 1);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vault.publishSignedBatch(batch, deadline, 1, signature);
        assertEq(vault.lastBatchId(), 0);
        vm.chainId(originalChainId);
        vault.publishSignedBatch(batch, deadline, 1, signature);
        assertEq(vault.lastBatchId(), 1);
    }

    function testChangingAnyBatchFieldInvalidatesOperatorSignature() public {
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, _firstBatch(), deadline, 1, OPERATOR_KEY);
        for (uint256 field; field < 6; ++field) {
            RubaVault.Batch memory changed = _firstBatch();
            if (field == 0) changed.batchId = 2;
            else if (field == 1) changed.previousStateRoot = keccak256("changed previous");
            else if (field == 2) changed.newStateRoot = keccak256("changed state");
            else if (field == 3) changed.receiptsRoot = keccak256("changed receipts");
            else if (field == 4) changed.firstTradeId = 2;
            else changed.tradeCount = 3;
            vm.expectRevert(RubaVault.InvalidSignature.selector);
            vault.publishSignedBatch(changed, deadline, 1, signature);
            assertEq(vault.lastBatchId(), 0);
        }
    }

    function testChangingDeadlineInvalidatesOperatorSignature() public {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, batch, deadline, 1, OPERATOR_KEY);
        vm.expectRevert(RubaVault.InvalidSignature.selector);
        vault.publishSignedBatch(batch, deadline + 1, 1, signature);
    }

    function testCorrectlySignedWrongEpochIsRejected() public {
        RubaVault.Batch memory batch = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, batch, deadline, 2, OPERATOR_KEY);
        vm.expectRevert(RubaVault.InvalidSignerEpoch.selector);
        vault.publishSignedBatch(batch, deadline, 2, signature);
    }

    function testEvenOperatorSignatureCannotPublishIncompleteOrOversizedBatch() public {
        for (uint256 count; count <= 5; ++count) {
            if (count == 4) continue;
            RubaVault.Batch memory batch = _firstBatch();
            batch.tradeCount = count;
            _expectInvalidSignedBatch(batch);
            assertEq(vault.lastBatchId(), 0);
            assertEq(vault.lastTradeId(), 0);
        }
        RubaVault.Batch memory valid = _firstBatch();
        bytes memory signature = _signBatch(vault, valid, block.timestamp + 3600, 1, OPERATOR_KEY);
        vault.publishSignedBatch(valid, block.timestamp + 3600, 1, signature);
        assertEq(vault.lastTradeId(), 4);
    }

    function testEvenOperatorSignatureCannotPublishZeroRoots() public {
        RubaVault.Batch memory batch = _firstBatch();
        batch.newStateRoot = bytes32(0);
        _expectInvalidSignedBatch(batch);
        batch = _firstBatch();
        batch.receiptsRoot = bytes32(0);
        _expectInvalidSignedBatch(batch);
        assertEq(vault.lastBatchId(), 0);
    }

    function testSignedBatchesRequireOrderAndContiguousNonoverlappingTrades() public {
        uint256 deadline = block.timestamp + 3600;
        RubaVault.Batch memory first = _firstBatch();
        RubaVault.Batch memory second =
            _batch(2, first.newStateRoot, keccak256("state2"), keccak256("receipts2"), 5);
        bytes memory secondSignature = _signBatch(vault, second, deadline, 1, OPERATOR_KEY);
        vm.expectRevert(RubaVault.InvalidBatch.selector);
        vault.publishSignedBatch(second, deadline, 1, secondSignature);
        bytes memory firstSignature = _signBatch(vault, first, deadline, 1, OPERATOR_KEY);
        vault.publishSignedBatch(first, deadline, 1, firstSignature);

        second.firstTradeId = 4;
        _expectInvalidSignedBatch(second);
        second.firstTradeId = 6;
        _expectInvalidSignedBatch(second);
        second.firstTradeId = 5;
        second.previousStateRoot = bytes32(0);
        _expectInvalidSignedBatch(second);
        second.previousStateRoot = first.newStateRoot;
        second.batchId = 3;
        _expectInvalidSignedBatch(second);
        second.batchId = 2;
        vault.publishSignedBatch(second, deadline, 1, secondSignature);
        assertEq(vault.lastBatchId(), 2);
        assertEq(vault.lastTradeId(), 8);
        assertEq(vault.stateRoot(), second.newStateRoot);
    }

    function testSignedAndLegacyPublicationsShareReplayAndSequenceGuards() public {
        RubaVault.Batch memory first = _firstBatch();
        uint256 deadline = block.timestamp + 3600;
        bytes memory signature = _signBatch(vault, first, deadline, 1, OPERATOR_KEY);
        vm.prank(alice);
        vault.publishSignedBatch(first, deadline, 1, signature);
        vm.expectRevert(RubaVault.InvalidBatch.selector);
        vm.prank(bob);
        vault.publishSignedBatch(first, deadline, 1, signature);
        _expectInvalidBatch(first);

        RubaVault.Batch memory second =
            _batch(2, first.newStateRoot, keccak256("state2"), keccak256("receipts2"), 5);
        vm.prank(operator);
        vault.publishBatch(second);
        _expectInvalidSignedBatch(second);
        (, bytes32 storedPrevious, bytes32 storedNext, bytes32 receipts, uint256 firstId, uint256 count) =
            vault.batches(1);
        assertEq(storedPrevious, bytes32(0));
        assertEq(storedNext, first.newStateRoot);
        assertEq(receipts, first.receiptsRoot);
        assertEq(firstId, 1);
        assertEq(count, 4);
        assertEq(vault.lastBatchId(), 2);
        assertEq(vault.lastTradeId(), 8);
    }
}

contract RubaVaultReentrancyTest is RubaVaultFixture {
    function testDepositAndWithdrawalBlockTokenReentrancy() public {
        ReentrantToken hooked = new ReentrantToken();
        RubaVault hookedVault = new RubaVault(address(hooked), address(usdt), address(this), operator);
        hookedVault.setWhitelist(alice, true);
        hooked.mint(alice, 10 ether);
        hooked.setCallback(
            address(hookedVault), abi.encodeCall(RubaVault.deposit, (address(hooked), 1)), true, true
        );
        vm.startPrank(alice);
        hooked.approve(address(hookedVault), 10 ether);
        hookedVault.deposit(address(hooked), 10 ether);
        vm.stopPrank();
        assertFalse(hooked.callbackSucceeded());
        assertEq(bytes4(hooked.callbackError()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        RubaVault.Withdrawal memory request = RubaVault.Withdrawal({
            account: alice,
            token: address(hooked),
            amount: 5 ether,
            nonce: 0,
            deadline: block.timestamp + 100,
            signerEpoch: 1
        });
        bytes memory signature = _sign(hookedVault, request, OPERATOR_KEY);
        vm.prank(alice);
        hookedVault.withdraw(request, signature);
        assertFalse(hooked.callbackSucceeded());
        assertEq(bytes4(hooked.callbackError()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(hooked.balanceOf(alice), 5 ether);
    }
}
