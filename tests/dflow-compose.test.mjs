import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, AddressLookupTableAccount,
} from "@solana/web3.js";
import {composePactumDflow} from "../sdk/compose-dflow-order.mjs";

const keeper=Keypair.generate().publicKey;
const vault=Keypair.generate().publicKey;
const prediction=new PublicKey("pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb");
const ix = new TransactionInstruction({programId:prediction,keys:[
  {pubkey:keeper,isSigner:true,isWritable:true},
  {pubkey:vault,isSigner:false,isWritable:false},
],data:Buffer.from([64,0,0])});
const pactumIx=new TransactionInstruction({programId:Keypair.generate().publicKey,keys:[
  {pubkey:keeper,isSigner:true,isWritable:true},
  {pubkey:vault,isSigner:false,isWritable:false}
],data:Buffer.from([4,0,0])});
const blockhash=Keypair.generate().publicKey.toBase58();
function serialize(lookupAccounts=[], target=keeper) {
  const message=new TransactionMessage({payerKey:target,recentBlockhash:blockhash,
    instructions:[ix]}).compileToV0Message(lookupAccounts);
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}
test("prepends Pactum and preserves unsigned DFlow instruction",()=>{
  const result=composePactumDflow({dflowTransactionBase64:serialize(),pactumInstruction:pactumIx,
    expectedKeeper:keeper.toBase58(),expectedVault:vault.toBase58()});
  assert.equal(result.audit.combinedInstructionCount,2);
  assert.equal(result.audit.safeForExecution,false);
  assert.equal(result.audit.signed,false);
  assert.equal(result.instructions[0].programId.toBase58(),pactumIx.programId.toBase58());
  assert.equal(result.instructions[1].programId.toBase58(),prediction.toBase58());
  assert.ok(result.requiredSigners.includes(keeper.toBase58()));
  assert.ok(!result.requiredSigners.includes(vault.toBase58()));
});
test("rejects mismatched keeper and signer PDA",()=>{
  assert.throws(()=>composePactumDflow({dflowTransactionBase64:serialize(),pactumInstruction:pactumIx,
    expectedKeeper:Keypair.generate().publicKey.toBase58(),expectedVault:vault.toBase58()}),/payer differs/);
  const badIx=new TransactionInstruction({programId:pactumIx.programId,
    keys:[{pubkey:vault,isSigner:true,isWritable:false}],data:Buffer.from([0])});
  assert.throws(()=>composePactumDflow({dflowTransactionBase64:serialize(),pactumInstruction:badIx,
    expectedKeeper:keeper.toBase58(),expectedVault:vault.toBase58()}),/PDA signature/);
});
test("rejects transaction beyond specified size budget",()=>{
  assert.throws(()=>composePactumDflow({dflowTransactionBase64:serialize(),pactumInstruction:pactumIx,
    expectedKeeper:keeper.toBase58(),expectedVault:vault.toBase58(),maxBytes:200}),/packet size/);
});
test("resolves ALT references and fails closed on missing tables",()=>{
  const lookup=new AddressLookupTableAccount({key:Keypair.generate().publicKey,
    state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,
      authority:keeper,addresses:[vault]}});
  const data=serialize([lookup]);
  const decoded=VersionedTransaction.deserialize(Buffer.from(data,"base64"));
  assert.ok(decoded.message.addressTableLookups.length>0);
  assert.throws(()=>composePactumDflow({dflowTransactionBase64:data,pactumInstruction:pactumIx,
    expectedKeeper:keeper.toBase58(),expectedVault:vault.toBase58()}),/Unresolved/);
  const result=composePactumDflow({dflowTransactionBase64:data,pactumInstruction:pactumIx,
    addressLookupTableAccounts:[lookup],expectedKeeper:keeper.toBase58(),expectedVault:vault.toBase58()});
  assert.equal(result.audit.combinedInstructionCount,2);
});
