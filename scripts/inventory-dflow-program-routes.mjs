import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const rpc = process.env.MAINNET_RPC_URL;
if (!rpc || new URL(rpc).hostname === "api.mainnet-beta.solana.com") throw new Error("Private MAINNET_RPC_URL required");
const conn = new Connection(rpc, "confirmed");
const since = Math.floor(Date.now() / 1000) - 200 * 3600;
const programs = [
  ["legacy-kalshi", "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb"],
  ["dflow-aggregator-v4", "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH"],
  ["world-market", "prediCtPZCttYMvm2W3PtxmMxLmT1dtN7riU6Cxh6tM"],
  ["world-janus-maker", "JanusXpm3gsW3c9ErNoUgHppL8dGLvZKB7uekkJEYFP"],
  ["world-bison-maker", "2DNbzPochEcyCcWMbL4d9S3u9QqQEj5bbe6cSZFvKsbh"],
];
const report = { generatedAt: new Date().toISOString(), sinceUnix: since, windowHours: 200, programs: [] };
async function withRetry(fn) {
  for (let i = 0; i < 4; i++) {
    try { return await fn(); }
    catch (error) {
      if (i === 3) throw error;
      await new Promise(r => setTimeout(r, (i + 1) * 1200));
    }
  }
}
for (const [role, id] of programs) {
  const row = { role, programId: id, inWindowSignatures: 0, successfulSignatures: 0, failedSignatures: 0, pages: 0, complete: false, sampledRoutes: {}, sampleFetchFailures: 0, newestBlockTime: null, oldestBlockTime: null, errors: [] };
  let before;
  const samples = [];
  try {
    for (let page = 0; page < 5; page++) {
      const batch = await withRetry(() => conn.getSignaturesForAddress(new PublicKey(id), { limit: 1000, ...(before ? { before } : {}) }, "confirmed"));
      row.pages++;
      if (!batch.length) { row.complete = true; break; }
      for (const item of batch) {
        if (item.blockTime == null) continue;
        if (item.blockTime < since) { row.complete = true; break; }
        row.inWindowSignatures++;
        row[item.err ? "failedSignatures" : "successfulSignatures"]++;
        row.newestBlockTime = Math.max(row.newestBlockTime ?? item.blockTime, item.blockTime);
        row.oldestBlockTime = Math.min(row.oldestBlockTime ?? item.blockTime, item.blockTime);
        if (!item.err && samples.length < 8) samples.push(item.signature);
      }
      if (row.complete || batch.length < 1000) { row.complete = true; break; }
      before = batch.at(-1).signature;
    }
    for (const signature of samples) {
      try {
        const tx = await withRetry(() => conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }));
        if (!tx) { row.sampleFetchFailures++; continue; }
        const outer = tx.transaction.message.instructions;
        for (const ix of outer) {
          const programId = ix.programId.toBase58();
          row.sampledRoutes["outer:" + programId] = (row.sampledRoutes["outer:" + programId] ?? 0) + 1;
        }
        for (const group of tx.meta?.innerInstructions ?? []) {
          for (const ix of group.instructions ?? []) {
            const key = "inner:" + ix.programId.toBase58();
            row.sampledRoutes[key] = (row.sampledRoutes[key] ?? 0) + 1;
          }
        }
      } catch (error) { row.sampleFetchFailures++; row.errors.push(String(error).slice(0, 160)); }
    }
  } catch (error) { row.errors.push(String(error).slice(0, 160)); }
  report.programs.push(row);
  console.log(JSON.stringify({ role, inWindowSignatures: row.inWindowSignatures, successfulSignatures: row.successfulSignatures, complete: row.complete, sampleFetchFailures: row.sampleFetchFailures, errors: row.errors }));
}
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/dflow-program-route-inventory.json", JSON.stringify(report, null, 2) + "\n");
