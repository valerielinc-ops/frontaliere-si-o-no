import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const MAX_SERP_HISTORY_SNAPSHOTS = 260;

function snapshotKey(snapshot) {
  return [snapshot?.createdAt, snapshot?.variant, snapshot?.period].join('|');
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
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
      .slice(-MAX_SERP_HISTORY_SNAPSHOTS),
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
