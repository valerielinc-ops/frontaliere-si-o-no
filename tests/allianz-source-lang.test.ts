import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Regression: the dedicated locale validator must use a job's REAL source
 * language, not a hard-coded locale, on any crawler that stamps a per-job
 * source language at crawl time.
 *
 * Allianz Suisse (DE/FR/IT) was configured `detectSourceLang: () => 'it'` while
 * detecting the source per job — so a German-source job, whose `de` field
 * legitimately equals its German source text, was flagged
 * `untranslated_description [de]` and HARD-FAILED the crawler on a false
 * positive (#1878 / #2003). The same latent mismatch existed across a class of
 * crawlers.
 */
const SCRIPTS_DIR = path.resolve(process.cwd(), 'scripts');

function read(name: string): string {
  return fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf-8');
}

describe('Allianz crawler — locale validator uses per-job source language', () => {
  const source = read('update-allianz-jobs.mjs');

  it('does not hard-code the validator source language to a single locale', () => {
    expect(source).not.toMatch(/detectSourceLang:\s*\(\)\s*=>\s*['"][a-z]{2}['"]/);
  });

  it('derives the validator source language per job', () => {
    expect(source).toMatch(/detectSourceLang:\s*\(text,\s*job\)\s*=>\s*job\?\.sourceLang/);
  });
});

describe('locale validator source-language consistency (whole class)', () => {
  // A crawler that assigns a VARIABLE per-job sourceLang (via detectLang) must
  // NOT validate with a fixed `detectSourceLang: () => 'xx'` — that mismatch is
  // the #2003 false-positive bug. Crawlers with a genuinely CONSTANT source
  // (e.g. `sourceLang: 'de'`) may keep the constant.
  const files = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => /^update-.*-jobs\.mjs$/.test(f));

  for (const file of files) {
    const src = read(file);
    const hasHardcodedValidator = /detectSourceLang:\s*\(\)\s*=>\s*['"][a-z]{2}['"]/.test(src);
    if (!hasHardcodedValidator) continue;

    // Does it compute a per-job sourceLang from detectLang (variable source)?
    const computesPerJobSource =
      /sourceLang\s*[:=]\s*[^'"\n]*detectLang\(/.test(src) ||
      /\bsourceLang:\s*(?:lang|row\.lang|row\.language)\b/.test(src);

    it(`${file}: no hard-coded validator source when source is per-job`, () => {
      expect(
        computesPerJobSource,
        `${file} hard-codes detectSourceLang: () => '..' but stamps a per-job sourceLang — ` +
          `use \`(text, job) => job?.sourceLang || detectLang(text, '..')\` (the #2003 false-positive class).`,
      ).toBe(false);
    });
  }
});
