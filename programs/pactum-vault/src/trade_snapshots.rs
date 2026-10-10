//! Trade-opening entitlement checkpoints (V2).
//! This records immutable per-vault opening shares, not a DFlow fill.
//! Snapshot creation is keeper-gated and has no custody or fee side effects.
use anchor_lang::prelude::*;
use crate::{dflow, error::PactumError, state::{ApprovedMarket,MarketRegistry}, v2::{VaultV2,VaultV2Position,ShareCheckpointV2}};
use anchor_spl::token::{Mint,TokenAccount};

#[account]
pub struct TradeSnapshotV2 {
    pub vault: Pubkey,
    pub trade_id: [u8;32],
    pub keeper_at_open: Pubkey,
    pub total_shares_at_open: u64,
    /// Vault-wide share revision at the transaction's opening point.
    pub share_revision_at_open: u64,
    pub trader_fee_bps_at_open: u16,
    pub order_account: Pubkey,
    pub market_ledger: Pubkey,
    pub input_amount_usdc: u64,
    pub bump: u8,
}
impl TradeSnapshotV2 {
    pub const LEN:usize=32+32+32+8+8+2+32+32+8+1;
}

#[account]
pub struct TradeParticipantV2 {
    pub trade: Pubkey,
    pub depositor: Pubkey,
    pub shares_at_open: u64,
    pub bump: u8,
}
impl TradeParticipantV2 {pub const LEN:usize=32+32+8+1;}

#[derive(Accounts)]
#[instruction(trade_id:[u8;32])]
pub struct OpenTradeSnapshotV2<'info> {
    #[account(mut)] pub keeper: Signer<'info>,
    #[account(seeds=[b"vault",vault.vault_id.as_ref()],bump=vault.config_bump)]
    pub vault: Account<'info,VaultV2>,
    #[account(init,payer=keeper,space=8+TradeSnapshotV2::LEN,
        seeds=[b"trade_snapshot",vault.key().as_ref(),trade_id.as_ref()],bump)]
    pub trade: Account<'info,TradeSnapshotV2>,
    #[account(seeds=[b"market_registry"],bump=market_registry.bump)]
    pub market_registry: Account<'info,MarketRegistry>,
    #[account(seeds=[b"market",approved_market.market_ledger.as_ref()],bump=approved_market.bump)]
    pub approved_market: Account<'info,ApprovedMarket>,
    /// CHECK: Must be both the approved and registry current DFlow market.
    #[account(address=approved_market.market_ledger,
        constraint=*market_ledger.owner==dflow::DFLOW_PREDICTION_MARKETS)]
    pub market_ledger: UncheckedAccount<'info>,
    #[account(address=approved_market.settlement_vault)]
    pub settlement_vault: Account<'info,TokenAccount>,
    /// CHECK: Actual DFlow order account, bound to trade ID and following instruction.
    pub order_account: UncheckedAccount<'info>,
    #[account(seeds=[b"vault_authority",vault.key().as_ref()],bump=vault.authority_bump)]
    /// CHECK: PDA custody identity only.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address=dflow::USDC_MINT)]
    pub usdc_mint: Account<'info,Mint>,
    #[account(token::mint=usdc_mint, token::authority=keeper)]
    pub keeper_usdc: Account<'info,TokenAccount>,
    #[account(address=vault.usdc_vault,token::mint=usdc_mint,token::authority=vault_authority)]
    pub vault_usdc: Account<'info,TokenAccount>,
    /// CHECK: Instructions sysvar for atomic next-instruction verification.
    #[account(address=solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info,System>,
}
#[derive(Accounts)]
pub struct CheckpointParticipantV2<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    /// CHECK: participant identity tied to vault position and checkpoint PDA.
    pub depositor: UncheckedAccount<'info>,
    #[account(seeds=[b"vault",vault.vault_id.as_ref()],bump=vault.config_bump)]
    pub vault: Account<'info,VaultV2>,
    #[account(seeds=[b"trade_snapshot",vault.key().as_ref(),trade.trade_id.as_ref()],
        bump=trade.bump,has_one=vault)]
    pub trade: Account<'info,TradeSnapshotV2>,
    #[account(seeds=[b"v2_position",vault.key().as_ref(),depositor.key().as_ref()],
        bump=position.bump,constraint=position.owner==depositor.key())]
    pub position: Account<'info,VaultV2Position>,
    #[account(init,payer=payer,space=8+TradeParticipantV2::LEN,
        seeds=[b"trade_participant",trade.key().as_ref(),depositor.key().as_ref()],bump)]
    pub participant: Account<'info,TradeParticipantV2>,
    pub system_program: Program<'info,System>,
}
pub fn open(ctx:Context<OpenTradeSnapshotV2>,trade_id:[u8;32],
    input_amount:u64, quoted_outcome_atoms:u64, slippage_bps:u16)->Result<()> {
    let v=&ctx.accounts.vault;
    v.require_keeper(ctx.accounts.keeper.key())?;
    require!(v.total_shares>0,PactumError::ZeroShares);
    require!(trade_id==ctx.accounts.order_account.key().to_bytes(),
        PactumError::InvalidDflowAccounts);
    v.check_trade(input_amount,ctx.accounts.vault_usdc.amount)?;
    let registry=&ctx.accounts.market_registry;
    let now=Clock::get()?.unix_timestamp;
    require!(registry.sequence>0 && registry.current.start_ts<=now &&
        now<registry.current.end_ts,PactumError::MarketRegistryStale);
    let approved=&ctx.accounts.approved_market;
    require!(approved.enabled,PactumError::MarketDisabled);
    require_keys_eq!(registry.current.market_ledger,ctx.accounts.market_ledger.key(),
        PactumError::MarketRegistryMismatch);
    require_keys_eq!(registry.current.settlement_vault,ctx.accounts.settlement_vault.key(),
        PactumError::MarketRegistryMismatch);
    require_keys_eq!(registry.current.yes_mint,approved.yes_mint,
        PactumError::MarketRegistryMismatch);
    require_keys_eq!(registry.current.no_mint,approved.no_mint,
        PactumError::MarketRegistryMismatch);
    require_keys_eq!(ctx.accounts.settlement_vault.mint,ctx.accounts.usdc_mint.key(),
        PactumError::InvalidDflowAccounts);
    require_keys_eq!(ctx.accounts.settlement_vault.owner,ctx.accounts.market_ledger.key(),
        PactumError::InvalidDflowAccounts);
    let index=solana_instructions_sysvar::load_current_index_checked(
        &ctx.accounts.instructions_sysvar.to_account_info())?;
    let next_index=index.checked_add(1).ok_or(PactumError::MathOverflow)?;
    let data=ctx.accounts.instructions_sysvar.try_borrow_data()?;
    let count=u16::from_le_bytes(data.get(..2).ok_or(PactumError::InvalidDflowAccounts)?
        .try_into().map_err(|_|error!(PactumError::InvalidDflowAccounts))?);
    require!(next_index.checked_add(1)==Some(count),PactumError::InvalidDflowAccounts);
    drop(data);
    let next=solana_instructions_sysvar::load_instruction_at_checked(
        usize::from(next_index),&ctx.accounts.instructions_sysvar.to_account_info())?;
    require_keys_eq!(next.program_id,dflow::DFLOW_PREDICTION_MARKETS,
        PactumError::InvalidDflowAccounts);
    require!(next.accounts.len()==12,PactumError::InvalidDflowAccounts);
    let expected=[
        dflow::DFLOW_PREDICTION_MARKETS,
        dflow::prediction_v1::EVENT_AUTHORITY,
        ctx.accounts.market_ledger.key(),
        ctx.accounts.settlement_vault.key(),
        ctx.accounts.order_account.key(),
        ctx.accounts.usdc_mint.key(),
        ctx.accounts.keeper_usdc.key(),
        ctx.accounts.keeper.key(),
        ctx.accounts.vault_authority.key(),
        ctx.accounts.vault_authority.key(),
        dflow::prediction_v1::SPL_TOKEN_PROGRAM,
        dflow::prediction_v1::SYSTEM_PROGRAM,
    ];
    for (meta,want) in next.accounts.iter().zip(expected.iter()) {
        require_keys_eq!(meta.pubkey,*want,PactumError::InvalidDflowAccounts);
    }
    require!(next.accounts[7].is_signer && !next.accounts[6].is_signer
        && !next.accounts[8].is_signer && !next.accounts[9].is_signer,
        PactumError::InvalidDflowAccounts);
    let observed=dflow::prediction_v1::decode_observed_open_order(&next.data)?;
    let side=match observed.side {
        dflow::prediction_v1::OutcomeSide::Yes => approved.yes_mint,
        dflow::prediction_v1::OutcomeSide::No => approved.no_mint,
    };
    require!(side==registry.current.yes_mint || side==registry.current.no_mint,
        PactumError::MarketRegistryMismatch);
    dflow::prediction_v1::validate_open_order_data(&next.data,observed.side,
        input_amount,quoted_outcome_atoms,slippage_bps)?;
    let t=&mut ctx.accounts.trade;
    t.vault=v.key();
    t.trade_id=trade_id;
    t.keeper_at_open=ctx.accounts.keeper.key();
    t.total_shares_at_open=v.total_shares;
    t.share_revision_at_open=v.share_revision;
    t.trader_fee_bps_at_open=v.trader_profit_share_bps;
    t.order_account=ctx.accounts.order_account.key();
    t.market_ledger=ctx.accounts.market_ledger.key();
    t.input_amount_usdc=input_amount;
    t.bump=ctx.bumps.trade;
    Ok(())
}
pub fn checkpoint(ctx:Context<CheckpointParticipantV2>)->Result<()> {
    let trade=&ctx.accounts.trade;
    let p=&ctx.accounts.position;
    // A checkpoint after any share change would be stale. Consequently
    // this prototype only accepts an unchanged vault share supply and
    // must NOT be used for general mid-trade deposits or withdrawals.
    require!(ctx.accounts.vault.share_revision==trade.share_revision_at_open,
        PactumError::InvalidMarketExposure);
    require!(ctx.accounts.vault.total_shares==trade.total_shares_at_open,
        PactumError::InvalidMarketExposure);
    require!(p.share_revision<=trade.share_revision_at_open,
        PactumError::InvalidMarketExposure);
    require!(p.shares>0 && p.shares<=trade.total_shares_at_open,
        PactumError::InvalidMarketExposure);
    let c=&mut ctx.accounts.participant;
    c.trade=trade.key();
    c.depositor=ctx.accounts.depositor.key();
    c.shares_at_open=p.shares;
    c.bump=ctx.bumps.participant;
    Ok(())
}
/// Read-only proof. Optional checkpoint accounts are verified by their
/// canonical PDAs before their historical balances can be considered.
#[derive(Accounts)]
pub struct VerifyTradeParticipationV2<'info> {
    /// CHECK: bound to the position's owner and the checkpoint PDAs.
    pub depositor: UncheckedAccount<'info>,
    #[account(seeds=[b"vault",vault.vault_id.as_ref()],bump=vault.config_bump)]
    pub vault: Account<'info,VaultV2>,
    #[account(seeds=[b"trade_snapshot",vault.key().as_ref(),trade.trade_id.as_ref()],
        bump=trade.bump,has_one=vault)]
    pub trade: Account<'info,TradeSnapshotV2>,
    #[account(seeds=[b"v2_position",vault.key().as_ref(),depositor.key().as_ref()],
        bump=position.bump,constraint=position.owner==depositor.key())]
    pub position: Account<'info,VaultV2Position>,
    pub before: Option<Account<'info,ShareCheckpointV2>>,
    pub after: Option<Account<'info,ShareCheckpointV2>>,
}
pub fn verify_participation(ctx:Context<VerifyTradeParticipationV2>) -> Result<()> {
    let depositor=ctx.accounts.depositor.key();
    let vault=ctx.accounts.vault.key();
    let pos=&ctx.accounts.position;
    for checkpoint in [ctx.accounts.before.as_ref(),ctx.accounts.after.as_ref()].into_iter().flatten() {
        let (expected, bump)=Pubkey::find_program_address(
            &[b"share_checkpoint",pos.key().as_ref(),
                checkpoint.mutation_index.to_le_bytes().as_ref()], &crate::ID);
        require_keys_eq!(checkpoint.key(),expected,PactumError::InvalidMarketExposure);
        require!(checkpoint.bump==bump,PactumError::InvalidMarketExposure);
    }
    let eligible=verify_opening_balance(
        ctx.accounts.trade.share_revision_at_open,
        ctx.accounts.before.as_deref(),
        ctx.accounts.after.as_deref(),
        depositor,vault,pos.share_mutations)?;
    require!(eligible<=ctx.accounts.trade.total_shares_at_open,
        PactumError::InvalidMarketExposure);
    msg!("Historical trade-opening eligible shares: {}",eligible);
    Ok(())
}

/// Validate a depositor's historical balance at the immutable trade-open
/// revision, using the *consecutive* before/after checkpoint pair.
/// The recorded account owners and PDA seeds must also be enforced by the
/// caller. The immediately next checkpoint excludes unprovided mutations.
///
/// An empty 'before' represents a wallet that had not yet deposited; in
/// that case 'after' must be the first-ever checkpoint (mutation_index = 0).
pub fn verify_opening_balance(
    opening_revision: u64,
    before: Option<&ShareCheckpointV2>,
    after: Option<&ShareCheckpointV2>,
    depositor: Pubkey,
    vault: Pubkey,
    current_mutations: u64,
) -> Result<u64> {
    if let Some(b) = before {
        require_keys_eq!(b.depositor, depositor, PactumError::InvalidMarketExposure);
        require_keys_eq!(b.vault, vault, PactumError::InvalidMarketExposure);
        require!(b.vault_revision <= opening_revision, PactumError::InvalidMarketExposure);
        require!(b.mutation_index < current_mutations, PactumError::InvalidMarketExposure);
    }
    if let Some(a) = after {
        require_keys_eq!(a.depositor, depositor, PactumError::InvalidMarketExposure);
        require_keys_eq!(a.vault, vault, PactumError::InvalidMarketExposure);
        require!(a.vault_revision > opening_revision, PactumError::InvalidMarketExposure);
        require!(a.mutation_index < current_mutations, PactumError::InvalidMarketExposure);
    }
    match (before, after) {
        (Some(b), Some(a)) => {
            require!(b.mutation_index.checked_add(1)==Some(a.mutation_index),
                PactumError::InvalidMarketExposure);
            require!(b.vault_revision < a.vault_revision, PactumError::InvalidMarketExposure);
            Ok(b.shares_after)
        },
        (None, Some(a)) => {
            require!(a.mutation_index == 0, PactumError::InvalidMarketExposure);
            Ok(0)
        },
        (Some(b), None) => {
            require!(b.mutation_index.checked_add(1)==Some(current_mutations),
                PactumError::InvalidMarketExposure);
            Ok(b.shares_after)
        },
        (None,None) => {
            require!(current_mutations == 0, PactumError::InvalidMarketExposure);
            Ok(0)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cp(vault:Pubkey, depositor:Pubkey, idx:u64, rev:u64, shares:u64)->ShareCheckpointV2 {
        ShareCheckpointV2{vault,depositor,mutation_index:idx,vault_revision:rev,shares_after:shares,bump:1}
    }
    #[test]
    fn resolves_consecutive_history_with_late_deposit() {
        let vault=Pubkey::new_unique();let alice=Pubkey::new_unique();
        let initial=cp(vault,alice,0,1,100);
        let later=cp(vault,alice,1,8,200);
        assert_eq!(verify_opening_balance(5,Some(&initial),Some(&later),alice,vault,2).unwrap(),100);
        assert_eq!(verify_opening_balance(0,None,Some(&initial),alice,vault,2).unwrap(),0);
        assert_eq!(verify_opening_balance(8,Some(&later),None,alice,vault,2).unwrap(),200);
    }
    #[test]
    fn rejects_skipped_stale_or_cross_vault_history() {
        let vault=Pubkey::new_unique();let other=Pubkey::new_unique();let alice=Pubkey::new_unique();
        let initial=cp(vault,alice,0,1,100);
        let skipped=cp(vault,alice,2,8,200);
        let later=cp(vault,alice,1,8,200);
        assert!(verify_opening_balance(5,Some(&initial),Some(&skipped),alice,vault,3).is_err());
        assert!(verify_opening_balance(5,Some(&initial),None,alice,vault,2).is_err());
        assert!(verify_opening_balance(5,None,Some(&later),alice,vault,2).is_err());
        assert!(verify_opening_balance(5,Some(&initial),Some(&later),alice,other,2).is_err());
    }
    #[test]
    fn trade_identifiers_are_separate_for_each_vault(){
        let a=Pubkey::new_unique();let b=Pubkey::new_unique();
        let id=[11u8;32];
        let (x,_)=Pubkey::find_program_address(&[b"trade_snapshot",a.as_ref(),id.as_ref()],&crate::ID);
        let (y,_)=Pubkey::find_program_address(&[b"trade_snapshot",b.as_ref(),id.as_ref()],&crate::ID);
        assert_ne!(x,y);
    }
    #[test]
    fn one_participant_record_per_trade_and_wallet(){
        let trade=Pubkey::new_unique();let alice=Pubkey::new_unique();let bob=Pubkey::new_unique();
        let (a,_)=Pubkey::find_program_address(&[b"trade_participant",trade.as_ref(),alice.as_ref()],&crate::ID);
        let (b,_)=Pubkey::find_program_address(&[b"trade_participant",trade.as_ref(),bob.as_ref()],&crate::ID);
        assert_ne!(a,b);
    }
}
