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
const ledgers = [...new Set(
  (evidence.instructionExamples ?? [])
    .filter((ix) => (ix.actionU64 === "72" || ix.actionU64 === "64") &&
      ix.dataLength === 80 && Array.isArray(ix.accounts) && ix.accounts.length >= 11)
    .map((ix) => ix.accounts[1])
    .filter(Boolean),
)].slice(0, 100);

const candidates = [];
let accountsChecked = 0;
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
      marketUsdc,
      yesMint,
      noMint,
      statusByte564: data[564],
      relationshipVerified: true,
      executableOpenVerified: false,
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  if (candidates.length >= MAX_CANDIDATES) break;
}

const report = {
  source: "solana-mainnet-rpc-only",
  observedAtUnix: now,
  sourceEvidence: EVIDENCE,
  observedLedgers: ledgers.length,
  validLedgerAccountsChecked: accountsChecked,
  candidates,
  warning: "Zero status byte and verified USDC rail are only screening signals. A successful DFlow OpenUserOrder on an actually active market is still required.",
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
