'use client'

import React, { useEffect, useState } from 'react';
import useLotteryReads from '@/hooks/useLotteryReads'
import { formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import { useEvents } from '@/app/providers/events'
import type { FeedEntry } from '@/types/feed'

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
    roundId,
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

  // Entry status: compute user entries & chance
  const { address } = useAccount()
  const { events } = useEvents()

  const currentRoundEvents = React.useMemo(() => {
    const currentRoundId = typeof roundId === 'number' ? roundId : undefined
    if (typeof currentRoundId === 'number') {
      return events.filter((e) => e.roundId === currentRoundId)
    }
    const BOUNDARY_TYPES = ['WinnerPicked', 'RoundReset', 'PoolFilled']
    const boundaryIndex = events.findIndex((e) => BOUNDARY_TYPES.includes(e.type))
    return boundaryIndex === -1 ? events : events.slice(0, boundaryIndex)
  }, [events, roundId])

  const enteredEvents = React.useMemo(
    () => currentRoundEvents.filter((e) => e.type === 'EnteredPool') as FeedEntry[],
    [currentRoundEvents]
  )

  function amtToHBAR(a?: bigint | number) {
    if (a === undefined || a === null) return 0
    if (typeof a === 'bigint') {
      try {
        return Number(formatUnits(a, 8))
      } catch {
        return 0
      }
    }
    if (typeof a === 'number') {
      if (!Number.isFinite(a)) return 0
      return a / 1e8
    }
    return 0
  }

  const userAddr = address ? address.toLowerCase() : undefined

  const userEntries = React.useMemo(() => {
    if (!userAddr) return [] as FeedEntry[]
    return enteredEvents.filter((e) => e.participant && String(e.participant).toLowerCase() === userAddr)
  }, [enteredEvents, userAddr])

  const userHBAR = React.useMemo(() => userEntries.reduce((s, e) => s + amtToHBAR(e.amount), 0), [userEntries])

  const chancePercent = React.useMemo(() => {
    if (!targetHBAR || targetHBAR === 0) return 0
    return (userHBAR / targetHBAR) * 100
  }, [userHBAR, targetHBAR])
 
  // Dynamic progress visuals & micro-interactions
  const [goldPulse, setGoldPulse] = useState(false)
  const [tickPulse, setTickPulse] = useState(false)
 
  useEffect(() => {
    if (progress >= 90) {
      setGoldPulse(true)
      const t = setTimeout(() => setGoldPulse(false), 450)
      return () => clearTimeout(t)
    }
    return
  }, [progress])
 
  useEffect(() => {
    if (progress >= 100) {
      setTickPulse(true)
      const t = setTimeout(() => setTickPulse(false), 420)
      return () => clearTimeout(t)
    }
    return
  }, [progress])
 
  const showGlint = progress >= 80
 
  // Dynamic hue-shifted gradient based on % thresholds
  let fillGradient = ''
  if (progress < 60) {
    // keep it green
    fillGradient = 'linear-gradient(90deg, #22C55E 0%, #10B981 100%)'
  } else if (progress < 85) {
    // warming to lime
    fillGradient = 'linear-gradient(90deg, #22C55E 0%, #10B981 40%, #A3E635 100%)'
  } else {
    // full emerald → gold payoff gradient
    fillGradient = 'linear-gradient(90deg, #22C55E 0%, #10B981 35%, #A3E635 70%, #FACC15 100%)'
  }
 
  const fillBoxShadow = goldPulse
    ? '0 12px 36px rgba(255,216,77,0.28), inset 0 0 0 1px rgba(255,255,255,0.95)'
    : '0 8px 24px rgba(34,197,94,0.12), inset 0 0 0 1px rgba(255,255,255,0.6)'
 
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
          <div className="h-6 w-full">
            <div className="progress-track h-6 w-full rounded-full relative">
              <div
                className={`progress-fill ${goldPulse ? 'pulse-gold' : ''}`}
                style={{ width: `${progress}%`, background: fillGradient, boxShadow: fillBoxShadow }}
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Pool ${Math.round(progress)}% full`}
              >
                {/* subtle diagonal stripes for contrast */}
                <div className="progress-stripes" aria-hidden />
                {/* leading-edge glint when near the end */}
                {showGlint && <div className="progress-glint" aria-hidden />}
              </div>
 
              {/* Goal marker (at target) */}
              <div
                className={`goal-tick ${tickPulse ? 'tick-pulse' : ''}`}
                style={{ left: `100%` }}
                aria-hidden
              />
            </div>
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

        {/* Your Entry Status (moved from LivePanel) */}
        <div className="section-accent live-section">
          <div>
            <h3 className="text-base font-semibold section-heading">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className="opacity-90">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M6 20v-1a4 4 0 014-4h4a4 4 0 014 4v1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Your Entry Status
            </h3>
            <p className="text-sm text-muted-foreground mt-1 lp-muted">
              {userHBAR > 0
                ? `You have ${userHBAR.toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR entered (${chancePercent.toLocaleString(undefined, { maximumFractionDigits: 0 })}% chance to win)`
                : 'You have not entered yet.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}