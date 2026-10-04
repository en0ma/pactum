import crypto from "node:crypto";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { requireRpcMetric } from "./metric-guard.mjs";

const RPC_URL = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(
  process.env.PACTUM_PROGRAM_ID ?? "AJnBVG77ZQnMLyeTuf9JoKhvaDFzFQZhtCBnzHgWFBTw",
);
const DFLOW_PM = new PublicKey(
  "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb",
);

const NOOP_CU_BUDGET = Number(process.env.PACTUM_NOOP_CU_BUDGET ?? "12000");
const DFLOW_PROBE_CU_BUDGET = Number(
  process.env.PACTUM_DFLOW_PROBE_CU_BUDGET ?? "80000",
);
const DFLOW_PDA_PROBE_CU_BUDGET = Number(
  process.env.PACTUM_DFLOW_PDA_PROBE_CU_BUDGET ?? "80000",
);
const BASE_FEE_BUDGET_LAMPORTS = Number(
  process.env.PACTUM_BASE_FEE_BUDGET_LAMPORTS ?? "10000",
);

function anchorDiscriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
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
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
