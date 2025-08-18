// web/src/app/api/snapshot/route.ts
// Server-side snapshot assembly with global fan-out, in-flight dedupe,
// per-IP token bucket, 20s no-block fallback, and content-derived stable ETag/hash.
// Canonical JSON body (JSON-safe only), canonical serializer with sorted keys,
// BigInt normalized to "bn:<decimal>", addresses lowercased.
// If hashing fails, reuse previous ETag/hash and mark stale=1 via headers.

import { NextResponse } from 'next/server';
import { LOTTERY_ABI } from '@/lib/contracts/lottery';
import { LOTTERY_ADDRESS } from '@/lib/hedera';
import { rpcClient, ipBuckets, parseCaller, recordTelemetry } from '@/server/rpc';
import { ensureAutoDraw } from '@/server/autoDraw';

// Raw snapshot from chain (not JSON-safe)
type RawSnapshot = {
  owner?: `0x${string}`;
  isReadyForDraw?: boolean;
  isDrawing?: boolean;
  participantCount?: number;
  participants?: `0x${string}`[]; // array of participant addresses (may contain duplicates on-chain)
  stageIndex?: number;
  roundId?: number;
  pendingRefundsTotalWei?: bigint;
  poolTargetWei?: bigint;
  // debugUnits
  balanceWeiTiny?: bigint;
  netWeiTiny?: bigint;
  blockNumber?: number;
};

// Canonical JSON-safe snapshot returned to clients
type CanonicalSnapshotJSON = {
  owner?: `0x${string}`; // lowercased string
  isReadyForDraw?: boolean;
  isDrawing?: boolean;
  participantCount?: number;
  participants?: string[]; // lowercased addresses
  stageIndex?: number;
  roundId?: number;
  pendingRefundsTotalWei?: string; // "bn:<decimal>"
  poolTargetWei?: string; // "bn:<decimal>"
  balanceWeiTiny?: string; // "bn:<decimal>"
  netWeiTiny?: string; // "bn:<decimal>"
  blockNumber?: number; // not part of hash
};

type BuildResult = { body: CanonicalSnapshotJSON; builtAtMs: number; forBlock?: number; hash: string; etag: string };

let lastGood: BuildResult | undefined;
let inFlight: Promise<BuildResult> | null = null;

// Hedera multicall fallback routing
const HEDERA_CHAIN_ID = 296;
let __forceFallback = (rpcClient.chain?.id === HEDERA_CHAIN_ID) || false;

// Telemetry counters
let throttleDenialsCount = 0;
function __getSnapshotCounters() {
  return {
    throttleDenialsCount,
    lastGoodBlock: lastGood?.forBlock,
    lastBuiltAtMs: lastGood?.builtAtMs
  };
}

// Stable stringify (sorted keys) for canonical hash
function stableSerialize(obj: unknown): string {
  if (obj === null) return 'null';
  const t = typeof obj;
  if (t === 'number' || t === 'boolean') return JSON.stringify(obj);
  if (t === 'string') return JSON.stringify(obj);
  if (t !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableSerialize).join(',')}]`;
  const entries = Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(',')}}`;
}

// Simple djb2 hash of canonical string
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function toBnString(v: bigint | undefined): string | undefined {
  return typeof v === 'bigint' ? `bn:${v.toString(10)}` : undefined;
}

function toCanonicalJSON(raw: RawSnapshot): CanonicalSnapshotJSON {
  return {
    owner: raw.owner ? (raw.owner.toLowerCase() as `0x${string}`) : undefined,
    isReadyForDraw: raw.isReadyForDraw,
    isDrawing: raw.isDrawing,
    participantCount: typeof raw.participantCount === 'number' ? raw.participantCount : undefined,
    participants: Array.isArray(raw.participants)
      ? (raw.participants as (`0x${string}` | string)[]).map((p) =>
          typeof p === 'string' ? p.toLowerCase() : String(p).toLowerCase()
        )
      : undefined,
    stageIndex: typeof raw.stageIndex === 'number' ? raw.stageIndex : undefined,
    roundId: typeof raw.roundId === 'number' ? raw.roundId : undefined,
    pendingRefundsTotalWei: toBnString(raw.pendingRefundsTotalWei),
    poolTargetWei: toBnString(raw.poolTargetWei),
    balanceWeiTiny: toBnString(raw.balanceWeiTiny),
    netWeiTiny: toBnString(raw.netWeiTiny),
    blockNumber: typeof raw.blockNumber === 'number' ? raw.blockNumber : undefined,
  };
}

// Exclude volatile/non-semantic fields from hash (e.g., blockNumber)
function canonicalForHash(canon: CanonicalSnapshotJSON) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { blockNumber, ...rest } = canon;
  return rest;
}

function computeHashAndEtag(canon: CanonicalSnapshotJSON): { hash: string; etag: string } {
  const canonicalString = stableSerialize(canonicalForHash(canon));
  const h = hashString(canonicalString);
  const etag = `"h:${h}"`; // strong, content-only
  return { hash: h, etag };
}

// Route-level quiet logging with minute summaries
let __minuteKey = '';
let __latencies: number[] = [];
let __staleCount = 0;
let __count = 0;
let __lastLoggedBlock: number | undefined;

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
function recordRequestLatency(latencyMs: number, stale: boolean, now: number) {
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

// Outlier detection vs current window p95
function isOutlier(latencyMs: number): boolean {
  if (__latencies.length < 20) return false;
  const p95 = percentile(__latencies, 0.95);
  return latencyMs > p95;
}

// Keep one rebuild per block; trigger fallback if >20s without a rebuild
const NO_BLOCK_FALLBACK_MS = 20_000;

// Contracts batch (no user-specific reads to preserve 1 RPC per block globally)
function contractsBatch(address: `0x${string}`) {
  const a = address as `0x${string}`;
  return [
    { address: a, abi: LOTTERY_ABI, functionName: 'owner' },
    { address: a, abi: LOTTERY_ABI, functionName: 'isReadyForDraw' },
    { address: a, abi: LOTTERY_ABI, functionName: 'isDrawing' },
    { address: a, abi: LOTTERY_ABI, functionName: 'participantCount' },
    { address: a, abi: LOTTERY_ABI, functionName: 'stage' },
    { address: a, abi: LOTTERY_ABI, functionName: 'pendingRefundsTotal' },
    { address: a, abi: LOTTERY_ABI, functionName: 'POOL_TARGET' },
    { address: a, abi: LOTTERY_ABI, functionName: 'debugUnits' },
    { address: a, abi: LOTTERY_ABI, functionName: 'getParticipants' },
    { address: a, abi: LOTTERY_ABI, functionName: 'currentRound' },
  ] as const;
}

/** Multicall result typing helpers (avoid any) */
type MCItem = { status?: 'success' | 'failure'; result?: unknown };
type MCResp = { results: MCItem[]; blockNumber?: bigint };

function isMCItem(x: unknown): x is MCItem {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return 'status' in r || 'result' in r;
}
function isMCResp(x: unknown): x is MCResp {
  if (typeof x !== 'object' || x === null) return false;
  return 'results' in (x as Record<string, unknown>);
}

function parseResult(data: MCItem[], blockNumber?: bigint): RawSnapshot {
  const get = <T,>(i: number): T | undefined => {
    const item = data?.[i];
    if (!item || item.status === 'failure') return undefined;
    return item.result as T;
  };
  const owner = get<`0x${string}`>(0);
  const isReadyForDraw = get<boolean>(1);
  const isDrawing = get<boolean>(2);
  const participantCountBig = get<bigint>(3);
  const stageRaw = get<bigint | number>(4);
  const pendingRefundsTotalWei = get<bigint>(5);
  const poolTargetWei = get<bigint>(6);
  const debug = get<[bigint, bigint, bigint, bigint, boolean]>(7);
  const participants = get<`0x${string}`[]>(8);
  const roundIdRaw = get<bigint | number>(9);

  const participantCount =
    participantCountBig !== undefined ? Number(participantCountBig) : undefined;
  const stageIndex =
    typeof stageRaw === 'bigint'
      ? Number(stageRaw)
      : typeof stageRaw === 'number'
      ? stageRaw
      : undefined;
  const roundId =
    typeof roundIdRaw === 'bigint'
      ? Number(roundIdRaw)
      : typeof roundIdRaw === 'number'
      ? roundIdRaw
      : undefined;

  return {
    owner,
    isReadyForDraw,
    isDrawing,
    participantCount,
    participants,
    stageIndex,
    roundId,
    pendingRefundsTotalWei,
    poolTargetWei,
    balanceWeiTiny: debug?.[0],
    netWeiTiny: debug?.[2],
    blockNumber: blockNumber !== undefined ? Number(blockNumber) : undefined,
  };
}

async function build(headers: Headers): Promise<BuildResult> {
  const { requestId } = parseCaller(headers);

  // Hedera-safe fallback using individual eth_call/readContract with HTTP auto-batching
  const doFallback = async (): Promise<BuildResult> => {
    const a = LOTTERY_ADDRESS as `0x${string}`;

    // Issue all requests in the same tick so viem HTTP transport batches them
    const pOwner = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'owner' });
    const pReady = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'isReadyForDraw' });
    const pDrawing = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'isDrawing' });
    const pCount = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'participantCount' });
    const pStage = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'stage' });
    const pPend = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'pendingRefundsTotal' });
    const pTarget = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'POOL_TARGET' });
    const pDebug = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'debugUnits' });
    const pParticipants = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'getParticipants' });
    const pRound = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'currentRound' });
    const pBlock = rpcClient.getBlockNumber();

    const settled = await Promise.allSettled([
      pOwner, pReady, pDrawing, pCount, pStage, pPend, pTarget, pDebug, pParticipants, pRound, pBlock
    ]);

    const results: MCItem[] = settled.slice(0, 10).map((s) =>
      s.status === 'fulfilled' ? { status: 'success', result: s.value } : { status: 'failure' }
    );

    let blockNumber: bigint | undefined = undefined;
    const bn = settled[10];
    if (bn && bn.status === 'fulfilled') {
      const v = bn.value as bigint | number;
      blockNumber = typeof v === 'bigint' ? v : BigInt(v);
    }

    recordTelemetry({
      ts: Date.now(),
      method: 'snapshot.build',
      blockTag: typeof blockNumber === 'bigint' ? Number(blockNumber) : 'latest',
      caller: 'server',
      requestId,
      ok: true,
    });

    const raw = parseResult(results, blockNumber);
    const canon = toCanonicalJSON(raw);
    const { hash, etag } = computeHashAndEtag(canon);
    const builtAtMs = Date.now();
    const forBlock = canon.blockNumber;
    return { body: canon, builtAtMs, forBlock, hash, etag };
  };

  // If we've determined multicall isn't supported for this chain, use fallback
  if (__forceFallback) {
    return doFallback();
  }

  try {
    const res = await rpcClient.multicall({
      allowFailure: true,
      contracts: contractsBatch(LOTTERY_ADDRESS as `0x${string}`),
    } as Parameters<typeof rpcClient.multicall>[0]);

    // viem multicall returns { results, blockNumber }
    const unknownRes: unknown = res;
    let results: MCItem[] = [];
    let blockNumber: bigint | undefined = undefined;

    if (isMCResp(unknownRes)) {
      const r = unknownRes as MCResp;
      results = Array.isArray(r.results) ? r.results : [];
      blockNumber = r.blockNumber;
    } else if (Array.isArray(unknownRes) && (unknownRes as unknown[]).every(isMCItem)) {
      results = unknownRes as MCItem[];
    }

    recordTelemetry({
      ts: Date.now(),
      method: 'snapshot.build',
      blockTag: typeof blockNumber === 'bigint' ? Number(blockNumber) : 'latest',
      caller: 'server',
      requestId,
      ok: true,
    });

    const raw = parseResult(results, blockNumber);
    const canon = toCanonicalJSON(raw);
    const { hash, etag } = computeHashAndEtag(canon);
    const builtAtMs = Date.now();
    const forBlock = canon.blockNumber;
    return { body: canon, builtAtMs, forBlock, hash, etag };
  } catch (err: unknown) {
    // Detect lack of multicall support and permanently route to fallback on Hedera
    const name =
      typeof err === 'object' && err !== null && 'name' in err ? String((err as { name?: unknown }).name) : '';
    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message?: unknown }).message)
        : '';

    const unsupported =
      name.includes('ChainDoesNotSupportContract') ||
      name.includes('ChainDoesNotSupport') ||
      msg.includes('ChainDoesNotSupportContract') ||
      msg.includes('Chain does not support') ||
      msg.includes('ChainDoesNotSupport') ||
      msg.toLowerCase().includes('multicall');

    if (unsupported) {
      __forceFallback = true;
      return doFallback();
    }
    throw err;
  }
}

function shouldRebuild(now: number, wantBlock?: number): boolean {
  if (!lastGood) return true;
  if (wantBlock !== undefined && lastGood.forBlock !== wantBlock) return true;
  if (now - lastGood.builtAtMs >= NO_BLOCK_FALLBACK_MS) return true;
  return false;
}

export async function GET(req: Request) {
  const start = Date.now();
  const { ip, requestId } = parseCaller(req.headers);
  const now = Date.now();

  // If client has ETag that matches our lastGood, reply 304 immediately (no body)
  const ifNoneMatch = req.headers.get('if-none-match');
  if (lastGood && ifNoneMatch && ifNoneMatch === lastGood.etag && !shouldRebuild(now)) {
    recordRequestLatency(Date.now() - start, false, Date.now());
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: lastGood.etag,
        'x-snapshot-block': String(lastGood.forBlock ?? ''),
        'x-snapshot-hash': lastGood.hash,
        'x-snapshot-stale': '0',
        'x-rate-limited': '0',
        'x-request-id': requestId,
      },
    });
  }

  // Quick path: serve cached latest if rebuild not needed
  if (!shouldRebuild(now) && lastGood) {
    const body = { ...(lastGood.body), isStale: false };
    const latency = Date.now() - start;
    recordRequestLatency(latency, false, Date.now());
    // Log once per new block only
    if (typeof lastGood.forBlock === 'number' && lastGood.forBlock !== __lastLoggedBlock) {
      console.log(`[snapshot.block] served block=${lastGood.forBlock} hash=${lastGood.hash}`);
      __lastLoggedBlock = lastGood.forBlock;
    }
    // Log outliers sparingly
    if (isOutlier(latency)) {
      console.warn(`[snapshot.outlier] served block=${lastGood.forBlock} latency=${latency}ms`);
    }

    // Schedule auto-draw if enabled (attach non-canonical field only to response)
    try {
      const stage =
        typeof body.stageIndex === 'number'
          ? body.stageIndex === 0
            ? 'Filling'
            : body.stageIndex === 1
            ? 'Ready'
            : body.stageIndex === 2
            ? 'Drawing'
            : undefined
          : undefined;
      const sched = ensureAutoDraw({ roundId: body.roundId, stage, isReadyForDraw: body.isReadyForDraw });
      if (sched?.willTriggerAt) {
        (body as Record<string, unknown>).willTriggerAt = sched.willTriggerAt;
      }
    } catch (err) {
      console.error('[snapshot.autoDraw] ensureAutoDraw error', err);
    }

    return NextResponse.json(body, {
      headers: {
        ETag: lastGood.etag,
        'x-snapshot-block': String(body.blockNumber ?? ''),
        'x-snapshot-hash': lastGood.hash,
        'x-snapshot-stale': '0',
        'x-rate-limited': '0',
        'x-request-id': requestId,
      },
    });
  }

  // If a rebuild would be triggered by this caller, check token bucket
  const allowTrigger = ipBuckets.take(ip, 1);
  if (!allowTrigger) {
    // Telemetry record for throttle denial
    throttleDenialsCount += 1;
    recordTelemetry({
      ts: Date.now(),
      method: 'snapshot.stale',
      blockTag: lastGood?.forBlock ?? 'latest',
      caller: ip,
      requestId,
      ok: false,
    });
    // Serve lastGood with stale marker when throttle exhausted
    const staleBody = {
      ...(lastGood?.body ?? {}),
      isStale: true,
    } as CanonicalSnapshotJSON & { isStale: boolean };
    const latency = Date.now() - start;
    recordRequestLatency(latency, true, Date.now());
    // Explicit rate-limit log (sparse)
    console.warn(`[snapshot.rate_limited] ip=${ip} block=${lastGood?.forBlock ?? ''}`);

    // Schedule auto-draw based on staleBody if applicable (non-canonical)
    try {
      const stage =
        typeof staleBody.stageIndex === 'number'
          ? staleBody.stageIndex === 0
            ? 'Filling'
            : staleBody.stageIndex === 1
            ? 'Ready'
            : staleBody.stageIndex === 2
            ? 'Drawing'
            : undefined
          : undefined;
      const sched = ensureAutoDraw({ roundId: staleBody.roundId, stage, isReadyForDraw: staleBody.isReadyForDraw });
      if (sched?.willTriggerAt) {
        (staleBody as Record<string, unknown>).willTriggerAt = sched.willTriggerAt;
      }
    } catch (err) {
      console.error('[snapshot.autoDraw] ensureAutoDraw error', err);
    }

    return NextResponse.json(staleBody, {
      headers: {
        ETag: lastGood?.etag ?? '"stale"',
        'x-snapshot-block': String(staleBody.blockNumber ?? ''),
        'x-snapshot-hash': lastGood?.hash ?? '',
        'x-snapshot-stale': '1',
        'x-rate-limited': '1',
        'x-request-id': requestId,
      },
    });
  }

  // Trigger build with in-flight dedupe
  inFlight = build(req.headers)
    .then((b) => {
      lastGood = b;
      return b;
    })
    .finally(() => {
      inFlight = null;
    });

  try {
    const built = await inFlight;
    const body = { ...built.body, isStale: false } as CanonicalSnapshotJSON & { isStale: boolean };
    const latency = Date.now() - start;
    recordRequestLatency(latency, false, Date.now());
    // Log once for new block
    if (typeof built.forBlock === 'number' && built.forBlock !== __lastLoggedBlock) {
      console.log(`[snapshot.block] built block=${built.forBlock} hash=${built.hash} latency=${latency}ms`);
      __lastLoggedBlock = built.forBlock;
    }
    // Outlier log
    if (isOutlier(latency)) {
      console.warn(`[snapshot.outlier] built block=${built.forBlock} latency=${latency}ms`);
    }

    // Schedule auto-draw for freshly built snapshot (non-canonical)
    try {
      const stage =
        typeof body.stageIndex === 'number'
          ? body.stageIndex === 0
            ? 'Filling'
            : body.stageIndex === 1
            ? 'Ready'
            : body.stageIndex === 2
            ? 'Drawing'
            : undefined
          : undefined;
      const sched = ensureAutoDraw({ roundId: body.roundId, stage, isReadyForDraw: body.isReadyForDraw });
      if (sched?.willTriggerAt) {
        (body as Record<string, unknown>).willTriggerAt = sched.willTriggerAt;
      }
    } catch (err) {
      console.error('[snapshot.autoDraw] ensureAutoDraw error', err);
    }

    return NextResponse.json(body, {
      headers: {
        ETag: built.etag,
        'x-snapshot-block': String(body.blockNumber ?? ''),
        'x-snapshot-hash': built.hash,
        'x-snapshot-stale': '0',
        'x-rate-limited': '0',
        'x-request-id': requestId,
      },
    });
  } catch (e) {
    // error log
    console.error('[snapshot.error]', e);
    // Serve stale on error; reuse previous ETag/hash, and never emit a time-based hash
    const staleBody = {
      ...(lastGood?.body ?? {}),
      isStale: true,
    } as CanonicalSnapshotJSON & { isStale: boolean };
    const latency = Date.now() - start;
    recordRequestLatency(latency, true, Date.now());

    // Schedule auto-draw for stale fallback if applicable (non-canonical)
    try {
      const stage =
        typeof staleBody.stageIndex === 'number'
          ? staleBody.stageIndex === 0
            ? 'Filling'
            : staleBody.stageIndex === 1
            ? 'Ready'
            : staleBody.stageIndex === 2
            ? 'Drawing'
            : undefined
          : undefined;
      const sched = ensureAutoDraw({ roundId: staleBody.roundId, stage, isReadyForDraw: staleBody.isReadyForDraw });
      if (sched?.willTriggerAt) {
        (staleBody as Record<string, unknown>).willTriggerAt = sched.willTriggerAt;
      }
    } catch (err) {
      console.error('[snapshot.autoDraw] ensureAutoDraw error', err);
    }

    return NextResponse.json(staleBody, {
      headers: {
        ETag: lastGood?.etag ?? '"stale"',
        'x-snapshot-block': String(staleBody.blockNumber ?? ''),
        'x-snapshot-hash': lastGood?.hash ?? '',
        'x-snapshot-stale': '1',
        'x-rate-limited': '0',
        'x-request-id': requestId,
      },
    });
  }
}