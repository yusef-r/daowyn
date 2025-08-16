'use client'

import useLotteryReads from '@/hooks/useLotteryReads'
import { formatUnits } from 'viem'

function SkeletonLine({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />
}

export default function StatusCard() {
  const {
    netHBAR,
    balanceHBAR,
    pendingRefundsTotalHBAR,
    remainingHBAR,
    participantCount,
    isReadyForDraw,
    isReadyDerived,
    isReadyStage,
    isFilling,
    isDrawing,
    feeNumerator,
    feeDenominator,
    poolTargetWei,
    feePreviewHBAR,
    prizePreviewHBAR,
    progressPercent,
    loading,
    error,
    rateLimited,
    rateLimitedUntil,
    isStale,
  } = useLotteryReads()

  // Pool targets / progress
  // POOL_TARGET is exposed in tinybars (8) — format directly with 8 decimals for display.
  const targetHBAR = poolTargetWei
    ? Number(formatUnits(poolTargetWei as bigint, 8))
    : 10
  const progress =
    progressPercent !== undefined
      ? Number(progressPercent)
      : targetHBAR > 0
      ? Math.min(100, ((netHBAR ?? 0) / targetHBAR) * 100)
      : 0

  const readyNow = Boolean(isReadyStage || isReadyForDraw || isReadyDerived)

  // Fee %
  const feePct =
    (Number((feeNumerator as bigint) ?? 0n) /
      Number((feeDenominator as bigint) ?? 1n)) *
    100

  // Wallet balance intentionally omitted to enforce zero direct RPC from UI
  const balLoading = false
  const hbar: number | null = null

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center justify-between p-4">
        <div>
          <h3 className="text-base font-semibold">Pool Status</h3>
          <p className="text-sm text-muted-foreground">
            Live status of the prize pool
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs ${
              readyNow
                ? 'bg-green-100 text-green-700'
                : 'bg-slate-100 text-slate-700'
            }`}
          >
            {readyNow ? 'Ready to draw' : 'Filling pool'}
          </span>
          {isDrawing ? (
            <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs text-red-700">
              Drawing
            </span>
          ) : null}
          {isStale ? (
            <span
              className="inline-block h-2 w-2 rounded-full bg-amber-500"
              title="stale"
              aria-label="stale"
            />
          ) : null}
        </div>
      </div>

      {process.env.NODE_ENV !== 'production' && rateLimited ? (
        <div className="mx-4 mb-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800" role="status" aria-live="polite">
          Rate limited — pausing refresh{typeof rateLimitedUntil === 'number' ? ` (~${Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000))}s)` : ''}.
        </div>
      ) : null}

      <div className="space-y-4 p-4 pt-0">
        {loading ? (
          <>
            <SkeletonLine className="h-6 w-40" />
            <SkeletonLine className="h-3 w-full" />
            <div className="grid grid-cols-3 gap-3">
              <SkeletonLine className="h-12" />
              <SkeletonLine className="h-12" />
              <SkeletonLine className="h-12" />
            </div>
            <SkeletonLine className="h-4 w-64" />
          </>
        ) : error ? (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            Failed to load pool status
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Net balance</span>
              <span className="text-xl font-semibold">
                {(netHBAR ?? 0).toLocaleString(undefined, {
                  maximumFractionDigits: 6
                })}{' '}
                HBAR
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">To target</span>
              <span className="text-sm">
                {(remainingHBAR ?? 0).toLocaleString(undefined, {
                  maximumFractionDigits: 6
                })}{' '}
                HBAR
              </span>
            </div>

            {(pendingRefundsTotalHBAR ?? 0) > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Pending credits</span>
                <span className="text-sm">
                  {pendingRefundsTotalHBAR!.toLocaleString(undefined, {
                    maximumFractionDigits: 6
                  })}{' '}
                  HBAR
                </span>
              </div>
            )}

            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                role="progressbar"
              />
            </div>

            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Participants</div>
                <div className="font-medium">
                  {(participantCount ?? 0).toString()}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Target</div>
                <div className="font-medium">
                  {targetHBAR.toLocaleString()} HBAR
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Fee</div>
                <div className="font-medium">
                  {isFinite(feePct) ? `${feePct.toFixed(2)}%` : '—'}
                </div>
              </div>
            </div>

            {/* Wallet balance omitted (no client RPCs) */}

            <div className="text-xs text-muted-foreground">
              If drawn now: fee ≈{' '}
              {(feePreviewHBAR ?? 0).toLocaleString(undefined, {
                maximumFractionDigits: 6
              })}{' '}
              HBAR • prize ≈{' '}
              {(prizePreviewHBAR ?? 0).toLocaleString(undefined, {
                maximumFractionDigits: 6
              })}{' '}
              HBAR
            </div>
          </>
        )}
      </div>
    </div>
  )
}