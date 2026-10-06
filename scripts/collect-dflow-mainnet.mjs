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
const INSTRUCTION_EXAMPLE_LIMIT = Number(
  process.env.DFLOW_DATASET_INSTRUCTION_EXAMPLE_LIMIT ?? "1000",
);
const PROGRAM_SIGNATURE_PAGE = Number(
  process.env.DFLOW_DATASET_PROGRAM_SIGNATURE_PAGE ?? "100",
);
const PROGRAM_SCAN_LIMIT = Number(
  process.env.DFLOW_DATASET_PROGRAM_SCAN_LIMIT ?? "15000",
);
const SCAN_AFTER_UNIX = Math.floor(
  new Date(process.env.DFLOW_DATASET_SCAN_AFTER ?? "2026-05-01T00:00:00Z").getTime() /
    1000,
);
const SCAN_BEFORE_UNIX = Math.floor(
  new Date(process.env.DFLOW_DATASET_SCAN_BEFORE ?? "2026-06-01T00:00:00Z").getTime() /
    1000,
);
const TX_LIMIT_PER_ORDER = Number(
  process.env.DFLOW_DATASET_TX_LIMIT_PER_ORDER ?? "32",
);
const OUTPUT =
  process.env.DFLOW_DATASET_OUTPUT ??
  "artifacts/dflow-mainnet-observations.json";
const START_BEFORE_SIGNATURE =
  process.env.DFLOW_DATASET_START_BEFORE_SIGNATURE || undefined;
const MAX_RUNTIME_MS = Number(
  process.env.DFLOW_DATASET_MAX_RUNTIME_MS ?? String(6 * 60 * 1000),
);

const DFLOW_PM = new PublicKey(
  "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb",
);
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

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
    data.length < 168 ||
    data[0] !== 0xf0 ||
    !data.subarray(1, 8).every((byte) => byte === 0) ||
    data[8] !== 0x02
  ) {
    return null;
  }

  // Current mainnet UserOrder events include a 6-byte event header after subtype.
  const base = 16;
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
    userOrder: new PublicKey(data.subarray(base, base + 32)).toBase58(),
    inputMint: new PublicKey(data.subarray(base + 32, base + 64)).toBase58(),
    inputAmount: data.readBigUInt64LE(base + 64).toString(),
    outputMint: new PublicKey(data.subarray(base + 72, base + 104)).toBase58(),
    outputAmount: data.readBigUInt64LE(base + 104).toString(),
    feeMint: new PublicKey(data.subarray(base + 112, base + 144)).toBase58(),
    feeAmount: data.readBigUInt64LE(base + 144).toString(),
    identity0:
      data.length >= 200
        ? new PublicKey(data.subarray(168, 200)).toBase58()
        : null,
    identity1:
      data.length >= 232
        ? new PublicKey(data.subarray(200, 232)).toBase58()
        : null,
    identity2:
      data.length >= 264
        ? new PublicKey(data.subarray(232, 264)).toBase58()
        : null,
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
    !ix.accounts[7] ||
    !ix.accounts[8]
  ) {
    return null;
  }

  return {
    orderAccount: ix.accounts[3],
    marketLedger: ix.accounts[1],
    marketUsdcAccount: ix.accounts[2],
    sourceUsdc: ix.accounts[5],
    user: ix.accounts[6],
    fillRecipient: ix.accounts[7],
    refundRecipient: ix.accounts[8],
    recipientIdentitiesDiverge:
      new Set([ix.accounts[6], ix.accounts[7], ix.accounts[8]]).size > 1,
    inputAmount: readU64LE(data, 24)?.toString() ?? null,
    quotedOutputAmount: readU64LE(data, 32)?.toString() ?? null,
    dataHex: ix.dataHex,
  };
}

function canonicalAta(owner, mint, tokenProgram = SPL_TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(tokenProgram).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0].toBase58();
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

function resolvedKeyMetas(tx) {
  const message = tx.transaction.message;
  const staticKeys = message.staticAccountKeys.map((key) => key.toBase58());
  const required = message.header.numRequiredSignatures;
  const readonlySigned = message.header.numReadonlySignedAccounts;
  const readonlyUnsigned = message.header.numReadonlyUnsignedAccounts;
  const staticCount = staticKeys.length;

  const metas = staticKeys.map((pubkey, index) => {
    const isSigner = index < required;
    const isWritable = isSigner
      ? index < required - readonlySigned
      : index < staticCount - readonlyUnsigned;
    return { pubkey, isSigner, isWritable, source: "static" };
  });

  for (const key of tx.meta?.loadedAddresses?.writable ?? []) {
    metas.push({
      pubkey: key.toBase58(),
      isSigner: false,
      isWritable: true,
      source: "lookup-writable",
    });
  }
  for (const key of tx.meta?.loadedAddresses?.readonly ?? []) {
    metas.push({
      pubkey: key.toBase58(),
      isSigner: false,
      isWritable: false,
      source: "lookup-readonly",
    });
  }
  return metas;
}

function allInstructions(tx) {
  return [
    ...(tx.transaction.message.compiledInstructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap(
      (group) => group.instructions ?? [],
    ),
  ];
}

function instructionDataBytes(ix) {
  if (typeof ix.data === "string") {
    return decodeBase58(ix.data);
  }
  if (ix.data instanceof Uint8Array || Buffer.isBuffer(ix.data)) {
    return Buffer.from(ix.data);
  }
  if (Array.isArray(ix.data)) {
    return Buffer.from(ix.data);
  }
  return null;
}

function instructionAccountIndexes(ix) {
  if (Array.isArray(ix.accountKeyIndexes)) return ix.accountKeyIndexes;
  if (Array.isArray(ix.accounts)) return ix.accounts;
  if (ix.accountKeyIndexes instanceof Uint8Array) {
    return [...ix.accountKeyIndexes];
  }
  if (ix.accounts instanceof Uint8Array) {
    return [...ix.accounts];
  }
  return [];
}

function dflowInstructions(tx, keys) {
  const keyMetas = resolvedKeyMetas(tx);
  return allInstructions(tx)
    .filter(
      (ix) =>
        typeof ix.programIdIndex === "number" &&
        keys[ix.programIdIndex] === DFLOW_PM.toBase58(),
    )
    .map((ix) => {
      const data = instructionDataBytes(ix);
      const rawAccounts = instructionAccountIndexes(ix).map(
        (index) => keys[index] ?? null,
      );
      const accounts =
        rawAccounts[0] === DFLOW_PM.toBase58()
          ? rawAccounts.slice(1)
          : rawAccounts;
      const rawIndexes = instructionAccountIndexes(ix);
      const normalizedIndexes =
        rawAccounts[0] === DFLOW_PM.toBase58()
          ? rawIndexes.slice(1)
          : rawIndexes;
      return {
        accounts,
        accountMetas: normalizedIndexes.map((index) => keyMetas[index] ?? null),
        rawAccounts,
        dataHex: data ? data.toString("hex") : null,
        event: data ? parseUserOrderEvent(data) : null,
      };
    });
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

function tokenBalanceSnapshots(tx, keys) {
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

function decodeSplTokenInstruction(programId, data) {
  if (programId !== SPL_TOKEN_PROGRAM || !data || data.length === 0) return null;
  const opcode = data[0];
  const names = {
    1: "initialize_account",
    3: "transfer",
    4: "approve",
    5: "revoke",
    9: "close_account",
    12: "transfer_checked",
    13: "approve_checked",
    16: "initialize_account2",
    18: "initialize_account3",
  };
  const decoded = { opcode, name: names[opcode] ?? "unknown" };
  if ((opcode === 3 || opcode === 4) && data.length >= 9) {
    decoded.amount = data.readBigUInt64LE(1).toString();
  }
  if ((opcode === 12 || opcode === 13) && data.length >= 10) {
    decoded.amount = data.readBigUInt64LE(1).toString();
    decoded.decimals = data[9];
  }
  return decoded;
}

function traceInstruction(ix, keys, keyMetas, outerIndex, innerIndex = null) {
  const data = instructionDataBytes(ix);
  const indexes = instructionAccountIndexes(ix);
  const programId =
    typeof ix.programIdIndex === "number" ? keys[ix.programIdIndex] ?? null : null;
  return {
    outerIndex,
    innerIndex,
    stackHeight: ix.stackHeight ?? null,
    programId,
    accounts: indexes.map((index) => keys[index] ?? null),
    accountMetas: indexes.map((index) => keyMetas[index] ?? null),
    dataHex: data ? data.toString("hex") : null,
    splToken: decodeSplTokenInstruction(programId, data),
  };
}

function orderedInstructionTrace(tx, keys) {
  const keyMetas = resolvedKeyMetas(tx);
  const outer = tx.transaction.message.compiledInstructions ?? [];
  const innerByOuter = new Map(
    (tx.meta?.innerInstructions ?? []).map((group) => [
      group.index,
      group.instructions ?? [],
    ]),
  );
  const trace = [];
  for (let outerIndex = 0; outerIndex < outer.length; outerIndex += 1) {
    trace.push(traceInstruction(outer[outerIndex], keys, keyMetas, outerIndex));
    const inner = innerByOuter.get(outerIndex) ?? [];
    for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
      trace.push(
        traceInstruction(
          inner[innerIndex],
          keys,
          keyMetas,
          outerIndex,
          innerIndex,
        ),
      );
    }
  }
  return trace;
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
  const startedAt = Date.now();
  const orders = new Map();
  const instructionShapes = {};
  const instructionExamples = [];
  let before = START_BEFORE_SIGNATURE;
  let scannedSignatures = 0;
  let oldestSignature = before ?? null;
  let oldestBlockTime = null;
  let windowSignatures = 0;
  let dflowInstructionCount = 0;
  let totalOpenInstructions = 0;
  let divergentOpenInstructions = 0;
  const divergentOpenExamples = [];
  let openEventCount = 0;
  let usdcInputOpenEventCount = 0;
  const openEventExamples = [];
  let action64InstructionCount = 0;
  const action64InstructionShapes = {};
  const action64InstructionExamples = [];
  let reachedWindow = false;

  while (
    scannedSignatures < PROGRAM_SCAN_LIMIT &&
    Date.now() - startedAt < MAX_RUNTIME_MS
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

    const tail = signatures.at(-1);
    if (tail) {
      oldestSignature = tail.signature;
      oldestBlockTime = tail.blockTime ?? oldestBlockTime;
    }

    if (scannedSignatures === 0 || scannedSignatures % 5000 === 0) {
      console.log(
        `historical scan progress: scanned=${scannedSignatures}, oldestBlockTime=${oldestBlockTime ? new Date(oldestBlockTime * 1000).toISOString() : "unknown"}`,
      );
    }

    for (const item of signatures) {
      if (Date.now() - startedAt >= MAX_RUNTIME_MS) break;
      scannedSignatures += 1;
      if (!item.blockTime) continue;

      if (item.blockTime >= SCAN_BEFORE_UNIX) {
        continue;
      }
      if (item.blockTime < SCAN_AFTER_UNIX) {
        return {
          candidates: [...orders.values()],
          scannedSignatures,
          windowSignatures,
          dflowInstructionCount,
          instructionShapes,
          instructionExamples,
          totalOpenInstructions,
          divergentOpenInstructions,
          divergentOpenExamples,
          openEventCount,
          usdcInputOpenEventCount,
          openEventExamples,
          action64InstructionCount,
          action64InstructionShapes,
          action64InstructionExamples,
          reachedWindow,
          oldestSignature,
          oldestBlockTime,
        };
      }

      reachedWindow = true;
      windowSignatures += 1;
      if (item.err) continue;

      const tx = await getTransactionWithRetry(connection, item.signature);
      if (!tx) continue;
      const keys = resolvedKeys(tx);
      const dflowIxs = dflowInstructions(tx, keys);
      const deltas = tokenBalanceDeltas(tx, keys);

      for (const eventIx of dflowIxs.filter((candidate) => candidate.event?.typeName === "open")) {
        openEventCount += 1;
        if (eventIx.event.inputMint === USDC_MINT) {
          usdcInputOpenEventCount += 1;
        }
        if (openEventExamples.length < 100) {
          openEventExamples.push({
            signature: item.signature,
            slot: tx.slot,
            blockTime: tx.blockTime,
            event: eventIx.event,
            signers: signerKeys(tx),
            siblingDflowInstructions: dflowIxs
              .filter((candidate) => candidate !== eventIx)
              .map((candidate) => {
                const candidateData = candidate.dataHex
                  ? Buffer.from(candidate.dataHex, "hex")
                  : null;
                return {
                  dataLength: candidateData?.length ?? null,
                  actionU64:
                    candidateData && candidateData.length >= 8
                      ? readU64LE(candidateData, 0)?.toString()
                      : null,
                  dataHex: candidate.dataHex,
                  accounts: candidate.accounts,
                  accountMetas: candidate.accountMetas,
                };
              }),
            tokenBalanceDeltas: deltas,
          });
        }
      }

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

        if (actionU64 === "64") {
          action64InstructionCount += 1;
          action64InstructionShapes[shapeKey] =
            (action64InstructionShapes[shapeKey] ?? 0) + 1;
          if (action64InstructionExamples.length < 100) {
            action64InstructionExamples.push({
              signature: item.signature,
              slot: tx.slot,
              blockTime: tx.blockTime,
              dataLength: data?.length ?? null,
              actionU64,
              dataHex: ix.dataHex,
              accounts: ix.accounts,
              accountMetas: ix.accountMetas,
              signers: signerKeys(tx),
              tokenBalanceDeltas: deltas,
              siblingEvents: dflowIxs
                .filter((candidate) => candidate.event)
                .map((candidate) => candidate.event),
              instructionTrace: orderedInstructionTrace(tx, keys),
            });
          }
        }

        if (instructionExamples.length < INSTRUCTION_EXAMPLE_LIMIT) {
          instructionExamples.push({
            signature: item.signature,
            slot: tx.slot,
            blockTime: tx.blockTime,
            dataLength: data?.length ?? null,
            actionU64,
            dataHex: ix.dataHex,
            accounts: ix.accounts,
            accountMetas: ix.accountMetas,
            signers: signerKeys(tx),
            tokenBalanceDeltas: deltas,
          });
        }

        const open = classifyOpenInstruction(ix);
        if (!open) continue;

        totalOpenInstructions += 1;
        if (open.recipientIdentitiesDiverge) {
          divergentOpenInstructions += 1;
          if (divergentOpenExamples.length < 50) {
            const snapshots = tokenBalanceSnapshots(tx, keys);
            const sourceAccountSnapshot =
              snapshots.find(
                (entry) =>
                  entry.account === open.sourceUsdc &&
                  entry.mint === USDC_MINT,
              ) ?? null;
            const expectedWalletUsdcAta = canonicalAta(open.user, USDC_MINT);
            divergentOpenExamples.push({
              signature: item.signature,
              slot: tx.slot,
              blockTime: tx.blockTime,
              ...open,
              signers: signerKeys(tx),
              accountMetas: ix.accountMetas,
              expectedWalletUsdcAta,
              sourceIsCanonicalWalletUsdcAta:
                open.sourceUsdc === expectedWalletUsdcAta,
              sourceOwnerMatchesWallet:
                sourceAccountSnapshot?.owner === open.user,
              sourceAccountSnapshot,
              recipientUsdcSnapshots: snapshots.filter(
                (entry) =>
                  entry.mint === USDC_MINT &&
                  [open.user, open.fillRecipient, open.refundRecipient].includes(
                    entry.owner,
                  ),
              ),
              tokenBalanceSnapshots: snapshots,
              tokenBalanceDeltas: deltas,
              instructionTrace: orderedInstructionTrace(tx, keys),
            });
          }
        }

        const sourceDelta = deltas.find(
          (delta) =>
            delta.account === open.sourceUsdc &&
            delta.mint === USDC_MINT &&
            BigInt(delta.delta) < 0n,
        );

        const debitMatches =
          sourceDelta &&
          -BigInt(sourceDelta.delta) === BigInt(open.inputAmount);

        const shouldRetain =
          open.recipientIdentitiesDiverge || orders.size < SAMPLE_LIMIT;
        if (shouldRetain && !orders.has(open.orderAccount)) {
          orders.set(open.orderAccount, {
            ...open,
            openSignature: item.signature,
            openSlot: tx.slot,
            openBlockTime: tx.blockTime,
            openSigners: signerKeys(tx),
            openAccountMetas: ix.accountMetas,
            openInstructionTrace: orderedInstructionTrace(tx, keys),
            inputMint: USDC_MINT,
            sourceDebitObserved: sourceDelta?.delta ?? null,
            sourceDebitMatchesEncodedInput: Boolean(debitMatches),
            openTokenBalanceDeltas: deltas,
          });
        }
      }

      await sleep(125);
    }

    before = signatures.at(-1)?.signature;
    if (!before) break;
  }

  return {
    candidates: [...orders.values()],
    scannedSignatures,
    windowSignatures,
    dflowInstructionCount,
    instructionShapes,
    instructionExamples,
    totalOpenInstructions,
    divergentOpenInstructions,
    divergentOpenExamples,
    openEventCount,
    usdcInputOpenEventCount,
    openEventExamples,
    action64InstructionCount,
    action64InstructionShapes,
    action64InstructionExamples,
    reachedWindow,
    oldestSignature,
    oldestBlockTime,
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
          accountMetas: ix.accountMetas,
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

  const userRefundCandidates = refundCandidates.filter(
    (item) =>
      item.account === seed.sourceUsdc ||
      (item.owner && item.owner === seed.user),
  );

  const lifecycleEvents = txs.flatMap((tx) =>
    tx.dflowInstructions
      .filter((ix) => ix.parsedEvent)
      .map((ix) => ({
        signature: tx.signature,
        slot: tx.slot,
        blockTime: tx.blockTime,
        event: ix.parsedEvent,
      }))
      .filter(
        (item) =>
          !item.event.userOrder ||
          item.event.userOrder === seed.orderAccount,
      ),
  );

  const action10 = txs.flatMap((tx) =>
    tx.dflowInstructions
      .filter((ix) => ix.actionU64 === "16")
      .map((ix) => ({
        signature: tx.signature,
        slot: tx.slot,
        blockTime: tx.blockTime,
        signers: tx.signers,
        accounts: ix.accounts,
        dataHex: ix.dataHex,
        dataLength: ix.dataLength,
        tokenBalanceDeltas: tx.tokenBalanceDeltas,
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
    userRefundCandidates,
    lifecycleEvents,
    action10,
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
  let openRecipientIdentitiesDiverge = 0;
  let openFillRecipientDiffersFromUser = 0;
  let openRefundRecipientDiffersFromUser = 0;
  let ordersWithOutcomeCandidate = 0;
  let ordersWithRefundCandidate = 0;
  let fillRecipientOwnerDiffersFromOpenUser = 0;
  let fullRefundOrders = 0;
  let partialFillOrders = 0;
  let exactQuotedFillOrders = 0;
  let ordersWithAction10 = 0;
  let action10FillMintInOutcomePair = 0;
  let action10FillMintOutsideOutcomePair = 0;
  let action10RevertMintInOutcomePair = 0;
  let action10RevertMintOutsideOutcomePair = 0;
  const lifecycleEventCounts = {};
  let eventsWithRecipientIdentityDivergence = 0;
  const divergentRecipientEvents = [];

  for (const sample of samples) {
    if (sample.account?.dataLength === 344) live344 += 1;
    if (
      sample.source?.owner &&
      sample.seed.user &&
      sample.source.owner !== sample.seed.user
    ) {
      sourceOwnerDiffersFromOpenUser += 1;
    }
    if (sample.seed.recipientIdentitiesDiverge) openRecipientIdentitiesDiverge += 1;
    if (sample.seed.fillRecipient !== sample.seed.user) openFillRecipientDiffersFromUser += 1;
    if (sample.seed.refundRecipient !== sample.seed.user) openRefundRecipientDiffersFromUser += 1;

    const outputs = sample.outputCandidates ?? [];
    const refunds = sample.userRefundCandidates ?? [];
    if ((sample.action10 ?? []).length > 0) {
      ordersWithAction10 += 1;
      const accounts = sample.action10[0]?.accounts ?? [];
      const outcomePair = new Set([accounts[7], accounts[8]].filter(Boolean));
      for (const item of sample.lifecycleEvents ?? []) {
        if (item.event?.typeName === "fill" && item.event.outputMint) {
          if (outcomePair.has(item.event.outputMint)) {
            action10FillMintInOutcomePair += 1;
          } else {
            action10FillMintOutsideOutcomePair += 1;
          }
        }
        if (item.event?.typeName === "revert" && item.event.outputMint) {
          if (outcomePair.has(item.event.outputMint)) {
            action10RevertMintInOutcomePair += 1;
          } else {
            action10RevertMintOutsideOutcomePair += 1;
          }
        }
      }
    }
    for (const item of sample.lifecycleEvents ?? []) {
      const name = item.event?.typeName ?? "unknown";
      lifecycleEventCounts[name] = (lifecycleEventCounts[name] ?? 0) + 1;
      const identities = [
        item.event?.identity0,
        item.event?.identity1,
        item.event?.identity2,
      ].filter(Boolean);
      if (identities.length === 3 && new Set(identities).size > 1) {
        eventsWithRecipientIdentityDivergence += 1;
        if (divergentRecipientEvents.length < 25) {
          divergentRecipientEvents.push({
            signature: item.signature,
            typeName: name,
            userOrder: item.event?.userOrder ?? null,
            identities,
          });
        }
      }
    }
    if (outputs.length > 0) ordersWithOutcomeCandidate += 1;
    if (refunds.length > 0) ordersWithRefundCandidate += 1;

    if (
      outputs.some(
        (item) =>
          item.owner &&
          sample.seed.user &&
          item.owner !== sample.seed.user,
      )
    ) {
      fillRecipientOwnerDiffersFromOpenUser += 1;
    }

    const userRefund = refunds
      .filter(
        (item) =>
          item.owner === sample.seed.user ||
          item.account === sample.seed.sourceUsdc,
      )
      .reduce((sum, item) => sum + BigInt(item.delta), 0n);
    const outputAmount = outputs.reduce(
      (sum, item) => sum + BigInt(item.delta),
      0n,
    );
    const inputAmount = BigInt(sample.seed.inputAmount);
    const quotedOutput = BigInt(sample.seed.quotedOutputAmount);

    if (outputAmount === 0n && userRefund === inputAmount) {
      fullRefundOrders += 1;
    } else if (outputAmount > 0n && userRefund > 0n) {
      partialFillOrders += 1;
    }
    if (outputAmount === quotedOutput && outputAmount > 0n) {
      exactQuotedFillOrders += 1;
    }

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
    openRecipientIdentitiesDiverge,
    openFillRecipientDiffersFromUser,
    openRefundRecipientDiffersFromUser,
    fillRecipientOwnerDiffersFromOpenUser,
    ordersWithOutcomeCandidate,
    ordersWithRefundCandidate,
    fullRefundOrders,
    partialFillOrders,
    exactQuotedFillOrders,
    ordersWithAction10,
    action10FillMintInOutcomePair,
    action10FillMintOutsideOutcomePair,
    action10RevertMintInOutcomePair,
    action10RevertMintOutsideOutcomePair,
    lifecycleEventCounts,
    eventsWithRecipientIdentityDivergence,
    divergentRecipientEvents,
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
      scanAfterUnix: SCAN_AFTER_UNIX,
      scanBeforeUnix: SCAN_BEFORE_UNIX,
      startBeforeSignature: START_BEFORE_SIGNATURE ?? null,
      txLimitPerOrder: TX_LIMIT_PER_ORDER,
      maxRuntimeMs: MAX_RUNTIME_MS,
      instructionExampleLimit: INSTRUCTION_EXAMPLE_LIMIT,
    },
    summary: {
      ...summarize(completeSamples, discovery.scannedSignatures),
      discoveredOpenCandidates: discovery.candidates.length,
      totalOpenInstructions: discovery.totalOpenInstructions,
      divergentOpenInstructions: discovery.divergentOpenInstructions,
      divergentOpenExamples: discovery.divergentOpenExamples,
      openEventCount: discovery.openEventCount,
      usdcInputOpenEventCount: discovery.usdcInputOpenEventCount,
      openEventExamples: discovery.openEventExamples,
      action64InstructionCount: discovery.action64InstructionCount,
      action64InstructionShapes: discovery.action64InstructionShapes,
      action64InstructionExamples: discovery.action64InstructionExamples,
      divergentOpenSourceCanonicalAtaCount:
        discovery.divergentOpenExamples.filter(
          (item) => item.sourceIsCanonicalWalletUsdcAta,
        ).length,
      divergentOpenSourceNonCanonicalAtaCount:
        discovery.divergentOpenExamples.filter(
          (item) => item.sourceIsCanonicalWalletUsdcAta === false,
        ).length,
      divergentOpenSourceOwnerMatchesWalletCount:
        discovery.divergentOpenExamples.filter(
          (item) => item.sourceOwnerMatchesWallet,
        ).length,
      dflowInstructionCount: discovery.dflowInstructionCount,
      windowSignatures: discovery.windowSignatures,
      reachedHistoricalWindow: discovery.reachedWindow,
      oldestSignature: discovery.oldestSignature,
      oldestBlockTime: discovery.oldestBlockTime,
      oldestBlockTimeIso: discovery.oldestBlockTime
        ? new Date(discovery.oldestBlockTime * 1000).toISOString()
        : null,
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
