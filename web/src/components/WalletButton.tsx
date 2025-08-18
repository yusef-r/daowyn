'use client'

// FORCE init to execute before we use the hook below
import { APPKIT_READY } from '@/lib/appkit-init.client'
void APPKIT_READY

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppKit } from '@reown/appkit/react'
import { useAccount, useDisconnect, useChainId } from 'wagmi'
import { hederaTestnet } from '@/lib/hedera'

type Props = {
  // kept for compatibility; ignored
  variant?: 'primary' | 'ghost' | 'compact'
  size?: 'sm' | 'md' | 'lg'
  className?: string
  hidden?: boolean
}

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}
function shorten(addr?: string) {
  if (!addr) return ''
  return addr.slice(0, 6) + '…' + addr.slice(-4)
}

export default function WalletButton({
  variant = 'primary',
  className,
  hidden
}: Props) {
  const { open } = useAppKit()
  const { address, isConnected, isConnecting } = useAccount()
  const { disconnect } = useDisconnect()
  const chainId = useChainId()
  const wrongNetwork = isConnected && chainId !== hederaTestnet.id
  
  // Balance omitted to enforce zero direct UI RPCs
  const balLoading = false
  const hbarText = '—'

  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const handleClick = useCallback(() => {
    if (!isConnected || wrongNetwork) { open?.(); return }
    setMenuOpen(v => !v)
  }, [isConnected, wrongNetwork, open])

  const copyAddress = useCallback(async () => {
    if (!address) return
    try { await navigator.clipboard.writeText(address) } catch {}
  }, [address])

  if (hidden) return null

  return (
    <div ref={rootRef} className={cx('relative', className)}>
      <button
        type="button"
        onClick={handleClick}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-busy={isConnecting || undefined}
        className={cx(
          'wallet-button relative inline-flex items-center gap-1 rounded-xl px-2 py-1 text-xs font-medium',
          // primary when disconnected: solid green CTA (unless connecting)
          // no border (outline) in light mode; keep dark-mode outline classes
          !isConnected && !isConnecting
            ? 'bg-green-600 text-white hover:bg-green-700 cursor-pointer focus-visible:ring-green-600/50 focus-visible:ring-offset-2 dark:bg-green-700 dark:hover:bg-green-800 dark:border-green-700 dark:hover:border-green-800'
            : // color/variant: outline/ghost style (transparent bg, neutral border + text)
            variant === 'ghost'
              ? 'border border-neutral-200 bg-transparent hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900'
              : // when connected, match chip outline thickness (1px) across states
              isConnected
                ? 'bg-transparent text-neutral-700 border border-neutral-200 hover:bg-neutral-50 cursor-pointer dark:text-neutral-300 dark:border-neutral-800 dark:hover:bg-neutral-900'
                : 'bg-transparent text-neutral-700 border border-neutral-200 hover:bg-neutral-50 cursor-pointer dark:text-neutral-300 dark:border-neutral-800 dark:hover:bg-neutral-900',
          // motion + depth (safe for reduced-motion)
          'transition-[transform,box-shadow,background-color] duration-200 ease-[cubic-bezier(.2,.7,.4,1)] will-change-transform transform-gpu',
          'hover:shadow-[0_6px_16px_rgba(0,0,0,0.10)] active:shadow-[0_2px_8px_rgba(0,0,0,0.08)]',
          'motion-safe:hover:scale-[1.015] motion-safe:active:scale-[0.985]',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500/70 focus-visible:ring-offset-2',
          // subtle sheen on hover (very light)
          'before:pointer-events-none before:absolute before:inset-0 before:rounded-xl',
          'before:bg-[linear-gradient(120deg,transparent,rgba(255,255,255,0.12),transparent)]',
          'before:opacity-0 hover:before:opacity-100 before:transition-opacity before:duration-300'
        )}
      >
        {isConnecting ? (
          <span className="inline-flex items-center gap-2 font-medium">
            <span
              aria-hidden
              className="inline-block h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin"
            />
            Connecting…
          </span>
        ) : wrongNetwork ? (
          <span className="font-medium">Wrong Network</span>
        ) : !isConnected ? (
          <span className="font-medium">Connect Wallet</span>
        ) : (
          <>
            <span className="inline-flex items-center gap-2.5">
              <span className="font-medium">{shorten(address)}</span>
              <span
                aria-hidden
                className={cx(
                  'inline-block h-2 w-2 rounded-full',
                  isConnected && !wrongNetwork ? 'bg-green-500' : 'bg-neutral-300',
                  'transform-gpu transition-colors duration-150'
                )}
              />
            </span>
          </>
        )}
      </button>

      {isConnected && (
        <div
          role="menu"
          aria-hidden={!menuOpen}
          className={cx(
            'absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border bg-white dark:bg-neutral-900',
            'border-neutral-200 dark:border-neutral-800 shadow-lg',
            // smooth fade + slide (no jank)
            'transform-gpu origin-top-right transition-all duration-200 ease-[cubic-bezier(.2,.7,.4,1)]',
            menuOpen
              ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
              : 'opacity-0 -translate-y-1 scale-[0.995] pointer-events-none'
          )}
        >
          <ul className="py-1">
            {/* Balance removed to avoid client RPCs */}
            <li className="my-1 h-px bg-neutral-100 dark:bg-neutral-800" aria-hidden="true" />
            <li>
              <button
                role="menuitem"
                onClick={() => { open?.(); setMenuOpen(false) }}
                className="w-full text-left block px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                Manage Wallet
              </button>
            </li>
            <li>
              <a
                role="menuitem"
                href={address ? `https://hashscan.io/testnet/account/${address}` : 'https://hashscan.io/testnet'}
                target="_blank"
                rel="noreferrer"
                className="block px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                onClick={() => setMenuOpen(false)}
              >
                View on Hashscan
              </a>
            </li>
            <li>
              <button
                role="menuitem"
                onClick={() => { copyAddress(); setMenuOpen(false) }}
                className="w-full text-left block px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                Copy Address
              </button>
            </li>
            <li>
              <button
                role="menuitem"
                onClick={() => { disconnect(); setMenuOpen(false) }}
                className="w-full text-left block px-3 py-2 text-sm text-red-600 hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                Disconnect
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
