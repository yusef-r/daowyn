'use client'
import { useMemo } from 'react'
import useLotteryReads from '@/hooks/useLotteryReads'

type Props = {
  className?: string
}

/**
 * Phase 1 placeholder:
 * - Displays "No winner yet" until we wire real events/history in a later phase.
 * - Keeps consistent card styling with StatusCard.
 */
export default function WinnerCard({ className }: Props) {
  const { loading, error } = useLotteryReads()

  const content = useMemo(() => {
    if (loading) {
      return (
        <div className="space-y-2">
          <div className="h-6 w-40 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-56 animate-pulse rounded-md bg-muted" />
        </div>
      )
    }
    if (error) {
      return (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          Failed to load recent winner
        </div>
      )
    }
    return (
      <div className="text-sm text-muted-foreground">
        No winner yet
      </div>
    )
  }, [loading, error])

  return (
    <div className={`rounded-lg border bg-card text-card-foreground shadow-sm ${className ?? ''}`}>
      <div className="p-4">
        <h3 className="text-base font-semibold">Last Winner</h3>
        <p className="text-sm text-muted-foreground">Most recent prize winner</p>
      </div>
      <div className="p-4 pt-0">
        {content}
      </div>
    </div>
  )
}