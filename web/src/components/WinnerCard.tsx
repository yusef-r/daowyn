'use client'
import { useMemo } from 'react'
import { formatUnits } from 'viem'
import useLotteryReads from '@/hooks/useLotteryReads'
import { useLotteryEvents } from '@/hooks/useLotteryEvents'
import { getExplorerTxUrl } from '@/lib/mirror'
import type { FeedEntry } from '@/types/feed'

type Props = {
  className?: string
  limit?: number
}

/**
 * Reworked to show a list of recent WinnerPicked events (most-recent-first),
 * each entry shows short address, prize (if available) and a tx explorer link.
 */
export default function WinnerCard({ className, limit = 5 }: Props) {
  const { loading, error } = useLotteryReads()
  const { events } = useLotteryEvents()

  const recentWinners = useMemo<FeedEntry[] | undefined>(() => {
    if (!Array.isArray(events) || events.length === 0) return undefined
    return events.filter((e) => e.type === 'WinnerPicked').slice(0, limit)
  }, [events, limit])

  const formatShort = (addr?: string) => {
    if (!addr || typeof addr !== 'string') return String(addr ?? '')
    return addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr
  }

  const formatPrize = (p?: bigint | number) => {
    if (p === undefined) return undefined
    const num = typeof p === 'bigint' ? Number(formatUnits(p as bigint, 8)) : Number(p)
    return num.toLocaleString(undefined, { maximumFractionDigits: 6 })
  }

  const content = useMemo(() => {
    if (loading) {
      return (
        <div className="space-y-2">
          <div className="h-6 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-5 w-28 animate-pulse rounded-full bg-muted" />
        </div>
      )
    }
    if (error) {
      return (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          Failed to load recent winners
        </div>
      )
    }

    if (recentWinners && recentWinners.length > 0) {
      return (
        <ul className="space-y-2">
          {recentWinners.map((ev, idx) => {
            const winner = ev.winner ?? ev.participant ?? 'Unknown'
            const prize = formatPrize(ev.prize ?? ev.amount)
            const key = ev.txHash ?? `${idx}`
            return (
              <li
                key={key}
                className="flex items-center justify-between gap-4 rounded-md border bg-card/50 p-3"
              >
                <div>
                  <div className="text-sm font-mono">{formatShort(String(winner))}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {prize !== undefined ? `${prize} HBAR` : 'Winner recorded'}
                  </div>
                </div>

                {ev.txHash ? (
                  <a
                    className="text-sm underline"
                    href={getExplorerTxUrl(String(ev.txHash))}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View tx
                  </a>
                ) : (
                  <div className="text-xs text-muted-foreground">No tx</div>
                )}
              </li>
            )
          })}
        </ul>
      )
    }

    return <div className="text-sm text-muted-foreground">No winners yet</div>
  }, [loading, error, recentWinners])

  return (
    <div className={`rounded-lg border bg-card text-card-foreground shadow-sm ${className ?? ''}`}>
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Recent Winners</h3>
            <p className="text-sm text-muted-foreground mt-1">Latest prize winners (most recent first)</p>
          </div>
        </div>

        <div className="mt-4">{content}</div>
      </div>
    </div>
  )
}