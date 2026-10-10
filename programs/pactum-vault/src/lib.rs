#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{
    self, Approve, Mint, Revoke, Token, TokenAccount, Transfer, TransferChecked,
};
use anchor_spl::token_interface::{
    Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount, TokenInterface,
};

use solana_cpi::invoke;
use solana_instruction::{AccountMeta, Instruction};

pub mod dflow;
pub mod error;
pub mod math;
pub mod state;

use error::PactumError;
use state::{
    ApprovedMarket, KeeperAuthorization, MarketExposure, MarketKeeperAuthorization, MarketRegistry,
    PendingDflowOrder, RegistryMarket, UserPosition, VaultConfig,
};

declare_id!("AJnBVG77ZQnMLyeTuf9JoKhvaDFzFQZhtCBnzHgWFBTw");

#[program]
pub mod pactum_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        max_trade_usdc: u64,
        max_total_exposure_usdc: u64,
        min_liquidity_buffer_usdc: u64,
    ) -> Result<()> {
        math::validate_risk_limits(max_trade_usdc, max_total_exposure_usdc)?;

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.usdc_vault = ctx.accounts.vault_usdc.key();
        config.paused = false;
        config.vault_authority_bump = ctx.bumps.vault_authority;
        config.config_bump = ctx.bumps.config;
        config.max_trade_usdc = max_trade_usdc;
        config.max_total_exposure_usdc = max_total_exposure_usdc;
        config.min_liquidity_buffer_usdc = min_liquidity_buffer_usdc;
        config.open_exposure_usdc = 0;
        config.total_shares = 0;
        config.open_positions = 0;

        emit!(VaultInitialized {
            admin: config.admin,
            usdc_vault: config.usdc_vault,
            max_trade_usdc,
            max_total_exposure_usdc,
            min_liquidity_buffer_usdc,
        });

        Ok(())
    }

    pub fn set_pause(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PauseChanged { paused });
        Ok(())
    }

    pub fn set_risk_limits(
        ctx: Context<AdminConfig>,
        max_trade_usdc: u64,
        max_total_exposure_usdc: u64,
        min_liquidity_buffer_usdc: u64,
    ) -> Result<()> {
        math::validate_risk_limits(max_trade_usdc, max_total_exposure_usdc)?;

        let config = &mut ctx.accounts.config;
        require!(
            max_total_exposure_usdc >= config.open_exposure_usdc,
            PactumError::InvalidRiskLimits
        );

        config.max_trade_usdc = max_trade_usdc;
        config.max_total_exposure_usdc = max_total_exposure_usdc;
        config.min_liquidity_buffer_usdc = min_liquidity_buffer_usdc;

        emit!(RiskLimitsChanged {
            max_trade_usdc,
            max_total_exposure_usdc,
            min_liquidity_buffer_usdc,
        });

        Ok(())
    }

    pub fn register_market(
        ctx: Context<RegisterMarket>,
        settlement_vault: Pubkey,
        yes_mint: Pubkey,
        no_mint: Pubkey,
    ) -> Result<()> {
        let market = &mut ctx.accounts.approved_market;
        market.market_ledger = ctx.accounts.market_ledger.key();
        market.settlement_vault = settlement_vault;
        market.yes_mint = yes_mint;
        market.no_mint = no_mint;
        market.enabled = true;
        market.bump = ctx.bumps.approved_market;

        emit!(MarketChanged {
            market_ledger: market.market_ledger,
            enabled: true,
        });

        Ok(())
    }

    pub fn set_market_enabled(ctx: Context<SetMarketEnabled>, enabled: bool) -> Result<()> {
        ctx.accounts.approved_market.enabled = enabled;
        emit!(MarketChanged {
            market_ledger: ctx.accounts.approved_market.market_ledger,
            enabled,
        });
        Ok(())
    }

    pub fn authorize_market_keeper(ctx: Context<AuthorizeMarketKeeper>) -> Result<()> {
        let authorization = &mut ctx.accounts.market_keeper_authorization;
        authorization.keeper = ctx.accounts.market_keeper.key();
        authorization.bump = ctx.bumps.market_keeper_authorization;

        emit!(MarketKeeperChanged {
            keeper: authorization.keeper,
            authorized: true,
        });

        Ok(())
    }

    pub fn revoke_market_keeper(ctx: Context<RevokeMarketKeeper>) -> Result<()> {
        emit!(MarketKeeperChanged {
            keeper: ctx.accounts.market_keeper_authorization.keeper,
            authorized: false,
        });
        Ok(())
    }

    pub fn update_market_registry(
        ctx: Context<UpdateMarketRegistry>,
        previous: RegistryMarket,
        current: RegistryMarket,
        next: RegistryMarket,
        sequence: u64,
        observed_slot: u64,
    ) -> Result<()> {
        require!(
            previous.start_ts < previous.end_ts,
            PactumError::InvalidMarketRegistry
        );
        require!(
            current.start_ts < current.end_ts,
            PactumError::InvalidMarketRegistry
        );
        require!(
            next.start_ts < next.end_ts,
            PactumError::InvalidMarketRegistry
        );
        require!(
            previous.end_ts <= current.start_ts && current.end_ts <= next.start_ts,
            PactumError::InvalidMarketRegistry
        );

        let clock = Clock::get()?;
        require!(
            observed_slot <= clock.slot,
            PactumError::InvalidMarketRegistry
        );
        require!(
            current.start_ts <= clock.unix_timestamp && clock.unix_timestamp < current.end_ts,
            PactumError::MarketRegistryStale
        );

        let registry = &mut ctx.accounts.market_registry;
        if registry.sequence == 0 {
            require!(sequence == 1, PactumError::InvalidMarketRegistry);
        } else {
            let expected_sequence = registry
                .sequence
                .checked_add(1)
                .ok_or(PactumError::MathOverflow)?;
            require!(
                sequence == expected_sequence,
                PactumError::InvalidMarketRegistry
            );
        }

        require_keys_eq!(
            current.market_ledger,
            ctx.accounts.current_market_ledger.key(),
            PactumError::MarketRegistryMismatch
        );
        require_keys_eq!(
            current.settlement_vault,
            ctx.accounts.current_market_usdc.key(),
            PactumError::MarketRegistryMismatch
        );
        require_keys_eq!(
            current.yes_mint,
            ctx.accounts.current_yes_mint.key(),
            PactumError::MarketRegistryMismatch
        );
        require_keys_eq!(
            current.no_mint,
            ctx.accounts.current_no_mint.key(),
            PactumError::MarketRegistryMismatch
        );

        registry.previous = previous;
        registry.current = current;
        registry.next = next;
        registry.sequence = sequence;
        registry.observed_slot = observed_slot;
        registry.bump = ctx.bumps.market_registry;

        let approved = &mut ctx.accounts.current_approved_market;
        if approved.market_ledger == Pubkey::default() {
            approved.market_ledger = current.market_ledger;
            approved.settlement_vault = current.settlement_vault;
            approved.yes_mint = current.yes_mint;
            approved.no_mint = current.no_mint;
            approved.enabled = true;
            approved.bump = ctx.bumps.current_approved_market;
        } else {
            require_keys_eq!(
                approved.market_ledger,
                current.market_ledger,
                PactumError::MarketRegistryMismatch
            );
            require_keys_eq!(
                approved.settlement_vault,
                current.settlement_vault,
                PactumError::MarketRegistryMismatch
            );
            require_keys_eq!(
                approved.yes_mint,
                current.yes_mint,
                PactumError::MarketRegistryMismatch
            );
            require_keys_eq!(
                approved.no_mint,
                current.no_mint,
                PactumError::MarketRegistryMismatch
            );
        }

        emit!(MarketRegistryUpdated {
            sequence,
            observed_slot,
            previous_market: previous.market_ledger,
            current_market: current.market_ledger,
            next_market: next.market_ledger,
        });

        Ok(())
    }

    /// Read-only validation for an atomically composed keeper + DFlow transaction.
    /// Does not transfer, delegate, sign, or approve any vault funds.
    ///
    /// Only the immediately following top-level instruction is accepted.
    /// This is a migration gate, not yet a production funding mechanism.
    pub fn verify_dflow_wrapper(
        ctx: Context<VerifyDflowWrapper>,
        input_amount: u64,
        quoted_outcome_atoms: u64,
        slippage_bps: u16,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, PactumError::VaultPaused);
        let now = Clock::get()?.unix_timestamp;
        let registry = &ctx.accounts.market_registry;
        require!(
            registry.sequence > 0
                && registry.current.start_ts <= now
                && now < registry.current.end_ts,
            PactumError::MarketRegistryStale
        );
        let approved = &ctx.accounts.approved_market;
        require!(approved.enabled, PactumError::MarketDisabled);
        require_keys_eq!(registry.current.market_ledger, approved.market_ledger, PactumError::MarketRegistryMismatch);
        require_keys_eq!(registry.current.settlement_vault, approved.settlement_vault, PactumError::MarketRegistryMismatch);
        require_keys_eq!(registry.current.yes_mint, approved.yes_mint, PactumError::MarketRegistryMismatch);
        require_keys_eq!(registry.current.no_mint, approved.no_mint, PactumError::MarketRegistryMismatch);
        math::validate_trade_amount(input_amount, ctx.accounts.config.open_exposure_usdc,
            ctx.accounts.config.max_trade_usdc, ctx.accounts.config.max_total_exposure_usdc)?;
        require!(
            ctx.accounts.vault_usdc.amount.checked_sub(input_amount)
                .ok_or(PactumError::MathOverflow)?
                >= ctx.accounts.config.min_liquidity_buffer_usdc,
            PactumError::LiquidityBufferViolation
        );
        let current_ix = solana_instructions_sysvar::load_current_index_checked(
            &ctx.accounts.instructions_sysvar.to_account_info()
        )?;
        let next_index = current_ix.checked_add(1).ok_or(PactumError::MathOverflow)?;
        let next = solana_instructions_sysvar::load_instruction_at_checked(
            usize::from(next_index),
            &ctx.accounts.instructions_sysvar.to_account_info()
        ).map_err(|_| error!(PactumError::InvalidDflowAccounts))?;
        // The verifier may be preceded by ComputeBudget/nonce instructions,
        // but must be the last instruction before the single DFlow open.
        // Fail closed against appended transfers or other keeper-controlled actions.
        let instruction_count = solana_instructions_sysvar::read_u16(
            &ctx.accounts.instructions_sysvar.try_borrow_data()?,
            0,
        ).map_err(|_| error!(PactumError::InvalidDflowAccounts))?;
        require!(usize::from(next_index) + 1 == usize::from(instruction_count),
            PactumError::InvalidDflowAccounts);
        require_keys_eq!(next.program_id, dflow::DFLOW_PREDICTION_MARKETS, PactumError::InvalidDflowAccounts);
        require!(next.accounts.len() == 12, PactumError::InvalidDflowAccounts);
        let expected = [
            ctx.accounts.dflow_program.key(),
            ctx.accounts.event_authority.key(),
            ctx.accounts.market_ledger.key(),
            ctx.accounts.market_usdc_account.key(),
            ctx.accounts.order_account.key(),
            ctx.accounts.usdc_mint.key(),
            ctx.accounts.keeper_usdc.key(),
            ctx.accounts.keeper.key(),
            ctx.accounts.vault_authority.key(),
            ctx.accounts.vault_authority.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.system_program.key(),
        ];
        for (meta, want) in next.accounts.iter().zip(expected.iter()) {
            require_keys_eq!(meta.pubkey, *want, PactumError::InvalidDflowAccounts);
        }
        // The bot is the only DFlow authority signer in the observed OpenUserOrder
        // shape. The PDA custody recipients are not top-level signers.
        require!(next.accounts[7].is_signer, PactumError::InvalidDflowAccounts);
        require!(!next.accounts[8].is_signer && !next.accounts[9].is_signer,
            PactumError::InvalidDflowAccounts);
        require!(!next.accounts[6].is_signer, PactumError::InvalidDflowAccounts);
        let side = dflow::prediction_v1::OutcomeSide::from_mint(
            approved, ctx.accounts.outcome_mint.key()
        )?;
        dflow::prediction_v1::validate_open_order_data(
            &next.data, side, input_amount, quoted_outcome_atoms, slippage_bps
        )?;
        // Read-only. This cannot certify spending, refund or asynchronous fill.
        Ok(())
    }

    pub fn authorize_keeper(ctx: Context<AuthorizeKeeper>) -> Result<()> {
        let authorization = &mut ctx.accounts.keeper_authorization;
        authorization.keeper = ctx.accounts.keeper.key();
        authorization.bump = ctx.bumps.keeper_authorization;

        emit!(KeeperChanged {
            keeper: authorization.keeper,
            authorized: true,
        });

        Ok(())
    }

    pub fn revoke_keeper(ctx: Context<RevokeKeeper>) -> Result<()> {
        emit!(KeeperChanged {
            keeper: ctx.accounts.keeper_authorization.keeper,
            authorized: false,
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, PactumError::VaultPaused);
        require!(
            ctx.accounts.config.open_exposure_usdc == 0 && ctx.accounts.config.open_positions == 0,
            PactumError::ExposureOpen
        );

        let shares = math::shares_for_deposit(
            amount,
            ctx.accounts.config.total_shares,
            ctx.accounts.vault_usdc.amount,
        )?;

        let position = &mut ctx.accounts.user_position;
        if position.owner == Pubkey::default() {
            position.owner = ctx.accounts.user.key();
            position.bump = ctx.bumps.user_position;
        } else {
            require_keys_eq!(
                position.owner,
                ctx.accounts.user.key(),
                PactumError::UnauthorizedAdmin
            );
        }

        position.shares = position
            .shares
            .checked_add(shares)
            .ok_or(PactumError::MathOverflow)?;

        ctx.accounts.config.total_shares = ctx
            .accounts
            .config
            .total_shares
            .checked_add(shares)
            .ok_or(PactumError::MathOverflow)?;

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.user_usdc.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.vault_usdc.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };

        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            amount,
            shares,
        });

        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, PactumError::VaultPaused);
        require!(
            ctx.accounts.config.open_exposure_usdc == 0 && ctx.accounts.config.open_positions == 0,
            PactumError::ExposureOpen
        );
        require!(
            ctx.accounts.user_position.shares >= shares,
            PactumError::InsufficientShares
        );

        let amount = math::usdc_for_withdrawal(
            shares,
            ctx.accounts.config.total_shares,
            ctx.accounts.vault_usdc.amount,
        )?;

        let remaining = ctx
            .accounts
            .vault_usdc
            .amount
            .checked_sub(amount)
            .ok_or(PactumError::MathOverflow)?;

        let withdrawing_all_shares = shares == ctx.accounts.config.total_shares;
        if !withdrawing_all_shares {
            require!(
                remaining >= ctx.accounts.config.min_liquidity_buffer_usdc,
                PactumError::LiquidityBufferViolation
            );
        }

        ctx.accounts.user_position.shares = ctx
            .accounts
            .user_position
            .shares
            .checked_sub(shares)
            .ok_or(PactumError::MathOverflow)?;

        ctx.accounts.config.total_shares = ctx
            .accounts
            .config
            .total_shares
            .checked_sub(shares)
            .ok_or(PactumError::MathOverflow)?;

        let authority_bump = [ctx.accounts.config.vault_authority_bump];
        let authority_seeds: &[&[u8]] = &[b"vault_authority", &authority_bump];
        let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault_usdc.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.user_usdc.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };

        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                cpi_accounts,
                signer_seeds,
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        emit!(WithdrawalEvent {
            user: ctx.accounts.user.key(),
            amount,
            shares,
        });

        Ok(())
    }

    /// Open a DFlow prediction-market order from Pactum custody.
    ///
    /// The strategy keeper remains the DFlow user/signer and chooses the
    /// market, side, amount, quote, and timing. Pactum requires that market
    /// data to agree with the independently maintained market registry before
    /// it applies vault risk limits. VaultAuthorityPDA then grants the keeper
    /// an exact, instruction-scoped SPL delegate allowance and signs only the
    /// DFlow fill/refund recipient roles, keeping all terminal assets in
    /// PDA-owned custody. The allowance is revoked before this instruction can
    /// commit.
    pub fn execute_trade(
        ctx: Context<ExecuteTrade>,
        order_data: [u8; dflow::prediction_v1::OPEN_USER_ORDER_DATA_LEN],
        input_amount: u64,
        quoted_outcome_atoms: u64,
        slippage_bps: u16,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, PactumError::VaultPaused);

        let clock = Clock::get()?;
        let current = &ctx.accounts.market_registry.current;
        require!(
            ctx.accounts.market_registry.sequence > 0
                && current.start_ts <= clock.unix_timestamp
                && clock.unix_timestamp < current.end_ts,
            PactumError::MarketRegistryStale
        );
        require_keys_eq!(
            current.market_ledger,
            ctx.accounts.approved_market.market_ledger,
            PactumError::MarketRegistryMismatch
        );
        require_keys_eq!(
            current.settlement_vault,
            ctx.accounts.approved_market.settlement_vault,
            PactumError::MarketRegistryMismatch
        );
        require_keys_eq!(
            current.yes_mint,
            ctx.accounts.approved_market.yes_mint,
            PactumError::MarketRegistryMismatch
        );
        require_keys_eq!(
            current.no_mint,
            ctx.accounts.approved_market.no_mint,
            PactumError::MarketRegistryMismatch
        );

        require!(
            ctx.accounts.approved_market.enabled,
            PactumError::MarketDisabled
        );
        let side = dflow::prediction_v1::OutcomeSide::from_mint(
            &ctx.accounts.approved_market,
            ctx.accounts.outcome_mint.key(),
        )?;

        let decoded = dflow::prediction_v1::validate_open_order_data(
            &order_data,
            side,
            input_amount,
            quoted_outcome_atoms,
            slippage_bps,
        )?;

        math::validate_trade_amount(
            input_amount,
            ctx.accounts.config.open_exposure_usdc,
            ctx.accounts.config.max_trade_usdc,
            ctx.accounts.config.max_total_exposure_usdc,
        )?;

        let outcome_balance_before = ctx.accounts.outcome_ata.amount;
        let refund_usdc_balance_before = ctx.accounts.refund_usdc_ata.amount;

        let remaining_liquidity = ctx
            .accounts
            .vault_usdc
            .amount
            .checked_sub(input_amount)
            .ok_or(PactumError::MathOverflow)?;
        require!(
            remaining_liquidity >= ctx.accounts.config.min_liquidity_buffer_usdc,
            PactumError::LiquidityBufferViolation
        );

        let keys = dflow::prediction_v1::OpenOrderKeys {
            dflow_program: ctx.accounts.dflow_program.key(),
            event_authority: ctx.accounts.event_authority.key(),
            market_ledger: ctx.accounts.market_ledger.key(),
            market_usdc_account: ctx.accounts.market_usdc_account.key(),
            order_account: ctx.accounts.order_account.key(),
            usdc_mint: ctx.accounts.usdc_mint.key(),
            source_usdc: ctx.accounts.vault_usdc.key(),
            token_authority: ctx.accounts.keeper.key(),
            fill_recipient: ctx.accounts.vault_authority.key(),
            refund_recipient: ctx.accounts.vault_authority.key(),
            token_program: ctx.accounts.token_program.key(),
            system_program: ctx.accounts.system_program.key(),
        };
        dflow::prediction_v1::validate_open_order_keys(
            &keys,
            &ctx.accounts.approved_market,
            ctx.accounts.vault_usdc.key(),
            ctx.accounts.keeper.key(),
            ctx.accounts.vault_authority.key(),
        )?;

        let authority_bump = [ctx.accounts.config.vault_authority_bump];
        let authority_seeds: &[&[u8]] = &[b"vault_authority", &authority_bump];
        let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

        token::approve(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Approve {
                    to: ctx.accounts.vault_usdc.to_account_info(),
                    delegate: ctx.accounts.keeper.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            input_amount,
        )?;

        ctx.accounts.vault_usdc.reload()?;
        require!(
            ctx.accounts.vault_usdc.delegate.is_some()
                && ctx.accounts.vault_usdc.delegate.unwrap() == ctx.accounts.keeper.key()
                && ctx.accounts.vault_usdc.delegated_amount == input_amount,
            PactumError::InvalidDelegateState
        );

        let vault_before = ctx.accounts.vault_usdc.amount;
        let ix = Instruction {
            program_id: dflow::DFLOW_PREDICTION_MARKETS,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.dflow_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.market_ledger.key(), false),
                AccountMeta::new(ctx.accounts.market_usdc_account.key(), false),
                AccountMeta::new(ctx.accounts.order_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.usdc_mint.key(), false),
                AccountMeta::new(ctx.accounts.vault_usdc.key(), false),
                AccountMeta::new(ctx.accounts.keeper.key(), true),
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: order_data.to_vec(),
        };

        solana_cpi::invoke_signed(
            &ix,
            &[
                ctx.accounts.dflow_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.market_ledger.to_account_info(),
                ctx.accounts.market_usdc_account.to_account_info(),
                ctx.accounts.order_account.to_account_info(),
                ctx.accounts.usdc_mint.to_account_info(),
                ctx.accounts.vault_usdc.to_account_info(),
                ctx.accounts.keeper.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        token::revoke(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Revoke {
                source: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ))?;

        ctx.accounts.vault_usdc.reload()?;
        require!(
            ctx.accounts.vault_usdc.delegate.is_none()
                && ctx.accounts.vault_usdc.delegated_amount == 0,
            PactumError::InvalidDelegateState
        );

        let spent = vault_before
            .checked_sub(ctx.accounts.vault_usdc.amount)
            .ok_or(PactumError::MathOverflow)?;
        require!(spent == input_amount, PactumError::InvalidDflowSpend);

        require_keys_eq!(
            *ctx.accounts.order_account.owner,
            dflow::DFLOW_PREDICTION_MARKETS,
            PactumError::InvalidDflowAccounts
        );
        require!(
            ctx.accounts.order_account.data_len()
                == dflow::prediction_v1::OBSERVED_USER_ORDER_ACCOUNT_LEN,
            PactumError::InvalidDflowAccounts
        );

        let pending = &mut ctx.accounts.pending_order;
        pending.order_account = ctx.accounts.order_account.key();
        pending.market_ledger = ctx.accounts.market_ledger.key();
        pending.outcome_mint = ctx.accounts.outcome_mint.key();
        pending.cost_basis_usdc = input_amount;
        pending.quoted_outcome_atoms = quoted_outcome_atoms;
        pending.outcome_balance_start = outcome_balance_before;
        pending.refund_usdc_balance_before = refund_usdc_balance_before;
        pending.slippage_bps = slippage_bps;
        pending.bump = ctx.bumps.pending_order;

        ctx.accounts.config.open_exposure_usdc = ctx
            .accounts
            .config
            .open_exposure_usdc
            .checked_add(input_amount)
            .ok_or(PactumError::MathOverflow)?;

        emit!(DflowOrderOpened {
            keeper: ctx.accounts.keeper.key(),
            order_account: ctx.accounts.order_account.key(),
            market_ledger: ctx.accounts.market_ledger.key(),
            outcome_mint: ctx.accounts.outcome_mint.key(),
            input_usdc: input_amount,
            quoted_outcome_atoms: decoded.quoted_output_amount,
            slippage_bps,
        });

        Ok(())
    }

    /// Finalize a terminal DFlow order that produced outcome tokens.
    ///
    /// Terminal proof is the DFlow user-order account having been deallocated.
    /// Any unconsumed USDC must have returned to the canonical VaultAuthority
    /// USDC ATA and is swept back into the Pactum vault.
    pub fn finalize_dflow_filled_order(ctx: Context<FinalizeDflowFilledOrder>) -> Result<()> {
        require_dflow_order_closed(&ctx.accounts.order_account)?;

        let total_filled_outcome_atoms = ctx
            .accounts
            .outcome_ata
            .amount
            .checked_sub(ctx.accounts.pending_order.outcome_balance_start)
            .ok_or(PactumError::MathOverflow)?;
        require!(
            total_filled_outcome_atoms > 0,
            PactumError::DflowFillNotObserved
        );

        let refund_usdc = ctx
            .accounts
            .refund_usdc_ata
            .amount
            .checked_sub(ctx.accounts.pending_order.refund_usdc_balance_before)
            .ok_or(PactumError::MathOverflow)?;
        let recognized_refund_usdc = refund_usdc.min(ctx.accounts.pending_order.cost_basis_usdc);
        let consumed_usdc = ctx
            .accounts
            .pending_order
            .cost_basis_usdc
            .checked_sub(recognized_refund_usdc)
            .ok_or(PactumError::MathOverflow)?;
        let minimum_outcome_atoms = dflow::prediction_v1::minimum_outcome_for_consumed_input(
            ctx.accounts.pending_order.quoted_outcome_atoms,
            ctx.accounts.pending_order.cost_basis_usdc,
            consumed_usdc,
            ctx.accounts.pending_order.slippage_bps,
        )?;
        require!(
            total_filled_outcome_atoms >= minimum_outcome_atoms,
            PactumError::InvalidDflowFixture
        );

        sweep_terminal_refund(
            &ctx.accounts.config,
            &ctx.accounts.vault_authority,
            &ctx.accounts.usdc_mint,
            &ctx.accounts.refund_usdc_ata,
            &ctx.accounts.vault_usdc,
            &ctx.accounts.token_program,
            refund_usdc,
        )?;

        ctx.accounts.config.open_exposure_usdc = ctx
            .accounts
            .config
            .open_exposure_usdc
            .checked_sub(recognized_refund_usdc)
            .ok_or(PactumError::MathOverflow)?;

        let exposure = &mut ctx.accounts.market_exposure;
        let creates_live_position = exposure.outcome_atoms == 0;
        if exposure.market_ledger == Pubkey::default() {
            exposure.market_ledger = ctx.accounts.approved_market.market_ledger;
            exposure.outcome_mint = ctx.accounts.outcome_mint.key();
            exposure.bump = ctx.bumps.market_exposure;
        } else {
            require_keys_eq!(
                exposure.market_ledger,
                ctx.accounts.approved_market.market_ledger,
                PactumError::InvalidMarketExposure
            );
            require_keys_eq!(
                exposure.outcome_mint,
                ctx.accounts.outcome_mint.key(),
                PactumError::InvalidMarketExposure
            );
        }

        exposure.cost_basis_usdc = exposure
            .cost_basis_usdc
            .checked_add(consumed_usdc)
            .ok_or(PactumError::MathOverflow)?;
        exposure.outcome_atoms = exposure
            .outcome_atoms
            .checked_add(total_filled_outcome_atoms)
            .ok_or(PactumError::MathOverflow)?;

        if creates_live_position {
            ctx.accounts.config.open_positions = ctx
                .accounts
                .config
                .open_positions
                .checked_add(1)
                .ok_or(PactumError::MathOverflow)?;
        }

        emit!(DflowOrderFinalized {
            keeper: ctx.accounts.keeper.key(),
            order_account: ctx.accounts.pending_order.order_account,
            market_ledger: exposure.market_ledger,
            outcome_mint: exposure.outcome_mint,
            consumed_usdc,
            refunded_usdc: recognized_refund_usdc,
            outcome_atoms: total_filled_outcome_atoms,
        });

        Ok(())
    }

    /// Unwind a terminal DFlow order that produced no outcome position.
    pub fn unwind_dflow_order(ctx: Context<UnwindDflowOrder>) -> Result<()> {
        require_dflow_order_closed(&ctx.accounts.order_account)?;

        let outcome_delta = ctx
            .accounts
            .outcome_ata
            .amount
            .checked_sub(ctx.accounts.pending_order.outcome_balance_start)
            .ok_or(PactumError::MathOverflow)?;
        require!(outcome_delta == 0, PactumError::InvalidDflowRefund);

        let refund_usdc = ctx
            .accounts
            .refund_usdc_ata
            .amount
            .checked_sub(ctx.accounts.pending_order.refund_usdc_balance_before)
            .ok_or(PactumError::MathOverflow)?;
        require!(
            refund_usdc >= ctx.accounts.pending_order.cost_basis_usdc,
            PactumError::InvalidDflowRefund
        );

        sweep_terminal_refund(
            &ctx.accounts.config,
            &ctx.accounts.vault_authority,
            &ctx.accounts.usdc_mint,
            &ctx.accounts.refund_usdc_ata,
            &ctx.accounts.vault_usdc,
            &ctx.accounts.token_program,
            refund_usdc,
        )?;

        ctx.accounts.config.open_exposure_usdc = ctx
            .accounts
            .config
            .open_exposure_usdc
            .checked_sub(ctx.accounts.pending_order.cost_basis_usdc)
            .ok_or(PactumError::MathOverflow)?;

        emit!(DflowOrderUnwound {
            keeper: ctx.accounts.keeper.key(),
            order_account: ctx.accounts.pending_order.order_account,
            market_ledger: ctx.accounts.pending_order.market_ledger,
            outcome_mint: ctx.accounts.pending_order.outcome_mint,
            refunded_usdc: ctx.accounts.pending_order.cost_basis_usdc,
        });

        Ok(())
    }

    /// Redeem a complete, tracked winning DFlow outcome position.
    ///
    /// This is deliberately available while paused and after a market is
    /// disabled so settlement/recovery cannot be administratively deadlocked.
    pub fn redeem_market_outcome(ctx: Context<RedeemMarketOutcome>) -> Result<()> {
        require!(
            ctx.accounts.pending_order.lamports() == 0
                && ctx.accounts.pending_order.data_is_empty(),
            PactumError::DflowOrderNotTerminal
        );

        let side = dflow::prediction_v1::OutcomeSide::from_mint(
            &ctx.accounts.approved_market,
            ctx.accounts.outcome_mint.key(),
        )?;

        let keys = dflow::prediction_v1::RedeemKeys {
            event_authority: ctx.accounts.event_authority.key(),
            market_ledger: ctx.accounts.market_ledger.key(),
            settlement_vault: ctx.accounts.settlement_vault.key(),
            outcome_account: ctx.accounts.outcome_account.key(),
            settlement_destination: ctx.accounts.vault_usdc.key(),
            usdc_mint: ctx.accounts.usdc_mint.key(),
            outcome_mint: ctx.accounts.outcome_mint.key(),
            token_authority: ctx.accounts.vault_authority.key(),
            token_2022_program: ctx.accounts.token_2022_program.key(),
            token_program: ctx.accounts.token_program.key(),
        };
        dflow::prediction_v1::validate_redeem_keys(
            &keys,
            &ctx.accounts.approved_market,
            side,
            ctx.accounts.vault_usdc.key(),
            ctx.accounts.vault_authority.key(),
        )?;

        require!(
            ctx.accounts.market_exposure.outcome_atoms > 0
                && ctx.accounts.config.open_positions > 0,
            PactumError::InvalidMarketExposure
        );
        math::validate_redeem_position(
            ctx.accounts.market_exposure.outcome_atoms,
            ctx.accounts.outcome_account.amount,
        )?;
        require!(
            ctx.accounts.outcome_mint.decimals == ctx.accounts.usdc_mint.decimals,
            PactumError::InvalidDflowAccounts
        );
        require!(
            ctx.accounts.config.open_exposure_usdc >= ctx.accounts.market_exposure.cost_basis_usdc,
            PactumError::InvalidMarketExposure
        );

        let outcome_before = ctx.accounts.outcome_account.amount;
        let usdc_before = ctx.accounts.vault_usdc.amount;

        let ix = Instruction {
            program_id: dflow::DFLOW_PREDICTION_MARKETS,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.dflow_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.market_ledger.key(), false),
                AccountMeta::new(ctx.accounts.settlement_vault.key(), false),
                AccountMeta::new(ctx.accounts.outcome_account.key(), false),
                AccountMeta::new(ctx.accounts.vault_usdc.key(), false),
                AccountMeta::new_readonly(ctx.accounts.usdc_mint.key(), false),
                AccountMeta::new(ctx.accounts.outcome_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_2022_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            data: dflow::prediction_v1::redeem_market_outcome_data().to_vec(),
        };

        let authority_bump = [ctx.accounts.config.vault_authority_bump];
        let authority_seeds: &[&[u8]] = &[b"vault_authority", &authority_bump];

        solana_cpi::invoke_signed(
            &ix,
            &[
                ctx.accounts.dflow_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.market_ledger.to_account_info(),
                ctx.accounts.settlement_vault.to_account_info(),
                ctx.accounts.outcome_account.to_account_info(),
                ctx.accounts.vault_usdc.to_account_info(),
                ctx.accounts.usdc_mint.to_account_info(),
                ctx.accounts.outcome_mint.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.token_2022_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.dflow_program.to_account_info(),
            ],
            &[authority_seeds],
        )?;

        ctx.accounts.outcome_account.reload()?;
        ctx.accounts.vault_usdc.reload()?;

        require!(
            ctx.accounts.outcome_account.amount == 0,
            PactumError::IncompleteRedemption
        );
        let payout = ctx
            .accounts
            .vault_usdc
            .amount
            .checked_sub(usdc_before)
            .ok_or(PactumError::MathOverflow)?;
        math::validate_terminal_redemption_payout(outcome_before, payout)?;

        let closed_cost_basis = ctx.accounts.market_exposure.cost_basis_usdc;
        ctx.accounts.config.open_exposure_usdc = ctx
            .accounts
            .config
            .open_exposure_usdc
            .checked_sub(closed_cost_basis)
            .ok_or(PactumError::MathOverflow)?;
        ctx.accounts.market_exposure.cost_basis_usdc = 0;
        ctx.accounts.market_exposure.outcome_atoms = 0;
        ctx.accounts.config.open_positions = ctx
            .accounts
            .config
            .open_positions
            .checked_sub(1)
            .ok_or(PactumError::MathOverflow)?;

        emit!(MarketRedeemed {
            market_ledger: ctx.accounts.market_ledger.key(),
            outcome_mint: ctx.accounts.outcome_mint.key(),
            redeemed_outcome_atoms: outcome_before,
            payout_usdc: payout,
            closed_cost_basis_usdc: closed_cost_basis,
        });

        Ok(())
    }

    /// Baseline instruction used by CI to detect compute-unit regressions.
    pub fn benchmark_noop(_ctx: Context<BenchmarkNoop>) -> Result<()> {
        Ok(())
    }

    /// Transitional production initializer for tracked exposure until the
    /// OpenUserOrder path can create it atomically from a confirmed DFlow fill.
    ///
    /// Admin-only by design: keepers must not be able to fabricate exposure and
    /// freeze deposits/withdrawals. This instruction cannot move vault funds.
    pub fn initialize_market_exposure(
        ctx: Context<InitializeMarketExposure>,
        cost_basis_usdc: u64,
        outcome_atoms: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, PactumError::VaultPaused);
        require!(
            cost_basis_usdc > 0 && outcome_atoms > 0,
            PactumError::ZeroAmount
        );
        math::validate_trade_amount(
            cost_basis_usdc,
            ctx.accounts.config.open_exposure_usdc,
            ctx.accounts.config.max_trade_usdc,
            ctx.accounts.config.max_total_exposure_usdc,
        )?;

        require!(
            ctx.accounts.approved_market.enabled,
            PactumError::MarketDisabled
        );
        let _side = dflow::prediction_v1::OutcomeSide::from_mint(
            &ctx.accounts.approved_market,
            ctx.accounts.outcome_mint.key(),
        )?;

        let exposure = &mut ctx.accounts.market_exposure;
        exposure.market_ledger = ctx.accounts.approved_market.market_ledger;
        exposure.outcome_mint = ctx.accounts.outcome_mint.key();
        exposure.cost_basis_usdc = cost_basis_usdc;
        exposure.outcome_atoms = outcome_atoms;
        exposure.bump = ctx.bumps.market_exposure;

        ctx.accounts.config.open_exposure_usdc = ctx
            .accounts
            .config
            .open_exposure_usdc
            .checked_add(cost_basis_usdc)
            .ok_or(PactumError::MathOverflow)?;
        ctx.accounts.config.open_positions = ctx
            .accounts
            .config
            .open_positions
            .checked_add(1)
            .ok_or(PactumError::MathOverflow)?;

        emit!(MarketExposureInitialized {
            market_ledger: exposure.market_ledger,
            outcome_mint: exposure.outcome_mint,
            cost_basis_usdc,
            outcome_atoms,
        });

        Ok(())
    }

    /// CI-only helper that creates tracked exposure for fork fixtures.
    #[cfg(feature = "test-hooks")]
    pub fn seed_market_exposure(
        ctx: Context<SeedMarketExposure>,
        cost_basis_usdc: u64,
        outcome_atoms: u64,
    ) -> Result<()> {
        require!(
            cost_basis_usdc > 0 && outcome_atoms > 0,
            PactumError::ZeroAmount
        );

        let exposure = &mut ctx.accounts.market_exposure;
        exposure.market_ledger = ctx.accounts.approved_market.market_ledger;
        exposure.outcome_mint = ctx.accounts.outcome_mint.key();
        exposure.cost_basis_usdc = cost_basis_usdc;
        exposure.outcome_atoms = outcome_atoms;
        exposure.bump = ctx.bumps.market_exposure;

        ctx.accounts.config.open_exposure_usdc = ctx
            .accounts
            .config
            .open_exposure_usdc
            .checked_add(cost_basis_usdc)
            .ok_or(PactumError::MathOverflow)?;
        ctx.accounts.config.open_positions = ctx
            .accounts
            .config
            .open_positions
            .checked_add(1)
            .ok_or(PactumError::MathOverflow)?;

        Ok(())
    }

    /// CI-only helper that seeds an asynchronous DFlow order awaiting fill reconciliation.
    #[cfg(feature = "test-hooks")]
    pub fn seed_pending_dflow_order(
        ctx: Context<SeedPendingDflowOrder>,
        cost_basis_usdc: u64,
        quoted_outcome_atoms: u64,
        outcome_balance_before: u64,
        slippage_bps: u16,
    ) -> Result<()> {
        require!(cost_basis_usdc > 0, PactumError::ZeroAmount);
        let _ = dflow::prediction_v1::minimum_outcome_atoms(quoted_outcome_atoms, slippage_bps)?;

        let pending = &mut ctx.accounts.pending_order;
        pending.order_account = ctx.accounts.order_account.key();
        pending.market_ledger = ctx.accounts.approved_market.market_ledger;
        pending.outcome_mint = ctx.accounts.outcome_mint.key();
        pending.cost_basis_usdc = cost_basis_usdc;
        pending.quoted_outcome_atoms = quoted_outcome_atoms;
        pending.outcome_balance_start = outcome_balance_before;
        pending.refund_usdc_balance_before = 0;
        pending.slippage_bps = slippage_bps;
        pending.bump = ctx.bumps.pending_order;

        ctx.accounts.config.open_exposure_usdc = ctx
            .accounts
            .config
            .open_exposure_usdc
            .checked_add(cost_basis_usdc)
            .ok_or(PactumError::MathOverflow)?;

        Ok(())
    }

    /// CI-only DFlow CPI smoke test. It intentionally sends invalid data to
    /// DFlow; the fork test passes only if simulation logs prove the inner
    /// DFlow invocation happened. This handler is absent in production builds.
    #[cfg(feature = "test-hooks")]
    pub fn probe_dflow_prediction_cpi(ctx: Context<ProbeDflowPredictionCpi>) -> Result<()> {
        let ix = Instruction {
            program_id: dflow::DFLOW_PREDICTION_MARKETS,
            accounts: vec![],
            data: dflow::DFLOW_CPI_PROBE_DATA.to_vec(),
        };

        invoke(&ix, &[ctx.accounts.dflow_program.to_account_info()]).map_err(Into::into)
    }

    /// CI-only fork probe for the observed OpenUserOrder account shape.
    ///
    /// Uses the same three repeated PDA signer roles as production execute_trade
    /// and the confirmed 80-byte action-0x40 payload shape. The fork test asserts
    /// that the CPI reaches the real DFlow PM program without signer escalation.
    #[cfg(feature = "test-hooks")]
    pub fn probe_dflow_open_order_pda(
        ctx: Context<ProbeDflowOpenOrderPda>,
        order_data: [u8; dflow::prediction_v1::OPEN_USER_ORDER_DATA_LEN],
    ) -> Result<()> {
        let ix = Instruction {
            program_id: dflow::DFLOW_PREDICTION_MARKETS,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.dflow_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.market_ledger.key(), false),
                AccountMeta::new(ctx.accounts.market_usdc_account.key(), false),
                AccountMeta::new(ctx.accounts.order_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.usdc_mint.key(), false),
                AccountMeta::new(ctx.accounts.source_usdc.key(), false),
                AccountMeta::new_readonly(ctx.accounts.probe_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.probe_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.probe_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: order_data.to_vec(),
        };

        let bump = [ctx.bumps.probe_authority];
        let seeds: &[&[u8]] = &[b"dflow_open_order_probe", &bump];

        solana_cpi::invoke_signed(
            &ix,
            &[
                ctx.accounts.dflow_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.market_ledger.to_account_info(),
                ctx.accounts.market_usdc_account.to_account_info(),
                ctx.accounts.order_account.to_account_info(),
                ctx.accounts.usdc_mint.to_account_info(),
                ctx.accounts.source_usdc.to_account_info(),
                ctx.accounts.probe_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.dflow_program.to_account_info(),
            ],
            &[seeds],
        )
        .map_err(Into::into)
    }

    /// CI-only probe for the evidence-backed DFlow funding path.
    ///
    /// A Pactum PDA transfers the exact order amount from PDA-owned USDC into
    /// the keeper's canonical USDC account. DFlow then spends from that
    /// keeper-owned source while the keeper is the authenticated wallet and
    /// the Pactum PDA is propagated as both fill and refund recipient signer.
    #[cfg(feature = "test-hooks")]
    pub fn probe_dflow_open_order_keeper_funded(
        ctx: Context<ProbeDflowOpenOrderKeeperFunded>,
        order_data: [u8; dflow::prediction_v1::OPEN_USER_ORDER_DATA_LEN],
        input_amount: u64,
    ) -> Result<()> {
        require!(input_amount > 0, PactumError::ZeroAmount);
        require!(
            ctx.accounts.keeper_usdc.amount == 0,
            PactumError::InvalidDflowSpend
        );

        let bump = [ctx.bumps.probe_authority];
        let authority_seeds: &[&[u8]] = &[b"dflow_open_order_probe", &bump];
        let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.source_usdc.to_account_info(),
                    to: ctx.accounts.keeper_usdc.to_account_info(),
                    authority: ctx.accounts.probe_authority.to_account_info(),
                },
                signer_seeds,
            ),
            input_amount,
        )?;

        ctx.accounts.keeper_usdc.reload()?;
        require!(
            ctx.accounts.keeper_usdc.amount == input_amount,
            PactumError::InvalidDflowSpend
        );

        let ix = Instruction {
            program_id: dflow::DFLOW_PREDICTION_MARKETS,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.dflow_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.market_ledger.key(), false),
                AccountMeta::new(ctx.accounts.market_usdc_account.key(), false),
                AccountMeta::new(ctx.accounts.order_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.usdc_mint.key(), false),
                AccountMeta::new(ctx.accounts.keeper_usdc.key(), false),
                AccountMeta::new(ctx.accounts.keeper.key(), true),
                AccountMeta::new_readonly(ctx.accounts.probe_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.probe_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: order_data.to_vec(),
        };

        solana_cpi::invoke_signed(
            &ix,
            &[
                ctx.accounts.dflow_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.market_ledger.to_account_info(),
                ctx.accounts.market_usdc_account.to_account_info(),
                ctx.accounts.order_account.to_account_info(),
                ctx.accounts.usdc_mint.to_account_info(),
                ctx.accounts.keeper_usdc.to_account_info(),
                ctx.accounts.keeper.to_account_info(),
                ctx.accounts.probe_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.dflow_program.to_account_info(),
            ],
            &[authority_seeds],
        )?;

        ctx.accounts.keeper_usdc.reload()?;
        require!(
            ctx.accounts.keeper_usdc.amount == 0,
            PactumError::InvalidDflowSpend
        );

        Ok(())
    }

    /// CI-only proof that Solana accepts a Pactum PDA as an inner DFlow signer.
    /// DFlow is expected to reject the deliberately invalid payload after entry.
    #[cfg(feature = "test-hooks")]
    pub fn probe_dflow_pda_signed_cpi(ctx: Context<ProbeDflowPdaSignedCpi>) -> Result<()> {
        let ix = Instruction {
            program_id: dflow::DFLOW_PREDICTION_MARKETS,
            accounts: vec![AccountMeta::new_readonly(
                ctx.accounts.probe_authority.key(),
                true,
            )],
            data: dflow::DFLOW_CPI_PROBE_DATA.to_vec(),
        };

        let bump = [ctx.bumps.probe_authority];
        let seeds: &[&[u8]] = &[b"dflow_cpi_probe", &bump];

        solana_cpi::invoke_signed(
            &ix,
            &[
                ctx.accounts.probe_authority.to_account_info(),
                ctx.accounts.dflow_program.to_account_info(),
            ],
            &[seeds],
        )
        .map_err(Into::into)
    }
}

fn require_dflow_order_closed(order_account: &UncheckedAccount<'_>) -> Result<()> {
    require!(
        order_account.lamports() == 0
            && order_account.data_is_empty()
            && *order_account.owner == anchor_lang::system_program::ID,
        PactumError::DflowOrderNotTerminal
    );
    Ok(())
}

fn sweep_terminal_refund<'info>(
    config: &Account<'info, VaultConfig>,
    vault_authority: &UncheckedAccount<'info>,
    usdc_mint: &Account<'info, Mint>,
    refund_usdc_ata: &Account<'info, TokenAccount>,
    vault_usdc: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    refund_usdc: u64,
) -> Result<()> {
    if refund_usdc == 0 {
        return Ok(());
    }

    let authority_bump = [config.vault_authority_bump];
    let authority_seeds: &[&[u8]] = &[b"vault_authority", &authority_bump];
    let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: refund_usdc_ata.to_account_info(),
                mint: usdc_mint.to_account_info(),
                to: vault_usdc.to_account_info(),
                authority: vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        refund_usdc,
        usdc_mint.decimals,
    )
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [b"config"],
        bump,
        space = 8 + VaultConfig::LEN
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA used only as the authority over Pactum-owned token accounts.
    #[account(seeds = [b"vault_authority"], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"usdc_vault"],
        bump,
        token::mint = usdc_mint,
        token::authority = vault_authority
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct RegisterMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: the market ledger is an external DFlow account and is stored as
    /// the registry key. Production trade CPI will additionally validate its
    /// owner/relationships on the fork-tested execution path.
    pub market_ledger: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [b"market", market_ledger.key().as_ref()],
        bump,
        space = 8 + ApprovedMarket::LEN
    )]
    pub approved_market: Account<'info, ApprovedMarket>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMarketEnabled<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [b"market", approved_market.market_ledger.as_ref()],
        bump = approved_market.bump
    )]
    pub approved_market: Account<'info, ApprovedMarket>,
}

#[derive(Accounts)]
pub struct AuthorizeMarketKeeper<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: market keeper need not sign when authorization is created.
    pub market_keeper: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [b"market_keeper", config.key().as_ref(), market_keeper.key().as_ref()],
        bump,
        space = 8 + MarketKeeperAuthorization::LEN
    )]
    pub market_keeper_authorization: Account<'info, MarketKeeperAuthorization>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeMarketKeeper<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: key is bound into the market-keeper authorization PDA.
    pub market_keeper: UncheckedAccount<'info>,

    #[account(
        mut,
        close = admin,
        seeds = [b"market_keeper", config.key().as_ref(), market_keeper.key().as_ref()],
        bump = market_keeper_authorization.bump,
        constraint = market_keeper_authorization.keeper == market_keeper.key()
    )]
    pub market_keeper_authorization: Account<'info, MarketKeeperAuthorization>,
}

#[derive(Accounts)]
pub struct UpdateMarketRegistry<'info> {
    #[account(mut)]
    pub market_keeper: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.config_bump
    )]
    pub config: Box<Account<'info, VaultConfig>>,

    #[account(
        seeds = [b"market_keeper", config.key().as_ref(), market_keeper.key().as_ref()],
        bump = market_keeper_authorization.bump,
        constraint = market_keeper_authorization.keeper == market_keeper.key()
    )]
    pub market_keeper_authorization: Box<Account<'info, MarketKeeperAuthorization>>,

    #[account(
        init_if_needed,
        payer = market_keeper,
        seeds = [b"market_registry"],
        bump,
        space = 8 + MarketRegistry::LEN
    )]
    pub market_registry: Box<Account<'info, MarketRegistry>>,

    /// CHECK: verified DFlow-owned current market ledger.
    #[account(
        mut,
        constraint = *current_market_ledger.owner == dflow::DFLOW_PREDICTION_MARKETS
    )]
    pub current_market_ledger: UncheckedAccount<'info>,

    #[account(
        token::mint = usdc_mint,
        token::authority = current_market_ledger
    )]
    pub current_market_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        constraint = *current_yes_mint.to_account_info().owner
            == dflow::prediction_v1::TOKEN_2022_PROGRAM
    )]
    pub current_yes_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(
        constraint = *current_no_mint.to_account_info().owner
            == dflow::prediction_v1::TOKEN_2022_PROGRAM
    )]
    pub current_no_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = market_keeper,
        seeds = [b"market", current_market_ledger.key().as_ref()],
        bump,
        space = 8 + ApprovedMarket::LEN
    )]
    pub current_approved_market: Box<Account<'info, ApprovedMarket>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyDflowWrapper<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.config_bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(
        seeds = [b"keeper", config.key().as_ref(), keeper.key().as_ref()],
        bump = keeper_authorization.bump,
        constraint = keeper_authorization.keeper == keeper.key()
    )]
    pub keeper_authorization: Box<Account<'info, KeeperAuthorization>>,
    #[account(seeds = [b"market_registry"], bump = market_registry.bump)]
    pub market_registry: Box<Account<'info, MarketRegistry>>,
    #[account(
        seeds = [b"market", approved_market.market_ledger.as_ref()],
        bump = approved_market.bump
    )]
    pub approved_market: Box<Account<'info, ApprovedMarket>>,
    /// CHECK: Fixed approved DFlow market ledger.
    #[account(address = approved_market.market_ledger,
        constraint = *market_ledger.owner == dflow::DFLOW_PREDICTION_MARKETS)]
    pub market_ledger: UncheckedAccount<'info>,
    #[account(address = approved_market.settlement_vault,
        token::mint = usdc_mint, token::authority = market_ledger)]
    pub market_usdc_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: DFlow order account identity is compared against the next instruction.
    pub order_account: UncheckedAccount<'info>,
    #[account(seeds = [b"vault_authority"], bump = config.vault_authority_bump)]
    /// CHECK: PDA used solely for recipient identity validation.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = config.usdc_vault, token::mint = usdc_mint,
        token::authority = vault_authority)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: Keeper funding account must be controlled by the keeper.
    #[account(token::mint = usdc_mint, token::authority = keeper)]
    pub keeper_usdc: Box<Account<'info, TokenAccount>>,
    #[account(constraint = outcome_mint.key() == approved_market.yes_mint ||
        outcome_mint.key() == approved_market.no_mint)]
    pub outcome_mint: Box<InterfaceAccount<'info, InterfaceMint>>,
    /// CHECK: Fixed DFlow program.
    #[account(address = dflow::DFLOW_PREDICTION_MARKETS)]
    pub dflow_program: UncheckedAccount<'info>,
    /// CHECK: Fixed DFlow event authority.
    #[account(address = dflow::prediction_v1::EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Solana instructions sysvar; sysvar address checked explicitly.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorizeKeeper<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: keeper need not sign when its authorization record is created.
    pub keeper: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [b"keeper", config.key().as_ref(), keeper.key().as_ref()],
        bump,
        space = 8 + KeeperAuthorization::LEN
    )]
    pub keeper_authorization: Account<'info, KeeperAuthorization>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeKeeper<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: key is bound into the keeper-authorization PDA.
    pub keeper: UncheckedAccount<'info>,

    #[account(
        mut,
        close = admin,
        seeds = [b"keeper", config.key().as_ref(), keeper.key().as_ref()],
        bump = keeper_authorization.bump,
        constraint = keeper_authorization.keeper == keeper.key()
    )]
    pub keeper_authorization: Account<'info, KeeperAuthorization>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA authority over the vault USDC account.
    #[account(
        seeds = [b"vault_authority"],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"position", config.key().as_ref(), user.key().as_ref()],
        bump,
        space = 8 + UserPosition::LEN
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = config.usdc_vault,
        token::mint = usdc_mint,
        token::authority = vault_authority
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA authority over the vault USDC account.
    #[account(
        seeds = [b"vault_authority"],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"position", config.key().as_ref(), user.key().as_ref()],
        bump = user_position.bump,
        constraint = user_position.owner == user.key()
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = config.usdc_vault,
        token::mint = usdc_mint,
        token::authority = vault_authority
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteTrade<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump
    )]
    pub config: Box<Account<'info, VaultConfig>>,

    #[account(
        seeds = [b"keeper", config.key().as_ref(), keeper.key().as_ref()],
        bump = keeper_authorization.bump,
        constraint = keeper_authorization.keeper == keeper.key()
    )]
    pub keeper_authorization: Box<Account<'info, KeeperAuthorization>>,

    #[account(
        seeds = [b"market_registry"],
        bump = market_registry.bump
    )]
    pub market_registry: Box<Account<'info, MarketRegistry>>,

    #[account(
        seeds = [b"market", approved_market.market_ledger.as_ref()],
        bump = approved_market.bump
    )]
    pub approved_market: Box<Account<'info, ApprovedMarket>>,

    /// CHECK: DFlow-owned approved market ledger.
    #[account(
        mut,
        address = approved_market.market_ledger,
        constraint = *market_ledger.owner == dflow::DFLOW_PREDICTION_MARKETS
    )]
    pub market_ledger: UncheckedAccount<'info>,

    #[account(
        mut,
        address = approved_market.settlement_vault,
        token::mint = usdc_mint,
        token::authority = market_ledger
    )]
    pub market_usdc_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: DFlow creates and owns this user-order account during OpenUserOrder.
    #[account(mut)]
    pub order_account: UncheckedAccount<'info>,

    /// CHECK: Pactum PDA that permanently owns vault custody token accounts.
    #[account(
        seeds = [b"vault_authority"],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = config.usdc_vault,
        token::mint = usdc_mint,
        token::authority = vault_authority
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = keeper,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub refund_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        constraint = *outcome_mint.to_account_info().owner
            == dflow::prediction_v1::TOKEN_2022_PROGRAM
    )]
    pub outcome_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(
        init_if_needed,
        payer = keeper,
        associated_token::mint = outcome_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_2022_program
    )]
    pub outcome_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(
        init,
        payer = keeper,
        seeds = [b"pending_order", config.key().as_ref()],
        bump,
        space = 8 + PendingDflowOrder::LEN
    )]
    pub pending_order: Box<Account<'info, PendingDflowOrder>>,

    pub token_2022_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    /// CHECK: fixed DFlow event authority.
    #[account(address = dflow::prediction_v1::EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: fixed DFlow Prediction Markets program.
    #[account(address = dflow::DFLOW_PREDICTION_MARKETS)]
    pub dflow_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FinalizeDflowFilledOrder<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump
    )]
    pub config: Box<Account<'info, VaultConfig>>,

    #[account(
        seeds = [b"keeper", config.key().as_ref(), keeper.key().as_ref()],
        bump = keeper_authorization.bump,
        constraint = keeper_authorization.keeper == keeper.key()
    )]
    pub keeper_authorization: Box<Account<'info, KeeperAuthorization>>,

    #[account(
        seeds = [b"market", approved_market.market_ledger.as_ref()],
        bump = approved_market.bump
    )]
    pub approved_market: Box<Account<'info, ApprovedMarket>>,

    /// CHECK: terminal proof requires this exact stored DFlow order account to be closed.
    #[account(address = pending_order.order_account)]
    pub order_account: UncheckedAccount<'info>,

    /// CHECK: Pactum PDA owning all custody token accounts.
    #[account(
        seeds = [b"vault_authority"],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = config.usdc_vault,
        token::mint = usdc_mint,
        token::authority = vault_authority
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub refund_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        constraint = *outcome_mint.to_account_info().owner
            == dflow::prediction_v1::TOKEN_2022_PROGRAM
    )]
    pub outcome_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(
        associated_token::mint = outcome_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_2022_program
    )]
    pub outcome_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(
        mut,
        close = keeper,
        seeds = [b"pending_order", config.key().as_ref()],
        bump = pending_order.bump,
        constraint = pending_order.market_ledger == approved_market.market_ledger,
        constraint = pending_order.outcome_mint == outcome_mint.key()
    )]
    pub pending_order: Box<Account<'info, PendingDflowOrder>>,

    #[account(
        init_if_needed,
        payer = keeper,
        seeds = [
            b"exposure",
            config.key().as_ref(),
            approved_market.market_ledger.as_ref(),
            outcome_mint.key().as_ref()
        ],
        bump,
        space = 8 + MarketExposure::LEN
    )]
    pub market_exposure: Box<Account<'info, MarketExposure>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnwindDflowOrder<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump
    )]
    pub config: Box<Account<'info, VaultConfig>>,

    #[account(
        seeds = [b"keeper", config.key().as_ref(), keeper.key().as_ref()],
        bump = keeper_authorization.bump,
        constraint = keeper_authorization.keeper == keeper.key()
    )]
    pub keeper_authorization: Box<Account<'info, KeeperAuthorization>>,

    #[account(
        seeds = [b"market", approved_market.market_ledger.as_ref()],
        bump = approved_market.bump
    )]
    pub approved_market: Box<Account<'info, ApprovedMarket>>,

    /// CHECK: terminal proof requires this exact stored DFlow order account to be closed.
    #[account(address = pending_order.order_account)]
    pub order_account: UncheckedAccount<'info>,

    /// CHECK: Pactum PDA owning all custody token accounts.
    #[account(
        seeds = [b"vault_authority"],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = config.usdc_vault,
        token::mint = usdc_mint,
        token::authority = vault_authority
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub refund_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        constraint = *outcome_mint.to_account_info().owner
            == dflow::prediction_v1::TOKEN_2022_PROGRAM
    )]
    pub outcome_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(
        associated_token::mint = outcome_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_2022_program
    )]
    pub outcome_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(
        mut,
        close = keeper,
        seeds = [b"pending_order", config.key().as_ref()],
        bump = pending_order.bump,
        constraint = pending_order.market_ledger == approved_market.market_ledger,
        constraint = pending_order.outcome_mint == outcome_mint.key()
    )]
    pub pending_order: Box<Account<'info, PendingDflowOrder>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemMarketOutcome<'info> {
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump
    )]
    pub config: Box<Account<'info, VaultConfig>>,

    #[account(
        seeds = [b"keeper", config.key().as_ref(), keeper.key().as_ref()],
        bump = keeper_authorization.bump,
        constraint = keeper_authorization.keeper == keeper.key()
    )]
    pub keeper_authorization: Box<Account<'info, KeeperAuthorization>>,

    #[account(
        seeds = [b"market", approved_market.market_ledger.as_ref()],
        bump = approved_market.bump
    )]
    pub approved_market: Box<Account<'info, ApprovedMarket>>,

    /// CHECK: external DFlow-owned ledger, pinned to the approved market.
    #[account(
        mut,
        address = approved_market.market_ledger,
        constraint = *market_ledger.owner == dflow::DFLOW_PREDICTION_MARKETS
    )]
    pub market_ledger: UncheckedAccount<'info>,

    #[account(
        mut,
        address = approved_market.settlement_vault,
        token::mint = usdc_mint,
        token::authority = market_ledger
    )]
    pub settlement_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Pactum PDA that signs DFlow token-authority roles.
    #[account(
        seeds = [b"vault_authority"],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = config.usdc_vault,
        token::mint = usdc_mint,
        token::authority = vault_authority
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = *outcome_account.to_account_info().owner
            == dflow::prediction_v1::TOKEN_2022_PROGRAM,
        constraint = outcome_account.mint == outcome_mint.key(),
        constraint = outcome_account.owner == vault_authority.key()
    )]
    pub outcome_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(
        mut,
        constraint = *outcome_mint.to_account_info().owner
            == dflow::prediction_v1::TOKEN_2022_PROGRAM
    )]
    pub outcome_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(
        mut,
        seeds = [
            b"exposure",
            config.key().as_ref(),
            approved_market.market_ledger.as_ref(),
            outcome_mint.key().as_ref()
        ],
        bump = market_exposure.bump,
        constraint = market_exposure.market_ledger == approved_market.market_ledger,
        constraint = market_exposure.outcome_mint == outcome_mint.key()
    )]
    pub market_exposure: Box<Account<'info, MarketExposure>>,

    /// CHECK: singleton pending-order PDA. Redemption requires this account to be absent.
    #[account(
        seeds = [b"pending_order", config.key().as_ref()],
        bump
    )]
    pub pending_order: UncheckedAccount<'info>,

    /// CHECK: fixed DFlow event-authority account.
    #[account(address = dflow::prediction_v1::EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: fixed Token-2022 program.
    #[account(address = dflow::prediction_v1::TOKEN_2022_PROGRAM)]
    pub token_2022_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: fixed, executable DFlow prediction-market program.
    #[account(address = dflow::DFLOW_PREDICTION_MARKETS)]
    pub dflow_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BenchmarkNoop {}

#[derive(Accounts)]
pub struct InitializeMarketExposure<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        seeds = [b"market", approved_market.market_ledger.as_ref()],
        bump = approved_market.bump
    )]
    pub approved_market: Account<'info, ApprovedMarket>,

    #[account(
        constraint = *outcome_mint.to_account_info().owner
            == dflow::prediction_v1::TOKEN_2022_PROGRAM
    )]
    pub outcome_mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(
        init,
        payer = admin,
        seeds = [
            b"exposure",
            config.key().as_ref(),
            approved_market.market_ledger.as_ref(),
            outcome_mint.key().as_ref()
        ],
        bump,
        space = 8 + MarketExposure::LEN
    )]
    pub market_exposure: Account<'info, MarketExposure>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-hooks")]
#[derive(Accounts)]
pub struct SeedMarketExposure<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        seeds = [b"market", approved_market.market_ledger.as_ref()],
        bump = approved_market.bump
    )]
    pub approved_market: Account<'info, ApprovedMarket>,

    /// CHECK: test fixture only; the production redeem path validates Token-2022 ownership.
    pub outcome_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [
            b"exposure",
            config.key().as_ref(),
            approved_market.market_ledger.as_ref(),
            outcome_mint.key().as_ref()
        ],
        bump,
        space = 8 + MarketExposure::LEN
    )]
    pub market_exposure: Account<'info, MarketExposure>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-hooks")]
#[derive(Accounts)]
pub struct SeedPendingDflowOrder<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.config_bump,
        has_one = admin
    )]
    pub config: Account<'info, VaultConfig>,

    #[account(
        seeds = [b"market", approved_market.market_ledger.as_ref()],
        bump = approved_market.bump
    )]
    pub approved_market: Account<'info, ApprovedMarket>,

    /// CHECK: synthetic DFlow-owned order account for fork reconciliation setup.
    pub order_account: UncheckedAccount<'info>,

    #[account(
        constraint = *outcome_mint.to_account_info().owner
            == dflow::prediction_v1::TOKEN_2022_PROGRAM
    )]
    pub outcome_mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"pending_order", config.key().as_ref()],
        bump,
        space = 8 + PendingDflowOrder::LEN
    )]
    pub pending_order: Account<'info, PendingDflowOrder>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-hooks")]
#[derive(Accounts)]
pub struct ProbeDflowPredictionCpi<'info> {
    /// CHECK: pinned to the known DFlow prediction-market program.
    #[account(address = dflow::DFLOW_PREDICTION_MARKETS)]
    pub dflow_program: UncheckedAccount<'info>,
}

#[cfg(feature = "test-hooks")]
#[derive(Accounts)]
pub struct ProbeDflowOpenOrderPda<'info> {
    /// CHECK: deterministic CI-only PDA standing in for VaultAuthority signer roles.
    #[account(seeds = [b"dflow_open_order_probe"], bump)]
    pub probe_authority: UncheckedAccount<'info>,

    /// CHECK: fixed DFlow event authority.
    #[account(address = dflow::prediction_v1::EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: forked DFlow market ledger supplied by the test fixture.
    #[account(mut)]
    pub market_ledger: UncheckedAccount<'info>,

    /// CHECK: forked DFlow market USDC account supplied by the test fixture.
    #[account(mut)]
    pub market_usdc_account: UncheckedAccount<'info>,

    /// CHECK: candidate DFlow order account. DFlow may reject it after CPI entry.
    #[account(mut)]
    pub order_account: UncheckedAccount<'info>,

    /// CHECK: canonical mainnet USDC mint.
    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: UncheckedAccount<'info>,

    /// CHECK: PDA-owned source USDC fixture seeded by Surfpool.
    #[account(mut)]
    pub source_usdc: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: fixed DFlow prediction-market program.
    #[account(address = dflow::DFLOW_PREDICTION_MARKETS)]
    pub dflow_program: UncheckedAccount<'info>,
}
#[cfg(feature = "test-hooks")]
#[derive(Accounts)]
pub struct ProbeDflowOpenOrderKeeperFunded<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    /// CHECK: deterministic CI-only PDA that owns the funding USDC account.
    #[account(seeds = [b"dflow_open_order_probe"], bump)]
    pub probe_authority: UncheckedAccount<'info>,

    /// CHECK: fixed DFlow event authority.
    #[account(address = dflow::prediction_v1::EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: forked DFlow market ledger supplied by the test fixture.
    #[account(mut)]
    pub market_ledger: UncheckedAccount<'info>,

    /// CHECK: forked DFlow market USDC account supplied by the test fixture.
    #[account(mut)]
    pub market_usdc_account: UncheckedAccount<'info>,

    /// CHECK: candidate DFlow order account.
    #[account(mut)]
    pub order_account: UncheckedAccount<'info>,

    /// CHECK: canonical mainnet USDC mint.
    #[account(address = dflow::USDC_MINT)]
    pub usdc_mint: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = probe_authority
    )]
    pub source_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = keeper
    )]
    pub keeper_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: fixed DFlow prediction-market program.
    #[account(address = dflow::DFLOW_PREDICTION_MARKETS)]
    pub dflow_program: UncheckedAccount<'info>,
}

#[cfg(feature = "test-hooks")]
#[derive(Accounts)]
pub struct ProbeDflowPdaSignedCpi<'info> {
    /// CHECK: deterministic CI-only PDA; it need not hold data or lamports.
    #[account(seeds = [b"dflow_cpi_probe"], bump)]
    pub probe_authority: UncheckedAccount<'info>,

    /// CHECK: pinned to the known DFlow prediction-market program.
    #[account(address = dflow::DFLOW_PREDICTION_MARKETS)]
    pub dflow_program: UncheckedAccount<'info>,
}

#[event]
pub struct VaultInitialized {
    pub admin: Pubkey,
    pub usdc_vault: Pubkey,
    pub max_trade_usdc: u64,
    pub max_total_exposure_usdc: u64,
    pub min_liquidity_buffer_usdc: u64,
}

#[event]
pub struct PauseChanged {
    pub paused: bool,
}

#[event]
pub struct RiskLimitsChanged {
    pub max_trade_usdc: u64,
    pub max_total_exposure_usdc: u64,
    pub min_liquidity_buffer_usdc: u64,
}

#[event]
pub struct MarketChanged {
    pub market_ledger: Pubkey,
    pub enabled: bool,
}

#[event]
pub struct MarketKeeperChanged {
    pub keeper: Pubkey,
    pub authorized: bool,
}

#[event]
pub struct MarketRegistryUpdated {
    pub sequence: u64,
    pub observed_slot: u64,
    pub previous_market: Pubkey,
    pub current_market: Pubkey,
    pub next_market: Pubkey,
}

#[event]
pub struct KeeperChanged {
    pub keeper: Pubkey,
    pub authorized: bool,
}

#[event]
pub struct DflowOrderOpened {
    pub keeper: Pubkey,
    pub order_account: Pubkey,
    pub market_ledger: Pubkey,
    pub outcome_mint: Pubkey,
    pub input_usdc: u64,
    pub quoted_outcome_atoms: u64,
    pub slippage_bps: u16,
}

#[event]
pub struct DflowOrderFinalized {
    pub keeper: Pubkey,
    pub order_account: Pubkey,
    pub market_ledger: Pubkey,
    pub outcome_mint: Pubkey,
    pub consumed_usdc: u64,
    pub refunded_usdc: u64,
    pub outcome_atoms: u64,
}

#[event]
pub struct DflowOrderUnwound {
    pub keeper: Pubkey,
    pub order_account: Pubkey,
    pub market_ledger: Pubkey,
    pub outcome_mint: Pubkey,
    pub refunded_usdc: u64,
}

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct WithdrawalEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct MarketExposureInitialized {
    pub market_ledger: Pubkey,
    pub outcome_mint: Pubkey,
    pub cost_basis_usdc: u64,
    pub outcome_atoms: u64,
}

#[event]
pub struct MarketRedeemed {
    pub market_ledger: Pubkey,
    pub outcome_mint: Pubkey,
    pub redeemed_outcome_atoms: u64,
    pub payout_usdc: u64,
    pub closed_cost_basis_usdc: u64,
}
