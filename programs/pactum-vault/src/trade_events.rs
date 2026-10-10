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
#[cfg(test)]
mod tests {
 use super::*;
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
