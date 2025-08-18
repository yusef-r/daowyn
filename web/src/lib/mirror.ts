/* web/src/lib/mirror.ts
   Mirror Node helper to fetch contract logs and map them to LotteryEvent-like feed entries.
   - Exports fetchLogsForEvents(startBlock?, endBlock?, sinceTimestamp?) to backfill history
   - Exports mapMirrorLogToEntry to convert Mirror log JSON to feed entry
   - Implements simple exponential backoff for 429/5xx
   - Uses NEXT_PUBLIC_MIRROR_BASE from env
 */

import type { FeedEntry } from '@/types/feed'
import { LOTTERY_ADDRESS, LOTTERY_ABI } from '@/lib/contracts/lottery'
import { decodeEventLog } from 'viem'
/* eslint-disable @typescript-eslint/no-explicit-any */

// Mirror Node base URL should be provided in env
// Mirror base + helpers
const MIRROR_BASE =
  process.env.NEXT_PUBLIC_MIRROR_BASE ??
  'https://testnet.mirrornode.hedera.com';

const isHexAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

export async function resolveEvmAddress(contractIdOrEvm: string): Promise<string> {
  if (isHexAddress(contractIdOrEvm)) return contractIdOrEvm.toLowerCase();

  const res = await fetch(
    `${MIRROR_BASE}/api/v1/contracts/${encodeURIComponent(contractIdOrEvm)}`
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mirror: failed to resolve EVM address (${res.status}) ${body}`);
  }
  const json = await res.json();
  const evm = (json?.evm_address ?? '').toLowerCase();
  if (!isHexAddress(evm)) throw new Error('Mirror: invalid evm_address from resolver');
  return evm;
}

// Minimal typed shape for Mirror logs we care about
type MirrorLog = {
  consensus_timestamp?: string
  transaction_hash?: string
  transaction_id?: string
  log_index?: number | string
  block_number?: number | string
  topic0?: string
  topics?: string[]
  data?: string
  args?: Record<string, unknown>
  [k: string]: unknown
}

// Utility: sleep
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Parse consensus_timestamp into milliseconds since epoch
function consensusTsToMs(ts: string): number {
  const [secs, nanos] = ts.split('.')
  const s = Number(secs || '0')
  const ns = Number((nanos || '0').padEnd(9, '0'))
  return s * 1000 + Math.floor(ns / 1_000_000)
}

export function normalizeToMs(v?: number | bigint | string | Date | null): number {
  // Normalize a variety of timestamp inputs to milliseconds since epoch.
  // Accepts number (seconds or ms), bigint, numeric string, "seconds.nanos" string,
  // Date instance. If conversion fails or value is absent, return Date.now().
  if (v === undefined || v === null) return Date.now()
  if (typeof v === 'number') {
    return v < 1e12 ? Math.floor(v * 1000) : Math.floor(v)
  }
  if (typeof v === 'bigint') {
    const n = Number(v)
    return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n)
  }
  if (typeof v === 'string') {
    // Mirror consensus timestamps are "seconds.nanos"
    if (/^\d+\.\d+$/.test(v)) return consensusTsToMs(v)
    const n = Number(v)
    if (Number.isFinite(n)) return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n)
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return parsed
    return Date.now()
  }
  if (v instanceof Date) return v.getTime()
  return Date.now()
}

// Build explorer base from env/chain - fallback to Hedera HashScan testnet if necessary
export function getExplorerTxUrl(txHashOrId: string) {
  const base =
    process.env.NEXT_PUBLIC_EXPLORER_BASE_URL ??
    (process.env.NEXT_PUBLIC_NETWORK === 'mainnet'
      ? 'https://hashscan.io/mainnet'
      : 'https://hashscan.io/testnet')
  return `${base}/transaction/${encodeURIComponent(txHashOrId)}`
}

// Helper to construct account explorer url
export function getExplorerAccountUrl(account: string) {
  const base =
    process.env.NEXT_PUBLIC_EXPLORER_BASE_URL ??
    (process.env.NEXT_PUBLIC_NETWORK === 'mainnet'
      ? 'https://hashscan.io/mainnet'
      : 'https://hashscan.io/testnet')
  return `${base}/account/${encodeURIComponent(account)}`
}

// Narrowing helpers
function looksLikeHexAddress(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(s)
}
function normalizeAddressFromTopic(t?: string): `0x${string}` | undefined {
  if (!t) return undefined
  const s = t.startsWith('0x') ? t : `0x${t}`
  const candidate = `0x${s.slice(-40)}`
  return looksLikeHexAddress(candidate) ? (candidate as `0x${string}`) : undefined
}
function looksLikeHexTx(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(s)
}
function normalizeTxHash(h?: string): `0x${string}` | string | undefined {
  if (!h) return undefined
  if (looksLikeHexTx(h)) return h as `0x${string}`
  // Hedera transaction ids (e.g. "0.0.1234@163...") are preserved as-is
  return h
}

// Convert various numeric shapes (number | bigint | numeric string) into a safe number | undefined.
export function safeNumber(value?: number | bigint | string | null): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value !== '') {
    const n = Number(value)
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

// Map Mirror Node log object to a normalized feed entry compatible with useLotteryEvents.LotteryEvent
export function mapMirrorLogToEntry(raw: MirrorLog): FeedEntry | null {
  try {
    const topic0 = (raw.topic0 as string | undefined) ?? raw.topics?.[0] ?? ''
    const data = raw.data as string | undefined
    const transaction_hash = raw.transaction_hash as string | undefined
    const transaction_id = raw.transaction_id as string | undefined
    const log_index = raw.log_index
    const block_number = raw.block_number
    const consensus_timestamp = raw.consensus_timestamp

    // Log raw Mirror response so we can distinguish "no logs" vs "logs but mapping returned null"

    const topics = (raw.topics as string[] | undefined) ?? (raw.topic0 ? [String(raw.topic0)] : [])

    // Try ABI-based decoding first (returns on successful decode & mapping)
    try {
      // Pre-compute normalized tx/block/ts/index so ABI decoding branch can return stable keys
      const txRawForAbi = transaction_hash ?? transaction_id
      const txHashForAbi = normalizeTxHash(txRawForAbi)
      const blockNumForAbi = block_number !== undefined ? Number(String(block_number)) : undefined
      const tsForAbi = consensus_timestamp ? consensusTsToMs(consensus_timestamp) : undefined
      const idxForAbi =
        typeof log_index === 'number'
          ? log_index
          : typeof log_index === 'string'
          ? Number(log_index)
          : undefined

      for (const abiEntry of (LOTTERY_ABI as any[])) {
        if (!abiEntry || abiEntry.type !== 'event') continue
        try {
          const decoded = decodeEventLog({
            abi: [abiEntry],
            data: (data ?? '0x') as any,
            topics: (topics ?? []) as any
          }) as any
          const name = abiEntry.name
          const args = decoded?.args ?? decoded ?? {}

          const tryAddress = (v: unknown, topicIdx?: number) => {
            if (typeof v === 'string' && looksLikeHexAddress(v)) return v as `0x${string}`
            if (topicIdx !== undefined && topics?.[topicIdx]) {
              const fromTopic = normalizeAddressFromTopic(topics[topicIdx])
              if (fromTopic) return fromTopic
            }
            return undefined
          }

          if (name === 'EnteredPool') {
            const participantCandidate = args.player ?? args.participant
            const participant = tryAddress(participantCandidate, 1)
            let amount = BigInt(0)
            try {
              if (args.amountEntered !== undefined) amount = BigInt(String(args.amountEntered))
              else if (args.amount !== undefined) amount = BigInt(String(args.amount))
            } catch {}
            if (!participant) continue

            const entry: FeedEntry = {
              type: 'EnteredPool',
              txHash: typeof txHashForAbi === 'string' && looksLikeHexTx(txHashForAbi) ? (txHashForAbi as `0x${string}`) : undefined,
              logIndex: idxForAbi,
              blockNumber: blockNumForAbi,
              timestamp: normalizeToMs(tsForAbi),
              participant,
              amount,
              roundId: safeNumber(args.roundId)
            }
            // Ensure a stable transaction identifier for Hedera tx ids (mirror may return non-hex ids)
            ;(entry as any).transaction_id =
              typeof txHashForAbi === 'string' && !looksLikeHexTx(txHashForAbi) ? txHashForAbi : transaction_id ?? undefined
            return entry
          }

          if (name === 'OverageRefunded') {
            const participantCandidate = args.player ?? args.participant
            const participant = tryAddress(participantCandidate, 1)
            let amount = BigInt(0)
            try {
              if (args.amountRefunded !== undefined) amount = BigInt(String(args.amountRefunded))
              else if (args.change !== undefined) amount = BigInt(String(args.change))
              else if (args.amount !== undefined) amount = BigInt(String(args.amount))
            } catch {}
            if (!participant) continue

            const entry: FeedEntry = {
              type: 'OverageRefunded',
              txHash: typeof txHashForAbi === 'string' && looksLikeHexTx(txHashForAbi) ? (txHashForAbi as `0x${string}`) : undefined,
              logIndex: idxForAbi,
              blockNumber: blockNumForAbi,
              timestamp: normalizeToMs(tsForAbi),
              participant,
              amount
            }
            return entry
          }

          if (name === 'WinnerPicked') {
            const winnerCandidate = args.winner
            const winner = tryAddress(winnerCandidate, 1)
            let prize = BigInt(0)
            try {
              if (args.amountWon !== undefined) prize = BigInt(String(args.amountWon))
              else if (args.amount !== undefined) prize = BigInt(String(args.amount))
              else if (args.prize !== undefined) prize = BigInt(String(args.prize))
            } catch {}
            if (!winner) continue

            const entry: FeedEntry = {
              type: 'WinnerPicked',
              txHash: typeof txHashForAbi === 'string' && looksLikeHexTx(txHashForAbi) ? (txHashForAbi as `0x${string}`) : undefined,
              logIndex: idxForAbi,
              blockNumber: blockNumForAbi,
              timestamp: normalizeToMs(tsForAbi),
              winner,
              prize,
              roundId: safeNumber(args.roundId)
            }
            // Ensure a stable transaction identifier for Hedera tx ids (mirror may return non-hex ids)
            ;(entry as any).transaction_id =
              typeof txHashForAbi === 'string' && !looksLikeHexTx(txHashForAbi) ? txHashForAbi : transaction_id ?? undefined
            return entry
          }
        } catch {
          // decoding failed for this ABI entry — try next
        }
      }
    } catch {
      // ignore ABI decode failures; fall back to previous heuristics below
    }

    const sig = String(topic0).toLowerCase()
    // Debug: signature/topic inspection to see why ABI decode may have failed
       
    const txRaw = transaction_hash ?? transaction_id
    const txHash = normalizeTxHash(txRaw)
    const blockNum = block_number !== undefined ? Number(String(block_number)) : undefined
    const ts = consensus_timestamp ? consensusTsToMs(consensus_timestamp) : undefined
    const idx = typeof log_index === 'number' ? log_index : typeof log_index === 'string' ? Number(log_index) : undefined

    // EnteredPool
    if (sig.includes('enteredpool')) {
      const participantCandidate = normalizeAddressFromTopic(raw.topics?.[1] as string | undefined) ?? (raw.args?.participant as string | undefined)
      const participant = typeof participantCandidate === 'string' && looksLikeHexAddress(participantCandidate) ? (participantCandidate as `0x${string}`) : undefined
      let amount = BigInt(0)
      try {
        if (data && data.startsWith('0x')) amount = BigInt(data)
        else if (raw.args?.amount) amount = BigInt(String(raw.args.amount))
      } catch {}
      if (!participant) return null
      const entry: FeedEntry = {
        type: 'EnteredPool',
        txHash: typeof txHash === 'string' && looksLikeHexTx(txHash) ? (txHash as `0x${string}`) : undefined,
        logIndex: idx,
        blockNumber: blockNum,
        timestamp: normalizeToMs(ts),
        participant,
        amount,
        roundId: safeNumber(raw.args?.roundId as any)
      }
      ;(entry as any).transaction_id =
        typeof txHash === 'string' && !looksLikeHexTx(txHash) ? txHash : transaction_id ?? undefined
      return entry
    }

    // OverageRefunded
    if (sig.includes('overagerefunded')) {
      const participantCandidate = normalizeAddressFromTopic(raw.topics?.[1] as string | undefined) ?? (raw.args?.participant as string | undefined)
      const participant = typeof participantCandidate === 'string' && looksLikeHexAddress(participantCandidate) ? (participantCandidate as `0x${string}`) : undefined
      let amount = BigInt(0)
      try {
        if (data && data.startsWith('0x')) amount = BigInt(data)
        else if (raw.args?.change) amount = BigInt(String(raw.args.change))
      } catch {}
      if (!participant) return null
      return {
        type: 'OverageRefunded',
        txHash: typeof txHash === 'string' && looksLikeHexTx(txHash) ? (txHash as `0x${string}`) : undefined,
        logIndex: idx,
        blockNumber: blockNum,
        timestamp: normalizeToMs(ts),
        participant,
        amount
      }
    }

    // WinnerPicked
    if (sig.includes('winnerpicked')) {
      const winnerCandidate = normalizeAddressFromTopic(raw.topics?.[1] as string | undefined) ?? (raw.args?.winner as string | undefined)
      const winner = typeof winnerCandidate === 'string' && looksLikeHexAddress(winnerCandidate) ? (winnerCandidate as `0x${string}`) : undefined
      let prize = BigInt(0)
      try {
        if (data && data.startsWith('0x')) prize = BigInt(data)
        else if (raw.args?.prize) prize = BigInt(String(raw.args.prize))
      } catch {}
      if (!winner) return null
      const entry: FeedEntry = {
        type: 'WinnerPicked',
        txHash: typeof txHash === 'string' && looksLikeHexTx(txHash) ? (txHash as `0x${string}`) : undefined,
        logIndex: idx,
        blockNumber: blockNum,
        timestamp: normalizeToMs(ts),
        winner,
        prize,
        roundId: safeNumber(raw.args?.roundId as any)
      }
      ;(entry as any).transaction_id =
        typeof txHash === 'string' && !looksLikeHexTx(txHash) ? txHash : transaction_id ?? undefined
      return entry
    }

    return null
  } catch {
    return null
  }
}

// Fetch logs from Mirror Node with basic retry/backoff on 429/5xx.
async function mirrorFetch<T = unknown>(path: string, params: Record<string, string | number | undefined> = {}, maxRetries = 5): Promise<T> {
  if (!MIRROR_BASE) throw new Error('Mirror base URL is not configured. Set NEXT_PUBLIC_MIRROR_BASE')
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  const url = `${MIRROR_BASE.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}`

  let attempt = 0
  let delay = 500
  while (true) {
    attempt++
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) {
        const json = await res.json()
        return json
      }
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt > maxRetries) {
          const text = await res.text().catch(() => '')
          throw new Error(`Mirror fetch failed ${res.status}: ${text}`)
        }
        await sleep(delay)
        delay = Math.min(delay * 2, 60_000)
        continue
      }
      const text = await res.text().catch(() => '')
      throw new Error(`Mirror fetch failed ${res.status}: ${text}`)
    } catch (err) {
      if (attempt > maxRetries) throw err
      await sleep(delay)
      delay = Math.min(delay * 2, 60_000)
    }
  }
}

// Public: fetch contract logs for the lottery contract filtered by event signatures or block range.
// Fetch logs with required filters so Mirror doesn't 400
export async function getContractLogs(opts: {
  contract: string;                // evm hex or "0.0.x"
  topic0?: `0x${string}`;
  topic1?: `0x${string}` | undefined;
  topic2?: `0x${string}` | undefined;
  topic3?: `0x${string}` | undefined;
  fromTimestamp?: string;          // e.g. "gte:1700000000.000000000"
  limit?: number;
  order?: 'asc' | 'desc';
}): Promise<MirrorLog[]> {
  const {
    contract,
    topic0,
    topic1,
    topic2,
    topic3,
    fromTimestamp,
    limit = 100,
    order = 'desc'
  } = opts;

  // Use per-contract results logs endpoint; accept 0.0.x or 0x.. and lowercase hex.
  const idOrEvm = looksLikeHexAddress(contract) ? contract.toLowerCase() : contract;

  const params: Record<string, string | number | undefined> = {
    order,
    limit: Math.min(limit, 200),
  };
  if (fromTimestamp !== undefined) params.timestamp = fromTimestamp;
  if (topic0 !== undefined) params.topic0 = topic0;
  if (topic1 !== undefined) params.topic1 = topic1;
  if (topic2 !== undefined) params.topic2 = topic2;
  if (topic3 !== undefined) params.topic3 = topic3;

  // Old global endpoint removed: /api/v1/contracts/logs?address=...
  const path = `/api/v1/contracts/${encodeURIComponent(idOrEvm)}/results/logs`;
  const json = await mirrorFetch<{ logs?: MirrorLog[] }>(path, params);
  return Array.isArray(json.logs) ? (json.logs as MirrorLog[]) : [];
}

export async function fetchLogsForEvents(opts: { startBlock?: number; endBlock?: number; limit?: number; topic0?: (`0x${string}`)[] }): Promise<{ logs: MirrorLog[]; degraded: boolean }> {
 const { startBlock, endBlock, limit = 200, topic0 } = opts ?? {}
 let degraded = false

 // Mirror logs endpoint supports topic filters but not block range; mark degraded if caller requested block filters
 if (startBlock !== undefined || endBlock !== undefined) degraded = true

 const topics: Array<`0x${string}` | undefined> = Array.isArray(topic0) && topic0.length > 0 ? topic0 : [undefined]
 const perTopicLimit = Math.max(1, Math.ceil(limit / topics.length))

 const collected: MirrorLog[] = []
 const seen = new Set<string>()

 for (const t0 of topics) {
   try {
     const logs = await getContractLogs({
       contract: LOTTERY_ADDRESS,
       topic0: t0,
       limit: perTopicLimit,
       order: 'desc'
     })

     for (const l of logs) {
       const tx = l.transaction_hash ?? l.transaction_id ?? ''
       const idx = l.log_index !== undefined ? String(l.log_index) : ''
       const key = `${tx}:${idx}`
       if (key && !seen.has(key)) {
         seen.add(key)
         collected.push(l)
       }
     }
   } catch {
     degraded = true
   }
 }

 // Sort newest first by consensus timestamp (fallback to block number)
 collected.sort((a, b) => {
   const aTs = typeof a.consensus_timestamp === 'string' ? consensusTsToMs(a.consensus_timestamp) : safeNumber(a.block_number) ?? 0
   const bTs = typeof b.consensus_timestamp === 'string' ? consensusTsToMs(b.consensus_timestamp) : safeNumber(b.block_number) ?? 0
   return bTs - aTs
 })

 return { logs: collected.slice(0, limit), degraded }
}

// Helper to fetch and map history entries since a start block (or recent window).
export async function fetchHistoryEntries(opts: { startBlock?: number; endBlock?: number; limit?: number; topic0?: (`0x${string}`)[] }): Promise<{ entries: FeedEntry[]; degraded: boolean }> {
  const { startBlock, endBlock, limit = 200, topic0 } = opts
  const { logs, degraded } = await fetchLogsForEvents({ startBlock, endBlock, limit, topic0 })
  const mapped: FeedEntry[] = []
  for (const l of logs) {
    const entry = mapMirrorLogToEntry(l)
    if (entry) mapped.push(entry)
  }
  mapped.sort((a, b) => {
    const aTs = Number(a.timestamp ?? safeNumber(a.blockNumber) ?? 0)
    const bTs = Number(b.timestamp ?? safeNumber(b.blockNumber) ?? 0)
    return bTs - aTs
  })
  return { entries: mapped, degraded }
}