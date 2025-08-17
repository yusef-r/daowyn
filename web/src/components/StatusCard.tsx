'use client'

import React, { useEffect, useState } from 'react';
import useLotteryReads from '@/hooks/useLotteryReads'
import { formatUnits } from 'viem'

function SkeletonLine({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />
}

export default function StatusCard() {
  const {
    netHBAR,
    participantCount,
    poolTargetWei,
    progressPercent,
    loading,
    error,
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






  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="p-6 space-y-4">
        <div className="text-center">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Prize Pool</div>
          <div className="mt-1 text-4xl sm:text-5xl font-extrabold">
            {(netHBAR ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
            <span className="text-lg font-semibold text-muted-foreground">HBAR</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-muted-foreground">Progress</div>
            <div className="text-sm font-mono font-semibold">{Math.round(progress)}%</div>
          </div>
          <div className="h-6 w-full overflow-hidden rounded-full bg-muted/60">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }}
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Pool ${Math.round(progress)}% full`}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md border p-3 text-center">
            <div className="text-xs text-muted-foreground">Participants</div>
            <div className="mt-1 font-bold font-mono text-lg">{(participantCount ?? 0).toString()}</div>
          </div>

          <div className="rounded-md border p-3 text-center">
            <div className="text-xs text-muted-foreground">Target</div>
            <div className="mt-1 font-bold font-mono text-lg">{targetHBAR.toLocaleString()} HBAR</div>
          </div>
        </div>
      </div>
    </div>
  )
}