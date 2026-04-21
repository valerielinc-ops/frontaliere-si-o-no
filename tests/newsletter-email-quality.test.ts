import { describe, expect, it } from 'vitest';

const {
  buildNewsletter,
  localizedUrl,
  truncateAtWordBoundary,
} = await import('@/services/newsletter-template.mjs');

const {
  companyPageUrl,
  buildSubjectPrompt,
  buildBriefingPrompt,
  loadDashboardMetrics,
} = await import('@/services/newsletter-content.mjs');

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

// ── Bug 3: locale-aware URL builder ────────────────────────────
describe('localizedUrl', () => {
  it('returns canonical IT URL for locale=it', () => {
    expect(localizedUrl('/cerca-lavoro-ticino', 'it')).toBe(
      'https://frontaliereticino.ch/cerca-lavoro-ticino',
    );
  });

  it.each([
    ['en', '/en/find-jobs-ticino'],
    ['de', '/de/jobs-im-tessin'],
    ['fr', '/fr/trouver-emploi-tessin'],
  ])('/cerca-lavoro-ticino for %s → %s', (loc, expected) => {
    expect(localizedUrl('/cerca-lavoro-ticino', loc)).toBe(
      `https://frontaliereticino.ch${expected}`,
    );
  });

  it.each([
    ['en', '/en/service-comparison/chf-eur-exchange-rate'],
    ['de', '/de/service-vergleich/chf-eur-wechselkurs'],
    ['fr', '/fr/comparaison-services/taux-change-chf-eur'],
  ])('/compara-servizi/cambio-franco-euro for %s', (loc, expected) => {
    expect(localizedUrl('/compara-servizi/cambio-franco-euro', loc)).toBe(
      `https://frontaliereticino.ch${expected}`,
    );
  });

  it('falls back to canonical IT path for unknown paths', () => {
    expect(localizedUrl('/some-unmapped-path', 'en')).toBe(
      'https://frontaliereticino.ch/some-unmapped-path',
    );
  });
});

describe('companyPageUrl', () => {
  it.each([
    ['it', '/cerca-lavoro-ticino/azienda-acme'],
    ['en', '/en/find-jobs-ticino/azienda-acme'],
    ['de', '/de/jobs-im-tessin/azienda-acme'],
    ['fr', '/fr/trouver-emploi-tessin/azienda-acme'],
  ])('builds locale-aware URL for %s', (loc, expected) => {
    expect(companyPageUrl('acme', loc)).toBe(
      `https://frontaliereticino.ch${expected}`,
    );
  });

  it('returns empty string when slug is missing', () => {
    expect(companyPageUrl('', 'it')).toBe('');
    expect(companyPageUrl(null as unknown as string, 'en')).toBe('');
  });
});

// ── Bug 3 integration: non-IT newsletter has no IT-only URLs ─
describe('buildNewsletter links are localized', () => {
  const baseArgs = {
    exchangeRate: { rate: 0.9420, previousRate: 0.9500 },
    matchedJobs: [],
    totalJobs: 42,
    metrics: loadDashboardMetrics(),
    issueNumber: 10,
    unsubscribeUrl: 'https://frontaliereticino.ch/u/x',
  };

  for (const loc of ['en', 'de', 'fr'] as const) {
    it(`${loc} email uses localized paths only`, () => {
      const html = buildNewsletter({ ...baseArgs, locale: loc });
      // IT canonical paths must NOT appear in non-IT emails
      expect(html).not.toContain('/compara-servizi/cambio-franco-euro');
      expect(html).not.toContain('/compara-servizi/confronta-casse-malati');
      expect(html).not.toMatch(/href="[^"]*\/cerca-lavoro-ticino[^"]*"/);
      expect(html).not.toMatch(/href="[^"]*\/statistiche[^"]*"/);
      expect(html).not.toMatch(/href="[^"]*\/tasse-e-pensione[^"]*"/);
      expect(html).not.toMatch(/href="[^"]*\/calcola-stipendio[^"]*"/);
    });
  }

  it('IT email still uses canonical IT paths', () => {
    const html = buildNewsletter({ ...baseArgs, locale: 'it' });
    expect(html).toContain('/compara-servizi/cambio-franco-euro');
    expect(html).toContain('/cerca-lavoro-ticino');
  });
});

// ── Bug 4: metric labels are localized per recipient ──────────
describe('metric labels are locale-aware', () => {
  it('loadDashboardMetrics returns no hardcoded label fields', () => {
    const metrics = loadDashboardMetrics();
    expect(metrics.unemploymentLabel).toBeUndefined();
    expect(metrics.lamalLabel).toBeUndefined();
    expect(metrics.unemploymentRate).toBeDefined();
    expect(metrics.lamalPremium).toBeDefined();
  });

  it('EN newsletter does not contain Italian metric labels', () => {
    const html = buildNewsletter({
      locale: 'en',
      exchangeRate: { rate: 0.94, previousRate: 0.95 },
      metrics: loadDashboardMetrics(),
      totalJobs: 1,
    });
    expect(html).not.toContain('Disoccupazione CH');
    expect(html).not.toContain('Premio LAMal Lugano');
    expect(html).toContain('Unemployment CH');
    expect(html).toContain('LAMal premium Lugano');
  });
});

// ── Bug 1: markdown sanitization in AI briefing ──────────────
describe('send-newsletter.mjs sanitizeAIBriefingHtml', () => {
  it('contains a markdown-to-HTML conversion for **bold**', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'scripts', 'send-newsletter.mjs'),
      'utf-8',
    );
    expect(src).toMatch(/\\\*\\\*.*<strong>/);
  });

  it('contains a markdown-to-HTML conversion for *italic*', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'scripts', 'send-newsletter.mjs'),
      'utf-8',
    );
    expect(src).toMatch(/<em>/);
  });
});

describe('buildBriefingPrompt forbids markdown', () => {
  it('system prompt contains an explicit anti-markdown rule', () => {
    const { system } = buildBriefingPrompt({
      subscriber: { locale: 'en' },
      exchangeRate: { rate: 0.94, previousRate: 0.95 },
      exchangeInsight: null,
      matchedJobs: [],
      weeklyFact: null,
      featuredTool: null,
    });
    expect(system).toMatch(/NEVER use Markdown|No Markdown|do not use \*\*/i);
    expect(system).toMatch(/\*\*bold\*\*/);
  });
});

// ── Bug 2: subject prompt enforces locale with in-language examples ─
describe('buildSubjectPrompt enforces target locale', () => {
  for (const loc of LOCALES) {
    it(`${loc} system prompt pins language and provides ${loc} examples`, () => {
      const { system } = buildSubjectPrompt({
        subscriber: { locale: loc },
        exchangeRate: { rate: 0.94, previousRate: 0.95 },
        matchedJobs: [],
        briefingSummary: '',
      });
      expect(system).toMatch(/ABSOLUTE LANGUAGE RULE/);
      // Each locale's examples must use a language-specific phrase
      const phraseByLocale: Record<string, RegExp> = {
        it: /Il tasso CHF|aziende assumono/,
        en: /CHF rate is dropping|companies hiring/,
        de: /CHF-Kurs|Firmen stellen/,
        fr: /Le taux CHF|entreprises recrutent/,
      };
      expect(system).toMatch(phraseByLocale[loc]);
    });
  }
});

// ── Bug 5: word-boundary truncation ───────────────────────────
describe('truncateAtWordBoundary', () => {
  it('returns input unchanged when short enough', () => {
    expect(truncateAtWordBoundary('Short title', 55)).toBe('Short title');
  });

  it('never appends an ellipsis', () => {
    const long = 'Very long job title that definitely needs truncation to fit';
    const result = truncateAtWordBoundary(long, 30);
    expect(result.endsWith('…')).toBe(false);
    expect(result.endsWith('...')).toBe(false);
  });

  it('cuts at word boundary when one exists deep enough', () => {
    const result = truncateAtWordBoundary('Senior Software Engineer Frontend Developer Ticino', 30);
    expect(result.length).toBeLessThanOrEqual(30);
    // Should not cut in the middle of a word — result's last char is a letter/digit
    expect(result).toMatch(/[\p{L}\p{N}]$/u);
  });

  it('handles empty / null input safely', () => {
    expect(truncateAtWordBoundary('', 10)).toBe('');
    expect(truncateAtWordBoundary(null as unknown as string, 10)).toBe('');
    expect(truncateAtWordBoundary(undefined as unknown as string, 10)).toBe('');
  });
});

describe('renderJobs uses word-boundary truncation (no ellipsis)', () => {
  it('long job titles never contain a trailing ellipsis in rendered HTML', () => {
    const html = buildNewsletter({
      locale: 'en',
      exchangeRate: { rate: 0.94, previousRate: 0.95 },
      metrics: loadDashboardMetrics(),
      matchedJobs: [
        {
          title: 'Senior Full-Stack Software Engineer with Machine Learning Focus',
          url: '/en/find-jobs-ticino/senior-swe',
          company: 'Acme Corp',
          location: 'Lugano',
          contract: 'Full-time',
        },
      ],
      totalJobs: 1,
    });
    // The job title is truncated, but the rendered job card must not carry "…"
    // directly after the truncated title text.
    const titleBlocks = html.match(/class="job-title"[^>]*>([^<]+)</g) || [];
    expect(titleBlocks.length).toBeGreaterThan(0);
    for (const block of titleBlocks) {
      expect(block).not.toContain('…');
      expect(block).not.toContain('...');
    }
  });
});
