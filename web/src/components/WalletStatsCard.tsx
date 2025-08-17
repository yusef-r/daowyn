'use client'

import React, { useMemo } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import { useEvents } from '@/app/providers/events'
import type { FeedEntry } from '@/types/feed'

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
      if (typeof e.roundId === 'number') s.add(String(e.roundId))
      else s.add(`${e.txHash ?? e.logIndex ?? Math.random()}`)
    }
    return s.size
  }, [userEntered])

  const wins = useMemo(
    () => events.filter((e) => e.type === 'WinnerPicked' && e.winner && String(e.winner).toLowerCase() === userAddr).length,
    [events, userAddr]
  )

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
        <div className="mt-3 space-y-3">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total contributed</span>
            <span className="font-medium">
              {totalContributed > 0 ? `${totalContributed.toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR` : '—'}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-muted-foreground">Win record</span>
            <span className="font-medium">
              {`${poolsEntered} | Wins: ${wins}`}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-muted-foreground">Total earnings</span>
            <span className="font-medium">
              {totalWinnings > 0 ? `${totalWinnings.toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR` : '—'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}