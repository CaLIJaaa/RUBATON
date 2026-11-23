// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

interface IReferenceFactory {
    function createPair(address, address) external returns (address);
    function getPair(address, address) external view returns (address);
}

interface IReferencePair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function mint(address) external returns (uint256);
    function burn(address) external returns (uint256, uint256);
    function swap(uint256, uint256, address, bytes calldata) external;
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Executes the genuine upstream 0.5.16 Factory/Pair bytecode as an AMM oracle.
/// The RUBA server uses this mathematics; the production custody vault does not
/// execute these public swaps or treat user credits as LP reserves.
contract UniswapV2ReferenceTest is Test {
    using SafeERC20 for IERC20;

    MockERC20 internal ruba;
    MockUSDT internal usdt;
    IReferenceFactory internal factory;
    IReferencePair internal pair;

    function setUp() public {
        ruba = new MockERC20("Mock RUBA", "RUBA", 18);
        usdt = new MockUSDT();
        // The npm artifact contains both top-level and nested EVM bytecode fields.
        // Read the exact published bytes instead of asking Forge to reinterpret it.
        string memory artifact = vm.readFile("lib/uniswap-v2-core/build/UniswapV2Factory.json");
        bytes memory factoryCode = vm.parseJsonBytes(artifact, ".bytecode");
        assertEq(keccak256(factoryCode), 0x8716c49c3c982e1d8b8beaab0a95d88cc5ec06681dded0f951fa1f3059c1e32a);
        bytes memory creation = abi.encodePacked(factoryCode, abi.encode(address(this)));
        address deployed;
        assembly {
            deployed := create(0, add(creation, 32), mload(creation))
        }
        require(deployed != address(0), "Reference factory deployment failed");
        factory = IReferenceFactory(deployed);
        pair = IReferencePair(factory.createPair(address(ruba), address(usdt)));
        ruba.mint(address(this), 1_000_000 ether);
        usdt.mint(address(this), 1_000_000 * 1e6);
        assertTrue(ruba.transfer(address(pair), 1_000 ether));
        IERC20(address(usdt)).safeTransfer(address(pair), 1_000 * 1e6);
        pair.mint(address(this));
    }

    function testFactoryAndInitialLpShares() public view {
        assertEq(factory.getPair(address(ruba), address(usdt)), address(pair));
        assertEq(factory.getPair(address(usdt), address(ruba)), address(pair));
        assertEq(pair.totalSupply(), 1e15);
        assertEq(pair.balanceOf(address(0)), 1_000);
        assertEq(pair.balanceOf(address(this)), 1e15 - 1_000);
        (uint256 rubaReserve, uint256 usdtReserve) = reserves();
        assertEq(rubaReserve, 1_000 ether);
        assertEq(usdtReserve, 1_000 * 1e6);
    }

    function testFactoryRejectsDuplicatePool() public {
        vm.expectRevert(bytes("UniswapV2: PAIR_EXISTS"));
        factory.createPair(address(usdt), address(ruba));
    }

    function testRubaToUsdtKnownServerVector() public {
        uint256 amountIn = 100 ether;
        uint256 amountOut = quote(amountIn, 1_000 ether, 1_000 * 1e6);
        assertEq(amountOut, 90_661_089);
        uint256 before = usdt.balanceOf(address(this));
        assertTrue(ruba.transfer(address(pair), amountIn));
        swapOut(false, amountOut);
        assertEq(usdt.balanceOf(address(this)) - before, amountOut);
        (uint256 rubaReserve, uint256 usdtReserve) = reserves();
        assertEq(rubaReserve, 1_100 ether);
        assertEq(usdtReserve, 1_000 * 1e6 - amountOut);
        assertEq(pair.totalSupply(), 1e15);
    }

    function testUsdtToRubaWithNoReturnToken() public {
        uint256 amountIn = 100 * 1e6;
        uint256 amountOut = quote(amountIn, 1_000 * 1e6, 1_000 ether);
        uint256 before = ruba.balanceOf(address(this));
        IERC20(address(usdt)).safeTransfer(address(pair), amountIn);
        swapOut(true, amountOut);
        assertEq(ruba.balanceOf(address(this)) - before, amountOut);
    }

    function testExcessOutputViolatesFeeAdjustedInvariant() public {
        uint256 amountIn = 100 ether;
        uint256 amountOut = quote(amountIn, 1_000 ether, 1_000 * 1e6);
        assertTrue(ruba.transfer(address(pair), amountIn));
        bool outputToken0 = pair.token0() == address(usdt);
        vm.expectRevert(bytes("UniswapV2: K"));
        pair.swap(outputToken0 ? amountOut + 1 : 0, outputToken0 ? 0 : amountOut + 1, address(this), "");
    }

    function testBurnReturnsProportionalReserves() public {
        uint256 shares = pair.balanceOf(address(this)) / 2;
        uint256 rubaBefore = ruba.balanceOf(address(this));
        uint256 usdtBefore = usdt.balanceOf(address(this));
        assertTrue(pair.transfer(address(pair), shares));
        pair.burn(address(this));
        assertEq(ruba.balanceOf(address(this)) - rubaBefore, shares * 1_000 ether / 1e15);
        assertEq(usdt.balanceOf(address(this)) - usdtBefore, shares * 1_000 * 1e6 / 1e15);
    }

    function testFuzzRubaSwapMatchesIntegerFormula(uint256 rawAmount) public {
        uint256 amountIn = bound(rawAmount, 1e15, 10_000 ether);
        uint256 amountOut = quote(amountIn, 1_000 ether, 1_000 * 1e6);
        assertTrue(ruba.transfer(address(pair), amountIn));
        swapOut(false, amountOut);
        (uint256 rubaReserve, uint256 usdtReserve) = reserves();
        assertEq(rubaReserve, 1_000 ether + amountIn);
        assertEq(usdtReserve, 1_000 * 1e6 - amountOut);
        assertGe((rubaReserve * 1_000 - amountIn * 3) * usdtReserve, 1_000 ether * 1_000 * 1e6 * 1_000);
    }

    function swapOut(bool outputRuba, uint256 amount) internal {
        bool token0IsRuba = pair.token0() == address(ruba);
        bool outputToken0 = outputRuba == token0IsRuba;
        pair.swap(outputToken0 ? amount : 0, outputToken0 ? 0 : amount, address(this), "");
    }

    function reserves() internal view returns (uint256 rubaReserve, uint256 usdtReserve) {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        return pair.token0() == address(ruba) ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function quote(uint256 amount, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        return amount * 997 * reserveOut / (reserveIn * 1_000 + amount * 997);
    }
}
