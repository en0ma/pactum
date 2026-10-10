import test from "node:test";
import assert from "node:assert/strict";
import {extractFinalizedDflowEvents,DFLOW_PROGRAM} from "../sdk/dflow-reconciliation-evidence.mjs";

function observed({program=DFLOW_PROGRAM,finalized=true,failed=false}={}) {
  const tx={transaction:{message:{accountKeys:[program,"11111111111111111111111111111111"]}},
    meta:{err:failed?{InstructionError:[0,"Custom"]}:null,
      innerInstructions:[{index:1,instructions:[
        {programIdIndex:0,decodedData:Buffer.from([0xf0,0,0,0,0,0,0,0,2,2,12])},
        {programIdIndex:0,decodedData:Buffer.from([0xf0,0,0,0,0,0,0,0,2,3,13])},
      ]}]}};
  return {transaction:tx,signatureStatus:{err:null,confirmationStatus:finalized?"finalized":"confirmed"},
    signature:"test-signature"};
}
test("indexes only finalized DFlow program events with distinct positions",()=>{
 const out=extractFinalizedDflowEvents(observed());
 assert.equal(out.length,2);
 assert.equal(out[0].orderEventType,2);
 assert.equal(out[1].orderEventType,3);
 assert.notEqual(out[0].innerInstructionIndex,out[1].innerInstructionIndex);
});
test("rejects unfinalized, failed, and unresolved provenance",()=>{
 assert.throws(()=>extractFinalizedDflowEvents(observed({finalized:false})),/not finalized/);
 assert.throws(()=>extractFinalizedDflowEvents(observed({failed:true})),/failed/);
 const args=observed();delete args.transaction.meta.innerInstructions;
 assert.throws(()=>extractFinalizedDflowEvents(args),/metadata/);
});
test("never accepts mimicked event emitted by another program",()=>{
 assert.deepEqual(extractFinalizedDflowEvents(observed({program:"11111111111111111111111111111111"})),[]);
 const args=observed();args.transaction.meta.innerInstructions[0].instructions[0].decodedData=Buffer.from([0,0,0,0,0,0,0,0,2,2]);
 assert.equal(extractFinalizedDflowEvents(args).length,1);
});
test("rejects unknown event kind and undecoded instruction bytes",()=>{
 const args=observed();args.transaction.meta.innerInstructions[0].instructions[0].decodedData=Buffer.from([0xf0,0,0,0,0,0,0,0,2,99]);
 assert.throws(()=>extractFinalizedDflowEvents(args),/subtype/);
 args.transaction.meta.innerInstructions[0].instructions[0].decodedData="base58-not-verified";
 assert.throws(()=>extractFinalizedDflowEvents(args),/decoded explicitly/);
});
