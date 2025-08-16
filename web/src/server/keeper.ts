// web/src/server/keeper.ts
// Minimal server-side keeper that auto-triggers draw near reveal time.
// Idempotent per round, single-fire, no client RPCs. Uses admin signer from env.

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hederaTestnet, HEDERA_RPC_URL } from '@/lib/hedera';
import { LOTTERY_ABI, LOTTERY_ADDRESS } from '@/lib/contracts/lottery';
import { getSnapshot } from '@/server/snapshotState';

type SpinLandingPlanJSON = {
  layoutHash: string;
  targetSegmentId: string;
  startAt: number;
  durationMs: number;
  easing: 'easeOutCubic';
  rotations: number;
};
type SpinJSON = {
  phase: 'idle' | 'neutral' | 'landing' | 'done';
  neutralStartAt?: number;
  revealTargetAt?: number;
  landingPlan?: SpinLandingPlanJSON;
};

let started = false;
let walletReady = false;
let walletErrorLogged = false;

// Per-round trigger memory to avoid duplicates
const triggeredAt = new Map<number, number>();
const triggering = new Set<number>();

let walletClient: ReturnType<typeof createWalletClient> | undefined;

function getWallet() {
  try {
    if (walletClient) return walletClient;
    // Prefer explicit admin key; fallback to owner/private keys if present (server-only)
    const pkRaw = (
      process.env.LOTTERY_ADMIN_PRIVATE_KEY ??
      process.env.LOTTERY_OWNER_PRIVATE_KEY ??
      process.env.OWNER_PRIVATE_KEY ??
      process.env.PRIVATE_KEY ??
      ''
    ).trim();
    if (!pkRaw) {
      if (!walletErrorLogged) {
        console.warn('[keeper] no admin/owner private key configured; keeper idle');
        walletErrorLogged = true;
      }
      return undefined;
    }
    const pk = pkRaw.startsWith('0x') ? (pkRaw as `0x${string}`) : (`0x${pkRaw}` as `0x${string}`);
    const account = privateKeyToAccount(pk);
    walletClient = createWalletClient({
      account,
      chain: hederaTestnet,
      transport: http(HEDERA_RPC_URL),
    });
    walletReady = true;
    console.log('[keeper] wallet ready; admin:', account.address);
    return walletClient;
  } catch (e) {
    if (!walletErrorLogged) {
      console.error('[keeper] wallet init error', e);
      walletErrorLogged = true;
    }
    return undefined;
  }
}

async function tryTrigger(roundId: number) {
  if (!LOTTERY_ADDRESS) return;
  const w = getWallet();
  if (!w) return;
  if (triggering.has(roundId)) return;

  triggering.add(roundId);
  try {
    const hash = await w.writeContract({
      address: LOTTERY_ADDRESS as `0x${string}`,
      abi: LOTTERY_ABI,
      functionName: 'triggerDraw',
      account: w.account!,
      chain: hederaTestnet,
    });
    const ts = Date.now();
    triggeredAt.set(roundId, ts);
    console.log(`[keeper] triggerDraw sent round=${roundId} tx=${hash} at ${new Date(ts).toISOString()}`);
  } catch (e) {
    console.error('[keeper] triggerDraw error', e);
  } finally {
    triggering.delete(roundId);
  }
}

export function ensureKeeper() {
  if (started) return;
  started = true;

  // Light loop; no upstream RPCs. Reads in-memory lastGood snapshot.
  setInterval(() => {
    try {
      // Initialize wallet lazily
      if (!walletReady) getWallet();

      const snap = getSnapshot();
      if (!snap) return;
      const body = snap.body as Record<string, unknown>;
      const roundId = typeof body.roundId === 'number' ? (body.roundId as number) : undefined;
      const stageIndex = typeof body.stageIndex === 'number' ? (body.stageIndex as number) : undefined;
      const isDrawing = Boolean(body.isDrawing);
      const spin = body.spin as SpinJSON | undefined;

      if (typeof roundId !== 'number') return;

      // Already triggered this round
      if (triggeredAt.has(roundId)) return;

      // Only act when Locked/Ready or Drawing stages exist (>= 1), not actively drawing, and no winner/plan yet
      const readyStage = typeof stageIndex === 'number' && stageIndex >= 1;
      const hasLandingPlan = Boolean(spin?.landingPlan);
      if (!readyStage || isDrawing || hasLandingPlan) return;

      const targetAt = typeof spin?.revealTargetAt === 'number' ? spin!.revealTargetAt! : undefined;
      if (typeof targetAt !== 'number' || targetAt <= 0) return;

      const now = Date.now();
      // Trigger when now >= revealTargetAt - 3000ms
      if (now >= targetAt - 3000) {
        void tryTrigger(roundId);
      }
    } catch {
      // swallow
    }
  }, 1000);
}