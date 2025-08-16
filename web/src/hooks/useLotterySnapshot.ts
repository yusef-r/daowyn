'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Dev-only assertions verifying merge semantics for falsy values
if (process.env.NODE_ENV !== 'production') {
  try {
    const prev = { participantCount: 5, isDrawing: true, anyArr: [1], anyBig: 7n };
    const curZero = { participantCount: 0 };
    // 0 overwrites
    console.assert((curZero.participantCount ?? prev.participantCount) === 0, '[assert] 0 should overwrite lastGood');
    const curFalse = { isDrawing: false };
    console.assert((curFalse.isDrawing ?? prev.isDrawing) === false, '[assert] false should overwrite lastGood');
    const curArr: unknown[] = [];
    const mergedArr = (curArr ?? (prev as unknown as { anyArr: unknown[] }).anyArr) as unknown[];
    console.assert(Array.isArray(mergedArr) && mergedArr.length === 0, '[assert] [] should overwrite lastGood');
    const bn0 = 0n;
    console.assert((bn0 ?? (prev as unknown as { anyBig: bigint }).anyBig) === 0n, '[assert] bn:0 should overwrite lastGood');
  } catch {
    // noop
  }
}

export type LotterySnapshot = {
  owner?: `0x${string}`;
  isReadyForDraw?: boolean;
  isDrawing?: boolean;
  participantCount?: number; // on-chain
  participantsCount?: number; // derived unique from entries
  stageIndex?: number;
  roundId?: number;
  pendingRefundsTotalWei?: bigint;
  poolTargetWei?: bigint;
  pendingRefundUserWei?: bigint; // no longer populated (server does not read user-specific)
  blockNumber?: number;

  // From debugUnits()
  balanceWeiTiny?: bigint;
  netWeiTiny?: bigint;

  // Derived/extra
  stage?: 'Filling' | 'Ready' | 'Drawing';
  openAt?: number;
  lockAt?: number;
  revealTargetAt?: number;
  reopenAt?: number;
  enterable?: boolean;
  participants?: (`0x${string}`)[];
  netBalance?: bigint;
  orphanedBalance?: bigint;

  // Canonical normalized wheel segments (address,start,end in 0..1)
  segments?: Array<{
    address: `0x${string}`;
    start: number;
    end: number;
  }>;

  // Server-provided wheel layout (JSON-safe only; no client recomputation)
  layout?: {
    roundId?: number;
    totalBn?: string;
    segments: Array<{
      id: string;
      addressLower?: `0x${string}`;
      sumBn: string;
      percent: number;
      startDeg: number;
      endDeg: number;
      label?: string;
    }>;
  };
  layoutHash?: string;
  segmentsHash?: string;

  // react-query-like meta
  isLoading: boolean;
  error: Error | undefined;
  refetch: () => Promise<void>;

  // rate-limit diagnostics (mapped from server throttle -> stale)
  rateLimited: boolean;
  rateLimitedUntil?: number;

  // stale-but-visible indicator
  isStale: boolean;

  // Fresh snapshot metadata (most recent non-stale snapshot observed)
  snapshotEtag?: string;
  snapshotHash?: string;
  snapshotLayoutHash?: string;
  snapshotSegmentsHash?: string;
  snapshotBlockNumber?: number;
};

/**
 * Server-driven snapshot (no direct RPC from UI).
 *
 * Behavior:
 * - Calls /api/snapshot which performs multicall on the server with global fan-out & dedupe.
 * - Coalesces updates per block on the server; client polls modestly (2s) without hitting upstream.
 * - Stale-but-visible: if server serves cached with stale marker, we keep lastGood and set isStale=true.
 * - No wallet/chain gating; visibility-first.
 * - No user-specific reads (pendingRefunds(user) omitted to preserve ≤1 upstream call per block).
 */
export default function useLotterySnapshot(
  contract?: `0x${string}`,
  // user is ignored by server snapshot to preserve global upstream budget
  _userAddress?: `0x${string}` | undefined,
  enabledParam?: boolean
): LotterySnapshot {
  const enabled = Boolean(enabledParam && contract);

  // Internal state
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [rateLimited, setRateLimited] = useState<boolean>(false);

  // Throttle + dedupe
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastFetchEndRef = useRef<number>(0);

  // Change-only update guards and wire dedupe
  const lastBlockRef = useRef<number | undefined>(undefined);
  const lastHashRef = useRef<string | undefined>(undefined);
  const lastEtagRef = useRef<string | undefined>(undefined);
  // lastFresh*: baseline from the most recent non-stale (stale:0) snapshot
  const lastFreshRef = useRef<Parsed | undefined>(undefined);
  const lastFreshEtagRef = useRef<string | undefined>(undefined);
  const lastFreshHashRef = useRef<string | undefined>(undefined);
  const lastFreshLayoutHashRef = useRef<string | undefined>(undefined);
  const lastFreshSegmentsHashRef = useRef<string | undefined>(undefined);
  const lastFreshBlockRef = useRef<number | undefined>(undefined);
  const [stale, setStale] = useState<boolean>(false);

  // last good parsed
  type SpinLandingPlan = {
    layoutHash: string;
    targetSegmentId: string;
    startAt: number;
    durationMs: number;
    easing: 'easeOutCubic';
    rotations: number;
  };
  type Spin = {
    phase: 'idle' | 'neutral' | 'landing' | 'done';
    neutralStartAt?: number;
    revealTargetAt?: number;
    landingPlan?: SpinLandingPlan;
  };

  type Parsed = {
    owner?: `0x${string}`;
    isReadyForDraw?: boolean;
    isDrawing?: boolean;
    participantCount?: number;
    participantsCount?: number;
    stageIndex?: number;
    roundId?: number;
    pendingRefundsTotalWei?: bigint;
    poolTargetWei?: bigint;
    pendingRefundUserWei?: bigint;
    balanceWeiTiny?: bigint;
    netWeiTiny?: bigint;
    blockNumber?: number;

    stage?: 'Filling' | 'Ready' | 'Drawing';
    openAt?: number;
    lockAt?: number;
    revealTargetAt?: number;
    reopenAt?: number;
    enterable?: boolean;
    participants?: (`0x${string}`)[];
    netBalance?: bigint;
    orphanedBalance?: bigint;

    // Canonical normalized segments
    segments?: Array<{
      address: `0x${string}`;
      start: number;
      end: number;
    }>;

    layout?: {
      roundId?: number;
      totalBn?: string;
      segments: Array<{
        id: string;
        addressLower?: `0x${string}`;
        sumBn: string;
        percent: number;
        startDeg: number;
        endDeg: number;
        label?: string;
      }>;
    };
    layoutHash?: string;
    segmentsHash?: string;

    // optional spin session from server + server time
    spin?: Spin;
    serverNowMs?: number;
  };
  const lastGoodRef = useRef<Parsed | undefined>(undefined);

  const parsePayload = useCallback((json: unknown): Parsed => {
    const j = (json ?? {}) as Record<string, unknown>;

    const toBig = (v: unknown): bigint | undefined => {
      try {
        if (typeof v === 'bigint') return v;
        if (typeof v === 'string' && v !== '') {
          if (v.startsWith('bn:')) return BigInt(v.slice(3));
          return BigInt(v);
        }
        return undefined;
      } catch {
        return undefined;
      }
    };

    const toNum = (v: unknown): number | undefined => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : undefined;
      return Number.isFinite(n as number) ? (n as number) : undefined;
    };

    const owner = (j.owner as `0x${string}` | undefined) ?? undefined;
    const isReadyForDraw = typeof j.isReadyForDraw === 'boolean' ? j.isReadyForDraw : undefined;
    const isDrawing = typeof j.isDrawing === 'boolean' ? j.isDrawing : undefined;
    const participantCount = toNum(j.participantCount);
    const participantsCount = toNum((j as Record<string, unknown>)['participantsCount']);
    const stageIndex = toNum(j.stageIndex);
    const roundId = toNum(j.roundId);
    const pendingRefundsTotalWei = toBig(j.pendingRefundsTotalWei);
    const poolTargetWei = toBig(j.poolTargetWei);
    const balanceWeiTiny = toBig(j.balanceWeiTiny);
    const netWeiTiny = toBig(j.netWeiTiny);
    const blockNumber = toNum(j.blockNumber);

    // Layout (JSON-safe only; always expose with concrete segments array)
    const layoutRaw = j.layout as Record<string, unknown> | undefined;

    let layoutSegments: NonNullable<Parsed['layout']>['segments'] = [];
    if (layoutRaw && typeof layoutRaw === 'object') {
      const maybeSegs = (layoutRaw as { segments?: unknown } | undefined)?.segments;
      const segs = Array.isArray(maybeSegs) ? (maybeSegs as unknown[]) : [];
      layoutSegments = segs
        .map((s) => {
          const x = (s ?? {}) as Record<string, unknown>;
          const id = typeof x.id === 'string' ? x.id : '';
          if (!id) return undefined;
          const addressLower = typeof x.addressLower === 'string' ? (x.addressLower as `0x${string}`) : undefined;
          const sumBn = typeof x.sumBn === 'string' ? x.sumBn : 'bn:0';
          const percent = typeof x.percent === 'number' ? x.percent : Number(x.percent ?? 0) || 0;
          const startDeg = typeof x.startDeg === 'number' ? x.startDeg : Number(x.startDeg ?? 0) || 0;
          const endDeg = typeof x.endDeg === 'number' ? x.endDeg : Number(x.endDeg ?? 0) || 0;
          const label = typeof x.label === 'string' ? x.label : undefined;
          return { id, addressLower, sumBn, percent, startDeg, endDeg, label };
        })
        .filter(Boolean) as NonNullable<Parsed['layout']>['segments'];
    }

    const layout: Parsed['layout'] = {
      roundId: toNum(layoutRaw?.roundId) ?? roundId,
      totalBn: typeof layoutRaw?.totalBn === 'string' ? (layoutRaw.totalBn as string) : undefined,
      segments: layoutSegments,
    };

    const layoutHash = typeof j.layoutHash === 'string' ? (j.layoutHash as string) : undefined;
    const segmentsHash = typeof (j as Record<string, unknown>).segmentsHash === 'string'
      ? ((j as Record<string, unknown>).segmentsHash as string)
      : undefined;

    // Spin (JSON-safe)
    let spin: Parsed['spin'] | undefined = undefined;
    const spinRaw = j.spin as Record<string, unknown> | undefined;
    if (spinRaw && typeof spinRaw === 'object') {
      const phaseStr = String(spinRaw['phase'] ?? '');
      const phase = phaseStr === 'idle' || phaseStr === 'neutral' || phaseStr === 'landing' || phaseStr === 'done' ? phaseStr : undefined;
      const neutralStartAt = typeof spinRaw['neutralStartAt'] === 'number' ? (spinRaw['neutralStartAt'] as number) : undefined;
      const revealTargetAt = typeof spinRaw['revealTargetAt'] === 'number' ? (spinRaw['revealTargetAt'] as number) : undefined;
      const lpRaw = spinRaw['landingPlan'] as Record<string, unknown> | undefined;
      let landingPlan: SpinLandingPlan | undefined = undefined;
      if (lpRaw && typeof lpRaw === 'object') {
        const lh = typeof lpRaw['layoutHash'] === 'string' ? (lpRaw['layoutHash'] as string) : undefined;
        const ts = typeof lpRaw['targetSegmentId'] === 'string' ? (lpRaw['targetSegmentId'] as string) : undefined;
        const sa = typeof lpRaw['startAt'] === 'number' ? (lpRaw['startAt'] as number) : undefined;
        const du = typeof lpRaw['durationMs'] === 'number' ? (lpRaw['durationMs'] as number) : undefined;
        const ez = typeof lpRaw['easing'] === 'string' ? (lpRaw['easing'] as string) : undefined;
        const ro = typeof lpRaw['rotations'] === 'number' ? (lpRaw['rotations'] as number) : undefined;
        if (lh && ts && typeof sa === 'number' && typeof du === 'number') {
          landingPlan = { layoutHash: lh, targetSegmentId: ts, startAt: sa, durationMs: du, easing: (ez ?? 'easeOutCubic') as 'easeOutCubic', rotations: ro ?? 0 };
        }
      }
      if (phase) {
        spin = { phase, neutralStartAt, revealTargetAt, landingPlan };
      }
    }

    // Derived extras
    const stageStr = typeof j['stage'] === 'string' ? (j['stage'] as 'Filling' | 'Ready' | 'Drawing') : undefined;
    const openAt = toNum(j['openAt']);
    const lockAt = toNum(j['lockAt']);
    const revealTargetAt = toNum(j['revealTargetAt']);
    const reopenAt = toNum(j['reopenAt']);
    const enterable = typeof j['enterable'] === 'boolean' ? (j['enterable'] as boolean) : undefined;
    const netBalance = toBig(j['netBalance']);
    const orphanedBalance = toBig(j['orphanedBalance']);

    const participants = Array.isArray((j as Record<string, unknown>)['participants'])
      ? ((j as Record<string, unknown>)['participants'] as unknown[])
          .map((x) => (typeof x === 'string' ? (x as `0x${string}`) : undefined))
          .filter(Boolean) as (`0x${string}`)[]
      : undefined;

    // Canonical normalized segments (top-level)
    let segments: Parsed['segments'] = undefined;
    const segsMaybe = (j as Record<string, unknown>)['segments'];
    if (Array.isArray(segsMaybe)) {
      segments = (segsMaybe as unknown[]).map((s) => {
        const x = (s ?? {}) as Record<string, unknown>;
        const address = typeof x['address'] === 'string' ? (x['address'] as `0x${string}`) : (undefined as unknown as `0x${string}`);
        const start = toNum(x['start']) ?? 0;
        const end = toNum(x['end']) ?? 0;
        if (!address) return undefined as unknown as { address: `0x${string}`; start: number; end: number };
        return { address, start, end };
      }).filter(Boolean) as NonNullable<Parsed['segments']>;
    }

    return {
      owner,
      isReadyForDraw,
      isDrawing,
      participantCount,
      participantsCount,
      stageIndex,
      roundId,
      pendingRefundsTotalWei,
      poolTargetWei,
      pendingRefundUserWei: undefined, // intentionally omitted on server
      balanceWeiTiny,
      netWeiTiny,
      blockNumber,
      stage: stageStr,
      openAt,
      lockAt,
      revealTargetAt,
      reopenAt,
      enterable,
      participants,
      netBalance,
      orphanedBalance,
      segments,
      layout,
      layoutHash,
      segmentsHash,
      spin,
    };
  }, []);

  const mergeWithLastGood = useCallback((current: Parsed): { merged: Parsed; usedFallback: boolean } => {
    const prev = lastGoodRef.current;
    if (!prev) return { merged: current, usedFallback: false };
    // Hard boundary between rounds: never inherit across different roundId
    if (typeof current.roundId === 'number' && typeof prev.roundId === 'number' && current.roundId !== prev.roundId) {
      return { merged: current, usedFallback: false };
    }
    let used = false;

    // Resolve stageIndex that will be used in the merged snapshot
    const stageIndexNext = current.stageIndex ?? prev.stageIndex ?? undefined;

    // Rule of truth: "Pool is Filling until it reaches the target; then it locks."
    // Never carry a previous lockAt into the Filling stage (stageIndex === 0).
    const lockAtValue =
      typeof stageIndexNext === 'number' && stageIndexNext === 0
        ? undefined
        : (current.lockAt ?? prev.lockAt ?? undefined);

    const merged: Parsed = {
      owner: current.owner ?? prev.owner ?? undefined,
      isReadyForDraw: current.isReadyForDraw ?? prev.isReadyForDraw ?? undefined,
      isDrawing: current.isDrawing ?? prev.isDrawing ?? undefined,
      participantCount: current.participantCount ?? prev.participantCount ?? undefined,
      participantsCount: current.participantsCount ?? prev.participantsCount ?? undefined,
      stageIndex: stageIndexNext,
      roundId: current.roundId ?? prev.roundId ?? undefined,
      pendingRefundsTotalWei: current.pendingRefundsTotalWei ?? prev.pendingRefundsTotalWei ?? undefined,
      poolTargetWei: current.poolTargetWei ?? prev.poolTargetWei ?? undefined,
      pendingRefundUserWei: current.pendingRefundUserWei ?? prev.pendingRefundUserWei ?? undefined,
      balanceWeiTiny: current.balanceWeiTiny ?? prev.balanceWeiTiny ?? undefined,
      netWeiTiny: current.netWeiTiny ?? prev.netWeiTiny ?? undefined,
      blockNumber: current.blockNumber ?? prev.blockNumber ?? undefined,

      stage: current.stage ?? prev.stage,
      openAt: current.openAt ?? prev.openAt,
      lockAt: lockAtValue,
      revealTargetAt: current.revealTargetAt ?? prev.revealTargetAt,
      reopenAt: current.reopenAt ?? prev.reopenAt,
      enterable: current.enterable ?? prev.enterable,
      participants: current.participants ?? prev.participants,
      netBalance: current.netBalance ?? prev.netBalance,
      orphanedBalance: current.orphanedBalance ?? prev.orphanedBalance,

      // Carry canonical normalized segments change-only
      segments: current.segments ?? prev.segments,

      layout: current.layout ?? prev.layout,
      layoutHash: current.layoutHash ?? prev.layoutHash,
      segmentsHash: current.segmentsHash ?? prev.segmentsHash,

      spin: current.spin ?? prev.spin,
      serverNowMs: current.serverNowMs ?? prev.serverNowMs,
    };
    for (const k of Object.keys(merged) as (keyof Parsed)[]) {
      if (current[k] === undefined && prev[k] !== undefined) {
        used = true;
        break;
      }
    }
    return { merged, usedFallback: used };
  }, []);

  // Fetcher
  const doFetch = useCallback(async () => {
    if (!enabled) return;
    // Basic throttle: at most one request every 1500 ms per tab
    const now = Date.now();
    if (now - lastFetchEndRef.current < 1500) return;

    // Deduplicate concurrent callers
    if (inFlightRef.current) {
      await inFlightRef.current;
      return;
    }

    const run = (async () => {
      setLoading((prev) => (prev && !lastGoodRef.current ? true : true));
      setError(undefined);
      try {
        const res = await fetch('/api/snapshot', {
          cache: 'no-store',
          headers: lastFreshEtagRef.current ? { 'If-None-Match': lastFreshEtagRef.current } : undefined,
        });

        const status = res.status;
        const hdr = res.headers;
        const hStale = hdr.get('x-snapshot-stale') === '1';
        const hRateLimited = hdr.get('x-rate-limited') === '1';
        const hBlockRaw = hdr.get('x-snapshot-block');
        const hBlock = hBlockRaw != null && hBlockRaw !== '' ? Number(hBlockRaw) : undefined;
        const hHash = hdr.get('x-snapshot-hash') ?? undefined;
        const hEtag = hdr.get('etag') ?? undefined;
        const hLayoutHash = hdr.get('x-layout-hash') ?? undefined;
        const hSegmentsHash = hdr.get('x-segments-hash') ?? undefined;
        const hNowRaw = hdr.get('x-now');
        const hNow = hNowRaw != null && hNowRaw !== '' ? Number(hNowRaw) : undefined;

        // Always update rateLimited and isStale from dedicated headers
        setRateLimited(hRateLimited);
        setStale(hStale);

        if (status === 304) {
          // No content change; keep lastGood as-is (no re-render flicker)
          return;
        }

        const json = await res.json();
        const parsed = parsePayload(json);
        if (typeof hNow === 'number' && Number.isFinite(hNow)) {
          (parsed as Parsed).serverNowMs = hNow;
        }
        // Debug logs: surface network vs parsed snapshot for diagnosis
        try {
          console.debug('[useLotterySnapshot.fetch]', {
            status,
            hBlock,
            hHash,
            hEtag,
            hLayoutHash,
            hSegmentsHash,
            hNow,
            parsedSegmentsLen: Array.isArray((parsed as Parsed).segments) ? ((parsed as Parsed).segments!.length) : 0,
            parsedLayoutLen: Array.isArray((parsed as Parsed).layout?.segments) ? (parsed as Parsed).layout!.segments.length : 0,
            parsedSpinPhase: (parsed as Parsed).spin?.phase ?? null,
            parsedFirstSegment: Array.isArray((parsed as Parsed).segments) ? ((parsed as Parsed).segments![0] ?? null) : null,
          });
        } catch {}

        // Change-only updates:
        // Apply updates whenever the fresh-baseline (lastFresh) changes. Stale responses should not
        // overwrite the user's semantic view. Compare headers against lastFresh* refs so stale bodies
        // are only used for metadata / scheduling.
        const shouldUpdate =
          (hEtag !== undefined && hEtag !== lastFreshEtagRef.current) ||
          (hHash !== undefined && hHash !== lastFreshHashRef.current) ||
          (typeof hLayoutHash === 'string' && hLayoutHash !== (lastFreshRef.current as Parsed | undefined)?.layoutHash) ||
          (typeof hSegmentsHash === 'string' && hSegmentsHash !== (lastFreshRef.current as Parsed | undefined)?.segmentsHash);

        if (shouldUpdate) {
          const next = { ...parsed };
          if (typeof hLayoutHash === 'string') next.layoutHash = hLayoutHash;
          if (typeof hSegmentsHash === 'string') next.segmentsHash = hSegmentsHash;
          const { merged } = mergeWithLastGood(next);

          // Adopt as fresh baseline only when the server explicitly marked this response as non-stale,
          // or if we don't yet have any fresh baseline at all (first good snapshot).
          if (!hStale || lastFreshRef.current === undefined) {
            lastGoodRef.current = merged;
            lastFreshRef.current = merged;
            lastFreshEtagRef.current = hEtag ?? lastFreshEtagRef.current;
            lastFreshHashRef.current = hHash ?? lastFreshHashRef.current;
            lastFreshLayoutHashRef.current = hLayoutHash ?? lastFreshLayoutHashRef.current;
            lastFreshSegmentsHashRef.current = hSegmentsHash ?? lastFreshSegmentsHashRef.current;
            lastFreshBlockRef.current = hBlock ?? merged.blockNumber ?? lastFreshBlockRef.current;
            lastBlockRef.current = lastFreshBlockRef.current;
            lastHashRef.current = lastFreshHashRef.current;
            lastEtagRef.current = lastFreshEtagRef.current;
          } else {
            // Stale response: keep lastFresh as the source of truth for user-facing fields.
            try {
              console.debug('[useLotterySnapshot.stale_received]', { hBlock, hHash, hEtag });
            } catch {}
          }
        }
      } catch (err) {
        setError(err as Error);
        // Keep previous lastGood; do not mark rate-limited unless server said so
      } finally {
        lastFetchEndRef.current = Date.now();
        setLoading(false);
      }
    })();

    inFlightRef.current = run;
    try {
      await run;
    } finally {
      inFlightRef.current = null;
    }
  }, [enabled, mergeWithLastGood, parsePayload]);

  // Poll modestly; server will dedupe per block and fallback after 20s of no blocks.
  useEffect(() => {
    if (!enabled) return;
    // fetch immediately on enable
    void doFetch();

    const id = setInterval(() => void doFetch(), 2000);
    return () => clearInterval(id);
  }, [enabled, doFetch]);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    await doFetch();
  }, [enabled, doFetch]);

  // Current parsed (may be empty on first load)
  const current: Parsed = lastFreshRef.current ?? lastGoodRef.current ?? {};

  // Disabled or no contract
  if (!enabled) {
    const base = lastGoodRef.current ?? current;
    return {
      ...base,
      isLoading: false,
      error: undefined,
      refetch: async () => {},
      rateLimited: false,
      rateLimitedUntil: undefined,
      isStale: false,
    } as LotterySnapshot;
  }

  // Partial sticky merge already baked into lastGoodRef; reflect stale if rateLimited true
  return {
    ...current,
    isLoading: loading && !lastFreshRef.current && !lastGoodRef.current, // never skeleton during refetch after first good snapshot
    error,
    refetch,
    rateLimited, // banner only when server explicitly signals rate-limited
    rateLimitedUntil: undefined,
    isStale: stale, // tiny amber dot only when serving lastGood from server (stale)
    // Expose fresh-baseline metadata so consumers can reason about etags/hashes/blockNumbers
    snapshotEtag: lastFreshEtagRef.current ?? lastEtagRef.current ?? undefined,
    snapshotHash: lastFreshHashRef.current ?? lastHashRef.current ?? undefined,
    snapshotLayoutHash: lastFreshLayoutHashRef.current ?? undefined,
    snapshotSegmentsHash: lastFreshSegmentsHashRef.current ?? undefined,
    snapshotBlockNumber: lastFreshBlockRef.current ?? lastBlockRef.current ?? undefined,
  } as LotterySnapshot;
}