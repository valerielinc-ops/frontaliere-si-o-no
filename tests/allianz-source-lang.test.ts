import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Regression: Allianz Suisse posts in DE/FR/IT. The locale validator was
 * configured with `detectSourceLang: () => 'it'`, so a German-source job —
 * whose `de` field legitimately equals its German source text — was flagged
 * `untranslated_description [de]` and HARD-FAILED the crawler on a false
 * positive (#1878 / #2003). The validator must instead use the per-job source
 * language that the crawler already stamps at crawl time.
 */
describe('Allianz crawler — locale validator uses per-job source language', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/update-allianz-jobs.mjs'),
    'utf-8',
  );

  it('does not hard-code the validator source language to a single locale', () => {
    expect(source).not.toMatch(/detectSourceLang:\s*\(\)\s*=>\s*['"]it['"]/);
  });

  it('derives the validator source language per job', () => {
    expect(source).toMatch(/detectSourceLang:\s*\(text,\s*job\)\s*=>\s*job\?\.sourceLang/);
  });

  it('still stamps a per-row source language at crawl time', () => {
    expect(source).toMatch(/sourceLang:\s*detectLang\(/);
  });
});
