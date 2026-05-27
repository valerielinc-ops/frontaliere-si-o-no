/**
 * Regression test for `cleanCrawlerArtifacts` mid-line separator scrub
 * (scripts/lib/crawler-template.mjs step 1b).
 *
 * audit:no-literal-markdown (0-tolerance, CLAUDE.md rule #1) failed on
 * HFR (Hôpital fribourgeois) job pages in runs #26264463075 and
 * #26268380310 because AI-translation flattening produced patterns like
 * `Ref.: HFR-M-251801 ____________ Le Département…` on a single line.
 * Step 2 only catches whole separator-only lines; step 3 only trailing
 * runs. This test pins down the mid-line case at the source so it can
 * never leak past assemble-jobs-dataset.mjs regardless of which renderer
 * downstream code uses.
 */
import { describe, expect, it } from 'vitest';
import { cleanCrawlerArtifacts } from '../../scripts/lib/crawler-template.mjs';

describe('cleanCrawlerArtifacts — mid-line separator runs', () => {
  it('strips 60+ underscore run from HFR description', () => {
    const input =
      `Ref.: HFR-M-251801 ${'_'.repeat(63)} Le Département de médecine ` +
      `interne et spécialités dispose d'un Service de référence.`;
    const out: string = cleanCrawlerArtifacts(input);
    expect(out).not.toMatch(/_{3,}/);
    expect(out).toContain('Ref.: HFR-M-251801');
    expect(out).toContain('Le Département');
  });

  it('strips 6+ equals / tilde runs', () => {
    expect(cleanCrawlerArtifacts('a ============= b')).not.toMatch(/={3,}/);
    expect(cleanCrawlerArtifacts('a ~~~~~~~~~~~~ b')).not.toMatch(/~{3,}/);
  });

  it('preserves short underscore tokens (snake_case, markdown bold tokens)', () => {
    expect(cleanCrawlerArtifacts('snake_case identifier')).toContain('snake_case');
    expect(cleanCrawlerArtifacts('a __b__ c')).toContain('__b__');
  });

  it('idempotent on already-clean text', () => {
    const clean = 'Le Département de médecine interne.\n\nProfile recherché.';
    expect(cleanCrawlerArtifacts(cleanCrawlerArtifacts(clean))).toBe(
      cleanCrawlerArtifacts(clean),
    );
  });
});
