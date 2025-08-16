// web/src/server/snapshot/service.ts
// Orchestration and I/O for snapshot building. Maintains single-flight and lastGood.

import { LOTTERY_ABI, LOTTERY_ADDRESS } from '@/lib/contracts/lottery';
import { validateConfig } from '@/lib/config';
import { rpcClient, recordTelemetry, parseCaller } from '@/server/rpc';
import { getContractLogsWindowed, mapMirrorLogToEntry, getLatestBlockTimestampTo, lastContractLogsPathUsed } from '@/lib/mirror';
import {
  CanonicalSnapshotJSON,
  RawSnapshot,
  BuildResult,
  MCItem,
  MCResp,
  SpinSession,
} from '@/server/snapshot/types';
import {
  toCanonicalJSON,
  computeEtagFromCanon,
  computeSnapshotHash,
  toBnStringStrict,
  layoutHash as layoutHashFn,
  segmentsHash as segmentsHashFn,
  segmentsHashCanonical as segmentsHashCanonFn,
} from '@/server/snapshot/hash';
import {
  buildSegments,
  buildCanonicalSegments,
  computeEnterable,
  freezeLayout,
  nextSpinSession,
} from '@/server/snapshot/compute';
import { keccak256, toBytes } from 'viem';

// Single-flight and caching
let lastGood: BuildResult | undefined;
let inFlight: Promise<BuildResult> | null = null;

// Config guard: ensure address sources aligned and log env consumers
try { validateConfig(); } catch (e) { console.error('[config.error]', e); throw e; }

const NO_BLOCK_FALLBACK_MS = 20_000;

// Hedera multicall fallback routing
const HEDERA_CHAIN_ID = 296;
let __forceFallback = (rpcClient.chain?.id === HEDERA_CHAIN_ID) || false;

// Multicall helpers
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
    { address: a, abi: LOTTERY_ABI, functionName: 'roundId' },
  ] as const;
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
  const roundIdRaw = get<bigint | number>(8);

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
    stageIndex,
    roundId,
    pendingRefundsTotalWei,
    poolTargetWei,
    balanceWeiTiny: debug?.[0],
    netWeiTiny: debug?.[2],
    blockNumber: blockNumber !== undefined ? Number(blockNumber) : undefined,
  };
}

// Reveal timing (ms)
const DEFAULT_REVEAL_MS = Number(process.env.NEXT_PUBLIC_WHEEL_REVEAL_MS ?? process.env.WHEEL_REVEAL_MS ?? 10_000);

// Per-round spin sessions (in-memory, service-scoped)
const spinSessions = new Map<number, SpinSession>();

// Layout freeze per round (service-scoped)
let frozenLayout: {
  roundId: number;
  layout: NonNullable<CanonicalSnapshotJSON['layout']>;
  layoutHash: string;
  canonSegments?: NonNullable<CanonicalSnapshotJSON['segments']>;
  canonSegmentsHash?: string;
} | null = null;

// Mirror-driven layout/participants computation (I/O + math assembly)
async function fetchAndComputeLayout(roundId?: number, stageIndex?: number): Promise<{
  layout?: CanonicalSnapshotJSON['layout'];
  layoutHash?: string;
  layoutSegmentsHash?: string;
  canonSegments?: NonNullable<CanonicalSnapshotJSON['segments']>;
  canonSegmentsHash?: string;
  participants?: (`0x${string}`)[];
  participantsCount?: number;
  total?: bigint;
  lastWinner?: { timestamp: number; winner: `0x${string}` } | undefined;
  lockTs?: number | undefined;
  entriesCount?: number;
  // diagnostics for guardrail logging at caller
  diagStartTs?: number;
  diagEndTs?: number;
  diagTopic0?: `0x${string}`;
  diagTopic1?: `0x${string}`;
}> {
  if (typeof roundId !== 'number') return {};
  if (!LOTTERY_ADDRESS) return {};

  // If frozen for this round, return it (also surface previously captured canonical segments/hash)
  if (frozenLayout && frozenLayout.roundId === roundId) {
    const segsLayout = frozenLayout.layout.segments ?? [];
    const segHashLayout = segmentsHashFn(segsLayout);
    return {
      layout: frozenLayout.layout,
      layoutHash: frozenLayout.layoutHash,
      layoutSegmentsHash: segHashLayout,
      canonSegments: frozenLayout.canonSegments,
      canonSegmentsHash: frozenLayout.canonSegmentsHash,
    };
  }

  // Diagnostics and windowed log resolution for entries[] using exact ABI topics
  // 1) Derive exact event signatures and topics from ABI
  const getEvent = (name: string) =>
    (LOTTERY_ABI as unknown as Array<{ type: string; name?: string; inputs?: Array<{ name?: string; type: string; indexed?: boolean }> }>)
      .find((x) => x.type === 'event' && x.name === name);
 
  const topicForEvent = (name: string): `0x${string}` => {
    const ev = getEvent(name);
    if (!ev || !ev.inputs) throw new Error(`ABI event not found: ${name}`);
    const sig = `${name}(${ev.inputs.map((i) => i.type).join(',')})`;
    return keccak256(toBytes(sig)) as `0x${string}`;
  };
 
  const enteredTopic0 = topicForEvent('EnteredPool');
  const winnerTopic0 = topicForEvent('WinnerPicked');
  const filledTopic0 = topicForEvent('PoolFilled');
  const resetTopic0 = topicForEvent('RoundReset'); // used to anchor scans to the current round when available

  // 2) Compute scan bounds
  const latestToTs = await getLatestBlockTimestampTo();
  const endTsMs = typeof latestToTs === 'number' ? latestToTs : Date.now();
 
  // Use a bounded "round lookback" to avoid scanning arbitrarily far into history.
  // Default to 24h (DAY_MS) but allow override via NEXT_PUBLIC_SNAPSHOT_ROUND_LOOKBACK_MS or SNAPSHOT_ROUND_LOOKBACK_MS.
  const DAY_MS = 86_400_000;
  const SEVEN_DAYS_MS = 7 * DAY_MS;
  const ROUND_LOOKBACK_MS = Number(process.env.NEXT_PUBLIC_SNAPSHOT_ROUND_LOOKBACK_MS ?? process.env.SNAPSHOT_ROUND_LOOKBACK_MS ?? DAY_MS);
 
  // Candidate lower bound for searches (do not look earlier than this unless fallback required)
  let sinceTsMs = Math.max(0, endTsMs - ROUND_LOOKBACK_MS);
 
  // 1) Try to anchor to a RoundReset event within the recent lookback window (fast path to bound scans to current round)
  try {
    const resetLogs = await getContractLogsWindowed({
      contract: LOTTERY_ADDRESS as string,
      topic0: resetTopic0,
      startMs: sinceTsMs,
      endMs: endTsMs,
      stepMs: DAY_MS,
      order: 'desc',
    });
    if (Array.isArray(resetLogs) && resetLogs.length > 0) {
      let best = -1;
      for (const rl of resetLogs as Array<Record<string, unknown>>) {
        const tsStr = typeof rl?.consensus_timestamp === 'string' ? (rl.consensus_timestamp as string) : '';
        if (!tsStr) continue;
        const [secs, nanosRaw] = tsStr.split('.');
        const secsNum = Number(secs || '0');
        const nanos = String(nanosRaw || '0').padEnd(9, '0');
        const nsNum = Number(nanos);
        const ts = secsNum * 1000 + Math.floor(nsNum / 1_000_000);
        if (ts > best) best = ts;
      }
      if (best >= 0) {
        sinceTsMs = Math.max(0, best);
        try { console.log('[snapshot.diag.round_anchor]', { foundLastReset: true, lastReset: sinceTsMs }); } catch {}
      }
    }
  } catch {
    // ignore errors from the round-reset lookup and fall back to winner-based anchoring
  }
 
  // 2) If no round-reset anchor, attempt to find the most recent WinnerPicked within the bounded lookback window
  const winnerStartMs = sinceTsMs;
  let lastWinner: { timestamp: number; winner: `0x${string}` } | undefined;
  let winnerPickedCount = 0;
  try {
    const winnerLogs = await getContractLogsWindowed({
      contract: LOTTERY_ADDRESS as string,
      topic0: winnerTopic0,
      startMs: winnerStartMs,
      endMs: endTsMs,
      stepMs: DAY_MS,
      order: 'desc',
    });
    winnerPickedCount = Array.isArray(winnerLogs) ? winnerLogs.length : 0;
    if (winnerPickedCount > 0) {
      let bestTs = -1;
      let bestWinner: `0x${string}` | undefined;
      const addrFromTopic = (t?: string): `0x${string}` | undefined => {
        if (!t) return undefined;
        const s = t.startsWith('0x') ? t : `0x${t}`;
        const cand = `0x${s.slice(-40)}`;
        return /^0x[a-fA-F0-9]{40}$/.test(cand) ? (cand as `0x${string}`) : undefined;
      };
      for (const wl of winnerLogs as Array<Record<string, unknown>>) {
        const tsStr = typeof wl?.consensus_timestamp === 'string' ? (wl.consensus_timestamp as string) : '';
        let ts = -1;
        if (tsStr) {
          const [secs, nanosRaw] = tsStr.split('.');
          const secsNum = Number(secs || '0');
          const nanos = String(nanosRaw || '0').padEnd(9, '0');
          const nsNum = Number(nanos);
          ts = secsNum * 1000 + Math.floor(nsNum / 1_000_000);
        }
        if (ts > bestTs) {
          bestTs = ts;
          const wlObj = wl as Record<string, unknown>;
          const topicsArr = wlObj['topics'] as string[] | undefined;
          const t1 = (wlObj['topic1'] as string | undefined) ?? (Array.isArray(topicsArr) ? topicsArr[1] : undefined);
          bestWinner = addrFromTopic(t1);
        }
      }
      if (bestTs >= 0) {
        // Winner address may be undefined on some Mirror payloads; timestamp anchor is what we need
        lastWinner = { timestamp: bestTs, winner: (bestWinner ?? '0x0000000000000000000000000000000000000000') as `0x${string}` };
      }
    }
  } catch {
    // ignore
  }

  // Anchor with a 10-minute overlap before lastWinner to avoid boundary truncation
  if (typeof lastWinner?.timestamp === 'number') {
    sinceTsMs = Math.max(0, lastWinner.timestamp - 10 * 60 * 1000);
  } else {
    sinceTsMs = Math.max(0, endTsMs - DAY_MS);
  }
  if (endTsMs <= sinceTsMs) sinceTsMs = endTsMs - 60_000;

  // Window diagnostics in consensus format
  try {
    const toCons = (ms: number) => {
      const secs = Math.floor(ms / 1000);
      const ns = (ms - secs * 1000) * 1_000_000;
      return `${secs}.${String(ns).padStart(9, '0')}`;
    };
    console.log('[snapshot.diag.window]', {
      from: `gte:${toCons(sinceTsMs)}`,
      to: `lt:${toCons(endTsMs)}`,
      overlapMs: typeof lastWinner?.timestamp === 'number' ? 10 * 60 * 1000 : 0,
    });
  } catch {}

  // Explicit diagnostics for window anchoring to validate suspicion of too-narrow window
  try {
    console.log('[snapshot.diag.lastWinner]', {
      foundLastWinner: Boolean(lastWinner),
      lastWinnerTs: typeof lastWinner?.timestamp === 'number' ? lastWinner!.timestamp : null,
      sinceTs: sinceTsMs,
      winnerPickedCount,
    });
  } catch {}

  // 3) Fetch EnteredPool using windowed calls
  let rawA = await getContractLogsWindowed({
    contract: LOTTERY_ADDRESS as string,
    topic0: enteredTopic0,
    startMs: sinceTsMs,
    endMs: endTsMs,
    stepMs: DAY_MS,
    order: 'asc',
  });

  // Diagnostic: compare EnteredPool counts for alt env address (if present)
  const __altEnv = (process.env.NEXT_PUBLIC_LOTTERY_ADDRESS ?? '').toLowerCase();
  const __altIsHex = /^0x[a-fA-F0-9]{40}$/.test(__altEnv);
  let __altRawCount: number | null = null;
  let __altDecodedCount: number | null = null;
  if (__altIsHex && __altEnv !== String(LOTTERY_ADDRESS).toLowerCase()) {
    try {
      const rawAlt = await getContractLogsWindowed({
        contract: __altEnv,
        topic0: enteredTopic0,
        startMs: sinceTsMs,
        endMs: endTsMs,
        stepMs: DAY_MS,
        order: 'asc',
      });
      __altRawCount = Array.isArray(rawAlt) ? rawAlt.length : 0;
      const decodedAlt = rawAlt
        .map((l) => mapMirrorLogToEntry(l))
        .filter((e): e is NonNullable<ReturnType<typeof mapMirrorLogToEntry>> => Boolean(e))
        .filter((e) => String(e.type).toLowerCase() === 'enteredpool')
        .filter((e) => (e.timestamp ?? 0) >= sinceTsMs);
      __altDecodedCount = decodedAlt.length;
    } catch {
      __altRawCount = -1;
      __altDecodedCount = -1;
    }
  }
  console.log('[snapshot.diag.addresses]', {
    fromContracts: String(LOTTERY_ADDRESS ?? ''),
    fromEnvContract: String(process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? ''),
    fromEnvLottery: String(process.env.NEXT_PUBLIC_LOTTERY_ADDRESS ?? ''),
  });
  console.log('[snapshot.diag.entered_compare]', {
    addr: String(LOTTERY_ADDRESS ?? ''),
    rawA: Array.isArray(rawA) ? rawA.length : 0,
    
    altAddr: __altIsHex ? __altEnv : null,
    altRawA: __altRawCount,
    altDecodedA: __altDecodedCount,
    windowStartMs: sinceTsMs,
    windowEndMs: endTsMs,
  });

  // Initial decode for EnteredPool events in the computed window
  let decodedA = rawA
    .map((l) => mapMirrorLogToEntry(l))
    .filter((e): e is NonNullable<ReturnType<typeof mapMirrorLogToEntry>> => Boolean(e))
    .filter((e) => String(e.type).toLowerCase() === 'enteredpool')
    .filter((e) => {
      const ts = e.timestamp ?? 0;
      // If we found a lastWinner, exclude entries at or before that exact timestamp to avoid boundary issues.
      return typeof lastWinner?.timestamp === 'number' ? ts > lastWinner.timestamp : ts >= sinceTsMs;
    });

  // Fallback strategy: if no decoded entries, widen window to 24h, then 7d.
  if (decodedA.length === 0) {
    try {
      const fallbackStart24 = Math.max(0, endTsMs - DAY_MS);
      const rawB = await getContractLogsWindowed({
        contract: LOTTERY_ADDRESS as string,
        topic0: enteredTopic0,
        startMs: fallbackStart24,
        endMs: endTsMs,
        stepMs: DAY_MS,
        order: 'asc',
      });
      const decodedB = rawB
        .map((l) => mapMirrorLogToEntry(l))
        .filter((e): e is NonNullable<ReturnType<typeof mapMirrorLogToEntry>> => Boolean(e))
        .filter((e) => String(e.type).toLowerCase() === 'enteredpool')
        .filter((e) => {
          const ts = e.timestamp ?? 0;
          return typeof lastWinner?.timestamp === 'number' ? ts > lastWinner.timestamp : ts >= fallbackStart24;
        });

      if (decodedB.length > 0) {
        console.warn('[snapshot.fallback.window.entered]', {
          span: '24h',
          startMs: fallbackStart24,
          endMs: endTsMs,
          decoded: decodedB.length,
        });
        rawA = rawB;
        decodedA = decodedB;
        sinceTsMs = fallbackStart24;
      } else {
        const fallbackStart7d = Math.max(0, endTsMs - SEVEN_DAYS_MS);
        const rawC = await getContractLogsWindowed({
          contract: LOTTERY_ADDRESS as string,
          topic0: enteredTopic0,
          startMs: fallbackStart7d,
          endMs: endTsMs,
          stepMs: DAY_MS,
          order: 'asc',
        });
        const decodedC = rawC
          .map((l) => mapMirrorLogToEntry(l))
          .filter((e): e is NonNullable<ReturnType<typeof mapMirrorLogToEntry>> => Boolean(e))
          .filter((e) => String(e.type).toLowerCase() === 'enteredpool')
          .filter((e) => {
            const ts = e.timestamp ?? 0;
            return typeof lastWinner?.timestamp === 'number' ? ts > lastWinner.timestamp : ts >= fallbackStart7d;
          });

        if (decodedC.length > 0) {
          console.warn('[snapshot.fallback.window.entered]', {
            span: '7d',
            startMs: fallbackStart7d,
            endMs: endTsMs,
            decoded: decodedC.length,
          });
          rawA = rawC;
          decodedA = decodedC;
          sinceTsMs = fallbackStart7d;
        } else {
          console.log('[snapshot.fallback.window.entered]', {
            span: 'none_found',
            tried: ['24h', '7d'],
            endMs: endTsMs,
          });
        }
      }
    } catch (e) {
      console.warn('[snapshot.fallback.window.error]', { message: (e as Error)?.message ?? String(e) });
    }
  }
 
  // Secondary broad fallback: drop topic filter and filter client-side (24h then 7d)
  if (decodedA.length === 0) {
    try {
      // 24h broad fetch (no topic)
      const broadStart24 = Math.max(0, endTsMs - DAY_MS);
      const rawBroad24 = await getContractLogsWindowed({
        contract: LOTTERY_ADDRESS as string,
        startMs: broadStart24,
        endMs: endTsMs,
        stepMs: DAY_MS,
        order: 'asc',
      });
      const decBroad24 = rawBroad24
        .map((l) => mapMirrorLogToEntry(l))
        .filter((e): e is NonNullable<ReturnType<typeof mapMirrorLogToEntry>> => Boolean(e))
        .filter((e) => String(e.type).toLowerCase() === 'enteredpool')
        .filter((e) => {
          const ts = e.timestamp ?? 0;
          return typeof lastWinner?.timestamp === 'number' ? ts > lastWinner.timestamp : ts >= broadStart24;
        });
      if (decBroad24.length > 0) {
        console.warn('[snapshot.fallback.window.entered_broad]', {
          span: '24h',
          startMs: broadStart24,
          endMs: endTsMs,
          decoded: decBroad24.length,
        });
        rawA = rawBroad24;
        decodedA = decBroad24;
        sinceTsMs = broadStart24;
      } else {
        // 7d broad fetch (no topic)
        const broadStart7d = Math.max(0, endTsMs - SEVEN_DAYS_MS);
        const rawBroad7 = await getContractLogsWindowed({
          contract: LOTTERY_ADDRESS as string,
          startMs: broadStart7d,
          endMs: endTsMs,
          stepMs: DAY_MS,
          order: 'asc',
        });
        const decBroad7 = rawBroad7
          .map((l) => mapMirrorLogToEntry(l))
          .filter((e): e is NonNullable<ReturnType<typeof mapMirrorLogToEntry>> => Boolean(e))
          .filter((e) => String(e.type).toLowerCase() === 'enteredpool')
          .filter((e) => {
            const ts = e.timestamp ?? 0;
            return typeof lastWinner?.timestamp === 'number' ? ts > lastWinner.timestamp : ts >= broadStart7d;
          });
        if (decBroad7.length > 0) {
          console.warn('[snapshot.fallback.window.entered_broad]', {
            span: '7d',
            startMs: broadStart7d,
            endMs: endTsMs,
            decoded: decBroad7.length,
          });
          rawA = rawBroad7;
          decodedA = decBroad7;
          sinceTsMs = broadStart7d;
        } else {
          console.log('[snapshot.fallback.window.entered_broad]', {
            span: 'none_found',
            tried: ['24h', '7d'],
            endMs: endTsMs,
          });
        }
      }
    } catch (e) {
      console.warn('[snapshot.fallback.window.error_broad]', { message: (e as Error)?.message ?? String(e) });
    }
  }
 
  // Lock moment: first PoolFilled after sinceTsMs
  try {
    const toCons = (ms: number) => {
      const secs = Math.floor(ms / 1000);
      const ns = (ms - secs * 1000) * 1_000_000;
      return `${secs}.${String(ns).padStart(9, '0')}`;
    };
    console.log('[snapshot.diag.final_window]', {
      sinceTsMs,
      sinceConsensus: toCons(sinceTsMs),
      untilConsensus: toCons(endTsMs),
      pathUsed: typeof lastContractLogsPathUsed === 'string' ? lastContractLogsPathUsed : null,
    });
  } catch {}
  let lockTsMs = 0;
  try {
    const filledLogs = await getContractLogsWindowed({
      contract: LOTTERY_ADDRESS as string,
      topic0: filledTopic0,
      startMs: Math.max(0, sinceTsMs + 1),
      endMs: endTsMs,
      stepMs: DAY_MS,
      order: 'asc',
    });
    let best = Number.POSITIVE_INFINITY;
    for (const fl of filledLogs) {
      const fe = mapMirrorLogToEntry(fl);
      if (fe?.timestamp && fe.timestamp >= sinceTsMs + 1 && fe.timestamp < best) {
        best = fe.timestamp;
      }
    }
    if (Number.isFinite(best)) lockTsMs = best;
  } catch {
    // ignore
  }

  // Diagnostics report (once per build)
  console.log('[snapshot.diag.logs]', {
    addr: LOTTERY_ADDRESS,
    roundId,
    startTs: sinceTsMs,
    endTs: endTsMs,
    stepMs: DAY_MS,
    rawA: rawA.length,
    
  });

  // Aggregate entries
  const sums = new Map<string, bigint>();
  let entriesCount = 0;
  for (const e of decodedA) {
    const addr = (e.participant ?? '').toLowerCase();
    if (!addr) continue;
    const amt = e.amount;
    let inc = 0n;
    if (typeof amt === 'bigint') inc = amt;
    else if (typeof amt === 'number') inc = BigInt(Math.trunc(amt));
    if (inc <= 0n) continue;
    const prev = sums.get(addr) ?? 0n;
    sums.set(addr, prev + inc);
    entriesCount += 1;
  }

  // Build initial participants from decoded sums
  const participantsSet = new Set<string>(Array.from(sums.keys()));
  let participants = Array.from(participantsSet) as (`0x${string}`)[];
  const entriesArr = Array.from(sums.entries());

  // Optional on-chain backfill: if chain participantCount > decoded set, enumerate participants[i]
  try {
    const a = LOTTERY_ADDRESS as `0x${string}`;
    const ocRaw = await rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'participantCount' }) as bigint | number;
    const onChainCount = typeof ocRaw === 'bigint' ? Number(ocRaw) : Number(ocRaw ?? 0);
    const decodedEntriesCount = sums.size;
    let backfillRan = false;
    let added = 0;
    let addedToSums = 0;

    // Log want/have for on-chain backfill decision
    try {
      console.log('[snapshot.onchain_backfill]', { want: onChainCount, have: decodedEntriesCount });
    } catch {}

    if (Number.isFinite(onChainCount) && onChainCount > participants.length && onChainCount < 10000) {
      const calls = Array.from({ length: onChainCount }, (_, i) => ({
        address: a,
        abi: LOTTERY_ABI,
        functionName: 'participants' as const,
        args: [BigInt(i)],
      }));
      // Type-safe parse for viem multicall which may return either an array or { results, blockNumber }
      const unknownRes: unknown = await rpcClient.multicall(
        { allowFailure: true, contracts: calls } as Parameters<typeof rpcClient.multicall>[0]
      );

      const resultsArray: Array<{ status: 'success' | 'failure'; result?: unknown }> =
        (typeof unknownRes === 'object' && unknownRes !== null && 'results' in (unknownRes as Record<string, unknown>))
          ? (((unknownRes as { results?: Array<{ status: 'success' | 'failure'; result?: unknown }> }).results) ?? [])
          : (Array.isArray(unknownRes)
              ? (unknownRes as Array<{ status: 'success' | 'failure'; result?: unknown }>)
              : []);

      for (const r of resultsArray) {
        if (r && r.status === 'success' && typeof r.result === 'string') {
          const addr = (r.result as string).toLowerCase();
          if (addr && !participantsSet.has(addr)) {
            participantsSet.add(addr);
            added += 1;
          }
        }
      }

      // Ensure decoded sums include participants found on-chain (amount 0n)
      for (const p of participantsSet) {
        if (!sums.has(p)) {
          sums.set(p, 0n);
          addedToSums += 1;
        }
      }

      participants = Array.from(participantsSet) as (`0x${string}`)[];
      backfillRan = added > 0 || addedToSums > 0;
    }

    console.log('[snapshot.onchain_backfill.final]', {
      onChainCount,
      preDecodedCount: decodedEntriesCount,
      finalParticipantsCount: participants.length,
      ran: backfillRan,
      addedParticipantsFromMulticall: added,
      addedToDecoded: addedToSums,
    });

    // Surface both counts for acceptance
    console.log('[snapshot.diag.onchain_counts]', {
      participantsCount: participants.length,
      onChainParticipantCount: Number.isFinite(onChainCount) ? onChainCount : null,
      backfillRan,
    });
  } catch {}

  // Diagnostics: core counts
  try {
    console.log('[snapshot.diag.counts]', {
      
      entriesCount,
      participantsCount: participants.length,
    });
  } catch {}

  // Canonical normalized segments (0..1, tie-break by address; close to 1.0)
  const { segments: canonSegments, total } = buildCanonicalSegments(entriesArr);
  const cHash = segmentsHashCanonFn(canonSegments);

  // Degrees layout for cinematic/landing
  const { segments, total: _ignoredSameTotal } = buildSegments(entriesArr);
  const layout: NonNullable<CanonicalSnapshotJSON['layout']> = {
    roundId,
    totalBn: toBnStringStrict(total),
    segments,
  };
  const lHash = layoutHashFn(layout);
  const sHashLayout = segmentsHashFn(segments);

  // Freeze based on stage
  const nextFrozen = freezeLayout(frozenLayout, {
    stageIndex,
    roundId,
    layout,
    layoutHash: lHash,
  });
  if (nextFrozen && typeof stageIndex === 'number' && stageIndex >= 1) {
    frozenLayout = { ...nextFrozen, canonSegments, canonSegmentsHash: cHash };
  } else {
    frozenLayout = nextFrozen;
  }

  return {
    layout,
    layoutHash: lHash,
    layoutSegmentsHash: sHashLayout,
    canonSegments,
    canonSegmentsHash: cHash,
    participants,
    participantsCount: participants.length,
    total,
    lastWinner,
    lockTs: lockTsMs || undefined,
    entriesCount,
    diagStartTs: sinceTsMs,
    diagEndTs: endTsMs,
    diagTopic0: enteredTopic0,
  };
}

function stageString(idx?: number): CanonicalSnapshotJSON['stage'] {
  if (typeof idx !== 'number') return undefined;
  return idx === 0 ? 'Filling' : idx === 1 ? 'Ready' : idx === 2 ? 'Drawing' : undefined;
}

function shouldRebuildInternal(now: number): boolean {
  if (!lastGood) return true;
  if (now - lastGood.builtAtMs >= NO_BLOCK_FALLBACK_MS) return true;
  return false;
}

// Public shouldRebuild API
export function shouldRebuild(now: number, wantBlock?: number): boolean {
  if (!lastGood) return true;
  if (wantBlock !== undefined && lastGood.forBlock !== wantBlock) return true;
  return shouldRebuildInternal(now);
}

// Exposed for route/keepers to observe last snapshot (read-only)
export function __peekLastGood(): BuildResult | undefined {
  return lastGood;
}

export async function buildSnapshot(headers: Headers): Promise<BuildResult> {
  // Single-flight across concurrent callers
  if (inFlight) return inFlight;

  const { requestId } = parseCaller(headers);

  const doFallback = async (): Promise<BuildResult> => {
    const a = LOTTERY_ADDRESS as `0x${string}`;

    const pOwner = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'owner' });
    const pReady = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'isReadyForDraw' });
    const pDrawing = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'isDrawing' });
    const pCount = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'participantCount' });
    const pStage = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'stage' });
    const pPend = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'pendingRefundsTotal' });
    const pTarget = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'POOL_TARGET' });
    const pDebug = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'debugUnits' });
    const pRound = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'roundId' });
    const pBlock = rpcClient.getBlockNumber();

    const settled = await Promise.allSettled([
      pOwner, pReady, pDrawing, pCount, pStage, pPend, pTarget, pDebug, pRound, pBlock
    ]);

    const results: MCItem[] = settled.slice(0, 9).map((s) =>
      s.status === 'fulfilled' ? { status: 'success', result: s.value } : { status: 'failure' }
    );

    let blockNumber: bigint | undefined = undefined;
    const bn = settled[9];
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

    const { layout, layoutHash, canonSegments, canonSegmentsHash, participants, participantsCount, total, lastWinner, lockTs, entriesCount, diagStartTs, diagEndTs, diagTopic0, diagTopic1 } =
      await fetchAndComputeLayout(canon.roundId, canon.stageIndex);

    if (layout) canon.layout = layout;
    if (layoutHash) canon.layoutHash = layoutHash;
    canon.segments = canonSegments ?? [];
    if (canonSegmentsHash) canon.segmentsHash = canonSegmentsHash;
    canon.participants = participants ?? [];
    if (typeof participantsCount === 'number') {
      canon.participantsCount = participantsCount;
      const rawCount = typeof canon.participantCount === 'number' ? canon.participantCount : undefined;
      if (typeof rawCount === 'number' && rawCount !== participantsCount) {
        console.warn('[snapshot.warn.count_mismatch]', { roundId: canon.roundId, participantCount: rawCount, participantsCount });
      }
      // Keep existing participantCount field in sync with participantsCount
      canon.participantCount = participantsCount;
      // Surface derived entriesCount for hashing and clients
      canon.entriesCount = entriesCount;
    }
    // Prefer on-chain net for diagnostics; fallback to derived total
    if (typeof raw.netWeiTiny === 'bigint') {
      canon.netBalance = toBnStringStrict(raw.netWeiTiny);
    } else if (typeof total === 'bigint') {
      canon.netBalance = toBnStringStrict(total);
    }
    // Guardrail: netBalance present but no entries aggregated
    if ((entriesCount ?? 0) === 0 && typeof canon.netBalance === 'string' && canon.netBalance !== 'bn:0') {
      console.warn('[snapshot.guard.netBalance_no_entries]', {
        roundId: canon.roundId,
        address: LOTTERY_ADDRESS,
        startTs: diagStartTs,
        endTs: diagEndTs,
        topic0: diagTopic0,
        ...(diagTopic1 ? { topic1: diagTopic1 } : {}),
      });
    }
    // Instrumentation
    {
      const segLen = Array.isArray(canonSegments) ? canonSegments.length : Array.isArray(canon.segments) ? canon.segments.length : 0;
      const entriesLen = typeof entriesCount === 'number' ? entriesCount : 0;
      const partCountNow = typeof canon.participantCount === 'number' ? canon.participantCount : 0;
      console.log(`[snapshot.build] round=${canon.roundId ?? ''} entries=${entriesLen} participants=${canon.participantsCount ?? 0} segments=${segLen} participantCount=${partCountNow}`);
      if (segLen === 0 && partCountNow > 0) {
        console.warn('[snapshot.warn.noSegments]', { roundId: canon.roundId, participantCount: partCountNow });
      }
    }

    canon.stage = stageString(canon.stageIndex);

    // Spin session/update
    if (typeof canon.roundId === 'number') {
      const prev = spinSessions.get(canon.roundId);
      const { session, spin } = nextSpinSession(prev, {
        stageIndex: canon.stageIndex,
        builtAtMs: Date.now(),
        lockTs,
        lastWinner,
        layoutHash,
        revealMs: DEFAULT_REVEAL_MS,
      });
      spinSessions.set(canon.roundId, session);
      canon.spin = spin;
    }

    // Timing top-level fields
    const lp = canon.spin?.landingPlan;
    canon.openAt = lastWinner?.timestamp || undefined;
    // Rule of truth: "Pool is Filling until it reaches the target; then it locks."
    // Only set lockAt when the server-observed stage indicates the round is locked (stageIndex >= 1).
    canon.lockAt = (typeof canon.stageIndex === 'number' && canon.stageIndex >= 1)
      ? ((lockTs ?? undefined) || undefined)
      : undefined;
    canon.revealTargetAt = typeof canon.spin?.revealTargetAt === 'number' ? canon.spin!.revealTargetAt! : undefined;
    canon.reopenAt = lp ? lp.startAt + lp.durationMs : undefined;

    // Enterable
    {
      const nowMs = Date.now();
      canon.enterable = computeEnterable(nowMs, canon.openAt, canon.lockAt, canon.reopenAt);
    }

    // Orphaned balance diagnostic
    if ((!participants || participants.length === 0) && typeof canon.netBalance === 'string' && canon.netBalance !== 'bn:0') {
      canon.orphanedBalance = canon.netBalance;
      console.warn('[snapshot.orphanedBalance]', { roundId: canon.roundId, netBalance: canon.netBalance });
    }
    // Additional warning: positive netBalance but no aggregated entries/segments
    if ((!canon.segments || canon.segments.length === 0) && typeof canon.netBalance === 'string' && canon.netBalance !== 'bn:0') {
      console.warn('[snapshot.warn.noEntries]', { roundId: canon.roundId, netBalance: canon.netBalance });
    }

    const hash = computeSnapshotHash(canon);
    const etag = computeEtagFromCanon(canon);
    const builtAtMs = Date.now();
    const forBlock = canon.blockNumber;
    return { body: canon, builtAtMs, forBlock, hash, etag };
  };

  const doBuild = async (): Promise<BuildResult> => {
    if (__forceFallback) return doFallback();

    try {
      const res = await rpcClient.multicall({
        allowFailure: true,
        contracts: contractsBatch(LOTTERY_ADDRESS as `0x${string}`),
      } as Parameters<typeof rpcClient.multicall>[0]);

      const unknownRes: unknown = res;
      let results: MCItem[] = [];
      let blockNumber: bigint | undefined = undefined;

      if (typeof unknownRes === 'object' && unknownRes !== null && 'results' in (unknownRes as Record<string, unknown>)) {
        const r = unknownRes as MCResp;
        results = Array.isArray(r.results) ? r.results : [];
        blockNumber = r.blockNumber;
      } else if (Array.isArray(unknownRes)) {
        const arr = unknownRes as unknown[];
        if (arr.every((x) => typeof x === 'object' && x !== null && ('status' in (x as Record<string, unknown>) || 'result' in (x as Record<string, unknown>)))) {
          results = arr as MCItem[];
        }
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

      const { layout, layoutHash, canonSegments, canonSegmentsHash, participants, participantsCount, total, lastWinner, lockTs, entriesCount, diagStartTs, diagEndTs, diagTopic0, diagTopic1 } =
        await fetchAndComputeLayout(canon.roundId, canon.stageIndex);
      if (layout) canon.layout = layout;
      if (layoutHash) canon.layoutHash = layoutHash;
      canon.segments = canonSegments ?? [];
      if (canonSegmentsHash) canon.segmentsHash = canonSegmentsHash;
      canon.participants = participants ?? [];
      if (typeof participantsCount === 'number') {
        canon.participantsCount = participantsCount;
        const rawCount = typeof canon.participantCount === 'number' ? canon.participantCount : undefined;
        if (typeof rawCount === 'number' && rawCount !== participantsCount) {
          console.warn('[snapshot.warn.count_mismatch]', { roundId: canon.roundId, participantCount: rawCount, participantsCount });
        }
        // Keep existing participantCount field in sync with participantsCount
        canon.participantCount = participantsCount;
      // Surface derived entriesCount for hashing and clients
      canon.entriesCount = entriesCount;
      }
      // Prefer on-chain net for diagnostics; fallback to derived total
      if (typeof raw.netWeiTiny === 'bigint') {
        canon.netBalance = toBnStringStrict(raw.netWeiTiny);
      } else if (typeof total === 'bigint') {
        canon.netBalance = toBnStringStrict(total);
      }
      // Guardrail: netBalance present but no entries aggregated
      if ((entriesCount ?? 0) === 0 && typeof canon.netBalance === 'string' && canon.netBalance !== 'bn:0') {
        console.warn('[snapshot.guard.netBalance_no_entries]', {
          roundId: canon.roundId,
          address: LOTTERY_ADDRESS,
          startTs: diagStartTs,
          endTs: diagEndTs,
          topic0: diagTopic0,
          ...(diagTopic1 ? { topic1: diagTopic1 } : {}),
        });
      }
      // Instrumentation
      {
        const segLen = Array.isArray(canonSegments) ? canonSegments.length : Array.isArray(canon.segments) ? canon.segments.length : 0;
        const entriesLen = typeof entriesCount === 'number' ? entriesCount : 0;
        const partCountNow = typeof canon.participantCount === 'number' ? canon.participantCount : 0;
        console.log(`[snapshot.build] round=${canon.roundId ?? ''} entries=${entriesLen} participants=${canon.participantsCount ?? 0} segments=${segLen} participantCount=${partCountNow}`);
        if (segLen === 0 && partCountNow > 0) {
          console.warn('[snapshot.warn.noSegments]', { roundId: canon.roundId, participantCount: partCountNow });
        }
      }

      canon.stage = stageString(canon.stageIndex);

      if (typeof canon.roundId === 'number') {
        const prev = spinSessions.get(canon.roundId);
        const { session, spin } = nextSpinSession(prev, {
          stageIndex: canon.stageIndex,
          builtAtMs: Date.now(),
          lockTs,
          lastWinner,
          layoutHash,
          revealMs: DEFAULT_REVEAL_MS,
        });
        spinSessions.set(canon.roundId, session);
        canon.spin = spin;
      }

      const lp = canon.spin?.landingPlan;
      canon.openAt = lastWinner?.timestamp || undefined;
      // Rule of truth: "Pool is Filling until it reaches the target; then it locks."
      // Only set lockAt when the server-observed stage indicates the round is locked (stageIndex >= 1).
      canon.lockAt = (typeof canon.stageIndex === 'number' && canon.stageIndex >= 1)
        ? ((lockTs ?? undefined) || undefined)
        : undefined;
      canon.revealTargetAt = typeof canon.spin?.revealTargetAt === 'number' ? canon.spin!.revealTargetAt! : undefined;
      canon.reopenAt = lp ? lp.startAt + lp.durationMs : undefined;

      {
        const nowMs = Date.now();
        canon.enterable = computeEnterable(nowMs, canon.openAt, canon.lockAt, canon.reopenAt);
      }

      if ((!participants || participants.length === 0) && typeof canon.netBalance === 'string' && canon.netBalance !== 'bn:0') {
        canon.orphanedBalance = canon.netBalance;
        console.warn('[snapshot.orphanedBalance]', { roundId: canon.roundId, netBalance: canon.netBalance });
      }
      if ((!canon.segments || canon.segments.length === 0) && typeof canon.netBalance === 'string' && canon.netBalance !== 'bn:0') {
        console.warn('[snapshot.warn.noEntries]', { roundId: canon.roundId, netBalance: canon.netBalance });
      }

      const hash = computeSnapshotHash(canon);
      const etag = computeEtagFromCanon(canon);
      const builtAtMs = Date.now();
      const forBlock = canon.blockNumber;
      return { body: canon, builtAtMs, forBlock, hash, etag };
    } catch (err: unknown) {
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
  };

  inFlight = doBuild()
    .then((b) => {
      lastGood = b;
      return b;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}