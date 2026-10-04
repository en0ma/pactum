# Pactum testing strategy

Pactum keeps the trading bot outside this repository. The only off-chain keeper
integration surface is the Pactum on-chain program.

## Layers

### Build and lint

CI runs Rust formatting, Clippy, a production Anchor build, and a second build
with the `test-hooks` feature.

The production binary does **not** contain the DFlow CPI probe.

### Surfpool mainnet fork

The integration job starts Surfpool against Solana mainnet. Accounts and
programs are fetched lazily from the upstream RPC, allowing Pactum tests to
exercise the deployed DFlow programs rather than mocks.

For reliable CI, configure the GitHub Actions secret:

`MAINNET_RPC_URL`

The workflow falls back to Solana's public mainnet RPC, which can rate-limit.

### DFlow CPI smoke test

The test-only `probe_dflow_prediction_cpi` handler CPIs into:

`pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb`

with deliberately invalid instruction data.

The transaction is expected to fail **inside DFlow**. CI passes only when the
simulation logs prove the DFlow prediction-market program was invoked at CPI
stack depth 2. This proves CPI reachability without pretending Pactum already
has a stable production DFlow ABI.

Once the decoded DFlow ABI and fixtures are frozen, replace/augment the probe
with successful fork tests for:

- PDA-owned USDC -> prediction order open
- asynchronous fill reconciliation
- wrong market / mint / destination rejection
- refund path
- resolved winning outcome -> USDC redemption
- no externally controlled principal withdrawal path

### CU and transaction-fee budgets

The fork suite records and gates:

| Path | Current ceiling |
| --- | ---: |
| `benchmark_noop` | 12,000 CU |
| DFlow CPI probe | 80,000 CU |
| base transaction fee | 10,000 lamports |

These values are regression guardrails, not production priority-fee estimates.
Production transactions should simulate immediately before submission and use
an appropriately padded compute-unit limit.

## Local execution

Prerequisites:

- Rust 1.89+
- Solana/Agave 3.1.10
- Anchor 1.1.2
- Node 20.18+
- Surfpool

Run:

```bash
npm install
MAINNET_RPC_URL="https://your-mainnet-rpc" npm run test:fork:ci
```

The suite uses a disposable local payer and never submits transactions to
mainnet.
