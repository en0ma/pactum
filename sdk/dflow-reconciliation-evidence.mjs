// Off-chain protocol-keeper verifier. The keeper may only index finalized
// DFlow instructions; this is NOT an on-chain historical transaction proof.
export const DFLOW_PROGRAM="pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
const HEADER=Buffer.from([0xf0,0,0,0,0,0,0,0]);
const ORDER_KINDS=new Set([1,2,3,4]);

// Require fully resolved inner instructions; never scan arbitrary log strings
// or data without verifying the *executing* program identity.
export function extractFinalizedDflowEvents({transaction,signatureStatus,signature}) {
  if (!transaction || transaction.meta?.err != null)
    throw new Error("Missing or failed DFlow transaction");
  if (!signatureStatus || signatureStatus.err != null ||
      signatureStatus.confirmationStatus!=="finalized")
    throw new Error("Transaction is not finalized");
  if (!transaction.meta || !Array.isArray(transaction.meta.innerInstructions))
    throw new Error("Inner instruction metadata is required");
  if (typeof signature!=="string" || !signature)
    throw new Error("Missing signature");
  const keys=transaction.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) throw new Error("Resolved account keys required");
  const addresses=keys.map(k=>typeof k==="string"?k:k?.pubkey?.toBase58?.()??k?.pubkey);
  if (addresses.some(k=>typeof k!=="string"))
    throw new Error("Unresolved account address");
  const output=[];
  for (const group of transaction.meta.innerInstructions) {
    if (!Number.isInteger(group.index) || group.index<0)
      throw new Error("Invalid outer instruction index");
    for (let i=0;i<group.instructions.length;i++) {
      const ix=group.instructions[i];
      if (addresses[ix.programIdIndex]!==DFLOW_PROGRAM) continue;
      // getTransaction JSON shape uses base58-encoded inner instruction data.
      // Caller MUST decode base58; reject ambiguous encodings by requiring a
      // byte buffer explicitly supplied by a trusted parser.
      if (!Buffer.isBuffer(ix.decodedData))
        throw new Error("DFlow instruction bytes must be decoded explicitly");
      const d=ix.decodedData;
      if (d.length<9 || !d.subarray(0,8).equals(HEADER)) continue;
      const eventType=d[8];
      if (eventType!==2 && eventType!==3) continue;
      if (eventType===2 && (d.length<10 || !ORDER_KINDS.has(d[9])))
        throw new Error("Invalid DFlow order event subtype");
      output.push({signature,outerInstructionIndex:group.index,innerInstructionIndex:i,
        eventType,orderEventType:eventType===2?d[9]:null,rawEvent:Buffer.from(d)});
    }
  }
  return output;
}
