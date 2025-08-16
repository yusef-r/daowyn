# web/src/context — directory audit

This report describes every file in the [`web/src/context:1`](web/src/context:1) directory and how it interacts with the on-chain contract [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1).

Directory-level interaction diagram:

```mermaid
graph LR
Context[LotteryDataContext] --> Hook[useLotterySnapshot]
Hook --> API[/api/snapshot]
API --> Service[snapshot/service]
Service --> Chain[Lottery.sol]
Hook --> Mirror[web/src/lib/mirror]
Context --> Hedera[web/src/lib/hedera.ts]
```

Files

- [`web/src/context/LotteryDataContext.tsx:1`](web/src/context/LotteryDataContext.tsx:1)
  - Purpose: Provides a React context/provider (LotteryDataProvider) and the `useLotteryData` hook that exposes a single source-of-truth snapshot (snap), sticky ownership state, the connected user address, and optimistic patch helpers (optimisticEnter).
  - Why it's here: Centralizes snapshot consumption and optimistic UI behavior so components read a stable snapshot object instead of performing direct RPCs. It merges a local optimistic overlay over the server snapshot for transient UX (e.g., showing an immediate balance change after the user submits an entry).
  - Interaction with Lottery.sol: Indirect — imports the contract address from [`web/src/lib/hedera.ts:1`](web/src/lib/hedera.ts:1) and consumes the canonical snapshot produced by the server API [`web/src/app/api/snapshot/route.ts:1`](web/src/app/api/snapshot/route.ts:1), which is assembled by [`web/src/server/snapshot/service.ts:1`](web/src/server/snapshot/service.ts:1) from on-chain reads and Mirror-node events. The optimistic overlay reads snapshot fields such as `netWeiTiny` and `poolTargetWei` (tinybar units) to simulate a local "enter" — this is a client-side approximation cleared on the next fresh server snapshot.

  - Notes:
    - Uses a sticky owner boolean to avoid owner UI flapping while snapshots are stale.
    - `optimisticEnter` converts HBAR -> tinybars using 1e8 (matching the contract's tinybar units) via `BigInt(Math.floor(amount * 1e8))`; this is approximate and not authoritative.
    - Detects and warns when the provider is mounted multiple times (dev-only guard).
    - Intentionally does not perform contract calls itself; it delegates reads to the snapshot hook/service to keep client RPC surface minimal.

Directory-level notes

- The context is intentionally lightweight and focused on composition: it delegates all on-chain reads and event decoding to the server-side snapshot pipeline and the `useLotterySnapshot` hook. This centralization reduces client-side RPC traffic and keeps contract interaction logic consolidated on the server and in hooks.

End of report.