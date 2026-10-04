use anchor_lang::prelude::*;

#[error_code]
pub enum PactumError {
    #[msg("The vault is paused")]
    VaultPaused,
    #[msg("The requested amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deposits and withdrawals are disabled while exposure is open")]
    ExposureOpen,
    #[msg("Arithmetic overflow or underflow")]
    MathOverflow,
    #[msg("Deposit would mint zero shares")]
    ZeroShares,
    #[msg("Not enough shares")]
    InsufficientShares,
    #[msg("Withdrawal would violate the configured liquidity buffer")]
    LiquidityBufferViolation,
    #[msg("The initial vault balance must be zero")]
    UnexpectedInitialVaultBalance,
    #[msg("Maximum trade amount must not exceed maximum total exposure")]
    InvalidRiskLimits,
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Market configuration is disabled")]
    MarketDisabled,
    #[msg("Trade amount exceeds the per-trade risk limit")]
    TradeTooLarge,
    #[msg("Trade would exceed aggregate exposure limit")]
    ExposureLimitExceeded,
    #[msg("Unexpected DFlow instruction fixture")]
    InvalidDflowFixture,
    #[msg("DFlow accounts do not match Pactum's approved market/custody constraints")]
    InvalidDflowAccounts,
    #[msg("DFlow did not debit exactly the validated trade amount")]
    InvalidDflowSpend,
    #[msg("Trade slippage exceeds Pactum's protocol cap")]
    InvalidSlippage,
    #[msg("The expected DFlow fill is not yet reflected in the PDA-owned outcome ATA")]
    DflowFillNotObserved,
    #[msg("The DFlow order account has not reached a verifiable terminal closed state")]
    DflowOrderNotTerminal,
    #[msg("The DFlow terminal refund does not match the reserved order cost basis")]
    InvalidDflowRefund,
    #[msg("Tracked market exposure does not match the redeemable position")]
    InvalidMarketExposure,
    #[msg("DFlow redemption did not burn the complete tracked outcome position")]
    IncompleteRedemption,
    #[msg("DFlow redemption payout did not match the redeemed winning outcome amount")]
    InvalidRedemptionPayout,
}
