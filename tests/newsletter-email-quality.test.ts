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
  // The company-hub URL prefix is localized (mirrors the build plugin's
  // companyRoutePrefix): azienda-/company-/unternehmen-/entreprise-. A hardcoded
  // IT `azienda-` on a non-IT board path 404s (the real page uses the locale
  // prefix). Canonical form has a trailing slash.
  it.each([
    ['it', '/cerca-lavoro-ticino/azienda-acme/'],
    ['en', '/en/find-jobs-ticino/company-acme/'],
    ['de', '/de/jobs-im-tessin/unternehmen-acme/'],
    ['fr', '/fr/trouver-emploi-tessin/entreprise-acme/'],
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

  const LOCALIZED_AGGREGATE_PATH = {
    en: '/en/find-jobs-switzerland',
    de: '/de/jobs-in-schweiz',
    fr: '/fr/trouver-emploi-suisse',
  };

  for (const loc of ['en', 'de', 'fr'] as const) {
    it(`${loc} email uses localized paths only`, () => {
      const html = buildNewsletter({ ...baseArgs, locale: loc });
      // IT canonical paths must NOT appear in non-IT emails
      expect(html).not.toContain('/compara-servizi/cambio-franco-euro');
      expect(html).not.toContain('/compara-servizi/confronta-casse-malati');
      expect(html).not.toMatch(/href="[^"]*\/cerca-lavoro-ticino[^"]*"/);
      expect(html).not.toMatch(/href="[^"]*\/cerca-lavoro-svizzera[^"]*"/);
      expect(html).not.toMatch(/href="[^"]*\/statistiche[^"]*"/);
      expect(html).not.toMatch(/href="[^"]*\/tasse-e-pensione[^"]*"/);
      expect(html).not.toMatch(/href="[^"]*\/calcola-stipendio[^"]*"/);
      // The "browse all jobs" CTA still resolves, localized, to the
      // Switzerland-wide aggregate board.
      expect(html).toContain(LOCALIZED_AGGREGATE_PATH[loc]);
    });
  }

  it('IT email still uses canonical IT paths', () => {
    const html = buildNewsletter({ ...baseArgs, locale: 'it' });
    expect(html).toContain('/compara-servizi/cambio-franco-euro');
    // The "browse all jobs" metric/CTA has no per-subscriber canton context
    // (totalJobs counts every canton), so it resolves to the Switzerland-wide
    // aggregate board, not the TI-only one.
    expect(html).toContain('/cerca-lavoro-svizzera');
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

// ── Wise: nessuna promessa di bonus nel corpo email (issue #7529) ──────
//
// `/go/wise/` e' un deeplink affiliato Partnerize che atterra su wise.com
// SENZA offerta per l'utente (services/affiliateService.ts). La promessa
// «carta gratuita / zero commissioni fino a CHF 600» valeva solo per il
// vecchio invito personale ed e' stata tolta da #7288 — ma solo per
// convenzione: nessun gate impediva di riscriverla. Questi test SONO il gate.
//
// Scope deliberato: la riga/blocco che linka Wise. Fineco (`bonus 50€`) e
// Crédit Agricole (`buono Amazon 50€`) hanno un'offerta VERA e devono restare,
// quindi il detector non gira mai sul loro copy.
// Il detector gira sul TESTO visibile, non sul markup: attributi, utm e
// classi non sono copy e non devono ne' accendere ne' spegnere il gate.
function stripHtmlTags(html: string): string {
  return String(html).replace(/<[^>]*>/g, ' ');
}

const WISE_BONUS_PROMISE_RE = new RegExp(
  [
    'bonus',
    'cashback',
    'carta gratuita',
    'carte gratuite',
    'free card',
    'kostenlose karte',
    'zero commissioni',
    'senza commissioni',
    'no fees',
    'free transfers?',
    'keine geb(?:ü|ue)hren',
    'sans frais',
    'CHF\\s?600',
    '600\\s?CHF',
    'buono',
    'voucher',
    'gutschein',
    'omaggio',
    'referral',
    'codice invito',
    'invite code',
  ].join('|'),
  'i',
);

describe('Wise: nessuna promessa di bonus (issue #7529)', () => {
  // Il detector deve accendersi sul testo davvero rimosso: senza questo
  // controllo una regex che non matcha nulla renderebbe verdi tutti gli altri.
  it('il detector riconosce la promessa rimossa da #7288', () => {
    for (const removed of [
      'Carta gratuita e zero commissioni fino a CHF 600',
      'Free card and zero fees up to CHF 600',
      'Bonus di benvenuto Wise',
    ]) {
      expect(WISE_BONUS_PROMISE_RE.test(removed)).toBe(true);
    }
  });

  it('il copy email del partner Wise non promette un bonus in nessun locale', async () => {
    const { NEWSLETTER_AFFILIATE_ENTRIES } = await import('@/services/newsletter/recommendedBlock.mjs');
    const wise = NEWSLETTER_AFFILIATE_ENTRIES.find((e: { goId: string }) => e.goId === 'wise');
    expect(wise).toBeDefined();
    for (const loc of LOCALES) {
      const copy = wise.copy[loc];
      expect(copy, `copy ${loc} mancante`).toBeDefined();
      for (const field of ['title', 'body', 'cta'] as const) {
        expect(
          WISE_BONUS_PROMISE_RE.test(copy[field]),
          `wise.copy.${loc}.${field} promette un bonus: ${copy[field]}`,
        ).toBe(false);
      }
    }
  });

  it('il blocco raccomandato renderizzato non promette un bonus quando linka Wise', async (ctx) => {
    const { renderRecommendedBlock, NEWSLETTER_SPONSORS, NEWSLETTER_AFFILIATE_ENTRIES } = await import(
      '@/services/newsletter/recommendedBlock.mjs'
    );
    const { getEnabledPartner } = await import('../functions/src/lib/affiliatePartnersRegistry.js');

    // `pickNewsletterRecommendation()` sceglie UNA raccomandazione per invio:
    // uno sponsor pagato attivo vince su ogni affiliato, e fra gli affiliati
    // vincono interest-match + `priority` del registry. Contare i render che
    // "capitano" di essere Wise legherebbe questo gate a decisioni di revenue:
    // attivare uno sponsor — o alzare la priority di un altro partner — non
    // riscrive il copy Wise ma spegnerebbe tests.yml su ogni PR.
    // Forziamo quindi la selezione (nessuno sponsor, sola entry Wise in gara) e
    // ripristiniamo subito: cosi' il render sotto e' sempre quello di Wise e
    // l'invariante non e' mai vacua.
    const wise = NEWSLETTER_AFFILIATE_ENTRIES.find((e: { goId: string }) => e.goId === 'wise');
    expect(wise, 'entry Wise assente da NEWSLETTER_AFFILIATE_ENTRIES').toBeDefined();
    // Unica dipendenza legittima: se il partner e' disabilitato nel registry
    // non finisce in nessuna email e l'invariante non ha superficie da coprire.
    if (!getEnabledPartner('wise')) ctx.skip();

    const sponsors = NEWSLETTER_SPONSORS.splice(0, NEWSLETTER_SPONSORS.length);
    const entries = NEWSLETTER_AFFILIATE_ENTRIES.splice(0, NEWSLETTER_AFFILIATE_ENTRIES.length);
    NEWSLETTER_AFFILIATE_ENTRIES.push(wise);
    try {
      for (const loc of LOCALES) {
        for (const interest of [undefined, 'general', 'utility', 'jobs', 'articles']) {
          const html = renderRecommendedBlock({ locale: loc, interest });
          expect(html, `blocco Wise (${loc}/${interest}) non renderizzato`).toContain('/go/wise/');
          expect(
            WISE_BONUS_PROMISE_RE.test(stripHtmlTags(html)),
            `blocco Wise (${loc}/${interest}) promette un bonus`,
          ).toBe(false);
        }
      }
    } finally {
      NEWSLETTER_SPONSORS.push(...sponsors);
      NEWSLETTER_AFFILIATE_ENTRIES.splice(0, NEWSLETTER_AFFILIATE_ENTRIES.length, ...entries);
    }
  });

  it('la riga Wise del blocco partner non promette un bonus, quelle Fineco/CA restano', async () => {
    // Template legacy: non e' quello che spedisce (services/newsletter-template.mjs
    // e' il live, vedi scripts/send-newsletter.mjs), ma e' il file che #7288 ha
    // ripulito ed e' ancora importabile — l'invariante vale anche qui.
    const { buildNewsletter: buildLegacy } = await import('../scripts/newsletter-template.mjs');
    for (const loc of LOCALES) {
      const html = buildLegacy({
        locale: loc,
        exchangeRate: { rate: 0.942, previousRate: 0.95 },
        metrics: loadDashboardMetrics(),
        matchedJobs: [],
        totalJobs: 42,
        issueNumber: 10,
        unsubscribeUrl: 'https://frontaliereticino.ch/u/x',
      });
      const rows = html.split('<tr>');
      const wiseRow = rows.find((r: string) => r.includes('/go/wise/'));
      expect(wiseRow, `riga Wise assente nel locale ${loc}`).toBeDefined();
      expect(
        WISE_BONUS_PROMISE_RE.test(stripHtmlTags(wiseRow as string)),
        `riga Wise (${loc}) promette un bonus`,
      ).toBe(false);
      // Contro-prova: i partner con un'offerta reale non vengono ripuliti. Sul
      // TESTO visibile, non sul markup grezzo: un qualunque `50` in un padding
      // o in un colore terrebbe verde la riga Crédit Agricole anche senza
      // «Buono Amazon 50€» — cioe' proprio la sweep-troppo-larga che questa
      // asserzione deve intercettare.
      const finecoRow = rows.find((r: string) => r.includes('/go/fineco/'));
      const caRow = rows.find((r: string) => r.includes('/go/creditagricole/'));
      expect(finecoRow, `riga Fineco assente nel locale ${loc}`).toBeDefined();
      expect(caRow, `riga Credit Agricole assente nel locale ${loc}`).toBeDefined();
      expect(stripHtmlTags(finecoRow as string)).toMatch(/bonus/i);
      expect(stripHtmlTags(caRow as string)).toMatch(/buono|voucher|gutschein|bon\b/i);
      expect(stripHtmlTags(caRow as string)).toMatch(/50\s?€|€\s?50/);
    }
  });

  it('nessuna chiave feature_wise_referral_bonus riesumata nei locali comparatori', async () => {
    for (const loc of LOCALES) {
      const mod = await import(`@/services/locales/${loc}-comparatori.ts`);
      const t: Record<string, string> = mod.default;
      expect(
        Object.keys(t).filter((k) => /wise.*(referral|bonus)|bonus.*wise/i.test(k)),
        `chiave bonus Wise riesumata in ${loc}-comparatori.ts`,
      ).toEqual([]);
      // Le due stringhe che alimentano il partner Wise (registry + email).
      for (const key of ['affiliate.wise.tagline', 'affiliate.wise.description']) {
        expect(
          WISE_BONUS_PROMISE_RE.test(t[key] || ''),
          `${key} (${loc}) promette un bonus: ${t[key]}`,
        ).toBe(false);
      }
    }
  });
});
