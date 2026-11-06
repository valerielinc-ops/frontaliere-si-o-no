/**
 * Regression: job-detail pages (the highest-traffic template) previously
 * gated ADSENSE_SNIPPET behind `hasSpaBundle ? '' : ...` alongside
 * GTAG_SNIPPET. Since job SEO pages have no raw `<ins>` slots and
 * AdSenseBanner only renders post-hydration, that gate meant: if SPA
 * hydration never completes (version-skew, a blocked/failed bundle, any
 * mount-time JS error), there was ZERO ad-serving mechanism on the page —
 * no meta verification, no Auto Ads, nothing. ADSENSE_SNIPPET must always
 * be present so the hydration-independent static loader can still serve
 * ads even when the SPA never mounts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

describe('jobsSeoPagesPlugin — ADSENSE_SNIPPET hydration-independent fallback', () => {
  it('never gates ADSENSE_SNIPPET behind hasSpaBundle', () => {
    const src = fs.readFileSync(path.join(ROOT, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
    const declLine = src.split('\n').find((l) => l.includes('const staticAnalyticsHtml ='));
    expect(declLine, 'staticAnalyticsHtml declaration not found in jobsSeoPagesPlugin.ts').toBeTruthy();
    expect(declLine).not.toMatch(/hasSpaBundle\s*\?\s*''\s*:\s*`[^`]*ADSENSE_SNIPPET/);
    expect(declLine).toContain('ADSENSE_SNIPPET');
  });
});
