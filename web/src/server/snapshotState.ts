// web/src/server/snapshotState.ts
// Minimal shared snapshot state to avoid import cycles between route and keeper.

export type SnapshotLike = {
  body: Record<string, unknown>;
};

let lastSnapshot: SnapshotLike | undefined;

export function setSnapshot(s: SnapshotLike) {
  lastSnapshot = s;
}

export function getSnapshot(): SnapshotLike | undefined {
  return lastSnapshot;
}