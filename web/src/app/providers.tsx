'use client'
import { APPKIT_READY, getWagmiConfig } from '@/lib/appkit-init.client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query'
import { useMemo } from 'react'
import WalletSessionGuard from './providers/WalletSessionGuard'
import { LotteryDataProvider } from '@/context/LotteryDataContext'
import AutoDrawDialog from '@/components/AutoDrawDialog'

export default function Providers({ children }: { children: React.ReactNode }) {
  void APPKIT_READY
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
          <AutoDrawDialog />
          {children}
        </LotteryDataProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}