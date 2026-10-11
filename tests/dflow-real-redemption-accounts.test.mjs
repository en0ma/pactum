import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const fixture=JSON.parse(readFileSync(new URL("./fixtures/dflow-real-redemptions-2026.json",import.meta.url),"utf8"));
const dflow="pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
const eventAuthority="ATZQPakBrumxMrSyuEmrt6NcxBbTR1Ucs99dnPFpBUuM";
const usdc="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const token2022="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const spl="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
function checkAccounts(actual,record){
 const expected=[dflow,eventAuthority,record.marketLedger,record.marketUsdc,
 record.outcomeAccount,record.recipientUsdc,usdc,record.outcomeMint,
 record.outcomeAuthority,token2022,spl];
 assert.deepEqual(actual,expected,"DFlow 0x59 account layout must match recorded CPI roles");
}
const observations=[
 ["pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb","ATZQPakBrumxMrSyuEmrt6NcxBbTR1Ucs99dnPFpBUuM","2Mb9VfikR6g9NXcXoEGvcjNMvwcdony8zu359WEC9vbh","5aNcsAzb9ZzeyhwTGaxDbi49FbEu7ois38nbxpCg36vn","HEtexPo9ZGdPGEvVAHjDNx1iDHyXDFkkNsEriaFeoWb5","BQQsYUjaJMyHyttBUkKLD9g9KyHdo1rUvUSKaLjR8MFR","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","AhydLZPSumu3toZPNGLkeMEtZBkXvNGkbUwu2AaR4VQ9","5sHxK2t34SqebVpYbLrCoKj6DJ4utV2bnUcm5xsXxA9y","TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb","TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
 ["pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb","ATZQPakBrumxMrSyuEmrt6NcxBbTR1Ucs99dnPFpBUuM","Am8J8LnmuNL4nqsfH3AQNDqfuCvYrW7pYQesBdnRFcM8","8jfjkBBLFvvANqTNRRVY8W6GUNx7ZS91TVAudT92XpQE","8pPSswBqomVMQxwmFkYwSrYBG5BCxAeejDcgU1dVrHpr","2sgWhmwFVp1bfexdKD2E15EAtzeyaeiZcmpHzo93ugxn","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","9eGVwSfcYHTPT6LH5mdVuGRZGY55ZTiXS1johpxowpwU","45ZXPfD3nBVwELoS6ZgCEK2ebwYsEtRV2yCMzhhix93K","TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb","TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]
];
test("two finalized DFlow 0x59 instructions match all ten Pactum redemption account roles",()=>{
 assert.equal(fixture.cases.length,2);
 for(let i=0;i<2;i++)checkAccounts(observations[i],fixture.cases[i]);
});
test("cross-market, wrong recipient and wrong authority substitutions fail",()=>{
 const original=observations[0];
 for(const index of [2,3,4,5,7,8]){
  const forged=[...original];forged[index]=observations[1][index];
  assert.throws(()=>checkAccounts(forged,fixture.cases[0]),/layout/);
 }
 const spoofed=[...original];spoofed[9]=spl;
 assert.throws(()=>checkAccounts(spoofed,fixture.cases[0]),/layout/);
});
