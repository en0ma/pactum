import assert from "node:assert/strict";
import test from "node:test";

import { requireRpcMetric } from "./metric-guard.mjs";

test("accepts finite non-negative metrics", () => {
  assert.equal(requireRpcMetric(0, "zero"), 0);
  assert.equal(requireRpcMetric(12_345, "cu"), 12_345);
});

test("rejects null and undefined metrics", () => {
  assert.throws(() => requireRpcMetric(null, "unitsConsumed"), /omitted required metric/);
  assert.throws(() => requireRpcMetric(undefined, "fee"), /omitted required metric/);
});

test("rejects invalid numeric metrics", () => {
  assert.throws(() => requireRpcMetric(Number.NaN, "cu"), /invalid metric/);
  assert.throws(() => requireRpcMetric(Number.POSITIVE_INFINITY, "cu"), /invalid metric/);
  assert.throws(() => requireRpcMetric(-1, "fee"), /invalid metric/);
});
