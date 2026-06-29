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
//
// RELATIONSHIP TO resolve-404-compat-conflict.mjs
// -----------------------------------------------
// This driver only owns the COMMON case: two producers each rewrote a shard
// with overlapping path sets → it dedups them by construction (the bloat fix).
// It deliberately does NOT subsume the registered in-place resolver
// (resolve-404-compat-conflict.mjs, wired via `--in-place-resolver-cmd`), which
// owns the SAFETY case: it runs assertCompatFloor (compat-paths-floor-guard.mjs)
// over the re-normalised TOTAL store and re-runs the fail-closed resolvability
// prune (scripts/prune-404-compat-paths.ts, PRUNE_404_STRICT=1) so a
// non-resolving path can't survive the merge and turn search-console-compat
// red. Because git invokes the content driver BEFORE the rebase reports
// conflicts, a driver that exits 0 on a degraded input would auto-resolve the
// shard, the rebase would return 0, and the resolver (which only runs when the
// rebase FAILS) would never fire — silently skipping both safety nets. So when
// the merge can't be trusted (see the fail-closed guard below) the driver
// SURFACES the conflict (exit 1) and hands off to the resolver instead.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , basePath, oursPath, theirsPath] = process.argv; // %O %A %B

// Read one merge stage. `ok:false` flags an input we could NOT trust — a
// corrupt/mid-write blob or an unreadable temp file (git always materialises
// the three stages, so an unreadable %O/%A/%B is an environment fault, not a
// legitimately-absent side). A genuinely-empty stage (e.g. no merge base for a
// newly-added shard) parses fine and stays `ok:true` with zero paths.
function loadPaths(p) {
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return { paths: [], ok: false };
  }
  if (raw.trim() === '') return { paths: [], ok: true };
  try {
    const j = JSON.parse(raw);
    const paths = Array.isArray(j?.paths) ? j.paths.filter((x) => typeof x === 'string') : [];
    return { paths, ok: true };
  } catch {
    return { paths: [], ok: false };
  }
}

const baseR = loadPaths(basePath);
const oursR = loadPaths(oursPath);
const theirsR = loadPaths(theirsPath);

const base = new Set(baseR.paths);
const ours = new Set(oursR.paths);
const theirs = new Set(theirsR.paths);

// Fail-closed guard (#1353 / the 404-truncation class — see
// compat-paths-floor-guard.mjs). Without it, loadPaths degrades a corrupt or
// mid-write side to an empty set and the deletion step below ((ours ∪ theirs)
// minus any base path absent from EITHER side) reads that emptiness as "every
// base path was intentionally removed" → it wipes this whole shard, ~1/shardCount
// of the 404→301 redirect engine. That loss sits BELOW the 150k *total* floor (a
// single shard holds far less, so a global assertCompatFloor can't catch it —
// resolve-404-compat-conflict.mjs makes the same observation), and writing it +
// exiting 0 looks like a clean auto-merge, so the resolver's floor guard +
// resolvability prune never run. Surface a conflict instead and let the complete
// resolver take over. Two untrustworthy shapes:
//   1. any side failed to parse (corrupt / mid-write / unreadable), or
//   2. a contributing side is empty while the ancestor has paths → the deletion
//      step would collapse the shard.
const parseFailed = !baseR.ok || !oursR.ok || !theirsR.ok;
const emptySideWithDeletableBase = (ours.size === 0 || theirs.size === 0) && base.size > 0;
if (parseFailed || emptySideWithDeletableBase) {
  process.stderr.write(
    `[merge-compat-shard] refusing to auto-merge (base=${base.size} ours=${ours.size} theirs=${theirs.size}): ` +
      (parseFailed ? 'a side failed to parse' : 'a side is empty while the ancestor has paths') +
      '. Surfacing conflict for resolve-404-compat-conflict.mjs (floor guard + resolvability prune).\n',
  );
  process.exit(1);
}

// 3-way set merge: keep everything either side has, then honour deletions —
// a path present in the ancestor but missing from ours OR theirs was removed
// on purpose and must not be resurrected by the union.
const final = new Set([...ours, ...theirs]);
for (const p of base) {
  if (!ours.has(p) || !theirs.has(p)) final.delete(p);
}

writeFileSync(oursPath, JSON.stringify({ paths: [...final].sort() }, null, 2) + '\n');
process.exit(0);
