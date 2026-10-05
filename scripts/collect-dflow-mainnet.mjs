import fs from "node:fs";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";

const MAINNET_RPC_URL =
  process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const DFLOW_METADATA_API_URL =
  process.env.DFLOW_METADATA_API_URL ??
  "https://dev-prediction-markets-api.dflow.net";
const DFLOW_API_KEY = process.env.DFLOW_API_KEY;
const SAMPLE_LIMIT = Number(process.env.DFLOW_DATASET_SAMPLE_LIMIT ?? "40");
const TX_LIMIT_PER_ORDER = Number(
  process.env.DFLOW_DATASET_TX_LIMIT_PER_ORDER ?? "32",
);
const OUTPUT =
  process.env.DFLOW_DATASET_OUTPUT ??
  "artifacts/dflow-mainnet-observations.json";

const DFLOW_PM = new PublicKey(
  "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb",
);

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((ch, i) => [ch, BigInt(i)]));

function decodeBase58(text) {
  let value = 0n;
  for (const ch of text) {
    const digit = BASE58_MAP.get(ch);
    if (digit === undefined) throw new Error(`invalid base58 character: ${ch}`);
    value = value * 58n + digit;
  }
  const bytes = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  bytes.reverse();
  let leadingZeroes = 0;
  while (leadingZeroes < text.length && text[leadingZeroes] === "1") {
    leadingZeroes += 1;
  }
  return Buffer.concat([Buffer.alloc(leadingZeroes), Buffer.from(bytes)]);
}

function parseUserOrderEvent(data) {
  if (
    data.length < 162 ||
    data[0] !== 0xf0 ||
    !data.subarray(1, 8).every((byte) => byte === 0) ||
    data[8] !== 0x02
  ) {
    return null;
  }

  return {
    type: data[9],
    typeName:
      data[9] === 1
        ? "open"
        : data[9] === 2
          ? "fill"
          : data[9] === 3
            ? "cancel"
            : data[9] === 4
              ? "revert"
              : "unknown",
    userOrder: new PublicKey(data.subarray(10, 42)).toBase58(),
    inputMint: new PublicKey(data.subarray(42, 74)).toBase58(),
    inputAmount: data.readBigUInt64LE(74).toString(),
    outputMint: new PublicKey(data.subarray(82, 114)).toBase58(),
    outputAmount: data.readBigUInt64LE(114).toString(),
    feeMint: new PublicKey(data.subarray(122, 154)).toBase58(),
    feeAmount: data.readBigUInt64LE(154).toString(),
  };
}

function findOffsets(data, pubkey) {
  if (!pubkey) return [];
  let needle;
  try {
    needle = new PublicKey(pubkey).toBuffer();
  } catch {
    return [];
  }
  const offsets = [];
  for (let offset = 0; offset <= data.length - needle.length; offset += 1) {
    if (data.subarray(offset, offset + needle.length).equals(needle)) {
      offsets.push(offset);
    }
  }
  return offsets;
}

function resolvedKeys(tx) {
  const staticKeys = tx.transaction.message.staticAccountKeys.map((key) =>
    key.toBase58(),
  );
  return [
    ...staticKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []).map((key) => key.toBase58()),
    ...(tx.meta?.loadedAddresses?.readonly ?? []).map((key) => key.toBase58()),
  ];
}

function instructions(tx) {
  return [
    ...(tx.transaction.message.compiledInstructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap(
      (group) => group.instructions ?? [],
    ),
  ];
}

function dflowEvents(tx, keys) {
  const events = [];
  for (const ix of instructions(tx)) {
    if (typeof ix.programIdIndex !== "number") continue;
    if (keys[ix.programIdIndex] !== DFLOW_PM.toBase58()) continue;
    const encoded = ix.data;
    if (typeof encoded !== "string") continue;
    const event = parseUserOrderEvent(decodeBase58(encoded));
    if (event) events.push(event);
  }
  return events;
}

function tokenBalances(tx, keys) {
  const before = new Map(
    (tx.meta?.preTokenBalances ?? []).map((item) => [
      `${item.accountIndex}:${item.mint}`,
      item,
    ]),
  );
  const after = new Map(
    (tx.meta?.postTokenBalances ?? []).map((item) => [
      `${item.accountIndex}:${item.mint}`,
      item,
    ]),
  );
  const joined = new Set([...before.keys(), ...after.keys()]);
  return [...joined].map((key) => {
    const pre = before.get(key);
    const post = after.get(key);
    const accountIndex = (pre ?? post).accountIndex;
    const preAmount = BigInt(pre?.uiTokenAmount?.amount ?? "0");
    const postAmount = BigInt(post?.uiTokenAmount?.amount ?? "0");
    return {
      accountIndex,
      account: keys[accountIndex] ?? null,
      mint: (pre ?? post).mint,
      owner: post?.owner ?? pre?.owner ?? null,
      preAmount: preAmount.toString(),
      postAmount: postAmount.toString(),
      delta: (postAmount - preAmount).toString(),
      programId: post?.programId ?? pre?.programId ?? null,
    };
  });
}

function signerKeys(tx) {
  const header = tx.transaction.message.header;
  return tx.transaction.message.staticAccountKeys
    .slice(0, header.numRequiredSignatures)
    .map((key) => key.toBase58());
}

async function fetchTrades() {
  const headers = {};
  if (DFLOW_API_KEY) headers["x-api-key"] = DFLOW_API_KEY;
  const response = await fetch(
    `${DFLOW_METADATA_API_URL}/api/v1/onchain-trades?limit=200`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(
      `DFlow onchain-trades failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = await response.json();
  const trades = body?.trades ?? [];
  if (!Array.isArray(trades) || trades.length === 0) {
    throw new Error("DFlow onchain-trades returned no trades");
  }
  return trades;
}

function uniqueOrders(trades) {
  const orders = new Map();
  for (const trade of trades) {
    if (typeof trade?.orderAccount !== "string") continue;
    const current = orders.get(trade.orderAccount);
    if (!current) orders.set(trade.orderAccount, trade);
  }
  return [...orders.values()].slice(0, SAMPLE_LIMIT);
}

async function collectOrder(connection, trade) {
  const order = new PublicKey(trade.orderAccount);
  const [accountInfo, signatures] = await Promise.all([
    connection.getAccountInfo(order, "confirmed"),
    connection.getSignaturesForAddress(order, {
      limit: TX_LIMIT_PER_ORDER,
    }),
  ]);

  const txs = [];
  for (const item of signatures) {
    if (item.err) continue;
    const tx = await connection.getTransaction(item.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;
    const keys = resolvedKeys(tx);
    const events = dflowEvents(tx, keys).filter(
      (event) => event.userOrder === trade.orderAccount,
    );
    if (events.length === 0) continue;

    txs.push({
      signature: item.signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      signers: signerKeys(tx),
      events,
      tokenBalances: tokenBalances(tx, keys).filter(
        (item) => item.delta !== "0",
      ),
      dflowInstructions: instructions(tx)
        .filter(
          (ix) =>
            typeof ix.programIdIndex === "number" &&
            keys[ix.programIdIndex] === DFLOW_PM.toBase58(),
        )
        .map((ix) => ({
          accounts: [...(ix.accountKeyIndexes ?? [])].map(
            (index) => keys[index] ?? null,
          ),
          data:
            typeof ix.data === "string"
              ? Buffer.from(decodeBase58(ix.data)).toString("hex")
              : null,
        })),
    });
  }

  txs.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const events = txs.flatMap((tx) =>
    tx.events.map((event) => ({
      signature: tx.signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      ...event,
    })),
  );

  let account = null;
  if (accountInfo) {
    const data = Buffer.from(accountInfo.data);
    account = {
      owner: accountInfo.owner.toBase58(),
      lamports: accountInfo.lamports,
      dataLength: data.length,
      dataBase64: data.toString("base64"),
      outputMintOffsets: findOffsets(data, trade.outputMint),
      fillRecipientOffsets: findOffsets(data, trade.fillRecipient),
      refundRecipientOffsets: findOffsets(data, trade.refundRecipient),
      walletOffsets: findOffsets(data, trade.wallet),
    };
  }

  return {
    feed: {
      orderAccount: trade.orderAccount,
      wallet: trade.wallet ?? null,
      fillRecipient: trade.fillRecipient ?? null,
      refundRecipient: trade.refundRecipient ?? null,
      inputMint: trade.inputMint ?? null,
      outputMint: trade.outputMint ?? null,
      inputAmount: String(trade.inputAmount ?? ""),
      outputAmount: String(trade.outputAmount ?? ""),
      transactionSignature: trade.transactionSignature ?? null,
      marketTicker: trade.marketTicker ?? trade.ticker ?? null,
    },
    account,
    events,
    transactions: txs,
  };
}

function stableOffset(samples, field) {
  const populated = samples
    .filter((sample) => sample.account?.dataLength === 344)
    .map((sample) => sample.account[field])
    .filter((offsets) => Array.isArray(offsets) && offsets.length > 0);
  if (populated.length < 2) return null;
  const common = populated[0].filter((offset) =>
    populated.slice(1).every((offsets) => offsets.includes(offset)),
  );
  return common.length === 1 ? common[0] : null;
}

function summarize(samples) {
  const lifecycleCounts = {};
  let distinctWalletFill = 0;
  let distinctWalletRefund = 0;
  let terminal = 0;
  let live344 = 0;

  for (const sample of samples) {
    if (sample.account?.dataLength === 344) live344 += 1;
    if (
      sample.feed.wallet &&
      sample.feed.fillRecipient &&
      sample.feed.wallet !== sample.feed.fillRecipient
    ) {
      distinctWalletFill += 1;
    }
    if (
      sample.feed.wallet &&
      sample.feed.refundRecipient &&
      sample.feed.wallet !== sample.feed.refundRecipient
    ) {
      distinctWalletRefund += 1;
    }
    const types = [...new Set(sample.events.map((event) => event.typeName))];
    const key = types.join("->") || "none";
    lifecycleCounts[key] = (lifecycleCounts[key] ?? 0) + 1;
    if (types.includes("cancel") || types.includes("revert")) terminal += 1;
  }

  return {
    sampledOrders: samples.length,
    live344OrderAccounts: live344,
    walletDiffersFromFillRecipient: distinctWalletFill,
    walletDiffersFromRefundRecipient: distinctWalletRefund,
    ordersWithCancelOrRevertEvidence: terminal,
    stableOffsetsAmongLive344: {
      outputMint: stableOffset(samples, "outputMintOffsets"),
      fillRecipient: stableOffset(samples, "fillRecipientOffsets"),
      refundRecipient: stableOffset(samples, "refundRecipientOffsets"),
      wallet: stableOffset(samples, "walletOffsets"),
    },
    lifecycleCounts,
  };
}

async function main() {
  const connection = new Connection(MAINNET_RPC_URL, "confirmed");
  const trades = await fetchTrades();
  const candidates = uniqueOrders(trades);
  const samples = [];

  for (const trade of candidates) {
    try {
      samples.push(await collectOrder(connection, trade));
    } catch (error) {
      samples.push({
        feed: {
          orderAccount: trade.orderAccount,
          wallet: trade.wallet ?? null,
          fillRecipient: trade.fillRecipient ?? null,
          refundRecipient: trade.refundRecipient ?? null,
          inputMint: trade.inputMint ?? null,
          outputMint: trade.outputMint ?? null,
          inputAmount: String(trade.inputAmount ?? ""),
          outputAmount: String(trade.outputAmount ?? ""),
          transactionSignature: trade.transactionSignature ?? null,
        },
        collectionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const dataset = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    dflowProgram: DFLOW_PM.toBase58(),
    source: {
      metadataApi: DFLOW_METADATA_API_URL,
      rpc: MAINNET_RPC_URL,
      feedTradeCount: trades.length,
      sampleLimit: SAMPLE_LIMIT,
      txLimitPerOrder: TX_LIMIT_PER_ORDER,
    },
    summary: summarize(samples.filter((sample) => !sample.collectionError)),
    samples,
  };

  fs.mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(dataset, null, 2) + "\n");

  console.log("DFlow mainnet observation summary");
  console.log(JSON.stringify(dataset.summary, null, 2));
  console.log(`dataset=${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
