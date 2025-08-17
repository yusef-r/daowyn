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
    const ts = e.timestamp ?? e.blockNumber ?? Date.now()
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

    setMerged(prev => {
      const combined = [...accumulated, ...prev]
      combined.sort((a, b) => {
        const aTs = Number(a.timestamp ?? (typeof a.blockNumber === 'number' ? a.blockNumber : 0))
        const bTs = Number(b.timestamp ?? (typeof b.blockNumber === 'number' ? b.blockNumber : 0))
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
        try { console.debug('[events provider] fetched history entries sample', (entries ?? []).slice(0, 10)) } catch {}
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
          try { console.debug('[events provider] polled history entries sample', (entries ?? []).slice(0, 10)) } catch {}
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
      try { console.debug('[events provider] refetched history entries sample', (entries ?? []).slice(0, 10)) } catch {}
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
    try { console.debug('[events provider] merging live events sample', (liveEvents ?? []).slice(0, 10)) } catch {}
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