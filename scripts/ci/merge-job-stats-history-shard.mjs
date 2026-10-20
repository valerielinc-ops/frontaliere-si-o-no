#!/usr/bin/env node
// 3-way merge driver for data/jobs-stats-history/YYYY-MM-DD.json (daily
// shards) and the legacy YYYY-MM.json monthly shards.
//
// Shards are rewritten JSON, not append-only text. Git's line merge
// would therefore retain two complete sorted rewrites or report a conflict
// whenever concurrent persist-job-stats runs update the same shard. The store
// merge is monotone by date: action keys are unioned and scalar counts keep the
// larger observed value.
import { readFileSync, writeFileSync } from 'node:fs';

import {
  assertJobStatsHistoryShardSize,
  mergeJobStatsHistoryEntries,
  serializeJobStatsHistoryShard,
} from '../lib/job-stats-history-store.mjs';

const [, , basePath, oursPath, theirsPath] = process.argv;

function loadShard(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, entries: [] };
  }
  if (raw.trim() === '') return { ok: true, entries: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.entries)) return { ok: false, entries: [] };
    return { ok: true, entries: parsed.entries };
  } catch {
    return { ok: false, entries: [] };
  }
}

const base = loadShard(basePath);
const ours = loadShard(oursPath);
const theirs = loadShard(theirsPath);

// Never turn a corrupt stage or a deleted non-empty shard into a clean merge.
// A caller can then apply an explicit resolver instead of silently dropping a
// month's history.
if (!base.ok || !ours.ok || !theirs.ok ||
    (base.entries.length > 0 && (ours.entries.length === 0 || theirs.entries.length === 0))) {
  process.stderr.write('[merge-job-stats-history-shard] refusing unsafe merge; surfacing conflict\n');
  process.exit(1);
}

const entries = mergeJobStatsHistoryEntries(ours.entries, theirs.entries);
const serialized = serializeJobStatsHistoryShard(entries);
// A union that GitHub would refuse to push must surface as a conflict, not as
// a clean merge that fails later at `git push` (#9654).
try {
  assertJobStatsHistoryShardSize(oursPath, serialized);
} catch (error) {
  process.stderr.write(`[merge-job-stats-history-shard] ${error.message}; surfacing conflict\n`);
  process.exit(1);
}
writeFileSync(oursPath, serialized, 'utf8');
