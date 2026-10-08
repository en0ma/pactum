import fs from "node:fs";

const API = "https://api.jup.ag/prediction/v1";
const OUTPUT = process.env.JUPITER_KALSHI_REPORT ?? "artifacts/jupiter-kalshi-route.json";
const apiKey = process.env.JUPITER_API_KEY;
const report = {
  collectedAt: new Date().toISOString(),
  provider: "kalshi",
  source: "jupiter-prediction-api",
  credentialAvailable: Boolean(apiKey),
  eventsRequest: null,
  tradingStatusRequest: null,
  markets: [],
  executableOrderVerified: false,
  note: "Read-only discovery only. No order created, signed, or submitted. API availability and market listings do not prove executable Pactum PDA CPI.",
};
async function request(path) {
  try {
    const response = await fetch(API + path, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch { return { httpStatus: response.status, ok: false, error: "Non-JSON response" }; }
    if (!response.ok) {
      return { httpStatus: response.status, ok: false, error: String(payload.message ?? payload.error ?? "API error").slice(0, 180) };
    }
    return { httpStatus: response.status, ok: true, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
if (!apiKey) {
  report.note = "JUPITER_API_KEY is unavailable; no Jupiter API requests were made. Configure the secret and explicitly run this read-only probe.";
} else {
  const events = await request("/events?provider=kalshi&includeMarkets=true&start=0&end=50");
  report.eventsRequest = { ok: events.ok, httpStatus: events.httpStatus ?? null, error: events.error ?? null };
  if (events.ok) {
    const values = Array.isArray(events.payload?.data) ? events.payload.data :
      Array.isArray(events.payload?.events) ? events.payload.events : [];
    report.eventsReturned = values.length;
    for (const event of values) {
      const nested = Array.isArray(event.markets) ? event.markets : [];
      for (const market of nested) {
        if (market.provider !== "kalshi" && event.provider !== "kalshi") continue;
        report.markets.push({
          eventId: event.eventId ?? event.id ?? null,
          marketId: market.marketId ?? market.id ?? null,
          provider: market.provider ?? event.provider,
          status: market.status ?? null,
          title: market.title ?? null,
          openTime: market.openTime ?? null,
          closeTime: market.closeTime ?? null,
        });
      }
    }
  }
  // Kalshi's rolling Bitcoin 15-minute series: KXBTC15M.
  // A listed market is not automatically open or eligible for order construction.
  report.btc15m = report.markets.filter(m =>
    /KXBTC15M|BTC\\s*15\\s*MIN|BITCOIN\\s*15\\s*MIN/i.test(
      [m.marketId, m.eventId, m.title].filter(Boolean).join(" ")
    )
  );
  report.btc15mOpenCandidates = report.btc15m.filter(m =>
    /^(open|active|trading)$/i.test(String(m.status ?? ""))
  );
  const status = await request("/trading-status");
  report.tradingStatusRequest = { ok: status.ok, httpStatus: status.httpStatus ?? null, error: status.error ?? null, tradingActive: status.ok ? status.payload.trading_active ?? status.payload.data?.trading_active ?? null : null };
}
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ credentialAvailable: report.credentialAvailable, eventsRequest: report.eventsRequest, eventsReturned: report.eventsReturned ?? null, kalshiMarkets: report.markets.length, btc15mMatches: report.btc15m?.length ?? 0, btc15mOpenCandidates: report.btc15mOpenCandidates?.length ?? 0, tradingStatusRequest: report.tradingStatusRequest, output: OUTPUT }));
