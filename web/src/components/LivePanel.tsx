'use client'

import React, { useMemo } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import useLotteryReads from '@/hooks/useLotteryReads'
import { useEvents } from '@/app/providers/events'
import type { FeedEntry } from '@/types/feed'
import { LOTTERY_ADDRESS, LOTTERY_ABI } from '@/lib/contracts/lottery'

export default function LivePanel() {
  const { address } = useAccount()
  const { netHBAR, roundId } = useLotteryReads()
  const { events } = useEvents()

  // Prefer canonical roundId from snapshot when available.
  // If roundId is provided, only show events that explicitly match that canonical round.
  // Otherwise, fall back to the previous boundary heuristic.
  const currentRoundEvents = useMemo(() => {
    const currentRoundId = typeof roundId === 'number' ? roundId : undefined
    if (typeof currentRoundId === 'number') {
      return events.filter((e) => e.roundId === currentRoundId)
    }
    // Boundary heuristic (fallback)
    const BOUNDARY_TYPES = ['WinnerPicked', 'RoundReset', 'PoolFilled']
    const boundaryIndex = events.findIndex((e) => BOUNDARY_TYPES.includes(e.type))
    return boundaryIndex === -1 ? events : events.slice(0, boundaryIndex)
  }, [events, roundId])

  const enteredEvents = useMemo(
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
      // numeric event payloads are tinybars as numbers -> convert to HBAR
      return a / 1e8
    }
    return 0
  }

  const userAddr = address ? address.toLowerCase() : undefined

  const userEntries = useMemo(() => {
    if (!userAddr) return [] as FeedEntry[]
    return enteredEvents.filter((e) => e.participant && String(e.participant).toLowerCase() === userAddr)
  }, [enteredEvents, userAddr])
  
  const userHBAR = useMemo(() => userEntries.reduce((s, e) => s + amtToHBAR(e.amount), 0), [userEntries])

  // Debug: surface key values to help diagnose empty-feed / staleness issues.
  // Remove these logs after investigation.
  type AbiEventEntry = { type?: string; name?: string }
  const abiEventNames = Array.isArray(LOTTERY_ABI)
    ? (LOTTERY_ABI
        .filter((i): i is AbiEventEntry => (i as AbiEventEntry).type === 'event')
        .map((e) => e.name ?? '') as string[])
    : []
  try {
    // Keep logs lightweight and defensive (optional chaining where useful).
    console.debug('LivePanel debug', {
      eventsLength: events?.length,
      currentRoundEventsLength: currentRoundEvents?.length,
      enteredEventsLength: enteredEvents?.length,
      netHBAR,
      userAddr,
      userHBAR,
      lotteryAddress: LOTTERY_ADDRESS,
      abiEventNames
    })
  } catch (err) {
    // swallow any debug logging errors in production render paths
    // (shouldn't happen, but safe-guarding UI).
  }

  // Make the panel more compact to better match the Prize Pool card height.
  // Show a slightly larger history in the live panel so more activity is visible.
  const recentEntered = enteredEvents.slice(0, 5)
  const recentWinners = useMemo(
    () => currentRoundEvents.filter((e) => e.type === 'WinnerPicked').slice(0, 5) as FeedEntry[],
    [currentRoundEvents]
  )
  const recentActivity = useMemo(() => {
    const combined = [...recentEntered, ...recentWinners]
    combined.sort((a, b) => {
      const aTs = Number(a.timestamp ?? (typeof a.blockNumber === 'number' ? a.blockNumber : 0))
      const bTs = Number(b.timestamp ?? (typeof b.blockNumber === 'number' ? b.blockNumber : 0))
      return bTs - aTs
    })
    return combined.slice(0, 5)
  }, [recentEntered, recentWinners])
 
  const formatShort = (addr?: string) => {
    if (!addr) return ''
    return addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr
  }
 
  const formatAmount = (a?: bigint | number) => {
    try {
      if (a === undefined || a === null) return ''
      if (typeof a === 'bigint') {
        return `${Number(formatUnits(a, 8)).toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR`
      }
      if (typeof a === 'number') {
        return `${(a / 1e8).toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR`
      }
      return String(a)
    } catch {
      return String(a)
    }
  }

  const getInitials = (addr?: string) => {
    if (!addr) return '??'
    try {
      const cleaned = String(addr).replace(/^0x/i, '')
      // Use first two visible chars if no separators
      const parts = cleaned.split(/[^a-zA-Z0-9]+/).filter(Boolean)
      if (parts.length === 0) return cleaned.slice(0, 2).toUpperCase()
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
      const first = (parts[0][0] ?? '').toUpperCase()
      const last = (parts[parts.length - 1][0] ?? '').toUpperCase()
      return `${first}${last}`
    } catch {
      return String(addr).slice(0, 2).toUpperCase()
    }
  }

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm h-full">
      <div className="p-3 space-y-3 h-full flex flex-col min-h-0">
        {/* Live Activity Feed */}
        <div className="section-accent live-section flex-1 flex flex-col min-h-0">
          <div className="flex h-full flex-col min-h-0">
            <h4 className="text-sm font-semibold section-heading">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className="opacity-90">
                <path d="M3 12h3l3-9 4 18 3-12 4 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Live Activity Feed
            </h4>
            <p className="text-xs text-muted-foreground mt-1">Recent activity</p>

            <div className="feed-list flex flex-col flex-1 min-h-0">
              {recentActivity.length === 0 ? (
                <div className="text-sm text-muted-foreground p-2">No recent activity.</div>
              ) : (
                <ul className="flex flex-col-reverse gap-2">
                  {recentActivity.map((ev, i) => {
                    const participant = ev.participant ?? ev.winner ?? 'Unknown'
                    const ts = ev.timestamp
                      ? new Date(Number(ev.timestamp))
                      : ev.blockNumber
                      ? new Date(Number(ev.blockNumber))
                      : undefined
                    const initials = getInitials(String(participant))
                    const isWinner = ev.type === 'WinnerPicked'
                    const amountLabel = isWinner ? formatAmount(ev.prize ?? ev.amount) : formatAmount(ev.amount)
                    return (
                      <li
                        key={`${ev.txHash ?? i}-${ev.logIndex ?? 0}`}
                        className={`feed-item ${i === 0 ? 'new' : ''}`}
                      >
                        <div className="avatar small" aria-hidden>
                          {initials}
                        </div>
                        <div className="flex-1">
                          <div className="feed-bubble text-sm">
                            <span className="font-medium">{isWinner ? 'Winner' : 'Player'} {formatShort(String(participant))}</span>
                            {' '}{isWinner ? 'won' : 'entered'} {amountLabel}
                          </div>
                          <div className="feed-ts text-xs">{ts ? ts.toLocaleString() : '—'}</div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}