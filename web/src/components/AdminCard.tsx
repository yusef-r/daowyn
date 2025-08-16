'use client'

import { useMemo, useState, useEffect } from 'react'
import { useAccount, useChainId } from 'wagmi'
import useLotteryReads, { useIsOwner } from '@/hooks/useLotteryReads'
import { useLotteryWrites } from '@/hooks/useLotteryWrites'
import { useLotteryData } from '@/context/LotteryDataContext'
import { getExplorerAccountUrl } from '@/lib/mirror'

export default function AdminCard() {
  const account = useAccount()
  const { isConnected, address: acctAddress } = account
  const { isOwner, owner } = useIsOwner()
  const chainId = useChainId()
  const {
    isReadyForDraw,
    participantCount,
    balanceHBAR,
    netHBAR,
    pendingRefundsTotalHBAR,
    pendingRefundUserHBAR,
    remainingHBAR,
    stage,
    stageIndex,
    roundId,
    lotteryAddress,
    readChainId: readChainIdFromHook,
    blockNumber,
    rawHBAR,
    targetHBAR,
    hasCode,
    codeHash,
    loading,
    error,
    feePreviewHBAR,
    prizePreviewHBAR,
    onExpectedNetwork,
    isStale,
    refetch,
  } = useLotteryReads()
  const { triggerDraw, error: txError } = useLotteryWrites()
  const { notifyServerUpdated, serverUpdatedCounter } = useLotteryData()

  useEffect(() => {
    try {
      const headerBtn = typeof document !== 'undefined' ? document.querySelector('header button[aria-haspopup="menu"]') : null
      const headerText = headerBtn?.textContent?.trim() ?? null
      console.log('[diag.account.admin]', {
        component: 'AdminCard',
        address: acctAddress ?? null,
        headerText,
        providerWrap: 'WagmiProvider -> QueryClientProvider -> LotteryDataProvider -> WalletSessionGuard',
      })
      if (!acctAddress) {
        console.warn('[diag.account.null]', {
          componentPath: 'web/src/components/AdminCard.tsx',
          wrappedBy: 'WagmiProvider -> QueryClientProvider -> LotteryDataProvider -> WalletSessionGuard',
        })
      }
    } catch {}
  }, [acctAddress])

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busyPulse, setBusyPulse] = useState(false)

  const canTrigger = useMemo(() => {
    return Boolean(isOwner && onExpectedNetwork && isReadyForDraw && stage !== 'Drawing')
  }, [isOwner, onExpectedNetwork, isReadyForDraw, stage])

  const isStageDrawing = stage === 'Drawing'

  const onConfirm = async () => {
    setConfirmOpen(false)
    setBusyPulse(true)
    try {
      const txHash = await triggerDraw()
      if (txHash) {
        try {
          notifyServerUpdated()
        } catch {}
        // Do not await refetch here; provider's notifyServerUpdated will fire-and-forget a refetch
      }
    } catch {
      // noop — user can retry
    } finally {
      // short, non-persistent pulse; yield to snapshot immediately
      setTimeout(() => setBusyPulse(false), 500)
    }
  }

  // Round boundary reset: clear any local UI state
  useEffect(() => {
    setConfirmOpen(false)
    setBusyPulse(false)
  }, [roundId])

  // If snapshot enters Drawing stage, stop any local pulse immediately
  useEffect(() => {
    if (isStageDrawing) setBusyPulse(false)
  }, [isStageDrawing])

  // When other parts of the app signal a server update, nudge this panel to refetch immediately.
  useEffect(() => {
    try {
      void refetch()
    } catch {}
  }, [serverUpdatedCounter, refetch])

  if (!isConnected) return null
  if (!isOwner) return null

  // debug values provided by hook

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Admin</h2>
        <div className="flex items-center gap-2">
          {isStale ? (
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" title="stale" aria-label="stale" />
          ) : null}
          <span className="text-xs text-muted-foreground">Owner: {owner}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="flex justify-between">
          <span>Status</span>
          <span className={isReadyForDraw ? 'text-green-600' : 'text-muted-foreground'}>
            {isReadyForDraw ? 'Ready for draw' : 'Filling pool'}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Drawing</span>
          <span className={isStageDrawing ? 'text-amber-600' : 'text-muted-foreground'}>
            {isStageDrawing ? 'In progress' : 'Idle'}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Participants</span>
          <span>{(participantCount ?? 0).toString()}</span>
        </div>
        <div className="flex justify-between">
          <span>Balance</span>
          <span>{loading ? '...' : `${(balanceHBAR ?? 0).toFixed(6)} HBAR`}</span>
        </div>
        <div className="flex justify-between">
          <span>Fee preview</span>
          <span>{loading ? '...' : `${(feePreviewHBAR ?? 0).toFixed(6)} HBAR`}</span>
        </div>
        <div className="flex justify-between">
          <span>Prize preview</span>
          <span>{loading ? '...' : `${(prizePreviewHBAR ?? 0).toFixed(6)} HBAR`}</span>
        </div>
      </div>

      {(error || txError) && (
        <div className="text-sm text-red-600">
          {String(error?.message ?? txError?.message ?? 'Transaction failed')}
        </div>
      )}

      <div className="flex gap-2">
        <button
          className="inline-flex items-center px-3 py-2 rounded-md bg-black text-white disabled:opacity-50"
          disabled={!canTrigger}
          onClick={() => setConfirmOpen(true)}
          aria-disabled={!canTrigger}
        >
          {isStageDrawing ? 'Drawing…' : (
            <>
              {busyPulse ? <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/50 border-t-white" /> : null}
              <span>Trigger Draw</span>
            </>
          )}
        </button>
      </div>

      {/* Debug block */}
      <div className="mt-2 rounded-md border p-2 text-xs space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Contract</span>
          {lotteryAddress ? (
            <a
              className="font-mono underline"
              href={getExplorerAccountUrl(lotteryAddress)}
              target="_blank"
              rel="noreferrer"
            >
              {lotteryAddress}
            </a>
          ) : (
            <span>—</span>
          )}
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Read chain</span>
          <span>{readChainIdFromHook}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Wallet chain</span>
          <span>{chainId}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Block</span>
          <span>{blockNumber ?? '…'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Code</span>
          <span>
            {hasCode === undefined ? 'unknown' : hasCode ? `present ${codeHash ?? ''}` : 'absent'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Stage</span>
          <span>
            {stage ?? 'Unknown'}
            {typeof stageIndex === 'number' ? ` (${stageIndex})` : ''}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">isReadyForDraw</span>
          <span>
            {String(isReadyForDraw)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">rawHBAR</span>
          <span>{loading ? '...' : `${(rawHBAR ?? 0).toFixed(6)} HBAR`}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">pendingRefundsTotal</span>
          <span>{loading ? '...' : `${(pendingRefundsTotalHBAR ?? 0).toFixed(6)} HBAR`}</span>
        </div>
        {Number(pendingRefundUserHBAR ?? 0) > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">pendingRefundUser</span>
            <span>{(pendingRefundUserHBAR ?? 0).toFixed(6)} HBAR</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-muted-foreground">netHBAR</span>
          <span>{loading ? '...' : `${(netHBAR ?? 0).toFixed(6)} HBAR`}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">targetHBAR</span>
          <span>{typeof targetHBAR === 'number' ? `${targetHBAR.toFixed(6)} HBAR` : '...'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">remainingHBAR</span>
          <span>{loading ? '...' : `${(remainingHBAR ?? 0).toFixed(6)} HBAR`}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Participants</span>
          <span>{(participantCount ?? 0).toString()}</span>
        </div>
        <div className="pt-1">
          <button
            className="inline-flex items-center px-2 py-1 rounded border text-xs"
            onClick={() => { void refetch() }}
          >
            Refetch
          </button>
        </div>
      </div>

      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center"
        >
          <div className="absolute inset-0 bg-black/50" onClick={() => setConfirmOpen(false)} />
          <div className="relative bg-white dark:bg-neutral-900 rounded-lg shadow-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-lg font-semibold">Confirm draw</h3>
            <p className="text-sm text-muted-foreground">
              This action will finalize the current pool. It will pay the owner fee and send the
              remaining balance to the randomly selected winner. This cannot be undone.
            </p>
            <ul className="text-sm space-y-1">
              <li>Balance: {(balanceHBAR ?? 0).toFixed(6)} HBAR</li>
              <li>Fee (to owner): {(feePreviewHBAR ?? 0).toFixed(6)} HBAR</li>
              <li>Prize (to winner): {(prizePreviewHBAR ?? 0).toFixed(6)} HBAR</li>
            </ul>
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="px-3 py-2 rounded-md border"
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-2 rounded-md bg-black text-white"
                onClick={onConfirm}
                autoFocus
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
