# web/src/lib — directory audit

This report describes every file in the [`web/src/lib:1`](web/src/lib:1) directory and how it interacts with the on-chain contract [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1).

Directory-level interaction diagram:

```mermaid
graph LR
Contracts[contracts/lottery.ts]
ABI[abi/Lottery.json]
Wagmi[wagmi.ts]
Hedera[hedera.ts]
Mirror[mirror.ts]
Appkit[appkit-init.client.ts]
Utils[utils.ts]
Contracts --> ABI
Contracts --> Wagmi
Mirror --> Contracts
Wagmi --> RPC[/web/src/server/rpc.ts:1]
```

Files

- [`web/src/lib/contracts/lottery.ts:1`](web/src/lib/contracts/lottery.ts:1)
  - Purpose: Exports the typed `LOTTERY_ABI` (from [`web/src/abi/Lottery.json:1`](web/src/abi/Lottery.json:1)) and validates/exports `LOTTERY_ADDRESS` (from env).
  - Why it's here: Single source for the contract ABI/address used across hooks, server code, and utilities.
  - Interaction with Lottery.sol: Acts as the frontend/backend bridge to the deployed contract ABI/address used to call and decode [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1).

- [`web/src/lib/wagmi.ts:1`](web/src/lib/wagmi.ts:1)
  - Purpose: Creates and exports a lightweight `publicClient` (viem) targeted at Hedera Testnet (`HEDERA_RPC_URL`) for non-hook reads.
  - Why it's here: Provides a single viem client for server and lib modules to perform read-only operations and multicalls.
  - Interaction with Lottery.sol: Used as the RPC transport when reading contract state (via `rpcClient` wrappers) against [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1).

- [`web/src/lib/hedera.ts:1`](web/src/lib/hedera.ts:1)
  - Purpose: Defines `hederaTestnet`, `HEDERA_RPC_URL`, `HEDERA_MIRROR_URL`, and (deprecated) `LOTTERY_ADDRESS` env shims.
  - Why it's here: Centralizes chain configuration and network constants used by wagmi/viem and AppKit.
  - Interaction with Lottery.sol: Supplies network config and an optional legacy contract address; canonical `LOTTERY_ADDRESS` is exported by [`web/src/lib/contracts/lottery.ts:1`](web/src/lib/contracts/lottery.ts:1).

- [`web/src/lib/config.ts:1`](web/src/lib/config.ts:1)
  - Purpose: Validates that the contract address exports/envs agree and warns or throws on mismatches.
  - Why it's here: Prevents accidental mismatched contract addresses between modules and environments.
  - Interaction with Lottery.sol: Guards that the frontend/server are pointed at the same deployed [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1) address.

- [`web/src/lib/mirror.ts:1`](web/src/lib/mirror.ts:1)
  - Purpose: Mirror Node helper to fetch logs, compute event topic0 hashes from the ABI, map logs to `FeedEntry`, and perform windowed/backfill queries with retry/backoff.
  - Why it's here: Centralizes event decoding and history backfills used by the snapshot service and `EventsProvider`.
  - Interaction with Lottery.sol: Direct — computes topics from the contract ABI and queries Mirror for events emitted by [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1) (EnteredPool, PoolFilled, WinnerPicked, RoundReset, etc.).

- [`web/src/lib/utils.ts:1`](web/src/lib/utils.ts:1)
  - Purpose: UI utility `cn()` (clsx + twMerge) for class name merging.
  - Why it's here: Small shared helper for components; no chain interaction.

- [`web/src/lib/appkit-init.client.ts:1`](web/src/lib/appkit-init.client.ts:1)
  - Purpose: Client-side AppKit / wallet bootstrap that initializes Reown/AppKit and exposes `getWagmiConfig` and `APPKIT_READY`.
  - Why it's here: Ensures consistent wallet config and prevents stale WalletConnect v2 artifacts during development.
  - Interaction with Lottery.sol: None directly; enables wallet flows used to sign transactions that call [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1).

Directory notes

- The `lib` folder centralizes chain configuration, the ABI/address bridge, Mirror Node helpers, and UI utilities. Keep `LOTTERY_ABI` in sync with [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1) and prefer `LOTTERY_ADDRESS` from [`web/src/lib/contracts/lottery.ts:1`](web/src/lib/contracts/lottery.ts:1) as authoritative.