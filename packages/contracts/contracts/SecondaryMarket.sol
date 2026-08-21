// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title SecondaryMarket
/// @notice Per-issuance liquidity pool that lets token units trade at a
///         demand-driven market price, alongside the fixed primary issuance.
///         The issuer seeds a reserve of token units + USDT; buyers and
///         sellers swap against it on a constant-product curve (x*y=k), so:
///           - more buys  -> token price rises
///           - more sells -> token price falls
///         Investors therefore earn in TWO ways: revenue yield (via the
///         RevenueDistributor) plus capital appreciation from price increase.
/// @dev No admin, no fees (pure constant product). Reserves updated after
///      every swap. Price is quoted as USDT per full token unit.
contract SecondaryMarket {
    address public immutable token; // RwaToken unit (18 dp)
    address public immutable usdt;  // USDT (6 dp)
    address public immutable issuer;

    uint256 public reserveToken; // token units held by the pool (18 dp)
    uint256 public reserveUsdt;  // USDT held by the pool (6 dp)
    /// @notice Cumulative USDT that ever entered the pool via buys (6 dp).
    uint256 public totalBuyVolume;
    /// @notice Cumulative token that ever left the pool via buys (18 dp).
    uint256 public totalSellVolume;

    /// @notice A single on-chain price snapshot (for the K-line/candle chart).
    struct PricePoint {
        uint32 ts;      // unix seconds
        uint64 price;   // USDT per token (6 dp)
        uint8 kind;     // 0=seed, 1=buy, 2=sell
    }
    /// @notice Full on-chain price history — drives the candlestick chart.
    PricePoint[] public priceHistory;

    function priceHistoryCount() external view returns (uint256) {
        return priceHistory.length;
    }

    event Seeded(address indexed by, uint256 tokenAmount, uint256 usdtAmount);
    event Swapped(address indexed by, bool isBuy, uint256 tokenAmount, uint256 usdtAmount);

    error ZeroAddress();
    error ZeroAmount();
    error NotIssuer();
    error Unseeded();
    error TransferFailed();

    constructor(address token_, address usdt_, address issuer_) {
        if (token_ == address(0) || usdt_ == address(0) || issuer_ == address(0)) revert ZeroAddress();
        token = token_;
        usdt = usdt_;
        issuer = issuer_;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    /// @notice Append a price snapshot (keeps the candle chart on-chain).
    function _record(uint8 kind) private {
        priceHistory.push(PricePoint(uint32(block.timestamp), uint64(price()), kind));
    }

    /// @notice Seed the pool with an initial token + USDT reserve (issuer only).
    ///         Establishes the starting price = reserveUsdt / reserveToken.
    function seed(uint256 tokenAmount, uint256 usdtAmount) external onlyIssuer {
        if (tokenAmount == 0 || usdtAmount == 0) revert ZeroAmount();
        if (!IERC20(token).transferFrom(msg.sender, address(this), tokenAmount)) revert TransferFailed();
        if (!IERC20(usdt).transferFrom(msg.sender, address(this), usdtAmount)) revert TransferFailed();
        reserveToken += tokenAmount;
        reserveUsdt += usdtAmount;
        emit Seeded(msg.sender, tokenAmount, usdtAmount);
        _record(0); // seed price point
    }

    /// @notice Current market price in USDT per 1e18 token unit.
    function price() public view returns (uint256) {
        if (reserveToken == 0) return 0;
        // USDT is 6 dp, token is 18 dp -> scale so result is USDT-per-token (6 dp).
        return (reserveUsdt * 1e18) / reserveToken;
    }

    /// @notice Token units received for a given USDT amount (before slippage check).
    function quoteTokenOut(uint256 usdtIn) public view returns (uint256) {
        if (reserveToken == 0 || usdtIn == 0) return 0;
        // Constant product: tokenOut = reserveToken * usdtIn / (reserveUsdt + usdtIn)
        return (reserveToken * usdtIn) / (reserveUsdt + usdtIn);
    }

    /// @notice USDT received for a given token amount (before slippage check).
    function quoteUsdtOut(uint256 tokenIn) public view returns (uint256) {
        if (reserveUsdt == 0 || tokenIn == 0) return 0;
        return (reserveUsdt * tokenIn) / (reserveToken + tokenIn);
    }

    /// @notice Buy token units by sending USDT. Price rises as the pool's
    ///         USDT reserve grows relative to its token reserve.
    function buy(uint256 usdtIn) external returns (uint256 tokenOut) {
        if (usdtIn == 0) revert ZeroAmount();
        tokenOut = quoteTokenOut(usdtIn);
        if (tokenOut == 0) revert ZeroAmount();
        if (!IERC20(usdt).transferFrom(msg.sender, address(this), usdtIn)) revert TransferFailed();
        if (!IERC20(token).transfer(msg.sender, tokenOut)) revert TransferFailed();
        reserveUsdt += usdtIn;
        reserveToken -= tokenOut;
        totalBuyVolume += usdtIn;
        emit Swapped(msg.sender, true, tokenOut, usdtIn);
        _record(1); // buy price point
    }

    /// @notice Sell token units for USDT. Price falls as the pool's token
    ///         reserve grows relative to its USDT reserve.
    function sell(uint256 tokenIn) external returns (uint256 usdtOut) {
        if (tokenIn == 0) revert ZeroAmount();
        usdtOut = quoteUsdtOut(tokenIn);
        if (usdtOut == 0) revert ZeroAmount();
        if (!IERC20(token).transferFrom(msg.sender, address(this), tokenIn)) revert TransferFailed();
        if (!IERC20(usdt).transfer(msg.sender, usdtOut)) revert TransferFailed();
        reserveToken += tokenIn;
        reserveUsdt -= usdtOut;
        totalSellVolume += tokenIn;
        emit Swapped(msg.sender, false, tokenIn, usdtOut);
        _record(2); // sell price point
    }
}
