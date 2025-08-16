// web/src/server/snapshot/types.ts
// Shared types for snapshot service and thin route

// Raw snapshot from chain (not JSON-safe)
export type RawSnapshot = {
  owner?: `0x${string}`;
  isReadyForDraw?: boolean;
  isDrawing?: boolean;
  participantCount?: number;
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
export type CanonicalSnapshotJSON = {
  owner?: `0x${string}`; // lowercased string
  isReadyForDraw?: boolean;
  isDrawing?: boolean;
  participantCount?: number;     // on-chain participantCount (raw)
  participantsCount?: number;    // derived unique count from current-round entries
  stageIndex?: number;
  stage?: 'Filling' | 'Ready' | 'Drawing';
  roundId?: number;

  // Balances (JSON-safe "bn:<decimal>")
  pendingRefundsTotalWei?: string;
  poolTargetWei?: string;
  balanceWeiTiny?: string;
  netWeiTiny?: string;
  netBalance?: string; // derived from Mirror entries total for current round

  blockNumber?: number; // not part of hash

  // Timing (server ms epoch)
  openAt?: number;         // last WinnerPicked timestamp (start of current round)
  lockAt?: number;         // first PoolFilled timestamp (round locked)
  revealTargetAt?: number; // neutralStartAt + REVEAL_MS
  reopenAt?: number;       // landing end when round can reopen

  // Participants derived from Mirror entries (unique lowercase addresses)
  participants?: (`0x${string}`)[];

  // Canonical normalized segments for the wheel (always present pre-lock; 0..1, hard-closed to 1.0)
  segments?: Array<{
    address: `0x${string}`;
    start: number; // 0..1
    end: number;   // 0..1
  }>;

  // Deterministic, JSON-safe spin-the-wheel layout for current round (degrees-based, used for landing plan)
  layout?: {
    roundId?: number;
    totalBn?: string; // "bn:<decimal>"
    segments?: Array<{
      id: string; // deterministic id (e.g., "addr:0x...")
      addressLower?: `0x${string}`;
      sumBn: string; // "bn:<decimal>"
      percent: number; // 0..100
      startDeg: number; // 0..360
      endDeg: number; // 0..360
      label?: string;
    }>;
  };
  // Hashes for client change-only rendering
  layoutHash?: string;    // hash of layout object
  segmentsHash?: string;  // hash of canonical normalized segments array only

  // Server-driven spin session (JSON-safe only; included in ETag)
  // spin.phase: "idle" | "neutral" | "landing" | "done"
  // spin.neutralStartAt: server ms when round first hit Locked (fallback to first-observed if Mirror lock unavailable)
  // spin.revealTargetAt: neutralStartAt + REVEAL_MS
  // spin.landingPlan: emitted after WinnerPicked; deterministic given layoutHash + winner
  spin?: SpinJSON;

  // Server-evaluated gate for enter button
  enterable?: boolean;

  // Diagnostics
  orphanedBalance?: string; // when netBalance>0 but no entries seen
};

export type SpinPhase = 'idle' | 'neutral' | 'landing' | 'done';

export type SpinLandingPlanJSON = {
  layoutHash: string;
  targetSegmentId: string;
  startAt: number;      // ms epoch
  durationMs: number;   // ms
  easing: 'easeOutCubic';
  rotations: number;    // extra full turns beyond direct shortest path
};

export type SpinJSON = {
  phase: SpinPhase;
  neutralStartAt?: number;
  revealTargetAt?: number;
  landingPlan?: SpinLandingPlanJSON;
};

// Per-round spin sessions (in-memory)
export type SpinSession = {
  neutralStartAt: number;
  revealTargetAt: number;
  winnerAddr?: `0x${string}`;
  landingPlan?: SpinLandingPlanJSON;
  phase: SpinPhase;
};

export type BuildResult = {
  body: CanonicalSnapshotJSON;
  builtAtMs: number;
  forBlock?: number;
  hash: string;
  etag: string;
};

// Multicall typing helpers
export type MCItem = { status?: 'success' | 'failure'; result?: unknown };
export type MCResp = { results: MCItem[]; blockNumber?: bigint };