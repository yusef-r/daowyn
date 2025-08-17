'use client'

import { useEffect, useRef, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { LOTTERY_ABI, LOTTERY_ADDRESS } from '@/lib/contracts/lottery'
import type { FeedEntry } from '@/types/feed'
import { safeNumber } from '@/lib/mirror'


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

    // EnteredPool(address indexed player, uint256 amountEntered)
    const unEntered = client.watchContractEvent({
      address: LOTTERY_ADDRESS,
      abi: LOTTERY_ABI,
      eventName: 'EnteredPool',
      onLogs: (logs) => {
        const mapped: FeedEntry[] = logs.map((l) => {
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
          }
        })
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
      onLogs: (logs) => {
        const mapped: FeedEntry[] = logs.map((l) => {
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
          }
        })
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
      onLogs: (logs) => {
        // Debug: inspect raw logs received from the provider
        try { console.debug('[useLotteryEvents] raw WinnerPicked logs:', logs) } catch {}
        const mapped: FeedEntry[] = logs.map((l) => {
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
          }
        })
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

    return () => {
      if (unsubRef.current) unsubRef.current()
    }
  }, [client])

  return { events }
}