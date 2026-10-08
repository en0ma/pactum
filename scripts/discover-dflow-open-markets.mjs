import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";

// Read only DFlow-owned on-chain market state. A zero status byte is a
// candidate, not proof that a fresh OpenUserOrder can execute.
const RPC_URL = process.env.MAINNET_RPC_URL;
if (!RPC_URL || new URL(RPC_URL).hostname === "api.mainnet-beta.solana.com") {
  throw new Error("A private MAINNET_RPC_URL is required");
}
const PROGRAM = "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OUTPUT = process.env.DFLOW_OPEN_CANDIDATES_OUTPUT ?? "artifacts/dflow-open-market-candidates.json";
const EVIDENCE = process.env.DFLOW_RECENT_EVIDENCE_FILE ?? "artifacts/dflow-mainnet-recent.json";
const MAX_CANDIDATES = Math.min(25, Math.max(1, Number(process.env.DFLOW_MAX_OPEN_CANDIDATES ?? 12)));
let rpcId = 0;

async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      if ((response.status === 429 || body.error?.code === 429) && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
        continue;
      }
      throw new Error(`${method}: ${JSON.stringify(body.error ?? response.status)}`);
    }
    return body.result;
  }
}

function pubkeyAt(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

const now = Math.floor(Date.now() / 1000);
const evidence = JSON.parse(fs.readFileSync(EVIDENCE, "utf8"));
const confirmedOpens = (evidence.summary?.action64InstructionExamples ?? [])
  .filter((ix) => ix.actionU64 === "64" && ix.dataLength === 80 &&
    Array.isArray(ix.accounts) && ix.accounts.length >= 11);
const otherObserved = (evidence.instructionExamples ?? [])
  .filter((ix) => ix.actionU64 === "72" && ix.dataLength === 80 &&
    Array.isArray(ix.accounts) && ix.accounts.length >= 11);
const ledgers = [...new Set(
  [...confirmedOpens, ...otherObserved].map((ix) => ix.accounts[1]).filter(Boolean),
)].slice(0, 100);

// Previously observed DFlow-owned 568-byte ledgers from focused CI #207/#210.
// Revalidate these on every run; historical screening is not tradability proof.
const HISTORICAL_LEDGER_FALLBACK = [
  "CPy9eaGECdD7W8ZhWdaJ3vhfp2711QLtStRKYGnPAjrx",
  "6xdVnEEjUh4fTAN1hGtsDbcim8CdvwCWvw3xGmNZrPF5",
  "CT91GupQzfM35qyVdb5Rk4NG4AYNoS43ET9cqzdJbtaU",
  "hQ5abQ1karPbvbPhKLEp3U3Jf1jdNTtp7QEdVvtML5u",
  "EdWBKGV8hKcpyR4Nu1bx3nkG4ScepKa8UWz1HS4bNxhx",
  "EocEe9dzW8hSjvcTA9NbQyfamTAQPL7eWeTUBECkm7P3",
  "6pQTyrpa1i3EaBq1p2LPJr6q6QjqugX7DxqWkzWyVnK5",
  "D6ugpVCWWU78VdRoa6MXkuPEB24b7ceW3sgMCrfTrHYX",
];
const recentlyObservedLedgers = new Set(ledgers);
for (const ledger of HISTORICAL_LEDGER_FALLBACK) {
  if (!recentlyObservedLedgers.has(ledger)) ledgers.push(ledger);
}

const candidates = [];
let accountsChecked = 0;
const openActionExamples = (evidence.summary?.action64InstructionExamples ?? [])
  .filter((example) => Array.isArray(example.accounts) && example.accounts.length >= 11);
const openExamplesByLedger = new Map();
for (const example of openActionExamples) {
  const ledger = example.accounts[1];
  if (!ledger) continue;
  openExamplesByLedger.set(ledger, (openExamplesByLedger.get(ledger) ?? 0) + 1);
}
for (let start = 0; start < ledgers.length; start += 20) {
  const batch = ledgers.slice(start, start + 20);
  const response = await rpc("getMultipleAccounts", [
    batch,
    { commitment: "confirmed", encoding: "base64" },
  ]);
  const matching = response.value ?? [];
  for (let i = 0; i < batch.length; i++) {
    const account = matching[i];
    if (!account || account.owner !== PROGRAM) continue;
    const data = Buffer.from(account.data[0], "base64");
    if (data.length !== 568) continue;
    accountsChecked++;
    if (data[564] !== 0) continue;
    const marketUsdc = pubkeyAt(data, 272);
    const yesMint = pubkeyAt(data, 377);
    const noMint = pubkeyAt(data, 449);
    const [rail] = (await rpc("getMultipleAccounts", [
      [marketUsdc],
      { commitment: "confirmed", encoding: "base64" },
    ])).value ?? [];
    if (!rail || rail.owner !== TOKEN_PROGRAM) continue;
    const railData = Buffer.from(rail.data[0], "base64");
    if (
      railData.length < 64 ||
      pubkeyAt(railData, 0) !== USDC ||
      pubkeyAt(railData, 32) !== batch[i]
    ) continue;
    candidates.push({
      marketLedger: batch[i],
      evidenceSource: recentlyObservedLedgers.has(batch[i]) ? "current-window" : "historical-ledger-refresh",
      marketUsdc,
      yesMint,
      noMint,
      statusByte564: data[564],
      relationshipVerified: true,
      executableOpenVerified: false,
      matchingUsdcInputOpenExamples: openExamplesByLedger.get(batch[i]) ?? 0,
      requiresFreshAction64Payload: true,
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  if (candidates.length >= MAX_CANDIDATES) break;
}

const report = {
  source: "solana-mainnet-rpc-only",
  observedAtUnix: now,
  sourceEvidence: EVIDENCE,
  scannedWindowStart: evidence.source?.scanAfterUnix ?? null,
  scannedWindowEnd: evidence.source?.scanBeforeUnix ?? null,
  observedWindowUsdcInputOpens: confirmedOpens.length,
  scanCoverageComplete: evidence.summary?.scanCoverageComplete ?? false,
  scannedProgramSignatures: evidence.summary?.scannedProgramSignatures ?? null,
  windowSignatures: evidence.summary?.windowSignatures ?? null,
  observedInstructionShapes: evidence.summary?.instructionShapes ?? {},
  observedDflowCallRoutes: evidence.summary?.transactionRoutes ?? {},
  observedDflowActions: evidence.summary?.dflowActionCounts ?? {},
  successfulWindowTransactions: evidence.summary?.successfulWindowTransactions ?? null,
  observedLedgers: recentlyObservedLedgers.size,
  historicalLedgerFallbackCount: HISTORICAL_LEDGER_FALLBACK.length,
  ledgersRefreshed: ledgers.length,
  validLedgerAccountsChecked: accountsChecked,
  candidateUsdcInputOpenExamples: candidates.reduce(
    (sum, candidate) => sum + candidate.matchingUsdcInputOpenExamples, 0
  ),
  candidates,
  warning: "Zero status byte and verified USDC rail are screening signals, not proof of a tradable market. Historical action 0x48 is not an action 0x40 USDC-input quote. Fresh 0x40 data and a successful direct DFlow simulation are required before Pactum execution.",
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
