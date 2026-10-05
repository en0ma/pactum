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

The original Pactum probe supplied VaultAuthorityPDA in the three repeated
user/authority signer roles and proved signer propagation with
`invoke_signed`.

PR #5 now tests and uses a stricter identity/custody split: the authorized
strategy keeper occupies the three DFlow user/signer roles, while the
PDA-owned USDC vault grants that keeper an exact temporary SPL delegate
allowance inside `execute_trade`. Pactum revokes the allowance before the
instruction can commit.

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

## Strategy keeper, market keeper, and custody

Pactum uses two independent off-chain keepers.

The strategy keeper keeps its existing behavior:

- discover the current DFlow market through DFlow APIs
- choose YES or NO
- request the quote/order data
- submit the keeper-signed Pactum transaction

The Pactum market keeper independently discovers the rolling market window and
publishes it to the `MarketRegistry` PDA:

- previous market
- current market
- next market
- each market ledger
- each USDC settlement vault
- each YES and NO mint
- each start and end timestamp
- monotonic registry sequence and observed slot

The market keeper cannot move vault funds. A registry update verifies the
current ledger is owned by the DFlow Prediction Markets program, verifies the
USDC settlement vault is controlled by that ledger, and verifies the current
YES and NO mints are Token-2022 mints.

`execute_trade` keeps the bot-supplied market and strategy inputs. Before
vault risk checks, Pactum requires those inputs to agree with the independently
published current registry entry and the approved on-chain DFlow accounts.

The execution authority model is:

```text
strategy keeper (DFlow user / signer)
              |
              | keeper-signed Pactum transaction
              v
        Pactum execute_trade
              |
              | validate registry + DFlow accounts + risk
              |
VaultAuthorityPDA owns vault_usdc
              |
              | SPL approve exact input_amount
              v
      strategy keeper delegate
              |
              | DFlow OpenUserOrder CPI
              v
             DFlow
              |
              | Pactum revokes delegate before commit
              v
        no standing authority
```

The delegated amount must equal the validated DFlow input amount. If the DFlow
CPI or revoke fails, Solana transaction atomicity rolls back the temporary
approval.

DFlow documents a `destinationWallet` concept and exposes `fillRecipient`
and `refundRecipient` in its on-chain trade feed. The mainnet probe therefore
correlates live 344-byte user-order accounts with the documented output mint,
fill recipient, and refund recipient. PR #5 is not merge-ready until multiple
live samples establish one stable offset for each field. Production validation
must then require the selected output mint and both asynchronous custody routes
to resolve to Pactum-controlled accounts.

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
