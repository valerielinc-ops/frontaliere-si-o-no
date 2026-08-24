import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The daily popularity snapshot went incremental because `job_views` grew from
 * ~2.9k documents to 66.107 (measured against production on 2026-08-24) while
 * the script kept reading all of them — 66k reads a day to move a handful of
 * counters.
 *
 * The incremental path rests on one thing the script cannot enforce alone: the
 * metadata file has to survive the run, i.e. the workflow has to commit it.
 * If it does not, `readPreviousSnapshot()` returns null forever and every run
 * silently falls back to the full scan — green, correct, and back to the old
 * bill. That pair is what this file guards.
 */
const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('job popularity snapshot stays incremental', () => {
  const script = read('scripts/fetch-job-popularity.mjs');
  const workflow = read('.github/workflows/refresh-job-popularity.yml');

  it('narrows the read to documents touched since the last scan', () => {
    expect(script).toContain("where('lastViewed', '>=', previous.since)");
  });

  it('projects the read down to the field it uses', () => {
    // Firestore bills the read either way; the projection is what the egress
    // line responds to.
    expect(script).toContain(".select('views')");
  });

  it('keeps a full-scan floor, which is what bounds a deleted document', () => {
    expect(script).toContain('FULL_SCAN_MAX_AGE_MS');
    expect(script).toContain("process.argv.includes('--full')");
  });

  it('commits the metadata the incremental path reads back', () => {
    // Both the normal commit and the rebase-retry regeneration: the retry path
    // re-runs the fetch, so a stale `git add` there loses the metadata exactly
    // when two data workflows race — the rarest and least visible case.
    const addLines = workflow
      .split('\n')
      .filter((l) => l.includes('git add data/job-popularity.json'));
    expect(addLines.length).toBeGreaterThanOrEqual(2);
    for (const line of addLines) {
      expect(line).toContain('data/job-popularity.meta.json');
    }
  });
});
