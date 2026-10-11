import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";

const METADATA_API_URL =
  process.env.DFLOW_PREDICTION_MARKETS_API_URL ??
  "https://dev-prediction-markets-api.dflow.net";
const TRADE_API_URL =
  process.env.DFLOW_TRADE_API_URL ?? "https://dev-quote-api.dflow.net";
const RPC_URL =
  process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const API_KEY = process.env.DFLOW_API_KEY;
const USDC_MINT =
  process.env.DFLOW_SETTLEMENT_MINT ??
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function headers() {
  return API_KEY ? { "x-api-key": API_KEY } : {};
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function discoverOutcomeMint() {
  if (process.env.DFLOW_PROBE_OUTPUT_MINT) {
    return {
      outputMint: process.env.DFLOW_PROBE_OUTPUT_MINT,
      marketTicker: null,
      side: null,
    };
  }

  const body = await fetchJson(
    `${METADATA_API_URL}/api/v1/events?withNestedMarkets=true&limit=200`,
  );
  for (const event of body.events ?? []) {
    for (const market of event.markets ?? []) {
      if (market.status !== "active") continue;
      const account =
        market.accounts?.[USDC_MINT] ?? Object.values(market.accounts ?? {})[0];
      if (account?.yesMint) {
        return {
          outputMint: account.yesMint,
          marketTicker: market.ticker ?? null,
          side: "yes",
        };
      }
      if (account?.noMint) {
        return {
          outputMint: account.noMint,
          marketTicker: market.ticker ?? null,
          side: "no",
        };
      }
    }
  }

  throw new Error("No active prediction-market outcome mint was discovered");
}

async function fetchOrder({ userPublicKey, outputMint, destinationWallet }) {
  const params = new URLSearchParams({
    inputMint: USDC_MINT,
    outputMint,
    amount: process.env.DFLOW_PROBE_AMOUNT ?? "1000000",
    slippageBps: process.env.DFLOW_PROBE_SLIPPAGE_BPS ?? "100",
    userPublicKey,
  });
  if (destinationWallet) params.set("destinationWallet", destinationWallet);

  return fetchJson(`${TRADE_API_URL}/order?${params.toString()}`);
}

async function resolveKeys(connection, tx) {
  const lookups = [];
  for (const lookup of tx.message.addressTableLookups ?? []) {
    const response = await connection.getAddressLookupTable(
      lookup.accountKey,
      { commitment: "confirmed" },
    );
    if (!response.value) {
      throw new Error(
        `Address lookup table is missing: ${lookup.accountKey.toBase58()}`,
      );
    }
    lookups.push(response.value);
  }
  return tx.message.getAccountKeys({ addressLookupTableAccounts: lookups });
}

async function summarizeOrder(label, order, connection, user, destination) {
  if (!order.transaction) {
    throw new Error(`${label} order response did not include a transaction`);
  }

  const tx = VersionedTransaction.deserialize(
    Buffer.from(order.transaction, "base64"),
  );
  const keys = await resolveKeys(connection, tx);
  const accountKeys = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys.get(index);
    accountKeys.push({
      index,
      key: key.toBase58(),
      signer: tx.message.isAccountSigner(index),
      writable: tx.message.isAccountWritable(index),
    });
  }

  const programs = tx.message.compiledInstructions.map((ix) => ({
    program: keys.get(ix.programIdIndex).toBase58(),
    accounts: [...ix.accountKeyIndexes].map((index) =>
      keys.get(index).toBase58(),
    ),
    dataHex: Buffer.from(ix.data).toString("hex"),
  }));

  return {
    label,
    request: {
      userPublicKey: user,
      destinationWallet: destination ?? null,
    },
    quote: {
      inAmount: order.inAmount ?? null,
      outAmount: order.outAmount ?? null,
      minOutAmount: order.minOutAmount ?? null,
      executionMode: order.executionMode ?? null,
    },
    userReferenced: accountKeys.some((item) => item.key === user),
    destinationReferenced: destination
      ? accountKeys.some((item) => item.key === destination)
      : null,
    accountKeys,
    programs,
  };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const user =
    process.env.DFLOW_PROBE_USER ?? Keypair.generate().publicKey.toBase58();
  const destination =
    process.env.DFLOW_PROBE_DESTINATION ??
    Keypair.generate().publicKey.toBase58();
  const discovered = await discoverOutcomeMint();

  const baseline = await fetchOrder({
    userPublicKey: user,
    outputMint: discovered.outputMint,
  });
  const destinationOrder = await fetchOrder({
    userPublicKey: user,
    outputMint: discovered.outputMint,
    destinationWallet: destination,
  });

  const [baselineSummary, destinationSummary] = await Promise.all([
    summarizeOrder("baseline", baseline, connection, user, null),
    summarizeOrder(
      "destination",
      destinationOrder,
      connection,
      user,
      destination,
    ),
  ]);

  console.log(
    JSON.stringify(
      {
        discovered,
        user,
        destination,
        transactionChanged:
          baseline.transaction !== destinationOrder.transaction,
        baseline: baselineSummary,
        destinationOrder: destinationSummary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
