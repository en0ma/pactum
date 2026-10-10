import {Connection,PublicKey} from "@solana/web3.js";
import {pathToFileURL} from "node:url";
import {readFileSync} from "node:fs";

export const DFLOW_PROGRAM = "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
const ACCOUNT_TYPES = ["order", "market", "settlement", "outcome", "refund"];
function key(s) { return new PublicKey(s); }

// Read actual *current* Solana account info. Never accept keeper-reported owner,
// lamports, or data bytes; callers must supply account addresses only.
export async function inspectDflowState(connection, targets) {
  if (!targets?.order || !targets?.market) throw Error("Order and market addresses required");
  const program=DFLOW_PROGRAM;
  const result={context:"current-state-only",order:targets.order,market:targets.market,accounts:{}};
  for (const type of ACCOUNT_TYPES) {
    const addr=targets[type];
    if (!addr) continue;
    const info=await connection.getAccountInfo(key(addr),"finalized");
    result.accounts[type]=info?{
      address:addr,owner:info.owner.toBase58(),lamports:info.lamports,
      dataLength:info.data.length,
      // Hash permits comparison without assuming undocumented offsets.
      dataBase64:Buffer.from(info.data).toString("base64"),
      dflowOwned:info.owner.toBase58()===program,
    }:{address:addr,exists:false};
  }
  const order=result.accounts.order,market=result.accounts.market;
  result.orderIsClosed=!order.exists&&order.owner===undefined;
  result.marketIsDflowOwned=!!market.dflowOwned;
  result.hasPersistentOrderAmounts=false; // Not proven by account presence alone.
  return result;
}
async function main(){
  const rpc=process.env.MAINNET_RPC_URL;
  if(!rpc)throw Error("MAINNET_RPC_URL required");
  // Use archived mainnet mappings directly, not independently typed market
  // addresses, when inspecting one of the recovered partial-fill examples.
  const caseLabel=process.env.DFLOW_JUNE_CASE;
  const archive=caseLabel?JSON.parse(readFileSync(
    new URL("../tests/fixtures/dflow-june-partial-fill-cases.json",import.meta.url),"utf8")):null;
  const example=caseLabel?archive.cases.find(x=>x.label===caseLabel):null;
  if(caseLabel&&!example)throw Error("Unknown recovered DFlow June case");
  const order=example?.orderAccount??process.env.DFLOW_ORDER_ACCOUNT;
  const market=example?.marketLedger??process.env.DFLOW_MARKET_LEDGER;
  if(!order||!market)throw Error("DFLOW_ORDER_ACCOUNT and DFLOW_MARKET_LEDGER required");
  const c=new Connection(rpc,"finalized");
  const state=await inspectDflowState(c,{order,market,
    settlement:example?.marketUsdcAccount??process.env.DFLOW_MARKET_USDC_ACCOUNT,
    outcome:process.env.DFLOW_OUTCOME_TOKEN_ACCOUNT,
    refund:process.env.DFLOW_REFUND_USDC_ACCOUNT});
  console.log(JSON.stringify(state,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(err=>{console.error(err);process.exitCode=1});
}
