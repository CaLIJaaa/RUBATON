// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {RubaVault} from "../src/RubaVault.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

interface ITenderlyVnet {
    function setBalance(address[] calldata accounts, uint256 balance) external returns (bool);
    function setErc20Balance(address token, address[] calldata accounts, uint256 balance)
        external
        returns (bool);
}

/// @notice Test-only vault whose initial deposits are made atomically during deployment.
/// @dev Normal deposits and withdrawals retain the production RubaVault behavior.
contract TenderlyBootstrapVault is RubaVault {
    address private constant VNET_PRECOMPILE = 0xc100000000000000000000000000000000000000;

    error PrecompileFailed();

    constructor(
        address ruba_,
        address usdt_,
        address admin,
        address initialOperator,
        address testWallet,
        address seeder,
        uint256 seedRuba,
        uint256 seedUsdt
    ) RubaVault(ruba_, usdt_, admin, initialOperator) {
        if (testWallet == address(0) || seeder == address(0)) revert InvalidAddress();
        if (seedRuba == 0 || seedUsdt == 0) revert InvalidAmount();
        whitelist[testWallet] = true;
        emit WhitelistUpdated(testWallet, true);
        whitelist[seeder] = true;
        emit WhitelistUpdated(seeder, true);
        _depositFrom(msg.sender, seeder, ruba_, seedRuba);
        _depositFrom(msg.sender, seeder, usdt_, seedUsdt);
    }

    /// @notice Test faucet and access update for an additional wallet, in one transaction.
    function prepareTestWallet(address account, uint256 rubaAmount) external onlyOwner {
        _prepareTestWallet(account, rubaAmount);
    }

    /// @notice Additional Tenderly wallet funding and access in one owner transaction.
    function prepareTestWalletWithCheatcodes(
        address account,
        uint256 rubaAmount,
        uint256 usdtTarget,
        uint256 ethTarget
    ) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        address[] memory wallet = new address[](1);
        wallet[0] = account;
        if (account.balance < ethTarget) {
            _precompileCall(abi.encodeCall(ITenderlyVnet.setBalance, (wallet, ethTarget)));
            if (account.balance < ethTarget) revert PrecompileFailed();
        }
        if (IERC20(usdt).balanceOf(account) < usdtTarget) {
            _precompileCall(abi.encodeCall(ITenderlyVnet.setErc20Balance, (usdt, wallet, usdtTarget)));
            if (IERC20(usdt).balanceOf(account) < usdtTarget) revert PrecompileFailed();
        }
        _prepareTestWallet(account, rubaAmount);
    }

    function _precompileCall(bytes memory data) private {
        (bool success, bytes memory result) = VNET_PRECOMPILE.call(data);
        if (!success || result.length != 32 || bytes32(result) != bytes32(uint256(1))) {
            revert PrecompileFailed();
        }
    }

    function _prepareTestWallet(address account, uint256 rubaAmount) private {
        if (account == address(0)) revert InvalidAddress();
        if (!whitelist[account]) {
            whitelist[account] = true;
            emit WhitelistUpdated(account, true);
        }
        if (rubaAmount != 0) MockERC20(ruba).mint(account, rubaAmount);
    }
}

/// @notice Deploy only on a virtual fork. Tenderly cheatcodes fund it atomically.
/// Without cheatcodes, pre-fund its predicted address with seedUsdt + walletUsdt.
/// @dev Creates both contracts, mints test RUBA, grants access, funds the test wallet
/// and deposits both seed assets. Runtime exposes only immutable recovery data.
contract TenderlyBootstrap {
    using SafeERC20 for IERC20;

    address public immutable RUBA;
    address public immutable VAULT;
    address public immutable TEST_WALLET;
    address public immutable SEEDER;
    uint256 public immutable SEED_RUBA;
    uint256 public immutable SEED_USDT;
    uint256 public immutable WALLET_ETH;
    bool public immutable USE_PRECOMPILE;

    bytes32 private constant VAULT_SALT = keccak256("RUBA_TENDERLY_BOOTSTRAP_V1");
    address public constant VNET_PRECOMPILE = 0xc100000000000000000000000000000000000000;

    struct Settings {
        address usdt;
        address admin;
        address operator;
        address testWallet;
        address seeder;
        uint256 walletRuba;
        uint256 walletUsdt;
        uint256 seedRuba;
        uint256 seedUsdt;
        uint256 walletEth;
    }

    error MainnetForbidden();
    error InvalidSettings();
    error PrecompileFailed();

    constructor(
        address usdt,
        address admin,
        address initialOperator,
        address testWallet,
        address seeder,
        uint256 walletRuba,
        uint256 walletUsdt,
        uint256 seedRuba,
        uint256 seedUsdt,
        uint256 walletEth,
        bool usePrecompile
    ) {
        if (block.chainid == 1) revert MainnetForbidden();
        Settings memory settings;
        settings.usdt = usdt;
        settings.admin = admin;
        settings.operator = initialOperator;
        settings.testWallet = testWallet;
        settings.seeder = seeder;
        settings.walletRuba = walletRuba;
        settings.walletUsdt = walletUsdt;
        settings.seedRuba = seedRuba;
        settings.seedUsdt = seedUsdt;
        settings.walletEth = walletEth;
        _validate(settings);
        if (usePrecompile) _fundWithPrecompile(settings);
        (RUBA, VAULT) = _deploy(settings);
        TEST_WALLET = testWallet;
        SEEDER = seeder;
        SEED_RUBA = seedRuba;
        SEED_USDT = seedUsdt;
        WALLET_ETH = walletEth;
        USE_PRECOMPILE = usePrecompile;
    }

    function _precompileCall(bytes memory data) private {
        (bool success, bytes memory result) = VNET_PRECOMPILE.call(data);
        if (!success || result.length != 32 || bytes32(result) != bytes32(uint256(1))) {
            revert PrecompileFailed();
        }
    }

    function _fundWithPrecompile(Settings memory settings) private {
        bool needsOperator = settings.operator.balance < 10 ether;
        bool needsSeeder = settings.seeder.balance < 10 ether;
        uint256 count = (needsOperator ? 1 : 0) + (needsSeeder ? 1 : 0);
        if (count != 0) {
            address[] memory roles = new address[](count);
            uint256 index;
            if (needsOperator) roles[index++] = settings.operator;
            if (needsSeeder) roles[index] = settings.seeder;
            _precompileCall(abi.encodeCall(ITenderlyVnet.setBalance, (roles, 10 ether)));
            if (settings.operator.balance < 10 ether || settings.seeder.balance < 10 ether) {
                revert PrecompileFailed();
            }
        }
        if (settings.testWallet.balance < settings.walletEth) {
            address[] memory wallet = new address[](1);
            wallet[0] = settings.testWallet;
            _precompileCall(abi.encodeCall(ITenderlyVnet.setBalance, (wallet, settings.walletEth)));
            if (settings.testWallet.balance < settings.walletEth) revert PrecompileFailed();
        }
        address[] memory holders = new address[](1);
        holders[0] = address(this);
        _precompileCall(
            abi.encodeCall(
                ITenderlyVnet.setErc20Balance,
                (settings.usdt, holders, settings.seedUsdt + settings.walletUsdt)
            )
        );
    }

    function _validate(Settings memory settings) private view {
        if (
            settings.usdt.code.length == 0 || settings.admin == address(0) || settings.operator == address(0)
                || settings.operator.code.length != 0 || settings.testWallet == address(0)
                || settings.seeder == address(0) || settings.seedRuba == 0 || settings.seedUsdt == 0
        ) revert InvalidSettings();
    }

    function _deploy(Settings memory settings) private returns (address ruba, address vault) {
        MockERC20 token = new MockERC20("Test RUBA", "RUBA", 18);
        ruba = address(token);
        if (settings.walletRuba != 0) token.mint(settings.testWallet, settings.walletRuba);
        token.mint(address(this), settings.seedRuba);

        bytes memory arguments = abi.encode(
            ruba,
            settings.usdt,
            settings.admin,
            settings.operator,
            settings.testWallet,
            settings.seeder,
            settings.seedRuba,
            settings.seedUsdt
        );
        vault = Create2.computeAddress(
            VAULT_SALT, keccak256(abi.encodePacked(type(TenderlyBootstrapVault).creationCode, arguments))
        );
        IERC20(ruba).forceApprove(vault, settings.seedRuba);
        IERC20(settings.usdt).forceApprove(vault, settings.seedUsdt);
        address deployed = address(
            new TenderlyBootstrapVault{salt: VAULT_SALT}(
                ruba,
                settings.usdt,
                settings.admin,
                settings.operator,
                settings.testWallet,
                settings.seeder,
                settings.seedRuba,
                settings.seedUsdt
            )
        );
        assert(deployed == vault);
        if (settings.walletUsdt != 0) {
            IERC20(settings.usdt).safeTransfer(settings.testWallet, settings.walletUsdt);
        }
    }
}
