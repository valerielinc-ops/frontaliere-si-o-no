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

  // The validator is invoked `detectSourceLang(text, job)`
  // (dedicated-crawler-common.mjs). Two buggy shapes ignore the per-job source:
  //   1. `() => 'xx'`            — 0-arg constant (ignores both params).
  //   2. `(x) => x.sourceLang…`  — 1-arg: the single param is the TEXT string,
  //      so `.sourceLang` is always undefined → silently falls back. (#2003)
  // The correct shapes are `(text, job) => job?.sourceLang || detectLang(...)`
  // or `(text) => detectLang(text, 'xx')` (re-detect from the job's own text).
  for (const file of files) {
    const src = read(file);
    const m = src.match(/detectSourceLang:\s*([^\n]+)/);
    if (!m) continue;
    const def = m[1];

    const isZeroArgConstant = /^\(\)\s*=>\s*['"][a-z]{2}['"]/.test(def);
    // 1-arg arrow that reaches into `.sourceLang` on its single (text) param.
    const isSingleArgSourceLang = /^\(\s*\w+\s*\)\s*=>\s*\w+\.sourceLang\b/.test(def);

    const computesPerJobSource =
      /sourceLang\s*[:=]\s*[^'"\n]*detectLang\(/.test(src) ||
      /\bsourceLang:\s*(?:lang|row\.lang|row\.language)\b/.test(src);

    // A single-arg `.sourceLang` shape is ALWAYS broken; a 0-arg constant is
    // only broken when the crawler actually varies the source per job.
    const isBuggy = isSingleArgSourceLang || (isZeroArgConstant && computesPerJobSource);

    it(`${file}: validator derives source from the per-job \`job\` param`, () => {
      expect(
        isBuggy,
        `${file} uses \`detectSourceLang: ${def.slice(0, 60)}…\` which ignores the per-job ` +
          `sourceLang — use \`(text, job) => job?.sourceLang || detectLang(text, '..')\` (#2003 class).`,
      ).toBe(false);
    });
  }
});
