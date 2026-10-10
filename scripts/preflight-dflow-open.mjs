import fs from "node:fs";

const candidateFile = process.env.DFLOW_CANDIDATES_FILE ?? "artifacts/dflow-open-market-candidates.json";
const quoteFile = process.env.DFLOW_OPEN_QUOTE_FILE;
const reportFile = process.env.DFLOW_OPEN_PREFLIGHT_OUTPUT ?? "artifacts/dflow-open-preflight.json";
const candidates = JSON.parse(fs.readFileSync(candidateFile, "utf8")).candidates ?? [];
const problems = [];
let selected = null;

if (!quoteFile) {
  problems.push("fresh_dflow_usdc_input_open_payload_missing");
} else {
  const quote = JSON.parse(fs.readFileSync(quoteFile, "utf8"));
  selected = candidates.find((x) => x.marketLedger === quote.marketLedger);
  if (!selected) problems.push("market_not_in_verified_candidates");
  const hex = quote.dataHex;
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{160}$/.test(hex)) {
    problems.push("open_payload_must_be_80_bytes_hex");
  } else {
    const data = Buffer.from(hex, "hex");
    if (data.readBigUInt64LE(0) !== 64n) problems.push("wrong_open_action");
    if (data[16] !== 89 && data[16] !== 78) problems.push("invalid_outcome_side");
    const amount = data.readBigUInt64LE(24);
    const quoted = data.readBigUInt64LE(32);
    if (amount === 0n || quoted === 0n) problems.push("non_positive_amount_or_quote");
    if (selected && quote.outcomeMint !== (data[16] === 89 ? selected.yesMint : selected.noMint)) {
      problems.push("side_mint_mismatch");
    }
    if (typeof quote.inputAmountAtoms !== "string" || quote.inputAmountAtoms !== amount.toString()) {
      problems.push("input_amount_mismatch");
    }
    if (typeof quote.quotedOutcomeAtoms !== "string" ||
        !/^[0-9]+$/.test(quote.quotedOutcomeAtoms) ||
        BigInt(quote.quotedOutcomeAtoms) > quoted) {
      problems.push("quoted_outcome_mismatch");
    }
  }
}

const report = {
  candidateCount: candidates.length,
  marketLedger: selected?.marketLedger ?? null,
  compatibleRecentOpens: candidates.reduce((sum, x) => sum + (x.matchingUsdcInputOpenExamples ?? 0), 0),
  preflightReady: problems.length === 0,
  simulationPassed: false,
  successfulOrderCreationVerified: false,
  blockers: problems,
  note: "Preflight checks only confirmed payload fields and market selection. Simulation and actual spending/recipient assertions are separate required gates.",
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (process.env.DFLOW_REQUIRE_OPEN_QUOTE === "1" && problems.length) process.exitCode = 1;
