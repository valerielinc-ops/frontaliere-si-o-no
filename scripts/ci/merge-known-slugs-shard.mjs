#!/usr/bin/env node
// merge-known-slugs-shard.mjs — custom git merge driver for the sharded
// canonical slug registry (data/all-known-job-slugs/part-*.json).
//
// WHY THIS EXISTS
// ---------------
// Each shard is a pretty-printed JSON object `{ "slugs": { "<slug>": {it,en,
// de,fr} } }` with SORTED keys (see scripts/lib/all-known-job-slugs-store.mjs).
// Several producers rewrite the registry on `main` — sync-gsc-orphans,
// mine-all-job-slugs, migrate-all-known-job-slugs-canton-aware (which runs in
// deploy, tests, post-deploy-validate-dist and the seo-build-data-prep
// composite action) — and they race each other's pushes. Because every write
// re-serialises the whole sorted shard, git's DEFAULT line-based 3-way merge
// has no stable anchor: it either conflicts (wedging the rebase-retry loop the
// push helper depends on) or keeps both rewritten halves, which for a JSON
// OBJECT means duplicate keys, not just bloat. This is the exact failure the
// `compat-shard` driver was written for after issue #2988 — same store shape,
// same producers, same race — so it gets the same treatment rather than a
// second, subtly different resolution strategy.
//
// This driver applies the shard's real merge semantics: a 3-way merge on the
// `slugs` MAP.
//   final = (ours ∪ theirs) minus any slug present in the ancestor but dropped
//   by EITHER side (a slug removed on purpose must not be resurrected).
// When both sides kept a slug but disagree on its value, the side that actually
// changed it wins; if BOTH changed it (e.g. two canton-aware migrations racing)
// the per-locale maps are unioned with ours preferred — losing a locale path
// costs a soft-landing page, so the merge is deliberately additive.
//
// Output matches writeAllKnownJobSlugs' shard shape exactly: sorted keys,
// 2-space pretty print, trailing newline — so the result is canonical by
// construction and cannot accumulate drift.
//
// Registered in .gitattributes as `merge=known-slugs-shard`; wired up with
// `git config merge.known-slugs-shard.driver` inside the shared rebase helpers
// (scripts/lib/git-push-with-retry.sh and scripts/lib/git-commit-data.sh) so
// every concurrent producer gets it. Invoked by git as:
//   node scripts/ci/merge-known-slugs-shard.mjs %O %A %B
// git reads the merged result back from %A (ours); exit 0 = resolved.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , basePath, oursPath, theirsPath] = process.argv; // %O %A %B

// Read one merge stage. `ok:false` flags an input we could NOT trust — a
// corrupt/mid-write blob or an unreadable temp file (git always materialises
// the three stages, so an unreadable %O/%A/%B is an environment fault, not a
// legitimately-absent side). A genuinely-empty stage (no merge base for a
// newly-added shard) parses fine and stays `ok:true` with zero slugs.
function loadSlugs(p) {
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return { slugs: {}, ok: false };
  }
  if (raw.trim() === '') return { slugs: {}, ok: true };
  try {
    const j = JSON.parse(raw);
    const s = j && typeof j.slugs === 'object' && j.slugs !== null ? j.slugs : {};
    return { slugs: s, ok: true };
  } catch {
    return { slugs: {}, ok: false };
  }
}

const baseR = loadSlugs(basePath);
const oursR = loadSlugs(oursPath);
const theirsR = loadSlugs(theirsPath);

const baseKeys = Object.keys(baseR.slugs);
const oursKeys = Object.keys(oursR.slugs);
const theirsKeys = Object.keys(theirsR.slugs);

// Fail-closed guard, same reasoning as merge-compat-shard.mjs: without it,
// loadSlugs degrades a corrupt or mid-write side to an empty map and the
// deletion step below reads that emptiness as "every ancestor slug was
// intentionally removed" → it wipes ~1/32 of the canonical slug registry, which
// is an accumulator nothing can rebuild. Exiting 0 after that would look like a
// clean auto-merge. Surface the conflict instead and let the push helper's
// rebase fail loudly.
const parseFailed = !baseR.ok || !oursR.ok || !theirsR.ok;
const emptySideWithDeletableBase = (oursKeys.length === 0 || theirsKeys.length === 0) && baseKeys.length > 0;
if (parseFailed || emptySideWithDeletableBase) {
  process.stderr.write(
    `[merge-known-slugs-shard] refusing to auto-merge (base=${baseKeys.length} ours=${oursKeys.length} theirs=${theirsKeys.length}): ` +
      (parseFailed ? 'a side failed to parse' : 'a side is empty while the ancestor has slugs') +
      '. Surfacing conflict rather than wiping a shard of the canonical slug registry.\n',
  );
  process.exit(1);
}

const stable = (v) => JSON.stringify(v);

/** Union the two locale maps, preferring ours on the same locale key. */
function mergeLocalePaths(ourVal, theirVal) {
  if (!ourVal || typeof ourVal !== 'object') return theirVal;
  if (!theirVal || typeof theirVal !== 'object') return ourVal;
  const merged = {};
  for (const k of Object.keys(theirVal)) {
    if (k === '__proto__') continue;
    merged[k] = theirVal[k];
  }
  for (const k of Object.keys(ourVal)) {
    if (k === '__proto__') continue;
    merged[k] = ourVal[k];
  }
  return merged;
}

const final = {};
for (const k of new Set([...oursKeys, ...theirsKeys])) {
  if (k === '__proto__') continue;
  const inOurs = Object.prototype.hasOwnProperty.call(oursR.slugs, k);
  const inTheirs = Object.prototype.hasOwnProperty.call(theirsR.slugs, k);
  const inBase = Object.prototype.hasOwnProperty.call(baseR.slugs, k);

  // Honour deletions: present in the ancestor but dropped by one side.
  if (inBase && (!inOurs || !inTheirs)) continue;

  if (inOurs && !inTheirs) {
    final[k] = oursR.slugs[k];
  } else if (inTheirs && !inOurs) {
    final[k] = theirsR.slugs[k];
  } else {
    const o = oursR.slugs[k];
    const t = theirsR.slugs[k];
    if (stable(o) === stable(t)) final[k] = o;
    else if (inBase && stable(o) === stable(baseR.slugs[k])) final[k] = t; // only theirs changed
    else if (inBase && stable(t) === stable(baseR.slugs[k])) final[k] = o; // only ours changed
    else final[k] = mergeLocalePaths(o, t); // both changed → additive union
  }
}

const sorted = {};
for (const k of Object.keys(final).sort()) sorted[k] = final[k];

writeFileSync(oursPath, JSON.stringify({ slugs: sorted }, null, 2) + '\n');
process.exit(0);
