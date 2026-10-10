//! Deterministic, integer-only profit and fee allocation primitives.
//!
//! These functions do not transfer tokens or establish when a PnL event becomes
//! final. The vault must crystallize all prior PnL **before** admitting deposits
//! into a new accounting epoch, and must not include post-entry deposits in
//! the denominator for profits earned by earlier positions.
use anchor_lang::prelude::*;
use crate::error::PactumError;

pub const FEE_BPS: u64 = 10_000;
pub const PROTOCOL_PROFIT_FEE_BPS: u64 = 100; // exactly 1% of eligible profit

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProfitSplit {
    pub protocol_fee: u64,
    pub trader_fee: u64,
    pub depositor_profit: u64,
}

/// Apply protocol fee to positive distributable profit first; split the remainder
/// between the trader and vault depositors. Trader share is configurable 0..100%
/// of post-protocol profit. Losses never cause performance-fee transfers.
///
/// IMPORTANT: 'eligible_profit' must already account for the correct closed
/// position/epoch basis and any applicable high-water-mark/loss carryforward.
/// It must never be computed as simply the vault's current liquid USDC balance.
pub fn split_eligible_profit(eligible_profit: u64, trader_share_bps: u16)
    -> Result<ProfitSplit> {
    require!(u64::from(trader_share_bps) <= FEE_BPS, PactumError::InvalidRiskLimits);
    let protocol_fee = (u128::from(eligible_profit)
        .checked_mul(u128::from(PROTOCOL_PROFIT_FEE_BPS))
        .ok_or(PactumError::MathOverflow)? / u128::from(FEE_BPS)) as u64;
    let after_protocol = eligible_profit.checked_sub(protocol_fee)
        .ok_or(PactumError::MathOverflow)?;
    let trader_fee = (u128::from(after_protocol)
        .checked_mul(u128::from(trader_share_bps))
        .ok_or(PactumError::MathOverflow)? / u128::from(FEE_BPS)) as u64;
    let depositor_profit = after_protocol.checked_sub(trader_fee)
        .ok_or(PactumError::MathOverflow)?;
    Ok(ProfitSplit { protocol_fee, trader_fee, depositor_profit })
}

/// Mint shares only after older positions' PnL and fees are crystallized.
/// 'nav_before' is net vault equity (not simply the current liquid balance).
/// Otherwise a late depositor can buy shares at an artificially low price.
pub fn shares_at_crystallized_nav(deposit: u64, shares_before: u64, nav_before: u64)
    -> Result<u64> {
    require!(deposit > 0, PactumError::ZeroAmount);
    if shares_before == 0 {
        require!(nav_before == 0, PactumError::UnexpectedInitialVaultBalance);
        return Ok(deposit);
    }
    require!(nav_before > 0, PactumError::MathOverflow);
    let shares = u128::from(deposit)
        .checked_mul(u128::from(shares_before))
        .ok_or(PactumError::MathOverflow)? / u128::from(nav_before);
    require!(shares > 0, PactumError::ZeroShares);
    u64::try_from(shares).map_err(|_| error!(PactumError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fee_priority_and_rounding() {
        let x=split_eligible_profit(1_000_000, 2_000).unwrap();
        assert_eq!(x.protocol_fee, 10_000);
        assert_eq!(x.trader_fee, 198_000);
        assert_eq!(x.depositor_profit, 792_000);
        assert_eq!(x.protocol_fee+x.trader_fee+x.depositor_profit,1_000_000);
    }
    #[test]
    fn zero_profit_means_no_performance_fees() {
        assert_eq!(split_eligible_profit(0,10_000).unwrap(),ProfitSplit::default());
    }
    #[test]
    fn fees_reject_invalid_share() {
        assert!(split_eligible_profit(100,10_001).is_err());
    }
    #[test]
    fn late_entry_buys_at_post_win_nav() {
        // First depositor owns 100 shares for 100 USDC atoms.
        // After 100 realized net profit they own 100 shares worth 200.
        // Second depositor supplies 200 and receives 100 new shares;
        // old depositor retains 50% of post-deposit 400 vault NAV.
        let late=shares_at_crystallized_nav(200,100,200).unwrap();
        assert_eq!(late,100);
        assert_eq!(200u64*100/200,100);
        // The next 100 of net profit is shared equally. The previous
        // 100 of realized profit is not reminted to the late depositor.
    }
    #[test]
    fn cannot_issue_shares_against_zero_nav() {
        assert!(shares_at_crystallized_nav(100,100,0).is_err());
    }
}
