//! Independent v2 vault accounts. The v1 singleton remains unchanged for migration.
//! No keeper funding or DFlow execution is authorized by this module.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use crate::{dflow, error::PactumError, math, state::VaultConfig};

#[account]
pub struct VaultV2 {
    pub vault_id: [u8; 32],
    pub admin: Pubkey,
    pub keeper: Pubkey, // Pubkey::default() means no bot assigned
    pub usdc_vault: Pubkey,
    pub paused: bool,
    pub authority_bump: u8,
    pub config_bump: u8,
    pub max_trade_usdc: u64,
    pub max_total_exposure_usdc: u64,
    pub min_liquidity_buffer_usdc: u64,
    pub open_exposure_usdc: u64,
    pub total_shares: u64,
    pub open_positions: u64,
}
impl VaultV2 {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 1 + 1 + 1 + 8 * 6;
    pub fn require_keeper(&self, keeper: Pubkey) -> Result<()> {
        require!(self.keeper != Pubkey::default(), PactumError::UnauthorizedKeeper);
        require_keys_eq!(self.keeper, keeper, PactumError::UnauthorizedKeeper);
        require!(!self.paused, PactumError::VaultPaused);
        Ok(())
    }
    pub fn check_trade(&self, amount: u64, liquid: u64) -> Result<()> {
        require!(!self.paused, PactumError::VaultPaused);
        math::validate_trade_amount(amount, self.open_exposure_usdc,
            self.max_trade_usdc, self.max_total_exposure_usdc)?;
        require!(liquid.checked_sub(amount).ok_or(PactumError::LiquidityBufferViolation)?
            >= self.min_liquidity_buffer_usdc, PactumError::LiquidityBufferViolation);
        Ok(())
    }
}
#[account]
pub struct VaultV2Position {
    pub owner: Pubkey,
    pub shares: u64,
    pub bump: u8,
}
impl VaultV2Position { pub const LEN: usize = 32 + 8 + 1; }

#[derive(Accounts)]
#[instruction(vault_id: [u8; 32])]
pub struct CreateVaultV2<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    // During v1→v2 migration the existing protocol config anchors authority.
    // Arbitrary wallets must not create public vaults.
    #[account(seeds=[b"config"], bump=protocol_config.config_bump, has_one=admin)]
    pub protocol_config: Account<'info, VaultConfig>,
    #[account(init, payer=admin, space=8+VaultV2::LEN,
        seeds=[b"vault", vault_id.as_ref()], bump)]
    pub vault: Account<'info, VaultV2>,
    /// CHECK: vault-scoped program-derived custody authority.
    #[account(seeds=[b"vault_authority", vault.key().as_ref()], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(address=dflow::USDC_MINT)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(init, payer=admin, seeds=[b"vault_usdc", vault.key().as_ref()],
        bump, token::mint=usdc_mint, token::authority=authority)]
    pub vault_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ManageVaultV2<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds=[b"vault", vault.vault_id.as_ref()], bump=vault.config_bump,
        has_one=admin)]
    pub vault: Account<'info, VaultV2>,
}
#[derive(Accounts)]
pub struct DepositVaultV2<'info> {
    #[account(mut)] pub user: Signer<'info>,
    #[account(mut, seeds=[b"vault", vault.vault_id.as_ref()], bump=vault.config_bump)]
    pub vault: Account<'info, VaultV2>,
    /// CHECK: derived per vault, not globally.
    #[account(seeds=[b"vault_authority", vault.key().as_ref()], bump=vault.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer=user, space=8+VaultV2Position::LEN,
        seeds=[b"v2_position", vault.key().as_ref(), user.key().as_ref()], bump)]
    pub position: Account<'info, VaultV2Position>,
    #[account(address=dflow::USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, token::mint=usdc_mint, token::authority=user)]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(mut, address=vault.usdc_vault, token::mint=usdc_mint, token::authority=authority)]
    pub vault_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct WithdrawVaultV2<'info> {
    #[account(mut)] pub user: Signer<'info>,
    #[account(mut, seeds=[b"vault", vault.vault_id.as_ref()], bump=vault.config_bump)]
    pub vault: Account<'info, VaultV2>,
    /// CHECK: derived per vault, not globally.
    #[account(seeds=[b"vault_authority", vault.key().as_ref()], bump=vault.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds=[b"v2_position", vault.key().as_ref(), user.key().as_ref()],
        bump=position.bump, constraint=position.owner==user.key())]
    pub position: Account<'info, VaultV2Position>,
    #[account(address=dflow::USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, token::mint=usdc_mint, token::authority=user)]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(mut, address=vault.usdc_vault, token::mint=usdc_mint, token::authority=authority)]
    pub vault_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
pub fn create(ctx: Context<CreateVaultV2>, vault_id: [u8;32],
    max_trade: u64, max_exposure: u64, buffer: u64) -> Result<()> {
    math::validate_risk_limits(max_trade, max_exposure)?;
    let v=&mut ctx.accounts.vault;
    v.vault_id=vault_id;
    v.admin=ctx.accounts.admin.key();
    v.keeper=Pubkey::default();
    v.usdc_vault=ctx.accounts.vault_usdc.key();
    v.paused=false;
    v.authority_bump=ctx.bumps.authority;
    v.config_bump=ctx.bumps.vault;
    v.max_trade_usdc=max_trade;
    v.max_total_exposure_usdc=max_exposure;
    v.min_liquidity_buffer_usdc=buffer;
    v.open_exposure_usdc=0;
    v.total_shares=0;
    v.open_positions=0;
    Ok(())
}
pub fn set_keeper(ctx: Context<ManageVaultV2>, keeper: Pubkey) -> Result<()> {
    // Single canonical slot: replacing or clearing is immediate.
    ctx.accounts.vault.keeper=keeper;
    Ok(())
}
pub fn set_rules(ctx: Context<ManageVaultV2>,
    max_trade: u64, max_exposure: u64, buffer: u64, paused: bool) -> Result<()> {
    math::validate_risk_limits(max_trade, max_exposure)?;
    let v=&mut ctx.accounts.vault;
    require!(max_exposure>=v.open_exposure_usdc, PactumError::InvalidRiskLimits);
    v.max_trade_usdc=max_trade;
    v.max_total_exposure_usdc=max_exposure;
    v.min_liquidity_buffer_usdc=buffer;
    v.paused=paused;
    Ok(())
}
pub fn deposit(ctx: Context<DepositVaultV2>, amount: u64) -> Result<()> {
    let v=&mut ctx.accounts.vault;
    require!(v.open_exposure_usdc==0 && v.open_positions==0, PactumError::ExposureOpen);
    let minted=math::shares_for_deposit(amount,v.total_shares,ctx.accounts.vault_usdc.amount)?;
    let p=&mut ctx.accounts.position;
    if p.owner==Pubkey::default() { p.owner=ctx.accounts.user.key(); p.bump=ctx.bumps.position; }
    require_keys_eq!(p.owner,ctx.accounts.user.key(),PactumError::UnauthorizedAdmin);
    p.shares=p.shares.checked_add(minted).ok_or(PactumError::MathOverflow)?;
    v.total_shares=v.total_shares.checked_add(minted).ok_or(PactumError::MathOverflow)?;
    token::transfer_checked(CpiContext::new(ctx.accounts.token_program.to_account_info(),
        TransferChecked{from:ctx.accounts.user_usdc.to_account_info(),
            mint:ctx.accounts.usdc_mint.to_account_info(),
            to:ctx.accounts.vault_usdc.to_account_info(),
            authority:ctx.accounts.user.to_account_info()}), amount,ctx.accounts.usdc_mint.decimals)
}
pub fn withdraw(ctx: Context<WithdrawVaultV2>, shares: u64) -> Result<()> {
    let v=&mut ctx.accounts.vault;
    require!(v.open_exposure_usdc==0 && v.open_positions==0, PactumError::ExposureOpen);
    require!(shares>0 && ctx.accounts.position.shares>=shares,PactumError::InsufficientShares);
    let amount=math::usdc_for_withdrawal(shares,v.total_shares,ctx.accounts.vault_usdc.amount)?;
    require!(ctx.accounts.vault_usdc.amount.checked_sub(amount)
        .ok_or(PactumError::MathOverflow)? >= v.min_liquidity_buffer_usdc,
        PactumError::LiquidityBufferViolation);
    ctx.accounts.position.shares=ctx.accounts.position.shares.checked_sub(shares).ok_or(PactumError::MathOverflow)?;
    v.total_shares=v.total_shares.checked_sub(shares).ok_or(PactumError::MathOverflow)?;
    let vault_key=v.key();
    let seeds:&[&[u8]]=&[b"vault_authority",vault_key.as_ref(),&[v.authority_bump]];
    token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),
        TransferChecked{from:ctx.accounts.vault_usdc.to_account_info(),
            mint:ctx.accounts.usdc_mint.to_account_info(),
            to:ctx.accounts.user_usdc.to_account_info(),
            authority:ctx.accounts.authority.to_account_info()},&[seeds]),
        amount,ctx.accounts.usdc_mint.decimals)
}
#[cfg(test)]
mod tests {
 use super::*;
 fn v(id:u8,keeper:Pubkey, max:u64)->VaultV2 {
  VaultV2{vault_id:[id;32],admin:Pubkey::new_unique(),keeper,
   usdc_vault:Pubkey::new_unique(),paused:false,authority_bump:255,config_bump:254,
   max_trade_usdc:max,max_total_exposure_usdc:max*2,min_liquidity_buffer_usdc:10,
   open_exposure_usdc:0,total_shares:0,open_positions:0}
 }
 #[test] fn keeper_is_one_per_vault_and_revocation_is_immediate() {
  let bot=Pubkey::new_unique();
  let mut a=v(1,bot,100);let b=v(2,Pubkey::new_unique(),100);
  assert!(a.require_keeper(bot).is_ok());
  assert!(b.require_keeper(bot).is_err());
  a.keeper=Pubkey::default();
  assert!(a.require_keeper(bot).is_err());
 }
 #[test] fn independent_vault_trade_rules() {
  let bot=Pubkey::new_unique();
  assert!(v(1,bot,100).check_trade(90,500).is_ok());
  assert!(v(2,bot,10).check_trade(90,500).is_err());
  assert!(v(1,bot,100).check_trade(90,95).is_err());
 }
}
