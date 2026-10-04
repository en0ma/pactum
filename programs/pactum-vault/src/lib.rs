use anchor_lang::prelude::*;

#[cfg(feature = "test-hooks")]
use solana_cpi::invoke;
#[cfg(feature = "test-hooks")]
use solana_instruction::Instruction;

pub mod dflow;

declare_id!("AJnBVG77ZQnMLyeTuf9JoKhvaDFzFQZhtCBnzHgWFBTw");

#[program]
pub mod pactum_vault {
    use super::*;

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
