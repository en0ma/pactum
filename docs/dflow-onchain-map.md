# DFlow Prediction Markets on-chain map

This document records DFlow Prediction Markets facts that Pactum uses for
validation and Solana-fork tests.

The sources are:

1. DFlow public documentation.
2. The QuickNode DFlow prediction-market walkthrough.
3. Mainnet transactions inspected during Pactum development.
4. Mainnet account state checked by the fork test.

Do not infer additional ABI fields from this document.

## Programs

Prediction Markets program:

```text
pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb
```

DFlow event authority:

```text
ATZQPakBrumxMrSyuEmrt6NcxBbTR1Ucs99dnPFpBUuM
```

Classic SPL Token:

```text
TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
```

Token-2022:

```text
TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

USDC:

```text
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

## Market registry model

DFlow metadata exposes market accounts by settlement mint.

A binary market has a settlement-specific:

- `marketLedger`
- `yesMint`
- `noMint`
- initialization state
- redemption state

The same Kalshi market can therefore have different on-chain ledgers and
outcome mints for USDC and CASH settlement.

Do not mix accounts from two settlement rails or two binary markets.

## QuickNode / captured buy fixture

Market:

```text
KXEPLGAME-26FEB18WOLARS-WOL
```

USDC market ledger:

```text
5UHoukpeVPQbmSUaAPWnkXEKZMrjSmwTqqaD8eXmvKNn
```

YES mint:

```text
CA7FMbzNTfeR7jkLzF113bBJupKwq98cixaQtc3b3frb
```

NO mint:

```text
D7ibW7tu2kvzfbDS78gF5i9UZTye7pqTP63yxYd43No3
```

The mainnet fork test resolves the ledger's USDC token account with
`getTokenAccountsByOwner(marketLedger, mint=USDC)`.

The captured transaction inspection showed this account with the prefix:

```text
BFH59...
```

The fork test requires the resolved account to match that captured prefix. It
also verifies:

- the market ledger is owned by the DFlow Prediction Markets program
- the YES and NO mints are owned by Token-2022
- the market USDC account is owned by classic SPL Token
- the token account mint is USDC
- the token account authority is the market ledger

Observed OpenUserOrder data:

```text
4000000000000000
bb267d4554fc60a6
590000000000150a
80770e0000000000
c0d8a70000000000
0000000000000000
0000000000000000
0000000000000000
0000000000000000
0000000000000000
```

Confirmed decoded fields:

- action: `0x40`
- input amount: `948096` USDC atoms
- quoted output: `11000000` outcome atoms

The remaining bytes are opaque.

The captured OpenUserOrder account order was:

1. event authority
2. market ledger
3. market USDC token account
4. user-order account
5. USDC mint
6. user source USDC token account
7. user
8. user
9. user
10. classic SPL Token program
11. System Program

Pactum supplies VaultAuthorityPDA in the three repeated user/authority signer
roles with `invoke_signed`.

## User-order account

A captured OpenUserOrder created a DFlow-owned account with 344 bytes of data.

Pactum treats the 344-byte size as an observed, versioned fixture. It is not a
published stable ABI.

The async lifecycle can have more than one Fill for one Open.

## Stable DFlow events

DFlow documents `EmitEvent` as the stable parsing surface.

Instruction discriminator:

```text
f000000000000000
```

Byte 8 is the event type:

- `0x01`: Market
- `0x02`: UserOrder
- `0x03`: UserRedeem

For UserOrder events, byte 9 is:

- `0x01`: Open
- `0x02`: Fill
- `0x03`: Cancel
- `0x04`: Revert

The documented `UserOrderEvent` includes:

- `userOrder`
- `inputMint`
- `inputAmount`
- `outputMint`
- `outputAmount`
- `feeMint`
- `feeAmount`

Open and later Fill/Cancel/Revert events share the same `userOrder` value.

DFlow explicitly states that raw instruction formats can change without
notice. Pactum must therefore keep raw instruction decoding versioned and
fixture-tested.

## Fill fixture

The captured fill:

- used LP signer `ProdD7SB4T5h7rwSHU6jJEUtm69rEooTzuguwndpNQc`
- did not require the original user as a signer
- consumed `948096` input atoms
- produced `11000000` outcome atoms
- created or used the original user's Token-2022 ATA

Observed fill data contained these four u64 values:

```text
0x41
948096
11000000
0
```

Pactum expects the corresponding destination to be the canonical
Token-2022 ATA for `(VaultAuthorityPDA, outcomeMint)`.

## Redeem fixture

QuickNode publishes this redemption transaction:

```text
2sF5df4KwTsKx4V8Qg3GLAQFRDRtctnVUaQbB9n3cjyvyHxKKr6RPHWu38HRvMozd7HGi5JvbLw4amXMQeYvLuL5
```

Captured USDC tie-market fixture:

Market ledger:

```text
GGViDLxL6RRQ4zTydGoiL6NnLugxyDGraydUBAQfo9iX
```

Settlement vault:

```text
BciG3VNEgDihNBcsZYxcJugBw59wQ7xRZAjen6ENaW6h
```

Winning YES mint:

```text
4qeSi2JVCbE9VQt1uzTJTpJSKdMFRsqWuvf3UL9fGa2P
```

Observed redeem data:

```text
5800000000000000
```

The captured redeem burned `5000000` outcome atoms and returned
`5000000` USDC atoms.

## Keeper-signer delegation research

DFlow's public cookbook discovers prediction markets with the Metadata API and
requests a trade transaction with the selected outcome mint plus
`userPublicKey`.

Pactum treats this as the supported discovery boundary:

- the keeper can use DFlow APIs to find the current active market
- the keeper can choose either approved outcome side
- Pactum must validate the selected market and execution constraints on-chain
- DFlow API responses are not settlement proof

Pactum is also testing a separate identity/custody model:

```text
keeper EOA                 VaultAuthorityPDA
    |                              |
    | DFlow signer/user            | owns pooled USDC
    |                              |
    +-------- temporary SPL -------+
              delegation
                    |
                    v
           DFlow OpenUserOrder
```

The test-only probe grants the keeper an exact SPL delegate allowance inside
one Pactum instruction, calls DFlow with the keeper in the observed repeated
user/signer roles, and revokes the allowance before return. A failed CPI rolls
back the complete transaction.

This does not change production `execute_trade`. Production remains
PDA-signed until observation proves all of these properties:

1. DFlow accepts the keeper as the verified trader while spending a
   PDA-owned USDC account through SPL delegation.
2. The delegation can be limited to exactly the validated input amount.
3. The asynchronous outcome destination can be fixed to VaultAuthorityPDA
   custody instead of the keeper.
4. Cancel/Revert refunds return to a PDA-owned account.
5. The selected DFlow output mint can be authenticated on-chain.
6. The keeper has no standing transfer authority after `execute_trade`
   returns.

The read-only `npm run inspect:dflow-order` tool compares current DFlow
`/order` transactions with and without a separate `destinationWallet`.
It resolves address lookup tables and reports signer, writable, and program
account relationships. It does not sign or submit transactions.

## Fork-test policy

Use real mainnet state when the test validates a DFlow relationship.

Examples:

- DFlow program ownership
- market ledger
- settlement-specific market USDC account
- outcome mint program ownership
- DFlow CPI account order
- signer propagation
- stable lifecycle events
- published transaction fixtures

Clone required account bytes into Surfpool before the transaction when remote
lazy loading would make the test depend on public-RPC availability.

Use synthetic local accounts only when the test validates Pactum state and the
external DFlow account contents are not part of the assertion.

Examples:

- synthetic closed user-order account for Pactum terminal accounting
- test-only pending-order seed
- donated token balances used to test Pactum accounting

Do not combine a market ledger from one market with a settlement vault or
outcome mint from another market.
