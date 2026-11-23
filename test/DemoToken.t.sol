// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {DemoToken} from "../src/DemoToken.sol";

contract DemoTokenTest is Test {
    DemoToken internal token;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint256 internal constant FAUCET = 10_000 ether;

    function setUp() public {
        token = new DemoToken("Demo RUBA", "RUBA", 18, address(this), FAUCET);
    }

    function testConstructorSetsMetadataOwnerAndFiniteFaucetWithoutInitialSupply() public view {
        assertEq(token.name(), "Demo RUBA");
        assertEq(token.symbol(), "RUBA");
        assertEq(token.decimals(), 18);
        assertEq(token.owner(), address(this));
        assertEq(token.FAUCET_AMOUNT(), FAUCET);
        assertEq(token.FAUCET_COOLDOWN(), 60);
        assertEq(token.MAX_FAUCET_AMOUNT(), type(uint96).max);
        assertEq(token.totalSupply(), 0);
        assertEq(token.nextFaucetAt(alice), 0);
    }

    function testAllFourDemoAssetsUseActualDecimalsAndIndependentFaucets() public {
        DemoToken usdt = new DemoToken("Demo USDT", "USDT", 6, address(this), 10_000e6);
        DemoToken weth = new DemoToken("Demo WETH", "WETH", 18, address(this), 10 ether);
        DemoToken wbtc = new DemoToken("Demo WBTC", "WBTC", 8, address(this), 1e8);
        vm.startPrank(alice);
        token.faucet();
        usdt.faucet();
        weth.faucet();
        wbtc.faucet();
        vm.stopPrank();
        assertEq(usdt.decimals(), 6);
        assertEq(weth.decimals(), 18);
        assertEq(wbtc.decimals(), 8);
        assertEq(token.balanceOf(alice), FAUCET);
        assertEq(usdt.balanceOf(alice), 10_000e6);
        assertEq(weth.balanceOf(alice), 10 ether);
        assertEq(wbtc.balanceOf(alice), 1e8);
    }

    function testConstructorRejectsUnsupportedDecimalsZeroOwnerAndInvalidFaucetBounds() public {
        vm.expectRevert(DemoToken.InvalidDecimals.selector);
        new DemoToken("Demo", "DEMO", 19, address(this), 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new DemoToken("Demo", "DEMO", 18, address(0), 1);
        vm.expectRevert(DemoToken.InvalidFaucetAmount.selector);
        new DemoToken("Demo", "DEMO", 18, address(this), 0);
        vm.expectRevert(DemoToken.InvalidFaucetAmount.selector);
        new DemoToken("Demo", "DEMO", 18, address(this), uint256(type(uint96).max) + 1);
        DemoToken boundary = new DemoToken("Demo boundary", "BOUND", 0, address(this), type(uint96).max);
        vm.prank(alice);
        assertEq(boundary.faucet(), type(uint96).max);
        assertEq(boundary.decimals(), 0);
    }

    function testOnlyOwnerCanMintBootstrapBalancesAndZeroRecipientIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        token.mint(alice, 123 ether);
        token.mint(bob, 123 ether);
        assertEq(token.balanceOf(bob), 123 ether);
        assertEq(token.balanceOf(alice), 0);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.mint(address(0), 1);
        assertEq(token.totalSupply(), 123 ether);
    }

    function testOwnershipTransferRequiresAcceptanceBeforeNewOwnerCanMint() public {
        token.transferOwnership(alice);
        assertEq(token.owner(), address(this));
        assertEq(token.pendingOwner(), alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        token.mint(alice, 1);
        vm.prank(alice);
        token.acceptOwnership();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        token.mint(bob, 1);
        vm.prank(alice);
        token.mint(bob, 2);
        assertEq(token.balanceOf(bob), 2);
    }

    function testFaucetIsSelfOnlyPermissionlessAndIndependentAcrossUsers() public {
        vm.prank(alice);
        uint256 amount = token.faucet();
        assertEq(amount, FAUCET);
        assertEq(token.balanceOf(alice), FAUCET);
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.balanceOf(address(this)), 0);
        vm.prank(bob);
        token.faucet();
        assertEq(token.balanceOf(bob), FAUCET);
        assertEq(token.totalSupply(), FAUCET * 2);
        assertEq(token.nextFaucetAt(alice), block.timestamp + 60);
        assertEq(token.nextFaucetAt(bob), block.timestamp + 60);
    }

    function testFirstFaucetAtTimestampZeroWorksAndCooldownAllowsExactSixtySecondBoundary() public {
        vm.warp(0);
        vm.prank(alice);
        token.faucet();
        assertEq(token.nextFaucetAt(alice), 60);
        vm.expectRevert(abi.encodeWithSelector(DemoToken.FaucetCooldown.selector, uint256(60)));
        vm.prank(alice);
        token.faucet();
        vm.warp(59);
        vm.expectRevert(abi.encodeWithSelector(DemoToken.FaucetCooldown.selector, uint256(60)));
        vm.prank(alice);
        token.faucet();
        assertEq(token.totalSupply(), FAUCET);
        vm.warp(60);
        vm.prank(alice);
        token.faucet();
        assertEq(token.totalSupply(), FAUCET * 2);
        assertEq(token.nextFaucetAt(alice), 120);
    }

    function testFaucetStillWorksAfterOwnerRenouncesAndDoesNotRequireAnAdmin() public {
        token.renounceOwnership();
        vm.prank(alice);
        token.faucet();
        assertEq(token.balanceOf(alice), FAUCET);
        assertEq(token.owner(), address(0));
    }

    function testFuzzMintFaucetAndTransfersConserveSupply(uint96 bootstrapAmount, uint96 transferAmount)
        public
    {
        token.mint(alice, bootstrapAmount);
        vm.prank(alice);
        token.faucet();
        uint256 supply = uint256(bootstrapAmount) + FAUCET;
        uint256 moved = bound(uint256(transferAmount), 0, supply);
        vm.prank(alice);
        assertTrue(token.transfer(bob, moved));
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(alice) + token.balanceOf(bob), supply);
        assertEq(token.balanceOf(bob), moved);
    }

    function testFuzzCooldownDependsOnlyOnEachCallersLastSuccess(uint64 timestamp) public {
        vm.warp(timestamp);
        vm.prank(alice);
        token.faucet();
        vm.warp(uint256(timestamp) + 59);
        vm.expectRevert(abi.encodeWithSelector(DemoToken.FaucetCooldown.selector, uint256(timestamp) + 60));
        vm.prank(alice);
        token.faucet();
        vm.prank(bob);
        token.faucet();
        vm.warp(uint256(timestamp) + 60);
        vm.prank(alice);
        token.faucet();
        assertEq(token.balanceOf(alice), FAUCET * 2);
        assertEq(token.balanceOf(bob), FAUCET);
        assertEq(token.totalSupply(), FAUCET * 3);
    }
}
