import fs from "node:fs";
import { Connection, PublicKey, VersionedTransaction, Transaction } from "@solana/web3.js";

// Offline-first. Optionally GET an unsigned /order with explicit mint and wallet.
// Never signs, funds, simulates, or submits a transaction.
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PROGRAM = "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
const outputPath = process.env.DFLOW_INSPECTION_OUTPUT ?? "artifacts/dflow-quote-inspection.json";
const inputPath = process.env.DFLOW_ORDER_RESPONSE_FILE;
const mint = process.env.DFLOW_PROBE_OUTPUT_MINT;
const wallet = process.env.DFLOW_PROBE_USER;
const expectedVault = process.env.DFLOW_EXPECTED_VAULT_AUTHORITY;
const expectedKeeper = process.env.DFLOW_EXPECTED_KEEPER;
const api = process.env.DFLOW_TRADE_API_URL ?? "https://quote-api.dflow.net";
const report = { readOnly: true, broadcast: false, marketProvenanceVerified: false,
  inspectedAt: new Date().toISOString(), inputMint: USDC, outputMint: mint ?? null,
  source: inputPath ? "offline-file" : "production-order-api", transactionPresent: false,
  accountInspection: null, safety: { executable: false, reason: "No on-chain PDA custody proof" } };
const validKey = (v) => { if (!v) return null; return new PublicKey(v).toBase58(); };
async function main() {
  let body;
  if (inputPath) {
    body = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } else if (mint && wallet && process.env.DFLOW_API_KEY) {
    validKey(mint); validKey(wallet);
    const amount = process.env.DFLOW_PROBE_AMOUNT ?? "1000000";
    if (!/^[1-9][0-9]*$/.test(amount)) throw Error("Invalid amount");
    const query = new URLSearchParams({ inputMint: USDC, outputMint: mint,
      userPublicKey: wallet, amount,
      slippageBps: process.env.DFLOW_PROBE_SLIPPAGE_BPS ?? "100" });
    if (expectedVault) { query.set("destinationWallet", validKey(expectedVault)); query.set("revertWallet", validKey(expectedVault)); }
    query.set("includeAddressLookupTables", "true");
    const response = await fetch(new URL("/order?" + query, api), {
      headers: { "x-api-key": process.env.DFLOW_API_KEY },
      signal: AbortSignal.timeout(12000) });
    report.httpStatus = response.status;
    if (!response.ok) throw Error("DFlow returned HTTP " + response.status);
    body = await response.json();
  } else {
    report.safety.reason = "Provide DFLOW_ORDER_RESPONSE_FILE, or DFLOW_PROBE_OUTPUT_MINT + DFLOW_PROBE_USER + DFLOW_API_KEY";
    return;
  }
  report.quote = { inAmount: body.inAmount ?? null, outAmount: body.outAmount ?? null,
    minOutAmount: body.minOutAmount ?? null, executionMode: body.executionMode ?? null };
  report.apiRoles = {
    destinationWallet: body.destinationWallet ?? null,
    revertWallet: body.revertWallet ?? null,
    refundWallet: body.refundWallet ?? null,
    destinationWalletMustSign: body.destinationWalletMustSign ?? null,
  };
  const encoded = body.transaction ?? body.data?.transaction;
  if (typeof encoded !== "string") { report.safety.reason = "No unsigned transaction returned"; return; }
  const data = Buffer.from(encoded, "base64");
  let tx, msg, ixs, keys, version;
  try { tx = VersionedTransaction.deserialize(data); msg = tx.message; version = String(tx.version); }
  catch { tx = Transaction.from(data); msg = tx.compileMessage(); version = "legacy"; }
  const lookupAccounts = [];
  if (msg.addressTableLookups?.length) {
    const rpc = process.env.MAINNET_RPC_URL;
    if (rpc) {
      const conn = new Connection(rpc, "confirmed");
      for (const lookup of msg.addressTableLookups) {
        const result = await conn.getAddressLookupTable(lookup.accountKey);
        if (!result.value) throw Error("Missing address lookup table " + lookup.accountKey);
        lookupAccounts.push(result.value);
      }
    }
  }
  const resolved = version === "legacy" ? msg.accountKeys :
    (msg.addressTableLookups?.length && lookupAccounts.length !== msg.addressTableLookups.length)
      ? null : msg.getAccountKeys({ addressLookupTableAccounts: lookupAccounts });
  const keyAt = i => version === "legacy" ? resolved[i]?.toBase58() : resolved?.get(i)?.toBase58();
  ixs = version === "legacy" ? msg.instructions : msg.compiledInstructions;
  const n = msg.header.numRequiredSignatures;
  const staticKeys = version === "legacy" ? msg.accountKeys : msg.staticAccountKeys;
  const instructions = ixs.map((ix, index) => ({
    index, programId: keyAt(ix.programIdIndex) ?? null,
    accountIndexes: [...(ix.accounts ?? ix.accountKeyIndexes)],
    accountPubkeys: [...(ix.accounts ?? ix.accountKeyIndexes)].map(keyAt),
    dataHex: Buffer.from(ix.data).toString("hex"),
  }));
  const accounts = [...Array(resolved ? resolved.length : staticKeys.length).keys()].map(i=>({
    index:i, pubkey:keyAt(i) ?? staticKeys[i]?.toBase58() ?? null,
    signer:i < n,
    writable: version === "legacy" ? (i < n ? i < n - msg.header.numReadonlySignedAccounts :
      i < staticKeys.length - msg.header.numReadonlyUnsignedAccounts) :
      msg.isAccountWritable(i),
  }));
  report.transactionPresent = true;
  report.accountInspection = { version, feePayer: keyAt(0), requiredSigners: accounts.filter(a=>a.signer).map(a=>a.pubkey), accounts,
    addressLookupTables: (msg.addressTableLookups ?? []).map(l=>l.accountKey.toBase58()),
    lookupTablesResolved: resolved !== null, instructions,
    containsDflowPredictionProgram: instructions.some(ix=>ix.programId===PROGRAM) };
  const violations = [];
  if (!resolved) violations.push("Address lookup tables unresolved");
  if (expectedKeeper && !accounts.some(a=>a.pubkey===expectedKeeper && a.signer))
    violations.push("Expected keeper is not a required signer");
  if (expectedVault) {
    if (accounts.some(a=>a.pubkey===expectedVault && a.signer)) violations.push("Vault PDA is required as top-level signer");
    for (const role of ["destinationWallet","revertWallet"]) {
      if (report.apiRoles[role] && report.apiRoles[role] !== expectedVault) violations.push(role+" mismatches expected vault");
      if (!report.apiRoles[role]) violations.push(role+" not echoed by API; inspect DFlow instruction accounts");
    }
    if (report.apiRoles.destinationWalletMustSign === true) violations.push("API requires destination wallet signer");
  } else violations.push("No expected vault authority configured");
  if (!report.accountInspection.containsDflowPredictionProgram) violations.push("Legacy DFlow PM program not seen in instructions (router route possible)");
  if (body.executionMode !== "async") violations.push("Async execution mode not explicitly confirmed");
  report.safety = { executable:false, inspectionViolations:violations,
    reason:"Inspection is advisory. Pactum on-chain checks and atomic funding are not proven." };
}
try { await main(); }
catch(e) { report.error = String(e.message ?? e).slice(0,200); }
fs.mkdirSync("artifacts",{recursive:true});
fs.writeFileSync(outputPath, JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({readOnly:report.readOnly,transactionPresent:report.transactionPresent,
  httpStatus:report.httpStatus??null, error:report.error??null,
  inspectionViolations:report.safety.inspectionViolations??[],output:outputPath}));
