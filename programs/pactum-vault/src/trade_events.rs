//! Vault-scoped fill/refund accounting model.
//!
//! A fill or refund is an individually identifiable execution event belonging
//! to one registered order. Public event registration is intentionally NOT
//! exposed until authoritative DFlow receipts and delta reconciliation are
//! verified. A bot statement alone must never create a settled trade or fee.
use anchor_lang::prelude::*;
use crate::error::PactumError;

pub const EVENT_FILL:u8=1;
pub const EVENT_REFUND:u8=2;

#[account]
pub struct TradeEventV2 {
    pub vault:Pubkey,
    pub order:Pubkey,
    pub event_id:[u8;32],
    pub kind:u8,
    pub input_usdc:u64,
    pub outcome_atoms:u64,
    pub refund_usdc:u64,
    pub reconciled:bool,
    pub bump:u8,
}
impl TradeEventV2 {
    pub const LEN:usize=32+32+32+1+8+8+8+1+1;
}
/// Deterministic per-vault uniqueness: event IDs cannot be registered twice
/// within the same vault; the same bytes in another vault are independent.
pub fn trade_event_address(vault:Pubkey,event_id:[u8;32])->Pubkey {
    Pubkey::find_program_address(&[b"v2_trade",vault.as_ref(),event_id.as_ref()],&crate::ID).0
}
pub fn validate_event_record(
    vault:Pubkey,order_vault:Pubkey,kind:u8,input:u64,outcome:u64,refund:u64,
)->Result<()> {
    require_keys_eq!(vault,order_vault,PactumError::InvalidMarketExposure);
    require!(kind==EVENT_FILL || kind==EVENT_REFUND,PactumError::InvalidDflowFixture);
    match kind {
        EVENT_FILL => require!(input>0 && outcome>0 && refund==0,PactumError::InvalidDflowFixture),
        EVENT_REFUND => require!(refund>0 && input==0 && outcome==0,PactumError::InvalidDflowFixture),
        _ => return err!(PactumError::InvalidDflowFixture),
    }
    Ok(())
}
/// Cumulative execution totals for one order. These are accounting state,
/// not authority to mint a trade event from unverified bot assertions.
#[derive(AnchorSerialize,AnchorDeserialize,Clone,Copy,Debug,Default,PartialEq,Eq)]
pub struct OrderReconciliationV2 {
    pub filled_usdc:u64,
    pub outcome_atoms:u64,
    pub refunded_usdc:u64,
    pub event_count:u64,
    pub terminal:bool,
}
impl OrderReconciliationV2 {
    /// Apply a single authenticated, uniquely identified event.
    /// The caller MUST verify that the event PDA is initialized only once
    /// and the fill/refund amounts are supported by DFlow state and custody.
    pub fn apply(&mut self, order_input_usdc:u64, kind:u8,
        fill_usdc:u64, outcome_atoms:u64, refund_usdc:u64,
        terminal:bool)->Result<()> {
        require!(!self.terminal,PactumError::InvalidDflowRefund);
        require!(kind==EVENT_FILL || kind==EVENT_REFUND,PactumError::InvalidDflowFixture);
        let new_filled=self.filled_usdc.checked_add(fill_usdc).ok_or(PactumError::MathOverflow)?;
        let new_refunded=self.refunded_usdc.checked_add(refund_usdc).ok_or(PactumError::MathOverflow)?;
        let new_outcome=self.outcome_atoms.checked_add(outcome_atoms).ok_or(PactumError::MathOverflow)?;
        require!(new_filled.checked_add(new_refunded).ok_or(PactumError::MathOverflow)?
            <=order_input_usdc,PactumError::InvalidDflowRefund);
        match kind {
            EVENT_FILL => require!(fill_usdc>0 && outcome_atoms>0 && refund_usdc==0,
                PactumError::InvalidDflowFixture),
            EVENT_REFUND => require!(refund_usdc>0 && fill_usdc==0 && outcome_atoms==0,
                PactumError::InvalidDflowFixture),
            _=>return err!(PactumError::InvalidDflowFixture),
        }
        if terminal {
            require!(new_filled.checked_add(new_refunded).ok_or(PactumError::MathOverflow)?
                ==order_input_usdc,PactumError::InvalidDflowRefund);
        }
        self.filled_usdc=new_filled;
        self.refunded_usdc=new_refunded;
        self.outcome_atoms=new_outcome;
        self.event_count=self.event_count.checked_add(1).ok_or(PactumError::MathOverflow)?;
        self.terminal=terminal;
        Ok(())
    }
}

/// Terminal evidence as differences from order-opening custody snapshots.
/// Exclusive attribution to this order must be established elsewhere.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct TerminalOrderDeltas {
    pub order_closed: bool,
    pub outcome_start: u64,
    pub outcome_end: u64,
    pub refund_start: u64,
    pub refund_end: u64,
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct TerminalOrderResult {
    pub consumed_usdc:u64,
    pub refunded_usdc:u64,
    pub outcome_atoms:u64,
}
/// Checked terminal accounting, NOT an authenticated per-event DFlow receipt.
pub fn reconcile_terminal_deltas(
    input_usdc:u64,
    quoted_outcome_atoms:u64,
    slippage_bps:u16,
    deltas:TerminalOrderDeltas,
)->Result<TerminalOrderResult> {
    require!(deltas.order_closed,PactumError::DflowFillNotObserved);
    require!(input_usdc>0,PactumError::ZeroAmount);
    let outcome_atoms=deltas.outcome_end.checked_sub(deltas.outcome_start)
        .ok_or(PactumError::InvalidDflowRefund)?;
    let refunded_usdc=deltas.refund_end.checked_sub(deltas.refund_start)
        .ok_or(PactumError::InvalidDflowRefund)?;
    require!(refunded_usdc<=input_usdc,PactumError::InvalidDflowRefund);
    let consumed_usdc=input_usdc.checked_sub(refunded_usdc)
        .ok_or(PactumError::MathOverflow)?;
    if consumed_usdc==0 {
        require!(outcome_atoms==0,PactumError::InvalidDflowFixture);
    } else {
        require!(outcome_atoms>0,PactumError::DflowFillNotObserved);
        let minimum=crate::dflow::prediction_v1::minimum_outcome_for_consumed_input(
            quoted_outcome_atoms,input_usdc,consumed_usdc,slippage_bps)?;
        require!(outcome_atoms>=minimum,PactumError::InvalidDflowFixture);
    }
    Ok(TerminalOrderResult{consumed_usdc,refunded_usdc,outcome_atoms})
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn partial_fills_refund_and_terminal_reconciliation() {
  let mut a=OrderReconciliationV2::default();
  a.apply(100,EVENT_FILL,30,240,0,false).unwrap();
  a.apply(100,EVENT_FILL,40,320,0,false).unwrap();
  a.apply(100,EVENT_REFUND,0,0,30,true).unwrap();
  assert_eq!(a.filled_usdc,70);
  assert_eq!(a.refunded_usdc,30);
  assert_eq!(a.outcome_atoms,560);
  assert_eq!(a.event_count,3);
  assert!(a.terminal);
  assert!(a.apply(100,EVENT_REFUND,0,0,1,true).is_err());
 }
 #[test] fn rejects_overfill_early_terminal_and_invalid_events() {
  let mut a=OrderReconciliationV2::default();
  assert!(a.apply(100,EVENT_FILL,101,50,0,false).is_err());
  assert!(a.apply(100,EVENT_FILL,40,50,0,true).is_err());
  assert!(a.apply(100,EVENT_REFUND,10,0,10,false).is_err());
  assert_eq!(a,OrderReconciliationV2::default());
  a.apply(100,EVENT_FILL,80,100,0,false).unwrap();
  assert!(a.apply(100,EVENT_REFUND,0,0,21,true).is_err());
  assert_eq!(a.filled_usdc,80);
  assert_eq!(a.refunded_usdc,0);
 }
 #[test] fn terminal_order_partial_fill_and_refund() {
  let d=TerminalOrderDeltas{order_closed:true,outcome_start:15,outcome_end:85,
       refund_start:20,refund_end:60};
  let r=reconcile_terminal_deltas(100,100,100,d).unwrap();
  assert_eq!(r.consumed_usdc,60);
  assert_eq!(r.refunded_usdc,40);
  assert_eq!(r.outcome_atoms,70);
 }
 #[test] fn terminal_order_rejects_unclosed_overrefund_and_underfill() {
  let mut d=TerminalOrderDeltas{order_closed:false,outcome_start:0,outcome_end:60,
       refund_start:0,refund_end:40};
  assert!(reconcile_terminal_deltas(100,100,0,d).is_err());
  d.order_closed=true;
  d.refund_end=101;
  assert!(reconcile_terminal_deltas(100,100,0,d).is_err());
  d.refund_end=40;d.outcome_end=59;
  assert!(reconcile_terminal_deltas(100,100,0,d).is_err());
  d.outcome_end=60;d.outcome_start=61;
  assert!(reconcile_terminal_deltas(100,100,0,d).is_err());
 }
 #[test] fn terminal_full_refund_requires_zero_outcome() {
  let mut d=TerminalOrderDeltas{order_closed:true,outcome_start:0,outcome_end:1,
       refund_start:0,refund_end:100};
  assert!(reconcile_terminal_deltas(100,100,100,d).is_err());
  d.outcome_end=0;
  let r=reconcile_terminal_deltas(100,100,100,d).unwrap();
  assert_eq!(r.consumed_usdc,0);
 }
 #[test] fn event_namespace_is_vault_specific() {
  let a=Pubkey::new_unique();let b=Pubkey::new_unique();let id=[44;32];
  assert_ne!(trade_event_address(a,id),trade_event_address(b,id));
  assert_eq!(trade_event_address(a,id),trade_event_address(a,id));
 }
 #[test] fn distinct_events_cannot_share_pda_in_one_vault() {
  let a=Pubkey::new_unique();
  assert_ne!(trade_event_address(a,[1;32]),trade_event_address(a,[2;32]));
 }
 #[test] fn event_types_reject_mixed_or_cross_vault_data() {
  let a=Pubkey::new_unique();let b=Pubkey::new_unique();
  assert!(validate_event_record(a,a,EVENT_FILL,10,50,0).is_ok());
  assert!(validate_event_record(a,a,EVENT_REFUND,0,0,10).is_ok());
  assert!(validate_event_record(a,b,EVENT_FILL,10,50,0).is_err());
  assert!(validate_event_record(a,a,EVENT_FILL,10,50,1).is_err());
  assert!(validate_event_record(a,a,EVENT_REFUND,0,10,10).is_err());
 }
}
