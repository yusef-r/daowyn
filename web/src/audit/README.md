# web/src audit index

This directory contains per-directory audits describing the purpose of every file in `web/src` and how each interacts with the contract [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1).

Directories and generated reports:
- abi — [`web/src/audit/abi.md:1`](web/src/audit/abi.md:1)
- app — [`web/src/audit/app.md:1`](web/src/audit/app.md:1)
- components — [`web/src/audit/components.md:1`](web/src/audit/components.md:1)
- context — [`web/src/audit/context.md:1`](web/src/audit/context.md:1)
- hooks — [`web/src/audit/hooks.md:1`](web/src/audit/hooks.md:1)
- lib — [`web/src/audit/lib.md:1`](web/src/audit/lib.md:1)
- server — [`web/src/audit/server.md:1`](web/src/audit/server.md:1)
- types — [`web/src/audit/types.md:1`](web/src/audit/types.md:1)

Status:
- [x] Generated per-directory audits

Notes:
- Each report contains concise summaries (1–3 sentences) per file and a directory-level interaction diagram.
- Files referencing the on-chain contract include exact links to [`chain/contracts/Lottery.sol:1`](chain/contracts/Lottery.sol:1).