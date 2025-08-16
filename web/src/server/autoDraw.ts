// web/src/server/autoDraw.ts
import fs from 'fs';
import path from 'path';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hederaTestnet, HEDERA_RPC_URL } from '@/lib/hedera';
import { rpcClient } from '@/server/rpc';
import { LOTTERY_ABI, LOTTERY_ADDRESS } from '@/lib/contracts/lottery';

type Stage = 'Filling' | 'Ready' | 'Drawing' | undefined;

const AUTO_DRAW_DELAY_MS = 10_000;

let current: { roundId?: number; willTriggerAt?: number; timer?: NodeJS.Timeout } | undefined;
const triggeredRounds = new Set<number>();

function cancelCurrent(): void {
  if (current?.timer) {
    clearTimeout(current.timer);
  }
  current = undefined;
}

function loadPrivateKeyFromChainEnv(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), 'chain/.env'),
    path.resolve(process.cwd(), '../chain/.env'),
    path.resolve(process.cwd(), '../../chain/.env'),
  ];
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const m = txt.match(/^\s*PRIVATE_KEY\s*=\s*(?:["']?)(.+?)(?:["']?)\s*$/m);
      if (m && m[1]) {
        return m[1].trim();
      }
    } catch {
      // ignore missing files/permissions
    }
  }
  return undefined;
}

async function tryTriggerDraw(expectedRoundId: number) {
  try {
    const a = LOTTERY_ADDRESS as `0x${string}`;
    const pStage = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'stage' });
    const pRound = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'roundId' });
    const pReady = rpcClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: 'isReadyForDraw' });

    const [stageRaw, roundRaw, isReady] = await Promise.all([pStage, pRound, pReady]);

    const stageIndex =
      typeof stageRaw === 'bigint' ? Number(stageRaw) : typeof stageRaw === 'number' ? stageRaw : undefined;
    const roundId = typeof roundRaw === 'bigint' ? Number(roundRaw) : typeof roundRaw === 'number' ? roundRaw : undefined;
    const stage: Stage = stageIndex === 0 ? 'Filling' : stageIndex === 1 ? 'Ready' : stageIndex === 2 ? 'Drawing' : undefined;

    // Confirm still Ready for same round
    if (stage !== 'Ready' || roundId !== expectedRoundId || !isReady) {
      cancelCurrent();
      return;
    }

    const privateKey = loadPrivateKeyFromChainEnv();
    if (!privateKey) {
      console.error('[autoDraw] PRIVATE_KEY not found in chain/.env');
      cancelCurrent();
      return;
    }

    const accountObj = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      chain: hederaTestnet,
      transport: http(HEDERA_RPC_URL),
      account: accountObj,
    });

    try {
      const tx = await walletClient.writeContract({
        address: LOTTERY_ADDRESS as `0x${string}`,
        abi: LOTTERY_ABI,
        functionName: 'triggerDraw',
        account: accountObj,
      });
      // Mark as triggered and clear state
      triggeredRounds.add(expectedRoundId);
      cancelCurrent();
      console.log('[autoDraw] triggerDraw tx submitted for round', expectedRoundId, 'tx:', tx);
    } catch (err) {
      console.error('[autoDraw] triggerDraw failed', err);
      cancelCurrent();
    }
  } catch (err) {
    console.error('[autoDraw] error in tryTriggerDraw', err);
    cancelCurrent();
  }
}

/**
 * ensureAutoDraw - idempotent scheduler hook
 * - Called from snapshot route with the current roundId, computed stage, and isReadyForDraw.
 * - Returns { willTriggerAt } when a timer is scheduled (epoch ms).
 */
export function ensureAutoDraw({
  roundId,
  stage,
  isReadyForDraw,
}: {
  roundId?: number;
  stage?: Stage;
  isReadyForDraw?: boolean;
}): { willTriggerAt?: number } {
  try {
    if (process.env.AUTO_DRAW_ENABLED !== 'true') return {};
    if (typeof roundId !== 'number') {
      cancelCurrent();
      return {};
    }

    const ready = stage === 'Ready' && Boolean(isReadyForDraw);
    if (!ready) {
      cancelCurrent();
      return {};
    }

    if (triggeredRounds.has(roundId)) return {};

    if (current?.roundId === roundId && current?.willTriggerAt) {
      return { willTriggerAt: current.willTriggerAt };
    }

    // New round - schedule single timer
    cancelCurrent();
    const willTriggerAt = Date.now() + AUTO_DRAW_DELAY_MS;
    const timer = setTimeout(() => {
      void tryTriggerDraw(roundId);
    }, AUTO_DRAW_DELAY_MS);

    current = { roundId, willTriggerAt, timer };
    return { willTriggerAt };
  } catch (err) {
    console.error('[autoDraw] ensureAutoDraw error', err);
    return {};
  }
}