// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RubaVault} from "../src/RubaVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

contract PauseGuardiansTest is Test {
    RubaVault internal vault;
    MockERC20 internal ruba;
    MockUSDT internal usdt;
    address internal admin;
    address internal guardian;
    address internal bot;
    address internal stranger;
    address internal alice;

    function setUp() public {
        admin = makeAddr("admin role");
        guardian = makeAddr("guardian role");
        bot = makeAddr("monitor bot");
        stranger = makeAddr("stranger");
        alice = makeAddr("alice");
        ruba = new MockERC20("Mock RUBA", "RUBA", 18);
        usdt = new MockUSDT();
        vault = new RubaVault(address(ruba), address(usdt), address(this), makeAddr("operator"));
        vault.setWhitelist(alice, true);
        ruba.mint(alice, 1000 ether);
        vm.prank(alice);
        ruba.approve(address(vault), type(uint256).max);
    }

    function _roles() internal view returns (address[3] memory roles) {
        roles[0] = admin;
        roles[1] = guardian;
        roles[2] = bot;
    }

    function _configure(uint256 delay) internal {
        vault.setPauseGuardians(_roles(), delay);
    }

    function testOwnerKeepsOldBehaviourBeforeGuardiansAreSet() public {
        vault.setMarketPaused(true);
        assertTrue(vault.marketPaused());
        vault.setMarketPaused(false);
        assertFalse(vault.marketPaused());
        vault.setTokenWithdrawalsPaused(address(usdt), true);
        vault.setTokenWithdrawalsPaused(address(usdt), false);
        assertFalse(vault.withdrawalsPaused(address(usdt)));

        vm.prank(stranger);
        vm.expectRevert(RubaVault.UnauthorizedPauser.selector);
        vault.setMarketPaused(true);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.setMarketPaused(false);
    }

    function testGuardianSetupIsOneTimeAndOwnerOnly() public {
        address[3] memory roles = _roles();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.setPauseGuardians(roles, 0);

        roles[2] = address(0);
        vm.expectRevert(RubaVault.InvalidPauseGuardians.selector);
        vault.setPauseGuardians(roles, 0);
        roles[2] = admin;
        vm.expectRevert(RubaVault.InvalidPauseGuardians.selector);
        vault.setPauseGuardians(roles, 0);
        vm.expectRevert(RubaVault.InvalidPauseGuardians.selector);
        vault.setPauseGuardians(_roles(), 8 days);

        _configure(1 hours);
        assertTrue(vault.pauseGuardiansConfigured());
        assertEq(vault.resumeDelay(), 1 hours);
        assertTrue(vault.isPauseGuardian(bot));
        assertFalse(vault.isPauseGuardian(stranger));
        assertEq(vault.pauseGuardians()[1], guardian);
        vm.expectRevert(RubaVault.PauseGuardiansAlreadyConfigured.selector);
        _configure(0);
    }

    function testAnyRolePausesButStrangerCannot() public {
        _configure(0);
        vm.prank(bot);
        vault.setMarketPaused(true);
        assertTrue(vault.marketPaused());

        vm.prank(guardian);
        vault.setTokenWithdrawalsPaused(address(ruba), true);
        assertTrue(vault.withdrawalsPaused(address(ruba)));
        assertFalse(vault.withdrawalsPaused(address(usdt)));

        vault.setTokenWithdrawalsPaused(address(usdt), true);
        assertTrue(vault.withdrawalsPaused(address(usdt)));

        vm.prank(stranger);
        vm.expectRevert(RubaVault.UnauthorizedPauser.selector);
        vault.setMarketPaused(true);
    }

    function testOwnerAndSingleGuardianCannotResume() public {
        _configure(0);
        vm.prank(admin);
        vault.setMarketPaused(true);

        vm.expectRevert(RubaVault.ResumeRequiresGuardians.selector);
        vault.setMarketPaused(false);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vault.setMarketPaused(false);

        vm.prank(admin);
        vault.approveMarketResume();
        assertTrue(vault.marketPaused());
        (, uint256 approvals,) = vault.marketResumeStatus();
        assertEq(approvals, 1);

        vm.prank(admin);
        vm.expectRevert(RubaVault.ResumeAlreadyApproved.selector);
        vault.approveMarketResume();
        vm.prank(stranger);
        vm.expectRevert(RubaVault.UnauthorizedGuardian.selector);
        vault.approveMarketResume();
        vm.expectRevert(RubaVault.UnauthorizedGuardian.selector);
        vault.approveMarketResume();
    }

    function testTwoGuardiansResumeWithoutDelay() public {
        _configure(0);
        vm.prank(bot);
        vault.setMarketPaused(true);
        vm.prank(admin);
        vault.approveMarketResume();
        vm.prank(guardian);
        vault.approveMarketResume();
        assertFalse(vault.marketPaused());

        vm.prank(alice);
        vault.deposit(address(ruba), 1 ether);

        vm.prank(guardian);
        vm.expectRevert(RubaVault.NothingToResume.selector);
        vault.approveMarketResume();
    }

    function testResumeWaitsForTimelockAndAnyoneExecutes() public {
        _configure(1 hours);
        vm.prank(bot);
        vault.setMarketPaused(true);
        vm.prank(admin);
        vault.approveMarketResume();
        vm.prank(guardian);
        vault.approveMarketResume();
        assertTrue(vault.marketPaused());
        (, uint256 approvals, uint256 readyAt) = vault.marketResumeStatus();
        assertEq(approvals, 2);
        assertEq(readyAt, block.timestamp + 1 hours);

        vm.expectRevert(RubaVault.ResumeNotReady.selector);
        vault.executeMarketResume();
        vm.warp(readyAt);
        vm.prank(stranger);
        vault.executeMarketResume();
        assertFalse(vault.marketPaused());
    }

    function testNewPauseCancelsCollectedApprovals() public {
        _configure(1 hours);
        vm.prank(bot);
        vault.setMarketPaused(true);
        (uint256 firstRound,,) = vault.marketResumeStatus();
        vm.prank(admin);
        vault.approveMarketResume();
        vm.prank(guardian);
        vault.approveMarketResume();

        vm.prank(bot);
        vault.setMarketPaused(true);
        (uint256 round, uint256 approvals, uint256 readyAt) = vault.marketResumeStatus();
        assertEq(round, firstRound + 1);
        assertEq(approvals, 0);
        assertEq(readyAt, 0);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(RubaVault.ResumeNotReady.selector);
        vault.executeMarketResume();
        assertTrue(vault.marketPaused());
    }

    function testTokenWithdrawalResumeIsSeparatePerToken() public {
        _configure(0);
        vm.prank(bot);
        vault.setTokenWithdrawalsPaused(address(ruba), true);
        vm.prank(bot);
        vault.setTokenWithdrawalsPaused(address(usdt), true);

        vm.expectRevert(RubaVault.ResumeRequiresGuardians.selector);
        vault.setTokenWithdrawalsPaused(address(usdt), false);

        vm.prank(admin);
        vault.approveTokenWithdrawalsResume(address(usdt));
        vm.prank(bot);
        vault.approveTokenWithdrawalsResume(address(usdt));
        assertFalse(vault.withdrawalsPaused(address(usdt)));
        assertTrue(vault.withdrawalsPaused(address(ruba)));
        (, uint256 rubaApprovals,) = vault.tokenWithdrawalsResumeStatus(address(ruba));
        assertEq(rubaApprovals, 0);

        vm.prank(admin);
        vm.expectRevert(RubaVault.UnsupportedToken.selector);
        vault.approveTokenWithdrawalsResume(address(0xbeef));
    }

    function testRotationNeedsTwoGuardiansAndDropsPendingApprovals() public {
        _configure(1 hours);
        address replacement = makeAddr("new guardian");
        vm.prank(bot);
        vault.setMarketPaused(true);
        vm.prank(admin);
        vault.approveMarketResume();
        vm.prank(bot);
        vault.approveMarketResume();

        vm.prank(admin);
        vault.approveGuardianRotation(1, replacement);
        assertEq(vault.pauseGuardians()[1], guardian);
        vm.prank(admin);
        vm.expectRevert(RubaVault.RotationAlreadyApproved.selector);
        vault.approveGuardianRotation(1, replacement);
        vm.prank(stranger);
        vm.expectRevert(RubaVault.UnauthorizedGuardian.selector);
        vault.approveGuardianRotation(1, replacement);
        vm.prank(bot);
        vm.expectRevert(RubaVault.InvalidPauseGuardians.selector);
        vault.approveGuardianRotation(1, admin);

        vm.prank(bot);
        vault.approveGuardianRotation(1, replacement);
        assertEq(vault.pauseGuardians()[1], replacement);
        assertEq(vault.guardianEpoch(), 1);
        assertFalse(vault.isPauseGuardian(guardian));

        vm.prank(guardian);
        vm.expectRevert(RubaVault.UnauthorizedPauser.selector);
        vault.setMarketPaused(true);

        (, uint256 approvals, uint256 readyAt) = vault.marketResumeStatus();
        assertEq(approvals, 0);
        assertEq(readyAt, 0);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(RubaVault.ResumeNotReady.selector);
        vault.executeMarketResume();

        vm.prank(replacement);
        vault.approveMarketResume();
        vm.prank(admin);
        vault.approveMarketResume();
        vm.warp(block.timestamp + 1 hours);
        vault.executeMarketResume();
        assertFalse(vault.marketPaused());
    }

    function testRotationIsClosedBeforeSetup() public {
        vm.expectRevert(RubaVault.PauseGuardiansNotConfigured.selector);
        vault.approveGuardianRotation(0, stranger);
    }

    function testOwnershipCannotBeRenounced() public {
        vm.expectRevert(RubaVault.OwnershipRenounceDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), address(this));
    }

    function testPauseDoesNotTouchExistingBalances() public {
        vm.prank(alice);
        vault.deposit(address(ruba), 10 ether);
        _configure(0);
        vm.prank(bot);
        vault.setMarketPaused(true);
        vm.prank(alice);
        vm.expectRevert(RubaVault.MarketPaused.selector);
        vault.deposit(address(ruba), 1 ether);
        assertEq(ruba.balanceOf(address(vault)), 10 ether);
    }
}
