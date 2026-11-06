/**
 * Regression test for `cleanCrawlerArtifacts`'s odd-`**`-count guard
 * (scripts/lib/crawler-template.mjs step 1a, #4553).
 *
 * The runtime parser (build-plugins/shared/jobDescription/parser.ts) and
 * free-translate.mjs both guard against a truncated closing `**` marker
 * surviving their pair-matching bold-scrub regex. cleanCrawlerArtifacts
 * documents itself as mirroring parser.ts but was missing this same guard —
 * a stray `**` from AI-translation truncation could reach data/jobs.json
 * before any renderer runs.
 */
import { describe, expect, it } from 'vitest';
import { cleanCrawlerArtifacts } from '../../scripts/lib/crawler-template.mjs';

describe('cleanCrawlerArtifacts — odd ** count scrub', () => {
  it('strips an unbalanced ** left by a truncated closing marker', () => {
    const input = 'Salary is **CHF 90000 per year';
    const out: string = cleanCrawlerArtifacts(input);
    expect(out).not.toMatch(/\*\*/);
    expect(out).toContain('CHF 90000 per year');
  });

  it('still converts/removes balanced empty ** ** pairs alongside a stray **', () => {
    const input = 'Role: ** ** Salary is **CHF 90000';
    const out: string = cleanCrawlerArtifacts(input);
    expect(out).not.toMatch(/\*\*/);
  });

  it('leaves genuinely balanced ** markers untouched by this guard', () => {
    const input = 'This is **bold** text';
    const out: string = cleanCrawlerArtifacts(input);
    expect(out).toContain('**bold**');
  });
});
