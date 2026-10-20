import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const JOBS_SEO_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../build-plugins/jobsSeoPagesPlugin.ts'),
  'utf8',
);

describe('historical archive fallback hreflang', () => {
  it('forwards a complete tracked locale cluster into indexable archive pages', () => {
    const rendererStart = JOBS_SEO_SOURCE.indexOf('const buildHistoricalArchiveHtml = (');
    const rendererEnd = JOBS_SEO_SOURCE.indexOf(
      'for (const [slug, paths] of Object.entries(tracking)',
      rendererStart,
    );
    expect(rendererStart).toBeGreaterThan(-1);
    expect(rendererEnd).toBeGreaterThan(rendererStart);

    const renderer = JOBS_SEO_SOURCE.slice(rendererStart, rendererEnd);
    expect(renderer).toContain('hreflangLinks = \'\'');
    expect(renderer).toContain('historicalUrl,');
    expect(renderer).toContain('hreflangLinks,');
  });

  it('builds historical fallbacks from the same four tracked paths as the cluster', () => {
    const selfHealingStart = JOBS_SEO_SOURCE.indexOf(
      '/* ── Self-healing: cover any tracking paths',
    );
    const selfHealingEnd = JOBS_SEO_SOURCE.indexOf(
      '/* ── Flush all buffered writes',
      selfHealingStart,
    );
    expect(selfHealingStart).toBeGreaterThan(-1);
    expect(selfHealingEnd).toBeGreaterThan(selfHealingStart);

    const selfHealing = JOBS_SEO_SOURCE.slice(selfHealingStart, selfHealingEnd);
    expect(selfHealing).toContain('buildTrackedHreflangLinks(slug, paths)');
    expect(selfHealing).toContain(
      'buildHistoricalArchiveHtml(slug, relPath, locale, archive, hreflangLinks)',
    );
  });
});
