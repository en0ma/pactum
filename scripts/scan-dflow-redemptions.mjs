import {Connection,PublicKey} from "@solana/web3.js";
import {writeFileSync,mkdirSync} from "node:fs";
const PROGRAM="pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
const BASE58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function from58(s){let x=0n;for(const c of s){const i=BASE58.indexOf(c);if(i<0)throw Error("invalid base58");x=x*58n+BigInt(i)}const b=[];while(x){b.push(Number(x&255n));x>>=8n}b.reverse();return Buffer.concat([Buffer.alloc(s.match(/^1*/)[0].length),Buffer.from(b)])}
function ixData(ix){if(!ix?.data)return null;return typeof ix.data==="string"?from58(ix.data):Buffer.from(ix.data)}
function keyList(tx){return [...tx.transaction.message.staticAccountKeys,...(tx.meta?.loadedAddresses?.writable??[]),...(tx.meta?.loadedAddresses?.readonly??[])].map(x=>x.toBase58())}
export function redeemInstructions(tx,signature){
 const keys=keyList(tx),output=[],outer=tx.transaction.message.compiledInstructions??[],groups=tx.meta?.innerInstructions??[];
 for(const {ix,outerIndex,innerIndex} of [...outer.map((ix,i)=>({ix,outerIndex:i,innerIndex:null})),...groups.flatMap(g=>g.instructions.map((ix,j)=>({ix,outerIndex:g.index,innerIndex:j})))]){
  if(keys[ix.programIdIndex]!==PROGRAM)continue;
  const data=ixData(ix);if(!data)continue;
  const action=data.length>=8?data.readBigUInt64LE(0):null;
  const isRedeem=(action===88n||action===89n)&&data.length===8;
  const isRedeemEvent=data.length>=9&&data[0]===240&&data.subarray(1,8).every(b=>b===0)&&data[8]===3;
  if(!isRedeem&&!isRedeemEvent)continue;
  output.push({signature,slot:tx.slot,blockTime:tx.blockTime,outerIndex,innerIndex,
    kind:isRedeem?"redeem-instruction":"redeem-event",dataHex:data.toString("hex"),
    accounts:[...(ix.accountKeyIndexes??ix.accounts??[])].map(i=>keys[i]),});
 }
 return output;
}
export function redemptionTransactionDetails(tx,signature){
 const keys=keyList(tx), all=[];
 for(const [outerIndex,ix] of (tx.transaction.message.compiledInstructions??[]).entries())
  all.push({outerIndex,innerIndex:null,ix});
 for(const group of tx.meta?.innerInstructions??[])
  for(const [innerIndex,ix] of group.instructions.entries())all.push({outerIndex:group.index,innerIndex,ix});
 const dflowActions=all.filter(x=>keys[x.ix.programIdIndex]===PROGRAM).map(x=>{
  const data=ixData(x.ix);return {outerIndex:x.outerIndex,innerIndex:x.innerIndex,
    actionU64:data?.length>=8?data.readBigUInt64LE(0).toString():null,
    dataHex:data?.toString("hex")??null,
    accounts:[...(x.ix.accountKeyIndexes??x.ix.accounts??[])].map(i=>keys[i])};
 });
 const balances=(tx.meta?.postTokenBalances??[]).flatMap(post=>{
  const pre=(tx.meta?.preTokenBalances??[]).find(p=>p.accountIndex===post.accountIndex&&p.mint===post.mint);
  const delta=BigInt(post.uiTokenAmount.amount)-BigInt(pre?.uiTokenAmount?.amount??"0");
  return delta===0n?[]:[{address:keys[post.accountIndex],mint:post.mint,
     owner:post.owner??pre?.owner??null,deltaAtoms:delta.toString()}];
 });
 const splActions=all.filter(x=>[ "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].includes(keys[x.ix.programIdIndex])).map(x=>{
   const data=ixData(x.ix);
   const opcode=data?.[0]??null;
   return {outerIndex:x.outerIndex,innerIndex:x.innerIndex,program:keys[x.ix.programIdIndex],
     opcode,amountAtoms:data&&data.length>=9&&[3,8,12,13,14,15].includes(opcode)?data.readBigUInt64LE(1).toString():null,
     accounts:[...(x.ix.accountKeyIndexes??x.ix.accounts??[])].map(i=>keys[i])};
 });
 return {signature,slot:tx.slot,dflowActions,tokenInstructions:splActions,tokenBalanceDeltas:balances};
}
export async function scan(connection,{limit=300,page=100,maxMatches=8}={}){
 const matches=[],seen=new Set();let before,scanned=0,failed=0;
 while(scanned<limit&&matches.length<maxMatches){
  const sigs=await connection.getSignaturesForAddress(new PublicKey(PROGRAM),{limit:Math.min(page,limit-scanned),...(before?{before}:{})},"finalized");
  if(!sigs.length)break;before=sigs.at(-1).signature;
  for(const sig of sigs){scanned++;if(sig.err)continue;
   const tx=await connection.getTransaction(sig.signature,{commitment:"finalized",maxSupportedTransactionVersion:0});
   if(!tx){failed++;continue}
   for(const event of redeemInstructions(tx,sig.signature)){
    const k=`${event.signature}:${event.outerIndex}:${event.innerIndex}`;if(!seen.has(k)){seen.add(k);matches.push(event)}
   }
   if(matches.length>=maxMatches)break;
  }
 }
 return {program:PROGRAM,commitment:"finalized",scanned,failed,matchCount:matches.length,matches,complete:scanned<limit};
}
if(process.argv[1]?.endsWith("scan-dflow-redemptions.mjs")){
 const rpc=process.env.MAINNET_RPC_URL;if(!rpc)throw Error("MAINNET_RPC_URL required");
 const conn=new Connection(rpc,"finalized");
 const signatures=(process.env.DFLOW_REDEEM_SIGNATURES??"").split(",").map(s=>s.trim()).filter(Boolean);
 const result=signatures.length?{program:PROGRAM,commitment:"finalized",mode:"specified-signatures",matches:[],transactionDetails:[]}
  :await scan(conn,{limit:Number(process.env.DFLOW_REDEEM_SCAN_LIMIT??300)});
 for(const signature of signatures){
  const tx=await conn.getTransaction(signature,{commitment:"finalized",maxSupportedTransactionVersion:0});
  if(!tx||tx.meta?.err)throw Error("Missing or failed redemption transaction");
  result.matches.push(...redeemInstructions(tx,signature));
  result.transactionDetails.push(redemptionTransactionDetails(tx,signature));
 }
 if(!signatures.length){
  result.transactionDetails=[];
  for(const signature of [...new Set(result.matches.map(x=>x.signature))].slice(0,3)){
   const tx=await conn.getTransaction(signature,{commitment:"finalized",maxSupportedTransactionVersion:0});
   if(tx)result.transactionDetails.push(redemptionTransactionDetails(tx,signature));
  }
 }
 mkdirSync("artifacts",{recursive:true});writeFileSync("artifacts/dflow-redemption-transactions.json",JSON.stringify(result,null,2)+"\n");
 console.log(JSON.stringify({scanned:result.scanned,failed:result.failed,matches:result.matches.map(x=>({signature:x.signature,kind:x.kind,slot:x.slot}))}));
}
