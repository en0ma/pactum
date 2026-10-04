use anchor_lang::prelude::*;

use crate::error::PactumError;

pub fn shares_for_deposit(amount: u64, total_shares: u64, liquid_usdc_before: u64) -> Result<u64> {
    if amount == 0 {
        return err!(PactumError::ZeroAmount);
    }

    if total_shares == 0 {
        require!(
            liquid_usdc_before == 0,
            PactumError::UnexpectedInitialVaultBalance
        );
        return Ok(amount);
    }

    require!(liquid_usdc_before > 0, PactumError::MathOverflow);

    let shares = (amount as u128)
        .checked_mul(total_shares as u128)
        .ok_or(PactumError::MathOverflow)?
        .checked_div(liquid_usdc_before as u128)
        .ok_or(PactumError::MathOverflow)?;

    require!(shares > 0, PactumError::ZeroShares);
    u64::try_from(shares).map_err(|_| error!(PactumError::MathOverflow))
}

pub fn usdc_for_withdrawal(shares: u64, total_shares: u64, liquid_usdc: u64) -> Result<u64> {
    require!(shares > 0, PactumError::ZeroAmount);
    require!(total_shares > 0, PactumError::MathOverflow);

    let amount = (shares as u128)
        .checked_mul(liquid_usdc as u128)
        .ok_or(PactumError::MathOverflow)?
        .checked_div(total_shares as u128)
        .ok_or(PactumError::MathOverflow)?;

    u64::try_from(amount).map_err(|_| error!(PactumError::MathOverflow))
}

pub fn validate_risk_limits(max_trade_usdc: u64, max_total_exposure_usdc: u64) -> Result<()> {
    require!(
        max_trade_usdc <= max_total_exposure_usdc,
        PactumError::InvalidRiskLimits
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_deposit_mints_one_share_atom_per_usdc_atom() {
        assert_eq!(shares_for_deposit(1_000_000, 0, 0).unwrap(), 1_000_000);
    }

    #[test]
    fn proportional_deposit_preserves_share_price() {
        assert_eq!(
            shares_for_deposit(500_000, 1_000_000, 2_000_000).unwrap(),
            250_000
        );
    }

    #[test]
    fn proportional_withdrawal_uses_current_liquid_nav() {
        assert_eq!(
            usdc_for_withdrawal(250_000, 1_000_000, 2_000_000).unwrap(),
            500_000
        );
    }

    #[test]
    fn rejects_trade_limit_above_total_exposure() {
        assert!(validate_risk_limits(2_000_000, 1_000_000).is_err());
    }
}
