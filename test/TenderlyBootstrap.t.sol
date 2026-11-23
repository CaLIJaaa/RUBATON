// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {RubaVault} from "../src/RubaVault.sol";
import {TenderlyBootstrap, TenderlyBootstrapVault} from "../script/TenderlyBootstrap.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

/// @dev Uses ordinary nested transfers/mints so an outer constructor revert also
/// rolls back the mock's effects. It implements the actual Tenderly selectors.
contract MockTenderlyVnet {
    function getStorageAt(address, bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function setBalance(address[] calldata accounts, uint256 amount) external returns (bool) {
        for (uint256 i; i < accounts.length; ++i) {
            if (accounts[i].balance < amount) {
                (bool sent,) = accounts[i].call{value: amount - accounts[i].balance}("");
                require(sent, "native funding failed");
            }
        }
        return true;
    }

    function setErc20Balance(address token, address[] calldata accounts, uint256 amount)
        external
        returns (bool)
    {
        for (uint256 i; i < accounts.length; ++i) {
            uint256 balance = MockUSDT(token).balanceOf(accounts[i]);
            if (balance < amount) MockUSDT(token).mint(accounts[i], amount - balance);
        }
        return true;
    }

    receive() external payable {}
}

contract RejectingTenderlyVnet {
    function setBalance(address[] calldata, uint256) external pure returns (bool) {
        return false;
    }

    function setErc20Balance(address, address[] calldata, uint256) external pure returns (bool) {
        return false;
    }
}

contract TenderlyBootstrapTest is Test {
    address private constant VNET = 0xc100000000000000000000000000000000000000;
    uint256 private constant OPERATOR_KEY = 0xa11ce;
    uint256 private constant WALLET_RUBA = 10_000 ether;
    uint256 private constant WALLET_USDT = 10_000e6;
    uint256 private constant SEED_RUBA = 1000 ether;
    uint256 private constant SEED_USDT = 1000e6;
    bytes32 private constant DEPOSITED = keccak256("Deposited(uint256,address,address,uint256)");
    bytes32 private constant SALT = keccak256("RUBA_TENDERLY_BOOTSTRAP_V1");

    MockUSDT private usdt;
    address private admin;
    address private operator;
    address private user;
    address private seeder;
    address private outsider;

    function setUp() public {
        usdt = new MockUSDT();
        admin = makeAddr("bootstrap-admin");
        operator = vm.addr(OPERATOR_KEY);
        user = makeAddr("bootstrap-user");
        seeder = makeAddr("bootstrap-seeder");
        outsider = makeAddr("bootstrap-outsider");
        vm.deal(admin, 100 ether);
    }

    function _nextBootstrap() private view returns (address) {
        return vm.computeCreateAddress(admin, vm.getNonce(admin));
    }

    function _installVnet() private {
        MockTenderlyVnet implementation = new MockTenderlyVnet();
        vm.etch(VNET, address(implementation).code);
        vm.deal(VNET, 1000 ether);
    }

    function _deploy(bool withPrecompile) private returns (TenderlyBootstrap bootstrap) {
        if (!withPrecompile) usdt.mint(_nextBootstrap(), WALLET_USDT + SEED_USDT);
        vm.prank(admin);
        bootstrap = new TenderlyBootstrap(
            address(usdt),
            admin,
            operator,
            user,
            seeder,
            WALLET_RUBA,
            WALLET_USDT,
            SEED_RUBA,
            SEED_USDT,
            10 ether,
            withPrecompile
        );
    }

    function _vault(TenderlyBootstrap bootstrap) private view returns (TenderlyBootstrapVault) {
        return TenderlyBootstrapVault(bootstrap.VAULT());
    }

    function testSingleDeploymentCreatesReadyVaultAndFundedWallet() public {
        address predicted = _nextBootstrap();
        uint256 nonceBefore = vm.getNonce(admin);
        TenderlyBootstrap bootstrap = _deploy(false);
        TenderlyBootstrapVault vault = _vault(bootstrap);
        MockERC20 ruba = MockERC20(bootstrap.RUBA());

        assertEq(address(bootstrap), predicted);
        assertEq(vm.getNonce(admin), nonceBefore + 1, "only the top-level CREATE consumes the EOA nonce");
        assertEq(vault.owner(), admin);
        assertEq(vault.pendingOwner(), address(0));
        assertEq(vault.operator(), operator);
        assertEq(vault.ruba(), address(ruba));
        assertEq(vault.usdt(), address(usdt));
        assertTrue(vault.whitelist(user));
        assertTrue(vault.whitelist(seeder));
        assertFalse(vault.whitelist(admin));
        assertFalse(vault.whitelist(address(bootstrap)));
        assertFalse(vault.whitelist(outsider));
        assertEq(ruba.decimals(), 18);
        assertEq(ruba.balanceOf(user), WALLET_RUBA);
        assertEq(usdt.balanceOf(user), WALLET_USDT);
        assertEq(ruba.balanceOf(address(vault)), SEED_RUBA);
        assertEq(usdt.balanceOf(address(vault)), SEED_USDT);
        assertEq(ruba.balanceOf(address(bootstrap)), 0);
        assertEq(usdt.balanceOf(address(bootstrap)), 0);
        assertEq(ruba.allowance(address(bootstrap), address(vault)), 0);
        assertEq(usdt.allowance(address(bootstrap), address(vault)), 0);
        assertEq(vault.nextDepositId(), 3);
        assertEq(bootstrap.TEST_WALLET(), user);
        assertEq(bootstrap.SEEDER(), seeder);
        assertEq(bootstrap.SEED_RUBA(), SEED_RUBA);
        assertEq(bootstrap.SEED_USDT(), SEED_USDT);
        assertEq(bootstrap.WALLET_ETH(), 10 ether);
        assertFalse(bootstrap.USE_PRECOMPILE());
    }

    function testConstructorDepositsEmitCanonicalLogsCreditedToSeederEOA() public {
        vm.recordLogs();
        TenderlyBootstrap bootstrap = _deploy(false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != bootstrap.VAULT() || logs[i].topics[0] != DEPOSITED) continue;
            ++count;
            assertEq(logs[i].topics.length, 4);
            assertEq(logs[i].topics[1], bytes32(count));
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(seeder))));
            address token = count == 1 ? bootstrap.RUBA() : address(usdt);
            assertEq(logs[i].topics[3], bytes32(uint256(uint160(token))));
            assertEq(abi.decode(logs[i].data, (uint256)), count == 1 ? SEED_RUBA : SEED_USDT);
        }
        assertEq(count, 2);
    }

    function testSeederCanRedeemAnOperatorAuthorizationForItsOwnDeposit() public {
        TenderlyBootstrapVault vault = _vault(_deploy(false));
        RubaVault.Withdrawal memory request = RubaVault.Withdrawal({
            account: seeder,
            token: address(usdt),
            amount: 1e6,
            nonce: 0,
            deadline: block.timestamp + 600,
            signerEpoch: 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_KEY, vault.withdrawalDigest(request));
        vm.prank(seeder);
        vault.withdraw(request, abi.encodePacked(r, s, v));
        assertEq(usdt.balanceOf(seeder), 1e6);
        assertEq(usdt.balanceOf(address(vault)), SEED_USDT - 1e6);
        assertTrue(vault.usedWithdrawalNonces(seeder, 0));
    }

    function testNormalDepositsRetainOriginalSenderAndRestrictions() public {
        TenderlyBootstrap bootstrap = _deploy(false);
        TenderlyBootstrapVault vault = _vault(bootstrap);
        MockERC20 ruba = MockERC20(bootstrap.RUBA());
        vm.startPrank(user);
        ruba.approve(address(vault), 5 ether);
        assertEq(vault.deposit(address(ruba), 5 ether), 3);
        vm.stopPrank();
        assertEq(ruba.balanceOf(address(vault)), SEED_RUBA + 5 ether);
        assertEq(ruba.balanceOf(user), WALLET_RUBA - 5 ether);
        vm.expectRevert(RubaVault.NotWhitelisted.selector);
        vm.prank(outsider);
        vault.deposit(address(ruba), 1 ether);
        vm.prank(admin);
        vault.setMarketPaused(true);
        vm.expectRevert(RubaVault.MarketPaused.selector);
        vm.prank(user);
        vault.deposit(address(ruba), 1 ether);
    }

    function testOwnerCanMintAndWhitelistAnAdditionalWalletAtomically() public {
        TenderlyBootstrap bootstrap = _deploy(false);
        TenderlyBootstrapVault vault = _vault(bootstrap);
        MockERC20 ruba = MockERC20(bootstrap.RUBA());
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        vm.prank(outsider);
        vault.prepareTestWallet(outsider, 25 ether);
        assertFalse(vault.whitelist(outsider));
        assertEq(ruba.balanceOf(outsider), 0);
        vm.prank(admin);
        vault.prepareTestWallet(outsider, 25 ether);
        assertTrue(vault.whitelist(outsider));
        assertEq(ruba.balanceOf(outsider), 25 ether);
        vm.prank(admin);
        vault.prepareTestWallet(outsider, 0);
        assertEq(ruba.balanceOf(outsider), 25 ether);
        vm.expectRevert(RubaVault.InvalidAddress.selector);
        vm.prank(admin);
        vault.prepareTestWallet(address(0), 1);
    }

    function testNativePrecompileModeFundsAllAssetsInsideSingleCreate() public {
        _installVnet();
        TenderlyBootstrap bootstrap = _deploy(true);
        TenderlyBootstrapVault vault = _vault(bootstrap);
        assertTrue(bootstrap.USE_PRECOMPILE());
        assertEq(operator.balance, 10 ether);
        assertEq(seeder.balance, 10 ether);
        assertEq(user.balance, 10 ether);
        assertEq(usdt.balanceOf(user), WALLET_USDT);
        assertEq(usdt.balanceOf(address(vault)), SEED_USDT);
        assertEq(vault.nextDepositId(), 3);
    }

    function testPrecompileFundingNeverReducesExistingNativeBalances() public {
        _installVnet();
        vm.deal(operator, 40 ether);
        vm.deal(seeder, 20 ether);
        vm.deal(user, 30 ether);
        _deploy(true);
        assertEq(operator.balance, 40 ether);
        assertEq(seeder.balance, 20 ether);
        assertEq(user.balance, 30 ether);
    }

    function testPrecompileModeSupportsCustomEthAndAlreadyFundedUsdtWallet() public {
        _installVnet();
        usdt.mint(user, WALLET_USDT);
        vm.prank(admin);
        TenderlyBootstrap bootstrap = new TenderlyBootstrap(
            address(usdt), admin, operator, user, seeder, WALLET_RUBA, 0, SEED_RUBA, SEED_USDT, 2 ether, true
        );
        assertEq(bootstrap.WALLET_ETH(), 2 ether);
        assertEq(user.balance, 2 ether);
        assertEq(usdt.balanceOf(user), WALLET_USDT);
        assertEq(usdt.balanceOf(bootstrap.VAULT()), SEED_USDT);
        assertEq(usdt.balanceOf(address(bootstrap)), 0);
        assertEq(usdt.totalSupply(), WALLET_USDT + SEED_USDT);
    }

    function testUnavailableOrFalsePrecompileCannotProducePartialSetup() public {
        address predicted = _nextBootstrap();
        vm.expectRevert(TenderlyBootstrap.PrecompileFailed.selector);
        vm.prank(admin);
        new TenderlyBootstrap(
            address(usdt),
            admin,
            operator,
            user,
            seeder,
            WALLET_RUBA,
            WALLET_USDT,
            SEED_RUBA,
            SEED_USDT,
            10 ether,
            true
        );
        assertEq(predicted.code.length, 0);
        assertEq(user.balance, 0);
        RejectingTenderlyVnet implementation = new RejectingTenderlyVnet();
        vm.etch(VNET, address(implementation).code);
        vm.expectRevert(TenderlyBootstrap.PrecompileFailed.selector);
        vm.prank(admin);
        new TenderlyBootstrap(
            address(usdt),
            admin,
            operator,
            user,
            seeder,
            WALLET_RUBA,
            WALLET_USDT,
            SEED_RUBA,
            SEED_USDT,
            10 ether,
            true
        );
        assertEq(usdt.balanceOf(user), 0);
        assertEq(operator.balance, 0);
        assertEq(seeder.balance, 0);
    }

    function testFinalUsdtTransferFailureRollsBackBothDeploymentsAndSeedTransfers() public {
        address predicted = _nextBootstrap();
        address predictedRuba = vm.computeCreateAddress(predicted, 1);
        address predictedVault = _predictVault(predicted, predictedRuba);
        usdt.mint(predicted, WALLET_USDT + SEED_USDT);
        usdt.setBlacklisted(user, true);
        vm.expectRevert(bytes("USDT: blacklisted"));
        vm.prank(admin);
        new TenderlyBootstrap(
            address(usdt),
            admin,
            operator,
            user,
            seeder,
            WALLET_RUBA,
            WALLET_USDT,
            SEED_RUBA,
            SEED_USDT,
            10 ether,
            false
        );
        assertEq(predicted.code.length, 0);
        assertEq(predictedRuba.code.length, 0);
        assertEq(predictedVault.code.length, 0);
        assertEq(usdt.balanceOf(predicted), WALLET_USDT + SEED_USDT);
        assertEq(usdt.balanceOf(predictedVault), 0);
        assertEq(usdt.balanceOf(user), 0);
    }

    function testLateFailureAlsoRollsBackNativePrecompileEffects() public {
        _installVnet();
        usdt.setBlacklisted(user, true);
        uint256 before = VNET.balance;
        vm.expectRevert(bytes("USDT: blacklisted"));
        vm.prank(admin);
        new TenderlyBootstrap(
            address(usdt),
            admin,
            operator,
            user,
            seeder,
            WALLET_RUBA,
            WALLET_USDT,
            SEED_RUBA,
            SEED_USDT,
            10 ether,
            true
        );
        assertEq(operator.balance, 0);
        assertEq(seeder.balance, 0);
        assertEq(user.balance, 0);
        assertEq(VNET.balance, before);
        assertEq(usdt.totalSupply(), 0);
    }

    function testOwnerCanFundAnAdditionalWalletInOnePrecompileTransaction() public {
        _installVnet();
        TenderlyBootstrap bootstrap = _deploy(true);
        TenderlyBootstrapVault vault = _vault(bootstrap);
        MockERC20 ruba = MockERC20(bootstrap.RUBA());
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        vm.prank(outsider);
        vault.prepareTestWalletWithCheatcodes(outsider, 25 ether, 50e6, 2 ether);
        assertEq(outsider.balance, 0);
        assertEq(usdt.balanceOf(outsider), 0);
        assertFalse(vault.whitelist(outsider));
        vm.prank(admin);
        vault.prepareTestWalletWithCheatcodes(outsider, 25 ether, 50e6, 2 ether);
        assertEq(outsider.balance, 2 ether);
        assertEq(usdt.balanceOf(outsider), 50e6);
        assertEq(ruba.balanceOf(outsider), 25 ether);
        assertTrue(vault.whitelist(outsider));
        vm.prank(admin);
        vault.prepareTestWalletWithCheatcodes(outsider, 0, 10e6, 1 ether);
        assertEq(outsider.balance, 2 ether);
        assertEq(usdt.balanceOf(outsider), 50e6);
        assertEq(ruba.balanceOf(outsider), 25 ether);
    }

    function testOwnerFundingRevertsIfPrecompileDoesNotExist() public {
        TenderlyBootstrap bootstrap = _deploy(false);
        TenderlyBootstrapVault vault = _vault(bootstrap);
        vm.expectRevert(TenderlyBootstrapVault.PrecompileFailed.selector);
        vm.prank(admin);
        vault.prepareTestWalletWithCheatcodes(outsider, 25 ether, 50e6, 2 ether);
        assertFalse(vault.whitelist(outsider));
        assertEq(MockERC20(bootstrap.RUBA()).balanceOf(outsider), 0);
    }

    function testBootstrapRejectsMainnetAndInvalidSeedSettings() public {
        vm.chainId(1);
        vm.expectRevert(TenderlyBootstrap.MainnetForbidden.selector);
        vm.prank(admin);
        new TenderlyBootstrap(
            address(usdt),
            admin,
            operator,
            user,
            seeder,
            WALLET_RUBA,
            WALLET_USDT,
            SEED_RUBA,
            SEED_USDT,
            10 ether,
            false
        );
        vm.chainId(31337);
        vm.expectRevert(TenderlyBootstrap.InvalidSettings.selector);
        vm.prank(admin);
        new TenderlyBootstrap(
            address(usdt),
            admin,
            operator,
            user,
            seeder,
            WALLET_RUBA,
            WALLET_USDT,
            0,
            SEED_USDT,
            10 ether,
            false
        );
        vm.expectRevert(TenderlyBootstrap.InvalidSettings.selector);
        vm.prank(admin);
        new TenderlyBootstrap(
            address(usdt),
            admin,
            operator,
            address(0),
            seeder,
            WALLET_RUBA,
            WALLET_USDT,
            SEED_RUBA,
            SEED_USDT,
            10 ether,
            false
        );
    }

    function testBootstrapAndVaultFitEvmCodeSizeLimits() public {
        assertLe(type(TenderlyBootstrap).creationCode.length + 11 * 32, 49_152, "EIP-3860 initcode limit");
        TenderlyBootstrap bootstrap = _deploy(false);
        assertLe(address(bootstrap).code.length, 24_576, "EIP-170 runtime limit");
        assertLe(bootstrap.VAULT().code.length, 24_576, "EIP-170 vault runtime limit");
    }

    function _predictVault(address bootstrap, address ruba) private view returns (address) {
        bytes memory arguments =
            abi.encode(ruba, address(usdt), admin, operator, user, seeder, SEED_RUBA, SEED_USDT);
        return Create2.computeAddress(
            SALT, keccak256(abi.encodePacked(type(TenderlyBootstrapVault).creationCode, arguments)), bootstrap
        );
    }
}
