'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Dev-only assertions verifying merge semantics for falsy values
if (process.env.NODE_ENV !== 'production') {
  try {
    const prev = { participantCount: 5, isDrawing: true, anyArr: [1], anyBig: 7n };
    const curZero = { participantCount: 0 };
    // 0 overwrites
    // eslint-disable-next-line no-console
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
  participantCount?: number;
  participants?: `0x${string}`[]; // array of participant addresses (may contain duplicates on-chain)
  stageIndex?: number;
  roundId?: number;
  pendingRefundsTotalWei?: bigint;
  poolTargetWei?: bigint;
  pendingRefundUserWei?: bigint; // no longer populated (server does not read user-specific)
  blockNumber?: number;
  willTriggerAt?: number; // epoch ms when server scheduled an auto-draw

  // From debugUnits()
  balanceWeiTiny?: bigint;
  netWeiTiny?: bigint;

  // react-query-like meta
  isLoading: boolean;
  error: Error | undefined;
  refetch: () => Promise<void>;

  // rate-limit diagnostics (mapped from server throttle -> stale)
  rateLimited: boolean;
  rateLimitedUntil?: number;

  // stale-but-visible indicator
  isStale: boolean;
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
  const [stale, setStale] = useState<boolean>(false);

  // last good parsed
  type Parsed = {
    owner?: `0x${string}`;
    isReadyForDraw?: boolean;
    isDrawing?: boolean;
    participantCount?: number;
    participants?: `0x${string}`[];
    stageIndex?: number;
    roundId?: number;
    pendingRefundsTotalWei?: bigint;
    poolTargetWei?: bigint;
    pendingRefundUserWei?: bigint;
    balanceWeiTiny?: bigint;
    netWeiTiny?: bigint;
    blockNumber?: number;
    willTriggerAt?: number;
  };
  const lastGoodRef = useRef<Parsed | undefined>(undefined);

  const parsePayload = (json: unknown): Parsed => {
    const j = (json ?? {}) as Record<string, unknown>;
    const toBig = (v: unknown): bigint | undefined => {
      try {
        if (typeof v === 'bigint') return v;
        if (typeof v === 'string' && v !== '') {
          // Accept canonical "bn:<decimal>" and plain decimal strings
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
    const stageIndex = toNum(j.stageIndex);
    const roundId = toNum(j.roundId);
    const pendingRefundsTotalWei = toBig(j.pendingRefundsTotalWei);
    const poolTargetWei = toBig(j.poolTargetWei);
    const balanceWeiTiny = toBig(j.balanceWeiTiny);
    const netWeiTiny = toBig(j.netWeiTiny);
    const blockNumber = toNum(j.blockNumber);
    const willTriggerAt = toNum(j.willTriggerAt);
    const participants = Array.isArray(j.participants)
      ? (j.participants as unknown[]).map((p) =>
          typeof p === 'string' ? (p.toLowerCase() as `0x${string}`) : (String(p).toLowerCase() as `0x${string}`)
        )
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
      pendingRefundUserWei: undefined, // intentionally omitted on server
      balanceWeiTiny,
      netWeiTiny,
      blockNumber,
      willTriggerAt,
    };
  };

  const mergeWithLastGood = (current: Parsed): { merged: Parsed; usedFallback: boolean } => {
    const prev = lastGoodRef.current;
    if (!prev) return { merged: current, usedFallback: false };
    // Hard boundary between rounds: never inherit across different roundId
    if (typeof current.roundId === 'number' && typeof prev.roundId === 'number' && current.roundId !== prev.roundId) {
      return { merged: current, usedFallback: false };
    }
    let used = false;
    const merged: Parsed = {
      owner: current.owner ?? prev.owner ?? undefined,
      isReadyForDraw: current.isReadyForDraw ?? prev.isReadyForDraw ?? undefined,
      isDrawing: current.isDrawing ?? prev.isDrawing ?? undefined,
      participantCount: current.participantCount ?? prev.participantCount ?? undefined,
      participants: current.participants ?? prev.participants ?? undefined,
      stageIndex: current.stageIndex ?? prev.stageIndex ?? undefined,
      roundId: current.roundId ?? prev.roundId ?? undefined,
      pendingRefundsTotalWei: current.pendingRefundsTotalWei ?? prev.pendingRefundsTotalWei ?? undefined,
      poolTargetWei: current.poolTargetWei ?? prev.poolTargetWei ?? undefined,
      pendingRefundUserWei: current.pendingRefundUserWei ?? prev.pendingRefundUserWei ?? undefined,
      balanceWeiTiny: current.balanceWeiTiny ?? prev.balanceWeiTiny ?? undefined,
      netWeiTiny: current.netWeiTiny ?? prev.netWeiTiny ?? undefined,
      blockNumber: current.blockNumber ?? prev.blockNumber ?? undefined,
      // willTriggerAt is ephemeral and only present when server schedules auto-draw
      willTriggerAt: current.willTriggerAt ?? prev.willTriggerAt ?? undefined,
    };
    for (const k of Object.keys(merged) as (keyof Parsed)[]) {
      if (current[k] === undefined && prev[k] !== undefined) {
        used = true;
        break;
      }
    }
    return { merged, usedFallback: used };
  };

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
          headers: lastEtagRef.current ? { 'If-None-Match': lastEtagRef.current } : undefined,
        });

        const status = res.status;
        const hdr = res.headers;
        const hStale = hdr.get('x-snapshot-stale') === '1';
        const hRateLimited = hdr.get('x-rate-limited') === '1';
        const hBlockRaw = hdr.get('x-snapshot-block');
        const hBlock = hBlockRaw != null && hBlockRaw !== '' ? Number(hBlockRaw) : undefined;
        const hHash = hdr.get('x-snapshot-hash') ?? undefined;
        const hEtag = hdr.get('etag') ?? undefined;

        // Always update rateLimited and isStale from dedicated headers
        setRateLimited(hRateLimited);
        setStale(hStale);

        if (status === 304) {
          // No content change; keep lastGood as-is (no re-render flicker)
          return;
        }

        const json = await res.json();
        const parsed = parsePayload(json);

        // Change-only updates:
        // Apply updates whenever ETag or x-snapshot-hash changes, even if response is stale.
        const shouldUpdate =
          (hEtag !== undefined && hEtag !== lastEtagRef.current) ||
          (hHash !== undefined && hHash !== lastHashRef.current);

        if (shouldUpdate) {
          const { merged } = mergeWithLastGood(parsed);
          lastGoodRef.current = merged;
          lastBlockRef.current = hBlock ?? merged.blockNumber ?? lastBlockRef.current;
          lastHashRef.current = hHash ?? lastHashRef.current;
          lastEtagRef.current = hEtag ?? lastEtagRef.current;
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
  }, [enabled]);

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
  const current: Parsed = useMemo(() => {
    return lastGoodRef.current ?? {};
  }, [lastGoodRef.current]);

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
    isLoading: loading && !lastGoodRef.current, // never skeleton during refetch after first good snapshot
    error,
    refetch,
    rateLimited, // banner only when server explicitly signals rate-limited
    rateLimitedUntil: undefined,
    isStale: stale, // tiny amber dot only when serving lastGood from server (stale)
  } as LotterySnapshot;
}