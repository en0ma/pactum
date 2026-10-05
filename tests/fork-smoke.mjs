import crypto from "node:crypto";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import { requireRpcMetric } from "./metric-guard.mjs";

const RPC_URL = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
const MAINNET_RPC_URL =
  process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PACTUM_PROGRAM_ID ?? "AJnBVG77ZQnMLyeTuf9JoKhvaDFzFQZhtCBnzHgWFBTw",
);
const DFLOW_PM = new PublicKey(
  "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb",
);
const DFLOW_EVENT_AUTHORITY = new PublicKey(
  "ATZQPakBrumxMrSyuEmrt6NcxBbTR1Ucs99dnPFpBUuM",
);
const OPEN_PROBE_MARKET_LEDGER = new PublicKey(
  "5UHoukpeVPQbmSUaAPWnkXEKZMrjSmwTqqaD8eXmvKNn",
);
const OPEN_PROBE_YES_MINT = new PublicKey(
  "CA7FMbzNTfeR7jkLzF113bBJupKwq98cixaQtc3b3frb",
);
const OPEN_PROBE_NO_MINT = new PublicKey(
  "D7ibW7tu2kvzfbDS78gF5i9UZTye7pqTP63yxYd43No3",
);
const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
const SPL_TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const TOKEN_2022_PROGRAM = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
const FILL_RECONCILE_OUTCOME_MINT = OPEN_PROBE_YES_MINT;
const OPEN_ORDER_FIXTURE = Buffer.from(
  "4000000000000000" +
    "bb267d4554fc60a6" +
    "590000000000150a" +
    "80770e0000000000" +
    "c0d8a70000000000" +
    "0000000000000000".repeat(5),
  "hex",
);

const NOOP_CU_BUDGET = Number(process.env.PACTUM_NOOP_CU_BUDGET ?? "12000");
const DFLOW_PROBE_CU_BUDGET = Number(
  process.env.PACTUM_DFLOW_PROBE_CU_BUDGET ?? "80000",
);
const DFLOW_PDA_PROBE_CU_BUDGET = Number(
  process.env.PACTUM_DFLOW_PDA_PROBE_CU_BUDGET ?? "80000",
);
const DFLOW_OPEN_PROBE_CU_BUDGET = Number(
  process.env.PACTUM_DFLOW_OPEN_PROBE_CU_BUDGET ?? "120000",
);
const BASE_FEE_BUDGET_LAMPORTS = Number(
  process.env.PACTUM_BASE_FEE_BUDGET_LAMPORTS ?? "10000",
);

function anchorDiscriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function associatedTokenAddress(owner, mint, tokenProgram = SPL_TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

function u64Le(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function u16Le(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

async function sendInstructions(connection, payer, ...instructions) {
  const tx = new Transaction().add(...instructions);
  return sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
}

async function surfpoolRpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) {
    throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}


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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRpc(url, method, params, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.json();

    const rateLimited =
      response.status === 429 ||
      body?.error?.code === 429 ||
      body?.error?.message?.toLowerCase().includes("too many requests");

    if (!rateLimited) {
      if (body.error) {
        throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
      }
      return body.result;
    }

    if (attempt === maxAttempts) {
      throw new Error(
        `${method} failed after ${maxAttempts} attempts: ${JSON.stringify(body.error)}`,
      );
    }

    await sleep(500 * 2 ** (attempt - 1));
  }

  throw new Error(`${method} failed without a response`);
}

async function cloneAccountValueToSurfpool(pubkey, account) {
  const [base64Data] = account.data;
  await surfpoolRpc("surfnet_setAccount", [
    pubkey.toBase58(),
    {
      lamports: account.lamports,
      owner: account.owner,
      executable: account.executable,
      data: Buffer.from(base64Data, "base64").toString("hex"),
    },
  ]);
}

async function probeDflowRegistryFixture() {
  const keys = [
    OPEN_PROBE_MARKET_LEDGER,
    OPEN_PROBE_YES_MINT,
    OPEN_PROBE_NO_MINT,
  ];
  const accountResult = await jsonRpc(MAINNET_RPC_URL, "getMultipleAccounts", [
    keys.map((key) => key.toBase58()),
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const [ledger, yesMint, noMint] = accountResult?.value ?? [];
  if (!ledger || !yesMint || !noMint) {
    throw new Error("DFlow registry fixture account is missing on mainnet");
  }

  if (ledger.owner !== DFLOW_PM.toBase58()) {
    throw new Error(
      `DFlow market ledger owner mismatch: ${ledger.owner} != ${DFLOW_PM.toBase58()}`,
    );
  }
  for (const [label, mint] of [
    ["yes", yesMint],
    ["no", noMint],
  ]) {
    if (mint.owner !== TOKEN_2022_PROGRAM.toBase58()) {
      throw new Error(`DFlow ${label} mint is not Token-2022: ${mint.owner}`);
    }
  }

  const tokenAccounts = await jsonRpc(
    MAINNET_RPC_URL,
    "getTokenAccountsByOwner",
    [
      OPEN_PROBE_MARKET_LEDGER.toBase58(),
      { mint: USDC_MINT.toBase58() },
      { encoding: "base64", commitment: "confirmed" },
    ],
  );
  const candidates = tokenAccounts?.value ?? [];
  const captured = candidates.find((item) => item.pubkey.startsWith("BFH59"));
  if (!captured) {
    throw new Error(
      `DFlow registry did not resolve the captured BFH59... USDC rail: ${candidates
        .map((item) => item.pubkey)
        .join(", ")}`,
    );
  }
  if (captured.account.owner !== SPL_TOKEN_PROGRAM.toBase58()) {
    throw new Error("DFlow market USDC account is not owned by SPL Token");
  }

  const [tokenDataBase64] = captured.account.data;
  const tokenData = Buffer.from(tokenDataBase64, "base64");
  if (
    !tokenData.subarray(0, 32).equals(USDC_MINT.toBuffer()) ||
    !tokenData.subarray(32, 64).equals(OPEN_PROBE_MARKET_LEDGER.toBuffer())
  ) {
    throw new Error("DFlow market USDC account mint/authority relationship changed");
  }

  const marketUsdc = new PublicKey(captured.pubkey);
  const ledgerData = Buffer.from(ledger.data[0], "base64");

  return {
    marketLedger: OPEN_PROBE_MARKET_LEDGER,
    marketLedgerAccount: ledger,
    marketUsdc,
    marketUsdcAccount: captured.account,
    yesMint: OPEN_PROBE_YES_MINT,
    yesMintAccount: yesMint,
    noMint: OPEN_PROBE_NO_MINT,
    noMintAccount: noMint,
    ledgerDataLength: ledgerData.length,
    ledgerYesMintOffsets: findByteOffsets(
      ledgerData,
      OPEN_PROBE_YES_MINT.toBuffer(),
    ),
    ledgerNoMintOffsets: findByteOffsets(
      ledgerData,
      OPEN_PROBE_NO_MINT.toBuffer(),
    ),
    ledgerUsdcAccountOffsets: findByteOffsets(
      ledgerData,
      marketUsdc.toBuffer(),
    ),
  };
}

function resolvedMessageKeys(tx) {
  const staticKeys = tx.transaction.message.accountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses ?? { writable: [], readonly: [] };
  return [...staticKeys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

function allCompiledInstructions(tx) {
  const top = tx.transaction.message.instructions ?? [];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions ?? []);
  return [...top, ...inner];
}

function terminalDflowEventType(tx, keys) {
  for (const ix of allCompiledInstructions(tx)) {
    if (typeof ix.programIdIndex !== "number" || typeof ix.data !== "string") continue;
    if (keys[ix.programIdIndex] !== DFLOW_PM.toBase58()) continue;
    const data = decodeBase58(ix.data);
    if (
      data.length >= 10 &&
      data[0] === 0xf0 &&
      data.subarray(1, 8).every((byte) => byte === 0) &&
      data[8] === 0x02 &&
      (data[9] === 0x03 || data[9] === 0x04)
    ) {
      return data[9];
    }
  }
  return null;
}

function parseDflowUserOrderEvent(data) {
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
    userOrder: new PublicKey(data.subarray(10, 42)),
    inputMint: new PublicKey(data.subarray(42, 74)),
    inputAmount: data.readBigUInt64LE(74),
    outputMint: new PublicKey(data.subarray(82, 114)),
    outputAmount: data.readBigUInt64LE(114),
    feeMint: new PublicKey(data.subarray(122, 154)),
    feeAmount: data.readBigUInt64LE(154),
  };
}

function findByteOffsets(data, needle) {
  const offsets = [];
  for (let offset = 0; offset <= data.length - needle.length; offset += 1) {
    if (data.subarray(offset, offset + needle.length).equals(needle)) {
      offsets.push(offset);
    }
  }
  return offsets;
}

function dflowOpenEvents(tx, keys) {
  const events = [];
  for (const ix of allCompiledInstructions(tx)) {
    if (typeof ix.programIdIndex !== "number" || typeof ix.data !== "string") continue;
    if (keys[ix.programIdIndex] !== DFLOW_PM.toBase58()) continue;
    const event = parseDflowUserOrderEvent(decodeBase58(ix.data));
    if (event?.type === 0x01) events.push(event);
  }
  return events;
}

async function probeDflowUserOrderLayout() {
  const programAccounts = await jsonRpc(MAINNET_RPC_URL, "getProgramAccounts", [
    DFLOW_PM.toBase58(),
    {
      encoding: "base64",
      commitment: "confirmed",
      filters: [{ dataSize: 344 }],
    },
  ]);

  const samples = [];
  for (const live of (programAccounts ?? []).slice(0, 8)) {
    const orderAddress = new PublicKey(live.pubkey);
    const signatures = await jsonRpc(MAINNET_RPC_URL, "getSignaturesForAddress", [
      orderAddress.toBase58(),
      { limit: 8 },
    ]);

    let matchedEvent = null;
    let signature = null;
    for (const entry of signatures ?? []) {
      if (entry.err) continue;
      const tx = await jsonRpc(MAINNET_RPC_URL, "getTransaction", [
        entry.signature,
        {
          encoding: "json",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (!tx?.meta || tx.meta.err) continue;
      const keys = resolvedMessageKeys(tx);
      matchedEvent = dflowOpenEvents(tx, keys).find(
        (event) => event.userOrder.toBase58() === orderAddress.toBase58(),
      );
      if (matchedEvent) {
        signature = entry.signature;
        break;
      }
      await sleep(200);
    }

    if (!matchedEvent) continue;

    const [base64Data] = live.account.data;
    const accountData = Buffer.from(base64Data, "base64");
    samples.push({
      userOrder: orderAddress.toBase58(),
      signature,
      inputMint: matchedEvent.inputMint.toBase58(),
      outputMint: matchedEvent.outputMint.toBase58(),
      inputAmount: matchedEvent.inputAmount.toString(),
      outputAmount: matchedEvent.outputAmount.toString(),
      inputMintOffsets: findByteOffsets(accountData, matchedEvent.inputMint.toBuffer()),
      outputMintOffsets: findByteOffsets(accountData, matchedEvent.outputMint.toBuffer()),
    });
    if (samples.length >= 3) break;
  }

  const populated = samples.filter((sample) => sample.outputMintOffsets.length > 0);
  let stableOutputMintOffset = null;
  if (populated.length >= 2) {
    const common = populated[0].outputMintOffsets.filter((offset) =>
      populated.slice(1).every((sample) => sample.outputMintOffsets.includes(offset)),
    );
    if (common.length === 1) stableOutputMintOffset = common[0];
  }

  return {
    liveUserOrderCount: programAccounts?.length ?? 0,
    stableOutputMintOffset,
    samples,
  };
}

function dflowReferencedIndexes(tx, keys) {
  const indexes = new Set();
  for (const ix of allCompiledInstructions(tx)) {
    if (typeof ix.programIdIndex !== "number") continue;
    if (keys[ix.programIdIndex] !== DFLOW_PM.toBase58()) continue;
    for (const index of ix.accounts ?? []) indexes.add(index);
  }
  return indexes;
}

async function probeDflowTerminalAccountClosure() {
  const rent344 = await jsonRpc(
    MAINNET_RPC_URL,
    "getMinimumBalanceForRentExemption",
    [344, { commitment: "confirmed" }],
  );

  const evidence = [];
  let before;
  let scanned = 0;
  const maxSignatures = 400;

  while (scanned < maxSignatures && evidence.length < 2) {
    const options = { limit: Math.min(100, maxSignatures - scanned) };
    if (before) options.before = before;

    const signatures = await jsonRpc(
      MAINNET_RPC_URL,
      "getSignaturesForAddress",
      [DFLOW_PM.toBase58(), options],
    );
    if (!signatures?.length) break;

    scanned += signatures.length;
    before = signatures[signatures.length - 1].signature;

    for (const entry of signatures) {
      if (entry.err !== null) continue;

      const tx = await jsonRpc(MAINNET_RPC_URL, "getTransaction", [
        entry.signature,
        { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx?.meta || tx.meta.err) {
        await sleep(100);
        continue;
      }

      const keys = resolvedMessageKeys(tx);
      const terminalType = terminalDflowEventType(tx, keys);
      if (terminalType === null) continue;

      const referenced = dflowReferencedIndexes(tx, keys);
      const closedOrderCandidates = [];
      for (const index of referenced) {
        const pre = tx.meta.preBalances?.[index] ?? 0;
        const post = tx.meta.postBalances?.[index] ?? 0;
        if (pre === rent344 && post === 0) {
          closedOrderCandidates.push(keys[index]);
        }
      }

      evidence.push({
        signature: entry.signature,
        terminalType: terminalType === 0x03 ? "cancel" : "revert",
        closedOrderCandidates,
      });

      if (evidence.length >= 2) break;
      await sleep(100);
    }
  }

  if (evidence.length === 0) {
    throw new Error(
      `No DFlow Cancel/Revert events found after scanning ${scanned} recent program signatures`,
    );
  }
  for (const item of evidence) {
    if (item.closedOrderCandidates.length !== 1) {
      throw new Error(
        `Terminal DFlow tx ${item.signature} had ${item.closedOrderCandidates.length} 344-byte-rent closed DFlow account candidates`,
      );
    }
  }

  return { rent344, scannedSignatures: scanned, evidence };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const [pactumInfo, dflowInfo] = await Promise.all([
    connection.getAccountInfo(PROGRAM_ID),
    connection.getAccountInfo(DFLOW_PM),
  ]);

  if (!pactumInfo?.executable) {
    throw new Error(`Pactum program is not executable at ${PROGRAM_ID.toBase58()}`);
  }
  if (!dflowInfo?.executable) {
    throw new Error(
      `DFlow PM program was not loaded from the mainnet fork: ${DFLOW_PM.toBase58()}`,
    );
  }

  const payer = Keypair.generate();
  const airdrop = await connection.requestAirdrop(payer.publicKey, 2_000_000_000);
  await connection.confirmTransaction(airdrop, "confirmed");

  const { blockhash } = await connection.getLatestBlockhash();

  const noopIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [],
    data: anchorDiscriminator("benchmark_noop"),
  });

  const noopTx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    noopIx,
  );
  noopTx.sign(payer);

  const noopSim = await connection.simulateTransaction(noopTx);
  if (noopSim.value.err) {
    throw new Error(`benchmark_noop simulation failed: ${JSON.stringify(noopSim.value.err)}`);
  }

  const noopCu = requireRpcMetric(noopSim.value.unitsConsumed, "benchmark_noop.unitsConsumed");
  if (noopCu > NOOP_CU_BUDGET) {
    throw new Error(`benchmark_noop CU regression: ${noopCu} > ${NOOP_CU_BUDGET}`);
  }

  const fee = await connection.getFeeForMessage(noopTx.compileMessage());
  const baseFee = requireRpcMetric(fee.value, "getFeeForMessage.value");
  if (baseFee > BASE_FEE_BUDGET_LAMPORTS) {
    throw new Error(
      `base fee regression: ${baseFee} > ${BASE_FEE_BUDGET_LAMPORTS} lamports`,
    );
  }

  const probeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [{ pubkey: DFLOW_PM, isSigner: false, isWritable: false }],
    data: anchorDiscriminator("probe_dflow_prediction_cpi"),
  });

  const probeTx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    probeIx,
  );
  probeTx.sign(payer);

  const probeSim = await connection.simulateTransaction(probeTx);
  const logs = probeSim.value.logs ?? [];
  const invokedDflow = logs.some((line) =>
    line.includes(`Program ${DFLOW_PM.toBase58()} invoke [2]`),
  );

  if (!invokedDflow) {
    console.error(logs.join("\n"));
    throw new Error("Pactum CPI did not reach the DFlow prediction-market program");
  }

  // Invalid data is intentional: success here would mean the smoke-test
  // assumption changed and the fixture must be reviewed.
  if (!probeSim.value.err) {
    throw new Error("DFlow CPI probe unexpectedly succeeded; review the smoke-test ABI");
  }

  const probeCu = requireRpcMetric(probeSim.value.unitsConsumed, "dflow_probe.unitsConsumed");
  if (probeCu > DFLOW_PROBE_CU_BUDGET) {
    throw new Error(
      `DFlow CPI probe CU regression: ${probeCu} > ${DFLOW_PROBE_CU_BUDGET}`,
    );
  }

  const [probeAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("dflow_cpi_probe")],
    PROGRAM_ID,
  );

  const pdaProbeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: probeAuthority, isSigner: false, isWritable: true },
      { pubkey: DFLOW_PM, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("probe_dflow_pda_signed_cpi"),
  });

  const pdaProbeTx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: probeAuthority,
      lamports: 1,
    }),
    pdaProbeIx,
  );
  pdaProbeTx.sign(payer);

  const pdaProbeSim = await connection.simulateTransaction(pdaProbeTx);
  const pdaProbeLogs = pdaProbeSim.value.logs ?? [];
  const pdaReachedDflow = pdaProbeLogs.some((line) =>
    line.includes(`Program ${DFLOW_PM.toBase58()} invoke [2]`),
  );
  const signerEscalationRejected = pdaProbeLogs.some((line) =>
    line.toLowerCase().includes("signer privilege escalated"),
  );

  if (!pdaReachedDflow || signerEscalationRejected) {
    console.error(pdaProbeLogs.join("\n"));
    throw new Error("PDA-signed CPI did not enter DFlow with accepted signer privilege");
  }
  if (!pdaProbeSim.value.err) {
    throw new Error("PDA-signed DFlow probe unexpectedly succeeded; review probe assumptions");
  }

  const pdaProbeCu = requireRpcMetric(
    pdaProbeSim.value.unitsConsumed,
    "dflow_pda_probe.unitsConsumed",
  );
  if (pdaProbeCu > DFLOW_PDA_PROBE_CU_BUDGET) {
    throw new Error(
      `PDA-signed DFlow probe CU regression: ${pdaProbeCu} > ${DFLOW_PDA_PROBE_CU_BUDGET}`,
    );
  }


  const dflowRegistry = await probeDflowRegistryFixture();
  await Promise.all([
    cloneAccountValueToSurfpool(
      dflowRegistry.marketLedger,
      dflowRegistry.marketLedgerAccount,
    ),
    cloneAccountValueToSurfpool(
      dflowRegistry.marketUsdc,
      dflowRegistry.marketUsdcAccount,
    ),
    cloneAccountValueToSurfpool(
      dflowRegistry.yesMint,
      dflowRegistry.yesMintAccount,
    ),
    cloneAccountValueToSurfpool(
      dflowRegistry.noMint,
      dflowRegistry.noMintAccount,
    ),
  ]);
  const openProbeMarketUsdc = dflowRegistry.marketUsdc;

  const [openProbeAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("dflow_open_order_probe")],
    PROGRAM_ID,
  );
  const openProbeSourceUsdc = associatedTokenAddress(
    openProbeAuthority,
    USDC_MINT,
  );
  await surfpoolRpc("surfnet_setTokenAccount", [
    openProbeAuthority.toBase58(),
    USDC_MINT.toBase58(),
    { amount: 2_000_000, state: "initialized" },
  ]);

  const openProbeOrderAccount = Keypair.generate().publicKey;
  const openProbeData = Buffer.concat([
    anchorDiscriminator("probe_dflow_open_order_pda"),
    OPEN_ORDER_FIXTURE,
  ]);
  const openProbeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: openProbeAuthority, isSigner: false, isWritable: false },
      { pubkey: DFLOW_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: OPEN_PROBE_MARKET_LEDGER, isSigner: false, isWritable: true },
      { pubkey: openProbeMarketUsdc, isSigner: false, isWritable: true },
      { pubkey: openProbeOrderAccount, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: openProbeSourceUsdc, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: DFLOW_PM, isSigner: false, isWritable: false },
    ],
    data: openProbeData,
  });

  const { blockhash: openProbeBlockhash } = await connection.getLatestBlockhash();
  const openProbeTx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: openProbeBlockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: openProbeOrderAccount,
      lamports: 1,
    }),
    openProbeIx,
  );
  openProbeTx.sign(payer);

  const openProbeSim = await connection.simulateTransaction(openProbeTx);
  const openProbeLogs = openProbeSim.value.logs ?? [];
  const openProbeReachedDflow = openProbeLogs.some((line) =>
    line.includes(`Program ${DFLOW_PM.toBase58()} invoke [2]`),
  );
  const openProbeSignerEscalation = openProbeLogs.some((line) =>
    line.toLowerCase().includes("signer privilege escalated"),
  );

  if (!openProbeReachedDflow || openProbeSignerEscalation) {
    console.error(openProbeLogs.join("\n"));
    throw new Error(
      "Observed OpenUserOrder PDA probe did not reach DFlow with accepted signer privilege",
    );
  }

  const openProbeCu = requireRpcMetric(
    openProbeSim.value.unitsConsumed,
    "dflow_open_order_probe.unitsConsumed",
  );
  if (openProbeCu > DFLOW_OPEN_PROBE_CU_BUDGET) {
    throw new Error(
      `DFlow OpenUserOrder probe CU regression: ${openProbeCu} > ${DFLOW_OPEN_PROBE_CU_BUDGET}`,
    );
  }


  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority")],
    PROGRAM_ID,
  );
  const [vaultUsdc] = PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_vault")],
    PROGRAM_ID,
  );
  const [approvedMarket] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), OPEN_PROBE_MARKET_LEDGER.toBuffer()],
    PROGRAM_ID,
  );
  const [keeperAuthorization] = PublicKey.findProgramAddressSync(
    [Buffer.from("keeper"), config.toBuffer(), payer.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const [pendingOrder] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_order"), config.toBuffer()],
    PROGRAM_ID,
  );
  const [marketExposure] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("exposure"),
      config.toBuffer(),
      OPEN_PROBE_MARKET_LEDGER.toBuffer(),
      FILL_RECONCILE_OUTCOME_MINT.toBuffer(),
    ],
    PROGRAM_ID,
  );

  const initializeVaultIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultUsdc, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator("initialize_vault"),
      u64Le(5_000_000),
      u64Le(20_000_000),
      u64Le(0),
    ]),
  });
  await sendInstructions(connection, payer, initializeVaultIx);

  const registerMarketIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: OPEN_PROBE_MARKET_LEDGER, isSigner: false, isWritable: false },
      { pubkey: approvedMarket, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator("register_market"),
      openProbeMarketUsdc.toBuffer(),
      dflowRegistry.yesMint.toBuffer(),
      dflowRegistry.noMint.toBuffer(),
    ]),
  });
  await sendInstructions(connection, payer, registerMarketIx);

  const authorizeKeeperIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      { pubkey: keeperAuthorization, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("authorize_keeper"),
  });
  await sendInstructions(connection, payer, authorizeKeeperIx);

  const syntheticOrderAccount = Keypair.generate().publicKey;
  await surfpoolRpc("surfnet_setAccount", [
    syntheticOrderAccount.toBase58(),
    {
      lamports: 1_000_000,
      owner: DFLOW_PM.toBase58(),
      executable: false,
      data: "00".repeat(344),
    },
  ]);

  const reconcileCostBasis = 948_096n;
  const reconcileQuotedOutcome = 11_000_000n;
  const reconcileSlippageBps = 50;

  const seedPendingIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: approvedMarket, isSigner: false, isWritable: false },
      { pubkey: syntheticOrderAccount, isSigner: false, isWritable: false },
      { pubkey: FILL_RECONCILE_OUTCOME_MINT, isSigner: false, isWritable: false },
      { pubkey: pendingOrder, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator("seed_pending_dflow_order"),
      u64Le(reconcileCostBasis),
      u64Le(reconcileQuotedOutcome),
      u64Le(0),
      u16Le(reconcileSlippageBps),
    ]),
  });
  await sendInstructions(connection, payer, seedPendingIx);

  const outcomeAta = associatedTokenAddress(
    vaultAuthority,
    FILL_RECONCILE_OUTCOME_MINT,
    TOKEN_2022_PROGRAM,
  );
  await surfpoolRpc("surfnet_setTokenAccount", [
    vaultAuthority.toBase58(),
    FILL_RECONCILE_OUTCOME_MINT.toBase58(),
    { amount: Number(reconcileQuotedOutcome), state: "initialized" },
    TOKEN_2022_PROGRAM.toBase58(),
  ]);

  const refundUsdcAta = associatedTokenAddress(
    vaultAuthority,
    USDC_MINT,
    SPL_TOKEN_PROGRAM,
  );
  await surfpoolRpc("surfnet_setTokenAccount", [
    vaultAuthority.toBase58(),
    USDC_MINT.toBase58(),
    { amount: 0, state: "initialized" },
  ]);

  await surfpoolRpc("surfnet_setAccount", [
    syntheticOrderAccount.toBase58(),
    {
      lamports: 0,
      owner: SystemProgram.programId.toBase58(),
      executable: false,
      data: "",
    },
  ]);

  const finalizeFilledIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: keeperAuthorization, isSigner: false, isWritable: false },
      { pubkey: approvedMarket, isSigner: false, isWritable: false },
      { pubkey: syntheticOrderAccount, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultUsdc, isSigner: false, isWritable: true },
      { pubkey: refundUsdcAta, isSigner: false, isWritable: true },
      { pubkey: FILL_RECONCILE_OUTCOME_MINT, isSigner: false, isWritable: false },
      { pubkey: outcomeAta, isSigner: false, isWritable: false },
      { pubkey: pendingOrder, isSigner: false, isWritable: true },
      { pubkey: marketExposure, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("finalize_dflow_filled_order"),
  });
  await sendInstructions(connection, payer, finalizeFilledIx);

  const [pendingAfterFinalize, exposureAfterFinalize] = await Promise.all([
    connection.getAccountInfo(pendingOrder),
    connection.getAccountInfo(marketExposure),
  ]);
  if (pendingAfterFinalize !== null) {
    throw new Error("terminal filled order did not close PendingDflowOrder");
  }
  if (!exposureAfterFinalize) {
    throw new Error("terminal filled order did not materialize MarketExposure");
  }
  const finalizedCostBasis = exposureAfterFinalize.data.readBigUInt64LE(72);
  const finalizedOutcomeAtoms = exposureAfterFinalize.data.readBigUInt64LE(80);
  if (finalizedCostBasis !== reconcileCostBasis) {
    throw new Error(
      `unexpected finalized cost basis: ${finalizedCostBasis} != ${reconcileCostBasis}`,
    );
  }
  if (finalizedOutcomeAtoms !== reconcileQuotedOutcome) {
    throw new Error(
      `unexpected finalized outcome atoms: ${finalizedOutcomeAtoms} != ${reconcileQuotedOutcome}`,
    );
  }

  const unwindOrderAccount = Keypair.generate().publicKey;
  await surfpoolRpc("surfnet_setAccount", [
    unwindOrderAccount.toBase58(),
    {
      lamports: 1_000_000,
      owner: DFLOW_PM.toBase58(),
      executable: false,
      data: "00".repeat(344),
    },
  ]);

  const seedUnwindIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: approvedMarket, isSigner: false, isWritable: false },
      { pubkey: unwindOrderAccount, isSigner: false, isWritable: false },
      { pubkey: FILL_RECONCILE_OUTCOME_MINT, isSigner: false, isWritable: false },
      { pubkey: pendingOrder, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator("seed_pending_dflow_order"),
      u64Le(reconcileCostBasis),
      u64Le(reconcileQuotedOutcome),
      u64Le(reconcileQuotedOutcome),
      u16Le(reconcileSlippageBps),
    ]),
  });
  await sendInstructions(connection, payer, seedUnwindIx);

  await surfpoolRpc("surfnet_setTokenAccount", [
    vaultAuthority.toBase58(),
    USDC_MINT.toBase58(),
    { amount: Number(reconcileCostBasis + 123n), state: "initialized" },
  ]);
  await surfpoolRpc("surfnet_setTokenAccount", [
    vaultAuthority.toBase58(),
    FILL_RECONCILE_OUTCOME_MINT.toBase58(),
    { amount: Number(reconcileQuotedOutcome + 1n), state: "initialized" },
    TOKEN_2022_PROGRAM.toBase58(),
  ]);
  await surfpoolRpc("surfnet_setAccount", [
    unwindOrderAccount.toBase58(),
    {
      lamports: 0,
      owner: SystemProgram.programId.toBase58(),
      executable: false,
      data: "",
    },
  ]);

  const unwindIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: keeperAuthorization, isSigner: false, isWritable: false },
      { pubkey: approvedMarket, isSigner: false, isWritable: false },
      { pubkey: unwindOrderAccount, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultUsdc, isSigner: false, isWritable: true },
      { pubkey: refundUsdcAta, isSigner: false, isWritable: true },
      { pubkey: FILL_RECONCILE_OUTCOME_MINT, isSigner: false, isWritable: false },
      { pubkey: outcomeAta, isSigner: false, isWritable: false },
      { pubkey: pendingOrder, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("unwind_dflow_order"),
  });
  const donatedOutcomeUnwindSim = await connection.simulateTransaction(
    new Transaction().add(unwindIx),
    [payer],
  );
  if (!donatedOutcomeUnwindSim.value.err) {
    throw new Error(
      "full-refund unwind accepted a terminal order with new outcome assets",
    );
  }

  const finalizeRefundedOutcomeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: keeperAuthorization, isSigner: false, isWritable: false },
      { pubkey: approvedMarket, isSigner: false, isWritable: false },
      { pubkey: unwindOrderAccount, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultUsdc, isSigner: false, isWritable: true },
      { pubkey: refundUsdcAta, isSigner: false, isWritable: true },
      { pubkey: FILL_RECONCILE_OUTCOME_MINT, isSigner: false, isWritable: false },
      { pubkey: outcomeAta, isSigner: false, isWritable: false },
      { pubkey: pendingOrder, isSigner: false, isWritable: true },
      { pubkey: marketExposure, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("finalize_dflow_filled_order"),
  });
  await sendInstructions(connection, payer, finalizeRefundedOutcomeIx);

  const [pendingAfterRefundedOutcome, configAfterRefundedOutcome, vaultAfterRefundedOutcome, exposureAfterRefundedOutcome] =
    await Promise.all([
      connection.getAccountInfo(pendingOrder),
      connection.getAccountInfo(config),
      connection.getTokenAccountBalance(vaultUsdc),
      connection.getAccountInfo(marketExposure),
    ]);
  if (pendingAfterRefundedOutcome !== null) {
    throw new Error("terminal refunded outcome order did not close PendingDflowOrder");
  }
  if (!exposureAfterRefundedOutcome) {
    throw new Error("terminal refunded outcome order lost tracked outcome assets");
  }

  const costAfterRefundedOutcome =
    exposureAfterRefundedOutcome.data.readBigUInt64LE(72);
  const atomsAfterRefundedOutcome =
    exposureAfterRefundedOutcome.data.readBigUInt64LE(80);
  if (costAfterRefundedOutcome !== reconcileCostBasis) {
    throw new Error(
      `full refund changed tracked cost basis: ${costAfterRefundedOutcome} != ${reconcileCostBasis}`,
    );
  }
  if (atomsAfterRefundedOutcome !== reconcileQuotedOutcome + 1n) {
    throw new Error(
      `refunded order outcome asset was not tracked: ${atomsAfterRefundedOutcome} != ${reconcileQuotedOutcome + 1n}`,
    );
  }

  const openExposureAfterRefundedOutcome =
    configAfterRefundedOutcome.data.readBigUInt64LE(99);
  if (openExposureAfterRefundedOutcome !== reconcileCostBasis) {
    throw new Error(
      `unexpected exposure after refunded outcome finalization: ${openExposureAfterRefundedOutcome} != ${reconcileCostBasis}`,
    );
  }
  if (BigInt(vaultAfterRefundedOutcome.value.amount) < reconcileCostBasis) {
    throw new Error("terminal refund was not swept back into vault_usdc");
  }

  const dflowUserOrderLayout = await probeDflowUserOrderLayout();
  console.log(
    "DFlow user-order layout probe:",
    JSON.stringify(dflowUserOrderLayout, null, 2),
  );
  const dflowTerminalClosure = await probeDflowTerminalAccountClosure();

  console.log(JSON.stringify({
    rpc: RPC_URL,
    pactumProgram: PROGRAM_ID.toBase58(),
    dflowPredictionProgram: DFLOW_PM.toBase58(),
    noop: {
      computeUnits: noopCu,
      feeLamports: baseFee,
      cuBudget: NOOP_CU_BUDGET,
      feeBudgetLamports: BASE_FEE_BUDGET_LAMPORTS,
    },
    dflowCpiProbe: {
      reachedDflow: true,
      expectedInnerFailure: true,
      computeUnits: probeCu,
      cuBudget: DFLOW_PROBE_CU_BUDGET,
    },
    dflowPdaSignedProbe: {
      authority: probeAuthority.toBase58(),
      reachedDflow: pdaReachedDflow,
      signerPrivilegeAccepted: !signerEscalationRejected,
      expectedInnerFailure: true,
      computeUnits: pdaProbeCu,
      cuBudget: DFLOW_PDA_PROBE_CU_BUDGET,
    },
    dflowRegistry: {
      marketLedger: dflowRegistry.marketLedger.toBase58(),
      marketUsdcAccount: dflowRegistry.marketUsdc.toBase58(),
      yesMint: dflowRegistry.yesMint.toBase58(),
      noMint: dflowRegistry.noMint.toBase58(),
      ledgerDataLength: dflowRegistry.ledgerDataLength,
      ledgerYesMintOffsets: dflowRegistry.ledgerYesMintOffsets,
      ledgerNoMintOffsets: dflowRegistry.ledgerNoMintOffsets,
      ledgerUsdcAccountOffsets: dflowRegistry.ledgerUsdcAccountOffsets,
    },
    dflowOpenUserOrderProbe: {
      authority: openProbeAuthority.toBase58(),
      sourceUsdc: openProbeSourceUsdc.toBase58(),
      marketLedger: OPEN_PROBE_MARKET_LEDGER.toBase58(),
      marketUsdcAccount: openProbeMarketUsdc.toBase58(),
      reachedDflow: openProbeReachedDflow,
      signerPrivilegeAccepted: !openProbeSignerEscalation,
      expectedInnerFailure: Boolean(openProbeSim.value.err),
      computeUnits: openProbeCu,
      cuBudget: DFLOW_OPEN_PROBE_CU_BUDGET,
    },
    dflowUserOrderLayout,
    dflowTerminalClosure,
    dflowTerminalLifecycle: {
      outcomeAta: outcomeAta.toBase58(),
      terminalFilledFinalized: pendingAfterFinalize === null,
      finalizedCostBasis: finalizedCostBasis.toString(),
      finalizedOutcomeAtoms: finalizedOutcomeAtoms.toString(),
      donatedOutcomeUnwindRejected: Boolean(donatedOutcomeUnwindSim.value.err),
      refundedOutcomeTracked: pendingAfterRefundedOutcome === null,
      costAfterRefundedOutcome: costAfterRefundedOutcome.toString(),
      atomsAfterRefundedOutcome: atomsAfterRefundedOutcome.toString(),
      openExposureAfterRefundedOutcome: openExposureAfterRefundedOutcome.toString(),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
