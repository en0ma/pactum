## Experimental V2 trade-snapshot accounts — not yet an entitlement ledger

`trade_snapshots.rs` now defines a per-vault, immutable trade-opening record containing trade ID, keeper, active share supply and bot fee rate. A participant checkpoint PDA can record a wallet's shares for that trade. Tests cover vault-isolated addresses. **These are scaffolding, not a secure snapshot implementation:** participant checkpoints occur in separate transactions, so a changing depositor position may not match its historical trade-open share count (even if total supply later returns to the same value). PnL routing **must not use these records** until snapshot creation is atomic, complete or provably authentic against historical ownership; the verifier must bind the trade ID to a real on-chain DFlow open and enforce single-use settlement. Likewise deposits cannot yet bypass the exposure-open guard. No production trading, fee routing or unrestricted active deposits are enabled.

# Vault V2 accounting: trade-open participation and settlement waterfall

## Superseding decision: immediate active deposits, trade-open snapshots

The earlier pending-deposit queue is **superseded as the target UX**. Deposits should be accepted as active capital immediately and participate in the **next trade opened after the deposit**, without claiming wins or losses from any already-open trades. Existing pending-deposit instructions remain experimental code for now, not the desired final deposit route.

Every trade must record immutable opening-state data: the vault, DFlow order identity, active share supply, trading bot and fee split in force when it opened. Each depositor's eligibility must likewise be checkpointed **at opening**, or proven from a tamper-resistant per-user share-history mechanism. Neither current share balances nor a global NAV after settlement can reconstruct earlier ownership.

**Critical:** trade-opening snapshots alone are insufficient to allow unrestricted same-pool deposits: if late capital is minted at liquid-USDC-only NAV while outstanding positions exist, the new shares may purchase claims on old positions and dilute previous owners. The implementation must combine snapshot PnL attribution with cohort-aware NAV/claim accounting and withdrawal constraints. Only then can the exposure-open rejection in `deposit_vault_v2` be removed. Capital deposited after one trade opens may finance a subsequent trade, but is never retroactively assigned to the prior trade.

Prototype arithmetic `pnl_for_trade_open_shares` and negative tests now demonstrate the entitlement rule; this is not the full on-chain entitlement ledger or a production deposit handler.

## Product rules confirmed

1. Each vault independently defines a bot's performance-fee share; every vault reads the same protocol market registry.
2. **At the moment a trade opens**, snapshot the eligible depositors and their pro-rata participation in that trade. A depositor who joins after that snapshot receives **no PnL from that already-open trade**, whether it wins or loses.
3. The depositor becomes eligible for **new trades opened after their deposit has been accepted**. Participation is based on capital/shares effective at each new trade's opening, not the deposit time alone.
4. For **each winning trade**, after authentic terminal settlement and reconciliation of cost basis, calculate the realized profit and transfer: **1% of trade profit to the protocol treasury**, the vault-configured bot share to that vault's authorized bot payout account, and the remaining profit to **that vault** for the participating depositors.
5. Losing trades generate no protocol or bot performance fee. Their realized loss is borne by that trade's snapshotted participating capital pro rata.
6. Fee payouts must only happen once per terminal trade and only in actual available settlement USDC. Pending/partially filled DFlow orders cannot trigger early profit payouts. Track refundable principal, realized loss and every payout separately.
7. A bot assigned to more than one vault has no cross-vault accounting rights. Bot replacement must not redirect an earlier trade's earned fee without an explicit fee-beneficiary policy.

## Fee order and example

Current V2 calculation defines the bot share as a percentage **of the profit remaining after** the 1% protocol fee:

- Winning trade profit = 100 USDC
- Protocol fee = 1 USDC
- Post-protocol profit = 99 USDC
- Example configured bot share = 20% of 99 = 19.80 USDC
- Depositor profit returned to the vault = 79.20 USDC
- Trade principal is returned to the vault separately

No fees are charged on trade principal. Rates must use integer atomic USDC and be frozen per trade at opening (or an expressly versioned alternative) so changing vault configuration while a trade is open cannot retroactively change a payout.

**The per-winning-trade fee model does not imply a high-water-mark or loss carryforward.** If those protections are wanted, they must be specified separately; otherwise a profitable trade following a loss still pays performance fees on that trade's own positive profit.

## Time-specific example

- Alice deposits 100 USDC.
- Trade #1 opens: participation snapshot contains Alice only.
- Bob deposits 100 USDC while Trade #1 remains open.
- Trade #1 settles +40 USDC gross profit: the protocol and bot receive their fees; Alice alone earns the remaining profit. Bob gets none of Trade #1's upside or downside.
- Trade #2 opens after Bob's deposit: Alice and Bob participate pro rata based on their **actual eligible capital at Trade #2 opening**, which may differ after Trade #1 settlement.

## Accounting model needed

Use trade-specific participation records / shares and locked cost basis (or a rigorously equivalent epoch/cohort accounting mechanism). Do **not** simply split trade PnL by depositor shares at settlement: a new depositor could receive a share of a position opened before their deposit.

The custody and NAV model must prevent deposits made during open orders from implicitly buying an economic claim on those earlier orders. This requires separately tracking existing position receivables, unsettled exposures and post-entry capital, and supporting fee-inclusive NAV per cohort. Withdrawal requests also need to respect each depositor's commitments to open trades.

Fundamental invariants:
- Sum of each trade's depositor PnL allocations equals **realized trade PnL after protocol/bot fees** (positive or negative).
- Protocol + bot + vault net profit = exactly the trade's positive realized profit (allowing for integer rounding dust held by vault).
- No claim on an older trade is transferred to a newer depositor by depositing or withdrawing.
- The registered bot is the trading signer; fee beneficiary is fixed/verifiable and cannot be replaced by arbitrary keeper-supplied account metas.
- Settlement/payout is idempotent; fees cannot be double paid.
- Fees are paid from **verified settlement proceeds**, never advance-funded from vault principal.

## Implementation state

`programs/pactum-vault/src/accounting.rs` implements the fixed 1% protocol arithmetic and configurable bot share of remaining positive profit, **not** on-chain fee transfers or trade-specific entitlement snapshots. `VaultV2` stores `trader_profit_share_bps`, settable by admin via `set_vault_trader_fee_v2`.

V2 now has **request_pending_deposit_v2**, **cancel_pending_deposit_v2** and **activate_pending_deposit_v2**. Requests transfer USDC into a separate, per-vault escrow and do not mint active shares, so Bob may request a deposit during Trade #1. A user may cancel some/all pending USDC from escrow at any time, before activation. At a no-open-exposure cutoff, activation transfers pending USDC into the active vault and mints shares at the active, post-settlement NAV. A fresh trade after activation may include Bob.

**Important:** Current activation checks `open_exposure_usdc == 0 && open_positions == 0` but does **not yet** prove all fee transfers and realized PnL snapshots have been reconciled. Pending activation must remain disabled in live deployments until that settlement checkpoint is enforceable. The previous direct `deposit_vault_v2` still exists and is restricted to exposure-free states; UI should use the pending request flow. Live DFlow execution, per-trade ownership snapshots and performance-fee routing remain disabled.

## Pending-deposit queue mechanics

- Pending USDC lives in a separate vault-specific SPL token account, `[b"pending_usdc", vault_config]`, owned by the corresponding vault authority PDA. It must not be used as keeper trading collateral.
- `VaultV2.pending_usdc_total` counts the sum of pending amounts; each `VaultV2Position.pending_usdc` holds the depositor's refundable claim.
- `request_pending_deposit_v2(amount)` accepts a deposit independently of open positions and moves real USDC into segregated escrow.
- `cancel_pending_deposit_v2(amount)` requires that depositor's signature, refunds precisely the requested pending amount, and leaves active shares unchanged.
- `activate_pending_deposit_v2()` is permissionless after the no-open-exposure accounting cutoff and activates that depositor's entire pending amount by minting shares at current NAV before moving escrow USDC to the active vault.
- Cancellation and activation in one Solana transaction are atomic; after activation there is no refundable pending balance. To exit active capital the depositor uses the withdrawal process and its risk restrictions.
- The dApp must distinguish **pending refundable USDC** from **active capital/shares**, show both balances and offer a cancellation action until activation.
