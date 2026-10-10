// Read-only confirmed transaction evidence inspector for previously discovered
// DFlow fill, partial-fill, cancellation and redeem signatures.
// Usage: DFLOW_TX_SIGNATURES="sig1,sig2" MAINNET_RPC_URL=... npm run inspect:dflow-events
import {Connection,PublicKey} from "@solana/web3.js";
import {pathToFileURL} from "node:url";
const PROGRAM="pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
const HEADER=Buffer.from([0xf0,0,0,0,0,0,0,0]);
const ALPHABET="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(value) {
 if(typeof value!=="string"||!value) throw Error("Invalid base58 instruction data");
 let n=0n;
 for(const char of value) {const d=ALPHABET.indexOf(char);if(d<0)throw Error("Invalid base58");n=n*58n+BigInt(d);}
 const out=[];while(n>0n){out.unshift(Number(n%256n));n/=256n;}
 for(let i=0;i<value.length&&value[i]==="1";i++)out.unshift(0);
 return Buffer.from(out);
}
export function inspectTransaction(tx,signature){
 if(!tx||tx.meta?.err!==null||!tx.meta||!Array.isArray(tx.meta.innerInstructions))
   throw Error("No successful transaction with inner instructions");
 const keys=tx.transaction.message.accountKeys.map(x=>typeof x==="string"?x:x.pubkey.toBase58?.()??String(x.pubkey));
 const found=[];
 for(const grp of tx.meta.innerInstructions){
   for(let i=0;i<grp.instructions.length;i++){
     const ix=grp.instructions[i];
     const executed=ix.programId?.toBase58?.()??keys[ix.programIdIndex];
     if(executed!==PROGRAM)continue;
     const bytes=typeof ix.data==="string"?decodeBase58(ix.data):null;
     if(!bytes||bytes.length<9||!bytes.subarray(0,8).equals(HEADER))continue;
     const eventType=bytes[8],subtype=eventType===2?bytes[9]:null;
     if(eventType!==2&&eventType!==3)continue;
     if(eventType===2&&(![1,2,3,4].includes(subtype)))throw Error("Unknown DFlow order event");
     found.push({signature,slot:tx.slot,outerIndex:grp.index,innerIndex:i,
       kind:eventType===3?"redeem":({1:"open",2:"fill",3:"cancel",4:"revert"}[subtype]),
       // Full versioned IDL needed to decode remaining fields with confidence.
       rawHex:bytes.toString("hex"),
       accounts:(ix.accounts??[]).map(k=>typeof k==="number"?keys[k]:k?.toBase58?.()??String(k))});
   }
 }
 return found;
}
async function main(){
 const sigs=(process.env.DFLOW_TX_SIGNATURES??"").split(",").map(x=>x.trim()).filter(Boolean);
 if(!sigs.length)throw Error("Set DFLOW_TX_SIGNATURES to comma-separated previously confirmed transaction signatures");
 const c=new Connection(process.env.MAINNET_RPC_URL??"https://api.mainnet-beta.solana.com","finalized");
 for(const sig of sigs){
  const status=await c.getSignatureStatuses([sig],{searchTransactionHistory:true});
  const st=status.value[0];
  if(!st||st.err||st.confirmationStatus!=="finalized")throw Error("Signature not finalized: "+sig);
  const tx=await c.getParsedTransaction(sig,{commitment:"finalized",maxSupportedTransactionVersion:0});
  console.log(JSON.stringify({signature:sig,events:inspectTransaction(tx,sig)},null,2));
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(e=>{console.error(e);process.exitCode=1;});
}
