import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
if (!MAINNET_RPC_URL) {
  throw new Error("MAINNET_RPC_URL is required for DFlow mainnet evidence");
}
const RPC_HOSTNAME = new URL(MAINNET_RPC_URL).hostname;
if (RPC_HOSTNAME === "api.mainnet-beta.solana.com") {
  throw new Error(
    "DFlow evidence must use the configured private MAINNET_RPC_URL, not the public Solana RPC",
  );
}
const SAMPLE_LIMIT = Number(process.env.DFLOW_DATASET_SAMPLE_LIMIT ?? "40");
const PROGRAM_SIGNATURE_PAGE = Number(
  process.env.DFLOW_DATASET_PROGRAM_SIGNATURE_PAGE ?? "100",
);
const PROGRAM_SCAN_LIMIT = Number(
  process.env.DFLOW_DATASET_PROGRAM_SCAN_LIMIT ?? "1200",
);
const TX_LIMIT_PER_ORDER = Number(
  process.env.DFLOW_DATASET_TX_LIMIT_PER_ORDER ?? "32",
);
const OUTPUT =
  process.env.DFLOW_DATASET_OUTPUT ??
  "artifacts/dflow-mainnet-observations.json";

const DFLOW_PM = new PublicKey(
  "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb",
);
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((ch, i) => [ch, BigInt(i)]));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("429") ||
    message.toLowerCase().includes("too many requests") ||
    message.toLowerCase().includes("rate limit")
  );
}

async function rpcWithRetry(label, fn, attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimitError(error) || attempt === attempts) throw error;
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 16000);
      console.warn(
        `${label}: RPC rate limited; retry ${attempt}/${attempts} after ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error(`${label}: exhausted retries`);
}

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

function readU64LE(buffer, offset) {
  if (buffer.length < offset + 8) return null;
  return buffer.readBigUInt64LE(offset);
}

function classifyOpenInstruction(ix) {
  if (!ix?.dataHex) return null;
  const data = Buffer.from(ix.dataHex, "hex");
  if (data.length !== 80) return null;
  if (readU64LE(data, 0) !== 0x40n) return null;
  if (ix.accounts.length !== 11) return null;
  if (ix.accounts[4] !== USDC_MINT) return null;
  if (ix.accounts[9] !== SPL_TOKEN_PROGRAM) return null;
  if (
    !ix.accounts[3] ||
    !ix.accounts[5] ||
    !ix.accounts[6] ||
    ix.accounts[6] !== ix.accounts[7] ||
    ix.accounts[7] !== ix.accounts[8]
  ) {
    return null;
  }

  return {
    orderAccount: ix.accounts[3],
    marketLedger: ix.accounts[1],
    marketUsdcAccount: ix.accounts[2],
    sourceUsdc: ix.accounts[5],
    user: ix.accounts[6],
    inputAmount: readU64LE(data, 24)?.toString() ?? null,
    quotedOutputAmount: readU64LE(data, 32)?.toString() ?? null,
    dataHex: ix.dataHex,
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

function allInstructions(tx) {
  return [
    ...(tx.transaction.message.compiledInstructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap(
      (group) => group.instructions ?? [],
    ),
  ];
}

function dflowInstructions(tx, keys) {
  return allInstructions(tx)
    .filter(
      (ix) =>
        typeof ix.programIdIndex === "number" &&
        keys[ix.programIdIndex] === DFLOW_PM.toBase58(),
    )
    .map((ix) => ({
      accounts: [...(ix.accountKeyIndexes ?? [])].map(
        (index) => keys[index] ?? null,
      ),
      dataHex:
        typeof ix.data === "string"
          ? Buffer.from(decodeBase58(ix.data)).toString("hex")
          : null,
      event:
        typeof ix.data === "string"
          ? parseUserOrderEvent(decodeBase58(ix.data))
          : null,
    }));
}

function tokenBalanceDeltas(tx, keys) {
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
  return [...joined]
    .map((key) => {
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
    })
    .filter((item) => item.delta !== "0");
}

function signerKeys(tx) {
  const count = tx.transaction.message.header.numRequiredSignatures;
  return tx.transaction.message.staticAccountKeys
    .slice(0, count)
    .map((key) => key.toBase58());
}

function positiveRecipient(deltas, mint) {
  const matches = deltas.filter(
    (item) => item.mint === mint && BigInt(item.delta) > 0n,
  );
  return matches.length === 1
    ? {
        account: matches[0].account,
        owner: matches[0].owner,
        delta: matches[0].delta,
      }
    : null;
}

function negativeSource(deltas, mint) {
  const matches = deltas.filter(
    (item) => item.mint === mint && BigInt(item.delta) < 0n,
  );
  return matches.length === 1
    ? {
        account: matches[0].account,
        owner: matches[0].owner,
        delta: matches[0].delta,
      }
    : null;
}

async function getTransactionWithRetry(connection, signature) {
  return rpcWithRetry(
    `getTransaction ${signature.slice(0, 12)}`,
    () =>
      connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
  );
}

async function discoverOrdersFromChain(connection) {
  const orders = new Map();
  const instructionShapes = {};
  const instructionExamples = [];
  let before;
  let scannedSignatures = 0;
  let dflowInstructionCount = 0;

  while (
    scannedSignatures < PROGRAM_SCAN_LIMIT &&
    orders.size < SAMPLE_LIMIT
  ) {
    const signatures = await rpcWithRetry(
      "getSignaturesForAddress DFlow program",
      () =>
        connection.getSignaturesForAddress(
          DFLOW_PM,
          {
            limit: PROGRAM_SIGNATURE_PAGE,
            ...(before ? { before } : {}),
          },
          "confirmed",
        ),
    );
    if (signatures.length === 0) break;

    for (const item of signatures) {
      scannedSignatures += 1;
      if (item.err) continue;

      const tx = await getTransactionWithRetry(connection, item.signature);
      if (!tx) continue;
      const keys = resolvedKeys(tx);
      const dflowIxs = dflowInstructions(tx, keys);
      const deltas = tokenBalanceDeltas(tx, keys);

      for (const ix of dflowIxs) {
        dflowInstructionCount += 1;
        const data = ix.dataHex ? Buffer.from(ix.dataHex, "hex") : null;
        const actionU64 =
          data && data.length >= 8 ? readU64LE(data, 0)?.toString() : null;
        const shapeKey = [
          `len=${data?.length ?? 0}`,
          `action=${actionU64 ?? "none"}`,
          `accounts=${ix.accounts.length}`,
        ].join("|");
        instructionShapes[shapeKey] = (instructionShapes[shapeKey] ?? 0) + 1;

        if (instructionExamples.length < 100) {
          instructionExamples.push({
            signature: item.signature,
            slot: tx.slot,
            blockTime: tx.blockTime,
            dataLength: data?.length ?? null,
            actionU64,
            dataHex: ix.dataHex,
            accounts: ix.accounts,
            signers: signerKeys(tx),
            tokenBalanceDeltas: deltas,
          });
        }

        const open = classifyOpenInstruction(ix);
        if (!open) continue;

        const sourceDelta = deltas.find(
          (delta) =>
            delta.account === open.sourceUsdc &&
            delta.mint === USDC_MINT &&
            BigInt(delta.delta) < 0n,
        );

        const debitMatches =
          sourceDelta &&
          -BigInt(sourceDelta.delta) === BigInt(open.inputAmount);

        if (!orders.has(open.orderAccount)) {
          orders.set(open.orderAccount, {
            ...open,
            openSignature: item.signature,
            openSlot: tx.slot,
            openBlockTime: tx.blockTime,
            openSigners: signerKeys(tx),
            inputMint: USDC_MINT,
            sourceDebitObserved: sourceDelta?.delta ?? null,
            sourceDebitMatchesEncodedInput: Boolean(debitMatches),
            openTokenBalanceDeltas: deltas,
          });
        }
      }

      if (orders.size >= SAMPLE_LIMIT) break;
      await sleep(150);
    }

    before = signatures.at(-1)?.signature;
    if (!before) break;
  }

  return {
    candidates: [...orders.values()],
    scannedSignatures,
    dflowInstructionCount,
    instructionShapes,
    instructionExamples,
  };
}

async function collectOrder(connection, seed) {
  const order = new PublicKey(seed.orderAccount);
  const accountInfo = await rpcWithRetry(
    `getAccountInfo ${seed.orderAccount}`,
    () => connection.getAccountInfo(order, "confirmed"),
  );
  const signatures = await rpcWithRetry(
    `getSignaturesForAddress ${seed.orderAccount}`,
    () =>
      connection.getSignaturesForAddress(
        order,
        { limit: TX_LIMIT_PER_ORDER },
        "confirmed",
      ),
  );

  const txs = [];
  for (const item of signatures) {
    if (item.err) continue;
    const tx = await getTransactionWithRetry(connection, item.signature);
    if (!tx) continue;
    const keys = resolvedKeys(tx);
    const deltas = tokenBalanceDeltas(tx, keys);
    const dflowIxs = dflowInstructions(tx, keys);
    if (dflowIxs.length === 0) continue;

    txs.push({
      signature: item.signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      signers: signerKeys(tx),
      tokenBalanceDeltas: deltas,
      dflowInstructions: dflowIxs.map((ix) => {
        const data = ix.dataHex ? Buffer.from(ix.dataHex, "hex") : null;
        return {
          accounts: ix.accounts,
          dataHex: ix.dataHex,
          dataLength: data?.length ?? null,
          actionU64:
            data && data.length >= 8 ? readU64LE(data, 0)?.toString() : null,
          parsedEvent: ix.event,
        };
      }),
    });
    await sleep(150);
  }

  txs.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

  const source = {
    account: seed.sourceUsdc,
    owner:
      seed.openTokenBalanceDeltas.find(
        (item) => item.account === seed.sourceUsdc && item.mint === USDC_MINT,
      )?.owner ?? null,
    delta:
      seed.openTokenBalanceDeltas.find(
        (item) => item.account === seed.sourceUsdc && item.mint === USDC_MINT,
      )?.delta ?? null,
  };

  const nonOpenTransactions = txs.filter(
    (tx) => tx.signature !== seed.openSignature,
  );
  const outputCandidates = nonOpenTransactions.flatMap((tx) =>
    tx.tokenBalanceDeltas
      .filter(
        (item) =>
          item.mint !== USDC_MINT &&
          BigInt(item.delta) > 0n,
      )
      .map((item) => ({
        signature: tx.signature,
        slot: tx.slot,
        account: item.account,
        owner: item.owner,
        mint: item.mint,
        delta: item.delta,
        programId: item.programId,
      })),
  );
  const refundCandidates = nonOpenTransactions.flatMap((tx) =>
    tx.tokenBalanceDeltas
      .filter(
        (item) =>
          item.mint === USDC_MINT &&
          BigInt(item.delta) > 0n,
      )
      .map((item) => ({
        signature: tx.signature,
        slot: tx.slot,
        account: item.account,
        owner: item.owner,
        mint: item.mint,
        delta: item.delta,
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
      outputMintOffsets: [
        ...new Set(outputCandidates.map((item) => item.mint)),
      ].flatMap((mint) =>
        findOffsets(data, mint).map((offset) => ({ mint, offset })),
      ),
      sourceOwnerOffsets: findOffsets(data, source?.owner),
      fillRecipientOwnerOffsets: [
        ...new Set(outputCandidates.map((item) => item.owner).filter(Boolean)),
      ].flatMap((owner) =>
        findOffsets(data, owner).map((offset) => ({ owner, offset })),
      ),
      refundRecipientOwnerOffsets: [
        ...new Set(refundCandidates.map((item) => item.owner).filter(Boolean)),
      ].flatMap((owner) =>
        findOffsets(data, owner).map((offset) => ({ owner, offset })),
      ),
      signerOffsets: seed.openSigners.flatMap((signer) =>
        findOffsets(data, signer).map((offset) => ({ signer, offset })),
      ),
    };
  }

  return {
    seed,
    source,
    outputCandidates,
    refundCandidates,
    account,
    transactions: txs,
  };
}

function stableNumberOffset(samples, getter) {
  const populated = samples
    .map(getter)
    .filter((offsets) => Array.isArray(offsets) && offsets.length > 0);
  if (populated.length < 2) return null;
  const common = populated[0].filter((offset) =>
    populated.slice(1).every((offsets) => offsets.includes(offset)),
  );
  return common.length === 1 ? common[0] : null;
}

function summarize(samples, scannedSignatures) {
  const actionCounts = {};
  let live344 = 0;
  let sourceOwnerDiffersFromOpenUser = 0;
  let ordersWithOutcomeCandidate = 0;
  let ordersWithRefundCandidate = 0;

  for (const sample of samples) {
    if (sample.account?.dataLength === 344) live344 += 1;
    if (
      sample.source?.owner &&
      sample.seed.user &&
      sample.source.owner !== sample.seed.user
    ) {
      sourceOwnerDiffersFromOpenUser += 1;
    }
    if (sample.outputCandidates?.length > 0) ordersWithOutcomeCandidate += 1;
    if (sample.refundCandidates?.length > 0) ordersWithRefundCandidate += 1;

    for (const tx of sample.transactions ?? []) {
      for (const ix of tx.dflowInstructions ?? []) {
        const key = ix.actionU64 ?? `len:${ix.dataLength}`;
        actionCounts[key] = (actionCounts[key] ?? 0) + 1;
      }
    }
  }

  return {
    scannedProgramSignatures: scannedSignatures,
    sampledOrders: samples.length,
    live344OrderAccounts: live344,
    sourceOwnerDiffersFromOpenUser,
    ordersWithOutcomeCandidate,
    ordersWithRefundCandidate,
    actionCounts,
  };
}

async function main() {
  console.log(`Using configured mainnet RPC host: ${RPC_HOSTNAME}`);
  const connection = new Connection(MAINNET_RPC_URL, "confirmed");
  const discovery = await discoverOrdersFromChain(connection);
  const samples = [];
  for (const seed of discovery.candidates) {
    try {
      samples.push(await collectOrder(connection, seed));
    } catch (error) {
      samples.push({
        seed,
        collectionError:
          error instanceof Error ? error.message : String(error),
      });
    }
  }

  const completeSamples = samples.filter((sample) => !sample.collectionError);
  const dataset = {
    schemaVersion: 2,
    collectedAt: new Date().toISOString(),
    dflowProgram: DFLOW_PM.toBase58(),
    source: {
      kind: "solana-mainnet-rpc-only",
      rpcHost: RPC_HOSTNAME,
      sampleLimit: SAMPLE_LIMIT,
      programScanLimit: PROGRAM_SCAN_LIMIT,
      programSignaturePage: PROGRAM_SIGNATURE_PAGE,
      txLimitPerOrder: TX_LIMIT_PER_ORDER,
    },
    summary: {
      ...summarize(completeSamples, discovery.scannedSignatures),
      discoveredOpenCandidates: discovery.candidates.length,
      dflowInstructionCount: discovery.dflowInstructionCount,
      instructionShapes: discovery.instructionShapes,
    },
    instructionExamples: discovery.instructionExamples,
    samples,
  };

  fs.mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(dataset, null, 2) + "\n");

  if (discovery.candidates.length === 0) {
    console.warn(
      `No exact OpenUserOrder fingerprint found in ${discovery.scannedSignatures} program signatures; diagnostic instruction evidence was still captured.`,
    );
  }
  console.log("DFlow mainnet on-chain evidence summary");
  console.log(JSON.stringify(dataset.summary, null, 2));
  console.log(`dataset=${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
