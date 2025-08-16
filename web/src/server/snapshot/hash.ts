// web/src/server/snapshot/hash.ts
// Canonicalization and hashing helpers for snapshot service

import type { RawSnapshot, CanonicalSnapshotJSON } from '@/server/snapshot/types';

// Stable stringify (sorted keys) for canonical hash
export function stableSerialize(obj: unknown): string {
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
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export function toBnString(v: bigint | undefined): string | undefined {
  return typeof v === 'bigint' ? `bn:${v.toString(10)}` : undefined;
}

export function toBnStringStrict(v: bigint): string {
  return `bn:${v.toString(10)}`;
}

export function toCanonicalJSON(raw: RawSnapshot): CanonicalSnapshotJSON {
  return {
    owner: raw.owner ? (raw.owner.toLowerCase() as `0x${string}`) : undefined,
    isReadyForDraw: raw.isReadyForDraw,
    isDrawing: raw.isDrawing,
    participantCount: typeof raw.participantCount === 'number' ? raw.participantCount : undefined,
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
// Build an explicit, deterministic subset of canonical fields that are semantic
// to clients (include fast-changing UI-driving fields here).
function canonicalForHash(canon: CanonicalSnapshotJSON) {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };

  // Core on-chain / semantic fields
  set('owner', canon.owner);
  set('isReadyForDraw', canon.isReadyForDraw);
  set('isDrawing', canon.isDrawing);
  set('participantCount', canon.participantCount);
  set('participantsCount', canon.participantsCount);
  set('entriesCount', canon.entriesCount);

  // Round / stage
  set('stageIndex', canon.stageIndex);
  set('stage', canon.stage);
  set('roundId', canon.roundId);

  // Balances (JSON-safe)
  set('pendingRefundsTotalWei', canon.pendingRefundsTotalWei);
  set('poolTargetWei', canon.poolTargetWei);
  set('balanceWeiTiny', canon.balanceWeiTiny);
  set('netWeiTiny', canon.netWeiTiny);
  set('netBalance', canon.netBalance);

  // Layout / segments change markers (clients key off hashes)
  set('layoutHash', canon.layoutHash);
  set('segmentsHash', canon.segmentsHash);

  // Spin / UI-driven transient state that should force new ETag when it changes
  set('spin', canon.spin);
  set('enterable', canon.enterable);

  return out;
}

export function computeSnapshotHash(canon: CanonicalSnapshotJSON): string {
  const canonicalString = stableSerialize(canonicalForHash(canon));
  return hashString(canonicalString);
}

// ETag should equal the snapshot hash for HTTP 304 decisions.
export function computeEtagFromCanon(canon: CanonicalSnapshotJSON): string {
  const h = computeSnapshotHash(canon);
  return `"h:${h}"`;
}

// Helpers for hashing layout/segments
export function layoutHash(layout: NonNullable<CanonicalSnapshotJSON['layout']>): string {
  return hashString(stableSerialize(layout));
}

export function segmentsHash(segments: NonNullable<NonNullable<CanonicalSnapshotJSON['layout']>['segments']>): string {
  return hashString(stableSerialize(segments));
}

// Hash for canonical normalized segments at the top-level snapshot (address,start,end 0..1)
export function segmentsHashCanonical(segments: NonNullable<CanonicalSnapshotJSON['segments']>): string {
  return hashString(stableSerialize(segments));
}