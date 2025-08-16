/* web/src/lib/mirror.ts
   Mirror Node helper to fetch contract logs and map them to LotteryEvent-like feed entries.
   - Exports fetchLogsForEvents(startBlock?, endBlock?, sinceTimestamp?) to backfill history
   - Exports mapMirrorLogToEntry to convert Mirror log JSON to feed entry
   - Implements simple exponential backoff for 429/5xx
   - Uses NEXT_PUBLIC_MIRROR_BASE from env
 */

import type { FeedEntry } from '@/types/feed'
import { LOTTERY_ADDRESS, LOTTERY_ABI } from '@/lib/contracts/lottery'
import { keccak256, toBytes } from 'viem'

// Mirror Node base URL should be provided in env
// Mirror base + helpers
const MIRROR_BASE =
  process.env.NEXT_PUBLIC_MIRROR_BASE ??
  'https://testnet.mirrornode.hedera.com';
const MIRROR_DIAG = ['1', 'true'].includes(String(process.env.NEXT_PUBLIC_MIRROR_DIAG ?? '').trim().toLowerCase());

const isHexAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

// Derive topic0 hashes from ABI to avoid drift with deployed bytecode
const getEvent = (name: string) =>
  (LOTTERY_ABI as unknown as Array<{ type: string; name?: string; inputs?: Array<{ type: string }> }>)
    .find((x) => x.type === 'event' && x.name === name)

const topicForEvent = (name: string): `0x${string}` => {
  const ev = getEvent(name)
  if (!ev || !ev.inputs) throw new Error(`ABI event not found: ${name}`)
  const sig = `${name}(${ev.inputs.map((i) => i.type).join(',')})`
  return keccak256(toBytes(sig)).toLowerCase() as `0x${string}`
}

const TOPIC_ENTERED_POOL = topicForEvent('EnteredPool')
const TOPIC_OVERAGE_REFUNDED = topicForEvent('OverageRefunded')
const TOPIC_WINNER_PICKED = topicForEvent('WinnerPicked')
const TOPIC_POOL_FILLED = topicForEvent('PoolFilled')
const TOPIC_ROUND_RESET = topicForEvent('RoundReset')

if (MIRROR_DIAG) {
  try {
    console.log('[mirror.diag.topics]', {
      TOPIC_ENTERED_POOL,
      TOPIC_OVERAGE_REFUNDED,
      TOPIC_WINNER_PICKED,
      TOPIC_POOL_FILLED,
      TOPIC_ROUND_RESET,
    })
  } catch {}
}

// Track which Mirror logs path was used most recently for diagnostics
// Possible values: 'global' | `perContract:/api/v1/contracts/${id}/results/logs`
export let lastContractLogsPathUsed: string | null = null;

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
  topic1?: string
  topic2?: string
  topic3?: string
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
    const consensus_timestamp = (raw.consensus_timestamp as string | undefined) ?? (raw.timestamp as string | undefined)

    const sig = String(topic0).toLowerCase()

    const txRaw = transaction_hash ?? transaction_id
    const txHash = normalizeTxHash(txRaw)
    const blockNum = block_number !== undefined ? Number(String(block_number)) : undefined
    const ts = consensus_timestamp ? consensusTsToMs(consensus_timestamp) : undefined
    const idx = typeof log_index === 'number' ? log_index : typeof log_index === 'string' ? Number(log_index) : undefined

    // EnteredPool
    if (sig === TOPIC_ENTERED_POOL) {
      const t1 = (raw as unknown as { topic1?: string }).topic1
      const participantCandidate =
        normalizeAddressFromTopic(t1 ?? (raw.topics?.[1] as string | undefined)) ??
        (raw.args?.participant as string | undefined)
      const participant =
        typeof participantCandidate === 'string' && looksLikeHexAddress(participantCandidate)
          ? (participantCandidate as `0x${string}`)
          : undefined
      let amount = BigInt(0)
      try {
        if (data && data.startsWith('0x')) amount = BigInt(data)
        else if (raw.args?.amount) amount = BigInt(String(raw.args.amount))
      } catch {}
      if (!participant) return null
      return {
        type: 'EnteredPool',
        txHash: typeof txHash === 'string' && looksLikeHexTx(txHash) ? (txHash as `0x${string}`) : undefined,
        logIndex: idx,
        blockNumber: blockNum,
        timestamp: ts,
        participant,
        amount
      }
    }

    // OverageRefunded
    if (sig === TOPIC_OVERAGE_REFUNDED) {
      const t1 = (raw as unknown as { topic1?: string }).topic1
      const participantCandidate =
        normalizeAddressFromTopic(t1 ?? (raw.topics?.[1] as string | undefined)) ??
        (raw.args?.participant as string | undefined)
      const participant =
        typeof participantCandidate === 'string' && looksLikeHexAddress(participantCandidate)
          ? (participantCandidate as `0x${string}`)
          : undefined
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
        timestamp: ts,
        participant,
        amount
      }
    }

    // WinnerPicked
    if (sig === TOPIC_WINNER_PICKED) {
      const t1 = (raw as unknown as { topic1?: string }).topic1
      const winnerCandidate =
        normalizeAddressFromTopic(t1 ?? (raw.topics?.[1] as string | undefined)) ??
        (raw.args?.winner as string | undefined)
      const winner =
        typeof winnerCandidate === 'string' && looksLikeHexAddress(winnerCandidate)
          ? (winnerCandidate as `0x${string}`)
          : undefined
      let prize = BigInt(0)
      try {
        if (data && data.startsWith('0x')) prize = BigInt(data)
        else if (raw.args?.prize ?? raw.args?.amountWon)
          prize = BigInt(String((raw.args as Record<string, unknown>).prize ?? (raw.args as Record<string, unknown>).amountWon))
      } catch {}
      if (!winner) return null
      return {
        type: 'WinnerPicked',
        txHash: typeof txHash === 'string' && looksLikeHexTx(txHash) ? (txHash as `0x${string}`) : undefined,
        logIndex: idx,
        blockNumber: blockNum,
        timestamp: ts,
        winner,
        prize
      }
    }

    // PoolFilled (round locked)
    if (sig === TOPIC_POOL_FILLED) {
      return {
        type: 'PoolFilled',
        txHash: typeof txHash === 'string' && looksLikeHexTx(txHash) ? (txHash as `0x${string}`) : undefined,
        logIndex: idx,
        blockNumber: blockNum,
        timestamp: ts,
      }
    }

    // RoundReset (optional for future use)
    if (sig === TOPIC_ROUND_RESET) {
      return {
        type: 'RoundReset',
        txHash: typeof txHash === 'string' && looksLikeHexTx(txHash) ? (txHash as `0x${string}`) : undefined,
        logIndex: idx,
        blockNumber: blockNum,
        timestamp: ts,
      }
    }

    return null
  } catch {
    return null
  }
}

// Fetch logs from Mirror Node with basic retry/backoff on 429/5xx.
async function mirrorFetch<T = unknown>(path: string, params: Record<string, string | number | (string | number)[] | undefined> = {}, maxRetries = 5): Promise<T> {
  if (!MIRROR_BASE) throw new Error('Mirror base URL is not configured. Set NEXT_PUBLIC_MIRROR_BASE')
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue
    if (Array.isArray(v)) {
      for (const vv of v) {
        if (vv === undefined || vv === '') continue
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(vv))}`)
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    }
  }
  const qs = parts.join('&')
  const url = `${MIRROR_BASE.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}`
 
  // Diagnostic: surface exact URL and params we will request from the Mirror node
  if (MIRROR_DIAG) {
    try {
      console.log('[mirror.diag.request]', { url, params })
    } catch {}
  }
 
  let attempt = 0
  let delay = 500
  while (true) {
    attempt++
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) {
        const json = await res.json()
        if (MIRROR_DIAG) {
          try {
            console.log('[mirror.diag.response]', { url, status: res.status, bodySize: JSON.stringify(json).length })
          } catch {}
        }
        return json
      }
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt > maxRetries) {
          const text = await res.text().catch(() => '')
          throw new Error(`Mirror fetch failed ${res.status}: ${text}`)
        }
        // 10–25% jitter on retries, exponential backoff, cap at 60s
        const jitter = 1 + (0.10 + Math.random() * 0.15)
        await sleep(Math.round(delay * jitter))
        delay = Math.min(delay * 2, 60_000)
        continue
      }
      const text = await res.text().catch(() => '')
      throw new Error(`Mirror fetch failed ${res.status}: ${text}`)
    } catch (err) {
      if (attempt > maxRetries) throw err
      const jitter = 1 + (0.10 + Math.random() * 0.15)
      await sleep(Math.round(delay * jitter))
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
  toTimestamp?: string;            // e.g. "lt:1700003600.000000000"
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
    toTimestamp,
    limit = 100,
    order = 'desc'
  } = opts;

  // Use per-contract results logs endpoint; accept 0.0.x or 0x.. and lowercase hex.
  const idOrEvm = looksLikeHexAddress(contract) ? contract.toLowerCase() : contract;

  const params: Record<string, string | number | (string | number)[] | undefined> = {
    order,
    limit: Math.min(limit, 200),
  };
  const hasTopics = topic0 !== undefined || topic1 !== undefined || topic2 !== undefined || topic3 !== undefined;
  if (hasTopics) {
    if (!fromTimestamp || !toTimestamp) {
      throw new Error('Mirror: topics require timestamp range. Provide both fromTimestamp (gte:...) and toTimestamp (lt:...)');
    }
    params.timestamp = [fromTimestamp, toTimestamp];
  } else {
    const ts: Array<string> = [];
    if (fromTimestamp) ts.push(fromTimestamp);
    if (toTimestamp) ts.push(toTimestamp);
    if (ts.length > 0) params.timestamp = ts;
  }
  if (topic0 !== undefined) params.topic0 = topic0;
  if (topic1 !== undefined) params.topic1 = topic1;
  if (topic2 !== undefined) params.topic2 = topic2;
  if (topic3 !== undefined) params.topic3 = topic3;

  // Prefer global endpoint with address filter when topics are present; per-contract as fallback
  if (hasTopics) {
    try {
      const jsonGlobal = await mirrorFetch<{ logs?: MirrorLog[] }>(
        `/api/v1/contracts/results/logs`,
        { ...params, address: idOrEvm }
      )
      const globalLogs = Array.isArray(jsonGlobal.logs) ? (jsonGlobal.logs as MirrorLog[]) : []
      if (globalLogs.length > 0) {
        if (MIRROR_DIAG) {
          try {
            console.warn('[mirror.primary.globalEndpoint]', {
              address: idOrEvm,
              count: globalLogs.length,
            })
          } catch {}
        }
        lastContractLogsPathUsed = 'global'
        return globalLogs
      }
    } catch {
      // ignore and try per-contract
    }
  }
 
  const path = `/api/v1/contracts/${encodeURIComponent(idOrEvm)}/results/logs`
  const json = await mirrorFetch<{ logs?: MirrorLog[] }>(path, params)
  const perContract = Array.isArray(json.logs) ? (json.logs as MirrorLog[]) : []
  if (perContract.length > 0 && hasTopics) {
    if (MIRROR_DIAG) {
      try {
        console.warn('[mirror.fallback.perContract]', {
          address: idOrEvm,
          count: perContract.length,
        })
      } catch {}
    }
  }
  lastContractLogsPathUsed = `perContract:${path}`
  return perContract
}

// Windowed fetch across [startMs, endMs) with default 24h slices and 7d per-call cap.
export async function getContractLogsWindowed(opts: {
  contract: string;
  topic0?: `0x${string}`;
  topic1?: `0x${string}`;
  topic2?: `0x${string}`;
  topic3?: `0x${string}`;
  startMs: number;
  endMs: number;
  stepMs?: number;              // default 24h
  perSliceLimit?: number;       // default 200 (Mirror max)
  order?: 'asc' | 'desc';       // default 'asc' (time-forward)
}): Promise<MirrorLog[]> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_SPAN_MS = 7 * DAY_MS - 1; // strictly < 7d
  const {
    contract,
    topic0,
    topic1,
    topic2,
    topic3,
    startMs,
    endMs,
    stepMs = DAY_MS,
    perSliceLimit = 200,
    order = 'asc',
  } = opts;

  const start = Math.max(0, Math.floor(startMs));
  let end = Math.max(start + 1, Math.floor(endMs));
  if (end <= start) end = start + 1;

  const slice = Math.max(1, Math.min(stepMs, MAX_SPAN_MS));
  const out: MirrorLog[] = [];

  function toGteTimestamp(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const ns = (ms - secs * 1000) * 1_000_000;
    return `gte:${secs}.${String(ns).padStart(9, '0')}`;
  }
  function toLtTimestamp(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const ns = (ms - secs * 1000) * 1_000_000;
    return `lt:${secs}.${String(ns).padStart(9, '0')}`;
  }

  for (let s = start; s < end; s += slice) {
    let e = Math.min(s + slice, end);
    if (e - s >= MAX_SPAN_MS) e = s + MAX_SPAN_MS;
    if (e <= s) continue;

    const logs = await getContractLogs({
      contract,
      topic0,
      topic1,
      topic2,
      topic3,
      fromTimestamp: toGteTimestamp(s),
      toTimestamp: toLtTimestamp(e),
      limit: Math.min(perSliceLimit, 200),
      order,
    });
    if (Array.isArray(logs) && logs.length) out.push(...logs);
  }

  return out;
}

export async function fetchLogsForEvents(opts: {
  startBlock?: number;
  endBlock?: number;
  limit?: number;
  topic0?: (`0x${string}`)[];
  fromTimestamp?: string;
  toTimestamp?: string;
  startMs?: number;
  endMs?: number;
}): Promise<{ logs: MirrorLog[]; degraded: boolean }> {
  const { startBlock, endBlock, limit = 200, topic0, fromTimestamp, toTimestamp, startMs, endMs } = opts ?? {};
  let degraded = false;

  // Mirror supports topics + timestamps only; block ranges not supported.
  if (startBlock !== undefined || endBlock !== undefined) degraded = true;

  // Resolve time bounds
  let ft = fromTimestamp;
  let tt = toTimestamp;
  if ((!ft || !tt) && typeof startMs === 'number' && typeof endMs === 'number') {
    const toGteTimestamp = (ms: number) => {
      const secs = Math.floor(ms / 1000);
      const ns = (ms - secs * 1000) * 1_000_000;
      return `gte:${secs}.${String(ns).padStart(9, '0')}`;
    };
    const toLtTimestamp = (ms: number) => {
      const secs = Math.floor(ms / 1000);
      const ns = (ms - secs * 1000) * 1_000_000;
      return `lt:${secs}.${String(ns).padStart(9, '0')}`;
    };
    const s = Math.max(0, Math.floor(startMs));
    const e = Math.max(s + 1, Math.floor(endMs));
    ft = toGteTimestamp(s);
    tt = toLtTimestamp(e);
  }

  const topics: Array<`0x${string}` | undefined> = Array.isArray(topic0) && topic0.length > 0 ? topic0 : [undefined];
  const perTopicLimit = Math.max(1, Math.ceil(limit / topics.length));

  const collected: MirrorLog[] = [];
  const seen = new Set<string>();

  for (const t0 of topics) {
    try {
      // Enforce: never query topics without timestamp bounds
      if (t0 !== undefined && (!ft || !tt)) {
        degraded = true;
        continue;
      }

      const logs = await getContractLogs({
        contract: LOTTERY_ADDRESS,
        topic0: t0,
        fromTimestamp: ft,
        toTimestamp: tt,
        limit: perTopicLimit,
        order: 'desc',
      });

      for (const l of logs) {
        const tx = l.transaction_hash ?? l.transaction_id ?? '';
        const idx = l.log_index !== undefined ? String(l.log_index) : '';
        const key = `${tx}:${idx}`;
        if (key && !seen.has(key)) {
          seen.add(key);
          collected.push(l);
        }
      }
    } catch {
      degraded = true;
    }
  }

  // Sort newest first by consensus timestamp (fallback to block number)
  collected.sort((a, b) => {
    const aTs = typeof a.consensus_timestamp === 'string' ? consensusTsToMs(a.consensus_timestamp) : safeNumber(a.block_number) ?? 0;
    const bTs = typeof b.consensus_timestamp === 'string' ? consensusTsToMs(b.consensus_timestamp) : safeNumber(b.block_number) ?? 0;
    return bTs - aTs;
  });

  return { logs: collected.slice(0, limit), degraded };
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

// Latest block upper timestamp helper
export async function getLatestBlockTimestampTo(): Promise<number | undefined> {
  try {
    const json = await mirrorFetch<{ blocks?: Array<{ timestamp?: { from?: string; to?: string } }> }>(
      '/api/v1/blocks',
      { limit: 1, order: 'desc' }
    )
    const to = json?.blocks?.[0]?.timestamp?.to
    return typeof to === 'string' ? consensusTsToMs(to) : undefined
  } catch {
    return undefined
  }
}