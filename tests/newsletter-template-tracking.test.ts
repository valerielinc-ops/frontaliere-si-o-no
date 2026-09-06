import { describe, expect, it } from 'vitest';

const { buildNewsletter, FEATURED_TOOLS, directUrl } = await import('@/services/newsletter-template.mjs');
const { matchJobsForSubscriber, validateJobUrls, getFallbackBriefing, FALLBACK_SUBJECT, decayFactor } = await import('@/services/newsletter-content.mjs');

const SAMPLE_EXCHANGE = { rate: 1.0942, previousRate: 1.0885 };
const SAMPLE_FACT = { text: 'Oltre 78.000 frontalieri lavorano nel Canton Ticino.', source: 'USTAT' };
const SAMPLE_TOOL = FEATURED_TOOLS[0];
const SAMPLE_JOBS = [
  { title: 'Software Engineer', company: 'Acme SA', location: 'Lugano', url: '/cerca-lavoro-ticino/software-engineer-acme-sa/' },
  { title: 'Accountant', company: 'Beta AG', location: 'Bellinzona', url: '/cerca-lavoro-ticino/accountant-beta-ag/' },
];

describe('newsletter template v2', () => {
  it('renders a valid HTML email with all sections', () => {
    const html = buildNewsletter({
      aiBriefing: '<p>Questa settimana il cambio resta stabile.</p>',
      exchangeRate: SAMPLE_EXCHANGE,
      matchedJobs: SAMPLE_JOBS,
      featuredTool: SAMPLE_TOOL,
      weeklyFact: SAMPLE_FACT,
      locale: 'it',
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=test@example.com',
      resubscribeUrl: 'https://frontaliereticino.ch/?action=resubscribe&email=test@example.com',
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Frontaliere Weekly');
    expect(html).toContain('1.0942');
    expect(html).toContain('Software Engineer');
    expect(html).toContain('Accountant');
    expect(html).toContain('Questa settimana il cambio resta stabile.');
    expect(html).toContain('78.000 frontalieri');
  });

  it('uses direct www URLs, never /newsletter/click/', () => {
    const html = buildNewsletter({
      aiBriefing: '<p>Test briefing.</p>',
      exchangeRate: SAMPLE_EXCHANGE,
      matchedJobs: SAMPLE_JOBS,
      featuredTool: SAMPLE_TOOL,
      weeklyFact: SAMPLE_FACT,
      locale: 'it',
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=test@example.com',
      resubscribeUrl: 'https://frontaliereticino.ch/?action=resubscribe&email=test@example.com',
    });

    expect(html).not.toContain('/newsletter/click/');
    expect(html).toContain('https://frontaliereticino.ch');
  });

  it('includes unsubscribe link', () => {
    const html = buildNewsletter({
      aiBriefing: '<p>Test.</p>',
      exchangeRate: SAMPLE_EXCHANGE,
      matchedJobs: [],
      featuredTool: SAMPLE_TOOL,
      weeklyFact: SAMPLE_FACT,
      locale: 'it',
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=test@example.com',
    });

    expect(html).toContain('action=unsubscribe');
  });

  it('works without aiBriefing (null/undefined)', () => {
    const html = buildNewsletter({
      exchangeRate: SAMPLE_EXCHANGE,
      matchedJobs: SAMPLE_JOBS,
      featuredTool: SAMPLE_TOOL,
      weeklyFact: SAMPLE_FACT,
      locale: 'it',
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=test@example.com',
      resubscribeUrl: 'https://frontaliereticino.ch/?action=resubscribe&email=test@example.com',
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('1.0942');
  });

  it('renders preheader text when provided', () => {
    const html = buildNewsletter({
      aiBriefing: '<p>Test.</p>',
      exchangeRate: SAMPLE_EXCHANGE,
      matchedJobs: [],
      featuredTool: SAMPLE_TOOL,
      weeklyFact: SAMPLE_FACT,
      locale: 'it',
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=test@example.com',
      resubscribeUrl: 'https://frontaliereticino.ch/?action=resubscribe&email=test@example.com',
      preheaderText: 'Questa settimana il cambio CHF/EUR sale!',
    });

    expect(html).toContain('Questa settimana il cambio CHF/EUR sale!');
  });
});

describe('newsletter content v2', () => {
  it('matchJobsForSubscriber returns limited jobs', () => {
    const jobs = Array.from({ length: 10 }, (_, i) => ({
      title: `Job ${i}`,
      company: `Co ${i}`,
      location: i < 5 ? 'Lugano' : 'Bellinzona',
      slug: `job-${i}-co-${i}`,
      publishedAt: new Date(Date.now() - i * 86400000).toISOString(),
    }));

    const matched = matchJobsForSubscriber({ locationInterest: 'Lugano', sectorInterest: null }, jobs, 3);
    expect(matched.length).toBeLessThanOrEqual(3);
  });

  it('matchJobsForSubscriber falls back to recent jobs with no preferences', () => {
    const jobs = [
      { title: 'A', company: 'X', location: 'Lugano', slug: 'a-x-lugano', publishedAt: new Date().toISOString() },
      { title: 'B', company: 'Y', location: 'Zurich', slug: 'b-y-zurich', publishedAt: new Date().toISOString() },
    ];

    const matched = matchJobsForSubscriber({ locationInterest: null, sectorInterest: null }, jobs, 5);
    expect(matched.length).toBe(2);
  });

  // Regression: company logos for the manifest's self-hosted brand/logo images
  // are offloaded out of the origin artifact to the CDN at deploy
  // (scripts/offload-generated-images-cdn.mjs), so the origin
  // /images/{brands,logos}/… path 404s and the email <img> shows a broken icon.
  // matchJobsForSubscriber MUST emit the CDN host for those paths (mirrors the
  // job-alert email fix #1705).
  it('matchJobsForSubscriber resolves manifest logos to the CDN host, not the origin', () => {
    const jobs = [
      { title: 'Engineer', company: 'Tether Operations', companyKey: 'tether', location: 'Lugano', slug: 'engineer-tether', publishedAt: new Date().toISOString() },
    ];

    const [matched] = matchJobsForSubscriber({ locationInterest: null, sectorInterest: null }, jobs, 1);
    // tether → /images/brands/tether.png in data/company-logos-manifest.json
    expect(matched.logoUrl).toBe('https://cdn.frontaliereticino.ch/images/brands/tether.png');
    // never the bare origin (which 404s post-offload)
    expect(matched.logoUrl.startsWith('https://frontaliereticino.ch/images/')).toBe(false);
  });

  // Regression: recentlyFeaturedSlugs must never displace fresh candidates
  // just because the fresh pool is shorter than `limit`. Older logic
  // (freshPool.length >= limit ? freshPool : fullPool) wholesale fell back to
  // the full pool, so an evergreen popular job in the exclude list could win
  // again. New logic puts fresh first and only backfills missing slots.
  it('matchJobsForSubscriber prefers fresh over recently-featured even when fresh pool is short', () => {
    const jobs = [
      { title: 'Evergreen', company: 'BigCo', location: 'Lugano', slug: 'evergreen', publishedAt: new Date().toISOString() },
      { title: 'Fresh', company: 'NewCo', location: 'Lugano', slug: 'fresh-job', publishedAt: new Date().toISOString() },
    ];

    const matched = matchJobsForSubscriber({ locationInterest: null, sectorInterest: null }, jobs, 4, 'it', ['evergreen']);
    expect(matched[0].slug).toBe('fresh-job');
    expect(matched.length).toBe(2);
    expect(matched.map((j) => j.slug)).toEqual(['fresh-job', 'evergreen']);
  });

  it('matchJobsForSubscriber uses saved job context without returning the source job', () => {
    const jobs = [
      {
        title: 'Original Nurse Job',
        company: 'Clinic A',
        location: 'Lugano',
        slug: 'original-nurse-job',
        category: 'Sanita',
        sector: 'Sanita',
        publishedAt: '2026-05-01T00:00:00.000Z',
      },
      {
        title: 'Infermiere reparto medicina',
        company: 'Clinic B',
        location: 'Lugano',
        slug: 'nurse-medicine',
        category: 'Sanita',
        sector: 'Sanita',
        publishedAt: '2026-05-02T00:00:00.000Z',
      },
      {
        title: 'Impiegato amministrativo',
        company: 'Office Co',
        location: 'Lugano',
        slug: 'admin-office',
        category: 'Amministrazione',
        sector: 'Amministrazione',
        publishedAt: '2026-05-03T00:00:00.000Z',
      },
    ];

    const matched = matchJobsForSubscriber(
      {
        job_slug: 'original-nurse-job',
        sourceJob: jobs[0],
      },
      jobs,
      2,
    );

    expect(matched.map((j) => j.slug)).toEqual(['nurse-medicine', 'admin-office']);
  });

  it('getFallbackBriefing returns HTML for all locales', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const html = getFallbackBriefing(locale, SAMPLE_EXCHANGE);
      expect(html).toContain('<p');
      expect(html.length).toBeGreaterThan(20);
    }
  });

  it('FALLBACK_SUBJECT has all locales', () => {
    expect(FALLBACK_SUBJECT.it).toBeDefined();
    expect(FALLBACK_SUBJECT.en).toBeDefined();
    expect(FALLBACK_SUBJECT.de).toBeDefined();
    expect(FALLBACK_SUBJECT.fr).toBeDefined();
  });
});

describe('validateJobUrls resilience', () => {
  const MATCHED = [
    { title: 'Dev', url: '/cerca-lavoro-ticino/dev-acme/', company: 'Acme', location: 'Lugano', contract: 'Tempo pieno' },
    { title: 'PM', url: '/cerca-lavoro-ticino/pm-beta/', company: 'Beta', location: 'Bellinzona', contract: 'Part-time' },
  ];
  const ALL_JOBS = [
    { slug: 'dev-acme', company: 'Acme', title: 'Dev' },
    { slug: 'pm-beta', company: 'Beta', title: 'PM' },
  ];

  it('keeps jobs whose slugs match allJobs', () => {
    const result = validateJobUrls(MATCHED, ALL_JOBS);
    expect(result).toHaveLength(2);
  });

  it('returns all matched jobs when allJobs is empty (resilience fallback)', () => {
    const result = validateJobUrls(MATCHED, []);
    // Should NOT return 0 — resilience: skip validation when slug set is empty
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns all matched jobs when allJobs is null', () => {
    const result = validateJobUrls(MATCHED, null);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty array for empty matchedJobs', () => {
    expect(validateJobUrls([], ALL_JOBS)).toHaveLength(0);
    expect(validateJobUrls(null, ALL_JOBS)).toHaveLength(0);
  });

  it('filters out jobs with unknown slugs', () => {
    const mixed = [
      ...MATCHED,
      { title: 'Ghost', url: '/cerca-lavoro-ticino/ghost-job/', company: 'X', location: 'X', contract: 'X' },
    ];
    const result = validateJobUrls(mixed, ALL_JOBS);
    expect(result).toHaveLength(2);
    expect(result.find((j) => j.title === 'Ghost')).toBeUndefined();
  });
});

describe('popularity decay (anti-evergreen-freeze)', () => {
  const NOW = new Date('2026-06-22T00:00:00.000Z').getTime();
  const daysAgoIso = (n: number) => new Date(NOW - n * 86400000).toISOString();

  it('halves the popularity weight every 30 days of job age', () => {
    expect(decayFactor({ postedDate: daysAgoIso(0) }, NOW)).toBeCloseTo(1, 5);
    expect(decayFactor({ postedDate: daysAgoIso(30) }, NOW)).toBeCloseTo(0.5, 5);
    expect(decayFactor({ postedDate: daysAgoIso(60) }, NOW)).toBeCloseTo(0.25, 5);
    expect(decayFactor({ postedDate: daysAgoIso(90) }, NOW)).toBeCloseTo(0.125, 5);
  });

  it('applies a neutral mid-life factor to jobs with no parseable date', () => {
    expect(decayFactor({}, NOW)).toBe(0.5);
    expect(decayFactor({ postedDate: 'not-a-date' }, NOW)).toBe(0.5);
  });

  it('never exceeds 1 for future-dated jobs (clamped age)', () => {
    expect(decayFactor({ postedDate: daysAgoIso(-10) }, NOW)).toBeLessThanOrEqual(1);
  });

  it('falls through a malformed postedDate to a valid firstSeenAt (date present ≠ usable)', () => {
    // ~0.3% of real jobs carry a present-but-unusable postedDate — e.g. an
    // impossible DD/MM like 30/13 that parseDateField rejects as NaN (a valid
    // DD/MM such as 30/05 now parses per #2630 and is decayed on its own date).
    // The unusable case must not shadow a good firstSeenAt and force the neutral 0.5 branch.
    const job = { postedDate: '30/13/26', firstSeenAt: daysAgoIso(0) };
    expect(decayFactor(job, NOW)).toBeCloseTo(1, 5);
    expect(decayFactor({ postedDate: '30/13/26', firstSeenAt: daysAgoIso(30) }, NOW)).toBeCloseTo(0.5, 5);
  });

  it('a daily re-crawl cannot reset a job\'s age (firstSeenAt beats crawledAt)', () => {
    // crawledAt refreshes on EVERY re-crawl; with it ahead of firstSeenAt in
    // the date-field order, every re-crawled postedDate-less job "aged" ~0 days
    // forever and the anti-evergreen decay never kicked in.
    const evergreen = { firstSeenAt: daysAgoIso(90), crawledAt: daysAgoIso(0) };
    expect(decayFactor(evergreen, NOW)).toBeCloseTo(0.125, 5);
  });

  it('still uses crawledAt as the last-resort date when nothing else parses', () => {
    expect(decayFactor({ crawledAt: daysAgoIso(30) }, NOW)).toBeCloseTo(0.5, 5);
  });
});

describe('no-profile job blend + backfill-slug relevance', () => {
  // No interest profile: the newest jobs must be represented, not just the
  // all-time popular ones — this is what makes the section rotate.
  it('represents the freshest jobs for a no-profile subscriber', () => {
    const jobs = Array.from({ length: 8 }, (_, i) => ({
      title: `Job ${i}`,
      company: `Co ${i}`,
      location: 'Lugano',
      slug: `job-${i}-co-${i}`,
      postedDate: new Date(Date.now() - i * 86400000).toISOString(),
    }));
    const matched = matchJobsForSubscriber({ locationInterest: null, sectorInterest: null }, jobs, 4);
    // job-0 is the newest; with all views=0 the blend orders by recency, so the
    // newest listing must appear.
    expect(matched.map((j) => j.slug)).toContain('job-0-co-0');
    expect(matched).toHaveLength(4);
    // Company diversity preserved.
    const companies = matched.map((j) => j.company);
    expect(new Set(companies).size).toBe(companies.length);
  });

  // A subscriber whose ONLY job signal is the retroactively-recovered
  // job_context_backfill_slug must still get a relevance-ranked match.
  it('ranks a matching job first using job_context_backfill_slug', () => {
    const jobs = [
      { title: 'Sviluppatore software backend', company: 'TechCo', location: 'Lugano', slug: 'sviluppatore-software-techco', category: 'IT', sector: 'IT' },
      { title: 'Infermiere reparto medicina', company: 'Clinica', location: 'Lugano', slug: 'infermiere-medicina-clinica', category: 'Sanita', sector: 'Sanita' },
    ];
    const matched = matchJobsForSubscriber(
      { locationInterest: null, sectorInterest: null, job_context_backfill_slug: 'infermiere-pediatria-ospedale-lugano' },
      jobs,
      2,
    );
    // The nurse job shares keywords with the backfill slug → ranks first.
    expect(matched[0].slug).toBe('infermiere-medicina-clinica');
  });
});

describe('directUrl helper', () => {
  it('produces https://frontaliereticino.ch URLs', () => {
    expect(directUrl('/calcola-stipendio/')).toBe('https://frontaliereticino.ch/calcola-stipendio/');
  });

  it('handles paths without leading slash', () => {
    const url = directUrl('cerca-lavoro-ticino/');
    expect(url).toContain('frontaliereticino.ch');
  });
});

const buildPartnerNewsletter = async (locale: unknown = 'it') => {
  const { buildNewsletter: buildLegacy } = await import('../scripts/newsletter-template.mjs');
  // Niente `matchedJobs`: renderJobSection di questo modulo chiama un `esc()`
  // che non esiste (ReferenceError) — segno che il modulo non viene eseguito
  // da nessun invio. Il blocco partner, che e' cio' che qui si misura, si
  // rende comunque.
  // Nemmeno `featuredTool`: SAMPLE_TOOL viene dal modulo LIVE, che non porta il
  // `buttonText` che renderFeaturedTool di questo modulo stampa — passarlo qui
  // inietta un `undefined` nel corpo che non ha nulla a che vedere col
  // template. Senza, il modulo sceglie da solo il tool da FEATURED_TOOLS_I18N,
  // che e' anche uno dei lookup per-locale che i test qui sotto misurano.
  return buildLegacy({
    aiBriefing: '<p>Test.</p>',
    exchangeRate: SAMPLE_EXCHANGE,
    weeklyFact: SAMPLE_FACT,
    locale,
    unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=test@example.com',
    resubscribeUrl: 'https://frontaliereticino.ch/?action=resubscribe&email=test@example.com',
  });
};

// Le tre righe partner puntano tutte a `/go/{id}/` con gli stessi utm: senza un
// parametro di posizione non si sa quale slot converte (#7527).
describe('affiliate partner rows carry their position', () => {
  const goHrefs = (html: string) =>
    [...html.matchAll(/href="(https:\/\/frontaliereticino\.ch\/go\/[^"]+)"/g)].map((m) => m[1]);

  it('gives each /go/ row a distinct pos parameter', async () => {
    const hrefs = goHrefs(await buildPartnerNewsletter());
    expect(hrefs).toHaveLength(3);
    const positions = hrefs.map((h) => new URL(h).searchParams.get('pos'));
    expect(positions.every(Boolean)).toBe(true);
    expect(new Set(positions).size).toBe(3);
  });

  it('encodes slot index + partner id, and keeps the utm params intact', async () => {
    const hrefs = goHrefs(await buildPartnerNewsletter());
    const positions = hrefs.map((h) => new URL(h).searchParams.get('pos'));
    expect(positions).toEqual(['nl-partner-1-wise', 'nl-partner-2-fineco', 'nl-partner-3-creditagricole']);
    for (const href of hrefs) {
      const params = new URL(href).searchParams;
      expect(params.get('utm_source')).toBe('newsletter');
      expect(params.get('utm_medium')).toBe('email');
      expect(params.get('utm_campaign')).toMatch(/^weekly_\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// Il fallback per-locale della riga partner (`p.desc[locale] || p.desc.it`)
// esisteva senza osservatore: toglierlo non faceva fallire nulla, e la
// copertura dei `desc` non era misurata da nessun gate (#7528). Due difetti
// distinti, quindi due osservatori distinti:
//   - il RAMO di fallback si misura solo chiamando renderAffiliatePartners
//     direttamente, perche' buildNewsletter passa da nlNormLocale e non gli
//     consegna mai un locale fuori da it|en|de|fr (verificato: togliere
//     `|| p.desc.it` lascia verde ogni test che passa da buildNewsletter);
//   - la COPERTURA dei `desc` si misura dal corpo email renderizzato, dove un
//     buco di traduzione stampa la stringa `undefined` all'iscritto.
describe('newsletter partner rows survive an unknown locale', () => {
  // Una descrizione per partner e per locale, nell'ordine di
  // AFFILIATE_PARTNERS_NL (wise, fineco, creditagricole).
  const PARTNER_DESC: Record<string, string[]> = {
    it: ['Tasso di cambio reale, commissioni trasparenti', 'Codice AA8381747 — bonus 50€', 'Buono Amazon 50€ con invito'],
    en: ['Real exchange rate, transparent fees', 'Code AA8381747 — €50 bonus', '€50 Amazon voucher with invite'],
    de: ['Echter Wechselkurs, transparente Gebühren', 'Code AA8381747 — 50€ Bonus', '50€ Amazon-Gutschein mit Einladung'],
    fr: ['Taux de change réel, frais transparents', 'Code AA8381747 — bonus 50€', 'Bon Amazon 50€ avec invitation'],
  };

  const UNKNOWN_LOCALES: unknown[] = ['es', 'es-ES', 'zh-CN', 'pt_BR', '', undefined, null];

  // L'unico test che fallisce se `|| p.desc.it` sparisce: il renderer riceve
  // qui il locale grezzo, non quello gia' normalizzato da buildNewsletter.
  it('renderAffiliatePartners falls back to Italian on a raw unknown locale', async () => {
    const { renderAffiliatePartners } = await import('../scripts/newsletter-template.mjs');
    for (const locale of UNKNOWN_LOCALES) {
      const rows = renderAffiliatePartners({ campaign: 'weekly_2026-01-01', locale });
      for (const desc of PARTNER_DESC.it) {
        expect(rows, `locale=${String(locale)}`).toContain(desc);
      }
      expect(rows, `locale=${String(locale)}`).not.toContain('undefined');
    }
  });

  it('falls back to the Italian description outside it|en|de|fr', async () => {
    for (const locale of UNKNOWN_LOCALES) {
      const html = await buildPartnerNewsletter(locale);
      for (const desc of PARTNER_DESC.it) {
        expect(html, `locale=${String(locale)}`).toContain(desc);
      }
    }
  });

  it('renders the translated partner row for every supported locale', async () => {
    for (const [locale, descs] of Object.entries(PARTNER_DESC)) {
      const html = await buildPartnerNewsletter(locale);
      for (const desc of descs) {
        expect(html, `locale=${locale}`).toContain(desc);
      }
    }
  });

  // L'assert vale sull'INTERO corpo, non solo sulla riga partner: copre in un
  // colpo anche gli altri lookup per-locale del template (JOB_CTA,
  // FEATURED_TOOLS_I18N, NL_TRANSLATIONS), tutti con fallback e tutti scoperti.
  it('never prints the literal "undefined" in the email body', async () => {
    for (const locale of [...Object.keys(PARTNER_DESC), ...UNKNOWN_LOCALES]) {
      const html = await buildPartnerNewsletter(locale);
      expect(html, `locale=${String(locale)}`).not.toContain('undefined');
    }
  });

  // Canary di copertura: la tabella qui sopra deve elencare esattamente i
  // locali che `nlNormLocale` sa produrre. Aggiungerne un quinto senza
  // tradurre le righe partner le farebbe cadere sull'italiano in silenzio —
  // il fallback maschera il buco, questo test no.
  it('has partner copy for every locale nlNormLocale can produce', async () => {
    const { nlNormLocale } = await import('../scripts/newsletter-template.mjs');
    const produced = new Set(
      ['it', 'en', 'de', 'fr', 'es', 'pt', 'zh', 'it-CH', 'en_GB', 'DE', '', undefined, null]
        .map((raw) => nlNormLocale(raw)),
    );
    expect([...produced].sort()).toEqual(Object.keys(PARTNER_DESC).sort());
  });
});

// Stessa classe, template LIVE: `services/newsletter-template.mjs` ha i suoi
// lookup per-locale (`nlT`, DATE_LOCALE, monthNames) e i test esistenti
// (newsletter-locale-leakage) li esercitano solo sui quattro locali
// supportati. Un iscritto con `locale` fuori da quell'insieme — o nullo, che
// in DB capita — deve ricevere l'italiano, mai la stringa `undefined`.
describe('live newsletter template survives an unknown locale', () => {
  const buildLive = (locale: unknown) => buildNewsletter({
    aiBriefing: '<p>Test.</p>',
    exchangeRate: SAMPLE_EXCHANGE,
    matchedJobs: SAMPLE_JOBS,
    featuredTool: SAMPLE_TOOL,
    weeklyFact: SAMPLE_FACT,
    locale,
    unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=test@example.com',
    resubscribeUrl: 'https://frontaliereticino.ch/?action=resubscribe&email=test@example.com',
  });

  it('never prints the literal "undefined", in any locale', () => {
    for (const locale of ['it', 'en', 'de', 'fr', 'es', 'es-ES', 'zh-CN', 'pt_BR', '', undefined, null]) {
      expect(buildLive(locale), `locale=${String(locale)}`).not.toContain('undefined');
    }
  });

  it('falls back to the Italian copy outside it|en|de|fr', () => {
    for (const locale of ['es', 'es-ES', 'zh-CN', 'pt_BR', '', undefined, null]) {
      const html = buildLive(locale);
      expect(html, `locale=${String(locale)}`).toContain('lang="it"');
    }
  });
});
