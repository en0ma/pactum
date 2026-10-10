import fs from "node:fs";

// DFlow's documented Kalshi tokenization metadata endpoint.
// This probe discovers API-described markets; it does not prove executable orders.
const BASE = process.env.DFLOW_PREDICTION_METADATA_URL ?? "https://dev-prediction-markets-api.dflow.net";
const OUTPUT = process.env.DFLOW_KALSHI_METADATA_OUTPUT ?? "artifacts/dflow-kalshi-metadata.json";
const url = new URL("/api/v1/markets", BASE);
url.searchParams.set("status", "active");
url.searchParams.set("limit", "200");
const headers = {};
if (process.env.DFLOW_API_KEY) headers["x-api-key"] = process.env.DFLOW_API_KEY;
const report = {
  collectedAt: new Date().toISOString(),
  source: "dflow-prediction-markets-metadata-api",
  requestedStatus: "active",
  endpointHost: url.hostname,
  apiReachable: false,
  httpStatus: null,
  marketsReturned: 0,
  markets: [],
  caveat: "API-reported active does not prove a live executable USDC-input Kalshi order. An authentic /order response, provenance verification, and fork simulation are still required.",
};
try {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  report.httpStatus = response.status;
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error("Metadata API returned non-JSON response"); }
  if (!response.ok) throw new Error(`Metadata API HTTP ${response.status}: ${body?.message ?? body?.error ?? "unavailable"}`);
  report.apiReachable = true;
  if (!Array.isArray(body?.markets)) throw new Error("Metadata API returned no markets array");
  report.marketsReturned = body.markets.length;
  report.markets = body.markets.slice(0, 200).map(m => ({
    status: m.status ?? null,
    ticker: m.ticker ?? m.marketTicker ?? null,
    title: m.title ?? m.marketTitle ?? null,
    yesMint: m.yesMint ?? m.yesTokenMint ?? null,
    noMint: m.noMint ?? m.noTokenMint ?? null,
    settlementMint: m.settlementMint ?? null,
    accountKeys: m.accounts ? Object.keys(m.accounts) : [],
    fieldNames: Object.keys(m),
  }));
  report.pagination = { cursor: body.cursor ?? body.nextCursor ?? null, hasMore: Boolean(body.cursor ?? body.nextCursor) };
} catch (error) {
  report.error = error instanceof Error ? error.message.slice(0, 250) : String(error).slice(0, 250);
}
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ apiReachable: report.apiReachable, httpStatus: report.httpStatus, marketsReturned: report.marketsReturned, error: report.error ?? null, output: OUTPUT }));
