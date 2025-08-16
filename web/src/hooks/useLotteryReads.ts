'use client';

import { useMemo, useEffect } from 'react';
import {
  useAccount,
  useChainId,
} from 'wagmi';
import { formatUnits } from 'viem';
import { hederaTestnet } from '@/lib/hedera';
import { useLotteryData } from '@/context/LotteryDataContext';

/** Hedera EVM decimals (HBAR uses 8-decimal tinybars) */
const HBAR_DECIMALS = 8;

/** Helpers */
function toHBAR(value?: bigint, decimals: number = HBAR_DECIMALS): number | undefined {
  if (value === undefined) return undefined;
  return Number(formatUnits(value, decimals));
}
function safeMulDiv(n?: bigint, mul?: bigint, div?: bigint): bigint | undefined {
  if (n === undefined || mul === undefined || div === undefined || div === 0n) return undefined;
  return (n * mul) / div;
}
function clampBigIntFloor(x: bigint): bigint {
  return x < 0n ? 0n : x;
}

/**
 * Primary reads hook for the Lottery dApp.
 * Thin adapter over the singleton LotteryDataContext snapshot.
 * No direct RPC calls in this file.
 */
type UseLotteryReadsResult = {
  owner: `0x${string}` | undefined;

  // readiness
  isReadyForDraw: boolean;         // on-chain readiness flag
  isReadyForDrawDerived: boolean;  // derived via net vs target
  isReadyDerived: boolean;         // alias of the above for clarity
  canDraw: boolean;                // stage-ready OR balance-ready

  // stage + drawing
  stage?: 'Filling' | 'Ready' | 'Drawing';
  stageIndex?: number;             // optional debug
  roundId?: number;                // round identity boundary
  willTriggerAt?: number;
  isFilling: boolean;
  isReadyStage: boolean;
  isDrawing: boolean;

  participantCount: number;

  // balances (formatted/net) + previews
  balanceWei: bigint | undefined;         // unused (kept for compatibility)
  balanceHBAR: number | undefined;        // raw balance formatted (from tinybars)
  netWei: bigint | undefined;             // internal tinybars (compat name)
  netHBAR: number | undefined;            // formatted net
  remainingHBAR: number | undefined;      // based on net
  feePreviewHBAR: number | undefined;     // based on net
  prizePreviewHBAR: number | undefined;   // based on net

  // pending refunds
  pendingRefundUserWei: bigint | undefined;
  pendingRefundUserHBAR: number | undefined;
  pendingRefundsTotalWei: bigint | undefined;
  pendingRefundsTotalHBAR: number | undefined;

  // progress expressed as a number percentage (0-100)
  progressPercent: number | undefined;

  // network gates
  hookConnected: boolean;
  onExpectedNetwork: boolean;

  // constants if any consumer wants them
  poolTargetWei: bigint | undefined;
  feeNumerator: bigint | undefined;
  feeDenominator: bigint | undefined;

  // network/contract identity diagnostics
  lotteryAddress: `0x${string}` | undefined;
  readChainId: number;
  blockNumber?: number;
  rawHBAR: number | undefined;
  targetHBAR: number | undefined;
  hasCode: boolean | undefined;
  codeHash?: string;

  // event diagnostics
  lastEvent?: { name: 'PoolFilled' | 'WinnerPicked' | 'RoundReset'; txHash?: string; blockNumber?: number };

  // mismatch flags
  readyMismatch: boolean;
  stageMismatch: boolean;

  // ownership convenience
  isOwner: boolean;

  // rate-limit diagnostics (dev banner)
  rateLimited?: boolean;
  rateLimitedUntil?: number;

  // meta
  loading: boolean;
  error: Error | undefined;
  refetch: () => Promise<void>;

  // stale indicator from snapshot
  isStale?: boolean;
};

export default function useLotteryReads(): UseLotteryReadsResult {
  const { status: accountStatus } = useAccount();
  const chainId = useChainId();

  const hookConnected = accountStatus === 'connected';
  const onExpectedNetwork = hookConnected && chainId === hederaTestnet.id;

  // Context: singleton snapshot and sticky ownership
  const { contract: address, snap, isOwner: stickyIsOwner } = useLotteryData();

  // Constants (no RPC reads)
  const FEE_NUMERATOR = 25n;
  const FEE_DENOMINATOR = 1000n;

  // Map snapshot -> local state
  const owner = snap.owner;
  const isReadyForDraw = Boolean(snap.isReadyForDraw);
  const isDrawing = Boolean(snap.isDrawing);
  const participantCount = Number(snap.participantCount ?? 0);

  const stageIndex = snap.stageIndex;
  const roundId = snap.roundId;
  const willTriggerAt = snap.willTriggerAt;
  const stage: UseLotteryReadsResult['stage'] =
    stageIndex === 0 ? 'Filling' : stageIndex === 1 ? 'Ready' : stageIndex === 2 ? 'Drawing' : undefined;
  const isFilling = stage === 'Filling';
  const isReadyStage = stage === 'Ready';

  // Balances from tinybars (debugUnits)
  const balanceTiny = snap.balanceWeiTiny;
  const netWei = snap.netWeiTiny; // tinybars
  const balanceHBAR = toHBAR(balanceTiny, HBAR_DECIMALS);
  const netHBAR = toHBAR(netWei, HBAR_DECIMALS);

  const poolTargetWeiTyped = snap.poolTargetWei;
  const pendingRefundsTotalWei = snap.pendingRefundsTotalWei;
  const pendingRefundUserWei = snap.pendingRefundUserWei;

  const pendingRefundsTotalHBAR = toHBAR(pendingRefundsTotalWei, HBAR_DECIMALS);
  const pendingRefundUserHBAR = toHBAR(pendingRefundUserWei, HBAR_DECIMALS);

  const remainingWei = useMemo(() => {
    if (netWei === undefined || poolTargetWeiTyped === undefined) return undefined;
    return clampBigIntFloor(poolTargetWeiTyped - netWei);
  }, [netWei, poolTargetWeiTyped]);

  const remainingHBAR = toHBAR(remainingWei, HBAR_DECIMALS);

  const progressPercent = useMemo(() => {
    if (netWei === undefined || poolTargetWeiTyped === undefined) return undefined;
    if (poolTargetWeiTyped === 0n) return 100;
    const pct = Number((netWei * 100n) / poolTargetWeiTyped);
    return pct > 100 ? 100 : pct;
  }, [netWei, poolTargetWeiTyped]);

  const feeWei = useMemo(() => {
    if (netWei === undefined) return undefined;
    return safeMulDiv(netWei, FEE_NUMERATOR, FEE_DENOMINATOR);
  }, [netWei]);

  const prizeWei = useMemo(() => {
    if (netWei === undefined || feeWei === undefined) return undefined;
    return clampBigIntFloor(netWei - feeWei);
  }, [netWei, feeWei]);

  const feePreviewHBAR = toHBAR(feeWei, HBAR_DECIMALS);
  const prizePreviewHBAR = toHBAR(prizeWei, HBAR_DECIMALS);

  // readiness derived via net vs. target
  const isReadyDerived =
    netWei !== undefined && poolTargetWeiTyped !== undefined
      ? netWei >= poolTargetWeiTyped
      : false;
  const isReadyForDrawDerived = isReadyDerived;

  // Draw readiness across both explicit stage and derived balance checks
  const canDraw = Boolean(isReadyStage || isReadyForDraw || isReadyDerived);

  // mismatch flags for diagnostics
  const readyMismatch = isReadyForDraw !== isReadyDerived;
  const stageMismatch = (stage !== 'Ready') && isReadyDerived;

  // --- Meta state aggregation ---
  const loading = snap.isLoading;

  const error = snap.error as Error | undefined;

  useEffect(() => {
    if (error) {
      console.error('[useLotteryReads]', error)
    }
  }, [error])

  const refetch = async () => {
    await Promise.allSettled([
      snap.refetch(),
    ]);
  };

  // Event diagnostics (disabled to reduce RPC load; rely on block-driven refresh)
  const lastEvent = undefined as
    | { name: 'PoolFilled' | 'WinnerPicked' | 'RoundReset'; txHash?: string; blockNumber?: number }
    | undefined;

  const isOwner = Boolean(stickyIsOwner);

  const rawHBAR = balanceHBAR;
  const targetHBAR = toHBAR(poolTargetWeiTyped, HBAR_DECIMALS);

  return {
    // raw on-chain
    owner: owner as `0x${string}` | undefined,

    // readiness
    isReadyForDraw,
    isReadyForDrawDerived,
    isReadyDerived,
    canDraw,

    // stage + drawing
    stage,
    stageIndex,
    roundId,
    willTriggerAt,
    isFilling,
    isReadyStage,
    isDrawing,

    participantCount,

    // balances + previews
    balanceWei: undefined, // not used externally; kept for compatibility
    balanceHBAR,
    netWei,
    netHBAR,
    remainingHBAR,
    feePreviewHBAR,
    prizePreviewHBAR,
    progressPercent,

    // pending refunds
    pendingRefundUserWei,
    pendingRefundUserHBAR,
    pendingRefundsTotalWei,
    pendingRefundsTotalHBAR,

    // network/contract identity diagnostics
    lotteryAddress: address,
    readChainId: hederaTestnet.id,
    blockNumber: snap.blockNumber,
    rawHBAR,
    targetHBAR,
    hasCode: undefined,
    codeHash: undefined,

    // event diagnostics
    lastEvent,

    // mismatch flags
    readyMismatch,
    stageMismatch,

    // network gates
    hookConnected,
    onExpectedNetwork,

    // constants if any consumer wants them
    poolTargetWei: poolTargetWeiTyped as bigint | undefined,
    feeNumerator: FEE_NUMERATOR,
    feeDenominator: FEE_DENOMINATOR,

    // ownership convenience
    isOwner,

    // rate-limit diagnostics
    rateLimited: snap.rateLimited,
    rateLimitedUntil: snap.rateLimitedUntil,

    // meta
    loading,
    error,
    refetch,

    // stale indicator
    isStale: snap.isStale,
  };
}

/**
 * Named helper kept for existing imports:
 *   import { useIsOwner } from '@/hooks/useLotteryReads'
 */
export const useIsOwner = () => {
  const r = useLotteryReads();
  return { isOwner: r.isOwner, owner: r.owner };
};