export function requireRpcMetric(value, label) {
  if (value === null || value === undefined) {
    throw new Error(`RPC omitted required metric: ${label}`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`RPC returned invalid metric for ${label}: ${value}`);
  }
  return value;
}
