'use client'

import React, { useMemo } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import useLotteryReads from '@/hooks/useLotteryReads'
import { useEvents } from '@/app/providers/events'
import type { FeedEntry } from '@/types/feed'
import { getExplorerTxUrl } from '@/lib/mirror'
import { LOTTERY_ADDRESS, LOTTERY_ABI } from '@/lib/contracts/lottery'

export default function LivePanel() {
  const { address } = useAccount()
  const { netHBAR, roundId } = useLotteryReads()
  const { events } = useEvents()

  // FeedEntry.timestamp is normalized to milliseconds at mapping time.
  // Treat it as a plain millisecond number here (no UI-side heuristics).
  const comparableTs = (e?: FeedEntry): number => {
    if (!e) return 0
    const t = e.timestamp ?? 0
    const n = typeof t === 'bigint' ? Number(t) : Number(t)
    return Number.isFinite(n) ? n : 0
  }

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
    // Compute lightweight summary metrics to help root-cause event filtering issues.
    const uniqueEventNames = Array.from(new Set((events ?? []).map((e) => e.type ?? '')))
    const blockNumbers = (events ?? [])
      .map((e) => (typeof e.blockNumber === 'number' ? e.blockNumber : undefined))
      .filter((n): n is number => typeof n === 'number')
    const firstBlockSeen = blockNumbers.length > 0 ? Math.min(...blockNumbers) : undefined
    const lastBlockSeen = blockNumbers.length > 0 ? Math.max(...blockNumbers) : undefined
    // estimate a sensible startBlock suggestion (used by EventsProvider as lastSeen - 2)
    const estimatedChosenStartBlock = lastBlockSeen !== undefined ? Math.max(0, lastBlockSeen - 2) : undefined
    const currentRoundIdForDebug = typeof roundId === 'number' ? roundId : undefined

    console.debug('LivePanel debug', {
      eventsLength: events?.length,
      currentRoundEventsLength: currentRoundEvents?.length,
      enteredEventsLength: enteredEvents?.length,
      netHBAR,
      userAddr,
      userHBAR,
      lotteryAddress: LOTTERY_ADDRESS,
      abiEventNames,
      uniqueEventNames,
      firstBlockSeen,
      lastBlockSeen,
      estimatedChosenStartBlock,
      currentRoundId: currentRoundIdForDebug,
      eventsRoundTypes: events?.slice(0, 20).map((ev) => ({ roundId: ev.roundId, type: ev.type, blockNumber: ev.blockNumber, logIndex: ev.logIndex }))
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
      const aTs = comparableTs(a)
      const bTs = comparableTs(b)
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
    <div className="rounded-lg border bg-card text-card-foreground shadow h-full">
      <div className="p-3 space-y-3 h-full flex flex-col min-h-0">
        {/* Live Activity Feed */}
        <div className="section-accent live-section flex-1 flex flex-col min-h-0">
          <div className="flex h-full flex-col min-h-0">
            <h3 className="text-base font-semibold section-heading panel-title pl-2">Live Activity Feed</h3>
            <p className="text-xs text-muted-foreground mt-1 panel-subtitle pl-2">Recent activity</p>

            <div className="feed-list flex flex-col flex-1 min-h-0">
              {recentActivity.length === 0 ? (
                <div className="text-sm text-muted-foreground p-2">No recent activity.</div>
              ) : (
                <ul className="flex flex-col-reverse gap-2">
                  {recentActivity.map((ev, i) => {
                    const participant = ev.participant ?? ev.winner ?? 'Unknown'
                    const ts = (() => {
                      const t = ev.timestamp
                      if (t === undefined || t === null) return undefined
                      const n = typeof t === 'bigint' ? Number(t) : Number(t)
                      if (!Number.isFinite(n)) return undefined
                      return new Date(n)
                    })()
                    const initials = getInitials(String(participant))
                    const isWinner = ev.type === 'WinnerPicked'
                    const amountLabel = isWinner ? formatAmount(ev.prize ?? ev.amount) : formatAmount(ev.amount)
                    const keyStr =
                      ev.txHash ??
                      (ev as unknown as { transaction_id?: string }).transaction_id ??
                      `${ev.blockNumber ?? ''}-${ev.logIndex ?? 0}-${ev.timestamp ?? i}`
                    const txId = ev.txHash ?? (ev as unknown as { transaction_id?: string }).transaction_id
                    return (
                      <li
                        key={keyStr}
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
                          <div className="feed-ts text-xs">
                            {ts ? ts.toLocaleDateString() : '—'}
                            {txId && (
                              <a
                                href={getExplorerTxUrl(String(txId))}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs underline underline-offset-2 text-muted-foreground hover:opacity-80 ml-2"
                              >
                                View
                              </a>
                            )}
                          </div>
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
