import fs from "node:fs";
import { Keypair, VersionedTransaction, Transaction } from "@solana/web3.js";

const API = "https://api.jup.ag/prediction/v1";
const MARKET_ID = "KXCRYPTORETURNY-26-BTC";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OUTPUT = "artifacts/jupiter-kalshi-order-inspection.json";
const report = { marketId: MARKET_ID, provider: "kalshi", collectedAt: new Date().toISOString(),
  unsignedOnly: true, submitted: false, orderBuilt: false };
const key = process.env.JUPITER_API_KEY;
if (!key) throw new Error("JUPITER_API_KEY required");
const headers = { "x-api-key": key, "content-type": "application/json" };
async function api(path, options = {}) {
  const response = await fetch(API + path, { headers, signal: AbortSignal.timeout(20000), ...options });
  const bodyText = await response.text();
  let body;
  try { body = JSON.parse(bodyText); } catch { body = { message: "non-JSON response" }; }
  return { status: response.status, ok: response.ok, body };
}
try {
  const m = await api("/markets/" + encodeURIComponent(MARKET_ID));
  report.marketLookup = { httpStatus: m.status, ok: m.ok, status: m.body?.status ?? m.body?.data?.status ?? null,
    provider: m.body?.provider ?? m.body?.data?.provider ?? null,
    error: m.ok ? null : String(m.body?.message ?? m.body?.error ?? "lookup failed").slice(0, 250) };
  // Never create a signed/on-chain order; POST /orders only constructs unsigned tx.
  // Use a fresh public key without storing or signing with its secret key.
  if (m.ok && report.marketLookup.status === "open" &&
      (report.marketLookup.provider === "kalshi" || report.marketLookup.provider === null)) {
    const owner = Keypair.generate().publicKey.toBase58();
    report.ownerMode = "unfunded-ephemeral-pubkey-no-secret-persisted";
    const request = { ownerPubkey: owner, marketId: MARKET_ID, isYes: true, isBuy: true,
      depositMint: USDC, depositAmount: "5000000" };
    const o = await api("/orders", { method: "POST", body: JSON.stringify(request) });
    report.orderRequest = { httpStatus: o.status, ok: o.ok, error: o.ok ? null :
      String(o.body?.message ?? o.body?.error ?? "order construction rejected").slice(0, 350) };
    if (o.ok && typeof o.body?.transaction === "string") {
      report.orderBuilt = true;
      let tx;
      let version;
      const bytes = Buffer.from(o.body.transaction, "base64");
      try { tx = VersionedTransaction.deserialize(bytes); version = tx.version; }
      catch { tx = Transaction.from(bytes); version = "legacy"; }
      const message = version === "legacy" ? tx.compileMessage() : tx.message;
      const keys = version === "legacy" ? message.accountKeys : message.staticAccountKeys;
      const required = message.header.numRequiredSignatures;
      report.transaction = { version, requiredSigners: keys.slice(0, required).map(k=>k.toBase58()),
        feePayer: keys[0]?.toBase58() ?? null,
        staticProgramIds: [...new Set((version === "legacy" ? message.instructions : message.compiledInstructions)
          .map(ix => keys[ix.programIdIndex]?.toBase58() ?? `lookup:${ix.programIdIndex}`))],
        lookupTables: version === "legacy" ? [] : (message.addressTableLookups ?? []).map(l => l.accountKey.toBase58()) };
      report.order = { orderPubkey: o.body.order?.orderPubkey ?? null,
        positionPubkey: o.body.order?.positionPubkey ?? null,
        requiredSignersFromApi: o.body.requiredSigners ?? o.body.order?.requiredSigners ?? null,
        executionModel: o.body.executionModel ?? null,
        settlement: o.body.settlement ?? null };
    }
  }
} catch(e) { report.error = String(e).slice(0, 350); }
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
