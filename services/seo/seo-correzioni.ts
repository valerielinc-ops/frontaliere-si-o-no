/**
 * seo-correzioni — SEO metadata builder for the /correzioni/ page.
 *
 * Used by:
 *  - components/pages/Correzioni.tsx (client-rendered JSON-LD)
 *
 * NOT used by build-plugins/staticPagesPlugin.ts: that plugin text-parses
 * services/seo/seo-pages.ts's 'correzioni' entry at build time (regex +
 * JSON.parse, not a real JS import), so it cannot call this function —
 * its literal mirrors this builder's shape minus `lastReviewed`. Keep the
 * two in sync by hand if the schema shape changes; see the comment on
 * that entry.
 *
 * Returns a stable SEO bundle per locale with a WebPage JSON-LD that
 * includes `lastReviewed` so search engines see freshness signals.
 */
import correctionsLog from '@/data/corrections-log.json';

const BASE_URL = 'https://frontaliereticino.ch';

export type CorrezioniLocale = 'it' | 'en' | 'de' | 'fr';

interface CorrezioniLogShape {
  version: number;
  policy: {
    sla_hours: number;
    types: string[];
    contactEmail: string;
  };
  entries: { date: string }[];
}

const log = correctionsLog as CorrezioniLogShape;

const CANONICAL_PATH: Record<CorrezioniLocale, string> = {
  it: '/correzioni/',
  en: '/en/corrections/',
  de: '/de/korrekturen/',
  fr: '/fr/corrections/',
};

const TITLE: Record<CorrezioniLocale, string> = {
  it: 'Correzioni — Politica di rettifica e registro pubblico | Frontaliere Ticino',
  en: 'Corrections — Editorial policy and public log | Frontaliere Ticino',
  de: 'Korrekturen — Richtlinie und öffentliches Register | Frontaliere Ticino',
  fr: 'Corrections — Politique éditoriale et registre public | Frontaliere Ticino',
};

const DESCRIPTION: Record<CorrezioniLocale, string> = {
  it: 'Politica di correzione di Frontaliere Ticino: SLA 48 ore, tipologie accettate (errore fattuale, refuso, chiarimento) e registro pubblico cronologico delle rettifiche.',
  en: 'Frontaliere Ticino corrections policy: 48-hour SLA, accepted types (factual, typo, clarification), and a public chronological log of every editorial fix.',
  de: 'Korrekturrichtlinie von Frontaliere Ticino: SLA 48 Stunden, akzeptierte Typen (Faktenfehler, Tippfehler, Klarstellung) und öffentliches Register aller Berichtigungen.',
  fr: 'Politique de correction de Frontaliere Ticino : SLA 48 heures, types acceptés (erreur factuelle, faute de frappe, clarification) et registre public des rectifications.',
};

/**
 * Resolve `lastReviewed` from the log entries.
 * Falls back to today's date (YYYY-MM-DD) when the log is empty so
 * crawlers always see a non-empty freshness signal.
 */
function resolveLastReviewed(): string {
  if (log.entries.length === 0) {
    return new Date().toISOString().slice(0, 10);
  }
  const sorted = [...log.entries].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
  return sorted[0].date.slice(0, 10);
}

export interface CorrezioniSeo {
  title: string;
  description: string;
  canonical: string;
  jsonLd: Record<string, unknown>;
}

/**
 * Build the SEO bundle for /correzioni/ in the given locale.
 */
export function buildCorrezioniSeo(locale: CorrezioniLocale = 'it'): CorrezioniSeo {
  const canonical = `${BASE_URL}${CANONICAL_PATH[locale]}`;
  const lastReviewed = resolveLastReviewed();

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    // WebPage-specific name/description, distinct from the <title>/meta
    // TITLE/DESCRIPTION above — matches the SSG static literal in
    // seo-pages.ts's 'correzioni' entry ('it' is the only shipped locale).
    name: locale === 'it' ? 'Correzioni — Frontaliere Ticino' : TITLE[locale],
    url: canonical,
    description:
      locale === 'it'
        ? 'Politica di correzione pubblica e registro cronologico delle rettifiche pubblicate da Frontaliere Ticino.'
        : DESCRIPTION[locale],
    inLanguage: locale,
    lastReviewed,
    isPartOf: { '@id': `${BASE_URL}/#website` },
    about: {
      '@type': 'CreativeWork',
      name: 'Editorial corrections policy',
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
