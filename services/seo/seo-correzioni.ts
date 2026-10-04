import correctionsLog from '../../data/corrections-log.json';
import { CORRECTIONS_COPY, CORRECTIONS_PATHS, type CorrectionsLocale } from '../editorialCorrections';

const BASE_URL = 'https://frontaliereticino.ch';

export type CorrezioniLocale = CorrectionsLocale;

/** A log entry can provide a review date; an empty log cannot. */
function resolveLastReviewed(): string | undefined {
  return correctionsLog.entries.map((entry: { date: string }) => entry.date)
    .filter((date) => Number.isFinite(Date.parse(date)) && Date.parse(date) <= Date.now())
    .sort().at(-1)?.slice(0, 10);
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
  const canonical = `${BASE_URL}${CORRECTIONS_PATHS[locale]}`;
  const lastReviewed = resolveLastReviewed();
  const copy = CORRECTIONS_COPY[locale];
  const title = `${copy.title} — ${copy.subtitle} | Frontaliere Ticino`;

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: `${copy.title} — Frontaliere Ticino`,
    url: canonical,
    description: copy.description,
    inLanguage: locale,
    ...(lastReviewed ? { lastReviewed } : {}),
    isPartOf: { '@id': `${BASE_URL}/#website` },
    about: {
      '@type': 'CreativeWork',
      name: 'Editorial corrections policy',
    },
    publisher: { '@id': `${BASE_URL}/#organization` },
  };

  return {
    title,
    description: copy.description,
    canonical,
    jsonLd,
  };
}
