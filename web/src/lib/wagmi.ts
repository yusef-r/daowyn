// web/src/lib/wagmi.ts
import { createPublicClient, http } from 'viem';
import { hederaTestnet, HEDERA_RPC_URL } from './hedera';

/** A lightweight viem client for non-hook reads (server actions, utilities, etc.) */
export const publicClient = createPublicClient({
  chain: hederaTestnet,
  transport: http(HEDERA_RPC_URL, { batch: { wait: 10, batchSize: 50 } }),
});

// Re-export the chain so old imports keep working.
export { hederaTestnet as chain } from './hedera';