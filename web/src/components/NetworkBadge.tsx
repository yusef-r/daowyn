'use client'
import { useChainId } from 'wagmi'
import clsx from 'clsx'
import { hederaTestnet } from '@/lib/hedera'

type Props = {
  expectedChainId?: number
  chainName?: string
  showExplorerLink?: boolean
  className?: string
}

export default function NetworkBadge({
  expectedChainId = hederaTestnet.id,
  chainName = 'Hedera Testnet',
  showExplorerLink = false,
  className
}: Props) {
  const chainId = useChainId()
  const onExpected = chainId === expectedChainId

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs',
        onExpected ? 'border-green-600/30' : 'border-amber-600/30',
        className
      )}
      aria-live="polite"
    >
      <span
        className={clsx(
          'h-2 w-2 rounded-full',
          onExpected ? 'bg-green-500' : 'bg-amber-500'
        )}
        aria-hidden="true"
      />
      <span className="font-medium">{chainName}</span>
      {!onExpected && (
        <span className="text-amber-600">Wrong network</span>
      )}
      {showExplorerLink && (
        <a
          href="https://hashscan.io/testnet"
          target="_blank"
          rel="noreferrer"
          className="underline-offset-2 hover:underline text-muted-foreground"
        >
          Explorer
        </a>
      )}
    </div>
  )
}