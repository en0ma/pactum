import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {Connection} from "@solana/web3.js";
import {redemptionTransactionDetails,redeemInstructions} from "./scan-dflow-redemptions.mjs";
const mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const eventAuthority="ATZQPakBrumxMrSyuEmrt6NcxBbTR1Ucs99dnPFpBUuM";
const dflow="pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
const spl="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const token2022="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export function verifyRedemption(tx,expected){
 assert.equal(tx.meta?.err,null,"finalized transaction must succeed");
 const details=redemptionTransactionDetails(tx,expected.signature);
 const actions=details.dflowActions.filter(a=>a.actionU64==="89"&&a.dataHex===("5900000000000000"+Buffer.from(Uint8Array.from({length:8},(_,i)=>Number((BigInt(expected.burnOutcomeAtoms)>>BigInt(8*i))&255n))).toString("hex")));
 assert.equal(actions.length,1,"exactly one DFlow 0x59 route");
 assert.deepEqual(actions[0].accounts,[dflow,eventAuthority,expected.marketLedger,expected.marketUsdc,expected.outcomeAccount,expected.recipientUsdc,mint,expected.outcomeMint,expected.outcomeAuthority,token2022,spl],"exact 0x59 program and custody account roles");
 const events=redeemInstructions(tx,expected.signature).filter(e=>e.kind==="redeem-event");
 assert.ok(events.length>=1,"DFlow must emit redeem event");
 const burns=details.tokenInstructions.filter(x=>x.program===token2022&&x.opcode===15&&x.accounts[0]===expected.outcomeAccount&&x.accounts[1]===expected.outcomeMint&&x.accounts[2]===expected.outcomeAuthority&&x.amountAtoms===expected.burnOutcomeAtoms);
 assert.equal(burns.length,1,"exact Token-2022 BurnChecked for outcome account");
 const transfers=details.tokenInstructions.filter(x=>x.program===spl&&x.opcode===12&&x.accounts[0]===expected.marketUsdc&&x.accounts[1]===mint&&x.accounts[2]===expected.recipientUsdc&&x.amountAtoms===expected.creditedUsdcAtoms);
 assert.equal(transfers.length,1,"exact SPL TransferChecked payout");
 const closes=details.tokenInstructions.filter(x=>x.program===token2022&&x.opcode===9&&x.accounts[0]===expected.outcomeAccount);
 assert.equal(closes.length,1,"outcome account close must match burn source");
 for(const [account,delta] of [[expected.marketUsdc,"-"+expected.debitedUsdcAtoms],[expected.recipientUsdc,expected.creditedUsdcAtoms]]){
  assert.ok(details.tokenBalanceDeltas.some(b=>b.address===account&&b.mint===mint&&b.deltaAtoms===delta),`missing actual USDC balance delta for ${account}`);
 }
 assert.equal(expected.burnOutcomeAtoms,expected.creditedUsdcAtoms,"fixture payout conservation");
 return {signature:expected.signature,slot:tx.slot,action:"0x59",eventCount:events.length,burnAtoms:expected.burnOutcomeAtoms,payoutUsdcAtoms:expected.creditedUsdcAtoms,verified:true};
}
if(process.argv[1]?.endsWith("verify-dflow-redemption-rpc.mjs")){
 const rpc=process.env.MAINNET_RPC_URL;if(!rpc)throw Error("MAINNET_RPC_URL required; cannot claim live verification");
 const fixture=JSON.parse(readFileSync(new URL("../tests/fixtures/dflow-real-redemptions-2026.json",import.meta.url),"utf8"));
 const connection=new Connection(rpc,"finalized"),verified=[];
 for(const c of fixture.cases){
  const tx=await connection.getTransaction(c.signature,{commitment:"finalized",maxSupportedTransactionVersion:0});
  if(!tx)throw Error("Archived transaction not returned by RPC: "+c.signature);
  verified.push(verifyRedemption(tx,c));
 }
 mkdirSync("artifacts",{recursive:true});
 writeFileSync("artifacts/dflow-redemption-rpc-verification.json",JSON.stringify({program:dflow,commitment:"finalized",verified},null,2)+"\n");
 console.log(JSON.stringify({verified:verified.length,results:verified}));
}
