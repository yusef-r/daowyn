'use client'

import React, { useMemo } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import useLotteryReads from '@/hooks/useLotteryReads'
import { useEvents } from '@/app/providers/events'
import WinnerCard from '@/components/WinnerCard'
import type { FeedEntry } from '@/types/feed'
import { LOTTERY_ADDRESS, LOTTERY_ABI } from '@/lib/contracts/lottery'

export default function LivePanel() {
  const { address } = useAccount()
  const { netHBAR, targetHBAR, roundId } = useLotteryReads()
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

  const chancePercent = useMemo(() => {
    if (!targetHBAR || targetHBAR === 0) return 0
    return (userHBAR / targetHBAR) * 100
  }, [userHBAR, targetHBAR])

  const recentEntered = enteredEvents.slice(0, 4)

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

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="p-4">
        <div>
          <h3 className="text-base font-semibold">Your Entry Status</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {userHBAR > 0
              ? `You have ${userHBAR.toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR entered (${chancePercent.toLocaleString(undefined, { maximumFractionDigits: 0 })}% chance to win)`
              : 'You have not entered yet.'}
          </p>
        </div>

        <div className="mt-4">
          <h4 className="text-sm font-semibold">Live Activity Feed</h4>
          <p className="text-xs text-muted-foreground mt-1">Recent entries</p>

          <div className="mt-2 overflow-y-auto max-h-48">
            {recentEntered.length === 0 ? (
              <div className="text-sm text-muted-foreground p-2">No recent entries.</div>
            ) : (
              <ul className="space-y-2">
                {recentEntered.map((ev, i) => {
                  const participant = ev.participant ?? ev.winner ?? 'Unknown'
                  const ts = ev.timestamp
                    ? new Date(Number(ev.timestamp))
                    : ev.blockNumber
                    ? new Date(Number(ev.blockNumber))
                    : undefined
                  return (
                    <li
                      key={`${ev.txHash ?? i}-${ev.logIndex ?? 0}`}
                      className="flex items-center justify-between gap-4 rounded-md p-2 hover:bg-muted/10"
                    >
                      <div>
                        <div className="text-sm">
                          <span className="font-medium">Player {formatShort(String(participant))}</span> entered {formatAmount(ev.amount)}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">{ts ? ts.toLocaleString() : '—'}</div>
                      </div>
                      <div className="text-xs text-muted-foreground" />
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="mt-4">
          <h4 className="text-sm font-semibold">Recent Winners</h4>
          <div className="mt-2">
            <WinnerCard limit={3} />
          </div>
        </div>
      </div>
    </div>
  )
}