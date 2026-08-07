// The FAQ pages were 95 of the 100 sampled offenders of
// audit:h1-title-duplicates on the 2026-08-06 deploy — one producer, almost
// the whole failure.
//
// Why they all duplicated: the per-question page's <title> IS the question,
// and hubChrome's hero emits that same question as the page's only <h1>. The
// brand suffix is what normally tells <title> and <h1> apart, and
// buildTitleWithBrand DROPS it as soon as the headline passes 45 characters —
// which a question always does. Measured: every offender's title was ≥46
// chars, the exact boundary.
//
// The repair differentiates the H1, never the title: build-plugins/shared/
// titleSuffix.ts states that a long headline is fixed at source, not by
// cutting, so the title keeps its keywords and the H1 gains a locale-aware
// tag. These pin that the producer keeps doing it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { differentiateH1FromTitle } from '../build-plugins/shared/seoContentTokens';

const plugin = readFileSync(resolve('build-plugins/faqHubPlugin.ts'), 'utf8');

describe('faq hub — <h1> must not repeat <title>', () => {
  it('differentiates the H1 on BOTH pages the plugin emits', () => {
    // The hub landing and the per-question pages are separate hubChrome
    // heroes; fixing one and not the other leaves most of the corpus red.
    // Counted rather than matched by block: the comments explaining WHY sit
    // inside those blocks and any window-based regex would trip over them.
    const heroCount = (plugin.match(/\bhero:\s*\{/g) ?? []).length;
    const calls = (plugin.match(/differentiateH1FromTitle\(/g) ?? []).length;
    expect(heroCount).toBeGreaterThanOrEqual(2);
    expect(calls).toBeGreaterThanOrEqual(heroCount);
  });

  it('compares the per-question H1 against the title that page actually ships', () => {
    // The page's <title> is `question`, not `copy.title`. Comparing against
    // the wrong string type-checks, ships, and silently never fires — the
    // first version of this fix did exactly that.
    expect(plugin).toContain('differentiateH1FromTitle(question, question, locale)');
    expect(plugin).not.toContain('differentiateH1FromTitle(question, copy.title');
  });

  it('actually changes a real offender, and leaves its title alone', () => {
    const question = 'Quali contributi AVS/AI/IPG paga un frontaliere nel 2026?';
    const h1 = differentiateH1FromTitle(question, question, 'it');
    expect(h1).not.toBe(question);
    expect(h1.startsWith(question)).toBe(true); // the question is not truncated
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('tags in %s', (locale) => {
    const q = 'A question long enough that the brand suffix cannot fit at all';
    expect(differentiateH1FromTitle(q, q, locale)).not.toBe(q);
  });
});
