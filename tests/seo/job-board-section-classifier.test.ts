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
import {
  isJobBoardContentPath,
  isJobBoardSectionPath,
  isJobBoardSectionPathname,
  JOB_BOARD_PROFESSION_CITY_RX,
  JOB_BOARD_SECTION_RX,
} from '../../scripts/lib/jobBoardSections.mjs';

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

  const professionCityPaths = [
    '/lavoro-lugano-saldatore/',
    '/en/jobs-lugano-welder/',
    '/de/arbeit-zurich-pflegefachperson/index.html',
    '/fr/travail-lausanne-infirmier/',
  ];

  it.each(professionCityPaths)('treats %s as a job-payload path for content audits', (p) => {
    expect(isJobBoardContentPath(p)).toBe(true);
    expect(JOB_BOARD_PROFESSION_CITY_RX.test(p)).toBe(true);
  });

  it('does not broaden the profession-city matcher to unknown or nested editorial paths', () => {
    expect(isJobBoardContentPath('/en/jobs-lugano/')).toBe(false);
    expect(isJobBoardContentPath('/en/jobs-lugano-welder/methodology/')).toBe(false);
    expect(isJobBoardContentPath('/en/jobs-geneva-welder/')).toBe(false);
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

  it('TI company-landing hubs still win over job-board', () => {
    // Was asserted as 'weekly-employers' — that label was itself the
    // audit-title-length/career-landings classifier-drift bug (see
    // tests/seo/employer-landing-section-classifier.test.ts); the page this
    // matches is the evergreen per-company career-landing hub, correctly
    // 'career-landings' (matching audit-text-html-ratio's classifier). What
    // this test actually guards — precedence over job-board — is unchanged.
    expect(classifyFeature(rel('/cerca-lavoro-ticino/azienda-eoc/'))).toBe('career-landings');
  });

  // The funnel validators (validate-content-quality / validate-sitemap-pages
  // isJobPage) call `JOB_BOARD_SECTION_RX.test('/' + path)` where `path` is a
  // dist-relative file path with the `index.html` leaf — cover that exact form.
  it.each([
    'cerca-lavoro-ticino/some-job/index.html',
    'cerca-lavoro-argovia/wettingen/index.html',
    'en/find-jobs-geneva/head-of-clinic-100-hug/index.html',
    'de/jobs-in-aargau/index.html',
  ])('validator form: "/" + %s matches the job-board section', (p) => {
    expect(isJobBoardSectionPath('/' + p)).toBe(true);
  });
});

// Runtime form: `window.location.pathname`, used by JobBoard's rewarded
// "Candidati" surface and by the click-only Offerwall gate (owner decision
// 2026-09-26: every job-board section, all cantons, the aggregator, it/en/de/fr).
describe('job-board section pathname matcher (runtime)', () => {
  it.each([
    '/cerca-lavoro-ticino',
    '/cerca-lavoro-ticino/',
    '/cerca-lavoro-ticino/stagista-supsi/',
    '/cerca-lavoro-argovia/wettingen/',
    '/cerca-lavoro-san-gallo/',
    '/cerca-lavoro-svizzera/',
    '/en/find-jobs-ticino/',
    '/en/find-jobs-geneva/head-of-clinic-100-hug/',
    '/en/find-jobs-switzerland',
    '/de/jobs-im-tessin/',
    '/de/jobs-in-aargau/',
    '/de/jobs-in-der-waadt/stelle/',
    '/de/jobs-in-schweiz/',
    '/fr/trouver-emploi-tessin/',
    '/fr/trouver-emploi-suisse/emploi/',
  ])('%s is inside a job-board section', (pathname) => {
    expect(isJobBoardSectionPathname(pathname)).toBe(true);
  });

  it.each([
    '',
    '/',
    '/cerca-lavoro/',
    '/articoli-frontaliere/permesso-g/',
    '/lavoro/',
    '/lavoro/infermiere-lugano/',
    '/jobs-lugano-infermiere/',
    '/en/jobs-lugano-nurse/',
    '/de/arbeit-lugano-pflege/',
    '/blog/cerca-lavoro-ticino/',
    '/it/cerca-lavoro-ticino/',
    '/aziende/eoc/',
    '/cerca-lavoro-1/',
  ])('%s is not a job-board section page', (pathname) => {
    expect(isJobBoardSectionPathname(pathname)).toBe(false);
  });
});
