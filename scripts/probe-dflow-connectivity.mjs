import fs from "node:fs";
import dns from "node:dns/promises";

const output = "artifacts/dflow-network-connectivity.json";
const targets = [
  "https://dev-prediction-markets-api.dflow.net/",
  "https://prediction-markets-api.dflow.net/",
  "https://quote-api.dflow.net/",
];
const result = { checkedAt: new Date().toISOString(), readOnly: true,
  runner: { country: null, source: null, geolocationAvailable: false },
  endpoints: [] };
const withTimeout = async (url) => {
  try {
    const r = await fetch(url, { method: "GET", redirect: "manual",
      signal: AbortSignal.timeout(9000),
      headers: { "user-agent": "PactumDFlowConnectivityProbe/1.0" } });
    return { ok: true, status: r.status,
      redirect: r.status >= 300 && r.status < 400,
      // Do not expose response bodies or signed redirect URLs.
      contentType: r.headers.get("content-type") };
  } catch (error) {
    return { ok: false, errorName: error?.name ?? "Error",
      errorCode: error?.cause?.code ?? null };
  }
};
try {
  // Service returns IP; consciously discard it and retain country code only.
  const r = await fetch("https://ipapi.co/json/", { signal: AbortSignal.timeout(7000) });
  if (r.ok) {
    const data = await r.json();
    const code = typeof data.country_code === "string" ? data.country_code : null;
    if (code && /^[A-Z]{2}$/.test(code)) {
      result.runner = { country: code, source: "ipapi.co", geolocationAvailable: true };
    }
  }
} catch { /* Best effort; region detection is not required for connectivity. */ }
for (const url of targets) {
  const hostname = new URL(url).hostname;
  let dnsStatus = "ok";
  try { await dns.lookup(hostname); }
  catch (error) { dnsStatus = error?.code ?? "failed"; }
  const http = await withTimeout(url);
  result.endpoints.push({ hostname, dnsStatus, http });
}
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
