'use client'

import { useEffect } from 'react'
import { useAccount, useDisconnect } from 'wagmi'

/**
 * WalletSessionGuard
 * - Avoids any direct RPC from UI.
 * - On focus, pings the server snapshot route; on hard network failure, disconnects.
 */
export default function WalletSessionGuard() {
  const { status } = useAccount()
  const { disconnect } = useDisconnect()

  useEffect(() => {
    let cancelled = false

    const validate = async () => {
      if (status !== 'connected') return
      try {
        const res = await fetch('/api/snapshot', { method: 'GET', cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
      } catch {
        if (!cancelled) {
          try {
            disconnect()
          } catch {
            // ignore disconnect errors
          }
        }
      }
    }

    // run once on mount or when deps change
    void validate()

    // also recheck when the tab regains focus
    const onFocus = () => void validate()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [status, disconnect])

  return null
}