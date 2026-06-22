import { describe, it, expect } from 'vitest';
import { buildSectorHubPath } from '../../build-plugins/jobSectorLanding';

// The "see all N offers" CTA on a profession landing (e.g. /lavoro-ticino-autista/)
// must deep-link to the profession's job-board sector hub
// (e.g. /cerca-lavoro-ticino/autisti/) — a crawlable, indexed PATH that lands
// the visitor on a search already filtered to the profession — NOT the generic
// job-board root and NOT a robots-disallowed `?q=` query URL.

const FIXTURE_JOB = {
  id: 'job-1',
  title: 'Autista C/CE',
  titleByLocale: { it: 'Autista C/CE' },
  company: 'Trasporti Ticino',
  companyKey: 'trasporti-ticino',
  companyDomain: 'trasporti.ch',
  city: 'Lugano',
  addressLocality: 'Lugano',
  canton: 'TI',
  contract: 'full-time',
  salaryMin: 60000,
  salaryMax: 75000,
  postedDate: new Date(Date.now() - 86400000 * 2).toISOString(),
  daysAgo: 2,
  slug: 'autista-cce-trasporti-ticino-lugano',
  slugByLocale: {},
  employmentType: 'full-time',
  url: 'https://example.com/job-1',
  isCantonalFallback: false,
};

const SNAPSHOT_BASE = {
  liveCount: 3,
  fresh30Count: 3,
  medianSalaryChf: 65000,
  topEmployers: [],
};

// profession id → sector hub key it must link to (kept in sync with
// PROFESSION_SECTOR_HUB in professionLandingsPlugin.ts).
const EXPECTED: Array<[string, string]> = [
  ['infermiere', 'infermieri'],
  ['operaio', 'industria'],
  ['impiegato', 'commercio'],
  ['ingegnere', 'ingegneri'],
  ['educatore', 'educatori'],
  ['autista', 'autisti'],
  ['muratore', 'edilizia'],
  ['cuoco', 'cuochi'],
  ['cameriere', 'camerieri'],
  ['elettricista', 'elettricisti'],
];

const ctaHrefOf = (html: string): string | null => {
  // The CTA is the last anchor in the featured-jobs section.
  const matches = [...html.matchAll(/<a href="([^"]+)"[^>]*>[^<]*offer/gi)];
  if (matches.length > 0) return matches[matches.length - 1][1];
  // Fallback: any anchor carrying the link-accent CTA styling.
  const styled = [...html.matchAll(/<a href="([^"]+)"[^>]*font-weight:700/gi)];
  return styled.length > 0 ? styled[styled.length - 1][1] : null;
};

describe('profession landing "see all offers" CTA links to the sector hub', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    for (const [profession, sector] of EXPECTED) {
      it(`${profession} (${locale}) → ${sector} hub`, async () => {
        const mod: any = await import('../../build-plugins/professionLandingsPlugin');
        const html = mod.renderProfessionFeaturedJobsForTest(profession, locale, {
          ...SNAPSHOT_BASE,
          featured: [FIXTURE_JOB],
        });
        const href = ctaHrefOf(html);
        expect(href, `no CTA anchor rendered for ${profession}/${locale}`).toBeTruthy();
        const expectedPath = buildSectorHubPath(locale, sector as any);
        expect(href).toBe(expectedPath);
        // Never the bare job-board root, never a robots-disallowed ?q= link.
        expect(href).not.toMatch(/\?q=/);
        expect(href!.replace(/\/+$/, '')).not.toMatch(
          /\/(cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)$/,
        );
      });
    }
  }
});
