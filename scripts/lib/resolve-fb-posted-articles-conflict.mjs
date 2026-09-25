#!/usr/bin/env node
/**
 * In-place rebase resolver for `data/fb-posted-articles.json`.
 *
 * The fb-articles-daily-schedule workflow's "Commit posted-articles tracking"
 * step appends the just-posted articles to the ledger and pushes. If another
 * commit landed on main between our read-and-post and our push (e.g. a
 * concurrent data-refresh workflow, or a queued second run of this workflow),
 * the rebase fails with a content conflict on this file. Without a resolver
 * the workflow exits 1, the ledger commit is LOST, and the next run — seeing
 * those article IDs missing from the ledger — would POST THEM AGAIN (double
 * posts). This resolver keeps the commit by merging both sides.
 *
 * Resolution semantics: UNION the `posted` arrays by `id`, dedup on collision
 * keeping the locally-staged entry (freshest ts + fbPostId — those are
 * authoritative because they came from our Graph API call). The schemaVersion
 * is taken from local; if missing falls back to upstream's, then 1.
 *
 * Same shape as the per-channel `resolve-fb-posted-jobs-conflict.mjs` /
 * `resolve-reddit-posted-jobs-conflict.mjs` — runs INSIDE the rebase, leaves
 * the file resolved + staged, then `git rebase --continue` closes the cycle.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitShowStage } from './git-show-stage.mjs';

const TARGET = 'data/fb-posted-articles.json';
const TRIM_LIMIT = 1000;

function readStage(stage) {
  // During `git rebase` (NOT plain merge):
  //   stage 2 = "ours"  = upstream (origin/main after the other commit)
  //   stage 3 = "theirs" = our local commit being replayed
  return gitShowStage(stage, TARGET);
}

function parseOrEmpty(label, raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.posted)) {
      return parsed;
    }
    process.stderr.write(
      `[resolve-fb-posted-articles] ${label} version is not a valid ledger object; treating as empty\n`,
    );
    return { schemaVersion: 1, posted: [] };
  } catch (err) {
    process.stderr.write(
      `[resolve-fb-posted-articles] ${label} JSON parse failed: ${err.message}\n`,
    );
    return { schemaVersion: 1, posted: [] };
  }
}

const conflicted = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
  encoding: 'utf-8',
})
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

if (!conflicted.includes(TARGET)) {
  process.stdout.write(`[resolve-fb-posted-articles] no conflict on ${TARGET}\n`);
  process.exit(0);
}

if (conflicted.length > 1) {
  process.stderr.write(
    `[resolve-fb-posted-articles] unexpected conflicted files: ${conflicted.filter((f) => f !== TARGET).join(', ')}\n`,
  );
  process.exit(1);
}

const upstream = parseOrEmpty('upstream', readStage(2));
const local = parseOrEmpty('local', readStage(3));

// Union by `id`. Local wins on collision (it carries the fresh fbPostId + ts
// that we just got from the Graph API).
const seen = new Set();
const merged = [];
let localOverlay = 0;

for (const entry of upstream.posted) {
  if (!entry || !entry.id || seen.has(entry.id)) continue;
  seen.add(entry.id);
  merged.push(entry);
}
for (const entry of local.posted) {
  if (!entry || !entry.id) continue;
  if (seen.has(entry.id)) {
    const idx = merged.findIndex((e) => e.id === entry.id);
    if (idx >= 0) merged[idx] = entry;
    localOverlay += 1;
  } else {
    seen.add(entry.id);
    merged.push(entry);
  }
}

// Mirror the trim-on-write behaviour of appendPosted in
// scripts/schedule-fb-articles-daily.mjs (POSTED_TRIM_LIMIT = 1000).
const trimmed = merged.slice(-TRIM_LIMIT);

const out = {
  schemaVersion: local.schemaVersion ?? upstream.schemaVersion ?? 1,
  posted: trimmed,
};

const outPath = path.resolve(process.cwd(), TARGET);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');

process.stdout.write(
  `[resolve-fb-posted-articles] merged ${upstream.posted.length} upstream + ${local.posted.length} local → ${trimmed.length} entries (${localOverlay} local-overlays win)\n`,
);

execFileSync('git', ['add', TARGET]);
