'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import { LOTTERY_ADDRESS } from '@/lib/hedera';
import useLotterySnapshot, { type LotterySnapshot } from '@/hooks/useLotterySnapshot';

type Ctx = {
  contract?: `0x${string}`;
  userAddress?: `0x${string}`;
  snap: LotterySnapshot;
  // Sticky ownership that stays true during stale/backoff until a fresh snapshot says otherwise
  isOwner: boolean;

  // Optimistic patch helpers
  optimisticEnter: (amountHBAR: string | number) => void;
};

const LotteryDataContext = createContext<Ctx | undefined>(undefined);

// Dev-only double-mount detector
let __lotteryProviderMounts = 0;

export function LotteryDataProvider({ children }: { children: React.ReactNode }) {
  const contract = LOTTERY_ADDRESS;
  const { address: userAddress } = useAccount();

  // Exactly one snapshot invocation; visibility-first (enabled independent of wallet chain)
  const snap = useLotterySnapshot(contract, userAddress, true);

  // Local optimistic overlay (e.g., self-enter) merged over snapshot until event refetch clears it
  const [overlay, setOverlay] = useState<Partial<LotterySnapshot> | null>(null);

  // Hard boundary on round transitions: clear optimistic overlay when roundId changes
  const prevRoundRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const r = snap.roundId;
    if (typeof r === 'number' && typeof prevRoundRef.current === 'number' && r !== prevRoundRef.current) {
      setOverlay(null);
      if (process.env.NODE_ENV !== 'production') {
        console.log('[lottery.round] roundId change detected; clearing optimistic overlay', { prev: prevRoundRef.current, next: r });
      }
    }
    prevRoundRef.current = r;
  }, [snap.roundId]);

  const effectiveSnap: LotterySnapshot = useMemo(() => {
    if (!overlay) return snap;
    return {
      ...snap,
      ...overlay,
      // force stale indicator while overlay is present
      isStale: true,
    } as LotterySnapshot;
  }, [snap, overlay]);

  // Sticky ownership: maintain last truthy until a fresh successful read flips it
  const [stickyOwner, setStickyOwner] = useState(false);
  const isOwnerNow =
    !!userAddress && !!snap.owner && userAddress.toLowerCase() === snap.owner.toLowerCase();

  useEffect(() => {
    if (!effectiveSnap.isStale) {
      // Only update on fresh successful snapshots
      setStickyOwner(isOwnerNow);
    }
  }, [isOwnerNow, effectiveSnap.isStale]);

  // Dev-only warning if mounted twice
  useEffect(() => {
    __lotteryProviderMounts += 1;
    if (process.env.NODE_ENV !== 'production' && __lotteryProviderMounts > 1) {
      // eslint-disable-next-line no-console
      console.warn('[LotteryDataProvider] Mounted more than once. Ensure a single instance at app root.');
    }
    return () => {
      __lotteryProviderMounts -= 1;
    };
  }, []);

  // Event-driven refetch via client watchers removed to enforce zero UI RPC.
  // Server snapshot polling will refresh state; optimistic overlay clears on next refetch.

  // Optimistic self-enter patch
  const optimisticEnter = (amountHBAR: string | number) => {
    try {
      const raw = String(amountHBAR).trim().replace(/[,\s_\u00A0]/g, '');
      const amt = Number(raw);
      if (!Number.isFinite(amt) || amt <= 0) {
        setOverlay((prev) => ({ ...(prev ?? {}), isStale: true } as Partial<LotterySnapshot>));
        return;
      }
      const amountTiny = BigInt(Math.floor(amt * 1e8)); // approximate tinybars
      const currentNet = effectiveSnap.netWeiTiny ?? 0n;
      const target = effectiveSnap.poolTargetWei;
      if (!target) {
        setOverlay({ isStale: true } as Partial<LotterySnapshot>);
        return;
      }
      const remaining = currentNet < target ? (target - currentNet) : 0n;
      const take = amountTiny < remaining ? amountTiny : remaining;
      const netNew = currentNet + take;
      const stageIndex =
        netNew >= target ? 1 : (effectiveSnap.stageIndex as number | undefined);

      setOverlay({
        netWeiTiny: netNew,
        stageIndex,
        isStale: true,
      } as Partial<LotterySnapshot>);
    } catch {
      setOverlay({ isStale: true } as Partial<LotterySnapshot>);
    }
  };

  const value = useMemo<Ctx>(
    () => ({
      contract,
      userAddress,
      snap: effectiveSnap,
      isOwner: stickyOwner,
      optimisticEnter,
    }),
    [contract, userAddress, effectiveSnap, stickyOwner]
  );

  return <LotteryDataContext.Provider value={value}>{children}</LotteryDataContext.Provider>;
}

export function useLotteryData() {
  const ctx = useContext(LotteryDataContext);
  if (!ctx) {
    throw new Error('useLotteryData must be used within a LotteryDataProvider');
  }
  return ctx;
}