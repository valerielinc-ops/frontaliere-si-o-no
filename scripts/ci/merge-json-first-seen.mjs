#!/usr/bin/env node
// merge-json-first-seen.mjs — custom git merge driver for monotonic
// "URL → first-seen ISO date" JSON maps (currently data/url-first-seen.json).
//
// WHY THIS EXISTS
// ---------------
// data/url-first-seen.json is a pretty-printed JSON object (one
// "url": "YYYY-MM-DD" per sorted line). Many producers on `main` (every
// deploy shard + post-merge auto-commits) append freshly-emitted URLs to it
// concurrently. A plain 3-way text merge (git's default) raises a content
// CONFLICT whenever two sides touch nearby lines — which wedged the
// dist-history push loop in deploy.yml (run 28142157430: 5 rebase attempts
// all aborted, url-first-seen.json never landed). `merge=union` is WRONG for a
// JSON object (it concatenates both sides' lines → duplicate keys / invalid
// JSON), so the JSONL union trick can't be reused here.
//
// This driver applies the file's real merge semantics instead: union the two
// maps and keep the EARLIEST first-seen date per URL (monotonic — never
// regress a first-seen). ISO dates sort lexically, so min = earliest. Output
// matches the generator (scripts/refresh-url-first-seen.mjs): keys sorted,
// 2-space pretty print, trailing newline. Ancestor (%O) is irrelevant for a
// union-min merge, so it is ignored.
//
// Registered in .gitattributes as `merge=json-first-seen`; the driver itself
// is wired up with `git config merge.json-first-seen.driver` in the workflow
// step before the rebase (see deploy.yml). Invoked by git as:
//   node scripts/ci/merge-json-first-seen.mjs %O %A %B
// git reads the merged result back from %A (ours); exit 0 = resolved.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , , oursPath, theirsPath] = process.argv;

function load(p) {
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8') || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

const merged = {};
for (const src of [load(oursPath), load(theirsPath)]) {
  for (const [url, date] of Object.entries(src)) {
    const cur = merged[url];
    // Keep the earliest first-seen (lexical min over ISO YYYY-MM-DD).
    if (cur === undefined || String(date) < String(cur)) merged[url] = date;
  }
}

const sorted = {};
for (const url of Object.keys(merged).sort()) sorted[url] = merged[url];
writeFileSync(oursPath, JSON.stringify(sorted, null, 2) + '\n');
process.exit(0);
