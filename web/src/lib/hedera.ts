// web/src/lib/hedera.ts
import { defineChain } from 'viem';

/** Public env (these must start with NEXT_PUBLIC_ to be available in the browser) */
export const HEDERA_RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? 'https://testnet.hashio.io/api';
export const HEDERA_MIRROR_URL =
  process.env.NEXT_PUBLIC_MIRROR_BASE ??
  process.env.NEXT_PUBLIC_MIRROR_URL ??
  'https://testnet.mirrornode.hedera.com';

/** Hedera Testnet chain definition for viem/wagmi */
export const hederaTestnet = defineChain({
  id: 296, // Hedera testnet
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 8 },
  rpcUrls: {
    default: { http: [HEDERA_RPC_URL] },
    public: { http: [HEDERA_RPC_URL] }
  },
  blockExplorers: {
    default: { name: 'Hashscan', url: 'https://hashscan.io/testnet' }
  },
  testnet: true,
});

/** Optional: surface the lottery address from env for consistent imports */
export const LOTTERY_ADDRESS =
  (process.env.NEXT_PUBLIC_LOTTERY_ADDRESS as `0x${string}` | undefined) ?? undefined;