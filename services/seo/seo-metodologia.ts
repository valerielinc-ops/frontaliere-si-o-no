/**
 * seo-metodologia — SEO metadata builder for the /metodologia/ page.
 *
 * Used by:
 *  - components/pages/Metodologia.tsx (runtime title/meta sync)
 *  - build-plugins/staticPagesPlugin.ts (static HTML generation)
 *
 * Returns a stable SEO bundle per locale with a WebPage JSON-LD that
 * includes `lastReviewed` so search engines see freshness signals.
 *
 * Created for Google News compliance (FASE 2 A3): pairs with the AI
 * disclosure box on every blog article and the corrections log at
 * /correzioni/.
 */

const BASE_URL = 'https://frontaliereticino.ch';

export type MetodologiaLocale = 'it' | 'en' | 'de' | 'fr';

const CANONICAL_PATH: Record<MetodologiaLocale, string> = {
  it: '/metodologia/',
  en: '/en/methodology/',
  de: '/de/methodik/',
  fr: '/fr/methodologie/',
};

const TITLE: Record<MetodologiaLocale, string> = {
  it: 'Metodologia editoriale — Come scriviamo gli articoli | Frontaliere Ticino',
  en: 'Editorial Methodology — How We Write Our Articles | Frontaliere Ticino',
  de: 'Redaktionelle Methodik — Wie wir unsere Artikel schreiben | Frontaliere Ticino',
  fr: 'Méthodologie éditoriale — Comment nous rédigeons nos articles | Frontaliere Ticino',
};

const DESCRIPTION: Record<MetodologiaLocale, string> = {
  it:
    "Pipeline editoriale di Frontaliere Ticino: bozze assistite da IA, revisione redazionale, fonti primarie (AFC, UST, Agenzia delle Entrate) e politica di aggiornamento e correzioni.",
  en:
    "Frontaliere Ticino editorial pipeline: AI-assisted drafting, editorial review, primary sources (FTA, FSO, Italian Revenue Agency), update and corrections policy.",
  de:
    "Redaktionelle Pipeline von Frontaliere Ticino: KI-gestützte Entwürfe, redaktionelle Prüfung, Primärquellen (ESTV, BFS, Agenzia delle Entrate), Aktualisierungs- und Korrekturrichtlinie.",
  fr:
    "Pipeline éditorial de Frontaliere Ticino : ébauches assistées par IA, révision rédactionnelle, sources primaires (AFC, OFS, Agence des revenus), politique de mise à jour et de corrections.",
};

const ABOUT_NAME: Record<MetodologiaLocale, string> = {
  it: 'Editorial methodology and AI-assistance disclosure',
  en: 'Editorial methodology and AI-assistance disclosure',
  de: 'Redaktionelle Methodik und KI-Offenlegung',
  fr: 'Méthodologie éditoriale et divulgation IA',
};

/**
 * The page itself doesn't change daily. We surface today's date as the
 * `lastReviewed` so crawlers always see a non-empty freshness signal —
 * the same convention we use on /correzioni/.
 */
function resolveLastReviewed(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface MetodologiaSeo {
  title: string;
  description: string;
  canonical: string;
  jsonLd: Record<string, unknown>;
}

/**
 * Build the SEO bundle for /metodologia/ in the given locale.
 */
export function buildMetodologiaSeo(
  locale: MetodologiaLocale = 'it',
): MetodologiaSeo {
  const canonical = `${BASE_URL}${CANONICAL_PATH[locale]}`;
  const lastReviewed = resolveLastReviewed();

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: TITLE[locale],
    url: canonical,
    description: DESCRIPTION[locale],
    inLanguage: locale,
    lastReviewed,
    isPartOf: { '@id': `${BASE_URL}/#website` },
    about: {
      '@type': 'CreativeWork',
      name: ABOUT_NAME[locale],
    },
    publisher: { '@id': `${BASE_URL}/#organization` },
  };

  return {
    title: TITLE[locale],
    description: DESCRIPTION[locale],
    canonical,
    jsonLd,
  };
}
