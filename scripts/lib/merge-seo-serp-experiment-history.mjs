import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const MAX_SERP_HISTORY_SNAPSHOTS = 260;

function snapshotKey(snapshot) {
  const rawCreatedAt = String(snapshot?.createdAt ?? '');
  const timestamp = Date.parse(rawCreatedAt);
  return JSON.stringify({
    ...snapshot,
    createdAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : rawCreatedAt,
  });
}

function snapshotTimestamp(snapshot) {
  const timestamp = Date.parse(String(snapshot?.createdAt ?? ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function mergeSeoSerpHistory(current, incoming) {
  const snapshots = new Map();
  for (const snapshot of [...(current?.snapshots ?? []), ...(incoming?.snapshots ?? [])]) {
    snapshots.set(snapshotKey(snapshot), snapshot);
  }
  return {
    ...(current ?? {}),
    ...(incoming ?? {}),
    snapshots: [...snapshots.values()]
      .map((snapshot) => ({ snapshot, timestamp: snapshotTimestamp(snapshot) }))
      .filter((entry) => entry.timestamp !== null)
      .sort((a, b) => a.timestamp - b.timestamp || snapshotKey(a.snapshot).localeCompare(snapshotKey(b.snapshot)))
      .slice(-MAX_SERP_HISTORY_SNAPSHOTS)
      .map((entry) => entry.snapshot),
  };
}

function readGitFile(ref, file) {
  return JSON.parse(execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' }));
}

if (process.argv[1] && process.argv[1].endsWith('merge-seo-serp-experiment-history.mjs')) {
  const [, , sourceRef, targetFile = 'data/seo-serp-experiment-history.json'] = process.argv;
  if (!sourceRef) throw new Error('usage: merge-seo-serp-experiment-history.mjs <source-ref> [file]');
  const current = fs.existsSync(targetFile) ? JSON.parse(fs.readFileSync(targetFile, 'utf8')) : {};
  const incoming = readGitFile(sourceRef, targetFile);
  fs.writeFileSync(targetFile, `${JSON.stringify(mergeSeoSerpHistory(current, incoming), null, 2)}\n`);
}
