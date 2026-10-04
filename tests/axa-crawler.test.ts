/**
 * AXA Svizzera crawler slug-disambiguation tests.
 *
 * Regression coverage for the silent slug-collision bug where multiple distinct
 * AXA openings (e.g. several "Consulente Assicurativo" roles published in
 * different Ticino cities) collapse to a single title-only slug under the
 * previous formula `slugify(title)` and get silently removed by the
 * housekeeping dedup pass.
 *
 * Audit reference: /tmp/housekeeping-audit-2026-04-07.md identified 16 silent
 * losses in axa-svizzera over a 30-day window (e.g. the Manno opening
 * 7da4e753-c869-4ef6-afe3-65b2ba0021f1 was repeatedly dropped because it
 * shared slug `consulente-per-la-sicurezza-axa-svizzera-axa` with the Biasca
 * opening 47bd2188-53ff-4ebf-b6d5-e00867e82a24).
 *
 * Each AXA vacancy URL contains a unique UUID under
 * `/posizioni-aperte/{slug}/{uuid}`; the regenerated slug must encode that
 * identity so the slugs remain unique even when title + city are identical.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
import {
  buildAxaRegeneratedSlug,
  buildAxaJob,
} from '@/scripts/update-axa-jobs.mjs';
import { fetchAxaJibeListings, parseAxaJibeDetailPage, parseAxaJibeListing } from '@/scripts/lib/axa-job-parser.mjs';

interface AxaRowFixture {
  url: string;
  detailUrl?: string;
  title: string;
  excerpt?: string;
  description?: string;
  metaDescription?: string;
  location?: string;
  address?: string;
  workload?: string;
  applyUrl?: string;
  uuid?: string;
  region?: string;
  lang?: string;
}

const makeRow = (overrides: Partial<AxaRowFixture> = {}): AxaRowFixture => ({
  url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
  detailUrl:
    'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
  title: 'Consulente Assicurativo',
  excerpt:
    'AXA cerca un consulente assicurativo motivato per consolidare la propria presenza ' +
    'sul territorio ticinese. Offriamo un ambiente dinamico, formazione continua e ' +
    'percorsi di carriera strutturati nel settore assicurativo svizzero.',
  description:
    'AXA cerca un consulente assicurativo motivato per consolidare la propria presenza ' +
    'sul territorio ticinese. Offriamo un ambiente dinamico, formazione continua e ' +
    'percorsi di carriera strutturati nel settore assicurativo svizzero.',
  metaDescription: '',
  location: 'Lugano',
  address: 'Via Maraini 13, 6900 Lugano',
  workload: '100%',
  applyUrl: 'https://jobs.axa.ch/apply/ats/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
  uuid: '59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
  region: 'tessin',
  lang: 'it',
  ...overrides,
});

describe('buildAxaRegeneratedSlug — disambiguator', () => {
  it('produces distinct slugs for jobs with identical title + city but different UUIDs', () => {
    const jobA = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/7da4e753-c869-4ef6-afe3-65b2ba0021f1',
      location: 'Manno',
    });
    const jobB = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/47bd2188-53ff-4ebf-b6d5-e00867e82a24',
      location: 'Biasca',
    });
    const jobC = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
      location: 'Lugano',
    });

    const slugA = buildAxaRegeneratedSlug(jobA, jobA.location);
    const slugB = buildAxaRegeneratedSlug(jobB, jobB.location);
    const slugC = buildAxaRegeneratedSlug(jobC, jobC.location);

    expect(slugA).toBeTruthy();
    expect(slugB).toBeTruthy();
    expect(slugC).toBeTruthy();
    expect(new Set([slugA, slugB, slugC]).size).toBe(3);
  });

  it('produces distinct slugs for jobs at the same city with same title but different UUIDs', () => {
    // Two openings published at the same city should still survive dedup.
    const jobA = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      location: 'Lugano',
    });
    const jobB = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      location: 'Lugano',
    });

    const slugA = buildAxaRegeneratedSlug(jobA, jobA.location);
    const slugB = buildAxaRegeneratedSlug(jobB, jobB.location);

    expect(slugA).not.toBe(slugB);
  });

  it('is deterministic — same job always produces the same slug', () => {
    const job = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
      location: 'Lugano',
    });
    const slug1 = buildAxaRegeneratedSlug(job, job.location);
    const slug2 = buildAxaRegeneratedSlug(job, job.location);
    expect(slug1).toBe(slug2);
  });

  it('produces a slug that contains the title tokens, the AXA brand and the city', () => {
    const job = makeRow({
      title: 'Consulente Assicurativo',
      location: 'Lugano',
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
    });
    const slug = buildAxaRegeneratedSlug(job, job.location);
    expect(slug).toContain('consulente');
    expect(slug).toContain('axa');
    expect(slug).toContain('lugano');
  });

  it('keeps the slug length within the 90-char SEO cap', () => {
    const job = makeRow({
      title:
        'Consulente Assicurativo Senior Specializzato nei Rami Generali per il Territorio Ticinese',
      location: 'Lugano',
    });
    const slug = buildAxaRegeneratedSlug(job, job.location);
    expect(slug.length).toBeLessThanOrEqual(90);
  });
});

describe('buildAxaJob — slug regression', () => {
  it('produces 3 distinct slugs for 3 jobs with identical title + different UUIDs (audit case)', () => {
    // Reproduces the exact audit scenario from /tmp/housekeeping-audit-2026-04-07.md:
    // 3 "Consulente Assicurativo" openings at different Ticino cities silently
    // collapsed to one slug because the previous formula was `slugify(title)`.
    const rowA = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/7da4e753-c869-4ef6-afe3-65b2ba0021f1',
      detailUrl:
        'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/7da4e753-c869-4ef6-afe3-65b2ba0021f1',
      location: 'Manno',
      address: 'Via Industria 5, 6928 Manno',
    });
    const rowB = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/47bd2188-53ff-4ebf-b6d5-e00867e82a24',
      detailUrl:
        'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/47bd2188-53ff-4ebf-b6d5-e00867e82a24',
      location: 'Biasca',
      address: 'Via Bellinzona 10, 6710 Biasca',
    });
    const rowC = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
      detailUrl:
        'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
      location: 'Lugano',
      address: 'Via Maraini 13, 6900 Lugano',
    });

    const jobA = buildAxaJob(rowA);
    const jobB = buildAxaJob(rowB);
    const jobC = buildAxaJob(rowC);

    const slugs = [jobA.slug, jobB.slug, jobC.slug];
    expect(new Set(slugs).size).toBe(3);
  });

  it('sets addressLocality to the per-job city so COMPANY_DEFAULTS does not overwrite it', () => {
    // The Lidl trap: if buildAxaJob does not set addressLocality, applyCompanyDefaults
    // fills it with the hardcoded HQ city, then hardenJobLocaleFields re-derives the
    // slug from `[title, company, addressLocality]` and collapses every per-city slug.
    const row = makeRow({
      location: 'Manno',
      address: 'Via Industria 5, 6928 Manno',
    });
    const job = buildAxaJob(row);
    expect(job.addressLocality).toBeTruthy();
    expect(String(job.addressLocality).toLowerCase()).toContain('manno');
  });
});

describe('AXA careers.axa.com (Jibe) source', () => {
  // Shapes of https://careers.axa.com/api/jobs?country=Switzerland and of a
  // detail page's JSON-LD on 2026-09-29, minimized (jobs.axa.ch answers 301
  // to this portal since 2026-07).
  const listingJson = {
    totalCount: 3,
    jobs: [
      {
        data: {
          req_id: '26952',
          title: 'Berater:in Gesundheitsvorsorge für die Generalagentur Vorsorge & Vermögen Bern',
          language: 'de-de',
          city: 'BERN',
          postal_code: '3008',
          street_address: 'Laupenstrasse 19',
          country_code: 'CH',
          description: '100%, Arbeitsort Bern Gestalte deine Zukunft – gemeinsam mit uns! Das erwartet dich Bedürfnisorientierte Beratung',
          apply_url: 'https://careers-de-axa.icims.com/jobs/26952/login',
          posted_date: '2026-09-24T06:32:00+0000',
          meta_data: { googlejobs: { derivedInfo: { locations: [{ postalAddress: { locality: 'Bern', administrativeArea: 'BE', postalCode: '3008' } }] } } },
        },
      },
      {
        data: {
          req_id: '23727',
          title: 'Mitarbeiter:in Innendienst für die Hauptagentur Pfäffikon SZ',
          language: 'de-de',
          city: 'PFÄFFIKON',
          postal_code: '8808',
          street_address: 'Churerstrasse 135',
          country_code: 'CH',
          description: '60%, Arbeitsort Pfäffikon SZ',
          meta_data: { googlejobs: { derivedInfo: { locations: [{ postalAddress: { locality: 'Freienbach', administrativeArea: 'SZ' } }] } } },
        },
      },
      { data: { req_id: '99999', title: 'Claims Handler', language: 'en-us', city: 'DUBLIN', country_code: 'IE' } },
    ],
  };

  it('validates the complete Jibe source timestamp through the builder', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const build = (posted_date: string) => {
      const { rows } = parseAxaJibeListing({ totalCount: 1, jobs: [{ data: { ...listingJson.jobs[0].data, posted_date } }] });
      expect(rows).toHaveLength(1);
      return buildAxaJob({ ...rows[0], canton: rows[0].cantonHint });
    };
    expect(build('2026-09-24T06:32:00+0000')).toMatchObject({
      postedDate: '2026-09-24T06:32:00+00:00', datePosted: '2026-09-24T06:32:00+00:00', postingDateSource: 'reported',
    });
    for (const value of ['2026-10-03T23:32:00+0000', '2026-02-30T06:32:00+0000', '2026-09-24T99:32:00+0000']) {
      expect(build(value)).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
    }
  });

  it('keeps the Swiss postings with the city the page states and the geocoded canton', () => {
    const { total, rows } = parseAxaJibeListing(listingJson);

    expect(total).toBe(3);
    expect(rows.map((row) => row.reqId)).toEqual(['26952', '23727']);
    expect(rows[0]).toMatchObject({
      url: 'https://careers.axa.com/careers-home/jobs/26952?lang=de-de',
      listingCity: 'Bern',
      cantonHint: 'BE',
      address: 'Laupenstrasse 19, 3008 Bern',
      postalCode: '3008',
      lang: 'de',
    });
    // «PFÄFFIKON» is what the detail page says; «Freienbach» is only the
    // municipality the geocoder picked. The canton settles the homonym.
    expect(rows[1]).toMatchObject({ listingCity: 'Pfäffikon', cantonHint: 'SZ' });
    expect(rows[0].listingDescription).toContain('Das erwartet dich');
  });

  it('reads the full HTML ad from the detail JSON-LD, lists and umlauts included', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'http://schema.org',
      '@type': 'JobPosting',
      title: 'Berater:in Gesundheitsvorsorge für die Generalagentur Vorsorge &amp; Verm&ouml;gen Bern',
      description: '<p><span>100%, Arbeitsort Bern</span></p><p>&nbsp;</p><p><strong>Das erwartet dich</strong></p><ul><li>Bed&uuml;rfnisorientierte Beratung von Versicherungskund:innen</li><li>Gewinnung von Neukund:innen</li></ul><p><strong>Das bringst du mit</strong></p><ul><li>&Uuml;berzeugendes Auftreten</li></ul>',
      jobLocation: { '@type': 'Place', address: { addressLocality: 'BERN', postalCode: '3008' } },
    })}</script></head><body></body></html>`;
    const detail = parseAxaJibeDetailPage(html);

    expect(detail.title).toBe('Berater:in Gesundheitsvorsorge für die Generalagentur Vorsorge & Vermögen Bern');
    expect(detail.workload).toBe('100%');
    expect(detail.description).toMatch(/^100%, Arbeitsort Bern/);
    expect(detail.description).toContain('Das erwartet dich\n\n• Bedürfnisorientierte Beratung von Versicherungskund:innen');
    expect(detail.description).toContain('• Überzeugendes Auftreten');
    expect(detail.description).not.toMatch(/&[a-z]+;/i);
  });

  describe('listing completeness', () => {
    const posting = (id: number, country = 'CH') => ({
      data: { req_id: String(id), title: `Kundenberater:in ${id}`, language: 'de-de', city: 'BERN', postal_code: '3008', country_code: country, description: 'Das erwartet dich' },
    });
    const page = (from: number, count: number, totalCount: number, foreign = 0) => ({
      totalCount,
      jobs: [
        ...Array.from({ length: count - foreign }, (_, i) => posting(from + i)),
        ...Array.from({ length: foreign }, (_, i) => posting(90000 + i, 'IE')),
      ],
    });

    it('fails, instead of returning 100 of 157, when page 2 errors', async () => {
      const fetchJson = async (url: string) => {
        if (url.includes('page=1&')) return page(1, 100, 157);
        throw new Error('HTTP 503');
      };
      await expect(fetchAxaJibeListings({ fetchJson })).rejects.toThrow(/page 2 failed after 100\/157/);
    });

    it('fails when the listing ends before totalCount postings arrived', async () => {
      const fetchJson = async (url: string) => (url.includes('page=1&') ? page(1, 100, 157) : { totalCount: 157, jobs: [] });
      await expect(fetchAxaJibeListings({ fetchJson })).rejects.toThrow(/incomplete: 100\/157/);
    });

    it('returns every Swiss posting once all totalCount postings arrived, a foreign one included', async () => {
      const fetchJson = async (url: string) => (url.includes('page=1&') ? page(1, 100, 158) : page(101, 58, 158, 1));
      const rows = await fetchAxaJibeListings({ fetchJson });
      expect(rows).toHaveLength(157);
    });
  });
});
