/**
 * Guard for the canton-aware events section matcher
 * (scripts/lib/eventsSections.mjs) and the audit feature classifiers that
 * consume it (scripts/audit-title-length.mjs, scripts/audit-text-html-ratio.mjs,
 * scripts/audit-dist-multi.mjs).
 *
 * Regression context (issue #3232 — 2026-07-03 post-deploy validate-dist
 * failure, 28th recurrence): the classifier matched ONLY the TI/Tessin
 * events segment (`eventi/ticino`, `events/ticino`, `veranstaltungen/tessin`,
 * `evenements/tessin`), so every NON-TI canton events page fell into the
 * volatile `spa-locale` / `spa-other` buckets once nationwide event sourcing
 * shipped (#3125/#3243). Events pages are inherently markup-heavy (event
 * cards + Event JSON-LD + maps), so this drifted BOTH the title-length and
 * text-html-ratio ratchets over their small spa-locale/spa-other caps with
 * no real content-quality regression. These must classify as `eventi` (its
 * own ratchet bucket) and auto-cover every present and future canton — same
 * fix shape as the job-board TI-only leak (2026-06-11,
 * scripts/lib/jobBoardSections.mjs).
 */
import { describe, it, expect } from 'vitest';
import { classifyFeature as classifyFeatureTitle } from '../../scripts/audit-title-length.mjs';
import { isEventsSectionPath, EVENTS_SECTION_RX } from '../../scripts/lib/eventsSections.mjs';

// classifyFeature takes a dist-relative path (with `dist/` prefix + index.html).
const rel = (p: string) => `dist${p}index.html`;

describe('events section matcher', () => {
  const eventsPaths = [
    // TI legacy (regression guard — must keep matching)
    '/eventi/ticino/',
    '/en/events/ticino/',
    '/de/veranstaltungen/tessin/',
    '/fr/evenements/tessin/',
    // Non-TI cantons, every locale prefix (the exact #3232 leak case)
    '/eventi/zurigo/',
    '/en/events/zurich/',
    '/en/events/aargau/',
    '/de/veranstaltungen/aargau/',
    '/de/veranstaltungen/graubunden/',
    '/fr/evenements/argovie/',
    '/fr/evenements/zurich/',
    '/en/events/graubunden/',
    '/en/events/schwyz/',
    '/en/events/thurgau/',
    // Digest sub-pages (this-week / this-weekend) under a canton section
    '/eventi/ticino/questa-settimana/',
    '/en/events/aargau/this-week/',
    '/de/veranstaltungen/aargau/diese-woche/',
    '/eventi/argovia/questa-settimana/',
    // Per-comune leaf page
    '/de/veranstaltungen/zurich/chur/open-training-acroyoga/',
    '/en/events/graubunden/flims/flims-unesco-world-heritage-site/',
  ];

  it.each(eventsPaths)('classifies %s as eventi', (p) => {
    expect(isEventsSectionPath(p)).toBe(true);
    expect(classifyFeatureTitle(rel(p))).toBe('eventi');
  });

  const nonEventsPaths = [
    // Locale landing / guides must NOT be swallowed by the broadened matcher
    '/en/guide-cross-border-taxation-2026/',
    '/de/steuern-und-rente/quellensteuersaetze-tessin-2026/',
    '/blog/qualche-articolo/',
    '/glossario-frontaliere/',
    // Job-board must stay distinct
    '/cerca-lavoro-ticino/',
    '/en/find-jobs-geneva/',
  ];

  it.each(nonEventsPaths)('does NOT classify %s as eventi', (p) => {
    expect(isEventsSectionPath(p)).toBe(false);
    expect(classifyFeatureTitle(rel(p))).not.toBe('eventi');
  });

  it('regex is anchored on a path boundary (no mid-segment false match)', () => {
    // A path whose segment merely contains "events" mid-word must not match.
    expect(EVENTS_SECTION_RX.test('/blog/best-events-in-switzerland/')).toBe(false);
  });

  it('does not match a bare events root with no canton/comune segment', () => {
    expect(EVENTS_SECTION_RX.test('/eventi/')).toBe(false);
  });
});
