'use client'

import React, { useMemo, useState } from 'react'
import { useEvents } from '@/app/providers/events'
import { getExplorerTxUrl, getExplorerAccountUrl } from '@/lib/mirror'
import type { FeedEntry } from '@/types/feed'
import { formatUnits } from 'viem'

function formatAmount(a?: bigint | number) {
  try {
    if (a === undefined || a === null) return ''
    let hbar: number
    if (typeof a === 'bigint') {
      // Contract emits tinybars (8 decimals) in events
      hbar = Number(formatUnits(a, 8))
    } else {
      if (!Number.isFinite(a)) return ''
      // Numbers passed here represent tinybars as well
      hbar = a / 1e8
    }
    return `${hbar.toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR`
  } catch {
    return String(a)
  }
}

export default function ActivityFeed() {
  const { events, degraded } = useEvents()
  const [filterType, setFilterType] = useState<'All' | 'EnteredPool' | 'OverageRefunded' | 'WinnerPicked'>('All')
  const [q, setQ] = useState('')
  const [timeWindowHours, setTimeWindowHours] = useState<number | undefined>(24)

  const filtered = useMemo(() => {
    const now = Date.now()
    return (events as FeedEntry[]).filter((e) => {
      if (filterType !== 'All' && e.type !== filterType) return false
      if (q) {
        const ql = q.toLowerCase()
        const hay = JSON.stringify(e).toLowerCase()
        if (!hay.includes(ql)) return false
      }
      if (timeWindowHours) {
        const ts = Number(e.timestamp ?? (typeof e.blockNumber === 'number' ? e.blockNumber : 0))
        const cutoff = now - timeWindowHours * 3600 * 1000
        if (ts && ts < cutoff) return false
      }
      return true
    })
  }, [events, filterType, q, timeWindowHours])

  return (
    <div className="activity-feed" aria-live="polite">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <label>
          Type:
          <select
            value={filterType}
            onChange={(ev: React.ChangeEvent<HTMLSelectElement>) =>
              setFilterType(ev.target.value as 'All' | 'EnteredPool' | 'OverageRefunded' | 'WinnerPicked')
            }
            aria-label="Filter by event type"
            style={{ marginLeft: 8 }}
          >
            <option value="All">All</option>
            <option value="EnteredPool">EnteredPool</option>
            <option value="OverageRefunded">OverageRefunded</option>
            <option value="WinnerPicked">WinnerPicked</option>
          </select>
        </label>

        <label>
          Search:
          <input aria-label="Search events" value={q} onChange={(ev) => setQ(ev.target.value)} placeholder="address, tx, amount..." style={{ marginLeft: 8 }} />
        </label>

        <label>
          Window:
          <select value={String(timeWindowHours ?? '')} onChange={(ev) => setTimeWindowHours(ev.target.value === '' ? undefined : Number(ev.target.value))} aria-label="Time window hours" style={{ marginLeft: 8 }}>
            <option value={24}>24h</option>
            <option value={72}>72h</option>
            <option value={168}>7d</option>
            <option value="">All</option>
          </select>
        </label>
      </div>

      {degraded && (
        <div role="status" aria-live="assertive" style={{ background: '#fff3cd', color: '#856404', padding: 8, borderRadius: 6, marginBottom: 12 }}>
          Mirror Node history is degraded — showing live events only. We will keep retrying in the background.
        </div>
      )}

      <div>
        {filtered.length === 0 ? (
          <div style={{ padding: 16, color: '#666' }}>No events found.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {filtered.map((e, i) => {
              const entry = e as FeedEntry
              const ts = entry.timestamp ? new Date(Number(entry.timestamp)) : undefined
              const tx = entry.txHash
              const logIndex = entry.logIndex
              return (
                <li key={`${tx ?? i}-${logIndex ?? 0}`} style={{ padding: 12, borderBottom: '1px solid #eee' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <strong>{entry.type}</strong>
                      <div style={{ fontSize: 13, color: '#666' }}>
                        {entry.type === 'EnteredPool' && entry.participant && (
                          <>
                            Participant: <a href={getExplorerAccountUrl(entry.participant)} target="_blank" rel="noreferrer">{entry.participant}</a>
                            {' • '}Amount: {formatAmount(entry.amount)}
                          </>
                        )}
                        {entry.type === 'OverageRefunded' && entry.participant && (
                          <>
                            Participant: <a href={getExplorerAccountUrl(entry.participant)} target="_blank" rel="noreferrer">{entry.participant}</a>
                            {' • '}Refund: {formatAmount(entry.amount)}
                          </>
                        )}
                        {entry.type === 'WinnerPicked' && entry.winner && (
                          <>
                            Winner: <a href={getExplorerAccountUrl(entry.winner)} target="_blank" rel="noreferrer">{entry.winner}</a>
                            {' • '}Prize: {formatAmount(entry.prize)}
                          </>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 150 }}>
                      <div style={{ fontSize: 12, color: '#666' }}>{ts ? ts.toLocaleString() : '—'}</div>
                      <div style={{ marginTop: 6 }}>
                        {tx ? (
                          <a href={getExplorerTxUrl(String(tx))} target="_blank" rel="noreferrer">View tx</a>
                        ) : (
                          <span style={{ color: '#999', fontSize: 12 }}>No tx</span>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}