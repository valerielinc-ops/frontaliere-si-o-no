/**
 * News Sitemap Whitelist (C1) tests.
 *
 * Verifies the topic whitelist + 48h freshness window correctly filter the
 * `dist/sitemap-news.xml` candidate set down to the 5 + 1 macro-themes that
 * Google News rewards.
 */
import { describe, expect, it } from 'vitest';
import {
  NEWS_SITEMAP_WHITELIST,
  NEWS_SITEMAP_WINDOW_HOURS,
  isArticleNewsEligible,
  matchedWhitelistTokens,
  type NewsEligibilityArticle,
} from '@/data/news-sitemap-whitelist';

const NOW = Date.UTC(2026, 4, 1, 12, 0, 0); // 2026-05-01T12:00:00Z (deterministic clock)
const HOUR_AGO = new Date(NOW - 3_600_000).toISOString();
const TWO_HOURS_AGO = new Date(NOW - 2 * 3_600_000).toISOString();
const THREE_DAYS_AGO = new Date(NOW - 3 * 24 * 3_600_000).toISOString();

describe('NEWS_SITEMAP_WHITELIST', () => {
  it('contains all 6 macro-theme keyword groups', () => {
    // 1. Fisco / tasse / dichiarazione / nuovo accordo 2026
    expect(NEWS_SITEMAP_WHITELIST).toEqual(expect.arrayContaining([
      'fisco', 'tasse', '730', 'dichiarazione', 'nuovo-accordo-2026',
      'imposta-fonte', 'valore-locativo', 'perequazione',
    ]));

    // 2. AVS / LPP / pensione / previdenza
    expect(NEWS_SITEMAP_WHITELIST).toEqual(expect.arrayContaining([
      'avs', 'lpp', 'pensione', 'previdenza',
    ]));

    // 3. LAMal / cassa malati / tassa salute
    expect(NEWS_SITEMAP_WHITELIST).toEqual(expect.arrayContaining([
      'lamal', 'assicurazione-malattia', 'cassa-malati', 'tassa-salute',
    ]));

    // 4. Dogana / frontiera / permit / lavoro frontaliere / salari
    expect(NEWS_SITEMAP_WHITELIST).toEqual(expect.arrayContaining([
      'dogana', 'frontiera', 'varco', 'permit-g', 'permit-b',
      'lavoro-frontaliere', 'salari', 'stipendi', 'contratto', 'dumping-salariale',
    ]));

    // 5. Cambio valuta / CHF-EUR / bonifico / tasso
    expect(NEWS_SITEMAP_WHITELIST).toEqual(expect.arrayContaining([
      'cambio-valuta', 'chf-eur', 'bonifico', 'tasso',
    ]));

    // 6. Trasporti frontaliere / treno / traffico / webcam / autisti-bus.
    // NOTE: standalone "auto" was deliberately omitted — it matches "automatic",
    // "autorita", etc. in slugs and would defeat the filter. Compound transport
    // tokens (a2-melide, a2-chiasso, autostrada-a2, autisti-bus) cover the
    // frontaliere car/road context.
    expect(NEWS_SITEMAP_WHITELIST).toEqual(expect.arrayContaining([
      'trasporti-frontaliere', 'treno', 'traffico', 'webcam-dogana', 'autisti-bus',
    ]));
  });

  it('uses lowercase tokens only (case-insensitive substring match invariant)', () => {
    for (const token of NEWS_SITEMAP_WHITELIST) {
      expect(token).toBe(token.toLowerCase());
    }
  });

  it('window is 48 hours per Google News spec', () => {
    expect(NEWS_SITEMAP_WINDOW_HOURS).toBe(48);
  });
});

describe('isArticleNewsEligible — frontaliere topics (must keep)', () => {
  it('keeps a fisco/tasse article published 1h ago', () => {
    const article: NewsEligibilityArticle = {
      slug: 'nuovo-accordo-fiscale-frontalieri-2026',
      title: 'Nuovo accordo fiscale 2026: cosa cambia per i frontalieri',
      articleSection: 'Fiscale',
      keywords: 'imposta alla fonte, accordo fiscale, frontalieri',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
    expect(matchedWhitelistTokens(article).length).toBeGreaterThan(0);
  });

  it('keeps an AVS/LPP pension article', () => {
    const article: NewsEligibilityArticle = {
      slug: 'avs-aumento-2026',
      title: 'AVS: aumento dei contributi previsto per il 2026',
      keywords: 'avs, lpp, previdenza',
      publishedAt: TWO_HOURS_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
  });

  it('keeps a LAMal article', () => {
    const article: NewsEligibilityArticle = {
      slug: 'lamal-premi-2026-ticino',
      title: 'LAMal 2026: i nuovi premi cassa malati in Ticino',
      articleSection: 'Pratico',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
  });

  it('keeps a dogana / permit-g lavoro article', () => {
    const article: NewsEligibilityArticle = {
      slug: 'dogana-chiasso-tempi-attesa',
      title: 'Dogana di Chiasso: i tempi di attesa al varco di Brogeda',
      keywords: 'dogana, frontiera, varco, permit g, lavoro frontaliere',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
  });

  it('keeps a CHF-EUR / cambio valuta article', () => {
    const article: NewsEligibilityArticle = {
      slug: 'franco-svizzero-stipendi-frontalieri',
      title: 'Franco svizzero forte: cosa significa per gli stipendi',
      keywords: 'cambio valuta, chf-eur, bonifico',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
  });

  it('keeps a trasporti / A2 / traffico article', () => {
    const article: NewsEligibilityArticle = {
      slug: 'a2-melide-chiusure-notturne-lavori',
      title: 'A2 Melide: chiusure notturne per lavori alla pavimentazione',
      keywords: 'traffico, a2, trasporti',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
  });

  it('matches via slug substring even when title is generic', () => {
    const article: NewsEligibilityArticle = {
      slug: 'tassa-salute-tensioni-ticino',
      title: 'Cresce il malcontento al confine',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
  });
});

describe('isArticleNewsEligible — off-topic (must drop)', () => {
  it('drops a sport article', () => {
    const article: NewsEligibilityArticle = {
      slug: 'hockey-ambri-piotta-vittoria-coppa',
      title: 'Hockey: Ambrì-Piotta vince in Coppa Svizzera',
      articleSection: 'Sport',
      keywords: 'hockey, sport, coppa svizzera',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(false);
  });

  it('drops a cultura / mostra arte article', () => {
    const article: NewsEligibilityArticle = {
      slug: 'rauschenberg-arte-mendrisiotto',
      title: 'Mostra Rauschenberg al Mendrisiotto',
      articleSection: 'Cultura',
      keywords: 'arte, mostra, cultura, museo',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(false);
  });

  it('drops a carnevale / festival article', () => {
    const article: NewsEligibilityArticle = {
      slug: 'carnevale-blenio-chiescia-bosc',
      title: 'Carnevale di Blenio: la Chiescia del Bosc',
      articleSection: 'Cultura',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(false);
  });

  it('drops a stale (>48h) frontaliere article even if topic matches', () => {
    const article: NewsEligibilityArticle = {
      slug: 'fisco-vecchio-articolo',
      title: 'Articolo vecchio sul fisco frontaliere',
      keywords: 'fisco, frontaliere, lamal',
      publishedAt: THREE_DAYS_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(false);
  });

  it('drops articles with malformed publication dates (fail closed)', () => {
    const article: NewsEligibilityArticle = {
      slug: 'fisco-frontaliere-malformed',
      title: 'AVS LAMal',
      publishedAt: 'not-a-real-date',
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(false);
  });

  it('drops future-dated articles', () => {
    const article: NewsEligibilityArticle = {
      slug: 'lamal-frontaliere-future',
      title: 'LAMal 2027',
      publishedAt: new Date(NOW + 24 * 3_600_000).toISOString(),
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(false);
  });

  it('drops articles with no whitelist match across any field', () => {
    const article: NewsEligibilityArticle = {
      slug: 'rsi-mostra-storia-ticino',
      title: 'RSI: una mostra sulla storia della Svizzera italiana',
      articleSection: 'Cultura',
      keywords: 'rsi, mostra, storia, museo',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(false);
  });
});

describe('isArticleNewsEligible — boundary conditions', () => {
  it('keeps an article exactly at the 48h boundary (inclusive)', () => {
    const article: NewsEligibilityArticle = {
      slug: 'fisco-frontaliere-boundary',
      title: 'Fisco frontaliere',
      publishedAt: new Date(NOW - 48 * 3_600_000).toISOString(),
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
  });

  it('drops an article 48h + 1ms past the boundary', () => {
    const article: NewsEligibilityArticle = {
      slug: 'fisco-frontaliere-just-stale',
      title: 'Fisco frontaliere',
      publishedAt: new Date(NOW - 48 * 3_600_000 - 1).toISOString(),
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(false);
  });

  it('matches via tags array', () => {
    const article: NewsEligibilityArticle = {
      slug: 'qualcosa-altro',
      title: 'Articolo generico',
      tags: ['lpp', 'previdenza-svizzera'],
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
  });

  it('case-insensitive on title (LAMAL matches lamal token)', () => {
    const article: NewsEligibilityArticle = {
      slug: 'health-insurance-news',
      title: 'LAMAL premiums rise in 2026',
      publishedAt: HOUR_AGO,
    };
    expect(isArticleNewsEligible(article, NOW)).toBe(true);
  });
});
