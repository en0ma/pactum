# DFlow keeper execution: verified code versus target architecture

## Current implementation (reviewed 2026-10-09)

- Admin calls `authorize_market_keeper`; its authorization PDA gates `update_market_registry`.
- The market keeper can publish `previous`, `current`, `next` market records with ordered intervals, incrementing sequence, and a current entry at the chain clock timestamp. Current market ledger is required to be owned by the DFlow Prediction Markets program; settlement USDC and Token-2022 mint constraints are checked.
- Admin separately authorizes strategy keepers through `authorize_keeper`.
- `execute_trade` currently takes DFlow's 80-byte OpenUserOrder instruction **data**, not a pre-signed external transaction. It verifies market registry, approved market, amount, slippage and recipient role pubkeys and invokes the DFlow Prediction Markets program by CPI.
- This production path grants the keeper an exact-amount SPL *delegate allowance* on the PDA-owned USDC vault for the duration of the CPI, then revokes it and verifies vault USDC spent equals input amount. It does **not** transfer USDC to a keeper-owned ATA first.
- Keeper-funded DFlow transfer-then-CPI exists only as a `#[cfg(feature = "test-hooks")]` probe. It is not a production instruction.

## Requested keeper-wrapped signed DFlow transaction

The proposed flow is not implemented. A Solana program cannot authenticate an entire independent pre-signed transaction merely by receiving its bytes, nor compel a **separate** transaction to execute afterward. The Solana transaction submitted to RPC must be constructed and signed over one final message, with Pactum and DFlow instructions arranged in it; adding Pactum instructions to an already-signed message invalidates its signatures and requires re-signing. Even if an instruction introspects sibling instructions using the Instructions sysvar, the protocol needs explicit validation of all relevant writable accounts, destination/refund/revert roles, input mint and amount, authorized programs, order identities, and atomic transaction ordering.

**Never release keeper-owned USDC in one transaction trusting the keeper to send a different DFlow transaction later.** A keeper can retain or redirect funds. An RPC relay is not an enforcement boundary. If funding a keeper ATA becomes necessary, it must be conditional on a single atomic Solana transaction whose subsequent DFlow execution is verified and whose failure rolls back the funding, or use another on-chain escrow/custody design with enforced reclaimability. DFlow asynchronous *fill* can happen in later transactions; the funding/open-order step still needs custody protection.

## Read-only quote inspector

`scripts/probe-dflow-quote-inspection.mjs` supports:

- Offline: `DFLOW_ORDER_RESPONSE_FILE=path/to/order-response.json node scripts/probe-dflow-quote-inspection.mjs`
- Read-only authenticated GET: set `DFLOW_API_KEY`, `DFLOW_PROBE_OUTPUT_MINT` (verified Kalshi outcome mint), `DFLOW_PROBE_USER` (public key), optionally `DFLOW_EXPECTED_VAULT_AUTHORITY`, `MAINNET_RPC_URL`, and run the script.
- Production default API URL is `https://quote-api.dflow.net`. A different host can be provided with `DFLOW_TRADE_API_URL`.

The inspector exposes required signer/writable flags, account indices, resolved address lookup tables when RPC is available, program IDs and hex instruction data, plus advisory role comparisons. It does not execute, sign, simulate, or broadcast. It **does not certify the quote as safe**; API metadata may omit refund/revert fields, and on-chain account roles must be validated against the DFlow instruction ABI. The JSON report always marks `safety.executable=false`. No public key is a substitute for proof that the mint belongs to an active Kalshi-backed market.

The PR CI probe skips live API requests if the key/mint/user configuration is missing, retaining an explanatory report. Live access may require a DFlow API key and jurisdiction eligibility.

## Blocking validation items

1. Verify an active Kalshi-backed outcome mint and its market ledger/settlement vault independently.
2. Obtain a real unsigned DFlow `/order` response and resolve all ALTs; audit every instruction, including pre/post instructions, signer flags, output custody and revert path.
3. Decide whether to continue direct CPI with a temporary delegate (current production code) or implement **atomic** keeper-ATA funding plus DFlow order opening. Do not confuse the latter with a separately submitted signed transaction.
4. Reproduce DFlow open-order execution and terminal fill/revert reconciliation on mainnet fork with a verified quote before enabling real funds.
5. Validate order recipient accounts and all refund/revert paths on-chain; never rely on an off-chain inspection report as an enforcement check.
