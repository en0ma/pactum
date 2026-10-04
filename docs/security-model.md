# Pactum security model

Pactum treats every off-chain component, including the strategy bot/keeper, as
potentially compromised.

## Core custody invariant

No externally controlled key may have generic SPL Token transfer authority over
pooled USDC.

The pooled USDC token account is controlled by the `vault_authority` PDA.
That PDA has no private key and can sign only when the Pactum program invokes
another program with the correct PDA seeds.

## Roles

### Admin

The admin may:

- pause/unpause the vault
- configure risk ceilings
- authorize and revoke keeper identities

The admin must not have a generic instruction that transfers vault USDC to an
arbitrary account. Emergency controls should stop new risk, not provide a
custodial withdrawal path.

### Keeper

A keeper represents the external strategy/bot.

A keeper may eventually request constrained prediction-market actions. A keeper
must never:

- own the pooled USDC account
- be an SPL delegate over pooled USDC
- select an arbitrary settlement mint
- redirect refunds, outcome tokens, or settlement proceeds
- call a generic token-transfer function through Pactum

Keeper authorization is stored in a dedicated PDA:

`["keeper", config, keeper]`

so multiple keepers can be authorized/revoked without storing an unbounded
vector in global config.

### Staker

Each staker has a program-owned position PDA:

`["position", config, staker]`

Pactum v1 uses internal non-transferable shares. Transferable receipt tokens are
intentionally deferred until the DFlow position/NAV accounting model is proven.

## Asset invariants

Pactum v1 supports only canonical Solana USDC:

`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

The canonical vault token account is a Pactum PDA token account whose authority
is `vault_authority`.

Future DFlow instructions must enforce all of the following on-chain:

1. DFlow prediction-market program ID is the pinned allowed program.
2. Source settlement token is canonical USDC.
3. Source token account is the canonical Pactum USDC vault.
4. User/token authority is `vault_authority`.
5. Market/market-ledger belongs to an approved strategy market.
6. Outcome mint is the exact approved YES or NO mint for that market's USDC rail.
7. Refund destination is Pactum-controlled.
8. Filled outcome tokens are owned by `vault_authority`.
9. Redemption USDC destination is the canonical Pactum USDC vault.
10. Trade amount and aggregate exposure remain under configured limits.

## Deposit/withdrawal phase

Until marked/open prediction positions are represented in NAV, Pactum takes the
conservative approach of disabling deposits and withdrawals whenever
`open_exposure_usdc != 0`.

This prevents share-price manipulation from deposits/withdrawals while assets
are represented by unresolved outcome tokens.

The restriction can later be replaced by epoch accounting once open-position
valuation and settlement reconciliation are implemented.

## Pausing

Pause blocks staker deposit/withdraw paths today and should block every
risk-increasing keeper operation added later.

Redemption/settlement recovery should remain callable while paused so a pause
cannot trap a winning position indefinitely.

## DFlow adapter boundary

Raw DFlow prediction-market instruction layouts are isolated in a versioned
adapter. Pactum must not accept arbitrary instruction bytes or arbitrary account
lists from the keeper.

The keeper supplies economic intent (market, side, amount, limits); Pactum
constructs the DFlow instruction itself after validating all accounts.

## CI invariants

CI must eventually test, on a mainnet fork:

- direct keeper SPL transfer from the vault fails
- unauthorized keeper trade request fails
- wrong DFlow program fails
- wrong USDC vault fails
- wrong market ledger fails
- wrong outcome mint fails
- redirected refund/output/settlement destination fails
- over-limit trade fails
- aggregate exposure breach fails
- valid PDA-signed DFlow order-open reaches/fills
- valid winning-token redemption returns USDC to the vault
