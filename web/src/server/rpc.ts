// web/src/server/rpc.ts
// Singleton RPC client wrapper with per-minute telemetry aggregation,
// simple per-IP token bucket, and a provider-mount sentinel.

import { publicClient as baseClient } from '@/lib/wagmi';

export type TelemetryEvent = {
  ts: number;
  method: string;
  blockTag?: string | number;
  caller?: string;
  requestId?: string;
  ok: boolean;
};

export type MinuteSummary = {
  minute: string;
  count: number;
  byMethod: Record<string, number>;
  byCaller: Record<string, number>;
  errors: number;
};

type Bucket = { tokens: number; lastRefill: number };

const PROVIDER_SENTINEL = (() => {
  // eslint-disable-next-line no-console
  console.debug('[rpc] provider wrapper module initialized');
  return Symbol('provider_sentinel');
})();

// Expose a single public client instance (re-exported from lib/wagmi).
export const rpcClient = baseClient;

// Telemetry (in-memory, last 60 minutes)
const TELEMETRY_WINDOW_MINUTES = 60;
const telemetryEvents: TelemetryEvent[] = [];

function minuteKey(ts: number) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

export function recordTelemetry(evt: TelemetryEvent) {
  telemetryEvents.push(evt);
  const cutoff = Date.now() - TELEMETRY_WINDOW_MINUTES * 60_000;
  while (telemetryEvents.length && telemetryEvents[0].ts < cutoff) {
    telemetryEvents.shift();
  }
}

export function getMinuteSummaries(): MinuteSummary[] {
  const byMinute = new Map<string, MinuteSummary>();
  for (const e of telemetryEvents) {
    const key = minuteKey(e.ts);
    let s = byMinute.get(key);
    if (!s) {
      s = { minute: key, count: 0, byMethod: {}, byCaller: {}, errors: 0 };
      byMinute.set(key, s);
    }
    s.count += 1;
    s.byMethod[e.method] = (s.byMethod[e.method] ?? 0) + 1;
    const caller = e.caller ?? 'unknown';
    s.byCaller[caller] = (s.byCaller[caller] ?? 0) + 1;
    if (!e.ok) s.errors += 1;
  }
  return Array.from(byMinute.values()).sort((a, b) => (a.minute < b.minute ? -1 : 1));
}

class TokenBuckets {
  private buckets = new Map<string, Bucket>();
  constructor(private capacity: number, private refillPerSecond: number) {}
  take(ip: string, amount = 1): boolean {
    const now = Date.now();
    let b = this.buckets.get(ip);
    if (!b) {
      b = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(ip, b);
    }
    const elapsed = (now - b.lastRefill) / 1000;
    const refill = elapsed * this.refillPerSecond;
    b.tokens = Math.min(this.capacity, b.tokens + refill);
    b.lastRefill = now;
    if (b.tokens >= amount) {
      b.tokens -= amount;
      return true;
    }
    return false;
  }
}

// capacity 3, refill 0.5/s (~1 call every 2s sustained)
export const ipBuckets = new TokenBuckets(3, 0.5);

export function parseCaller(headers: Headers) {
  const xff = headers.get('x-forwarded-for') ?? headers.get('x-real-ip') ?? '';
  const ip = (xff.split(',')[0] || '').trim() || 'unknown';
  const requestId =
    headers.get('x-request-id') ??
    (globalThis.crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  return { ip, requestId };
}

// Normalize blockTag value for telemetry
function normBlockTag(v: unknown): string | number {
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return 'latest';
}

// Convenience wrappers to record telemetry for specific calls if needed.
export async function getBlockNumberWithTelemetry(headers: Headers) {
  const { ip, requestId } = parseCaller(headers);
  try {
    const bn = await rpcClient.getBlockNumber();
    recordTelemetry({
      ts: Date.now(),
      method: 'getBlockNumber',
      blockTag: 'latest',
      caller: ip,
      requestId,
      ok: true,
    });
    return bn;
  } catch (err) {
    recordTelemetry({
      ts: Date.now(),
      method: 'getBlockNumber',
      blockTag: 'latest',
      caller: ip,
      requestId,
      ok: false,
    });
    throw err;
  }
}

export async function multicallWithTelemetry<T>(
  headers: Headers,
  args: Parameters<typeof rpcClient.multicall>[0]
) {
  const { ip, requestId } = parseCaller(headers);
  try {
    const res = await rpcClient.multicall(args);
    recordTelemetry({
      ts: Date.now(),
      method: 'multicall',
      blockTag: normBlockTag((args as Record<string, unknown>)['blockTag']),
      caller: ip,
      requestId,
      ok: true,
    });
    return res as T;
  } catch (err) {
    recordTelemetry({
      ts: Date.now(),
      method: 'multicall',
      blockTag: normBlockTag((args as Record<string, unknown>)['blockTag']),
      caller: ip,
      requestId,
      ok: false,
    });
    throw err;
  }
}