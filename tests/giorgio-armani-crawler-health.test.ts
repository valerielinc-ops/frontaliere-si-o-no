import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, 'scripts/update-giorgio-armani-jobs.mjs'),
  'utf8',
);

describe('Giorgio Armani crawler health receipt', () => {
  it('passes outcome counters to the exit guard', () => {
    expect(SOURCE).toContain(
      "registerCrawlerSummaryGuard(COMPANY_KEY, 'giorgio-armani', summaryCounts);",
    );
    expect(SOURCE).toContain("summaryCounts.abortKind = 'no-jobs-parsed';");
    expect(SOURCE).toContain("summaryCounts.abortKind = 'source-extraction-failed';");
  });

  it('publishes a filtered-empty heartbeat only after a real listing observation', () => {
    expect(SOURCE).toContain("summaryCounts.lastFetchOutcome = 'filtered_empty';");
    expect(SOURCE).toContain(
      'writeGiorgioArmaniSummary({ counts: summaryCounts });',
    );
  });
});
