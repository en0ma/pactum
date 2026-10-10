//! Trade-opening entitlement checkpoints (V2).
//! This records immutable per-vault opening shares, not a DFlow fill.
//! Snapshot creation is keeper-gated and has no custody or fee side effects.
use anchor_lang::prelude::*;
use crate::{error::PactumError, v2::{VaultV2,VaultV2Position}};

#[account]
pub struct TradeSnapshotV2 {
    pub vault: Pubkey,
    pub trade_id: [u8;32],
    pub keeper_at_open: Pubkey,
    pub total_shares_at_open: u64,
    pub trader_fee_bps_at_open: u16,
    pub bump: u8,
}
impl TradeSnapshotV2 {
    pub const LEN:usize=32+32+32+8+2+1;
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
pub fn open(ctx:Context<OpenTradeSnapshotV2>,trade_id:[u8;32])->Result<()> {
    let v=&ctx.accounts.vault;
    v.require_keeper(ctx.accounts.keeper.key())?;
    require!(v.total_shares>0,PactumError::ZeroShares);
    let t=&mut ctx.accounts.trade;
    t.vault=v.key();
    t.trade_id=trade_id;
    t.keeper_at_open=ctx.accounts.keeper.key();
    t.total_shares_at_open=v.total_shares;
    t.trader_fee_bps_at_open=v.trader_profit_share_bps;
    t.bump=ctx.bumps.trade;
    Ok(())
}
pub fn checkpoint(ctx:Context<CheckpointParticipantV2>)->Result<()> {
    let trade=&ctx.accounts.trade;
    let p=&ctx.accounts.position;
    // A checkpoint after any share change would be stale. Consequently
    // this prototype only accepts an unchanged vault share supply and
    // must NOT be used for general mid-trade deposits or withdrawals.
    require!(ctx.accounts.vault.total_shares==trade.total_shares_at_open,
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
#[cfg(test)]
mod tests {
    use super::*;
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
