// web/src/app/api/snapshot/route.ts
// Thin route: caller parsing, rate limit, call service.buildSnapshot, set headers, 304/stale handling.

import { NextResponse } from 'next/server';
import { parseCaller, ipBuckets, recordTelemetry } from '@/server/rpc';
import { ensureKeeper } from '@/server/keeper';
import { setSnapshot } from '@/server/snapshotState';
import { buildSnapshot, shouldRebuild, __peekLastGood as __peekFromService } from '@/server/snapshot/service';
import { recordRequestLatency, isOutlier } from '@/server/snapshot/telemetry';
import type { CanonicalSnapshotJSON } from '@/server/snapshot/types';

// Start keeper loop once in this process (lazy-init when the route module loads)
ensureKeeper();

// Telemetry counters
let throttleDenialsCount = 0;
let __lastLoggedBlock: number | undefined;

// Expose counters (optional for health)
export function __getSnapshotCounters() {
  const lg = __peekFromService();
  return {
    throttleDenialsCount,
    lastGoodBlock: lg?.forBlock,
    lastBuiltAtMs: lg?.builtAtMs,
  };
}

// Expose lastGood peek via original symbol for compatibility
export function __peekLastGood() {
  return __peekFromService();
}

export async function GET(req: Request) {
  const start = Date.now();
  const { ip, requestId } = parseCaller(req.headers);
  const now = Date.now();
  const lastGood = __peekFromService();

  // If client has ETag that matches our lastGood, reply 304 immediately (no body)
  const ifNoneMatch = req.headers.get('if-none-match');
  if (lastGood && ifNoneMatch && ifNoneMatch === lastGood.etag && !shouldRebuild(now)) {
    recordRequestLatency(Date.now() - start, false, Date.now());
    try { setSnapshot({ body: lastGood.body as unknown as Record<string, unknown> }); } catch {}
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: lastGood.etag,
        'x-snapshot-block': String(lastGood.forBlock ?? ''),
        'x-snapshot-hash': lastGood.hash,
        'x-snapshot-stale': '0',
        'x-layout-hash': String(lastGood.body.layoutHash ?? ''),
        'x-segments-hash': String((lastGood.body as CanonicalSnapshotJSON).segmentsHash ?? ''),
        'x-rate-limited': '0',
        'x-request-id': requestId,
        'x-now': String(Date.now()),
      },
    });
  }

  // Quick path: serve cached latest if rebuild not needed
  if (!shouldRebuild(now) && lastGood) {
    const body = { ...(lastGood.body), isStale: false };
    const latency = Date.now() - start;
    recordRequestLatency(latency, false, Date.now());
    if (typeof lastGood.forBlock === 'number' && lastGood.forBlock !== __lastLoggedBlock) {
      console.log(`[snapshot.block] served block=${lastGood.forBlock} hash=${lastGood.hash}`);
      __lastLoggedBlock = lastGood.forBlock;
    }
    if (isOutlier(latency)) console.warn(`[snapshot.outlier] served block=${lastGood.forBlock} latency=${latency}ms`);
    try { setSnapshot({ body: lastGood.body as unknown as Record<string, unknown> }); } catch {}
    return NextResponse.json(body, {
      headers: {
        ETag: lastGood.etag,
        'x-snapshot-block': String((body as CanonicalSnapshotJSON).blockNumber ?? ''),
        'x-snapshot-hash': lastGood.hash,
        'x-snapshot-stale': '0',
        'x-layout-hash': String(lastGood.body.layoutHash ?? ''),
        'x-segments-hash': String((lastGood.body as CanonicalSnapshotJSON).segmentsHash ?? ''),
        'x-rate-limited': '0',
        'x-request-id': requestId,
        'x-now': String(Date.now()),
      },
    });
  }

  // If a rebuild would be triggered by this caller, check token bucket
  const allowTrigger = ipBuckets.take(ip, 1);
  if (!allowTrigger) {
    throttleDenialsCount += 1;
    recordTelemetry({
      ts: Date.now(),
      method: 'snapshot.stale',
      blockTag: lastGood?.forBlock ?? 'latest',
      caller: ip,
      requestId,
      ok: false,
    });
    const staleBody = { ...(lastGood?.body ?? {}), isStale: true } as CanonicalSnapshotJSON & { isStale: boolean };
    const latency = Date.now() - start;
    recordRequestLatency(latency, true, Date.now());
    console.warn(`[snapshot.rate_limited] ip=${ip} block=${lastGood?.forBlock ?? ''}`);
    try { if (lastGood) setSnapshot({ body: lastGood.body as unknown as Record<string, unknown> }); } catch {}
    return NextResponse.json(staleBody, {
      headers: {
        ETag: lastGood?.etag ?? '"stale"',
        'x-snapshot-block': String(staleBody.blockNumber ?? ''),
        'x-snapshot-hash': lastGood?.hash ?? '',
        'x-snapshot-stale': '1',
        'x-layout-hash': String(lastGood?.body.layoutHash ?? ''),
        'x-segments-hash': String(((lastGood?.body ?? {}) as CanonicalSnapshotJSON).segmentsHash ?? ''),
        'x-rate-limited': '1',
        'x-request-id': requestId,
        'x-now': String(Date.now()),
      },
    });
  }

  // Trigger build (single-flight handled in service)
  try {
    // Fire-and-forget: start the build but do not await so callers do not block.
    // Service enforces single-flight; capture background errors to avoid unhandled rejections.
    buildSnapshot(req.headers).catch((err) => {
      console.error('[snapshot.background.error]', err);
    });

    const last = __peekFromService();
    const staleBody = { ...(last?.body ?? {}), isStale: true } as CanonicalSnapshotJSON & { isStale: boolean };
    const latency = Date.now() - start;
    // Mark as stale since we're returning cached data while a build runs
    recordRequestLatency(latency, true, Date.now());
    try { if (last) setSnapshot({ body: last.body as unknown as Record<string, unknown> }); } catch {}
    return NextResponse.json(staleBody, {
      headers: {
        ETag: last?.etag ?? '"stale"',
        'x-snapshot-block': String(staleBody.blockNumber ?? ''),
        'x-snapshot-hash': last?.hash ?? '',
        'x-snapshot-stale': '1',
        'x-layout-hash': String(last?.body.layoutHash ?? ''),
        'x-segments-hash': String(((last?.body ?? {}) as CanonicalSnapshotJSON).segmentsHash ?? ''),
        'x-rate-limited': '0',
        'x-request-id': requestId,
        'x-now': String(Date.now()),
      },
    });
  } catch (e) {
    console.error('[snapshot.error]', e);
    const last = __peekFromService();
    const staleBody = { ...(last?.body ?? {}), isStale: true } as CanonicalSnapshotJSON & { isStale: boolean };
    const latency = Date.now() - start;
    recordRequestLatency(latency, true, Date.now());
    try { if (last) setSnapshot({ body: last.body as unknown as Record<string, unknown> }); } catch {}
    return NextResponse.json(staleBody, {
      headers: {
        ETag: last?.etag ?? '"stale"',
        'x-snapshot-block': String(staleBody.blockNumber ?? ''),
        'x-snapshot-hash': last?.hash ?? '',
        'x-snapshot-stale': '1',
        'x-layout-hash': String(last?.body.layoutHash ?? ''),
        'x-segments-hash': String(((last?.body ?? {}) as CanonicalSnapshotJSON).segmentsHash ?? ''),
        'x-rate-limited': '0',
        'x-request-id': requestId,
        'x-now': String(Date.now()),
      },
    });
  }
}