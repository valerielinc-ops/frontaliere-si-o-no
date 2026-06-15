#!/usr/bin/env node
/**
 * In-place rebase resolver for `data/reddit-posted-jobs.json`.
 *
 * The reddit-jobs-daily-schedule workflow's "Commit posted-jobs tracking"
 * step appends the just-posted jobs to the ledger and pushes. If another
 * commit landed on main between our read-and-post and our push (e.g. an
 * article workflow, a translate-pending sync, or even a concurrent
 * reddit-jobs run), the rebase fails with a content conflict on this
 * file. Without a resolver the workflow exits 1 and the ledger ends up
 * out-of-sync with what we actually posted to Reddit — leading the next
 * run to post duplicate jobs for the same IDs.
 *
 * Resolution semantics: UNION the `posted` arrays by a STABLE composite
 * key of `id + subreddit` (so the same job posted to two different subs
 * BOTH survive), dedup on collision keeping the locally-staged entry
 * (freshest ts + redditPostId — those are authoritative because they came
 * from our Reddit API call). The schemaVersion is taken from local; if
 * missing falls back to upstream's, then 1.
 *
 * Same shape as `resolve-fb-posted-jobs-conflict.mjs` — runs INSIDE the
 * rebase, leaves the file resolved + staged, then
 * `git rebase --continue` closes the cycle.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = 'data/reddit-posted-jobs.json';
const TRIM_LIMIT = 1000;

function readStage(stage) {
  // During `git rebase` (NOT plain merge):
  //   stage 2 = "ours"  = upstream (origin/main after the other commit)
  //   stage 3 = "theirs" = our local commit being replayed
  const out = execFileSync('git', ['show', `:${stage}:${TARGET}`], { encoding: 'utf-8' });
  return out;
}

function parseOrEmpty(label, raw) {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.posted)
    ) {
      return parsed;
    }
    process.stderr.write(
      `[resolve-reddit-posted] ${label} version is not a valid ledger object; treating as empty\n`,
    );
    return { schemaVersion: 1, posted: [] };
  } catch (err) {
    process.stderr.write(
      `[resolve-reddit-posted] ${label} JSON parse failed: ${err.message}\n`,
    );
    return { schemaVersion: 1, posted: [] };
  }
}

// Stable composite key: a job posted to two subreddits is two distinct
// ledger rows, so both must survive the union.
function entryKey(entry) {
  return `${entry.id} ${entry.subreddit ?? ''}`;
}

const conflicted = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
  encoding: 'utf-8',
})
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

if (!conflicted.includes(TARGET)) {
  process.stdout.write(`[resolve-reddit-posted] no conflict on ${TARGET}\n`);
  process.exit(0);
}

if (conflicted.length > 1) {
  process.stderr.write(
    `[resolve-reddit-posted] unexpected conflicted files: ${conflicted.filter((f) => f !== TARGET).join(', ')}\n`,
  );
  process.exit(1);
}

const upstream = parseOrEmpty('upstream', readStage(2));
const local = parseOrEmpty('local', readStage(3));

// Union by composite (id + subreddit). Local wins on collision (it carries
// the fresh redditPostId + ts that we just got from the Reddit API).
const seen = new Set();
const merged = [];
let localOverlay = 0;

// Walk upstream first so its entries occupy the index, then overlay
// local (newer entries replace, novel local entries appended).
for (const entry of upstream.posted) {
  if (!entry || !entry.id) continue;
  const key = entryKey(entry);
  if (seen.has(key)) continue;
  seen.add(key);
  merged.push(entry);
}
for (const entry of local.posted) {
  if (!entry || !entry.id) continue;
  const key = entryKey(entry);
  if (seen.has(key)) {
    // Replace: find the existing index and overwrite with local's authoritative copy.
    const idx = merged.findIndex((e) => entryKey(e) === key);
    if (idx >= 0) merged[idx] = entry;
    localOverlay += 1;
  } else {
    seen.add(key);
    merged.push(entry);
  }
}

// Mirror the trim-on-write behaviour of appendLedger in
// scripts/schedule-reddit-jobs-daily.mjs (POSTED_TRIM_LIMIT = 1000).
const trimmed = merged.slice(-TRIM_LIMIT);

const out = {
  schemaVersion: local.schemaVersion ?? upstream.schemaVersion ?? 1,
  posted: trimmed,
};

const outPath = path.resolve(process.cwd(), TARGET);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');

process.stdout.write(
  `[resolve-reddit-posted] merged ${upstream.posted.length} upstream + ${local.posted.length} local → ${trimmed.length} entries (${localOverlay} local-overlays win)\n`,
);

execFileSync('git', ['add', TARGET]);
