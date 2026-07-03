/**
 * Regression: dedicated (non-template) crawler runners must rewrite the
 * GATED per-crawler slice (writeJobsCrawlerSlice, which runs the
 * quality/normalization gates) AFTER runDedicatedBaseCrawler, not rely on
 * the raw ungated seed staying committed (issue #3089 item 1).
 *
 * Background: `runDedicatedBaseCrawler` internally calls the raw
 * `seedCrawlerSlicesFromDataJobs` helper (thin, cycle-free, no quality gate)
 * to refresh each crawler's on-disk slice from the freshly-merged
 * `data/jobs.json` BEFORE the shared crawler subprocess runs — otherwise the
 * shared crawler would localize/rewrite a stale slice-only snapshot in CI
 * (see PR #3070). That raw seed is intentionally NOT gated (no boilerplate /
 * wrong-language checks) — the gate runs in `writeJobsCrawlerSlice`, which
 * every runner is expected to call again with the FINAL, localized jobs
 * after `runDedicatedBaseCrawler` returns.
 *
 * Dedicated runners built on `scripts/lib/crawler-template.mjs`'s
 * `runStandardCrawlerPipeline` get this ordering for free (checked once,
 * directly, below). Runners that call `runDedicatedBaseCrawler` directly
 * (SMN, Mikron, and ~70 other `scripts/update-*.mjs` dedicated crawlers) hand
 * -roll the same sequence — this test scans all of them and fails if any
 * script either never calls the gated `writeJobsCrawlerSlice` at all, or
 * calls it BEFORE `runDedicatedBaseCrawler` (which would ship the raw,
 * ungated seed instead of the gated final write).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// Matches an actual call site (open-paren right after the name), not the
// named-import line `import { runDedicatedBaseCrawler, ... } from '...'`
// (which is followed by a comma, not a paren).
const CALL_RE = (name: string) => new RegExp(`\\b${name}\\s*\\(`);

function findDirectDedicatedRunners(): string[] {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith('update-') && f.endsWith('-jobs.mjs'))
    .filter((f) => {
      const source = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf-8');
      // Only scripts that call runDedicatedBaseCrawler directly (not routed
      // through the template's runStandardCrawlerPipeline) are in scope —
      // the template's own ordering is verified separately below.
      return CALL_RE('runDedicatedBaseCrawler').test(source) && !CALL_RE('runStandardCrawlerPipeline').test(source);
    })
    .sort();
}

function firstCallLine(source: string, name: string): number {
  const lines = source.split('\n');
  const re = CALL_RE(name);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function lastCallLine(source: string, name: string): number {
  const lines = source.split('\n');
  const re = CALL_RE(name);
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) last = i;
  }
  return last;
}

describe('dedicated-runner gated-slice write order (#3089 item 1)', () => {
  const directRunners = findDirectDedicatedRunners();

  it('finds a non-trivial set of direct (non-template) dedicated runners to check (sanity: the discovery glob itself did not silently break)', () => {
    // Known members of this set as of the #3089 fix — if this count collapses
    // to near-zero, the discovery regex above broke, not that every crawler
    // suddenly moved to the template.
    expect(directRunners.length).toBeGreaterThan(30);
    expect(directRunners).toContain('update-mikron-jobs.mjs');
    expect(directRunners).toContain('update-swiss-medical-network-jobs.mjs');
  });

  for (const file of findDirectDedicatedRunners()) {
    it(`${file}: writeJobsCrawlerSlice (gated) is called, and after runDedicatedBaseCrawler`, () => {
      const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf-8');

      const runLine = firstCallLine(source, 'runDedicatedBaseCrawler');
      expect(runLine, `${file}: expected a runDedicatedBaseCrawler(...) call site`).toBeGreaterThanOrEqual(0);

      const writeLine = lastCallLine(source, 'writeJobsCrawlerSlice');
      expect(
        writeLine,
        `${file}: expected a writeJobsCrawlerSlice(...) call — without it, the raw ` +
          `ungated seed from runDedicatedBaseCrawler stays committed as this crawler's ` +
          `final slice (#3089 item 1 regression: boilerplate/wrong-lang jobs stay indexed).`,
      ).toBeGreaterThanOrEqual(0);

      expect(
        writeLine,
        `${file}: writeJobsCrawlerSlice must be called AFTER runDedicatedBaseCrawler ` +
          `(line ${runLine + 1}) so the gated write reflects the final, localized jobs — ` +
          `found it at line ${writeLine + 1}, before the base crawler ran.`,
      ).toBeGreaterThan(runLine);
    });
  }

  it('crawler-template.mjs (runStandardCrawlerPipeline): writeJobsCrawlerSlice is called after runDedicatedBaseCrawler', () => {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, 'lib', 'crawler-template.mjs'), 'utf-8');
    const runLine = firstCallLine(source, 'runDedicatedBaseCrawler');
    const writeLine = lastCallLine(source, 'writeJobsCrawlerSlice');
    expect(runLine).toBeGreaterThanOrEqual(0);
    expect(writeLine).toBeGreaterThanOrEqual(0);
    expect(writeLine).toBeGreaterThan(runLine);
  });
});
