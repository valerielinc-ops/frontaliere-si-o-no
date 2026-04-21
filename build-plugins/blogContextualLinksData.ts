/**
 * Keyword→Feature URL mapping for blog contextual link injection (A6).
 *
 * The `blogContextualLinksPlugin` scans every generated blog article HTML file
 * in `dist/` and replaces the first occurrence of a matching keyword (outside
 * anchors/code/headings) with an internal link to the target feature URL.
 *
 * Per-locale mappings are colocated below so translators can maintain the
 * keyword wording alongside the other SEO copy. Every rule is constructed with
 * an explicit case-insensitive RegExp because the matched slice is re-used as
 * the anchor text, preserving the article's voice.
 *
 * Ordering notes:
 *   - `priority` is used to break ties when multiple rules match the same text
 *     window. Higher numbers win.
 *   - `targetUrl` MUST be an absolute path (leading `/`). A single article
 *     never gets two links to the same target (see plugin dedup logic).
 *   - `minArticleWords` is a safety floor — articles below this threshold are
 *     skipped entirely for this rule (empty or ultra-short articles should not
 *     be stuffed with links).
 */

export type BlogLinkLocale = 'it' | 'en' | 'de' | 'fr';

export interface BlogContextualLinkRule {
  /** Case-insensitive regex with word-boundary awareness. MUST use the `i` flag. */
  readonly keywordPattern: RegExp;
  /** Absolute target path, e.g. `/prezzi-diesel/oggi/`. */
  readonly targetUrl: string;
  /** Minimum word count before the rule applies (default = 500). */
  readonly minArticleWords?: number;
  /** Tiebreaker when multiple rules match the same region. Higher wins. */
  readonly priority: number;
  /** Human-readable identifier used in logs/telemetry. */
  readonly id: string;
}

const DEFAULT_MIN_WORDS = 500;

/**
 * IT rules — the primary locale (no URL prefix). Targets the five new feature
 * clusters: F6 (fuel), F2 (LAMal), F4 (job-market snapshot), F5 (weekly
 * employers), F3b (orphan landings → job listings) plus the geo/recency hubs
 * shipped in P1.
 */
const RULES_IT: readonly BlogContextualLinkRule[] = [
  // F6 — Fuel daily (diesel)
  {
    id: 'it.fuel.diesel.prices',
    keywordPattern: /\b(?:prezzo|prezzi|aumento|aumenti|costo|costi|rincaro|rincari)\s+(?:del\s+|della\s+|dei\s+)?diesel\b/i,
    targetUrl: '/prezzi-diesel/oggi/',
    priority: 12,
  },
  {
    id: 'it.fuel.diesel.generic',
    keywordPattern: /\b(?:diesel|gasolio)\s+(?:in\s+)?(?:ticino|svizzera|lugano|mendrisio|chiasso)\b/i,
    targetUrl: '/prezzi-diesel/oggi/',
    priority: 10,
  },
  {
    id: 'it.fuel.benzina.prices',
    keywordPattern: /\b(?:prezzo|prezzi|aumento|aumenti|costo|costi|rincaro|rincari)\s+(?:della\s+|delle\s+)?benzina\b/i,
    targetUrl: '/prezzi-benzina/oggi/',
    priority: 12,
  },
  {
    id: 'it.fuel.benzina.generic',
    keywordPattern: /\bbenzina\s+(?:in\s+)?(?:ticino|svizzera|lugano|mendrisio|chiasso)\b/i,
    targetUrl: '/prezzi-benzina/oggi/',
    priority: 10,
  },
  {
    id: 'it.fuel.carburante',
    keywordPattern: /\b(?:prezzi|costi|rincari)\s+(?:dei\s+|del\s+)?(?:carburante|carburanti)\b/i,
    targetUrl: '/prezzi-diesel/oggi/',
    priority: 9,
  },

  // F2 — LAMal / cassa malati
  {
    id: 'it.lamal.premium.ticino',
    keywordPattern: /\b(?:premi|premio)\s+(?:della\s+|delle\s+)?cass[ae]\s+malati(?:\s+(?:in\s+)?(?:ticino|canton\s+ticino))?\b/i,
    targetUrl: '/premi-cassa-malati/ticino/',
    priority: 12,
  },
  {
    id: 'it.lamal.cassa-malati',
    keywordPattern: /\b(?:cassa|casse)\s+malati\b/i,
    targetUrl: '/premi-cassa-malati/ticino/',
    priority: 9,
  },
  {
    id: 'it.lamal.assicurazione',
    keywordPattern: /\bassicurazione\s+malattia(?:\s+obbligatoria)?\b/i,
    targetUrl: '/premi-cassa-malati/ticino/',
    priority: 8,
  },
  {
    id: 'it.lamal.lamal',
    keywordPattern: /\bLAM[aA]l\b/,
    targetUrl: '/premi-cassa-malati/ticino/',
    priority: 8,
  },

  // F4 — Job-market snapshot (Ticino hub)
  {
    id: 'it.jobs.mercato-lavoro',
    keywordPattern: /\bmercato\s+del\s+lavoro(?:\s+(?:in\s+)?ticino)?\b/i,
    targetUrl: '/mercato-lavoro-ticino/',
    priority: 11,
  },
  {
    id: 'it.jobs.offerte-ticino',
    keywordPattern: /\b(?:offerte|posti|annunci|ricerca)\s+(?:di\s+)?lavoro\s+(?:in\s+)?(?:ticino|lugano|mendrisio|bellinzona|locarno)\b/i,
    targetUrl: '/mercato-lavoro-ticino/',
    priority: 10,
  },
  {
    id: 'it.jobs.occupazione',
    keywordPattern: /\b(?:tasso\s+di\s+)?occupazione(?:\s+(?:in\s+)?ticino)?\b/i,
    targetUrl: '/mercato-lavoro-ticino/',
    priority: 7,
  },

  // F5 — Weekly employers
  {
    id: 'it.employers.assumono',
    keywordPattern: /\baziende\s+(?:che\s+)?assumono(?:\s+(?:in\s+)?(?:ticino|lugano|mendrisio|bellinzona))?\b/i,
    targetUrl: '/aziende-che-assumono/ticino/settimana-corrente/',
    priority: 11,
  },
  {
    id: 'it.employers.datori',
    keywordPattern: /\b(?:principali|maggiori)\s+datori\s+di\s+lavoro\b/i,
    targetUrl: '/aziende-che-assumono/ticino/settimana-corrente/',
    priority: 9,
  },

  // P1 recency & geo hubs (link-equity boost to existing SEO clusters)
  {
    id: 'it.recency.3days',
    keywordPattern: /\b(?:ultim[ei]\s+(?:3|tre)\s+giorni|ultimi\s+giorni)\s+(?:per|di|in)\s+(?:offerte|lavoro|annunci)\b/i,
    targetUrl: '/cerca-lavoro-ticino/ultimi-3-giorni/',
    priority: 7,
  },
];

/**
 * EN rules — English UI + SEO targets (feature paths under /en/).
 */
const RULES_EN: readonly BlogContextualLinkRule[] = [
  // F6 — Fuel daily
  {
    id: 'en.fuel.diesel.prices',
    keywordPattern: /\b(?:price|prices|cost|costs|increase|increases)\s+(?:of\s+)?diesel\b/i,
    targetUrl: '/en/diesel-prices/today/',
    priority: 12,
  },
  {
    id: 'en.fuel.diesel.generic',
    keywordPattern: /\bdiesel\s+(?:price|prices)\b/i,
    targetUrl: '/en/diesel-prices/today/',
    priority: 10,
  },
  {
    id: 'en.fuel.gasoline',
    keywordPattern: /\b(?:gasoline|petrol)\s+(?:price|prices|cost|costs)\b/i,
    targetUrl: '/en/gasoline-prices/today/',
    priority: 11,
  },
  {
    id: 'en.fuel.fuel',
    keywordPattern: /\bfuel\s+(?:price|prices|cost|costs)(?:\s+(?:in\s+)?(?:ticino|switzerland))?\b/i,
    targetUrl: '/en/diesel-prices/today/',
    priority: 9,
  },

  // F2 — LAMal
  {
    id: 'en.lamal.premiums.ticino',
    keywordPattern: /\bhealth[- ]insurance\s+premiums?(?:\s+(?:in\s+)?ticino)?\b/i,
    targetUrl: '/en/health-insurance-premiums/ticino/',
    priority: 12,
  },
  {
    id: 'en.lamal.lamal',
    keywordPattern: /\bLAM[aA]l\b/,
    targetUrl: '/en/health-insurance-premiums/ticino/',
    priority: 9,
  },
  {
    id: 'en.lamal.sickness',
    keywordPattern: /\bhealth[- ]insurance(?:\s+(?:for\s+cross[- ]border\s+workers|frontalieri))?\b/i,
    targetUrl: '/en/health-insurance-premiums/ticino/',
    priority: 8,
  },

  // F4 — Job market
  {
    id: 'en.jobs.market',
    keywordPattern: /\bjob\s+market(?:\s+(?:in\s+)?ticino)?\b/i,
    targetUrl: '/en/ticino-job-market/',
    priority: 11,
  },
  {
    id: 'en.jobs.openings',
    keywordPattern: /\b(?:job\s+openings|job\s+offers|job\s+postings)\s+(?:in\s+)?(?:ticino|lugano|mendrisio|bellinzona|locarno)\b/i,
    targetUrl: '/en/ticino-job-market/',
    priority: 10,
  },

  // F5 — Employers
  {
    id: 'en.employers.hiring',
    keywordPattern: /\b(?:companies|employers)\s+(?:that\s+are\s+)?hiring(?:\s+(?:in\s+)?(?:ticino|lugano|mendrisio|bellinzona))?\b/i,
    targetUrl: '/en/companies-hiring/ticino/current-week/',
    priority: 11,
  },

  // P1 recency hub
  {
    id: 'en.recency.3days',
    keywordPattern: /\bjobs\s+posted\s+in\s+the\s+last\s+(?:3|three)\s+days\b/i,
    targetUrl: '/en/find-jobs-ticino/last-3-days/',
    priority: 7,
  },
];

/**
 * DE rules — Deutsch.
 */
const RULES_DE: readonly BlogContextualLinkRule[] = [
  // F6 — Fuel daily
  {
    id: 'de.fuel.diesel.prices',
    keywordPattern: /\b(?:Diesel|Dieselpreis(?:e)?|Dieselpreiserhöhung)\s*(?:preise|kosten|anstieg)?\b/i,
    targetUrl: '/de/dieselpreise/heute/',
    priority: 12,
  },
  {
    id: 'de.fuel.benzin.prices',
    keywordPattern: /\b(?:Benzin|Benzinpreis(?:e)?)(?:\s+(?:in\s+)?(?:tessin|schweiz))?\b/i,
    targetUrl: '/de/benzinpreise/heute/',
    priority: 11,
  },
  {
    id: 'de.fuel.treibstoff',
    keywordPattern: /\bTreibstoff(?:preise|kosten)\b/i,
    targetUrl: '/de/dieselpreise/heute/',
    priority: 9,
  },

  // F2 — LAMal
  {
    id: 'de.lamal.krankenkasse.ticino',
    keywordPattern: /\bKrankenkassenprämien?(?:\s+(?:im\s+)?tessin)?\b/i,
    targetUrl: '/de/krankenkassenpraemien/ticino/',
    priority: 12,
  },
  {
    id: 'de.lamal.krankenkasse',
    keywordPattern: /\bKrankenversicherung(?:\s+obligatorisch)?\b/i,
    targetUrl: '/de/krankenkassenpraemien/ticino/',
    priority: 9,
  },

  // F4 — Job market
  {
    id: 'de.jobs.arbeitsmarkt',
    keywordPattern: /\bArbeitsmarkt(?:\s+(?:im\s+)?tessin)?\b/i,
    targetUrl: '/de/tessin-arbeitsmarkt/',
    priority: 11,
  },
  {
    id: 'de.jobs.stellen',
    keywordPattern: /\bStellenangebote\s+(?:im\s+)?(?:tessin|lugano|mendrisio|bellinzona)\b/i,
    targetUrl: '/de/tessin-arbeitsmarkt/',
    priority: 10,
  },

  // F5 — Employers
  {
    id: 'de.employers.arbeitgeber',
    keywordPattern: /\b(?:arbeitgeber|unternehmen)\s+(?:die|die\s+gerade)?\s*einstellen\b/i,
    targetUrl: '/de/unternehmen-einstellen/ticino/aktuelle-woche/',
    priority: 11,
  },

  // Recency
  {
    id: 'de.recency.3days',
    keywordPattern: /\bneue\s+Stellen\s+(?:der\s+)?letzten\s+(?:3|drei)\s+Tage\b/i,
    targetUrl: '/de/jobs-im-tessin/letzte-3-tage/',
    priority: 7,
  },
];

/**
 * FR rules — Français.
 */
const RULES_FR: readonly BlogContextualLinkRule[] = [
  // F6 — Fuel daily
  {
    id: 'fr.fuel.diesel.prices',
    keywordPattern: /\b(?:prix|coût|coûts|hausse|augmentation)s?\s+(?:du\s+|des\s+)?(?:diesel|gasoil)\b/i,
    targetUrl: '/fr/prix-diesel/aujourdhui/',
    priority: 12,
  },
  {
    id: 'fr.fuel.essence',
    keywordPattern: /\b(?:prix|coût|coûts|hausse)\s+(?:de\s+l'|des?\s+)?essence\b/i,
    targetUrl: '/fr/prix-essence/aujourdhui/',
    priority: 11,
  },
  {
    id: 'fr.fuel.carburant',
    keywordPattern: /\b(?:prix|coûts)\s+(?:des\s+|du\s+)?carburants?\b/i,
    targetUrl: '/fr/prix-diesel/aujourdhui/',
    priority: 9,
  },

  // F2 — LAMal
  {
    id: 'fr.lamal.primes.ticino',
    keywordPattern: /\bprimes?\s+(?:d'|de\s+l')?assurance[- ]maladie(?:\s+(?:au\s+)?tessin)?\b/i,
    targetUrl: '/fr/primes-assurance-maladie/ticino/',
    priority: 12,
  },
  {
    id: 'fr.lamal.caisse-maladie',
    keywordPattern: /\bcaisse[- ]maladie\b/i,
    targetUrl: '/fr/primes-assurance-maladie/ticino/',
    priority: 9,
  },

  // F4 — Job market
  {
    id: 'fr.jobs.marche-travail',
    keywordPattern: /\bmarché\s+du\s+travail(?:\s+(?:au\s+)?tessin)?\b/i,
    targetUrl: '/fr/marche-travail-tessin/',
    priority: 11,
  },
  {
    id: 'fr.jobs.offres',
    keywordPattern: /\boffres\s+d['e]?\s*emploi\s+(?:au\s+|en\s+)?(?:tessin|lugano|mendrisio|bellinzona|locarno)\b/i,
    targetUrl: '/fr/marche-travail-tessin/',
    priority: 10,
  },

  // F5 — Employers
  {
    id: 'fr.employers.recrutent',
    keywordPattern: /\b(?:entreprises|employeurs)\s+qui\s+recrutent(?:\s+(?:au\s+)?(?:tessin|lugano|mendrisio|bellinzona))?\b/i,
    targetUrl: '/fr/entreprises-qui-recrutent/ticino/semaine-actuelle/',
    priority: 11,
  },

  // Recency
  {
    id: 'fr.recency.3days',
    keywordPattern: /\boffres\s+(?:d['e]?\s*emploi\s+)?(?:des\s+)?(?:3|trois)\s+derniers\s+jours\b/i,
    targetUrl: '/fr/trouver-emploi-tessin/derniers-3-jours/',
    priority: 7,
  },
];

export const BLOG_CONTEXTUAL_LINKS: Record<BlogLinkLocale, readonly BlogContextualLinkRule[]> = {
  it: RULES_IT,
  en: RULES_EN,
  de: RULES_DE,
  fr: RULES_FR,
};

/** Default minimum word count for an article to be eligible for any rule. */
export const BLOG_LINKS_MIN_ARTICLE_WORDS = DEFAULT_MIN_WORDS;

/** Max number of contextual links inserted per article, regardless of locale. */
export const BLOG_LINKS_MAX_PER_ARTICLE = 3;

/**
 * Return the effective minimum word count for a rule — explicit `minArticleWords`
 * wins, otherwise falls back to the plugin-wide default.
 */
export function effectiveMinWords(rule: BlogContextualLinkRule): number {
  return rule.minArticleWords ?? BLOG_LINKS_MIN_ARTICLE_WORDS;
}
