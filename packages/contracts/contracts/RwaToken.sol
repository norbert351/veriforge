// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title RwaToken
/// @notice Tokenized unit of a real-world asset issuance on BOT Chain.
///         Investors buy units with USDT at a fixed price. Sale proceeds
///         go straight to the issuer. The token itself holds no funds.
///         Revenue sharing happens in RevenueDistributor, pro-rata by balance.
/// @dev Standard ERC-20, mint-on-buy. No roles, no pausable, no blacklist.
contract RwaToken is ERC20 {
    address public immutable issuer;
    address public immutable usdt;
    /// @notice Per-issuance secondary-market pool where units trade at a
    ///         demand-driven price. Set once after both contracts deploy
    ///         (the contracts reference each other, so the field is mutable).
    address public secondaryMarket;
    uint256 public immutable pricePerToken; // USDT (6 dp) per 1e18 token unit

    event Bought(address indexed buyer, uint256 usdtAmount, uint256 tokenAmount);

    error ZeroPrice();
    error ZeroAmount();
    error TransferFailed();
    error AlreadySet();

    constructor(
        string memory name_,
        string memory symbol_,
        address issuer_,
        address usdt_,
        uint256 pricePerToken_
    ) ERC20(name_, symbol_) {
        if (issuer_ == address(0)) revert ZeroAddress();
        if (usdt_ == address(0)) revert ZeroAddress();
        if (pricePerToken_ == 0) revert ZeroPrice();
        issuer = issuer_;
        usdt = usdt_;
        pricePerToken = pricePerToken_;
    }

    /// @notice One-time link to the per-issuance secondary market. Callable by
    ///         anyone but only the first call wins; the API sets it right after
    ///         deployment of both contracts.
    function setSecondaryMarket(address market_) external {
        if (market_ == address(0)) revert ZeroAddress();
        if (secondaryMarket != address(0)) revert AlreadySet();
        secondaryMarket = market_;
    }

    error ZeroAddress();

    /// @notice Buy token units with USDT. USDT is pulled from the buyer
    ///         (needs allowance) and forwarded to the issuer immediately.
    /// @param usdtAmount USDT amount in 6-dp units.
    /// @return tokenAmount Token units minted (18 dp).
    function buy(uint256 usdtAmount) external returns (uint256 tokenAmount) {
        if (usdtAmount == 0) revert ZeroAmount();
        tokenAmount = (usdtAmount * 1e18) / pricePerToken;
        if (tokenAmount == 0) revert ZeroAmount();
        bool ok = IERC20(usdt).transferFrom(msg.sender, issuer, usdtAmount);
        if (!ok) revert TransferFailed();
        _mint(msg.sender, tokenAmount);
        emit Bought(msg.sender, usdtAmount, tokenAmount);
    }
}
