import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

// Offline-only transaction composition. Never signs or broadcasts.
// All externally obtained transaction instructions are untrusted.
export function composePactumDflow({
  dflowTransactionBase64, pactumInstruction, addressLookupTableAccounts = [],
  expectedKeeper, expectedVault, maxBytes = 1232,
}) {
  if (!dflowTransactionBase64 || !pactumInstruction) throw Error("Missing DFlow transaction or Pactum instruction");
  if (!expectedKeeper || !expectedVault) throw Error("Keeper and vault required");
  const keeper = new PublicKey(expectedKeeper);
  const vault = new PublicKey(expectedVault);
  const original = VersionedTransaction.deserialize(Buffer.from(dflowTransactionBase64, "base64"));
  const lookups = original.message.addressTableLookups ?? [];
  const present = new Set(addressLookupTableAccounts.map(x=>x.key.toBase58()));
  if (lookups.some(x=>!present.has(x.accountKey.toBase58())))
    throw Error("Unresolved DFlow lookup table");
  const decoded = TransactionMessage.decompile(original.message, {addressLookupTableAccounts});
  if (!decoded.payerKey.equals(keeper)) throw Error("DFlow payer differs from authorized keeper");
  if (original.message.staticAccountKeys.slice(0,original.message.header.numRequiredSignatures).some(k=>k.equals(vault)))
    throw Error("Vault PDA cannot be top-level signer");
  if (pactumInstruction.keys.some(k=>k.pubkey.equals(vault) && k.isSigner))
    throw Error("Pactum instruction incorrectly requires vault PDA signature");
  const instructions = [pactumInstruction, ...decoded.instructions];
  const combinedMessage = new TransactionMessage({
    payerKey: keeper,
    recentBlockhash: decoded.recentBlockhash,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts);
  const combined = new VersionedTransaction(combinedMessage);
  const requiredSigners = combinedMessage.staticAccountKeys
    .slice(0,combinedMessage.header.numRequiredSignatures).map(k=>k.toBase58());
  if (requiredSigners.includes(vault.toBase58())) throw Error("Vault PDA became a required signer");
  const serializedBytes = combined.serialize().length;
  if (serializedBytes > maxBytes) throw Error("Combined transaction exceeds Solana packet size: "+serializedBytes);
  return {
    transaction: combined, instructions, requiredSigners,
    audit: {
      originalInstructionCount: decoded.instructions.length,
      combinedInstructionCount: instructions.length,
      serializedBytes, maxBytes,
      keeper: keeper.toBase58(), vault: vault.toBase58(),
      payer: combinedMessage.staticAccountKeys[0].toBase58(),
      dflowInstructionsPreserved: true,
      signed: false, submitted: false,
      // No claims of custody safety: on-chain instructions-sysvar enforcement must still be built.
      safeForExecution: false,
    },
  };
}
