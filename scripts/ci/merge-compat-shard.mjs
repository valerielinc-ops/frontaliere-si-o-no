#!/usr/bin/env node
// merge-compat-shard.mjs — custom git merge driver for the sharded
// seo-404-compat store (data/seo-404-compat/part-*.json).
//
// WHY THIS EXISTS
// ---------------
// Each shard is a pretty-printed JSON object `{ "paths": [ "...sorted..." ] }`
// (see scripts/lib/compat-paths-store.mjs). Many producers on `main`
// (sync-gsc-orphans, discover-404s, discover-404s-via-cloudflare, …) rewrite
// the shards concurrently. writeCompatPaths SORTS each shard, so adding a few
// paths shifts many lines; git's DEFAULT line-based 3-way merge then keeps both
// fully-rewritten sorted versions → the shard ends up with every path roughly
// TWICE and unsorted (observed post-#2988: 6/16 shards at ~2× size / ~135k
// lines / 68k unique). The store dedups on read so behaviour stays correct, but
// the on-disk bloat is real and `merge=union` would make it worse (it just
// concatenates both sides → duplicates). Same class of problem the
// `json-first-seen` driver solves for data/url-first-seen.json.
//
// This driver applies the shard's real merge semantics: a 3-way SET merge on
// `paths`. final = (ours ∪ theirs) minus any path that existed in the ancestor
// but was deleted by EITHER side (URL recovered → dropped from compat). Output
// matches writeCompatPaths' shard shape exactly: { "paths": [sorted] }, 2-space
// pretty print, trailing newline — so the result is deduped + sorted by
// construction and no duplicate bloat can accumulate.
//
// Registered in .gitattributes as `merge=compat-shard`; wired up with
// `git config merge.compat-shard.driver` inside the shared rebase helpers
// (scripts/lib/git-push-with-retry.sh and scripts/lib/git-commit-data.sh) so
// every concurrent producer gets it. Invoked by git as:
//   node scripts/ci/merge-compat-shard.mjs %O %A %B
// git reads the merged result back from %A (ours); exit 0 = resolved.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , basePath, oursPath, theirsPath] = process.argv; // %O %A %B

function loadPaths(p) {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8') || '{}');
    return Array.isArray(j?.paths) ? j.paths.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const base = new Set(loadPaths(basePath));
const ours = new Set(loadPaths(oursPath));
const theirs = new Set(loadPaths(theirsPath));

// 3-way set merge: keep everything either side has, then honour deletions —
// a path present in the ancestor but missing from ours OR theirs was removed
// on purpose and must not be resurrected by the union.
const final = new Set([...ours, ...theirs]);
for (const p of base) {
  if (!ours.has(p) || !theirs.has(p)) final.delete(p);
}

writeFileSync(oursPath, JSON.stringify({ paths: [...final].sort() }, null, 2) + '\n');
process.exit(0);
