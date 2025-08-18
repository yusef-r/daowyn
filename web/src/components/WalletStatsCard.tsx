'use client'

import React, { useMemo, useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import { useEvents } from '@/app/providers/events'
import type { FeedEntry } from '@/types/feed'
import { Wallet, Trophy, TrendingUp } from 'lucide-react'

export default function WalletStatsCard() {
  const { address } = useAccount()
  const { events } = useEvents()
  const userAddr = address ? address.toLowerCase() : undefined

  // Persist per-wallet total winnings to localStorage so it survives page refreshes
  const [cachedWinnings, setCachedWinnings] = useState<number | undefined>(undefined)

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

  // Load cached winnings on user/address change
  useEffect(() => {
    if (!userAddr) {
      setCachedWinnings(undefined)
      return
    }
    try {
      const key = `walletStats:totalWinnings:${userAddr}`
      const raw = localStorage.getItem(key)
      if (raw !== null) {
        const n = Number(raw)
        if (Number.isFinite(n)) setCachedWinnings(n)
      }
    } catch {
      // noop
    }
  }, [userAddr])

  // Update cache when we observe a non-zero totalWinnings greater than what's cached
  useEffect(() => {
    if (!userAddr) return
    try {
      const key = `walletStats:totalWinnings:${userAddr}`
      const current = cachedWinnings ?? 0
      if (totalWinnings > current) {
        localStorage.setItem(key, String(totalWinnings))
        setCachedWinnings(totalWinnings)
      }
    } catch {
      // noop
    }
  }, [totalWinnings, userAddr, cachedWinnings])

  // Prefer the higher of observed totalWinnings and cachedWinnings so value survives refreshes
  const displayedWinnings = Math.max(totalWinnings, cachedWinnings ?? 0)

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow">
      <div className="p-4">
        <h3 className="text-base font-semibold section-heading panel-title">Wallet Stats</h3>

        <div className="mt-3">
          {/* TOTAL WINNINGS - primary metric */}
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-muted-foreground opacity-70" />
              <span className="text-sm text-muted-foreground">Total Winnings</span>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium text-foreground">
                {displayedWinnings > 0
                  ? `${displayedWinnings.toLocaleString(undefined, { maximumFractionDigits: 2 })} HBAR`
                  : '—'}
              </div>
            </div>
          </div>

          <div className="border-t border-muted-foreground/20 my-3" />

          {/* Average Entry */}
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-muted-foreground opacity-70" />
              <span className="text-sm text-muted-foreground">Average Entry</span>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium text-foreground">
                {poolsEntered > 0
                  ? `${(totalContributed / poolsEntered).toLocaleString(undefined, { maximumFractionDigits: 2 })} HBAR`
                  : '—'}
              </div>
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
                  ? `${totalContributed.toLocaleString(undefined, { maximumFractionDigits: 2 })} HBAR`
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
