# Pactum multi-vault architecture (target)

## Product contract

Pactum supports multiple independent vaults, displayed in the dApp. The protocol admin creates vaults and assigns, replaces or revokes **one trading bot keeper per vault**. Depositors select a vault and contribute USDC to **that vault's** custody account. A keeper operator copies the selected vault's published settlement addresses into its DFlow integration.

Each vault has **its own independently configured trading policy and risk limits** (including per-trade USDC cap, total exposure cap, liquidity buffer, pause state, and any additional approved strategy constraints). The on-chain trade gate always evaluates the **selected vault's** configuration, never another vault's or a global trading limit. A shared market listing does not imply every vault must trade every listed market.

Each vault has **at most one active trading bot keeper**. The same bot public key may be assigned to more than one vault, but must have a distinct vault-scoped authorization for each. Every order authorizes **one exact vault** and may never draw principal from another vault.

**One protocol market keeper** alone publishes the **single globally shared Pactum market registry** consumed by every vault. This protocol keeper is a separate role from vault trading bot keepers. Vault admins/bot keepers cannot update the global registry.

## Required on-chain identity and PDA layout

The existing singleton seeds are **not sufficient**:
- `[b"config"]` currently admits one VaultConfig for the entire program.
- `[b"vault_authority"]` currently admits one vault authority for the entire program.
- `[b"market_registry"]` is **correctly global** and must remain the one shared market registry across all vaults.
- `[b"pending_order", config]` currently tracks only one pending order per vault.

Target layout (must be implemented with an explicit migration strategy):
- Vault config: `[b"vault", vault_id]` (vault_id unique, admin-supplied or deterministic). Stores that vault's independent max-trade amount, max-total-exposure, min-liquidity-buffer, pause setting, and any future per-vault strategy/market restrictions.
- Vault authority: `[b"vault_authority", vault_config]`.
- Vault USDC token account: canonical ATA of vault authority and USDC mint, or a strictly recorded and PDA-owned vault account.
- Active trading keeper: store one `Option<Pubkey>` in each vault config, or a single `[b"vault_keeper", vault_config]` authorization account containing its active bot pubkey. Assign/reassign/revoke only through vault-admin-authorized instructions. The old per-keeper-PDA design `[b"keeper", vault_config, keeper_pubkey]` must not allow two simultaneously active keeper accounts for one vault; use a single canonical slot or enforce replacement atomically.
- Protocol market keeper: one globally configured, admin-controlled pubkey/authorization record, separate from vault configs; only that signer may update the singleton market registry.
- User shares: `[b"position", vault_config, depositor]`.
- Vault exposure: `[b"exposure", vault_config, market_ledger, outcome_mint]`.
- Pending order: `[b"pending_order", vault_config, dflow_order_account]` so multiple orders can coexist.
- Risk policy: per-vault state checked by every trade and deposit/withdraw operation. Updating the protocol registry must **not** overwrite or bypass a vault's limits; bot keepers cannot modify their own vault's policy.
- Market registry: one **global** `[b"market_registry"]` maintained by the sole protocol market keeper. Every vault reads the same registry; vault-specific strategy/risk/accounting remains isolated. Do not trust bot-supplied market information.

All vault-sensitive instruction account constraints must derive identity from the selected `vault_config`, require that its configured USDC vault is owned by its vault authority, and bind keeper approval to that configuration. Vault admin changes must be expressly authorized and auditable.

## dApp / SDK address manifest

For each vault the dApp should publish:
- `vaultConfig` — vault identity; use this in Pactum instruction accounts and authorization lookups.
- `vaultAuthority` — PDA custody authority; candidate DFlow `destinationWallet` and `revertWallet`.
- `vaultUsdcAta` — vault authority-owned canonical USDC ATA, if the DFlow route takes a token-account address.
- `outcomeAta` — per-outcome-mint associated token account for the vault authority.
- `activeKeeper` — the unique active trading bot pubkey for this vault (or null if revoked), published from the canonical vault authorization state. No second active keeper may coexist.
- `marketRegistry` — the same global Pactum registry address for **every** vault.

When the DFlow API offers `destinationWallet`/`revertWallet`, use `vaultAuthority` only after verifying the returned unsigned transaction settles to vault-owned accounts. The DFlow on-chain `fillRecipient` and `refundRecipient` fields must likewise be checked against the chosen vault's authority/account layout; do not assume API fields map 1:1 to ABI roles.

The bot must not be able to choose settlement to its own wallet, even if that wallet has been authorized as a keeper.

## Atomic wrapped transaction

Use a single final assembled Solana transaction, signed *after* composing:
1. Optional compute-budget and other narrowly allowed preparation instructions.
2. Pactum validate-and-fund instruction with the selected vault config, its **sole active keeper** authorization, shared global registry/market validation and exact-amount approval.
3. Permitted DFlow order instructions whose authenticated recipient roles resolve to that vault's custody.
4. Only if supported by verified DFlow ABI, a safely enforced residual-refund/settlement sequence.

**Current implementation does not yet deliver this**. The read-only verifier uses a singleton config/authority and a fixed observed 12-account DFlow instruction. The production `execute_trade` uses CPI, and funding an external keeper account without guaranteed recovery is unsafe.

Do not enable any external keeper funding until:
- Per-vault isolation is implemented and tested against keeper cross-vault access, revoked authorization, attempts to activate multiple keepers for one vault, and attempts to use another vault's larger trade/exposure limits.
- The shared market registry rejects updates from all parties except the one protocol market keeper.
- Authentic unsigned DFlow quotes confirm recipient, signer, funding and remaining-balance behavior.
- On-chain policy validates every relevant instruction/account and ensures no successful transaction leaves stray keeper-owned vault principal.
- Atomic rollback and asynchronous order reconciliation are covered in fork tests.

## Migration

This is an interface-changing refactor, including PDA addresses, account constraints, SDK inputs, IDL and tests. Do not silently mutate the deployed singleton state. Use a new vault configuration version / explicit migration, with separately audited handling for any existing deposits or pending orders.

## Current-code gaps to resolve in the refactor

- `MarketRegistry` already uses the global `[b"market_registry"]` seed: **preserve it**. `MarketKeeperAuthorization` presently permits multiple protocol market keeper authorization PDAs (keyed by keeper pubkey) and must be replaced with a **single** controlled authority if exactly one market keeper is required.
- `KeeperAuthorization` currently uses `[b"keeper", config, keeper]` and allows registering multiple trading keepers for the singleton config. Changing to multiple vault configs **alone** will not enforce a one-bot-per-vault rule. Move to a canonical active bot slot or enforce exclusivity with a single authorization PDA per vault.
- The existing read-only DFlow verifier checks that the supplied keeper has a valid authorization PDA; this needs to additionally check that the signer is the vault's **current, sole active bot**. Revoked or replaced bots must fail immediately.
