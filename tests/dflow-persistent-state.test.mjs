import test from "node:test";
import assert from "node:assert/strict";
import {Keypair,PublicKey} from "@solana/web3.js";
import {inspectDflowState,DFLOW_PROGRAM} from "../scripts/inspect-dflow-persistent-state.mjs";
const order=Keypair.generate().publicKey.toBase58();
const market=Keypair.generate().publicKey.toBase58();
function rpc({liveOrder=false,marketOwner=DFLOW_PROGRAM}={}) {
 const calls=[];
 const client={async getAccountInfo(addr,commitment){
  assert.equal(commitment,"finalized");calls.push(addr.toBase58());
  if(addr.toBase58()===order&&!liveOrder)return null;
  return {owner:new PublicKey(addr.toBase58()===market?marketOwner:DFLOW_PROGRAM),
    lamports:1,data:Buffer.alloc(addr.toBase58()===market?568:344)};
 }};
 return {client,calls};
}
test("reads surviving DFlow market ledger without mistaking it for per-order proof",async()=>{
 const {client,calls}=rpc();
 const x=await inspectDflowState(client,{order,market});
 assert.equal(x.orderIsClosed,true);assert.equal(x.marketIsDflowOwned,true);
 assert.equal(x.hasPersistentOrderAmounts,false);
 assert.equal(x.accounts.market.dataLength,568);
 assert.equal(calls.length,2);
});
test("rejects forged DFlow ownership and does not infer filled amounts",async()=>{
 const {client}=rpc({liveOrder:true,marketOwner:Keypair.generate().publicKey.toBase58()});
 const x=await inspectDflowState(client,{order,market});
 assert.equal(x.orderIsClosed,false);assert.equal(x.marketIsDflowOwned,false);
 assert.equal(x.hasPersistentOrderAmounts,false);
});
test("requires explicit order and market locators",async()=>{
 const {client}=rpc();await assert.rejects(()=>inspectDflowState(client,{order}),/required/);
});
 
import {readFileSync} from "node:fs";
test("archived June orders retain distinct actual DFlow market mappings",()=>{
 const data=JSON.parse(readFileSync(new URL("./fixtures/dflow-june-partial-fill-cases.json",import.meta.url),"utf8"));
 assert.equal(data.cases.length,2);
 for(const example of data.cases){
  for(const field of ["orderAccount","marketLedger","marketUsdcAccount"])
   assert.equal(new PublicKey(example[field]).toBase58(),example[field]);
  assert.notEqual(example.orderAccount,example.marketLedger);
  assert.notEqual(example.marketLedger,example.marketUsdcAccount);
 }
 assert.notEqual(data.cases[0].marketLedger,data.cases[1].marketLedger);
});
