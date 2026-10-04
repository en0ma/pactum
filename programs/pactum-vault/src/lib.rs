#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[cfg(feature = "test-hooks")]
use solana_cpi::invoke;
#[cfg(feature = "test-hooks")]
use solana_instruction::{AccountMeta, Instruction};

pub mod dflow;
pub mod error;
pub mod math;
pub mod state;

use error::PactumError;
use state::{ApprovedMarket, KeeperAuthorization, UserPosition, VaultConfig};

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
            ctx.accounts.config.open_exposure_usdc == 0,
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
            ctx.accounts.config.open_exposure_usdc == 0,
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

    /// Baseline instruction used by CI to detect compute-unit regressions.
    pub fn benchmark_noop(_ctx: Context<BenchmarkNoop>) -> Result<()> {
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
pub struct BenchmarkNoop {}

#[cfg(feature = "test-hooks")]
#[derive(Accounts)]
pub struct ProbeDflowPredictionCpi<'info> {
    /// CHECK: pinned to the known DFlow prediction-market program.
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
pub struct KeeperChanged {
    pub keeper: Pubkey,
    pub authorized: bool,
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
