use anchor_lang::prelude::*;

#[account]
pub struct VaultConfig {
    pub admin: Pubkey,
    pub usdc_vault: Pubkey,
    pub paused: bool,
    pub vault_authority_bump: u8,
    pub config_bump: u8,
    pub max_trade_usdc: u64,
    pub max_total_exposure_usdc: u64,
    pub min_liquidity_buffer_usdc: u64,
    pub open_exposure_usdc: u64,
    pub total_shares: u64,
}

impl VaultConfig {
    pub const LEN: usize = 32 + // admin
        32 + // usdc_vault
        1 +  // paused
        1 +  // vault_authority_bump
        1 +  // config_bump
        8 +  // max_trade_usdc
        8 +  // max_total_exposure_usdc
        8 +  // min_liquidity_buffer_usdc
        8 +  // open_exposure_usdc
        8; // total_shares
}

#[account]
pub struct UserPosition {
    pub owner: Pubkey,
    pub shares: u64,
    pub bump: u8,
}

impl UserPosition {
    pub const LEN: usize = 32 + 8 + 1;
}

#[account]
pub struct KeeperAuthorization {
    pub keeper: Pubkey,
    pub bump: u8,
}

impl KeeperAuthorization {
    pub const LEN: usize = 32 + 1;
}

#[account]
pub struct ApprovedMarket {
    pub market_ledger: Pubkey,
    pub settlement_vault: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

impl ApprovedMarket {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 1 + 1;
}

#[account]
pub struct MarketExposure {
    pub market_ledger: Pubkey,
    pub outcome_mint: Pubkey,
    /// USDC atoms originally committed to this position.
    pub cost_basis_usdc: u64,
    /// Outcome-token atoms expected to be redeemed on full settlement.
    pub outcome_atoms: u64,
    pub bump: u8,
}

impl MarketExposure {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1;
}
