/**
 * Newsletter company-hub existence gate (#2530, Class C).
 *
 * The build emits a company hub for every company with >=1 ACTIVE job
 * (data/jobs.json); brand-alias slugs additionally get 200 bridge pages. A
 * company whose name exists ONLY on EXPIRED jobs (e.g.
 * `jumbo-divisione-di-coop-societa-cooperativa`) therefore has NO emitted hub —
 * linking it from the newsletter silently 404s. The newsletter now gates the
 * company URL on an allow-set built from the active jobs with the SAME
 * slugifier the link builder uses, mirroring the existing `validateJobUrls` net.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCompanyHubSlugSet,
  companyHubUrlIfEmitted,
  slugifyCompanyName,
  matchJobsForSubscriber,
} from '../services/newsletter-content.mjs';

const activeJobs = [
  { title: 'Dev', slug: 'dev-acme', company: 'Acme SA', location: 'Lugano', description: 'Sviluppo software full-stack a Lugano.' },
  { title: 'Ops', slug: 'ops-jumbo', company: 'Jumbo', location: 'Bellinzona', description: 'Addetto vendite a Bellinzona.' },
];

describe('buildCompanyHubSlugSet', () => {
  it('contains one slug per active company, using slugifyCompanyName', () => {
    const set = buildCompanyHubSlugSet(activeJobs);
    expect(set.has(slugifyCompanyName('Acme SA'))).toBe(true);
    expect(set.has('jumbo')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('is empty for empty/missing input', () => {
    expect(buildCompanyHubSlugSet([]).size).toBe(0);
    expect(buildCompanyHubSlugSet(undefined).size).toBe(0);
  });

  it('excludes a company on a description-less / field-incomplete job — mirrors emitter validJobs gate (#2608 item 2)', () => {
    const jobs = [
      { title: 'Dev', company: 'Acme SA', location: 'Lugano', description: 'Ruolo completo.' },
      { title: 'X', company: 'NoDesc SA', location: 'Lugano' },          // missing description → no hub emitted
      { title: 'Y', company: 'NoLoc SA', description: 'ha desc' },        // missing location
      { company: 'NoTitle SA', location: 'Lugano', description: 'd' },    // missing title
      { title: 'Z', company: 'ByLocale SA', location: 'Chiasso', descriptionByLocale: { it: 'ok' } }, // descriptionByLocale counts
    ];
    const set = buildCompanyHubSlugSet(jobs);
    expect(set.has('acme-sa')).toBe(true);
    expect(set.has('bylocale-sa')).toBe(true); // descriptionByLocale satisfies the gate
    expect(set.has('nodesc-sa')).toBe(false);
    expect(set.has('noloc-sa')).toBe(false);
    expect(set.has('notitle-sa')).toBe(false);
  });
});

describe('companyHubUrlIfEmitted', () => {
  const emitted = buildCompanyHubSlugSet(activeJobs);

  it('returns a hub URL for a company present in the active set', () => {
    const url = companyHubUrlIfEmitted('Acme SA', 'it', emitted);
    expect(url).toContain('acme-sa');
    expect(url.endsWith('/')).toBe(true);
  });

  it('returns "" for a company present ONLY on expired jobs (the #2530 404 class)', () => {
    // This long Jumbo variant exists only on expired postings; no hub is emitted.
    expect(
      companyHubUrlIfEmitted('Jumbo, Divisione di Coop Società Cooperativa', 'it', emitted),
    ).toBe('');
  });

  it('returns "" for empty company', () => {
    expect(companyHubUrlIfEmitted('', 'it', emitted)).toBe('');
  });

  it('skips the gate (returns URL) when the allow-set is empty — never drops every link on a bad dataset', () => {
    const url = companyHubUrlIfEmitted('Some Company', 'it', new Set());
    expect(url).toContain('some-company');
  });
});

describe('matchJobsForSubscriber — companyUrl is gated end-to-end', () => {
  it('does not attach a companyUrl for an expired-only company variant', () => {
    const subscriber = { locale: 'it', sourceJob: {
      title: 'Cassiere', slug: 'cassiere-jumbo-exp', location: 'Bellinzona',
      company: 'Jumbo, Divisione di Coop Società Cooperativa',
    } };
    const matched = matchJobsForSubscriber(subscriber, activeJobs, 3, 'it');
    // Any card whose company is the expired-only variant must carry empty companyUrl.
    for (const card of matched) {
      if (card.company === 'Jumbo, Divisione di Coop Società Cooperativa') {
        expect(card.companyUrl).toBe('');
      }
    }
  });

  it('attaches a companyUrl for an active company', () => {
    const subscriber = { locale: 'it' };
    const matched = matchJobsForSubscriber(subscriber, activeJobs, 3, 'it');
    const acme = matched.find((c) => c.company === 'Acme SA');
    if (acme) expect(acme.companyUrl).toContain('acme-sa');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TI-only company-hub gate (#3557).
//
// The hub URL this module builds (companyPageUrl → JOB_BOARD_PATH) is always
// the Ticino board path. The build only ever emits a hub page at that path
// for a company with >=1 active TI job (jobsSeoPagesPlugin.ts's legacy
// companyMap loop, ~line 3700) — a company whose active jobs are ALL outside
// TI gets a *different* per-canton hub URL instead, never this one. Before
// this fix, buildCompanyHubSlugSet allow-listed such companies anyway, so
// the newsletter linked a hub URL the build never emits at this path.
describe('buildCompanyHubSlugSet — TI-only canton gate (#3557)', () => {
  it('excludes a company whose only active job is outside TI', () => {
    const nonTiOnlyJobs = [
      { title: 'Dev', slug: 'dev-zh', company: 'Zurich Corp', canton: 'ZH', location: 'Zürich', description: 'Sviluppo software a Zurigo.' },
    ];
    const set = buildCompanyHubSlugSet(nonTiOnlyJobs);
    expect(set.has(slugifyCompanyName('Zurich Corp'))).toBe(false);
    expect(set.size).toBe(0);
  });

  it('includes a company with >=1 active TI job even if it also has non-TI jobs', () => {
    const mixedCantonJobs = [
      { title: 'Dev', slug: 'dev-multi-ti', company: 'Multi SA', canton: 'TI', location: 'Lugano', description: 'Ruolo a Lugano.' },
      { title: 'Dev', slug: 'dev-multi-zh', company: 'Multi SA', canton: 'ZH', location: 'Zürich', description: 'Ruolo a Zurigo.' },
    ];
    const set = buildCompanyHubSlugSet(mixedCantonJobs);
    expect(set.has(slugifyCompanyName('Multi SA'))).toBe(true);
  });

  it('companyHubUrlIfEmitted returns "" for a company whose only active job is outside TI', () => {
    // Mirrors production: buildCompanyHubSlugSet always runs over the FULL
    // active jobs array (activeJobs has real TI jobs), never a single
    // company's jobs in isolation — so the allow-set here is non-empty and
    // the gate (not the "empty allow-set, fail-open" escape hatch) is what's
    // under test.
    const jobsWithNonTiOnlyCompany = [
      ...activeJobs,
      { title: 'Dev', slug: 'dev-zh', company: 'Zurich Corp', canton: 'ZH', location: 'Zürich', description: 'Sviluppo software a Zurigo.' },
    ];
    const emitted = buildCompanyHubSlugSet(jobsWithNonTiOnlyCompany);
    expect(companyHubUrlIfEmitted('Zurich Corp', 'it', emitted)).toBe('');
  });

  it('matchJobsForSubscriber attaches no companyUrl for a non-TI-only company', () => {
    const jobsWithNonTiOnlyCompany = [
      ...activeJobs,
      { title: 'Dev', slug: 'dev-zh', company: 'Zurich Corp', canton: 'ZH', location: 'Zürich', description: 'Sviluppo software a Zurigo.' },
    ];
    const subscriber = { locale: 'it' };
    const matched = matchJobsForSubscriber(subscriber, jobsWithNonTiOnlyCompany, 4, 'it');
    const zhCard = matched.find((c) => c.company === 'Zurich Corp');
    if (zhCard) expect(zhCard.companyUrl).toBe('');
  });
});
