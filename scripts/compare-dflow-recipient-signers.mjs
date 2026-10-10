import fs from "node:fs";
import { PublicKey, VersionedTransaction, Transaction } from "@solana/web3.js";

// Inspect two read-only DFlow /order responses using the same trader and mint.
// No signing, simulation, funding or transaction submission.
const output = "artifacts/dflow-recipient-signer-comparison.json";
const env = process.env;
const report = { readOnly:true, ordersSubmitted:0, txBroadcast:false,
  comparedAt:new Date().toISOString(), comparisons:[], verdict:"not_tested" };
const all = [env.DFLOW_API_KEY,env.DFLOW_PROBE_OUTPUT_MINT,env.DFLOW_PROBE_USER,env.DFLOW_EXPECTED_VAULT_AUTHORITY];
const pk = v => new PublicKey(v).toBase58();
async function request(label, override) {
  const params = new URLSearchParams({
    inputMint:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    outputMint:pk(env.DFLOW_PROBE_OUTPUT_MINT),
    userPublicKey:pk(env.DFLOW_PROBE_USER),
    amount:env.DFLOW_PROBE_AMOUNT ?? "1000000",
    slippageBps:env.DFLOW_PROBE_SLIPPAGE_BPS ?? "100",
    includeAddressLookupTables:"true",
  });
  if (override) {
    params.set("destinationWallet",pk(env.DFLOW_EXPECTED_VAULT_AUTHORITY));
    params.set("revertWallet",pk(env.DFLOW_EXPECTED_VAULT_AUTHORITY));
  }
  const endpoint = new URL("/order?" + params,env.DFLOW_TRADE_API_URL ?? "https://quote-api.dflow.net");
  const response = await fetch(endpoint,{headers:{"x-api-key":env.DFLOW_API_KEY},signal:AbortSignal.timeout(12000)});
  const summary = {label,httpStatus:response.status,ok:response.ok,transactionPresent:false};
  if (!response.ok) return summary;
  const json=await response.json();
  const serialized=json.transaction ?? json.data?.transaction;
  if (typeof serialized !== "string") return {...summary,reason:"No unsigned transaction"};
  const buffer=Buffer.from(serialized,"base64");
  let keys, required, version, msg;
  try {
    const tx=VersionedTransaction.deserialize(buffer);
    msg=tx.message;keys=msg.staticAccountKeys;required=msg.header.numRequiredSignatures;
    version=String(tx.version);
  } catch {
    const tx=Transaction.from(buffer);
    msg=tx.compileMessage();keys=msg.accountKeys;required=msg.header.numRequiredSignatures;
    version="legacy";
  }
  const signers=keys.slice(0,required).map(k=>k.toBase58());
  return {...summary,transactionPresent:true,version,
    signers,requiredSignerCount:required,
    vaultMustSign:signers.includes(pk(env.DFLOW_EXPECTED_VAULT_AUTHORITY)),
    keeperMustSign:signers.includes(pk(env.DFLOW_PROBE_USER)),
    destinationWalletMustSign:json.destinationWalletMustSign ?? null,
    executionMode:json.executionMode ?? null,
    addressLookupTables:(msg.addressTableLookups??[]).map(x=>x.accountKey.toBase58())};
}
try {
  if (all.some(v=>!v)) {
    report.reason="Set DFLOW_API_KEY, DFLOW_PROBE_OUTPUT_MINT, DFLOW_PROBE_USER, and DFLOW_EXPECTED_VAULT_AUTHORITY; no requests made.";
  } else {
    const baseline=await request("baseline_default_recipients",false);
    const vault=await request("vault_destination_and_revert",true);
    report.comparisons=[baseline,vault];
    report.verdict=baseline.transactionPresent && vault.transactionPresent
      ? (vault.vaultMustSign ? "vault_signer_required" : "no_vault_top_level_signature")
      : "insufficient_transactions";
    report.note="Signer comparison is not custody/market verification. Lookup indices do not contain top-level signers.";
  }
} catch(e) {report.error=String(e.message??e).slice(0,200);}
fs.mkdirSync("artifacts",{recursive:true});
fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({verdict:report.verdict,comparisons:report.comparisons.map(x=>({
  label:x.label,httpStatus:x.httpStatus,transactionPresent:x.transactionPresent,
  vaultMustSign:x.vaultMustSign,keeperMustSign:x.keeperMustSign})),reason:report.reason??null,error:report.error??null}));
