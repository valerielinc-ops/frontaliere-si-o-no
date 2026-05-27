#!/usr/bin/env node
/**
 * In-place rebase resolver for `data/fb-posted-jobs.json`.
 *
 * The fb-jobs-daily-schedule workflow's "Commit posted-jobs tracking"
 * step appends the just-scheduled posts to the ledger and pushes. If
 * another commit landed on main between our read-and-schedule and our
 * push (e.g. an article workflow, a translate-pending sync, or even a
 * concurrent fb-jobs schedule), the rebase fails with a content
 * conflict on this file. Without a resolver the workflow exits 1 and
 * the ledger ends up out-of-sync with the FB Page's scheduled queue —
 * leading the next run to schedule duplicate posts for the same job IDs
 * (run 25373882596 was exactly this scenario).
 *
 * Resolution semantics: UNION the `posted` arrays by `id`, dedup on
 * collision keeping the locally-staged entry (freshest scheduledFor +
 * fbPostId — those are authoritative because they came from our Graph
 * API call). The schemaVersion is taken from local; if missing falls
 * back to upstream's, then 1.
 *
 * Same shape as `resolve-winners-conflict.mjs` — runs INSIDE the
 * rebase, leaves the file resolved + staged, then
 * `git rebase --continue` closes the cycle.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = 'data/fb-posted-jobs.json';
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
      `[resolve-fb-posted] ${label} version is not a valid ledger object; treating as empty\n`,
    );
    return { schemaVersion: 1, posted: [] };
  } catch (err) {
    process.stderr.write(
      `[resolve-fb-posted] ${label} JSON parse failed: ${err.message}\n`,
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
  process.stdout.write(`[resolve-fb-posted] no conflict on ${TARGET}\n`);
  process.exit(0);
}

if (conflicted.length > 1) {
  process.stderr.write(
    `[resolve-fb-posted] unexpected conflicted files: ${conflicted.filter((f) => f !== TARGET).join(', ')}\n`,
  );
  process.exit(1);
}

const upstream = parseOrEmpty('upstream', readStage(2));
const local = parseOrEmpty('local', readStage(3));

// Union by `id`. Local wins on collision (it carries the fresh fbPostId
// + scheduledFor that we just got from the Graph API).
const seen = new Set();
const merged = [];
let localOverlay = 0;

// Walk upstream first so its entries occupy the index, then overlay
// local (newer entries replace, novel local entries appended).
for (const entry of upstream.posted) {
  if (!entry || !entry.id || seen.has(entry.id)) continue;
  seen.add(entry.id);
  merged.push(entry);
}
for (const entry of local.posted) {
  if (!entry || !entry.id) continue;
  if (seen.has(entry.id)) {
    // Replace: find the existing index and overwrite with local's authoritative copy.
    const idx = merged.findIndex((e) => e.id === entry.id);
    if (idx >= 0) merged[idx] = entry;
    localOverlay += 1;
  } else {
    seen.add(entry.id);
    merged.push(entry);
  }
}

// Mirror the trim-on-write behaviour of appendPosted in
// scripts/schedule-fb-jobs-daily.mjs (POSTED_TRIM_LIMIT = 1000).
const trimmed = merged.slice(-TRIM_LIMIT);

const out = {
  schemaVersion: local.schemaVersion ?? upstream.schemaVersion ?? 1,
  posted: trimmed,
};

const outPath = path.resolve(process.cwd(), TARGET);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');

process.stdout.write(
  `[resolve-fb-posted] merged ${upstream.posted.length} upstream + ${local.posted.length} local → ${trimmed.length} entries (${localOverlay} local-overlays win)\n`,
);

execFileSync('git', ['add', TARGET]);
