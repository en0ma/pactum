## Live V2 terminalization guard (no custody or fee settlement)

`finalize_reconciled_order_v2` is now a public, permissionless instruction that reads the **actual registered DFlow order account** and verifies matching address, system ownership, zero lamports and empty data, before atomically marking an already fully reconciled V2 order terminal. The stored cumulative fill/refund ledger must account for the entire input and meet the order-opening slippage floor. The instruction accepts **no event amounts**, never creates a fill/refund event, and makes **no token or fee transfers**. It cannot finalize an ordinary newly registered order whose fills and refunds have not yet been authenticated and recorded: that pipeline remains unimplemented. A caller cannot use a different closed system account to pass the canonical-order check.

The verification path relies on the existing V1 observed terminal account predicate. It is not an event receipt and cannot supply missing historical fill/refund data. Production settlement remains disabled until those events can be authenticated and recorded separately.

## Canonical DFlow terminal account verification

The V1 observed terminal order predicate is system ownership, zero lamports, and empty data. `verify_canonical_dflow_order_closed` now additionally requires the supplied address to equal the registered order's immutable `order_account`, rejecting arbitrary closed accounts, open accounts, wrong owners and accounts with data. Regression tests cover these cases. Future V2 terminal handlers must read the real account's owner/lamports/data length and require this predicate before applying `project_terminal_order`.

A closed account proves the canonical order account is no longer open under this observed lifecycle. It does not by itself prove per-fill/refund amounts or authenticate historical DFlow events; no persistent V2 terminal handler or payout is enabled.

## Separate terminal closure after fill/refund events

`project_terminal_order` now closes a fully reconciled order **without inventing an extra fill event**. It requires externally proven closure of the matching DFlow order account, all original USDC consumed or refunded, and a minimum total received outcome amount for the actual consumed USDC after applying the registered quote/slippage. A fully refunded order can close with zero outcome atoms. Duplicate terminal transitions fail; tests cover unclosed/partial input, underfill, refunds and duplicate closure.

This is a pure checked projection. The `dflow_order_closed` argument is NOT independently verified by this function; a future on-chain caller must validate the canonical DFlow-owned order state or another authenticated closure source. No on-chain event ingestion or payout is exposed.

## Canonical event ID binding

`observed_event_id(vault,signature,event_index)` translates the full 64-byte Solana transaction signature, event index and vault into the fixed 32-byte event ID used by `TradeEventV2`. `validate_observed_event_parent` now rejects a record if its vault, parent order or event ID differs from the canonical identity for that exact observed transaction event. Tests reject altered signatures and event positions. This closes a model-level gap where a 32-byte event ID could otherwise be chosen independently of the transaction-reference tuple.

An event ID is **not proof of an emitted event**. No externally provided signature or event body is trusted for an on-chain ledger write until DFlow provenance can be verified. No bot or protocol keeper can currently invoke an exposed V2 event-accounting instruction.

## Vault-scoped DFlow event identity and parent binding

`observed_event_address(vault, transaction_signature, event_index)` now derives a deterministic PDA from the vault, both complete 32-byte halves of the 64-byte Solana transaction signature, and the event's index within that transaction. It distinguishes multiple fills in one transaction, collisions between vaults, and different transactions; no keeper-chosen nonce or truncated signature is involved. `validate_event_parent` checks that a candidate fill/refund record belongs to exactly the intended vault and registered parent order, with the expected event ID and compatible quantities. Regression tests cover identity uniqueness and mismatched parent records.

These functions are **not on-chain evidence authentication**. The keeper must first obtain finalized DFlow program events, and an agreed on-chain verifier must prove provenance before a canonical event PDA can be initialized or cumulative amounts mutated. Never derive deposit PnL or fees merely from a transaction signature, user-supplied bytes or a keeper declaration. Live event writes are still disabled.

## Existing DFlow fixtures wired into V2 fill projection

`project_decoded_order_fill` now connects the already-known DFlow `UserOrderEvent` order identity and USDC/outcome mint checks to `OrderReconciliationV2::apply`. It derives candidate cumulative filled USDC and credited outcome tokens, rejects cross-order identities and overfilled input, and does not mutate persistent accounts. Regression tests exercise a partial 60/100 fill and a second fill exceeding the original 100 USDC; an invalid proposal leaves the previous reconciliation untouched.

The existing V1 confirmed redemption instruction fixture is tested through `validate_observed_redeem_instruction`. Its encoded **instruction data** is exactly 8 bytes (action `0x58`) and therefore contains no 32-byte purchase order ID. This is **not** a conclusion about the separate `UserRedeemEvent` body or the transaction's remaining accounts and logs, which still require inspection of actual confirmed transactions.

These tests reuse existing DFlow instruction parsing, but the projected fill event is still passed as decoded data from an external observer. **No on-chain instruction can currently accept it as a historical proof; no event ledger writes or PnL/fee payments are authorized.** Separate fill/refund identity, event-specific evidence verification and market redemption attribution remain necessary.

## DFlow UserOrderEvent semantic validation — IDL adapter

The official DFlow parsing guide confirms semantic fields `userOrder`, `inputMint`, `inputAmount`, `outputMint`, `outputAmount`, `feeMint`, and `feeAmount` for order events. `DecodedUserOrderEvent` and `validate_decoded_order_fill` now reject fills with mismatched parent order or input/output/fee mint, invalid lifecycle kind, or zero fill quantities. Tests also establish why event identity must include the event's intra-transaction position: one transaction can contain more than one emitted event.

**Not yet a complete raw event decoder:** the public DFlow guide does not provide the exact serialized order and layout of *all* event fields, so we must obtain the versioned program IDL or confirmed fixture before decoding arbitrary raw `EmitEvent` bytes into `DecodedUserOrderEvent`. Do not guess offsets or treat this adapter as an on-chain historical proof. The keeper can perform accurate off-chain IDL decoding and monitoring, but ledger writes, settlement and fees remain disabled pending an authenticated proof path. The original purchase order in `UserRedeemEvent` is still unverified.

## DFlow program events: protocol-keeper observation versus on-chain authorization

The protocol keeper (separate from the trading bot) monitors actual DFlow PredictionMarkets `EmitEvent` instructions. DFlow's published schema uses the 8-byte `f0 00 00 00 00 00 00 00` discriminator, event type `2` for `UserOrderEvent` and `3` for `UserRedeemEvent`; order event subtypes are Open=1, Fill=2, Cancel=3, Revert=4. Order lifecycle events include `userOrder`, linking opening and subsequent fills/cancellations to a parent order. The new `classify_dflow_emit_event` helper parses **only this documented header**; the remaining event fields require full authoritative IDL decoding. **The helper does not authenticate a historical transaction or enable payouts.**

The keeper should index finalized Solana transactions, reject program-ID mismatches, decode true instruction/event contents and associate `userOrder` with the vault-scoped order registry; events need stable transaction-signature-plus-event-index identities to prevent replay. However, Solana programs cannot look up arbitrary previously finalized transaction logs using a transaction signature alone. An event body forwarded in a later keeper instruction is untrusted bytes even when it looks well-formed. Therefore `TradeEventV2` mutations remain unexposed pending an on-chain-verifiable mechanism, such as DFlow-owned persistent state with proven semantics or an approved proof-verification pathway. The keeper may observe and submit transaction references, but not attest monetary values.

DFlow documents `UserRedeemEvent` separately; no confirmed on-chain evidence in this branch establishes an original purchase-order ID inside that event. Do not assume one exists. Redemption attribution may instead depend on verified market, outcome token account, quantities and per-order inventory and cost basis.

## DFlow terminal evidence validation — partial implementation

The V2 `reconcile_terminal_deltas` helper checks DFlow order closure, monotonic vault-custody outcome/refund token balances, bounded refunds, full-refund consistency, and the verified quote's prorated minimum outcome quantity. This builds on V1's terminal-order accounting and has adversarial unit tests.

**Crucial missing attribution evidence:** a shared vault outcome token account or USDC refund destination can be affected by multiple orders between opening and terminal observation. Differences in those balances cannot safely prove *which* order supplied the fill/refund or provide a unique per-fill trade ID. Accordingly this helper does **not** create trade events, mutate `OrderRecordV2`, or authorize fee transfers. Before enabling live on-chain ingestion, isolate per-order custody or verify DFlow-owned order receipts with an authoritative event identifier and same-order refund/outcome amounts. Exactly-once event PDA creation and cumulative reconciliation must then occur in one transaction. Off-chain bot claims are not sufficient.

## V2 cumulative order reconciliation (not yet ingesting external events)

An `OrderRecordV2` now stores a cumulative `OrderReconciliationV2`: verified filled USDC, credited outcome atoms, verified refunded USDC, accepted event count, and terminal state. The checked transition function requires positive and type-consistent fills/refunds; never allows total filled + refunded principal to exceed original order input; requires full principal reconciliation before terminal; rejects another transition after terminal; checks integer overflow. Its tests cover partial fills, refund remainder, overfill, early terminal, and rejected post-terminal mutations.

**Important:** The transition function is deliberately not exposed as a bot-callable instruction. A DFlow fill/refund **must be proved against canonical DFlow order state and actual vault-owned token balance changes**, and its unique event ID checked before the on-chain order totals can be updated. An arbitrary bot event is not authoritative. Ledger balance reconciliation alone cannot reconstruct an independent per-fill ID if DFlow combines fills between observations; terminal totals and trustworthy event semantics may require more evidence. Until such a proof is implemented and mainnet-fork-tested, these accounting fields remain at their initial zero values and real fee routing is disabled.

## Order registry and trade event registry — revised vault-scoped identity

The canonical V2 entrypoint is now `register_order_v2` (replacing `open_trade_snapshot_v2`). The **order record** is initialized at `[b"v2_order", vault_pubkey, order_id]`, so each order ID is unique *within its vault*, not across the entire protocol. The record stores DFlow order account, approved market, YES/NO side, input USDC, quoted output, slippage, bot identity, status and the trade-opening share/fee snapshot. As before, it atomically verifies the immediately subsequent final DFlow OpenUserOrder. On-chain initialization rejects reuse of the same vault/order ID.

A distinct `TradeEventV2` type models individual fill/refund events at `[b"v2_trade", vault_pubkey, event_id]`. An order may produce multiple fill/refund events, each with its own trade-event ID; the same ID may be used independently by different vaults. The event schema and integer-only validators exist with Rust tests, but **public event writes are intentionally absent** until DFlow receipts and custody deltas can be authenticated. In particular, a bot-supplied event ID or claimed refund cannot trigger payouts.

The pre-existing historical share-checkpoint proofs now read the parent `OrderRecordV2` opening revision. Legacy V1 instructions remain unchanged. No production DFlow funding, fill/refund reconciliation, depositor PnL settlement, or fee transfer is enabled by this refactor.

## Atomic DFlow-opening binding (new)

`open_trade_snapshot_v2` now requires the immediately following instruction to be the **final** top-level DFlow PredictionMarkets OpenUserOrder instruction in that same Solana transaction. It checks the vault's sole keeper signer and vault-specific risk limits, the shared market registry, DFlow account layout and PDA fill/refund recipients, the observed order data, and requires `trade_id` to equal the DFlow order-account public key bytes. The trade-open share revision and bot fee rate are captured at the validated opening point.

**Limitations:** no funding is performed; the DFlow order still uses the keeper's source USDC. This is based on a known 12-account OpenUserOrder layout pending authentic unsigned DFlow quotes. It does not establish PnL eligibility for all investors by itself, settle trade outcomes, pay protocol/trader fees, or enable immediate deposits while earlier trades are open. A separate order cannot be submitted as evidence for this snapshot. Never enable mainnet custody movement on this basis alone.

## Read-only historical participation proof

`verify_trade_participation_v2` verifies an individual depositor's historical active share balance against a specific vault's trade-opening revision. Optional consecutive before/after checkpoints must match their canonical vault-position and mutation-index PDAs. The verifier rejects skipped indices, revision gaps, cross-vault/depositor mismatches, and amounts exceeding the trade's opening share supply. A late entrant with a first checkpoint after opening receives zero historical shares. This verifier is **read-only** and logs eligible shares; it does not create an entitlement, distribute PnL, fund DFlow, or pay fees.

Important: the trade snapshot itself is currently keeper-created independently of a real verified DFlow order. Historical participation proof alone **cannot** make PnL disbursement safe. Production settlement must atomically bind trade-open records to actual DFlow order execution and cost basis, enforce exactly-once settlement, and use correct cohort-aware NAV before enabling mid-trade active deposits. Pending escrow remains available during this migration.

## Append-only share history (in progress)

V2 share-changing instructions now atomically initialize an immutable `ShareCheckpointV2` PDA for each depositor, keyed by the depositor's position PDA and monotonic `share_mutations` index. It records the post-operation share balance and vault-wide revision. Deposit, withdrawal and pending activation paths each append a checkpoint. This makes the historical share timeline verifiable even if a depositor's share balance later returns to an earlier value.

**Still required:** an on-chain settlement proof that loads the correct *bounding consecutive checkpoints* for the trade-opening revision. A checkpoint without proof of the immediately next mutation could be stale. An initial (zero-share) state must also be handled. The current public `checkpoint_participant_v2` remains disabled, and no live PnL payouts rely on these records.

Changing the layout of `VaultV2` and `VaultV2Position` requires a clean versioned deployment/migration; existing initialized V2 accounts of the older size cannot be silently reused.

## Monotonic share revision — first historical-integrity gate

`VaultV2.share_revision` now advances on every active share mint or burn, including pending-deposit activation; `VaultV2Position.share_revision` records each affected depositor's latest change. `TradeSnapshotV2.share_revision_at_open` captures the vault's revision at opening. A delayed checkpoint cannot pass merely because shares were minted and later burned back to the same supply: revisions remain changed. Rust tests cover this round-trip.

**This is not an immutable history of each wallet's earlier share balance.** To enable immediate active deposits and settlements, the next implementation must atomically append immutable per-wallet share checkpoints on each share mutation and securely resolve the latest checkpoint at or before the trade-opening revision. A separate later call cannot recreate trustworthy history. Until then the DFlow PnL routing and the V2 exposure-open deposit guard remain unchanged.

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
