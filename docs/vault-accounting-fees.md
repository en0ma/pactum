# Vault V2 accounting and performance fees

## Required financial invariant

A depositor owns a **pro-rata share of the vault's net assets from their admission forward**, not historical trade PnL. Shares are minted at **post-crystallization NAV per share**. Deposits may never mint at liquid-USDC-only NAV when outstanding DFlow orders or positions carry historical profits or losses.

A deposit received while any trade is open must either:
1. Be rejected (current V2 behavior); or
2. Be held separately as **pending capital** with zero trading entitlement, then admitted at the next fully settled epoch using that epoch's post-fee NAV. This queuing mechanism has **not** been implemented.

This restriction protects late entrants from receiving profits on already-open positions and protects earlier investors from dilution.

## Profit split

For **eligible realized net profit** after applying an appropriate per-share high-water mark / loss carryforward and after closing the relevant accounting interval:

1. Protocol fee: **1%** of eligible positive profit (100 basis points).
2. Trader fee: each vault's admin-configured `trader_profit_share_bps` portion (0–10,000 bps) of **profit remaining after** the protocol fee.
3. Depositors: **all remaining profit**, reflected in their vault-share NAV in proportion to shares held before that profit was earned.

Example: 100 USDC eligible profit, trader share 20% of post-protocol profit.
- Protocol: 1 USDC.
- Trader: 19.80 USDC.
- Depositors: 79.20 USDC (distributed by existing vault shares / NAV).
- Fee percentages are not charged against original depositor principal, and **no performance fees are assessed for zero or negative eligible PnL**.

Use integer atomic USDC math; floor fees and leave any rounding remainder in depositor NAV. Each vault has separate PnL, share supply, trader fee configuration and custody. The market registry remains global.

## Current implementation

`accounting.rs` now offers deterministic fee split and NAV-priced share math with Rust tests. `VaultV2` stores `trader_profit_share_bps`, configurable via admin-only `set_vault_trader_fee_v2`. Protocol fee rate is a program constant, not adjustable per vault.

**Important: Fee crystallization, high-water mark accounting, fee payouts, realized position PnL tracking, and pending-deposit admission have not been wired into settlement.** The deposit and withdrawal handlers still reject while open exposure exists and use liquid-USDC math only under that restriction. They must not be enabled for live trading until closed-position accounting also guarantees post-fee NAV and captures realized losses.

## Required before mainnet funds

- Track per-vault/per-position realized cost basis, terminal refunds, settlement proceeds and losses; no double-counting across partial fills.
- Maintain an appropriate **per-share or cohort high-water mark / loss carryforward** so new subscribers do not inherit old investors' fee histories or obtain stale claims to pre-admission trades.
- Crystallize terminal trade PnL and deduct accrued protocol/trader fees **before** pricing any newly admitted shares, withdrawals or new risk exposure.
- Ensure trader fee recipients are authorized and canonical, never arbitrary keeper-supplied addresses; protocol treasury immutable/controlled by protocol governance.
- Add invariants for a late depositor after both winning and losing epochs, depositor exit/re-entry, changed trader-fee configuration, repeated settlement, rounding dust, and multiple vaults with disjoint capital.
- Fees on profits vs trade notional, and whether protocol/trader accrue on realized vs high-water-mark net profits, are specified here as **performance fees on eligible realized positive net PnL**. If product intent is a 1% fee on all traded principal, token amounts and economics need a different implementation and explicit approval.
