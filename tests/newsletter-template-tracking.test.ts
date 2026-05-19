import { describe, expect, it } from 'vitest';

const { buildNewsletter, FEATURED_TOOLS, directUrl } = await import('@/services/newsletter-template.mjs');
const { matchJobsForSubscriber, validateJobUrls, getFallbackBriefing, FALLBACK_SUBJECT } = await import('@/services/newsletter-content.mjs');

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

describe('directUrl helper', () => {
  it('produces https://frontaliereticino.ch URLs', () => {
    expect(directUrl('/calcola-stipendio/')).toBe('https://frontaliereticino.ch/calcola-stipendio/');
  });

  it('handles paths without leading slash', () => {
    const url = directUrl('cerca-lavoro-ticino/');
    expect(url).toContain('frontaliereticino.ch');
  });
});
