#!/usr/bin/env node
// merge-json-first-seen.mjs — custom git merge driver for monotonic
// "URL → first-seen ISO date" JSON maps: the shards data/url-first-seen/<h>.json
// (scripts/lib/url-first-seen-store.mjs) and, until it is retired, the legacy
// single file data/url-first-seen.json.
//
// WHY THIS EXISTS
// ---------------
// data/url-first-seen.json (now each shard) is a pretty-printed JSON object (one
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
// FAILURE POLICY: a side that is missing, empty, not JSON, or not an object makes
// the merge FAIL (exit 1, %A untouched). The previous load() swallowed the error
// and returned {}, so a corrupt side was merged as "no entries" and the result
// was written back as a resolved merge: a whole side of the history was lost
// with exit 0. A failed driver surfaces as a conflict, which is the honest outcome.
//
// Registered in .gitattributes as `merge=json-first-seen`; the driver itself
// is wired up with `git config merge.json-first-seen.driver` in the workflow
// step before the rebase (see deploy.yml). Invoked by git as:
//   node scripts/ci/merge-json-first-seen.mjs %O %A %B
// git reads the merged result back from %A (ours); exit 0 = resolved.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { earlierFirstSeen } from '../lib/url-first-seen-store.mjs';

/**
 * Parse one side of the merge. Empty text is `{}` (git hands the driver an
 * empty file for an absent ancestor); anything else that is not a JSON object
 * throws.
 *
 * @param {string} text
 * @param {string} label for the error message
 * @returns {Record<string, string>}
 */
export function parseFirstSeenSide(text, label) {
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`merge-json-first-seen: ${label} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`merge-json-first-seen: ${label} is not a JSON object`);
  }
  return parsed;
}

/**
 * Union of the sides keeping the EARLIEST first-seen date per URL.
 *
 * @param {Array<Record<string, string>>} sides
 * @returns {Record<string, string>} keys sorted
 */
export function mergeFirstSeenSides(sides) {
  /** @type {Map<string, string>} */
  const merged = new Map();
  for (const side of sides) {
    for (const [url, date] of Object.entries(side)) {
      const cur = merged.get(url);
      if (cur === undefined) merged.set(url, String(date));
      else merged.set(url, earlierFirstSeen(cur, String(date)));
    }
  }
  const sorted = {};
  for (const url of [...merged.keys()].sort()) sorted[url] = merged.get(url);
  return sorted;
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const [, , , oursPath, theirsPath] = process.argv;
  try {
    const sides = [oursPath, theirsPath].map((p) => parseFirstSeenSide(readFileSync(p, 'utf8'), p));
    writeFileSync(oursPath, JSON.stringify(mergeFirstSeenSides(sides), null, 2) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
