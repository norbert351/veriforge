// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title RevenueDistributor
/// @notice Pull-based revenue sharing for a tokenized RWA issuance.
///         Anyone can deposit revenue in USDT; token holders claim their
///         pro-rata share based on their token balance. Holds funds ONLY
///         while unclaimed. No admin, no withdrawals, no owner.
/// @dev Classic dividend-per-token accumulator. Claims are accurate as of
///      claim time; balances are snapshotted per claim.
contract RevenueDistributor {
    address public immutable token;
    address public immutable usdt;

    /// @notice Cumulative USDT entitlement per 1e18 token unit (scaled 1e18).
    uint256 public accDividendPerToken;
    /// @notice Per-holder already-claimed dividend-per-token marker.
    mapping(address => uint256) public paidPerToken;

    event Deposited(address indexed by, uint256 amount);
    event Claimed(address indexed holder, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NoSupply();
    error NothingToClaim();
    error TransferFailed();

    constructor(address token_, address usdt_) {
        if (token_ == address(0) || usdt_ == address(0)) revert ZeroAddress();
        token = token_;
        usdt = usdt_;
    }

    /// @notice Deposit revenue in USDT. Any caller (typically the issuer or
    ///         the asset operator). Requires token supply > 0 so the
    ///         per-token accrual is defined.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 supply = IERC20(token).totalSupply();
        if (supply == 0) revert NoSupply();
        bool ok = IERC20(usdt).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        accDividendPerToken += (amount * 1e18) / supply;
        emit Deposited(msg.sender, amount);
    }

    /// @notice USDT a holder can currently claim.
    function claimable(address holder) public view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(holder);
        if (bal == 0) return 0;
        uint256 accrued = (bal * (accDividendPerToken - paidPerToken[holder])) / 1e18;
        return accrued;
    }

    /// @notice Claim the holder's accrued USDT share.
    function claim() external returns (uint256 amount) {
        amount = claimable(msg.sender);
        if (amount == 0) revert NothingToClaim();
        paidPerToken[msg.sender] = accDividendPerToken;
        bool ok = IERC20(usdt).transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }
}
