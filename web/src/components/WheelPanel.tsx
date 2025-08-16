'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLotteryData } from '@/context/LotteryDataContext'

type DrawSeg = {
  id: string
  addressLower: `0x${string}`
  percent: number
  startDeg: number
  endDeg: number
  label?: string
}

function addrShort(a?: string) {
  if (!a) return 'Others'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// Deterministic color palette by index (no randomness; stable ordering from server)
const PALETTE = [
  '#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#84cc16', '#d946ef', '#f97316', '#22c55e',
  '#6366f1', '#14b8a6', '#eab308', '#f43f5e', '#a855f7',
]

// Build an SVG arc path from start/end degrees without recomputing any angles
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const toRad = (deg: number) => (Math.PI / 180) * (deg - 90) // rotate so 0deg is at 12 o'clock
  const s = toRad(startDeg)
  const e = toRad(endDeg)
  const x1 = cx + r * Math.cos(s)
  const y1 = cy + r * Math.sin(s)
  const x2 = cx + r * Math.cos(e)
  const y2 = cy + r * Math.sin(e)
  // Sweep is always clockwise per server ordering; large-arc flag if sweep > 180
  let delta = endDeg - startDeg
  if (delta < 0) delta += 360
  const largeArc = delta > 180 ? 1 : 0
  const sweep = 1
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} ${sweep} ${x2} ${y2} Z`
}

function LegendRow({ seg, color }: { seg: DrawSeg; color: string }) {
  const label = seg.label ?? addrShort(seg.addressLower)
  const pct = typeof seg.percent === 'number' ? `${seg.percent.toFixed(2)}%` : '0%'
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-block size-3 rounded-sm" style={{ background: color }} />
        <span className="truncate" title={label}>{label}</span>
      </div>
      <div className="tabular-nums text-muted-foreground">{pct}</div>
    </div>
  )
}

export default function WheelPanel({ className = '' }: { className?: string }) {
  // Server snapshot is the single source of truth
  const { snap } = useLotteryData()
  const { isStale, isDrawing, roundId, stageIndex, layout, layoutHash, segmentsHash, spin } = snap as typeof snap & { spin?: {
    phase: 'idle' | 'neutral' | 'landing' | 'done'
    neutralStartAt?: number
    revealTargetAt?: number
    landingPlan?: {
      layoutHash: string
      targetSegmentId: string
      startAt: number
      durationMs: number
      easing: 'easeOutCubic'
      rotations: number
    }
  } }
  
  // Debug instrumentation: surface server snapshot fields in browser console for diagnosis
  try {
    const snapObj = snap as unknown as { segments?: Array<Record<string, unknown>> };
    console.debug('[WheelPanel.snap]', {
      segmentsLength: Array.isArray(snapObj.segments) ? snapObj.segments.length : 0,
      firstSegment: Array.isArray(snapObj.segments) ? (snapObj.segments[0] ?? null) : null,
      segmentsHash,
      layoutHash,
      spinPhase: spin?.phase ?? null,
    });
  } catch (e) {
    // swallow logging errors in production-like builds
    console.debug('[WheelPanel.snap] logging error', e);
  }

  const isFilling = stageIndex === 0
  const isReadyStage = stageIndex === 1

  // Stable primitives for spin/plan to avoid broad object deps
  const phase = spin?.phase
  const neutralStartAt = spin?.neutralStartAt
  const revealTargetAt = spin?.revealTargetAt
  const lp = spin?.landingPlan
  const lpLayoutHash = lp?.layoutHash
  const lpTargetSegmentId = lp?.targetSegmentId
  const lpStartAt = lp?.startAt
  const lpDurationMs = lp?.durationMs
  const lpRotations = lp?.rotations

  const normSegments = useMemo(
    () =>
      (snap as unknown as {
        segments?: { address: `0x${string}`; start: number; end: number }[]
      }).segments ?? [],
    [snap]
  )
  
  // Build draw segments from normalized fractions (0..1) provided by server
  const drawSegments: DrawSeg[] = useMemo(() => {
    return normSegments.map((s) => {
      const startDeg = Number(s.start) * 360
      const endDeg = Number(s.end) * 360
      const percent = Math.max(0, (Number(s.end) - Number(s.start)) * 100)
      const addressLower = (s.address as string).toLowerCase() as `0x${string}`
      return {
        id: `addr:${addressLower}`,
        addressLower,
        percent,
        startDeg,
        endDeg,
        label: `${addrShort(addressLower)} • ${percent.toFixed(2)}%`,
      }
    })
  }, [normSegments])
  
  // Stable view-model keyed by server-provided order; no client re-sorting or angle math
  const vm = useMemo(() => {
    return drawSegments.map((seg, i) => ({
      key: `${seg.id}:${i}`, // deterministic across equal inputs
      seg,
      color: PALETTE[i % PALETTE.length],
    }))
  }, [drawSegments])

  // -----------------------
  // Cinematic rotation logic
  // -----------------------

  // One-time server-time offset estimate.
  // We prefer x-now header from server, but since the hook doesn't expose headers, we estimate using absolute server fields.
  // Strategy: at first sight of spin (neutral/landing), align local clock so that neutralStartAt maps consistently.
  const serverOffsetRef = useRef(0)
  const offsetSeededRef = useRef(false)

  useEffect(() => {
    if (offsetSeededRef.current) return
    // If server emitted absolute ms fields, seed an offset once to align our local clock.
    const nsa = typeof neutralStartAt === 'number' ? neutralStartAt : undefined
    if (typeof nsa === 'number' && nsa > 0) {
      serverOffsetRef.current = nsa - Date.now()
      offsetSeededRef.current = true
    } else {
      // Fallback: when we enter ready stage without a timestamp, assume no offset (tabs on same machine will align)
      if (typeof stageIndex === 'number' && stageIndex >= 1) {
        serverOffsetRef.current = 0
        offsetSeededRef.current = true
      }
    }
  }, [neutralStartAt, stageIndex])


  // Seed angle derived inside the animation effect from layoutHash

  const NEUTRAL_DPS = 120 // deg per second, deterministic

  // Geometry cache keyed only by layoutHash (no array deps inside effect)
  const geomRef = useRef<{ hash?: string | null; byId: Record<string, { startDeg: number; endDeg: number }> }>({
    hash: undefined,
    byId: {},
  })
  const layoutKey = (typeof stageIndex === 'number' && stageIndex === 0 ? (segmentsHash ?? null) : (layoutHash ?? null))
  if (geomRef.current.hash !== layoutKey) {
    const byId: Record<string, { startDeg: number; endDeg: number }> = {}
    const segs = Array.isArray(layout?.segments) ? layout!.segments : []
    for (const s of segs) {
      const id = s?.id
      if (!id) continue
      byId[id] = { startDeg: Number(s.startDeg ?? 0), endDeg: Number(s.endDeg ?? 0) }
    }
    geomRef.current = { hash: layoutKey, byId }
  }

  // Landing plan derived from server spin.landingPlan + current layout
  type Plan = { startAt: number; duration: number; startAngle: number; endAngle: number; layoutHash: string }
  const planRef = useRef<Plan | null>(null)
  const lpKeyRef = useRef<string | undefined>(undefined)
  const [angle, setAngle] = useState<number>(0)

  useEffect(() => {
    let raf = 0

    // Compute seed angle locally from layoutHash for stability
    let seedDegLocal = 0
    {
      const s = String((typeof stageIndex === 'number' && stageIndex === 0 ? (segmentsHash ?? '') : (layoutHash ?? '')))
      if (s) {
        const head = s.slice(0, 8)
        const n = Number.parseInt(head, 16)
        seedDegLocal = Number.isFinite(n) ? (n % 360) : 0
      }
    }
    const neutralAngleAt = (tMs: number, nsa: number) => seedDegLocal + NEUTRAL_DPS * Math.max(0, (tMs - nsa) / 1000)
    const normalize = (a: number) => {
      let x = a % 360
      if (x < 0) x += 360
      return x
    }

    const tick = () => {
      const nowS = Date.now() + serverOffsetRef.current
      const nsa = typeof neutralStartAt === 'number' && neutralStartAt > 0 ? neutralStartAt : undefined

      // Prepare plan from server landingPlan when available and layout matches
      const rta = typeof revealTargetAt === 'number' && revealTargetAt > 0 ? revealTargetAt : undefined
      const layoutOk = layoutHash && lpLayoutHash && layoutHash === lpLayoutHash
      const targetSegId = layoutOk ? lpTargetSegmentId : undefined
      const targetAngle = targetSegId ? (() => {
        const seg = geomRef.current.byId[targetSegId!]
        if (!seg) return undefined as number | undefined
        const center = ((Number(seg.startDeg ?? 0) + Number(seg.endDeg ?? 0)) / 2) % 360
        let x = (-center) % 360
        if (x < 0) x += 360
        return x
      })() : undefined

      if (layoutOk && typeof targetAngle === 'number' && typeof lpStartAt === 'number' && typeof lpDurationMs === 'number' && (!rta || nowS >= rta)) {
        const newKey = `${lpLayoutHash}|${targetSegId}|${lpStartAt}|${lpDurationMs}|${(lpRotations ?? 0)}`
        const needsRebuild = !planRef.current || planRef.current.layoutHash !== layoutHash || lpKeyRef.current !== newKey
        if (needsRebuild) {
          // Starting angle: where neutral spin would be at lpStartAt
          const nsaEff = nsa ?? nowS
          const currentAngleAtStart = normalize(neutralAngleAt(lpStartAt, nsaEff))
          const baseTarget = targetAngle

          // Ensure forward rotation ending at baseTarget with extra full rotations
          let delta = baseTarget - currentAngleAtStart
          while (delta <= 0) delta += 360
          delta += Math.max(0, ((lpRotations ?? 0) | 0)) * 360

          const endAngle = currentAngleAtStart + delta
          planRef.current = {
            startAt: lpStartAt,
            duration: Math.max(200, lpDurationMs),
            startAngle: currentAngleAtStart,
            endAngle,
            layoutHash: layoutHash!,
          }
          lpKeyRef.current = newKey
        }
      } else {
        // No landing plan (yet) — keep neutral spin
        if (planRef.current && phase !== 'landing') {
          planRef.current = null
          lpKeyRef.current = undefined
        }
      }

      const plan = planRef.current

      if (plan) {
        // Late joiners: snap if already past the end
        if (nowS >= plan.startAt + plan.duration) {
          setAngle(plan.endAngle)
        } else if (nowS < plan.startAt) {
          // Before plan start: continue neutral spin until start
          const nsaEff = nsa ?? nowS
          setAngle(neutralAngleAt(nowS, nsaEff))
        } else {
          const p = Math.max(0, Math.min(1, (nowS - plan.startAt) / plan.duration))
          const eased = 1 - Math.pow(1 - p, 3) // easeOutCubic
          const a = plan.startAngle + (plan.endAngle - plan.startAngle) * eased
          setAngle(a)
        }
      } else {
        // Neutral or idle phase
        if (typeof phase === 'string' && (phase === 'neutral' || phase === 'idle' || phase === 'done')) {
          const nsaEff2 = nsa ?? nowS
          setAngle(neutralAngleAt(nowS, nsaEff2))
        } else {
          // Unknown: hold steady
          setAngle(prev => prev)
        }
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [
    phase,
    neutralStartAt,
    revealTargetAt,
    lpLayoutHash,
    lpTargetSegmentId,
    lpStartAt,
    lpDurationMs,
    lpRotations,
    layoutHash,
    segmentsHash,
  ])

  // Header badges
  const statusBadge = isDrawing
    ? { text: 'Drawing…', cls: 'bg-red-100 text-red-700' }
    : isReadyStage
      ? { text: 'Frozen', cls: 'bg-amber-100 text-amber-700' }
      : { text: 'Live', cls: 'bg-green-100 text-green-700' }

  return (
    <div className={`rounded-lg border bg-card text-card-foreground shadow-sm ${className}`} data-layout-hash={layoutHash ?? undefined}>
      <div className="flex items-center justify-between p-4">
        <div>
          <h3 className="text-base font-semibold">Wheel</h3>
          <p className="text-sm text-muted-foreground">
            Round {typeof roundId === 'number' ? roundId : '—'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs ${statusBadge.cls}`}>
            {statusBadge.text}
          </span>
          {isStale ? (
            <span
              className="inline-block h-2 w-2 rounded-full bg-amber-500"
              title="stale"
              aria-label="stale"
            />
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 pt-0 md:grid-cols-5">
        <div className="md:col-span-3 flex items-center justify-center">
          <div className="relative">
            {/* Drawing placeholder: subtle ring, do not imply winner */}
            {isDrawing && drawSegments.length === 0 ? (
              <div className="size-64 rounded-full border-8 border-muted" aria-hidden />
            ) : (
              <svg
                key={String((typeof stageIndex === 'number' && stageIndex === 0 ? (segmentsHash ?? '') : (layoutHash ?? '')))}
                viewBox="0 0 200 200"
                width="100%"
                height="100%"
                className="max-h-80 max-w-80"
                role="img"
                aria-label="Prize wheel"
              >
                <title>Prize wheel</title>
                <desc>Server-provided layout with deterministic segments and angles</desc>
                <circle cx="100" cy="100" r="100" fill="transparent" />
                {vm.length === 0 ? (
                  <circle cx="100" cy="100" r="96" fill="#e5e7eb" />
                ) : (
                  <g transform={`rotate(${angle} 100 100)`}>
                    {vm.map(({ key, seg, color }) => (
                      <path
                        key={key}
                        d={arcPath(100, 100, 96, Number(seg.startDeg ?? 0), Number(seg.endDeg ?? 0))}
                        fill={color}
                        stroke="white"
                        strokeWidth="1"
                      />
                    ))}
                  </g>
                )}
                {/* Center hub */}
                <circle cx="100" cy="100" r="20" fill="white" stroke="#e5e7eb" />
              </svg>
            )}
          </div>
        </div>

        <div className="md:col-span-2">
          <div className="text-sm text-muted-foreground mb-2">
            {isFilling ? 'Live resizing from entries' : isReadyStage ? 'Layout frozen for draw' : isDrawing ? 'Drawing in progress' : '—'}
          </div>
          {/* Legend for quick labels */}
          <div className="divide-y">
            {vm.length === 0 ? (
              <div className="text-sm text-muted-foreground">No entries yet</div>
            ) : (
              vm.map(({ key, seg, color }) => <LegendRow key={key} seg={seg} color={color} />)
            )}
          </div>

          {/* Accessibility table for screen readers */}
          <div className="sr-only" aria-live="polite">
            <table>
              <thead>
                <tr>
                  <th>Segment</th>
                  <th>Percent</th>
                  <th>Start(deg)</th>
                  <th>End(deg)</th>
                </tr>
              </thead>
              <tbody>
                {drawSegments.map((s, i) => (
                  <tr key={`${s.id}:${i}`}>
                    <td>{addrShort(s.addressLower)}</td>
                    <td>{typeof s.percent === 'number' ? s.percent.toFixed(2) : '0.00'}%</td>
                    <td>{Number(s.startDeg ?? 0).toFixed(2)}</td>
                    <td>{Number(s.endDeg ?? 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}