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
/// Observed in finalized October 2026 redemption transactions; this action uses
/// an 11-account route and MUST NOT be substituted into the V1 0x58 CPI.
pub const OBSERVED_REDEEM_ACTION_2026: u64 = 0x59;

pub const OPEN_USER_ORDER_DATA_LEN: usize = 80;
pub const OPEN_USER_ORDER_SIDE_OFFSET: usize = 16;
pub const OPEN_USER_ORDER_YES: u8 = b'Y';
pub const OPEN_USER_ORDER_NO: u8 = b'N';
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
    pub side: OutcomeSide,
    pub input_amount: u64,
    pub quoted_output_amount: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenOrderKeys {
    pub dflow_program: Pubkey,
    pub event_authority: Pubkey,
    pub market_ledger: Pubkey,
    pub market_usdc_account: Pubkey,
    pub order_account: Pubkey,
    pub usdc_mint: Pubkey,
    pub source_usdc: Pubkey,
    pub token_authority: Pubkey,
    pub fill_recipient: Pubkey,
    pub refund_recipient: Pubkey,
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

    let side = match data[16] {
        b'Y' => OutcomeSide::Yes,
        b'N' => OutcomeSide::No,
        _ => return err!(PactumError::InvalidDflowFixture),
    };

    Ok(ObservedOpenOrder {
        side,
        input_amount: read_u64(data, 24)?,
        quoted_output_amount: read_u64(data, 32)?,
    })
}

pub fn validate_open_order_keys(
    keys: &OpenOrderKeys,
    market: &ApprovedMarket,
    expected_source_usdc: Pubkey,
    expected_token_authority: Pubkey,
    expected_recipient: Pubkey,
) -> Result<()> {
    require!(market.enabled, PactumError::MarketDisabled);
    require_keys_eq!(
        keys.dflow_program,
        super::DFLOW_PREDICTION_MARKETS,
        PactumError::InvalidDflowAccounts
    );
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
        expected_source_usdc,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.token_authority,
        expected_token_authority,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.fill_recipient,
        expected_recipient,
        PactumError::InvalidDflowAccounts
    );
    require_keys_eq!(
        keys.refund_recipient,
        expected_recipient,
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

    Ok(quoted_outcome_atoms
        .checked_mul(BPS_DENOMINATOR - u64::from(slippage_bps))
        .ok_or(PactumError::MathOverflow)?
        / BPS_DENOMINATOR)
}

pub fn minimum_outcome_for_consumed_input(
    quoted_outcome_atoms: u64,
    quoted_input_atoms: u64,
    consumed_input_atoms: u64,
    slippage_bps: u16,
) -> Result<u64> {
    require!(quoted_input_atoms > 0, PactumError::ZeroAmount);
    require!(
        consumed_input_atoms <= quoted_input_atoms,
        PactumError::InvalidDflowRefund
    );
    require!(
        slippage_bps <= MAX_TRADE_SLIPPAGE_BPS,
        PactumError::InvalidSlippage
    );

    let numerator = u128::from(quoted_outcome_atoms)
        .checked_mul(u128::from(consumed_input_atoms))
        .and_then(|value| value.checked_mul(u128::from(BPS_DENOMINATOR - u64::from(slippage_bps))))
        .ok_or(PactumError::MathOverflow)?;
    let denominator = u128::from(quoted_input_atoms)
        .checked_mul(u128::from(BPS_DENOMINATOR))
        .ok_or(PactumError::MathOverflow)?;

    u64::try_from(numerator / denominator).map_err(|_| error!(PactumError::MathOverflow))
}

pub fn validate_open_order_data(
    data: &[u8],
    expected_side: OutcomeSide,
    expected_input_amount: u64,
    quoted_outcome_atoms: u64,
    slippage_bps: u16,
) -> Result<ObservedOpenOrder> {
    let decoded = decode_observed_open_order(data)?;
    require!(
        decoded.side == expected_side,
        PactumError::InvalidDflowFixture
    );
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

/// The observed 0x59 top-level instruction carries the DFlow program as
/// its first account, then the ten CPI account roles. This is an account-map
/// **fixture helper**, not settlement authorization or an executable CPI.
pub fn observed_redeem_accounts_2026(keys: &RedeemKeys) -> [Pubkey; 11] {
    [
        super::DFLOW_PREDICTION_MARKETS,
        keys.event_authority,
        keys.market_ledger,
        keys.settlement_vault,
        keys.outcome_account,
        keys.settlement_destination,
        keys.usdc_mint,
        keys.outcome_mint,
        keys.token_authority,
        keys.token_2022_program,
        keys.token_program,
    ]
}

/// Encode the observed sixteen-byte 0x59 redemption action and exact burn amount.
/// The observed instruction has the DFlow program address as account[0] in
/// its top-level compiled instruction, followed by the same ten account roles
/// currently validated by RedeemKeys. Do not switch the production CPI before
/// successfully simulating this variant with Pactum vault PDA authority.
/// Prepare the witnessed 0x59 quantity only when it fully redeems the
/// already-accounted position. Merely producing these bytes cannot authorize
/// a transfer or replace the production 0x58 CPI.
pub fn checked_observed_redeem_data_2026(
    recorded_outcome_atoms: u64,
    custodied_outcome_atoms: u64,
) -> Result<[u8; 16]> {
    require!(
        recorded_outcome_atoms > 0 && recorded_outcome_atoms == custodied_outcome_atoms,
        PactumError::InvalidMarketExposure
    );
    Ok(observed_redeem_market_outcome_data_2026(recorded_outcome_atoms))
}

pub fn observed_redeem_market_outcome_data_2026(outcome_atoms: u64) -> [u8; 16] {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&OBSERVED_REDEEM_ACTION_2026.to_le_bytes());
    bytes[8..].copy_from_slice(&outcome_atoms.to_le_bytes());
    bytes
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
        assert_eq!(decoded.side, OutcomeSide::Yes);
        assert_eq!(decoded.side, OutcomeSide::Yes);
        assert_eq!(decoded.input_amount, 948_096);
        assert_eq!(decoded.quoted_output_amount, 11_000_000);
    }

    #[test]
    fn confirmed_0x59_redemption_matches_all_observed_account_positions() {
        // Finalized transaction 542GdJZfw4Ju8n5pyG5Gk6EJEGgbQNuWLBPSeTf7p4dXW2KC3bzA7X3X95NS4RjBA9WJWAXV1WQTcfRQGLcc1GjN.
        let keys=RedeemKeys {
            event_authority: EVENT_AUTHORITY,
            market_ledger: pubkey!("2Mb9VfikR6g9NXcXoEGvcjNMvwcdony8zu359WEC9vbh"),
            settlement_vault: pubkey!("5aNcsAzb9ZzeyhwTGaxDbi49FbEu7ois38nbxpCg36vn"),
            outcome_account: pubkey!("HEtexPo9ZGdPGEvVAHjDNx1iDHyXDFkkNsEriaFeoWb5"),
            settlement_destination: pubkey!("BQQsYUjaJMyHyttBUkKLD9g9KyHdo1rUvUSKaLjR8MFR"),
            usdc_mint: super::super::USDC_MINT,
            outcome_mint: pubkey!("AhydLZPSumu3toZPNGLkeMEtZBkXvNGkbUwu2AaR4VQ9"),
            token_authority: pubkey!("5sHxK2t34SqebVpYbLrCoKj6DJ4utV2bnUcm5xsXxA9y"),
            token_2022_program: TOKEN_2022_PROGRAM,
            token_program: SPL_TOKEN_PROGRAM,
        };
        let actual=observed_redeem_accounts_2026(&keys);
        assert_eq!(actual.len(),11);
        assert_eq!(actual[0],super::super::DFLOW_PREDICTION_MARKETS);
        assert_eq!(actual[1],EVENT_AUTHORITY);
        assert_eq!(actual[2],keys.market_ledger);
        assert_eq!(actual[3],keys.settlement_vault);
        assert_eq!(actual[4],keys.outcome_account);
        assert_eq!(actual[5],keys.settlement_destination);
        assert_eq!(actual[6],super::super::USDC_MINT);
        assert_eq!(actual[7],keys.outcome_mint);
        assert_eq!(actual[8],keys.token_authority);
        assert_eq!(actual[9],TOKEN_2022_PROGRAM);
        assert_eq!(actual[10],SPL_TOKEN_PROGRAM);
    }

    #[test]
    fn observed_0x59_requires_full_recorded_custody_and_correct_quantity() {
        assert_eq!(
            checked_observed_redeem_data_2026(1_000_000, 1_000_000).unwrap(),
            [0x59, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x42, 0x0f, 0, 0, 0, 0]
        );
        assert_eq!(
            checked_observed_redeem_data_2026(3_000_000, 3_000_000).unwrap(),
            [0x59, 0, 0, 0, 0, 0, 0, 0xc0, 0xc6, 0x2d, 0, 0, 0, 0, 0]
        );
        for (recorded, custodied) in [(0, 0), (1, 0), (1, 2), (2, 1)] {
            assert!(checked_observed_redeem_data_2026(recorded, custodied).is_err());
        }
    }

    #[test]
    fn observed_0x59_redeem_is_distinct_from_existing_0x58_cpi() {
        let observed=observed_redeem_market_outcome_data_2026(1_000_000);
        assert_eq!(&observed[..8], &89u64.to_le_bytes());
        assert_eq!(&observed[8..], &1_000_000u64.to_le_bytes());
        assert_eq!(observed.len(), 16);
        assert_eq!(observed, [0x59, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]);
        assert_ne!(&observed[..8], &redeem_market_outcome_data());
        // Existing production CPI stays explicit 0x58 until a real fork probe.
        assert!(validate_redeem_data(&observed).is_err());
        assert!(validate_redeem_data(&redeem_market_outcome_data()).is_ok());
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
    fn decodes_no_side_and_rejects_unknown_side() {
        let mut fixture = OPEN_FIXTURE;
        fixture[OPEN_USER_ORDER_SIDE_OFFSET] = OPEN_USER_ORDER_NO;
        assert_eq!(
            decode_observed_open_order(&fixture).unwrap().side,
            OutcomeSide::No
        );

        fixture[OPEN_USER_ORDER_SIDE_OFFSET] = b'X';
        assert!(decode_observed_open_order(&fixture).is_err());
    }

    #[test]
    fn open_order_validation_rejects_unapproved_market_usdc_account() {
        let market = market();
        let vault_usdc = Pubkey::new_unique();
        let vault_authority = Pubkey::new_unique();

        let keys = OpenOrderKeys {
            dflow_program: crate::dflow::DFLOW_PREDICTION_MARKETS,
            event_authority: EVENT_AUTHORITY,
            market_ledger: market.market_ledger,
            market_usdc_account: Pubkey::new_unique(),
            order_account: Pubkey::new_unique(),
            usdc_mint: crate::dflow::USDC_MINT,
            source_usdc: vault_usdc,
            token_authority: vault_authority,
            fill_recipient: vault_authority,
            refund_recipient: vault_authority,
            token_program: SPL_TOKEN_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        };

        assert!(validate_open_order_keys(
            &keys,
            &market,
            vault_usdc,
            vault_authority,
            vault_authority,
        )
        .is_err());
    }

    #[test]
    fn computes_minimum_outcome_atoms() {
        assert_eq!(minimum_outcome_atoms(11_000_000, 50).unwrap(), 10_945_000);
        assert!(minimum_outcome_atoms(11_000_000, MAX_TRADE_SLIPPAGE_BPS + 1).is_err());
    }

    #[test]
    fn prorates_slippage_floor_for_partial_terminal_fill() {
        assert_eq!(
            minimum_outcome_for_consumed_input(11_000_000, 948_096, 474_048, 50).unwrap(),
            5_472_500
        );
        assert_eq!(
            minimum_outcome_for_consumed_input(11_000_000, 948_096, 0, 50).unwrap(),
            0
        );
        assert!(minimum_outcome_for_consumed_input(11_000_000, 948_096, 948_097, 50).is_err());
    }

    #[test]
    fn open_order_data_enforces_amount_quote_and_slippage() {
        let decoded =
            validate_open_order_data(&OPEN_FIXTURE, OutcomeSide::Yes, 948_096, 11_000_000, 50)
                .unwrap();
        assert_eq!(decoded.input_amount, 948_096);
        assert_eq!(decoded.quoted_output_amount, 11_000_000);

        assert!(
            validate_open_order_data(&OPEN_FIXTURE, OutcomeSide::Yes, 948_095, 11_000_000, 50)
                .is_err()
        );
        assert!(
            validate_open_order_data(&OPEN_FIXTURE, OutcomeSide::Yes, 948_096, 12_000_000, 50)
                .is_err()
        );
        assert!(validate_open_order_data(
            &OPEN_FIXTURE,
            OutcomeSide::Yes,
            948_096,
            11_000_000,
            MAX_TRADE_SLIPPAGE_BPS + 1,
        )
        .is_err());
    }

    #[test]
    fn open_order_data_rejects_side_mismatch() {
        assert!(
            validate_open_order_data(&OPEN_FIXTURE, OutcomeSide::No, 948_096, 11_000_000, 50,)
                .is_err()
        );

        let mut invalid = OPEN_FIXTURE;
        invalid[16] = b'X';
        assert!(decode_observed_open_order(&invalid).is_err());
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
