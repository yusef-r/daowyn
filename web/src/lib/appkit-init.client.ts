'use client'

/**
 * AppKit bootstrap that runs once on the client and exposes the SAME wagmiConfig
 * your app will use in <WagmiProvider>. Exporting APPKIT_READY ensures this module
 * cannot be tree-shaken and executes before any useAppKit() call in that bundle.
 */

import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { hederaTestnet } from '@/lib/hedera'
import type { Config } from 'wagmi';

declare global {
  interface Window {
    __appkit_inited__?: boolean;
    __appkit_wagmi_config__?: Config;
  }
}

const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID

export const APPKIT_READY: boolean = (() => {
  if (typeof window === 'undefined') return false
  if (window.__appkit_inited__) return true

  if (!projectId) {
    console.warn('[AppKit] Missing NEXT_PUBLIC_WC_PROJECT_ID')
    return false
  }

  const adapter = new WagmiAdapter({
    ssr: false,
    projectId,
    networks: [hederaTestnet],
  })

  createAppKit({
    adapters: [adapter],
    projectId,
    networks: [hederaTestnet],
    defaultNetwork: hederaTestnet,
    // add/keep wallet ids if you want, optional
    includeWalletIds: [
      'a29498d225fa4b13468ff4d6cf4ae0ea4adcbd95f07ce8a843a1dee10b632f3f', // HashPack
      'c40c24b39500901a330a025938552d70def4890fffe9bd315046bd33a2ece24d', // Kabila
      'a9104b630bac1929ad9ac2a73a17ed4beead1889341f307bff502f89b46c8501', // Blade
    ],
    features: { analytics: false },
    metadata: {
      name: 'DAOWYN',
      description: 'Hedera dApp',
      url: typeof location !== 'undefined' ? location.origin : 'http://localhost:3000',
      icons: [],
    },
  })

  // expose wagmiConfig so the app uses the exact same instance
  window.__appkit_wagmi_config__ = adapter.wagmiConfig
  window.__appkit_inited__ = true
  return true
})()

// Consumers (Providers) will import this so both sides use one config
export function getWagmiConfig(): Config | undefined {
  return typeof window !== 'undefined'
    ? (window.__appkit_wagmi_config__ as Config | undefined)
    : undefined;
}