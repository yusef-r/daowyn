'use client'

import React, { createContext, useContext, useEffect, useMemo, useState, useRef, useCallback } from 'react'
import type { FeedEntry } from '@/types/feed'
import { fetchHistoryEntries } from '@/lib/mirror'
import { useLotteryEvents } from '@/hooks/useLotteryEvents'

type EventsContextValue = {
  events: FeedEntry[]
  latest?: FeedEntry
  degraded: boolean
  refetchHistory: () => Promise<void>
}

const EventsContext = createContext<EventsContextValue | undefined>(undefined)

function amtToHBAR(a?: bigint | number) {
  if (a === undefined || a === null) return 0
  if (typeof a === 'bigint') {
    try {
      // bigint represents tinybars (8 decimals)
      return Number(a) / 1e8
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

export function EventsProvider({ children }: { children: React.ReactNode }) {

  // Local merged state: history + live
  const [merged, setMerged] = useState<FeedEntry[]>([])
  const seenRef = useRef<Set<string>>(new Set())
  const [degraded, setDegraded] = useState(false)
  const lastSeenBlockRef = useRef<number | undefined>(undefined)
  const isFetchingRef = useRef(false)

  // Keying function for dedupe: prefer txHash+logIndex, fallback to timestamp-logIndex
  const keyFor = (e: FeedEntry) => {
    const tx = e.txHash ?? (e as unknown as { transaction_id?: string })?.transaction_id
    const idx = typeof e.logIndex === 'number' ? e.logIndex : 0
    if (tx) return `${String(tx)}:${String(idx)}`
    // Expect e.timestamp to be normalized to milliseconds at mapping time.
    const ts = e.timestamp ?? Date.now()
    return `ts:${String(ts)}:${String(idx)}`
  }

  // Merge function: prepend new entries, dedupe, sort by timestamp/blockNumber desc
  const mergeAndSet = useCallback((incoming: FeedEntry[]) => {
    const s = seenRef.current
    const accumulated: FeedEntry[] = []
 
    for (const e of incoming) {
      const k = keyFor(e)
      if (s.has(k)) continue
      s.add(k)
      accumulated.push(e)
      // update lastSeenBlockRef if available - handle number|bigint safely
      const bn = e.blockNumber
      if (typeof bn === 'bigint') {
        const n = Number(bn)
        lastSeenBlockRef.current = lastSeenBlockRef.current ? Math.max(lastSeenBlockRef.current, n) : n
      } else if (typeof bn === 'number') {
        lastSeenBlockRef.current = lastSeenBlockRef.current ? Math.max(lastSeenBlockRef.current, bn) : bn
      }
    }
 
    // Persist newly-seen WinnerPicked prizes to localStorage per-winner (mimics persistence of Total Entries)
    // Only process the newly accumulated items (seenRef prevented duplicates)
    try {
      for (const ev of accumulated) {
        if (ev.type === 'WinnerPicked' && ev.winner) {
          const winner = String(ev.winner).toLowerCase()
          // prize may be bigint or number (tinybars)
          const rawPrize = (ev.prize ?? ev.amount ?? 0) as bigint | number
          const prizeHBAR = amtToHBAR(rawPrize)
          if (!prizeHBAR || prizeHBAR === 0) continue
          const key = `walletStats:totalWinnings:${winner}`
          const prevRaw = localStorage.getItem(key)
          const prev = prevRaw !== null && prevRaw !== '' ? Number(prevRaw) : 0
          if (!Number.isFinite(prev)) continue
          const next = prev + prizeHBAR
          localStorage.setItem(key, String(next))
        }
      }
    } catch {
      // noop - localStorage may be unavailable in some environments
    }
 
    setMerged(prev => {
      const combined = [...accumulated, ...prev]
      combined.sort((a, b) => {
        // Use normalized timestamp (ms) only — mapping ensures timestamp is always present.
        const aTs = Number(a.timestamp ?? 0)
        const bTs = Number(b.timestamp ?? 0)
        return bTs - aTs
      })
      return combined
    })
  }, [])

  // Initial history fetch on mount
  useEffect(() => {
    let mounted = true
    const doFetch = async () => {
      if (isFetchingRef.current) return
      isFetchingRef.current = true
      try {
        // Fetch recent history (mirror util returns mapped entries + degraded flag)
        const { entries, degraded: wasDegraded } = await fetchHistoryEntries({ limit: 200 })
        if (!mounted) return
        setDegraded(wasDegraded)
        // reset seen set and merged
        seenRef.current = new Set()
        setMerged([])
        // entries may not be typed as FeedEntry yet from mirror; we cast here safely
        mergeAndSet(entries as unknown as FeedEntry[])
        // Debug: surface a short sample of fetched history entries for diagnostics
      } catch (err) {
        setDegraded(true)
      } finally {
        isFetchingRef.current = false
      }
    }
    doFetch()
    return () => {
      mounted = false
    }
  }, [mergeAndSet])

  // Lightweight polling to coalesce new history (Mirror Node) every 5s
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        if (isFetchingRef.current) return
        isFetchingRef.current = true
        try {
          const startBlock = lastSeenBlockRef.current ? Math.max(0, lastSeenBlockRef.current - 2) : undefined
          const { entries, degraded: wasDegraded } = await fetchHistoryEntries({ startBlock, limit: 200 })
          setDegraded(wasDegraded)
          mergeAndSet(entries as unknown as FeedEntry[])
          // Debug: sample of polled entries
        } catch {
          setDegraded(true)
        } finally {
          isFetchingRef.current = false
        }
      })()
    }, 5000)
    return () => clearInterval(id)
  }, [mergeAndSet])

  // Exposed refetchHistory for reconnect/backfill
  const refetchHistory = useCallback(async () => {
    if (isFetchingRef.current) return
    isFetchingRef.current = true
    try {
      const startBlock = lastSeenBlockRef.current ? Math.max(0, lastSeenBlockRef.current - 2) : undefined
      const { entries, degraded: wasDegraded } = await fetchHistoryEntries({ startBlock, limit: 500 })
      setDegraded(wasDegraded)
      mergeAndSet(entries as unknown as FeedEntry[])
      // Debug: sample of refetched entries for diagnostics
    } catch {
      setDegraded(true)
    } finally {
      isFetchingRef.current = false
    }
  }, [mergeAndSet])

  // Merge live watcher events (client-side) so consumers see WinnerPicked and other live-only events.
  // useLotteryEvents subscribes to contract events; merge its mapped FeedEntry[] into our canonical feed.
  const { events: liveEvents } = useLotteryEvents()
  useEffect(() => {
    if (!Array.isArray(liveEvents) || liveEvents.length === 0) return
    // mergeAndSet will dedupe and prepend
    mergeAndSet(liveEvents)
  }, [liveEvents, mergeAndSet])

  const value = useMemo(
    () => ({
      events: merged,
      latest: merged[0],
      degraded,
      refetchHistory
    }),
    [merged, degraded, refetchHistory]
  )

  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
}

export function useEvents() {
  const ctx = useContext(EventsContext)
  if (!ctx) throw new Error('useEvents must be used within EventsProvider')
  return ctx
}