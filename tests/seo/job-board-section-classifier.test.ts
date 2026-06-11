/**
 * Guard for the canton-aware job-board section matcher
 * (scripts/lib/jobBoardSections.mjs) and the audit feature classifier that
 * consumes it (scripts/audit-title-length.mjs → also imported by
 * audit-h1-title-duplicates + audit-title-no-disambig-hash).
 *
 * Regression context (2026-06-11 post-deploy validate-dist failure):
 * the classifier matched ONLY the four TI legacy job-board slugs, so every
 * NON-TI canton job page (hub, city hub, AND each job-detail page) fell into
 * the volatile `spa-locale` / `spa-other` buckets. Long externally-sourced
 * job titles then drifted the spa-locale ratchet over its cap with no real
 * SEO change. These must classify as `job-board` (high organic-growth
 * headroom) and auto-cover every present and future canton.
 */
import { describe, it, expect } from 'vitest';
import { classifyFeature } from '../../scripts/audit-title-length.mjs';
import { isJobBoardSectionPath, JOB_BOARD_SECTION_RX } from '../../scripts/lib/jobBoardSections.mjs';

// classifyFeature takes a dist-relative path (with `dist/` prefix + index.html).
const rel = (p: string) => `dist${p}index.html`;

describe('job-board section matcher', () => {
  const jobBoardPaths = [
    // TI legacy (regression guard — must keep matching)
    '/cerca-lavoro-ticino/',
    '/en/find-jobs-ticino/',
    '/de/jobs-im-tessin/',
    '/fr/trouver-emploi-tessin/',
    // Non-TI cantons, every locale prefix
    '/cerca-lavoro-argovia/',
    '/cerca-lavoro-argovia/wettingen/',
    '/en/find-jobs-geneva/',
    '/de/jobs-in-aargau/',
    '/de/jobs-in-der-waadt/',
    '/fr/trouver-emploi-vaud/',
    // Multi-word canton slug (San Gallo) must not be truncated by the matcher
    '/cerca-lavoro-san-gallo/',
    '/cerca-lavoro-san-gallo/rapperswil/',
    // Switzerland aggregator
    '/cerca-lavoro-svizzera/',
    '/en/find-jobs-switzerland/',
    '/de/jobs-in-schweiz/',
    '/fr/trouver-emploi-suisse/',
    // Job-detail page under a non-TI canton section (the exact leak case)
    '/en/find-jobs-geneva/head-of-clinic-with-or-without-specialty-title-80-to-100-hug-puplinge/',
  ];

  it.each(jobBoardPaths)('classifies %s as job-board', (p) => {
    expect(isJobBoardSectionPath(p)).toBe(true);
    expect(classifyFeature(rel(p))).toBe('job-board');
  });

  const nonJobBoardPaths = [
    // Locale landing / guides must NOT be swallowed by the broadened matcher
    '/en/guide-cross-border-taxation-2026/',
    '/de/steuern-und-rente/quellensteuersaetze-tessin-2026/',
    '/fr/guide-frontalier/lamal-frontaliers/',
    '/glossario-frontaliere/',
    // Job-market snapshot uses a different prefix and must stay distinct
    '/de/arbeitsmarkt/',
    '/mercato-lavoro-ticino/',
  ];

  it.each(nonJobBoardPaths)('does NOT classify %s as job-board', (p) => {
    expect(isJobBoardSectionPath(p)).toBe(false);
    expect(classifyFeature(rel(p))).not.toBe('job-board');
  });

  it('regex is anchored on a path boundary (no mid-segment false match)', () => {
    // A path whose segment merely contains "find-jobs" mid-word must not match.
    expect(JOB_BOARD_SECTION_RX.test('/blog/how-to-find-jobs-in-switzerland/')).toBe(false);
  });

  it('TI weekly-employer company hubs still win over job-board', () => {
    expect(classifyFeature(rel('/cerca-lavoro-ticino/azienda-eoc/'))).toBe('weekly-employers');
  });
});
