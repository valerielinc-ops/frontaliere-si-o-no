/**
 * Regression for issue #7308: contextual article CTAs must interpolate the
 * canton placeholders instead of rendering `{canton}` literally.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../../components/community/BlogArticles.tsx'),
  'utf8',
);

const CTA_START = SOURCE.indexOf('{/* Contextual CTA widgets */}');
const CTA_END = SOURCE.indexOf('{/* Article feedback — utile / non utile */}', CTA_START);
const CONTEXTUAL_CTA = SOURCE.slice(CTA_START, CTA_END);

describe('BlogArticles — contextual CTA canton interpolation (#7308)', () => {
  it('passes canton interpolation params to contextual CTA title and description', () => {
    expect(CTA_START, 'contextual CTA block not found').toBeGreaterThan(-1);
    expect(CTA_END, 'article feedback boundary not found').toBeGreaterThan(CTA_START);
    expect(CONTEXTUAL_CTA).toContain('t(cta.titleKey, getCantonI18nParams())');
    expect(CONTEXTUAL_CTA).toContain('t(cta.descKey, getCantonI18nParams())');
  });
});
