import { describe, it, expect } from 'vitest';
import {
  publisherJobToRecords,
  publisherJobsToSlice,
  applyFeaturedSlotCap,
  slugifyPublisher,
  truncatePublisherSlug,
  PUBLISHER_SOURCE_KEY,
} from '../scripts/lib/publisherJobProjection.mjs';
import {
  detectBoilerplateDescriptions,
} from '../scripts/assemble-jobs-dataset.mjs';

const NOW = '2026-06-10T10:00:00.000Z';

function paidJob(over: Record<string, unknown> = {}) {
  return {
    id: 'job1',
    publisherUid: 'pub1',
    status: 'paid',
    title: 'Fisioterapista diplomato/a',
    description: 'x '.repeat(60),
    sourceLang: 'it',
    company: { name: 'R&C PhysioMedical Group', domain: 'physiomedicalgroup.ch' },
    locations: [{ label: 'Lugano' }, { label: 'Locarno' }],
    employmentType: 'FULL_TIME',
    apply: { mode: 'external_url', url: 'https://physiomedicalgroup.ch/careers' },
    paidAt: NOW,
    createdAt: NOW,
    ...over,
  };
}

describe('publisherJobToRecords', () => {
  it('emits one record per distinct location', () => {
    const recs = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(recs).toHaveLength(2);
    expect(recs.map((r: any) => r.location).sort()).toEqual(['Locarno', 'Lugano']);
  });

  it('only projects paid jobs', () => {
    expect(publisherJobToRecords(paidJob({ status: 'pending_payment' }), { nowIso: NOW })).toEqual([]);
    expect(publisherJobToRecords(paidJob({ status: 'draft' }), { nowIso: NOW })).toEqual([]);
    expect(publisherJobToRecords(paidJob({ status: 'archived' }), { nowIso: NOW })).toEqual([]);
    expect(publisherJobToRecords(paidJob({ status: 'expired' }), { nowIso: NOW })).toEqual([]);
    expect(publisherJobToRecords(null, { nowIso: NOW })).toEqual([]);
  });

  it('tags provenance + source key', () => {
    const [r] = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(r.source).toBe(PUBLISHER_SOURCE_KEY);
    expect(r.publisherUid).toBe('pub1');
    expect(r.publisherJobId).toBe('job1');
  });

  it('mirrors the flat description into descriptionByLocale.it (boilerplate-guard input)', () => {
    const desc = 'parola '.repeat(60).trim();
    const [r] = publisherJobToRecords(paidJob({ description: desc }), { nowIso: NOW });
    expect(r.descriptionByLocale).toBeDefined();
    expect(r.descriptionByLocale.it).toBe(desc);
  });

  it('preserves an existing descriptionByLocale.it instead of overwriting it', () => {
    const existing = 'testo italiano gia tradotto con tante parole diverse qui '.repeat(4).trim();
    const [r] = publisherJobToRecords(
      paidJob({ descriptionByLocale: { it: existing } }),
      { nowIso: NOW },
    );
    expect(r.descriptionByLocale.it).toBe(existing);
  });

  it('populates titleByLocale + slugByLocale for all 4 locales (job-locale-completeness gate)', () => {
    const [r] = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(r.titleByLocale).toBeDefined();
    expect(r.slugByLocale).toBeDefined();
    for (const lk of ['it', 'en', 'de', 'fr']) {
      expect(String(r.titleByLocale[lk] || '').length).toBeGreaterThan(0);
      expect(String(r.slugByLocale[lk] || '').length).toBeGreaterThan(0);
    }
    // The /lavoro/<slug> path is locale-agnostic → same slug across locales.
    expect(r.slugByLocale.en).toBe(r.slug);
    expect(r.titleByLocale.it).toBe('Fisioterapista diplomato/a');
  });

  it('preserves a real per-locale title/slug instead of overwriting with the source', () => {
    const [r] = publisherJobToRecords(
      paidJob({ titleByLocale: { en: 'Certified physiotherapist' }, slugByLocale: { en: 'certified-physiotherapist-lugano' } }),
      { nowIso: NOW },
    );
    expect(r.titleByLocale.en).toBe('Certified physiotherapist');
    expect(r.slugByLocale.en).toBe('certified-physiotherapist-lugano');
    expect(String(r.titleByLocale.de || '').length).toBeGreaterThan(0); // still backfilled from source
  });

  it('produces stable deterministic ids per (job, location)', () => {
    const a = publisherJobToRecords(paidJob(), { nowIso: NOW });
    const b = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(a.map((r: any) => r.id)).toEqual(b.map((r: any) => r.id));
    expect(a.map((r: any) => r.id)).toContain('pub-job1-lugano');
    expect(a.map((r: any) => r.id)).toContain('pub-job1-locarno');
  });

  it('uses the external apply URL when mode is external_url', () => {
    const [r] = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(r.applyUrl).toBe('https://physiomedicalgroup.ch/careers');
  });

  it('falls back to the site canonical apply URL for non-external modes', () => {
    const [r] = publisherJobToRecords(
      paidJob({ apply: { mode: 'forward_email', email: 'hr@x.ch' } }),
      { nowIso: NOW },
    );
    expect(r.applyUrl).toBe(r.url);
    expect(r.url).toMatch(/^https:\/\/frontaliereticino\.ch\/lavoro\//);
  });

  it('carries structured-data fields with safe defaults', () => {
    const [r] = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(r.canton).toBe('TI');
    expect(r.country).toBe('CH');
    expect(r.currency).toBe('CHF');
    expect(r.postedDate).toBe(NOW);
    // crawledAt is day-granularity (= "last verified live"); validThrough = crawledAt + 30d.
    expect(r.crawledAt).toBe('2026-06-10');
    expect(r.validThrough).toBe('2026-07-10T00:00:00.000Z');
    expect(r.addressLocality).toBe('Lugano');
  });

  it('refreshes crawledAt so validThrough never goes stale on a still-live ad', () => {
    // Ad paid months ago but re-projected today → crawledAt = today, validThrough future.
    const [r] = publisherJobToRecords(
      paidJob({ paidAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }),
      { nowIso: '2026-09-15T08:00:00.000Z' },
    );
    expect(r.crawledAt).toBe('2026-09-15');
    expect(r.postedDate).toBe('2026-01-01T00:00:00.000Z'); // datePosted stays true
    expect(new Date(r.validThrough).getTime()).toBeGreaterThan(new Date('2026-09-15').getTime());
  });

  it('floors validThrough to a future date when projected without nowIso from a stale paidAt (#3505)', () => {
    // No nowIso → crawledAt anchors to the (old) paidAt; without the floor the
    // record would carry validThrough = paidAt + 30d, already in the past.
    // Relative dates (never absolute): fixture must not become a time-bomb.
    const daysAgoIso = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
    const stalePaidAt = daysAgoIso(120);
    const [r] = publisherJobToRecords(
      paidJob({ paidAt: stalePaidAt, createdAt: stalePaidAt }),
    );
    // Floored to ≥ today(day-granular) + 30d — strictly in the future.
    expect(new Date(r.validThrough).getTime()).toBeGreaterThan(
      Date.now() + 28 * 86400000,
    );
    expect(r.postedDate).toBe(stalePaidAt); // datePosted stays true
  });

  it('honors explicit location address + canton', () => {
    const recs = publisherJobToRecords(
      paidJob({
        locations: [
          { label: 'Lugano', canton: 'TI', address: { postalCode: '6900', streetAddress: 'Via Emilio Bossi 6' } },
        ],
      }),
      { nowIso: NOW },
    );
    expect(recs[0].postalCode).toBe('6900');
    expect(recs[0].streetAddress).toBe('Via Emilio Bossi 6');
  });

  it('propagates the featured flag', () => {
    const [r] = publisherJobToRecords(paidJob({ featured: true }), { nowIso: NOW });
    expect(r.featured).toBe(true);
    const [r2] = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(r2.featured).toBe(false);
  });

  it('Piano Azienda (tier=azienda): always featured + tier preserved', () => {
    // Unlimited plan → every ad is featured by default, even without an explicit
    // featured flag; the azienda tier must survive projection (not collapse to sponsored).
    const [r] = publisherJobToRecords(paidJob({ tier: 'azienda' }), { nowIso: NOW });
    expect(r.featured).toBe(true);
    expect(r.tier).toBe('azienda');
    // External apply still allowed (employer can keep their own URL); not forced to in-house.
    expect(r.applyMode).toBe('external_url');
  });

  it('dedupes case/whitespace-variant locations', () => {
    const recs = publisherJobToRecords(
      paidJob({ locations: [{ label: 'Lugano' }, { label: 'lugano ' }, { label: '' }] }),
      { nowIso: NOW },
    );
    expect(recs).toHaveLength(1);
  });
});

describe('publisherJobsToSlice', () => {
  it('flattens many jobs and skips non-paid', () => {
    const slice = publisherJobsToSlice(
      [paidJob(), paidJob({ id: 'job2', status: 'draft' })],
      { nowIso: NOW },
    );
    expect(slice).toHaveLength(2); // only job1's 2 locations
  });
});

describe('free tier', () => {
  it('projects free ads with status "published" (live alongside sponsored "paid")', () => {
    const recs = publisherJobToRecords(
      paidJob({ tier: 'free', status: 'published', locations: [{ label: 'Lugano' }] }),
      { nowIso: NOW },
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].tier).toBe('free');
  });

  it('never marks a free ad as featured, even if the flag is set', () => {
    const [r] = publisherJobToRecords(
      paidJob({ tier: 'free', status: 'published', featured: true, locations: [{ label: 'Lugano' }] }),
      { nowIso: NOW },
    );
    expect(r.featured).toBe(false);
  });

  it('tags sponsored ads with tier "sponsored"', () => {
    const [r] = publisherJobToRecords(paidJob({ tier: 'sponsored' }), { nowIso: NOW });
    expect(r.tier).toBe('sponsored');
  });

  it('does not project a free ad still in draft', () => {
    expect(
      publisherJobToRecords(paidJob({ tier: 'free', status: 'draft' }), { nowIso: NOW }),
    ).toEqual([]);
  });

  it('slice includes both free-published and sponsored-paid, skips drafts', () => {
    const slice = publisherJobsToSlice(
      [
        paidJob({ id: 'spon', tier: 'sponsored', status: 'paid', locations: [{ label: 'Lugano' }] }),
        paidJob({ id: 'free', tier: 'free', status: 'published', locations: [{ label: 'Locarno' }] }),
        paidJob({ id: 'draft', tier: 'free', status: 'draft', locations: [{ label: 'Bellinzona' }] }),
      ],
      { nowIso: NOW },
    );
    expect(slice).toHaveLength(2);
    expect(slice.map((r: any) => r.tier).sort()).toEqual(['free', 'sponsored']);
  });
});

describe('slug helpers', () => {
  it('slugifies with diacritic stripping', () => {
    expect(slugifyPublisher('Zürich Genève')).toBe('zurich-geneve');
    expect(slugifyPublisher('  Fisioterapista, diplomato/a  ')).toBe('fisioterapista-diplomato-a');
  });
  it('truncates at a hyphen boundary', () => {
    const long = 'a'.repeat(60) + '-' + 'b'.repeat(80);
    expect(truncatePublisherSlug(long, 120).endsWith('-')).toBe(false);
    expect(truncatePublisherSlug(long, 120).length).toBeLessThanOrEqual(120);
  });
});

describe('applyFeaturedSlotCap', () => {
  const mk = (canton: string, postedDate: string) => ({ canton, featured: true, postedDate });

  it('keeps all featured when within cap', () => {
    const recs = [mk('TI', '2026-06-01'), mk('TI', '2026-06-02')];
    applyFeaturedSlotCap(recs, 6);
    expect(recs.every((r) => r.featured)).toBe(true);
  });

  it('caps featured per canton, keeping the most recently paid', () => {
    const recs = [
      mk('TI', '2026-06-01'),
      mk('TI', '2026-06-03'),
      mk('TI', '2026-06-02'),
    ];
    applyFeaturedSlotCap(recs, 2);
    const kept = recs.filter((r) => r.featured).map((r) => r.postedDate).sort();
    expect(kept).toEqual(['2026-06-02', '2026-06-03']); // newest two
  });

  it('caps independently per canton', () => {
    const recs = [mk('TI', '2026-06-01'), mk('TI', '2026-06-02'), mk('GR', '2026-06-01')];
    applyFeaturedSlotCap(recs, 1);
    expect(recs.filter((r) => r.canton === 'TI' && r.featured)).toHaveLength(1);
    expect(recs.filter((r) => r.canton === 'GR' && r.featured)).toHaveLength(1);
  });

  it('never touches non-featured records', () => {
    const recs = [{ canton: 'TI', featured: false, postedDate: '2026-06-01' }];
    applyFeaturedSlotCap(recs, 0);
    expect(recs[0].featured).toBe(false);
  });

  it('exempts Piano Azienda from the cap and does not let it consume sponsored slots', () => {
    // 2 azienda (unlimited, always featured) + 2 sponsored, cap=1 per canton.
    const recs = [
      { canton: 'TI', tier: 'azienda', featured: true, postedDate: '2026-06-01' },
      { canton: 'TI', tier: 'azienda', featured: true, postedDate: '2026-06-02' },
      { canton: 'TI', tier: 'sponsored', featured: true, postedDate: '2026-06-03' },
      { canton: 'TI', tier: 'sponsored', featured: true, postedDate: '2026-06-04' },
    ];
    applyFeaturedSlotCap(recs, 1);
    // Both azienda stay featured (exempt); sponsored still capped to 1 (newest).
    expect(recs.filter((r) => r.tier === 'azienda').every((r) => r.featured)).toBe(true);
    const sponsoredKept = recs.filter((r) => r.tier === 'sponsored' && r.featured);
    expect(sponsoredKept).toHaveLength(1);
    expect(sponsoredKept[0].postedDate).toBe('2026-06-04');
  });
});

describe('applyMode projection', () => {
  it('emits the sponsored apply mode', () => {
    const [r] = publisherJobToRecords(
      paidJob({ tier: 'sponsored', apply: { mode: 'forward_email', email: 'hr@x.ch' } }),
      { nowIso: NOW },
    );
    expect(r.applyMode).toBe('forward_email');
  });

  it('forces external_url for free tier regardless of stored mode', () => {
    const [r] = publisherJobToRecords(
      paidJob({ tier: 'free', status: 'published', apply: { mode: 'in_house', email: 'x@y.ch' }, locations: [{ label: 'Lugano' }] }),
      { nowIso: NOW },
    );
    expect(r.applyMode).toBe('external_url');
  });
});

describe('companyLogo projection', () => {
  it('projects a valid https logoUrl as companyLogo', () => {
    const [r] = publisherJobToRecords(
      paidJob({ company: { name: 'ACME SA', logoUrl: 'https://acme.ch/logo.png' } }),
      { nowIso: NOW },
    );
    expect(r.companyLogo).toBe('https://acme.ch/logo.png');
  });

  it('drops non-https / junk logo URLs (initials-badge fallback downstream)', () => {
    for (const bad of ['http://acme.ch/logo.png', 'javascript:alert(1)', 'data:image/png;base64,x', '/logo.png', '']) {
      const [r] = publisherJobToRecords(
        paidJob({ company: { name: 'ACME SA', logoUrl: bad } }),
        { nowIso: NOW },
      );
      expect(r.companyLogo, `logoUrl=${bad}`).toBeUndefined();
    }
  });
});

describe('descriptionMd projection (sponsored-only markdown)', () => {
  it('passes descriptionMd through for sponsored ads', () => {
    const md = `## Chi siamo\nTesto.\n\n## Requisiti\n- ${'parola '.repeat(50).trim()}`;
    const [r] = publisherJobToRecords(paidJob({ descriptionMd: md }), { nowIso: NOW });
    expect(r.descriptionMd).toBe(md);
    expect(r.description).toBe(paidJob().description); // flat description untouched
  });

  it('never projects descriptionMd on free-tier ads', () => {
    const [r] = publisherJobToRecords(
      paidJob({ tier: 'free', status: 'published', descriptionMd: '## Sezione\n- voce' }),
      { nowIso: NOW },
    );
    expect(r.descriptionMd).toBeUndefined();
  });
});

describe('publisher slice does not trip the boilerplate guard', () => {
  // Regression for the publisher-jobs-sync FATAL: publisher ads store only the
  // flat `description`, so before the descriptionByLocale.it mirror the guard
  // read an empty IT description and flagged every paid ad as boilerplate
  // (`empty_description`) → 100% ratio → the whole sync aborted and the paid ad
  // never reached the live slice.
  it('flags 0 records as boilerplate when ads have real ≥50-word descriptions', () => {
    const realDesc =
      'Cerchiamo una figura motivata e qualificata da inserire stabilmente nel nostro ' +
      'team clinico multidisciplinare in forte crescita. COMPITI: gestione quotidiana ' +
      'dei pazienti, valutazione funzionale completa, redazione dei piani di trattamento ' +
      'personalizzati, monitoraggio dei progressi e stretta collaborazione con il ' +
      'personale medico e amministrativo della struttura. PROFILO: diploma riconosciuto, ' +
      'esperienza pregressa nel settore, ottime capacita relazionali e comunicative, ' +
      'autonomia organizzativa, precisione e disponibilita al lavoro su turni flessibili. ' +
      'Offriamo un ambiente moderno e ben attrezzato, formazione continua, possibilita ' +
      'concrete di crescita professionale e un pacchetto retributivo competitivo.';
    const recs = publisherJobsToSlice([paidJob({ description: realDesc })], { nowIso: NOW });
    expect(recs.length).toBeGreaterThan(0);
    const report = detectBoilerplateDescriptions(recs, PUBLISHER_SOURCE_KEY);
    expect(report.boilerplateCount).toBe(0);
    expect(report.ratio).toBe(0);
  });
});
