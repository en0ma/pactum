# Pactum multi-vault architecture (target)

## Product contract

Pactum supports multiple independent vaults, displayed in the dApp. An admin creates vaults and assigns or revokes trading keepers per vault. Depositors select a vault and contribute USDC to **that vault's** custody account. A keeper operator copies the selected vault's published settlement addresses into its DFlow integration.

A keeper public key may be authorized for multiple vaults, but every order authorizes **one exact vault** and may never draw principal from a different vault.

## Required on-chain identity and PDA layout

The existing singleton seeds are **not sufficient**:
- `[b"config"]` currently admits one VaultConfig for the entire program.
- `[b"vault_authority"]` currently admits one vault authority for the entire program.
- `[b"market_registry"]` currently admits one global rolling registry.
- `[b"pending_order", config]` currently tracks only one pending order per vault.

Target layout (must be implemented with an explicit migration strategy):
- Vault config: `[b"vault", vault_id]` (vault_id unique, admin-supplied or deterministic).
- Vault authority: `[b"vault_authority", vault_config]`.
- Vault USDC token account: canonical ATA of vault authority and USDC mint, or a strictly recorded and PDA-owned vault account.
- Keeper authorization: `[b"keeper", vault_config, keeper_pubkey]`. Creation/revocation is authenticated by the vault's administrative authority and is evaluated for the **chosen vault**, never as a global permission.
- User shares: `[b"position", vault_config, depositor]`.
- Vault exposure: `[b"exposure", vault_config, market_ledger, outcome_mint]`.
- Pending order: `[b"pending_order", vault_config, dflow_order_account]` so multiple orders can coexist.
- Markets: distinguish the *protocol-controlled market registry* (which markets DFlow/Kalshi supports) from vault-specific approval/risk decisions. Do not globally trust bot-supplied market information.

All vault-sensitive instruction account constraints must derive identity from the selected `vault_config`, require that its configured USDC vault is owned by its vault authority, and bind keeper approval to that configuration. Vault admin changes must be expressly authorized and auditable.

## dApp / SDK address manifest

For each vault the dApp should publish:
- `vaultConfig` — vault identity; use this in Pactum instruction accounts and authorization lookups.
- `vaultAuthority` — PDA custody authority; candidate DFlow `destinationWallet` and `revertWallet`.
- `vaultUsdcAta` — vault authority-owned canonical USDC ATA, if the DFlow route takes a token-account address.
- `outcomeAta` — per-outcome-mint associated token account for the vault authority.
- `keeperAuthorization` — per-vault/per-keeper PDA; the keeper must be registered and not revoked.

When the DFlow API offers `destinationWallet`/`revertWallet`, use `vaultAuthority` only after verifying the returned unsigned transaction settles to vault-owned accounts. The DFlow on-chain `fillRecipient` and `refundRecipient` fields must likewise be checked against the chosen vault's authority/account layout; do not assume API fields map 1:1 to ABI roles.

The bot must not be able to choose settlement to its own wallet, even if that wallet has been authorized as a keeper.

## Atomic wrapped transaction

Use a single final assembled Solana transaction, signed *after* composing:
1. Optional compute-budget and other narrowly allowed preparation instructions.
2. Pactum validate-and-fund instruction with the selected vault config, vault-specific keeper authorization, registry/market validation and exact-amount approval.
3. Permitted DFlow order instructions whose authenticated recipient roles resolve to that vault's custody.
4. Only if supported by verified DFlow ABI, a safely enforced residual-refund/settlement sequence.

**Current implementation does not yet deliver this**. The read-only verifier uses a singleton config/authority and a fixed observed 12-account DFlow instruction. The production `execute_trade` uses CPI, and funding an external keeper account without guaranteed recovery is unsafe.

Do not enable any external keeper funding until:
- Per-vault isolation is implemented and tested against keeper cross-vault access and revoked authorization.
- Authentic unsigned DFlow quotes confirm recipient, signer, funding and remaining-balance behavior.
- On-chain policy validates every relevant instruction/account and ensures no successful transaction leaves stray keeper-owned vault principal.
- Atomic rollback and asynchronous order reconciliation are covered in fork tests.

## Migration

This is an interface-changing refactor, including PDA addresses, account constraints, SDK inputs, IDL and tests. Do not silently mutate the deployed singleton state. Use a new vault configuration version / explicit migration, with separately audited handling for any existing deposits or pending orders.
