'use client'

import { useEffect, useRef, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { LOTTERY_ABI, LOTTERY_ADDRESS } from '@/lib/contracts/lottery'
import type { FeedEntry } from '@/types/feed'
import { safeNumber, normalizeToMs } from '@/lib/mirror'
import { HEDERA_RPC_URL } from '@/lib/hedera'


export function useLotteryEvents() {
  const client = usePublicClient()
  const [events, setEvents] = useState<FeedEntry[]>([])
  const unsubRef = useRef<null | (() => void)>(null)

  useEffect(() => {
    if (!client) return

    if (unsubRef.current) {
      unsubRef.current()
      unsubRef.current = null
    }

    const unsubs: Array<() => void> = []

    const push = (mapped: FeedEntry[]) => {
      setEvents(prev => [...mapped, ...prev])
    }

    // Simple RPC probe to avoid starting HTTP filter-based watchers when the RPC is unreachable / CORS-blocked
    const probeRpc = async () => {
      try {
        const res = await fetch(HEDERA_RPC_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 })
        })
        return res.ok
      } catch {
        return false
      }
    }

    const setup = async () => {
      const ok = await probeRpc()
      if (!ok) {
        console.error('[useLotteryEvents] RPC probe failed; disabling contract event watchers for URL', HEDERA_RPC_URL)
        return
      }

      // EnteredPool(address indexed player, uint256 amountEntered)
      const unEntered = client.watchContractEvent({
        address: LOTTERY_ADDRESS,
        abi: LOTTERY_ABI,
        eventName: 'EnteredPool',
        onLogs: async (logs) => {
          const base = logs.map((l) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const args = (l as any)?.args ?? {}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const txHash = (l as any)?.transactionHash ?? (l as any)?.transaction_hash
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const logIndexRaw = (l as any)?.logIndex ?? (l as any)?.log_index
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const blockNumberRaw = (l as any)?.blockNumber ?? (l as any)?.block_number
            return {
              type: 'EnteredPool',
              txHash,
              logIndex: safeNumber(logIndexRaw),
              blockNumber: safeNumber(blockNumberRaw),
              participant: args.player,
              amount: args.amountEntered,
              roundId: safeNumber(args.roundId)
            } as FeedEntry
          })

          const blockNums = Array.from(new Set(base.map((e) => e.blockNumber).filter((n): n is number => typeof n === 'number')))
          const tsByBlock = new Map<number, number>()
          await Promise.all(
            blockNums.map(async (bn) => {
              try {
                const blk = await client.getBlock({ blockNumber: BigInt(bn) })
                const rawTs = blk?.timestamp
                if (rawTs !== undefined && rawTs !== null) {
                  const n = typeof rawTs === 'bigint' ? Number(rawTs) : Number(rawTs)
                  if (Number.isFinite(n)) {
                    const ms = n < 1e12 ? n * 1000 : n
                    tsByBlock.set(bn, ms)
                  }
                }
              } catch {
                // ignore block fetch failures; we'll fallback below
              }
            })
          )

          const mapped = base.map((e) => ({
            ...e,
            timestamp: normalizeToMs(typeof e.blockNumber === 'number' ? tsByBlock.get(e.blockNumber) ?? Date.now() : Date.now())
          }))
          
          push(mapped)
        },
        onError: (error) => {
          console.error('[useLotteryEvents] EnteredPool watch error', error)
        }
      })
      unsubs.push(unEntered)

      // OverageRefunded(address indexed player, uint256 amountRefunded)
      const unRefund = client.watchContractEvent({
        address: LOTTERY_ADDRESS,
        abi: LOTTERY_ABI,
        eventName: 'OverageRefunded',
        onLogs: async (logs) => {
          const base = logs.map((l) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const args = (l as any)?.args ?? {}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const txHash = (l as any)?.transactionHash ?? (l as any)?.transaction_hash
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const logIndexRaw = (l as any)?.logIndex ?? (l as any)?.log_index
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const blockNumberRaw = (l as any)?.blockNumber ?? (l as any)?.block_number
            return {
              type: 'OverageRefunded',
              txHash,
              logIndex: safeNumber(logIndexRaw),
              blockNumber: safeNumber(blockNumberRaw),
              participant: args.player,
              amount: args.amountRefunded
            } as FeedEntry
          })

          const blockNums = Array.from(new Set(base.map((e) => e.blockNumber).filter((n): n is number => typeof n === 'number')))
          const tsByBlock = new Map<number, number>()
          await Promise.all(
            blockNums.map(async (bn) => {
              try {
                const blk = await client.getBlock({ blockNumber: BigInt(bn) })
                const rawTs = blk?.timestamp
                if (rawTs !== undefined && rawTs !== null) {
                  const n = typeof rawTs === 'bigint' ? Number(rawTs) : Number(rawTs)
                  if (Number.isFinite(n)) {
                    const ms = n < 1e12 ? n * 1000 : n
                    tsByBlock.set(bn, ms)
                  }
                }
              } catch {
                // ignore
              }
            })
          )

          const mapped = base.map((e) => ({
            ...e,
            timestamp: normalizeToMs(typeof e.blockNumber === 'number' ? tsByBlock.get(e.blockNumber) ?? Date.now() : Date.now())
          }))
      
          push(mapped)
        },
        onError: (error) => {
          console.error('[useLotteryEvents] OverageRefunded watch error', error)
        }
      })
      unsubs.push(unRefund)

      // WinnerPicked(address indexed winner, uint256 prize)
      const unWinner = client.watchContractEvent({
        address: LOTTERY_ADDRESS,
        abi: LOTTERY_ABI,
        eventName: 'WinnerPicked',
        onLogs: async (logs) => {
          // Debug: inspect raw logs received from the provider
          try { console.debug('[useLotteryEvents] raw WinnerPicked logs:', logs) } catch {}
          const base = logs.map((l) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const args = (l as any)?.args ?? {}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const txHash = (l as any)?.transactionHash ?? (l as any)?.transaction_hash
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const logIndexRaw = (l as any)?.logIndex ?? (l as any)?.log_index
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const blockNumberRaw = (l as any)?.blockNumber ?? (l as any)?.block_number
            return {
              type: 'WinnerPicked',
              txHash,
              logIndex: safeNumber(logIndexRaw),
              blockNumber: safeNumber(blockNumberRaw),
              winner: args.winner,
              prize: args.amountWon,
              roundId: safeNumber(args.roundId)
            } as FeedEntry
          })

          const blockNums = Array.from(new Set(base.map((e) => e.blockNumber).filter((n): n is number => typeof n === 'number')))
          const tsByBlock = new Map<number, number>()
          await Promise.all(
            blockNums.map(async (bn) => {
              try {
                const blk = await client.getBlock({ blockNumber: BigInt(bn) })
                const rawTs = blk?.timestamp
                if (rawTs !== undefined && rawTs !== null) {
                  const n = typeof rawTs === 'bigint' ? Number(rawTs) : Number(rawTs)
                  if (Number.isFinite(n)) {
                    const ms = n < 1e12 ? n * 1000 : n
                    tsByBlock.set(bn, ms)
                  }
                }
              } catch {
                // ignore
              }
            })
          )

          const mapped = base.map((e) => ({
            ...e,
            timestamp: normalizeToMs(typeof e.blockNumber === 'number' ? tsByBlock.get(e.blockNumber) ?? Date.now() : Date.now())
          }))
      
          // Debug: inspect mapped entries produced by the watcher
          try { console.debug('[useLotteryEvents] mapped WinnerPicked entries:', mapped) } catch {}
          push(mapped)
        },
        onError: (error) => {
          console.error('[useLotteryEvents] WinnerPicked watch error', error)
        }
      })
      unsubs.push(unWinner)

      unsubRef.current = () => {
        for (const u of unsubs) {
          try { u() } catch {}
        }
        unsubRef.current = null
      }
    }

    // start setup (does the probe and registers watchers)
    void setup()

    return () => {
      if (unsubRef.current) unsubRef.current()
    }
  }, [client])

  return { events }
}