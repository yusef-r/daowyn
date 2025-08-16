'use client'

import { useMemo, useState, useEffect } from 'react'
import { useAccount, useChainId } from 'wagmi'
import useLotteryReads, { useIsOwner } from '@/hooks/useLotteryReads'
import { useLotteryWrites } from '@/hooks/useLotteryWrites'
import { useEvents } from '@/app/providers/events'
import { Toaster } from 'sonner'
import { getExplorerTxUrl, getExplorerAccountUrl } from '@/lib/mirror'

export default function AdminCard() {
  const { isConnected } = useAccount()
  const { isOwner, owner } = useIsOwner()
  const chainId = useChainId()
  const {
    isReadyForDraw,
    isReadyDerived,
    isDrawing,
    participantCount,
    balanceHBAR,
    netHBAR,
    pendingRefundsTotalHBAR,
    pendingRefundUserHBAR,
    remainingHBAR,
    poolTargetWei,
    stage,
    stageIndex,
    lotteryAddress,
    readChainId: readChainIdFromHook,
    blockNumber,
    rawHBAR,
    targetHBAR,
    hasCode,
    codeHash,
    lastEvent,
    feePreviewHBAR,
    prizePreviewHBAR,
    readyMismatch,
    stageMismatch,
    loading,
    error,
    canDraw,
    onExpectedNetwork,
    refetch,
  } = useLotteryReads()
  const { triggerDraw, submitting, waiting, error: txError } = useLotteryWrites()
  const { latest: latestEvent } = useEvents()

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [optimisticDrawing, setOptimisticDrawing] = useState(false)
  const [toastKey, setToastKey] = useState(0)

  const canTrigger = useMemo(() => {
    // Only disable Draw when !isReadyForDraw; keep Admin visible via sticky isOwner
    return Boolean(isOwner && isReadyForDraw && onExpectedNetwork && !isDrawing && !optimisticDrawing)
  }, [isOwner, isReadyForDraw, onExpectedNetwork, isDrawing, optimisticDrawing])

  const currentDrawing = optimisticDrawing || isDrawing || waiting || submitting

  const onConfirm = async () => {
    setConfirmOpen(false)
    setOptimisticDrawing(true)
    try {
      const txHash = await triggerDraw()
      // Do not wait on-chain from the UI; rely on server snapshot refresh
      if (txHash) {
        await refetch()
      }
    } catch {
      // surface via txError state; reset optimistic state so user can retry
      setOptimisticDrawing(false)
      return
    }
    // keep optimistic true until events hook resets in future phase
    // for now, timeout reset as a fallback
    setTimeout(() => setOptimisticDrawing(false), 30_000)
  }

  // reset optimistic state and show a brief toast when WinnerPicked observed
  useEffect(() => {
    if (!latestEvent) return
    if (latestEvent.type === 'WinnerPicked') {
      setOptimisticDrawing(false)
      // bump toast key to trigger a simple notification (Toaster already mounted at layout)
      setToastKey(k => k + 1)
      // we intentionally don't call explicit refresh here; wagmi reads should refetch
    }
  }, [latestEvent])

  if (!isConnected) return null
  if (!isOwner) return null

  // debug values provided by hook

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Admin</h2>
        <span className="text-xs text-muted-foreground">Owner: {owner}</span>
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
          <span className={currentDrawing ? 'text-amber-600' : 'text-muted-foreground'}>
            {currentDrawing ? 'In progress' : 'Idle'}
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
          {currentDrawing ? 'Drawing…' : 'Trigger Draw'}
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
          <span className={readyMismatch ? 'text-red-600 font-medium' : ''}>
            {String(isReadyForDraw)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">isReadyDerived</span>
          <span className={readyMismatch ? 'text-red-600 font-medium' : ''}>
            {String(isReadyDerived)}
          </span>
        </div>
        {(readyMismatch || stageMismatch) && (
          <div className="text-red-600">
            Warning: readiness mismatch{stageMismatch ? ' (stage not Ready while net ≥ target)' : ''}.
          </div>
        )}
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
        {lastEvent && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last event</span>
            <span className="truncate">
              {lastEvent.name}
              {lastEvent.blockNumber !== undefined ? ` @#${lastEvent.blockNumber}` : ''}
              {lastEvent.txHash ? (
                <>
                  {' '}
                  <a
                    className="underline"
                    href={getExplorerTxUrl(lastEvent.txHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx
                  </a>
                </>
              ) : null}
            </span>
          </div>
        )}
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
      {/* Mount a lightweight Toaster trigger to ensure notifications can be shown from here if desired */}
      <Toaster richColors position="top-right" />
    </div>
  )
}
