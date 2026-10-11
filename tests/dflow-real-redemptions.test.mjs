import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const evidence=JSON.parse(readFileSync(new URL("./fixtures/dflow-real-redemptions-2026.json",import.meta.url),"utf8"));
function check(c){
 if(c.action!==89||c.eventSubtype!==3)throw Error("wrong DFlow redemption route");
 if(c.marketUsdc===c.recipientUsdc)throw Error("same payout account");
 const debit=BigInt(c.debitedUsdcAtoms),credit=BigInt(c.creditedUsdcAtoms);
 if(debit<=0n||credit!==debit)throw Error("payout deltas mismatch");
 return true;
}
test("two real finalized DFlow 0x59 redemptions credit exactly the observed USDC debit",()=>{
 assert.equal(evidence.source.artifact,11686286269);
 assert.equal(evidence.cases.length,2);
 for(const c of evidence.cases)assert.equal(check(c),true);
});
test("rejects fake routes or unrelated payout amounts",()=>{
 const c=evidence.cases[0];
 assert.throws(()=>check({...c,action:88}),/route/);
 assert.throws(()=>check({...c,eventSubtype:2}),/route/);
 assert.throws(()=>check({...c,creditedUsdcAtoms:"999999"}),/mismatch/);
 assert.throws(()=>check({...c,marketUsdc:c.recipientUsdc}),/same payout/);
});
