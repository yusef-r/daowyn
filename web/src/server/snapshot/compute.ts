// web/src/server/snapshot/compute.ts
// Pure math and deterministic state-transition helpers (no I/O)

import type {
  CanonicalSnapshotJSON,
  SpinJSON,
  SpinLandingPlanJSON,
  SpinSession,
} from '@/server/snapshot/types';
import { toBnStringStrict } from '@/server/snapshot/hash';

// Build wheel segments deterministically from [addressLower, amount] entries.
// - Sort by amount desc, tie-break by address asc
// - Top K addresses plus optional "others" bucket
// - Hard 360° closure on the last segment
export function buildSegments(
  entries: Array<[`0x${string}` | string, bigint]>,
  options?: { topK?: number }
): {
  segments: NonNullable<NonNullable<CanonicalSnapshotJSON['layout']>['segments']>;
  total: bigint;
} {
  const topK = options?.topK ?? 10;
  const arr = [...entries];

  // Sort: amount desc, address asc (lowercased for tie-break)
  arr.sort((a, b) => {
    const diff = b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0;
    if (diff !== 0) return diff;
    const aa = String(a[0]).toLowerCase();
    const bb = String(b[0]).toLowerCase();
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });

  const top = arr.slice(0, topK);
  const rest = arr.slice(topK);

  let othersSum = 0n;
  for (const [, v] of rest) othersSum += v;

  const total = arr.reduce((acc, [, v]) => acc + v, 0n);
  const segments: NonNullable<NonNullable<CanonicalSnapshotJSON['layout']>['segments']> = [];

  let cursor = 0; // degrees
  const addSeg = (id: string, addrLower: string | undefined, sum: bigint) => {
    const percent = total === 0n ? 0 : Number((sum * 10000n) / total) / 100; // two decimals, deterministic
    const delta = total === 0n ? 0 : Number((sum * 36000n) / total) / 100;   // two decimals
    const startDeg = cursor;
    const endDeg = cursor + delta;
    cursor = endDeg;
    segments.push({
      id,
      addressLower: addrLower as `0x${string}` | undefined,
      sumBn: toBnStringStrict(sum),
      percent,
      startDeg,
      endDeg,
      label: addrLower
        ? `${addrLower.slice(0, 6)}…${addrLower.slice(-4)} • ${percent.toFixed(2)}%`
        : `Others • ${percent.toFixed(2)}%`,
    });
  };

  for (const [addr, v] of top) addSeg(`addr:${String(addr).toLowerCase()}`, String(addr).toLowerCase(), v);
  if (othersSum > 0n) addSeg('others', undefined, othersSum);

  // Enforce hard 360° closure on last segment
  if (segments.length > 0) {
    segments[segments.length - 1].endDeg = 360;
  }

  return { segments, total };
}

// Build canonical normalized segments from all entries (no top-K, no "others").
// - Sort by amount desc, tie-break by address asc (lowercased)
// - Compute cumulative fractions 0..1
// - Hard-close final segment to 1.0
export function buildCanonicalSegments(
  entries: Array<[`0x${string}` | string, bigint]>
): { segments: Array<{ address: `0x${string}`; start: number; end: number }>; total: bigint } {
  const arr = [...entries];
  // Sort: amount desc, address asc
  arr.sort((a, b) => {
    const diff = b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0;
    if (diff !== 0) return diff;
    const aa = String(a[0]).toLowerCase();
    const bb = String(b[0]).toLowerCase();
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });

  const total = arr.reduce((acc, [, v]) => acc + v, 0n);
  const segments: Array<{ address: `0x${string}`; start: number; end: number }> = [];

  if (total === 0n || arr.length === 0) {
    return { segments, total };
  }

  let cursor = 0;
  for (let i = 0; i < arr.length; i++) {
    const [addr, v] = arr[i];
    const frac = Number(v) / Number(total); // deterministic in JSON (double)
    const start = cursor;
    const end = start + frac;
    cursor = end;
    // Push with lowercased address
    segments.push({
      address: String(addr).toLowerCase() as `0x${string}`,
      start,
      end,
    });
  }
  // Hard-close last to 1.0
  segments[segments.length - 1].end = 1.0;

  return { segments, total };
}

// Pure function to determine if "enter" is allowed based on server-evaluated timing.
export function computeEnterable(nowMs: number, openAt?: number, lockAt?: number, reopenAt?: number): boolean {
  const open = openAt ?? 0;
  const lock = lockAt ?? Number.MAX_SAFE_INTEGER;
  const reopen = reopenAt ?? 0;
  return nowMs >= open && nowMs < lock && nowMs >= reopen;
}

// Freeze/unfreeze layout deterministically based on stage state.
// - When stageIndex >= 1 (Locked/Ready/Drawing), return frozen for that round
// - When stage returns to Filling or round changes, clear frozen (caller holds current frozen)
export function freezeLayout<T extends { roundId: number; layout: NonNullable<CanonicalSnapshotJSON['layout']>; layoutHash: string }>(
  currentFrozen: T | null,
  args: { stageIndex?: number; roundId: number; layout: T['layout']; layoutHash: string }
): T | null {
  const { stageIndex, roundId, layout, layoutHash } = args;
  if (typeof stageIndex === 'number' && stageIndex >= 1) {
    return { roundId, layout, layoutHash } as T;
  }
  // If we changed rounds, drop frozen
  if (currentFrozen && currentFrozen.roundId !== roundId) return null;
  return currentFrozen;
}

// Build a landing plan with deterministic timing rules given current time.
// Matches route behavior: prefer finishing at revealTargetAt, cap extension by +5000ms,
// and choose rotations based on duration window.
export function buildLandingPlan(args: {
  layoutHash: string;
  targetSegmentId: string;
  now: number;
  revealTargetAt: number;
}): SpinLandingPlanJSON {
  const { layoutHash, targetSegmentId, now, revealTargetAt } = args;
  const desiredFinish = revealTargetAt;
  const capFinish = desiredFinish + 5000;

  let durationMs: number;
  let rotations = 0;

  if (now <= desiredFinish) {
    durationMs = Math.max(1500, desiredFinish - now);
    rotations = durationMs >= 4000 ? 2 : 1;
  } else if (now <= capFinish) {
    durationMs = Math.max(1200, capFinish - now);
    rotations = 1;
  } else {
    durationMs = 2000;
    rotations = 0;
  }

  return {
    layoutHash,
    targetSegmentId,
    startAt: now,
    durationMs,
    easing: 'easeOutCubic',
    rotations,
  };
}

// Stateless transition to next SpinSession + emit SpinJSON.
// Caller is responsible for holding per-round session state; this function returns an updated copy.
export function nextSpinSession(
  prev: SpinSession | undefined,
  args: {
    stageIndex?: number;
    builtAtMs: number;
    lockTs?: number;
    lastWinner?: { timestamp: number; winner: `0x${string}` };
    layoutHash?: string;
    revealMs: number;
  }
): { session: SpinSession; spin: SpinJSON } {
  const { stageIndex, builtAtMs, lockTs, lastWinner, layoutHash, revealMs } = args;

  // Initialize or evolve base session
  let session: SpinSession;
  if (!prev) {
    if (typeof stageIndex === 'number' && stageIndex >= 1) {
      const nsa = typeof lockTs === 'number' && lockTs > 0 ? lockTs : builtAtMs;
      session = {
        neutralStartAt: nsa,
        revealTargetAt: nsa + revealMs,
        phase: 'neutral',
      };
    } else {
      session = {
        neutralStartAt: 0,
        revealTargetAt: 0,
        phase: 'idle',
      };
    }
  } else {
    session = { ...prev };
    // If we became locked and didn't have neutralStartAt yet, set it
    if (session.neutralStartAt <= 0 && typeof stageIndex === 'number' && stageIndex >= 1) {
      session.neutralStartAt = typeof lockTs === 'number' && lockTs > 0 ? lockTs : builtAtMs;
      session.revealTargetAt = session.neutralStartAt + revealMs;
    }
    // If unlocked, keep idle but retain data
    if (typeof stageIndex === 'number' && stageIndex === 0 && session.neutralStartAt <= 0) {
      session.phase = 'idle';
    }
  }

  // Winner observation: set winner for this round when winner ts is after neutralStartAt
  if (lastWinner && session.neutralStartAt > 0 && lastWinner.timestamp > session.neutralStartAt) {
    session.winnerAddr = lastWinner.winner;
  }

  // Emit landing plan when we know winner and have layoutHash but no plan yet
  if (layoutHash && session.winnerAddr && !session.landingPlan) {
    const targetSegmentId = `addr:${session.winnerAddr.toLowerCase()}`;
    session.landingPlan = buildLandingPlan({
      layoutHash,
      targetSegmentId,
      now: builtAtMs,
      revealTargetAt: session.revealTargetAt,
    });
    session.phase = 'landing';
  }

  // Phase resolution
  if (session.landingPlan) {
    const endAt = session.landingPlan.startAt + session.landingPlan.durationMs;
    session.phase = builtAtMs >= endAt ? 'done' : 'landing';
  } else if (session.neutralStartAt > 0 && (stageIndex ?? 0) >= 1) {
    session.phase = 'neutral';
  } else {
    session.phase = 'idle';
  }

  // Emit JSON-safe spin
  const spin: SpinJSON = { phase: session.phase };
  if (session.neutralStartAt > 0) spin.neutralStartAt = session.neutralStartAt;
  if (session.revealTargetAt > 0) spin.revealTargetAt = session.revealTargetAt;
  if (session.landingPlan) spin.landingPlan = session.landingPlan;

  return { session, spin };
}