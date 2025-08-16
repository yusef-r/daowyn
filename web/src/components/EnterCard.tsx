'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useChainId, useDisconnect } from 'wagmi'
import useLotteryReads from '@/hooks/useLotteryReads'
import { useEnterLottery } from '@/hooks/useLotteryWrites'
import { getExplorerTxUrl } from '@/lib/mirror'
import { useAppKit } from '@reown/appkit/react'

function SkeletonLine({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />
}

export default function EnterCard() {
  const { isConnected } = useAccount()
  const {
    remainingHBAR,
    isFilling,
    isReadyStage,
    enterable,
    onExpectedNetwork,
    loading: readsLoading,
    error: readsError,
    pendingRefundUserHBAR,
    refetch,
    roundId,
    participantCount,
    stageIndex,
  } = useLotteryReads()
  const chainId = useChainId()
  const { address } = useAccount()
  const { disconnect } = useDisconnect()
  const { open } = useAppKit()

  useEffect(() => {
    try {
      const headerBtn = typeof document !== 'undefined' ? document.querySelector('header button[aria-haspopup="menu"]') : null
      const headerText = headerBtn?.textContent?.trim() ?? null
      console.log('[diag.account.enter]', {
        component: 'EnterCard',
        address: address ?? null,
        headerText,
        providerWrap: 'WagmiProvider -> QueryClientProvider -> LotteryDataProvider -> WalletSessionGuard',
      })
      if (!address) {
        console.warn('[diag.account.null]', {
          componentPath: 'web/src/components/EnterCard.tsx',
          wrappedBy: 'WagmiProvider -> QueryClientProvider -> LotteryDataProvider -> WalletSessionGuard',
        })
      }
    } catch {}
  }, [address])

  // Wallet balance is intentionally not fetched on the client to avoid direct RPCs.
  const balLoading = false
  const hbarText = '—'

  const {
    enter,
    // hook returns tx state names — alias for component convenience
    txHash,
    isPending,
    isConfirming,
    isConfirmed,
    error: txError,
    reset,
    // legacy aliases (if needed)
    submitting,
    txError: legacyTxError
  } = useEnterLottery()

  // Normalize names used previously in component
  // submitting is not a connection check; force truthy so `connected` reflects wallet state
  const hookConnected = true
  // Note: onExpectedNetwork is provided by the reads hook (not the write hook). Keep using the value from useLotteryReads for network gating.
  const isSuccess = Boolean(isConfirmed)
  const isError = Boolean(txError ?? legacyTxError)
  const hash = txHash
  const error = txError ?? legacyTxError

  const [amount, setAmount] = useState<string>('')
  const [submittingLocal, setSubmittingLocal] = useState<boolean>(false)

  // Keep lightweight refs of latest snapshot values so we can detect when the server
  // has reflected an entered transaction (fast server case).
  const latestParticipantsRef = useRef<number | undefined>(participantCount)
  const latestRemainingRef = useRef<number | undefined>(remainingHBAR)
  const latestStageRef = useRef<number | undefined>(stageIndex)

  useEffect(() => {
    latestParticipantsRef.current = participantCount
    latestRemainingRef.current = remainingHBAR
    latestStageRef.current = stageIndex
  }, [participantCount, remainingHBAR, stageIndex])

  const disableAll = submittingLocal || isPending || isConfirming
  const connected = isConnected && hookConnected
  const canSubmit =
    connected &&
    onExpectedNetwork &&
    Boolean(enterable) &&
    !disableAll &&
    Number(amount || '0') > 0

  const refundPreview = useMemo(() => {
    const amt = Number(amount || '0')
    if (!Number.isFinite(amt) || amt <= 0) return 0
    const rem = Number(remainingHBAR || 0)
    const over = amt - rem
    return over > 0 ? over : 0
  }, [amount, remainingHBAR])

  const handleEnterClick = async () => {
    if (!canSubmit) return
    if (submittingLocal || isPending || isConfirming) return

    // Snapshot pre-submit server-observed values
    const preParticipants = latestParticipantsRef.current
    const preRemaining = latestRemainingRef.current
    const preStage = latestStageRef.current
    console.debug('[enter.pre]', { preParticipants, preRemaining, preStage, amount })

    setSubmittingLocal(true)
    try {
      const txHash = await enter(amount)
      console.debug('[enter.txHash]', { txHash })

      // On tx hash returned, refetch server snapshot once then poll briefly (bounded)
      if (txHash) {
        try {
          await refetch()
          console.debug('[enter.refetch] completed')
        } catch (e) {
          console.debug('[enter.refetch] failed', e)
        }

        const start = Date.now()
        const timeoutMs = 12000
        const intervalMs = 1000
        let seen = false
        let reason = ''
        while (!seen && Date.now() - start < timeoutMs) {
          await new Promise((res) => setTimeout(res, intervalMs))
          const curParticipants = latestParticipantsRef.current
          const curRemaining = latestRemainingRef.current
          const curStage = latestStageRef.current

          if (typeof preParticipants === 'number' && typeof curParticipants === 'number' && curParticipants > preParticipants) {
            seen = true
            reason = 'participants'
            break
          }
          if (typeof preRemaining === 'number' && typeof curRemaining === 'number' && curRemaining < preRemaining) {
            seen = true
            reason = 'remaining'
            break
          }
          if (typeof preStage === 'number' && typeof curStage === 'number' && curStage !== preStage) {
            seen = true
            reason = 'stage'
            break
          }
        }

        if (seen) {
          try {
            reset()
            console.debug('[enter.reset] called', { reason })
          } catch (e) {
            console.debug('[enter.reset] failed', e)
          }
        } else {
          console.debug('[enter.poll] timed out')
        }
      }
    } catch (err: unknown) {
      let message = ''; if (typeof err === 'object' && err && 'message' in err) { const m = (err as { message?: unknown }).message; message = typeof m === 'string' ? m : String(m); } else { message = String(err); }
      if (message.includes('No matching key')) {
        try { disconnect() } catch {}
        try { open?.() } catch {}
      }
    } finally {
      setSubmittingLocal(false)
    }
  }

  // Reset Enter form when a new round starts
  useEffect(() => {
    setAmount('')
    try { reset() } catch {}
  }, [roundId, reset])

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="p-4">
        <h3 className="text-base font-semibold">Enter the Pool</h3>
        <p className="text-sm text-muted-foreground">
          Add HBAR to the prize pool. Any overage is refunded or auto-credited.
        </p>
      </div>

      <div className="space-y-4 p-4 pt-0">
        {readsLoading ? (
          <>
            <SkeletonLine className="h-10 w-full" />
            <SkeletonLine className="h-6 w-48" />
            <SkeletonLine className="h-10 w-32" />
          </>
        ) : readsError ? (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            Failed to load pool info
          </div>
        ) : (
          <>
            {!enterable && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                Entries are closed for now. They reopen after the current round lands.
              </div>
            )}

            {!onExpectedNetwork && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                Wrong network. Please switch to Hedera Testnet.
              </div>
            )}

            {!connected && (
              <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-800">
                Connect your wallet to enter the pool.
              </div>
            )}
            {/* Wallet balance intentionally omitted to avoid client RPCs */}
            <label className="block text-sm font-medium">
              Amount (HBAR)
              <input
                type="number"
                inputMode="decimal"
                step="0.000001"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none ring-0 focus:border-primary"
                placeholder="0.0"
                disabled={disableAll}
                aria-label="HBAR amount to enter"
              />
            </label>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <div>
                Remaining to target:{' '}
                <span className="font-medium">
                  {Number(remainingHBAR ?? 0).toLocaleString(undefined, {
                    maximumFractionDigits: 6
                  })}{' '}
                  HBAR
                </span>
              </div>
              <button
                type="button"
                className="underline underline-offset-2 hover:opacity-80"
                onClick={() =>
                  setAmount(
                    Number(remainingHBAR ?? 0).toLocaleString(undefined, {
                      maximumFractionDigits: 6,
                      useGrouping: false
                    })
                  )
                }
                disabled={disableAll}
              >
                To target
              </button>
            </div>

            {refundPreview > 0 && (
              <div className="text-xs text-muted-foreground">
                Warning: amount exceeds remaining. Estimated refund: {refundPreview.toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR
              </div>
            )}

            {(pendingRefundUserHBAR ?? 0) > 0 && (
              <div className="text-xs text-muted-foreground">
                Pending refund: {pendingRefundUserHBAR!.toLocaleString(undefined, { maximumFractionDigits: 6 })} HBAR (auto-flush on next action)
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleEnterClick}
                disabled={!canSubmit}
                className={`inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium ${
                  canSubmit ? 'hover:bg-muted' : 'opacity-60'
                }`}
              >
                {disableAll ? 'Submitting...' : 'Enter Pool'}
              </button>

              {hash && (
                <a
                  href={getExplorerTxUrl(String(hash))}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs underline underline-offset-2 text-muted-foreground hover:opacity-80"
                >
                  View transaction
                </a>
              )}
            </div>

            {(isError || error) && (
              <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                {(error?.message ?? String(error)) || 'Transaction failed. Please try again.'}
              </div>
            )}

            {isSuccess && (
              <div className="flex items-center justify-between rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-700">
                <span>Entry confirmed.</span>
                <button
                  type="button"
                  className="underline underline-offset-2 hover:opacity-80"
                  onClick={() => {
                    setAmount('')
                    reset()
                  }}
                >
                  Reset
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}