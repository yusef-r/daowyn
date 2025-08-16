// web/src/server/snapshot/telemetry.ts
// Route/service-level latency counters with minute summaries and outlier detection.

let __minuteKey = '';
let __latencies: number[] = [];
let __staleCount = 0;
let __count = 0;

function minuteKey(ts: number) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}T${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))));
  return a[i];
}

function logMinuteSummary(now: number) {
  if (__count === 0) return;
  const p50 = Math.round(percentile(__latencies, 0.5));
  const p95 = Math.round(percentile(__latencies, 0.95));
  console.log(`[snapshot.minute] ${__minuteKey} count=${__count} p50=${p50}ms p95=${p95}ms stale=${__staleCount}`);
  __latencies = [];
  __staleCount = 0;
  __count = 0;
  __minuteKey = minuteKey(now);
}

export function recordRequestLatency(latencyMs: number, stale: boolean, now: number) {
  const mk = minuteKey(now);
  if (!__minuteKey) __minuteKey = mk;
  if (mk !== __minuteKey) {
    logMinuteSummary(now);
    __minuteKey = mk;
  }
  __latencies.push(latencyMs);
  __count += 1;
  if (stale) __staleCount += 1;
}

export function isOutlier(latencyMs: number): boolean {
  if (__latencies.length < 20) return false;
  const p95 = percentile(__latencies, 0.95);
  return latencyMs > p95;
}