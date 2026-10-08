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
  const pageSize = 50;
  const maxPages = Math.max(1, Math.min(20, Number(process.env.JUPITER_KALSHI_MAX_PAGES ?? 10)));
  const seen = new Set();
  report.pages = [];
  report.eventsReturned = 0;
  report.btc15m = [];
  for (let page = 0; page < maxPages; page++) {
    const start = page * pageSize;
    const result = await request(`/events?provider=kalshi&includeMarkets=true&start=${start}&end=${start + pageSize}`);
    const entries = result.ok
      ? (Array.isArray(result.payload?.data) ? result.payload.data :
         Array.isArray(result.payload?.events) ? result.payload.events : [])
      : [];
    report.pages.push({ start, end: start + pageSize, httpStatus: result.httpStatus ?? null,
      ok: result.ok, received: entries.length, error: result.error ?? null });
    if (page === 0) report.eventsRequest = report.pages[0];
    if (!result.ok) break;
    report.eventsReturned += entries.length;
    for (const event of entries) {
      const nested = Array.isArray(event.markets) ? event.markets : [];
      for (const market of nested) {
        if (market.provider !== "kalshi" && event.provider !== "kalshi") continue;
        const id = String(market.marketId ?? market.id ?? "");
        const eventId = String(event.eventId ?? event.id ?? "");
        const identity = eventId + ":" + id;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const record = {
          eventId, marketId: id, provider: market.provider ?? event.provider,
          status: market.status ?? null,
          title: market.title ?? event.title ?? null,
          openTime: market.openTime ?? null, closeTime: market.closeTime ?? null,
        };
        report.markets.push(record);
        // Include nested event/market identifiers, ticker and description without
        // assuming the API's title necessarily contains the Kalshi series code.
        const searchText = [eventId, id, event.title, event.ticker, event.subtitle,
          event.description, market.title, market.ticker, market.subtitle,
          market.description, market.externalId, market.kalshiTicker]
          .filter(Boolean).join(" ");
        if (/KXBTC15M|(?:BTC|BITCOIN)[\s_-]*(?:15[\s_-]*(?:M|MIN(?:UTE)?S?))/i.test(searchText)) {
          report.btc15m.push({ ...record, matchedOn: searchText.slice(0, 350) });
        }
      }
    }
    if (entries.length < pageSize) break;
  }
  report.scanComplete = report.pages.length < maxPages &&
    report.pages.at(-1)?.ok === true && report.pages.at(-1)?.received < pageSize;
  report.btc15mOpenCandidates = report.btc15m.filter(m =>
    /^(open|active|trading)$/i.test(String(m.status ?? ""))
  );
  // Compare provider-specific crypto listings, without treating Forecast
  // (bisonfi) markets as Kalshi-backed collateral.
  report.cryptoProviderComparison = {};
  for (const [name, path] of [
    ["kalshi", "/events?provider=kalshi&category=crypto&includeMarkets=true&start=0&end=50"],
    ["bisonfi15m", "/events?provider=bisonfi&category=crypto&tag=15m&includeMarkets=true&start=0&end=50"],
  ]) {
    const found = await request(path);
    const events = found.ok
      ? (Array.isArray(found.payload?.data) ? found.payload.data :
         Array.isArray(found.payload?.events) ? found.payload.events : [])
      : [];
    const marketRecords = events.flatMap(e => (e.markets ?? []).map(m => ({
      eventId: e.eventId ?? e.id ?? null,
      eventTitle: e.title ?? null,
      marketId: m.marketId ?? m.id ?? null,
      marketTitle: m.title ?? null,
      provider: m.provider ?? e.provider ?? null,
      status: m.status ?? null,
      tradable: m.tradable ?? null,
      outcomeMint: m.outcomeMint ?? null,
      closeTime: m.closeTime ?? null,
    })));
    report.cryptoProviderComparison[name] = {
      ok: found.ok, httpStatus: found.httpStatus ?? null,
      error: found.error ?? null, eventCount: events.length,
      marketCount: marketRecords.length,
      markets: marketRecords.slice(0, 50),
    };
  }
  const status = await request("/trading-status");
  report.tradingStatusRequest = { ok: status.ok, httpStatus: status.httpStatus ?? null, error: status.error ?? null, tradingActive: status.ok ? status.payload.trading_active ?? status.payload.data?.trading_active ?? null : null };
}
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ credentialAvailable: report.credentialAvailable, eventsRequest: report.eventsRequest, eventsReturned: report.eventsReturned ?? null, kalshiMarkets: report.markets.length, btc15mMatches: report.btc15m?.length ?? 0, btc15mOpenCandidates: report.btc15mOpenCandidates?.length ?? 0, pages: report.pages?.length ?? 0, scanComplete: report.scanComplete ?? false, cryptoProviderComparison: Object.fromEntries(Object.entries(report.cryptoProviderComparison ?? {}).map(([k,v]) => [k,{ok:v.ok,eventCount:v.eventCount,marketCount:v.marketCount,error:v.error}])), tradingStatusRequest: report.tradingStatusRequest, output: OUTPUT }));
