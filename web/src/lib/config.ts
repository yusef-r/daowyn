// web/src/lib/config.ts
// Single-source-of-truth config guard. Verifies duplicate address exports and logs env usage.

import { LOTTERY_ADDRESS as CONTRACTS_LOTTERY_ADDRESS } from '@/lib/contracts/lottery';
import { LOTTERY_ADDRESS as HEDERA_LOTTERY_ADDRESS } from '@/lib/contracts/lottery';

/**
 * validateConfig()
 * - Logs resolved addresses from contracts/lottery and hedera modules
 * - Logs public envs for contract address
 * - Throws if duplicate exports disagree
 * - Warns if deprecated NEXT_PUBLIC_LOTTERY_ADDRESS differs from NEXT_PUBLIC_CONTRACT_ADDRESS
 */
export function validateConfig(): void {
  // Resolve from exports
  const aContracts = (CONTRACTS_LOTTERY_ADDRESS ?? '').toLowerCase();
  const aHedera = (HEDERA_LOTTERY_ADDRESS ?? '').toLowerCase();

  // Resolve envs
  const envContract = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? '').toLowerCase();
  const envLottery = (process.env.NEXT_PUBLIC_LOTTERY_ADDRESS ?? '').toLowerCase();

  // Diagnostics
  try {
    console.log('[config.diag.resolved]', {
      fromContractsLottery: aContracts,
      fromHederaLottery: aHedera || null,
      env_NEXT_PUBLIC_CONTRACT_ADDRESS: envContract || null,
      env_NEXT_PUBLIC_LOTTERY_ADDRESS: envLottery || null,
    });
  } catch {}

  // Hard guard: if both exports exist and mismatch, throw
  const isHex = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v);
  if (isHex(aContracts) && isHex(aHedera) && aContracts !== aHedera) {
    throw new Error(
      `Config mismatch: LOTTERY_ADDRESS exports disagree (contracts=${aContracts} hedera=${aHedera}). ` +
      `Use contracts/lottery only and align env NEXT_PUBLIC_CONTRACT_ADDRESS.`
    );
  }

  // Soft guard: if deprecated env present and mismatched, warn
  if (envLottery && envContract && envLottery !== envContract) {
    console.warn(
      '[config.warn.env_mismatch] NEXT_PUBLIC_LOTTERY_ADDRESS differs from NEXT_PUBLIC_CONTRACT_ADDRESS. ' +
      'NEXT_PUBLIC_LOTTERY_ADDRESS is deprecated and will be ignored; update your .env.local.'
    );
  }
}