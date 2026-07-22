/**
 * Guard for the health-facilities section matcher
 * (scripts/lib/healthFacilitiesSections.mjs) and the audit feature
 * classifiers that consume it (scripts/audit-title-length.mjs,
 * scripts/audit-text-html-ratio.mjs, scripts/audit-page-weight.mjs,
 * scripts/audit-dist-multi.mjs).
 *
 * Regression context (2026-07-22 post-deploy validate-dist failure): the
 * health-facilities hub (epic #4455/#4457, build-plugins/healthFacilitiesPlugin.ts)
 * shipped with no entry in classifyFeature. Its pages are markup-heavy by
 * design (facility JSON-LD + job cards, same shape as `eventi`) but carry
 * substantive real prose (verified live: 400+ words in `<main>`), so a low
 * text/HTML ratio isn't a content-quality regression. Without a dedicated
 * bucket, every facility page fell through to the generic `spa-locale` /
 * `spa-other` catch-all, whose baseline expects near-zero offenders,
 * tripping the text-html-ratio rate-ratchet gate on a normal crawl with no
 * real regression — same fix shape as the events TI-only leak (#3232) and
 * the job-board TI-only leak (2026-06-11).
 */
import { describe, it, expect } from 'vitest';
import { classifyFeature as classifyFeatureTitle } from '../../scripts/audit-title-length.mjs';
import { classifyFeature as classifyFeatureRatio } from '../../scripts/audit-text-html-ratio.mjs';
import { isHealthFacilitiesSectionPath, HEALTH_FACILITIES_SECTION_RX } from '../../scripts/lib/healthFacilitiesSections.mjs';

// classifyFeature takes a dist-relative path (with `dist/` prefix + index.html).
const rel = (p: string) => `dist${p}index.html`;

describe('health-facilities section matcher', () => {
  const facilityPaths = [
    '/strutture-sanitarie/clinique-la-source/',
    '/strutture-sanitarie/psgn/',
    '/en/healthcare-facilities/clinique-la-source/',
    '/en/healthcare-facilities/spital-emmental/',
    '/de/gesundheitseinrichtungen/psgn/',
    '/de/gesundheitseinrichtungen/merian-iselin/',
    '/fr/etablissements-sante/clinique-la-source/',
    '/fr/etablissements-sante/institution-lavigny/',
  ];

  it.each(facilityPaths)('classifies %s as health-facilities', (p) => {
    expect(isHealthFacilitiesSectionPath(p)).toBe(true);
    expect(classifyFeatureTitle(rel(p))).toBe('health-facilities');
    expect(classifyFeatureRatio(rel(p))).toBe('health-facilities');
  });

  const nonFacilityPaths = [
    // Locale landing / guides must NOT be swallowed by the matcher
    '/en/guide-cross-border-taxation-2026/',
    '/de/steuern-und-rente/quellensteuersaetze-tessin-2026/',
    '/blog/qualche-articolo/',
    // Job-board and events must stay distinct
    '/cerca-lavoro-ticino/',
    '/en/find-jobs-geneva/',
    '/eventi/ticino/',
    // Mid-word false-match guard
    '/blog/best-healthcare-facilities-tips/',
  ];

  it.each(nonFacilityPaths)('does NOT classify %s as health-facilities', (p) => {
    expect(isHealthFacilitiesSectionPath(p)).toBe(false);
    expect(classifyFeatureTitle(rel(p))).not.toBe('health-facilities');
    expect(classifyFeatureRatio(rel(p))).not.toBe('health-facilities');
  });

  it('regex is anchored on a path boundary (no mid-segment false match)', () => {
    expect(HEALTH_FACILITIES_SECTION_RX.test('/blog/best-healthcare-facilities-tips/')).toBe(false);
  });
});
