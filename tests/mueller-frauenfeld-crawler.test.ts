import { describe, expect, it } from 'vitest';
import { loadSpec, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';

describe('mueller-frauenfeld crawler spec', () => {
  it('requires a non-empty vacancy slug before the numeric detail id', () => {
    const spec = loadSpec('mueller-frauenfeld');
    const detailMatcher = templateToRegex(spec.detailTemplate);

    expect(spec.detailTemplate).toBe('/karriere/freie-stellen/*-#.html');
    expect(detailMatcher.test('/karriere/freie-stellen/gleisbauer-mwd-129.html')).toBe(true);
    expect(detailMatcher.test('/karriere/freie-stellen/baumaschinenmechaniker-efz-mw-40.html')).toBe(true);
    expect(detailMatcher.test('/karriere/freie-stellen/-41.html')).toBe(false);
    expect(detailMatcher.test('/karriere/freie-stellen/-6.html')).toBe(false);
  });
});
