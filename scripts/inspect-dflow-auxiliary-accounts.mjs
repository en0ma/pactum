import {Connection,PublicKey} from "@solana/web3.js";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const DFLOW="pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
export async function inspectCandidates(connection,fixture){
 const out=[];
 for(const item of fixture.cases){
  const accounts=[];
  for(const address of item.accounts){
   const info=await connection.getAccountInfo(new PublicKey(address),"finalized");
   const bytes=info?.data?Buffer.from(info.data):null;
   const needle=new PublicKey(item.order).toBuffer();
   let orderOffsets=[];
   if(bytes)for(let i=0;i<=bytes.length-needle.length;i++)
     if(bytes.subarray(i,i+needle.length).equals(needle))orderOffsets.push(i);
   accounts.push({address,exists:!!info,owner:info?.owner.toBase58()??null,
     dflowOwned:info?.owner.toBase58()===DFLOW,dataLength:bytes?.length??null,
     orderPubkeyOffsets:orderOffsets});
  }
  out.push({case:item.case,order:item.order,accounts});
 }
 return {sourceArtifact:fixture.source.artifact,cases:out};
}
async function main(){
 if(!process.env.MAINNET_RPC_URL)throw Error("MAINNET_RPC_URL required");
 const fixture=JSON.parse(readFileSync(new URL("../tests/fixtures/dflow-june-candidate-state-accounts.json",import.meta.url)));
 const conn=new Connection(process.env.MAINNET_RPC_URL,"finalized");
 console.log(JSON.stringify(await inspectCandidates(conn,fixture),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{console.error(e);process.exitCode=1});
