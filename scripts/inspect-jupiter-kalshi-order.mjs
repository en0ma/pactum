import fs from "node:fs";
import { VersionedTransaction, Transaction, PublicKey } from "@solana/web3.js";

// Inspect an authentic unsigned Jupiter order response offline. Never sign or send.
// Usage: node scripts/inspect-jupiter-kalshi-order.mjs <response.json>
const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/inspect-jupiter-kalshi-order.mjs <response.json>");
const payload = JSON.parse(fs.readFileSync(input, "utf8"));
const serialized = payload.transaction ?? payload.data?.transaction ??
  payload.order?.transaction ?? payload.data?.order?.transaction;
if (typeof serialized !== "string" || !serialized.length) {
  throw new Error("No base64 serialized transaction in supported Jupiter response fields");
}
const raw = Buffer.from(serialized, "base64");
if (!raw.length) throw new Error("Transaction base64 is empty");
let tx;
let version;
try {
  tx = VersionedTransaction.deserialize(raw);
  version = tx.version;
} catch {
  tx = Transaction.from(raw);
  version = "legacy";
}
const output = { sourceFile: input, version, signatureCount: 0, requiredSigners: [], feePayer: null,
  staticProgramIds: [], addressLookupTables: [], accountCount: 0,
  note: "Static transaction inspection only. Lookup table addresses need RPC resolution to inventory every invoked program. No signing or submission occurred." };
if (version === "legacy") {
  const msg = tx.compileMessage();
  output.signatureCount = msg.header.numRequiredSignatures;
  output.feePayer = msg.accountKeys[0]?.toBase58() ?? null;
  output.requiredSigners = msg.accountKeys.slice(0, output.signatureCount).map(k => k.toBase58());
  output.accountCount = msg.accountKeys.length;
  output.staticProgramIds = [...new Set(msg.instructions.map(ix => msg.accountKeys[ix.programIdIndex]?.toBase58()))];
} else {
  const msg = tx.message;
  output.signatureCount = msg.header.numRequiredSignatures;
  output.requiredSigners = msg.staticAccountKeys.slice(0, output.signatureCount).map(k => k.toBase58());
  output.feePayer = msg.staticAccountKeys[0]?.toBase58() ?? null;
  output.accountCount = msg.staticAccountKeys.length;
  output.staticProgramIds = [...new Set(msg.compiledInstructions.map(ix =>
    msg.staticAccountKeys[ix.programIdIndex]?.toBase58() ?? `lookup-index:${ix.programIdIndex}`))];
  output.addressLookupTables = (msg.addressTableLookups ?? []).map(lookup => ({
    key: lookup.accountKey.toBase58(),
    writableIndexes: [...lookup.writableIndexes],
    readonlyIndexes: [...lookup.readonlyIndexes],
  }));
}
console.log(JSON.stringify(output, null, 2));
