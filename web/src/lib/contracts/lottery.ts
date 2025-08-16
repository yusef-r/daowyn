/* web/src/lib/contracts/lottery.ts */
import type { Abi } from 'viem'
import { hederaTestnet } from '@/lib/hedera'
import lotteryAbiJson from '@/abi/Lottery.json'
import { publicClient } from '@/lib/wagmi'  

// Validate and export contract address from env
const address = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS
if (!address) {
  throw new Error('Missing NEXT_PUBLIC_CONTRACT_ADDRESS in web/.env.local')
}
const isHexAddress = /^0x[a-fA-F0-9]{40}$/.test(address)
if (process.env.NODE_ENV !== 'production') {
  if (!isHexAddress) {
    console.warn('[contracts/lottery] NEXT_PUBLIC_CONTRACT_ADDRESS is not a 0x…40 hex address')
  }
}
export const LOTTERY_ADDRESS = address as `0x${string}`

// Export ABI (typed) from generated JSON
export const LOTTERY_ABI = (lotteryAbiJson as { abi: Abi }).abi

// Helper to get a viem PublicClient aligned with our configured chain
export function getHederaPublicClient() {
  const client = publicClient
  if (!client) {
    throw new Error('Public client is not available. Ensure Providers are set up.')
  }
  if (process.env.NODE_ENV !== 'production') {
    const connected = client.chain?.id
    console.debug('[contracts/lottery] Public client chainId:', connected)
  }
  if (client.chain && client.chain.id !== hederaTestnet.id) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `Warning: Connected chain id ${client.chain.id} differs from Hedera Testnet ${hederaTestnet.id}.`
      )
    }
  }
  return client
}