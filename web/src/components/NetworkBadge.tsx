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
        'inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-xs font-medium bg-[#FFFBF2] border-[#E6C86B]',
        className
      )}
      aria-live="polite"
    >
      <span className="font-medium text-[#B8860B]">{chainName}</span>
      {!onExpected && (
        <span className="text-[#996515]">Wrong network</span>
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