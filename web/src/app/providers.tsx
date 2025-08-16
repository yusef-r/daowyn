'use client'
import { APPKIT_READY, getWagmiConfig } from '@/lib/appkit-init.client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query'
import { useMemo, useEffect } from 'react'
import WalletSessionGuard from './providers/WalletSessionGuard'
import { LotteryDataProvider } from '@/context/LotteryDataContext'
 
export default function Providers({ children }: { children: React.ReactNode }) {
  void APPKIT_READY
  const mountId = useMemo(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`, []);
  useEffect(() => {
    try {
      const g = globalThis as unknown as { __providerMountCount?: number }
      const prev = g.__providerMountCount ?? 0;
      g.__providerMountCount = prev + 1;
      console.log(`[provider.mount:${mountId}]`, { count: g.__providerMountCount, file: 'web/src/app/providers.tsx' });
    } catch {}
  }, [mountId]);

  const cfg = getWagmiConfig()
  const qc = useMemo(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error) => {
            // temporary visibility to avoid infinite skeletons
            console.error('[ReactQuery]', error)
          },
        }),
        defaultOptions: {
          queries: {
            retry: 1,
          },
        },
      }),
    []
  )
  if (!cfg) return null  // optional; now it only runs on client
 
  return (
    <WagmiProvider config={cfg}>
      <QueryClientProvider client={qc}>
        <LotteryDataProvider>
          <WalletSessionGuard />
          {children}
        </LotteryDataProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}