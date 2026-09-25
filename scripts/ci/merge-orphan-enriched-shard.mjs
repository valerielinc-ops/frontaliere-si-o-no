#!/usr/bin/env node
// merge-orphan-enriched-shard.mjs — custom git merge driver for the sharded
// enriched-orphan ledger (data/orphan-enriched-data/part-*.json).
//
// WHY THIS EXISTS
// ---------------
// Each shard is a pretty-printed JSON object `{ "orphans": [ … ] }` whose array
// is sorted by (slug, locale) — see scripts/lib/orphan-enriched-store.mjs.
// Several producers rewrite the ledger on `main` and race each other's pushes:
// sync-gsc-orphans (the whole ledger, every run) and enrich-compat-orphan-slugs
// (appends translation-cache content). Because every write re-serialises the
// whole sorted shard, git's DEFAULT line-based 3-way merge has no stable
// anchor: it either conflicts — wedging the rebase-retry loop the push helper
// depends on — or keeps both rewritten halves, which for a JSON ARRAY means
// duplicate records and a doubled blob, i.e. exactly the size problem the
// sharding was introduced to solve.
//
// This is the same failure the `compat-shard` (#2988) and `known-slugs-shard`
// (#4248) drivers were written for — same store family, same producers, same
// race — so it gets the same treatment rather than a third, subtly different
// resolution strategy. The only difference is the payload shape: an ARRAY keyed
// by (locale, slug) instead of a map keyed by slug.
//
// Merge semantics, on the record set keyed by `${locale}:${slug}` (the identity
// sync-gsc-orphans step 2c itself uses):
//   final = (ours ∪ theirs) minus any record present in the ancestor but
//   dropped by EITHER side (a record removed on purpose must not be
//   resurrected).
// When both sides kept a record but disagree on its value, the side that
// actually changed it wins. If BOTH changed it (two enrichment passes racing),
// the record with the STRONGER search signal wins — impressions/clicks/queries
// are what the soft-landing page renders, so the merge deliberately keeps the
// richer observation rather than the newer one.
//
// Output matches writeOrphanEnriched's shard shape exactly: array sorted by
// (slug, locale), 2-space pretty print, trailing newline — so the result is
// canonical by construction and cannot accumulate drift.
//
// Registered in .gitattributes as `merge=orphan-enriched-shard`; wired up with
// `git config merge.orphan-enriched-shard.driver` inside the shared rebase
// helpers (scripts/lib/git-push-with-retry.sh and scripts/lib/git-commit-data.sh)
// so every concurrent producer gets it. Invoked by git as:
//   node scripts/ci/merge-orphan-enriched-shard.mjs %O %A %B
// git reads the merged result back from %A (ours); exit 0 = resolved.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , basePath, oursPath, theirsPath] = process.argv; // %O %A %B

/** Same identity as scripts/lib/orphan-enriched-store.mjs `orphanRecordKey`. */
function recordKey(r) {
  return `${r?.locale || 'it'}:${r?.slug ?? ''}`;
}

// Read one merge stage. `ok:false` flags an input we could NOT trust — a
// corrupt/mid-write blob or an unreadable temp file (git always materialises
// the three stages, so an unreadable %O/%A/%B is an environment fault, not a
// legitimately-absent side). A genuinely-empty stage (no merge base for a
// newly-added shard) parses fine and stays `ok:true` with zero records.
function loadRecords(p) {
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return { map: new Map(), ok: false };
  }
  if (raw.trim() === '') return { map: new Map(), ok: true };
  try {
    const j = JSON.parse(raw);
    const list = Array.isArray(j?.orphans) ? j.orphans : [];
    const map = new Map();
    for (const r of list) {
      if (!r || typeof r !== 'object' || !r.slug) continue;
      map.set(recordKey(r), r);
    }
    return { map, ok: true };
  } catch {
    return { map: new Map(), ok: false };
  }
}

const baseR = loadRecords(basePath);
const oursR = loadRecords(oursPath);
const theirsR = loadRecords(theirsPath);

// Fail-closed guard, same reasoning as merge-known-slugs-shard.mjs: without it,
// loadRecords degrades a corrupt or mid-write side to an empty map and the
// deletion step below reads that emptiness as "every ancestor record was
// intentionally removed" → it wipes ~1/32 of an accumulator nothing can
// rebuild (the GSC signal behind these records ages out of the 16-month
// window). Exiting 0 after that would look like a clean auto-merge. Surface the
// conflict instead and let the push helper's rebase fail loudly.
const parseFailed = !baseR.ok || !oursR.ok || !theirsR.ok;
const emptySideWithDeletableBase =
  (oursR.map.size === 0 || theirsR.map.size === 0) && baseR.map.size > 0;
if (parseFailed || emptySideWithDeletableBase) {
  process.stderr.write(
    `[merge-orphan-enriched-shard] refusing to auto-merge (base=${baseR.map.size} ours=${oursR.map.size} theirs=${theirsR.map.size}): ` +
      (parseFailed ? 'a side failed to parse' : 'a side is empty while the ancestor has records') +
      '. Surfacing conflict rather than wiping a shard of the enriched-orphan ledger.\n',
  );
  process.exit(1);
}

const stable = (v) => JSON.stringify(v);

/** Higher = more search signal. Ties are broken by the caller, not here. */
function signal(r) {
  return [
    Number(r?.totalImpressions) || 0,
    Number(r?.totalClicks) || 0,
    Array.isArray(r?.queries) ? r.queries.length : 0,
  ];
}

/** Keep the record carrying the stronger GSC signal; `ours` wins a pure tie. */
function richer(ourVal, theirVal) {
  const a = signal(ourVal);
  const b = signal(theirVal);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? ourVal : theirVal;
  }
  return ourVal;
}

const final = new Map();
for (const k of new Set([...oursR.map.keys(), ...theirsR.map.keys()])) {
  const inOurs = oursR.map.has(k);
  const inTheirs = theirsR.map.has(k);
  const inBase = baseR.map.has(k);

  // Honour deletions: present in the ancestor but dropped by one side.
  if (inBase && (!inOurs || !inTheirs)) continue;

  if (inOurs && !inTheirs) {
    final.set(k, oursR.map.get(k));
  } else if (inTheirs && !inOurs) {
    final.set(k, theirsR.map.get(k));
  } else {
    const o = oursR.map.get(k);
    const t = theirsR.map.get(k);
    if (stable(o) === stable(t)) final.set(k, o);
    else if (inBase && stable(o) === stable(baseR.map.get(k))) final.set(k, t); // only theirs changed
    else if (inBase && stable(t) === stable(baseR.map.get(k))) final.set(k, o); // only ours changed
    else final.set(k, richer(o, t)); // both changed → keep the richer observation
  }
}

const orphans = [...final.values()].sort((a, b) => {
  const sa = String(a?.slug ?? '');
  const sb = String(b?.slug ?? '');
  if (sa !== sb) return sa < sb ? -1 : 1;
  const la = String(a?.locale ?? '');
  const lb = String(b?.locale ?? '');
  if (la !== lb) return la < lb ? -1 : 1;
  return 0;
});

writeFileSync(oursPath, `${JSON.stringify({ orphans }, null, 2)}\n`);
process.exit(0);
