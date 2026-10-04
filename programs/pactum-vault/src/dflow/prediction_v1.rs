use anchor_lang::prelude::*;

use crate::error::PactumError;

/// Observed action/discriminator values from confirmed mainnet transactions.
///
/// These are intentionally versioned and covered by fixture tests. They must not
/// be accepted from keeper-supplied raw bytes.
pub const OPEN_USER_ORDER_ACTION: u64 = 0x40;
pub const FILL_USER_ORDER_ACTION: u64 = 0x41;
pub const REDEEM_MARKET_OUTCOME_ACTION: u64 = 0x58;

pub const OPEN_USER_ORDER_DATA_LEN: usize = 80;
pub const FILL_USER_ORDER_DATA_LEN: usize = 32;
pub const REDEEM_MARKET_OUTCOME_DATA_LEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedOpenOrder {
    pub input_amount: u64,
    pub quoted_output_amount: u64,
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

    #[test]
    fn decodes_confirmed_open_order_fixture() {
        let decoded = decode_observed_open_order(&OPEN_FIXTURE).unwrap();
        assert_eq!(decoded.input_amount, 948_096);
        assert_eq!(decoded.quoted_output_amount, 11_000_000);
    }

    #[test]
    fn accepts_confirmed_redeem_action() {
        validate_redeem_data(&REDEEM_MARKET_OUTCOME_ACTION.to_le_bytes()).unwrap();
    }

    #[test]
    fn rejects_unknown_action() {
        let mut fixture = OPEN_FIXTURE;
        fixture[0] = 0x42;
        assert!(decode_observed_open_order(&fixture).is_err());
    }
}
