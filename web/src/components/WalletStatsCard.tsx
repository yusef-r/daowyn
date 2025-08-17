'use client'

import React, { useMemo } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import { useEvents } from '@/app/providers/events'
import type { FeedEntry } from '@/types/feed'
import { Wallet, Trophy, TrendingUp } from 'lucide-react'

export default function WalletStatsCard() {
  const { address } = useAccount()
  const { events } = useEvents()
  const userAddr = address ? address.toLowerCase() : undefined

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

  const enteredEvents = useMemo(() => events.filter((e) => e.type === 'EnteredPool') as FeedEntry[], [events])

  const userEntered = useMemo(() => {
    if (!userAddr) return [] as FeedEntry[]
    return enteredEvents.filter((e) => e.participant && String(e.participant).toLowerCase() === userAddr)
  }, [enteredEvents, userAddr])

  const totalContributed = useMemo(() => userEntered.reduce((s, e) => s + amtToHBAR(e.amount), 0), [userEntered])

  const poolsEntered = useMemo(() => {
    const s = new Set<string>()
    for (const e of userEntered) {
      const txKey =
        e.txHash ??
        (e as unknown as { transaction_id?: string }).transaction_id ??
        `${e.blockNumber ?? ''}-${e.logIndex ?? ''}-${e.timestamp ?? ''}`
      if (typeof e.roundId === 'number') s.add(String(e.roundId))
      else s.add(txKey)
    }
    return s.size
  }, [userEntered])

  const wins = useMemo(
    () => events.filter((e) => e.type === 'WinnerPicked' && e.winner && String(e.winner).toLowerCase() === userAddr).length,
    [events, userAddr]
  )

  // Lightweight debug to inspect WinnerPicked events and their roundId/prize shapes
  try {
    const winnerEvents = (events?.filter((ev) => ev.type === 'WinnerPicked') ?? []) as unknown[]
    const winnerEventsSample = winnerEvents.slice(0, 5).map((ev) => {
      const asRec = ev as { prize?: bigint | number; amount?: bigint | number; winner?: string; roundId?: number }
      const asWinner = ev as { winner?: string }
      return {
        winner: asWinner.winner,
        prize: asRec.prize ?? asRec.amount,
        roundId: asRec.roundId,
        roundIdType: typeof asRec.roundId
      }
    })
    // Summary (existing)
    console.debug('WalletStats debug', {
      winnerEventsTotal: winnerEvents.length,
      winnerEventsSample
    })

    // Full sample for deeper inspection (print first 10 full event objects)
    try {
      // Avoid potential circular structure issues by attempting shallow stringification,
      // but also log the raw objects as a fallback when stringify fails.
      const sample = winnerEvents.slice(0, 10)
      try {
        console.debug('WalletStats debug - winnerEventsSampleFull (stringified):', JSON.stringify(sample, (_k, v) => {
          // Convert BigInt to string for safe stringify
          if (typeof v === 'bigint') return v.toString()
          return v
        }, 2))
      } catch {
        console.debug('WalletStats debug - winnerEventsSampleFull (raw):', sample)
      }
    } catch {}
  } catch {}

  const winRatePercent = useMemo(() => {
    if (poolsEntered === 0) return 0
    return Math.round((wins / poolsEntered) * 100)
  }, [wins, poolsEntered])

  const totalWinnings = useMemo(() => {
    return events.reduce((s, e) => {
      if (e.type === 'WinnerPicked' && e.winner && String(e.winner).toLowerCase() === userAddr) {
        // prize may be stored as `prize` or `amount` depending on source
        const p: bigint | number = (e.prize ?? e.amount ?? 0) as bigint | number
        return s + amtToHBAR(p)
      }
      return s
    }, 0)
  }, [events, userAddr])

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="p-4">
        <h3 className="text-base font-semibold">Wallet Stats</h3>

        <div className="mt-3">
          {/* WINS - primary metric */}
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-muted-foreground opacity-70" />
              <span className="text-sm text-muted-foreground">Wins</span>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium text-foreground">{wins} Wins</div>
            </div>
          </div>

          <div className="border-t border-muted-foreground/20 my-3" />

          {/* Win Rate */}
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-muted-foreground opacity-70" />
              <span className="text-sm text-muted-foreground">Win Rate</span>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium text-foreground">{winRatePercent}%</div>
            </div>
          </div>

          <div className="border-t border-muted-foreground/20 my-3" />

          {/* Invested */}
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wallet className="w-4 h-4 text-muted-foreground opacity-70" />
              <span className="text-sm text-muted-foreground">Invested</span>
            </div>
            <div className="text-right">
              <span className="text-sm font-medium text-foreground">
                {totalContributed > 0
                  ? `${totalContributed.toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR`
                  : '—'}
              </span>
            </div>
          </div>

          <div className="border-t border-muted-foreground/20 my-3" />

          {/* Total Entries */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-muted-foreground opacity-70" />
              <span className="text-sm text-muted-foreground">Total Entries</span>
            </div>
            <div className="text-right">
              <span className="text-sm font-medium text-foreground">{poolsEntered} Entries</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}