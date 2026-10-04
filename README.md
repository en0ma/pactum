# Pactum

Pactum is a non-custodial Solana vault protocol for pooled prediction-market
strategies.

The strategy bot lives outside this repository. It is an untrusted keeper from
the protocol's point of view: it may request allowed actions, but it must never
hold or receive staker principal.

## Repository scope

- Anchor/Solana vault program
- DFlow prediction-market adapter
- security invariants and accounting
- unit/integration tests
- Surfpool mainnet-fork tests
- compute-unit and transaction-fee regression budgets
- GitHub Actions

Not included:

- trading model
- Python strategy bot
- private keys or deployment secrets

## DFlow integration

Pactum targets the DFlow prediction-market program on Solana:

`pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb`

and isolates DFlow-specific constants/ABI code under
`programs/pactum-vault/src/dflow.rs`.

The current fork suite contains a CI-only CPI reachability probe. Successful
order-open and redemption CPI fixtures are the next integration milestone.

## Development

See [docs/testing.md](docs/testing.md).

> Early development. Not audited. Do not use with production funds.
