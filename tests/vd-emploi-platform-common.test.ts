import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createVdEmploiPlatformParser, offerDetailUrl } from '../scripts/lib/vd-emploi-platform-common.mjs';

/**
 * Issue 5253 (hib-broye): every published URL of the four hospitals on the
 * VD "emploi.*" platform was `/nos-offres/<slug>`, which 301-redirects to
 * `/undefined`. The API's `uri` (or `/fr/nos-offres/<slug>-<id>`) is the page.
 * Fixture: offers of emploi.hopital-broye.ch and emploi.ehc-vd.ch, bodies
 * truncated. HIB ids 95 and 103 share one slug; id 198 carries another
 * offer's slug.
 */
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'vd-emploi-platform', 'offers.json'),
  'utf8',
));

describe('offerDetailUrl', () => {
  it('uses the API uri when it points at the career host', () => {
    const offer = fixture.hib.offers.find((o) => o.id === 103);
    expect(offerDetailUrl(offer, 'https://emploi.hopital-broye.ch'))
      .toBe('https://emploi.hopital-broye.ch/fr/nos-offres/physiotherapeute-de-80-a-100-103');
  });

  it('builds /fr/nos-offres/<slug>-<id> when the API sends no uri (EHC)', () => {
    const [offer] = fixture.ehc;
    expect(offer.uri).toBeUndefined();
    expect(offerDetailUrl(offer, 'https://emploi.ehc-vd.ch/'))
      .toBe('https://emploi.ehc-vd.ch/fr/nos-offres/agent-de-proprete-fh-3773');
  });

  it('never returns the bare /nos-offres/<slug> form that redirects to /undefined', () => {
    for (const offer of fixture.hib.offers) {
      expect(offerDetailUrl(offer, 'https://emploi.hopital-broye.ch'))
        .toMatch(/^https:\/\/emploi\.hopital-broye\.ch\/fr\/nos-offres\/[^/]+-\d+$/);
    }
  });

  it('ignores a uri on another host and builds the URL from slug + id', () => {
    expect(offerDetailUrl(
      { id: 7, slug: 'poste', uri: 'https://elsewhere.example/fr/nos-offres/poste-7' },
      'https://emploi.hopital-broye.ch',
    )).toBe('https://emploi.hopital-broye.ch/fr/nos-offres/poste-7');
  });

  it('returns an empty string without a slug or a numeric id', () => {
    expect(offerDetailUrl({ id: 7 }, 'https://emploi.hopital-broye.ch')).toBe('');
    expect(offerDetailUrl({ slug: 'poste' }, 'https://emploi.hopital-broye.ch')).toBe('');
  });
});

describe('createVdEmploiPlatformParser().fetchAllJobs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes one reachable URL per offer, also when offers share a slug', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fixture.hib), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const parser = createVdEmploiPlatformParser({
      companyKey: 'hib-broye',
      companyName: 'Hôpital Intercantonal de la Broye (HIB)',
      companyDomain: 'hopital-broye.ch',
      baseUrl: 'https://emploi.hopital-broye.ch',
      defaultCanton: 'VD',
      defaultCity: 'Payerne',
      defaultPostalCode: '1530',
    });
    const jobs = await parser.fetchAllJobs();
    expect(jobs).toHaveLength(fixture.hib.offers.length);
    const urls = jobs.map((job) => job.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(jobs.length);
    for (const job of jobs) {
      expect(job.url).toMatch(/\/fr\/nos-offres\/[^/]+-\d+$/);
      expect(job.applyUrl).toBe(job.url);
      expect(parser.isTrustedDomain(job.url)).toBe(true);
    }
    const billing = jobs.find((job) => /facturation/.test(job.title));
    expect(billing?.url).toMatch(/-198$/);
  });

  const hibConfig = {
    companyKey: 'hib-broye',
    companyName: 'Hôpital Intercantonal de la Broye (HIB)',
    companyDomain: 'hopital-broye.ch',
    baseUrl: 'https://emploi.hopital-broye.ch',
    defaultCanton: 'VD',
    defaultCity: 'Payerne',
    defaultPostalCode: '1530',
  };
  const stubApi = (payload: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));

  it('keeps two offers with different ids and requisitions even when title, workplace and text are identical', async () => {
    const [first] = fixture.hib.offers;
    const twin = { ...first, id: first.id + 1000, requisitionId: first.requisitionId + 1000, uri: undefined };
    stubApi({ offers: [first, twin] });
    const jobs = await createVdEmploiPlatformParser(hibConfig).fetchAllJobs();
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.url)).size).toBe(2);
  });

  it('keeps one row, the most recent, for an offer the source republishes under the same requisition', async () => {
    // EHC 3590 and 3626: two offer ids, requisition 2165 for both.
    const [first] = fixture.hib.offers;
    const older = { ...first, id: first.id + 1000, uri: undefined, dateFrom: '2000-01-01T00:00:00+00:00' };
    stubApi({ offers: [older, first] });
    const jobs = await createVdEmploiPlatformParser(hibConfig).fetchAllJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toMatch(new RegExp(`-${first.id}$`));
  });

  it('keeps one row for the same offer id listed twice', async () => {
    const [first] = fixture.hib.offers;
    stubApi({ offers: [first, { ...first }] });
    const jobs = await createVdEmploiPlatformParser(hibConfig).fetchAllJobs();
    expect(jobs).toHaveLength(1);
  });

  it('moves stored rows off the legacy URL onto the offer with the same title, and drops dead ones', async () => {
    stubApi(fixture.hib);
    const parser = createVdEmploiPlatformParser(hibConfig);
    const stored = [
      // Legacy URL shared by offers 95 and 103: the title decides.
      { title: 'Physiothérapeute de 80% à 100%', url: 'https://emploi.hopital-broye.ch/nos-offres/physiotherapeute-de-80-a-100', descriptionByLocale: { it: 'tradotto' } },
      // Legacy URL of an offer the API no longer lists.
      { title: 'Employé-e de maison à 80%', url: 'https://emploi.hopital-broye.ch/nos-offres/secretaire-medicale-a-30' },
      // Already on the current URL shape.
      { title: 'Autre', url: 'https://emploi.hopital-broye.ch/fr/nos-offres/autre-1' },
    ];
    expect(parser.prepareExistingJobs(stored)).toBe(stored); // before a fetch: untouched
    await parser.fetchAllJobs();
    const prepared = parser.prepareExistingJobs(stored);
    expect(prepared.map((job) => job.url)).toEqual([
      'https://emploi.hopital-broye.ch/fr/nos-offres/physiotherapeute-de-80-a-100-103',
      'https://emploi.hopital-broye.ch/fr/nos-offres/autre-1',
    ]);
    expect(prepared[0].applyUrl).toBe(prepared[0].url);
    expect(prepared[0].descriptionByLocale).toEqual({ it: 'tradotto' });
  });
});
