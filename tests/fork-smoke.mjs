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
  "GGViDLxL6RRQ4zTydGoiL6NnLugxyDGraydUBAQfo9iX",
);
const OPEN_PROBE_MARKET_USDC = new PublicKey(
  "BciG3VNEgDihNBcsZYxcJugBw59wQ7xRZAjen6ENaW6h",
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
const FILL_RECONCILE_OUTCOME_MINT = new PublicKey(
  "4qeSi2JVCbE9VQt1uzTJTpJSKdMFRsqWuvf3UL9fGa2P",
);
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

async function jsonRpc(url, method, params) {
  const response = await fetch(url, {
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

async function jsonRpcBatch(url, calls) {
  const payload = calls.map((call, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: call.method,
    params: call.params,
  }));

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (Array.isArray(body)) {
      const byId = new Map(body.map((item) => [item.id, item]));
      return payload.map((item) => {
        const result = byId.get(item.id);
        if (!result) throw new Error(`missing batch RPC result for id ${item.id}`);
        if (result.error) {
          throw new Error(`batch RPC error: ${JSON.stringify(result.error)}`);
        }
        return result.result;
      });
    }
  } catch {
    // Public Solana RPC providers differ on batch support; fall through to
    // individual calls so the terminal-state proof tests DFlow, not batching.
  }

  const results = [];
  for (const call of calls) {
    results.push(await jsonRpc(url, call.method, call.params));
  }
  return results;
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
  const signatures = await jsonRpc(MAINNET_RPC_URL, "getSignaturesForAddress", [
    DFLOW_PM.toBase58(),
    { limit: 60 },
  ]);
  const candidates = signatures
    .filter((entry) => entry.err === null)
    .slice(0, 40);

  const transactions = await jsonRpcBatch(
    MAINNET_RPC_URL,
    candidates.map((entry) => ({
      method: "getTransaction",
      params: [
        entry.signature,
        { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ],
    })),
  );

  const rent344 = await jsonRpc(
    MAINNET_RPC_URL,
    "getMinimumBalanceForRentExemption",
    [344, { commitment: "confirmed" }],
  );

  const evidence = [];
  for (let i = 0; i < transactions.length; i += 1) {
    const tx = transactions[i];
    if (!tx?.meta || tx.meta.err) continue;
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
      signature: candidates[i].signature,
      terminalType: terminalType === 0x03 ? "cancel" : "revert",
      closedOrderCandidates,
    });

    if (evidence.length >= 2) break;
  }

  if (evidence.length === 0) {
    throw new Error(
      "No recent DFlow Cancel/Revert events found; cannot establish terminal account-closure proof",
    );
  }
  for (const item of evidence) {
    if (item.closedOrderCandidates.length !== 1) {
      throw new Error(
        `Terminal DFlow tx ${item.signature} had ${item.closedOrderCandidates.length} 344-byte-rent closed DFlow account candidates`,
      );
    }
  }

  return { rent344, evidence };
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
      { pubkey: OPEN_PROBE_MARKET_USDC, isSigner: false, isWritable: true },
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
      OPEN_PROBE_MARKET_USDC.toBuffer(),
      FILL_RECONCILE_OUTCOME_MINT.toBuffer(),
      Keypair.generate().publicKey.toBuffer(),
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
  await sendInstructions(connection, payer, unwindIx);

  const [pendingAfterUnwind, configAfterUnwind, vaultAfterUnwind] = await Promise.all([
    connection.getAccountInfo(pendingOrder),
    connection.getAccountInfo(config),
    connection.getTokenAccountBalance(vaultUsdc),
  ]);
  if (pendingAfterUnwind !== null) {
    throw new Error("zero-fill terminal unwind did not close PendingDflowOrder");
  }
  const openExposureAfterUnwind = configAfterUnwind.data.readBigUInt64LE(99);
  if (openExposureAfterUnwind !== reconcileCostBasis) {
    throw new Error(
      `unexpected exposure after unwind: ${openExposureAfterUnwind} != ${reconcileCostBasis}`,
    );
  }
  if (BigInt(vaultAfterUnwind.value.amount) < reconcileCostBasis) {
    throw new Error("terminal refund was not swept back into vault_usdc");
  }

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
    dflowOpenUserOrderProbe: {
      authority: openProbeAuthority.toBase58(),
      sourceUsdc: openProbeSourceUsdc.toBase58(),
      marketLedger: OPEN_PROBE_MARKET_LEDGER.toBase58(),
      marketUsdcAccount: OPEN_PROBE_MARKET_USDC.toBase58(),
      reachedDflow: openProbeReachedDflow,
      signerPrivilegeAccepted: !openProbeSignerEscalation,
      expectedInnerFailure: Boolean(openProbeSim.value.err),
      computeUnits: openProbeCu,
      cuBudget: DFLOW_OPEN_PROBE_CU_BUDGET,
    },
    dflowTerminalClosure,
    dflowTerminalLifecycle: {
      outcomeAta: outcomeAta.toBase58(),
      terminalFilledFinalized: pendingAfterFinalize === null,
      finalizedCostBasis: finalizedCostBasis.toString(),
      finalizedOutcomeAtoms: finalizedOutcomeAtoms.toString(),
      donationTolerantFullRefundUnwind: pendingAfterUnwind === null,
      openExposureAfterUnwind: openExposureAfterUnwind.toString(),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
