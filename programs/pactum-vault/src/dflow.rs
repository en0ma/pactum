use anchor_lang::prelude::*;
use solana_pubkey::pubkey;

/// DFlow prediction-market program observed on Solana mainnet.
///
/// Raw prediction-market ABIs are isolated here because instruction layouts are
/// less stable than DFlow's public API/event surfaces.
pub const DFLOW_PREDICTION_MARKETS: Pubkey =
    pubkey!("pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb");

/// DFlow router/orchestrator program observed on Solana mainnet.
pub const DFLOW_ROUTER: Pubkey = pubkey!("DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH");

/// Pactum v1 intentionally supports only the USDC prediction-market rail.
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// CI-only payload deliberately rejected by DFlow. The fork test uses it to
/// prove that Pactum can CPI into the real mainnet prediction-market program.
#[cfg(feature = "test-hooks")]
pub const DFLOW_CPI_PROBE_DATA: &[u8] = &[0xff];
