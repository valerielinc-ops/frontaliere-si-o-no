/**
 * EEAT — authoritative external sources block for YMYL tax/salary pages
 * (issue #3515).
 *
 * Google's Quality Rater Guidelines weigh source attribution heavily for
 * financial/legal (YMYL) claims. The site's tax/salary content (blog
 * articles, glossary terms, salary scenario pages, tasse-e-pensione pages)
 * derives its numbers from these official sources but historically never
 * linked them. This module renders a small localized "Fonti ufficiali"
 * <section> with outbound citations so every YMYL template can append it
 * below the actionable content (mobile-first: sources at the bottom of the
 * content area).
 *
 * Rules:
 * - Every URL here was verified to answer HTTP 200 (direct, no redirect)
 *   before being committed. If you add a source, curl it first.
 * - Citations use rel="noopener" only — NO rel="nofollow": these are
 *   editorial citations to primary sources, not paid/UGC links.
 * - Single shared module by design (AGENTS.md Non-Negotiable #6): the URL
 *   list must not be copy-pasted into individual templates, so it cannot
 *   drift between page classes.
 */

export type SourcesLocale = 'it' | 'en' | 'de' | 'fr';

interface AuthoritativeSource {
  /** Per-locale target URL (falls back per-source to the same URL when the authority publishes in one language only). */
  readonly href: Record<SourcesLocale, string>;
  /** Per-locale visible link label. */
  readonly label: Record<SourcesLocale, string>;
}

/** Heading for the sources block, per locale. */
export const SOURCES_HEADING: Record<SourcesLocale, string> = {
  it: 'Fonti ufficiali',
  en: 'Official sources',
  de: 'Offizielle Quellen',
  fr: 'Sources officielles',
};

/**
 * BFS/UST — Swiss Federal Statistical Office, wages & income statistics
 * (LSE — the salary structure survey the site's salary medians derive from).
 * The Italian portal has no deep wages page, so `it` links the section
 * landing; en/de/fr link the dedicated wages page. All four verified 200.
 */
const BFS_WAGES: AuthoritativeSource = {
  href: {
    it: 'https://www.bfs.admin.ch/bfs/it/home/statistiche/lavoro-reddito.html',
    en: 'https://www.bfs.admin.ch/bfs/en/home/statistics/work-income/wages-income-employment-labour-costs.html',
    de: 'https://www.bfs.admin.ch/bfs/de/home/statistiken/arbeit-erwerb/loehne-erwerbseinkommen-arbeitskosten.html',
    fr: 'https://www.bfs.admin.ch/bfs/fr/home/statistiques/travail-remuneration/salaires-revenus-cout-travail.html',
  },
  label: {
    it: 'Ufficio federale di statistica (UST) — Salari e reddito',
    en: 'Swiss Federal Statistical Office (FSO) — Wages and income',
    de: 'Bundesamt für Statistik (BFS) — Löhne und Erwerbseinkommen',
    fr: 'Office fédéral de la statistique (OFS) — Salaires et revenus',
  },
};

/**
 * ESTV/AFC — Swiss Federal Tax Administration country page for Italy:
 * hosts the double-taxation convention and the 2020 cross-border commuters
 * agreement (in force since 2024). All four locale URLs verified 200.
 */
const ESTV_ITALY: AuthoritativeSource = {
  href: {
    it: 'https://www.estv.admin.ch/it/italia',
    en: 'https://www.estv.admin.ch/en/italy',
    de: 'https://www.estv.admin.ch/de/italien',
    fr: 'https://www.estv.admin.ch/fr/italie',
  },
  label: {
    it: 'Amministrazione federale delle contribuzioni (AFC) — Accordo fiscale Svizzera–Italia',
    en: 'Swiss Federal Tax Administration (FTA) — Switzerland–Italy tax agreement',
    de: 'Eidgenössische Steuerverwaltung (ESTV) — Steuerabkommen Schweiz–Italien',
    fr: 'Administration fédérale des contributions (AFC) — Accord fiscal Suisse–Italie',
  },
};

/**
 * Canton Ticino tax authority (Divisione delle contribuzioni) — withholding
 * tax (imposta alla fonte) information page: the primary source for the
 * A/B/C/H withholding tables cited across the site. Published in Italian
 * only, so all locales share the URL. Verified 200.
 */
const TI_WITHHOLDING: AuthoritativeSource = {
  href: {
    it: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/informazioni-sullimposte-alla-fonte',
    en: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/informazioni-sullimposte-alla-fonte',
    de: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/informazioni-sullimposte-alla-fonte',
    fr: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/informazioni-sullimposte-alla-fonte',
  },
  label: {
    it: 'Cantone Ticino — Imposta alla fonte (Divisione delle contribuzioni)',
    en: 'Canton Ticino — Withholding tax (cantonal tax authority, in Italian)',
    de: 'Kanton Tessin — Quellensteuer (kantonale Steuerverwaltung, auf Italienisch)',
    fr: 'Canton du Tessin — Impôt à la source (administration fiscale cantonale, en italien)',
  },
};

/**
 * Agenzia delle Entrate — Italian revenue agency page on cross-border
 * commuter rules (IRPEF side: franchigia, credito d'imposta, new 2024
 * agreement). Published in Italian only. Verified 200.
 */
const AGENZIA_ENTRATE_FRONTALIERI: AuthoritativeSource = {
  href: {
    it: 'https://www.agenziaentrate.gov.it/portale/norme-per-i-pendolari-transfrontalieri-dei-paesi-confinanti',
    en: 'https://www.agenziaentrate.gov.it/portale/norme-per-i-pendolari-transfrontalieri-dei-paesi-confinanti',
    de: 'https://www.agenziaentrate.gov.it/portale/norme-per-i-pendolari-transfrontalieri-dei-paesi-confinanti',
    fr: 'https://www.agenziaentrate.gov.it/portale/norme-per-i-pendolari-transfrontalieri-dei-paesi-confinanti',
  },
  label: {
    it: 'Agenzia delle Entrate — Norme per i lavoratori frontalieri',
    en: 'Agenzia delle Entrate — Cross-border commuter rules (Italy, in Italian)',
    de: 'Agenzia delle Entrate — Grenzgänger-Regeln (Italien, auf Italienisch)',
    fr: 'Agenzia delle Entrate — Règles pour les frontaliers (Italie, en italien)',
  },
};

export type AuthoritativeSourceKey =
  | 'bfsWages'
  | 'estvItaly'
  | 'tiWithholding'
  | 'agenziaEntrate';

const SOURCES: Record<AuthoritativeSourceKey, AuthoritativeSource> = {
  bfsWages: BFS_WAGES,
  estvItaly: ESTV_ITALY,
  tiWithholding: TI_WITHHOLDING,
  agenziaEntrate: AGENZIA_ENTRATE_FRONTALIERI,
};

/** Default source set for YMYL tax/salary pages (all four authorities). */
export const YMYL_TAX_SALARY_SOURCE_KEYS: readonly AuthoritativeSourceKey[] = [
  'bfsWages',
  'tiWithholding',
  'estvItaly',
  'agenziaEntrate',
];

export interface SourcesBlockClassNames {
  readonly section?: string;
  readonly heading?: string;
  readonly list?: string;
  readonly item?: string;
  /** Inline style for the <h2> — for template families styled via inline tokens (e.g. H2_STYLE) instead of classes. */
  readonly headingStyle?: string;
  /** Inline style for the <ul>. */
  readonly listStyle?: string;
}

const cls = (name?: string): string => (name ? ` class="${name}"` : '');
const sty = (style?: string): string => (style ? ` style="${style}"` : '');

/**
 * Renders the localized "Fonti ufficiali" block as a self-contained
 * <section>. Class names / inline styles are injectable so each SSG
 * template can reuse its existing heading/list styling; markup structure
 * stays identical across page classes.
 */
export function renderAuthoritativeSourcesHtml(
  locale: SourcesLocale,
  keys: readonly AuthoritativeSourceKey[] = YMYL_TAX_SALARY_SOURCE_KEYS,
  classNames: SourcesBlockClassNames = {},
): string {
  const items = keys
    .map((key) => {
      const source = SOURCES[key];
      return `<li${cls(classNames.item)}><a href="${source.href[locale]}" target="_blank" rel="noopener">${source.label[locale]}</a></li>`;
    })
    .join('');
  return `<section${cls(classNames.section)} data-sources-block><h2${cls(classNames.heading)}${sty(classNames.headingStyle)}>${SOURCES_HEADING[locale]}</h2><ul${cls(classNames.list)}${sty(classNames.listStyle)}>${items}</ul></section>`;
}
