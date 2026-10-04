use anchor_lang::prelude::*;
use solana_pubkey::pubkey;

use crate::{error::PactumError, state::ApprovedMarket};

/// Observed action/discriminator values from confirmed mainnet transactions.
///
/// These are intentionally versioned and covered by fixture tests. They must not
/// be accepted from keeper-supplied raw bytes.
pub const OPEN_USER_ORDER_ACTION: u64 = 0x40;
pub const FILL_USER_ORDER_ACTION: u64 = 0x41;
pub const REDEEM_MARKET_OUTCOME_ACTION: u64 = 0x58;

pub const OPEN_USER_ORDER_DATA_LEN: usize = 80;
pub const OBSERVED_USER_ORDER_ACCOUNT_LEN: usize = 344;
pub const FILL_USER_ORDER_DATA_LEN: usize = 32;
pub const REDEEM_MARKET_OUTCOME_DATA_LEN: usize = 8;
pub const MAX_TRADE_SLIPPAGE_BPS: u16 = 500;
pub const BPS_DENOMINATOR: u64 = 10_000;

pub const EVENT_AUTHORITY: Pubkey = pubkey!("ATZQPakBrumxMrSyuEmrt6NcxBbTR1Ucs99dnPFpBUuM");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SPL_TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM_PROGRAM: Pubkey = pubkey!("11111111111111111111111111111111");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeSide {
    Yes,
    No,
}

impl OutcomeSide {
    pub fn mint(self, market: &ApprovedMarket) -> Pubkey {
        match self {
            Self::Yes => market.yes_mint,
            Self::No => market.no_mint,
        }
    }

    pub fn from_mint(market: &ApprovedMarket, mint: Pubkey) -> Result<Self> {
        if mint == market.yes_mint {
            Ok(Self::Yes)
        } else if mint == market.no_mint {
            Ok(Self::No)
        } else {
            err!(PactumError::InvalidDflowAccounts)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedOpenOrder {
    pub input_amount: u64,
    pub quoted_output_amount: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenOrderKeys {
    pub event_authority: Pubkey,
    pub market_ledger: Pubkey,
    pub market_usdc_account: Pubkey,
    pub order_account: Pubkey,
    pub usdc_mint: Pubkey,
    pub source_usdc: Pubkey,
    pub token_authority: Pubkey,
    pub token_program: Pubkey,
    pub system_program: Pubkey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedeemKeys {
    pub event_authority: Pubkey,
    pub market_ledger: Pubkey,
    pub settlement_vault: Pubkey,
    pub outcome_account: Pubkey,
    pub settlement_destination: Pubkey,
    pub usdc_mint: Pubkey,
    pub outcome_mint: Pubkey,
    pub token_authority: Pubkey,
    pub token_2022_program: Pubkey,
    pub token_program: Pubkey,
}

/// Decode only fields that are confirmed from observed transactions.
///
/// The remaining bytes are deliberately opaque until additional independent
/// fixtures establish their semantics.
pub fn decode_observed_open_order(data: &[u8]) -> Result<ObservedOpenOrder> {
    require!(
        data.len() == OPEN_USER_ORDER_DATA_LEN,
        PactumError::InvalidDflowFixture
    );

    let action = read_u64(data, 0)?;
    require!(
        action == OPEN_USER_ORDER_ACTION,
        PactumError::InvalidDflowFixture
    );

    Ok(ObservedOpenOrder {
        input_amount: read_u64(data, 24)?,
        quoted_output_amount: read_u64(data, 32)?,
    })
}

pub fn validate_open_order_keys(
    keys: &OpenOrderKeys,
    market: &ApprovedMarket,
    vault_usdc: Pubkey,
    vault_authority: Pubkey,
) -> Result<()> {
    require!(market.enabled, PactumError::MarketDisabled);
    require_keys_eq!(
        keys.event_authority,
        EVENT_AUTHORITY,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.market_ledger,
        market.market_ledger,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.market_usdc_account,
        market.settlement_vault,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.usdc_mint,
        super::USDC_MINT,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.source_usdc,
        vault_usdc,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.token_authority,
        vault_authority,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.token_program,
        SPL_TOKEN_PROGRAM,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.system_program,
        SYSTEM_PROGRAM,
        PactumError::InvalidDflowAccounts
    );
    Ok(())
}

pub fn minimum_outcome_atoms(quoted_outcome_atoms: u64, slippage_bps: u16) -> Result<u64> {
    require!(
        slippage_bps <= MAX_TRADE_SLIPPAGE_BPS,
        PactumError::InvalidSlippage
    );

    quoted_outcome_atoms
        .checked_mul(BPS_DENOMINATOR - u64::from(slippage_bps))
        .ok_or(PactumError::MathOverflow)
        .map(|value| value / BPS_DENOMINATOR)
}

pub fn validate_open_order_data(
    data: &[u8],
    expected_input_amount: u64,
    quoted_outcome_atoms: u64,
    slippage_bps: u16,
) -> Result<ObservedOpenOrder> {
    let decoded = decode_observed_open_order(data)?;
    require!(
        decoded.input_amount == expected_input_amount,
        PactumError::InvalidDflowFixture
    );

    let min_outcome_atoms = minimum_outcome_atoms(quoted_outcome_atoms, slippage_bps)?;

    require!(
        decoded.quoted_output_amount >= min_outcome_atoms,
        PactumError::InvalidDflowFixture
    );

    Ok(decoded)
}

pub fn validate_redeem_keys(
    keys: &RedeemKeys,
    market: &ApprovedMarket,
    side: OutcomeSide,
    vault_usdc: Pubkey,
    vault_authority: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        keys.event_authority,
        EVENT_AUTHORITY,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.market_ledger,
        market.market_ledger,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.settlement_vault,
        market.settlement_vault,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.settlement_destination,
        vault_usdc,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.usdc_mint,
        super::USDC_MINT,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.outcome_mint,
        side.mint(market),
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.token_authority,
        vault_authority,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.token_2022_program,
        TOKEN_2022_PROGRAM,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.token_program,
        SPL_TOKEN_PROGRAM,
        PactumError::InvalidDflowAccounts
    );
    Ok(())
}

pub fn redeem_market_outcome_data() -> [u8; REDEEM_MARKET_OUTCOME_DATA_LEN] {
    REDEEM_MARKET_OUTCOME_ACTION.to_le_bytes()
}

pub fn validate_redeem_data(data: &[u8]) -> Result<()> {
    require!(
        data.len() == REDEEM_MARKET_OUTCOME_DATA_LEN,
        PactumError::InvalidDflowFixture
    );
    require!(
        read_u64(data, 0)? == REDEEM_MARKET_OUTCOME_ACTION,
        PactumError::InvalidDflowFixture
    );
    Ok(())
}

fn read_u64(data: &[u8], offset: usize) -> Result<u64> {
    let bytes: [u8; 8] = data
        .get(offset..offset + 8)
        .ok_or(PactumError::InvalidDflowFixture)?
        .try_into()
        .map_err(|_| error!(PactumError::InvalidDflowFixture))?;

    Ok(u64::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Confirmed mainnet OpenUserOrder fixture:
    // input = 948,096 USDC atoms; quoted output = 11,000,000 outcome atoms.
    const OPEN_FIXTURE: [u8; 80] = [
        0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xbb, 0x26, 0x7d, 0x45, 0x54, 0xfc, 0x60,
        0xa6, 0x59, 0x00, 0x00, 0x00, 0x00, 0x00, 0x15, 0x0a, 0x80, 0x77, 0x0e, 0x00, 0x00, 0x00,
        0x00, 0x00, 0xc0, 0xd8, 0xa7, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    fn market() -> ApprovedMarket {
        ApprovedMarket {
            market_ledger: pubkey!("GGViDLxL6RRQ4zTydGoiL6NnLugxyDGraydUBAQfo9iX"),
            settlement_vault: pubkey!("BciG3VNEgDihNBcsZYxcJugBw59wQ7xRZAjen6ENaW6h"),
            yes_mint: pubkey!("4qeSi2JVCbE9VQt1uzTJTpJSKdMFRsqWuvf3UL9fGa2P"),
            no_mint: pubkey!("CA7FMbzNTfeR7jkLzF113bBJupKwq98cixaQtc3b3frb"),
            enabled: true,
            bump: 255,
        }
    }

    #[test]
    fn decodes_confirmed_open_order_fixture() {
        let decoded = decode_observed_open_order(&OPEN_FIXTURE).unwrap();
        assert_eq!(decoded.input_amount, 948_096);
        assert_eq!(decoded.quoted_output_amount, 11_000_000);
    }

    #[test]
    fn accepts_confirmed_redeem_action() {
        let data = redeem_market_outcome_data();
        assert_eq!(data, REDEEM_MARKET_OUTCOME_ACTION.to_le_bytes());
        validate_redeem_data(&data).unwrap();
    }

    #[test]
    fn redeem_remains_available_when_market_is_disabled() {
        let mut market = market();
        market.enabled = false;
        let vault_usdc = Pubkey::new_unique();
        let vault_authority = Pubkey::new_unique();

        let keys = RedeemKeys {
            event_authority: EVENT_AUTHORITY,
            market_ledger: market.market_ledger,
            settlement_vault: market.settlement_vault,
            outcome_account: Pubkey::new_unique(),
            settlement_destination: vault_usdc,
            usdc_mint: crate::dflow::USDC_MINT,
            outcome_mint: market.yes_mint,
            token_authority: vault_authority,
            token_2022_program: TOKEN_2022_PROGRAM,
            token_program: SPL_TOKEN_PROGRAM,
        };

        validate_redeem_keys(
            &keys,
            &market,
            OutcomeSide::Yes,
            vault_usdc,
            vault_authority,
        )
        .unwrap();
    }

    #[test]
    fn rejects_unknown_action() {
        let mut fixture = OPEN_FIXTURE;
        fixture[0] = 0x42;
        assert!(decode_observed_open_order(&fixture).is_err());
    }

    #[test]
    fn open_order_validation_rejects_unapproved_market_usdc_account() {
        let market = market();
        let vault_usdc = Pubkey::new_unique();
        let vault_authority = Pubkey::new_unique();

        let keys = OpenOrderKeys {
            event_authority: EVENT_AUTHORITY,
            market_ledger: market.market_ledger,
            market_usdc_account: Pubkey::new_unique(),
            order_account: Pubkey::new_unique(),
            usdc_mint: crate::dflow::USDC_MINT,
            source_usdc: vault_usdc,
            token_authority: vault_authority,
            token_program: SPL_TOKEN_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        };

        assert!(validate_open_order_keys(&keys, &market, vault_usdc, vault_authority,).is_err());
    }

    #[test]
    fn computes_minimum_outcome_atoms() {
        assert_eq!(minimum_outcome_atoms(11_000_000, 50).unwrap(), 10_945_000);
        assert!(minimum_outcome_atoms(11_000_000, MAX_TRADE_SLIPPAGE_BPS + 1).is_err());
    }

    #[test]
    fn open_order_data_enforces_amount_quote_and_slippage() {
        let decoded = validate_open_order_data(&OPEN_FIXTURE, 948_096, 11_000_000, 50).unwrap();
        assert_eq!(decoded.input_amount, 948_096);
        assert_eq!(decoded.quoted_output_amount, 11_000_000);

        assert!(validate_open_order_data(&OPEN_FIXTURE, 948_095, 11_000_000, 50).is_err());
        assert!(validate_open_order_data(&OPEN_FIXTURE, 948_096, 12_000_000, 50).is_err());
        assert!(validate_open_order_data(
            &OPEN_FIXTURE,
            948_096,
            11_000_000,
            MAX_TRADE_SLIPPAGE_BPS + 1,
        )
        .is_err());
    }

    #[test]
    fn redeem_validation_rejects_redirected_usdc_destination() {
        let market = market();
        let vault_usdc = Pubkey::new_unique();
        let vault_authority = Pubkey::new_unique();
        let usdc_mint = crate::dflow::USDC_MINT;

        let keys = RedeemKeys {
            event_authority: EVENT_AUTHORITY,
            market_ledger: market.market_ledger,
            settlement_vault: market.settlement_vault,
            outcome_account: Pubkey::new_unique(),
            settlement_destination: Pubkey::new_unique(),
            usdc_mint,
            outcome_mint: market.yes_mint,
            token_authority: vault_authority,
            token_2022_program: TOKEN_2022_PROGRAM,
            token_program: SPL_TOKEN_PROGRAM,
        };

        assert!(validate_redeem_keys(
            &keys,
            &market,
            OutcomeSide::Yes,
            vault_usdc,
            vault_authority,
        )
        .is_err());
    }

    #[test]
    fn redeem_validation_rejects_wrong_outcome_mint() {
        let market = market();
        let vault_usdc = Pubkey::new_unique();
        let vault_authority = Pubkey::new_unique();
        let usdc_mint = crate::dflow::USDC_MINT;

        let keys = RedeemKeys {
            event_authority: EVENT_AUTHORITY,
            market_ledger: market.market_ledger,
            settlement_vault: market.settlement_vault,
            outcome_account: Pubkey::new_unique(),
            settlement_destination: vault_usdc,
            usdc_mint,
            outcome_mint: market.no_mint,
            token_authority: vault_authority,
            token_2022_program: TOKEN_2022_PROGRAM,
            token_program: SPL_TOKEN_PROGRAM,
        };

        assert!(validate_redeem_keys(
            &keys,
            &market,
            OutcomeSide::Yes,
            vault_usdc,
            vault_authority,
        )
        .is_err());
    }
}
