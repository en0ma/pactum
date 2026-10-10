import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const fixture=JSON.parse(readFileSync(new URL("./fixtures/dflow-june-partial-fill-cases.json",import.meta.url),"utf8"));
function validate(x){
 for(const k of ["open","fill","outcome","refundDelta"])
   if(!Number.isSafeInteger(x[k])||x[k]<0)throw Error("Invalid amount");
 if(x.open<=0||x.fill<=0||x.outcome<=0)throw Error("Invalid partial fill");
 if(x.fill>=x.open)throw Error("Not a partial fill");
 if(x.refundDelta!==x.open-x.fill)throw Error("Refund/principal mismatch");
 if(x.openRefundRecipient!==x.actualRefundOwner||x.openSourceUsdc!==x.actualRefundAccount)
   throw Error("Refund is not attributed to the registered open's refund identity/source");
 return true;
}
test("recovered June mainnet partial fills reconcile observed original principal",()=>{
 assert.equal(fixture.sourceArtifact,11532353903);
 assert.equal(fixture.cases.length,2);
 for(const x of fixture.cases)assert.equal(validate(x),true);
});
test("rejects spoofed custody destination, wrong refund and made-up full fill",()=>{
 const x=fixture.cases[0];
 assert.throws(()=>validate({...x,refundDelta:x.refundDelta+1}),/mismatch/);
 assert.throws(()=>validate({...x,actualRefundOwner:"different-owner"}),/attributed/);
 assert.throws(()=>validate({...x,actualRefundAccount:"different-token-account"}),/attributed/);
 assert.throws(()=>validate({...x,fill:x.open}),/partial/);
 assert.throws(()=>validate({...x,fill:x.open+1}),/partial/);
});
