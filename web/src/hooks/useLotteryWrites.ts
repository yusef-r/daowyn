'use client';

import { useCallback } from 'react';
import type { Address } from 'viem';
import { parseEther } from 'viem';
import { useWriteContract } from 'wagmi';
import { LOTTERY_ABI, LOTTERY_ADDRESS } from '@/lib/contracts/lottery';
import { useLotteryData } from '@/context/LotteryDataContext';

/** Hedera native decimals (HBAR tinybars) */
const HBAR_DECIMALS = 8;

/**
 * Enter flow: payable call to `enter()` sending native HBAR.
 * Consumers (EnterCard) expect:
 *  - enter(amountHBAR)
 *  - txHash, isPending, isConfirming, isConfirmed, error, reset
 */
export function useEnterLottery() {
  const {
    data: hash,
    isPending,
    error,
    writeContractAsync,
    reset: resetWrite,
  } = useWriteContract();

  const isConfirming = false;
  const isConfirmed = false;

  // Context optimistic patch for immediate UX feedback
  const { optimisticEnter } = useLotteryData();

  const enter = useCallback(
    async (amountHBAR: string | number) => {
      if (!LOTTERY_ADDRESS) {
        throw new Error('Missing NEXT_PUBLIC_CONTRACT_ADDRESS');
      }
      if (LOTTERY_ADDRESS.startsWith('0.0.')) {
        throw new Error('NEXT_PUBLIC_CONTRACT_ADDRESS must be an EVM 0x address, not 0.0.x');
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(LOTTERY_ADDRESS)) {
        throw new Error('Invalid NEXT_PUBLIC_CONTRACT_ADDRESS: expected 0x-prefixed EVM address');
      }
      // Normalize user input (strip grouping spaces/commas/underscores) before unit parsing
      const raw = String(amountHBAR);
      const normalized = raw.trim().replace(/[,\s_\u00A0]/g, '');
      // Send values as 18-decimal wei so HashPack/RPC relays accept them.
      // parseEther(normalized) returns a bigint in wei (18 decimals).
      const value = parseEther(normalized);

      // Solidity: function enter() external payable {}
      const txHash = await writeContractAsync({
        address: LOTTERY_ADDRESS as Address,
        abi: LOTTERY_ABI,
        functionName: 'enter',
        value,
      });

      // Optimistically patch local snapshot (take = min(remaining, amount))
      try {
        optimisticEnter(normalized);
      } catch {
        // noop
      }

      return txHash;
    },
    [writeContractAsync, optimisticEnter]
  );

  const reset = useCallback(() => {
    resetWrite();
    // useWaitForTransactionReceipt has no explicit reset; clearing hash via resetWrite is sufficient.
  }, [resetWrite]);

  return {
    // action
    enter,

    // tx state
    txHash: hash,
    isPending,      // wallet prompt shown / user confirming
    isConfirming,   // broadcasted, waiting for receipt
    isConfirmed,    // mined/confirmed
    error,
    reset,

    // legacy aliases used in some components
    submitting: isPending,
    waiting: isConfirming,
    txError: error,
  };
}

/**
 * Admin flow: `triggerDraw()` non-payable call.
 * Consumers (AdminCard) expect:
 *  - triggerDraw()
 *  - txHash, isPending, isConfirming, isConfirmed, error, reset
 *  - legacy aliases: submitting, waiting, txError
 */
export function useLotteryWrites() {
  const {
    data: hash,
    isPending,
    error,
    writeContractAsync,
    reset: resetWrite,
  } = useWriteContract();

  const isConfirming = false;
  const isConfirmed = false;

  const triggerDraw = useCallback(async () => {
    if (!LOTTERY_ADDRESS) {
      throw new Error('Missing NEXT_PUBLIC_CONTRACT_ADDRESS');
    }
    // Solidity: function triggerDraw() external {}
    return await writeContractAsync({
      address: LOTTERY_ADDRESS as Address,
      abi: LOTTERY_ABI,
      functionName: 'triggerDraw',
    });
  }, [writeContractAsync]);

  const reset = useCallback(() => {
    resetWrite();
  }, [resetWrite]);

  return {
    // actions
    triggerDraw,
    reset,

    // tx state
    txHash: hash,
    isPending,
    isConfirming,
    isConfirmed,
    error,

    // legacy aliases
    submitting: isPending,
    waiting: isConfirming,
    txError: error,
  };
}

export default useLotteryWrites;