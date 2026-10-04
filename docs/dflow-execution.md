# DFlow execution architecture

The Python bot is an untrusted keeper. It uses DFlow endpoints for market
discovery/quotes and calls Pactum's `execute_trade` instruction. It never owns
or receives pooled USDC and it never signs for DFlow custody.

## Buy

```text
Python bot
    |
    | execute_trade(...)
    v
Pactum vault
    |
    | validates approved market, side, amount,
    | canonical USDC rail, exposure, quote, slippage,
    | liquidity buffer, DFlow accounts
    v
VaultAuthority PDA
    |
    | invoke_signed
    v
DFlow Prediction Markets / OpenUserOrder
    |
    | debit
    v
PDA-owned vault_usdc -> DFlow order custody

                    async

DFlow LP
    |
    | FillUserOrder
    v
Token-2022 ATA(VaultAuthorityPDA, outcomeMint)
```

The keeper is not a DFlow token authority. The three observed user/authority
roles in the captured OpenUserOrder instruction are supplied as
VaultAuthorityPDA and receive signer privilege only through Pactum
`invoke_signed`.

Pactum checks that the OpenUserOrder CPI debits exactly the validated USDC
amount and that the resulting user-order account is owned by the DFlow
Prediction Markets program with the observed account size. The cost basis is
reserved immediately as open exposure in a `PendingDflowOrder` PDA.

## Settlement

```text
VaultAuthority PDA
    |
    | invoke_signed
    v
DFlow Prediction Markets / RedeemMarketOutcome
    |
    v
USDC back to PDA-owned vault_usdc
```

Redemption is the already-merged direct-PDA path. Winning outcome tokens are
burned and USDC returns only to Pactum's vault.

## Async fill reconciliation

OpenUserOrder and FillUserOrder are separate transactions. `execute_trade`
therefore records pending exposure rather than pretending the outcome tokens
exist synchronously. A subsequent reconciliation path must prove the
Token-2022 outcome balance at
`ATA(VaultAuthorityPDA, outcomeMint)` and convert the pending order into the
redeemable market exposure record.

## Versioned OpenUserOrder payload

The observed DFlow v1 OpenUserOrder instruction is action `0x40` with an
80-byte payload. Pactum currently validates the confirmed fields:

- input USDC amount at bytes 24..32
- quoted outcome amount at bytes 32..40
- protocol slippage cap and quote-derived minimum outcome

The other observed fields remain versioned/opaque until independently decoded.
They must not be treated as trusted custody or destination controls. No DFlow
`/order` endpoint is part of execution.
