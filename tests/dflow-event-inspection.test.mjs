import test from "node:test";
import assert from "node:assert/strict";
import {inspectTransaction} from "../scripts/inspect-dflow-events.mjs";
import {PublicKey} from "@solana/web3.js";
const program=new PublicKey("pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb");
const other=new PublicKey("11111111111111111111111111111111");
function encode58(buf) {
 const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
 let n=0n;for(const b of buf)n=n*256n+BigInt(b);
 let out="";while(n>0n){out=alphabet[Number(n%58n)]+out;n/=58n;}
 for(const b of buf){if(b!==0)break;out="1"+out;}
 return out||"1";
}
function fixture(kind=2,issuer=program) {
 const payload=Buffer.from([0xf0,0,0,0,0,0,0,0,kind,...(kind===2?[2]:[]),5]);
 return {slot:123,meta:{err:null,innerInstructions:[{index:2,instructions:[
  {programId:issuer,accounts:[other],data:encode58(payload)}]}]},
  transaction:{message:{accountKeys:[{pubkey:program},{pubkey:other}]}}};
}
test("reads DFlow user-order partial-fill framing",()=>{
 const events=inspectTransaction(fixture(),"sig");
 assert.equal(events.length,1);assert.equal(events[0].kind,"fill");
 assert.equal(events[0].outerIndex,2);assert.equal(events[0].rawHex.slice(0,20),"f0000000000000000202");
});
test("reads redemption but does not invent originating order",()=>{
 const events=inspectTransaction(fixture(3),"sig");
 assert.equal(events[0].kind,"redeem");
 assert.ok(!("userOrder" in events[0]));
});
test("ignores spoofed event body by a different executing program",()=>{
 assert.deepEqual(inspectTransaction(fixture(2,other),"sig"),[]);
});
test("rejects failed or incomplete transaction",()=>{
 const tx=fixture();tx.meta.err={};assert.throws(()=>inspectTransaction(tx,"sig"));
 delete tx.meta.err;assert.throws(()=>inspectTransaction(tx,"sig"));
});
