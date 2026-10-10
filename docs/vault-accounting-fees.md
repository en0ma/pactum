# Vault V2 accounting: trade-open participation and settlement waterfall

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

The current V2 deposit and withdrawal instructions **still reject while exposure/positions are open**; supporting Bob's mid-trade deposit with participation beginning at Trade #2 requires new cohort accounting and is not implemented yet. Live DFlow execution and performance-fee routing remain disabled until the snapshot and reconciliation logic are tested.
