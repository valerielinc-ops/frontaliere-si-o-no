import { GLOSSARY_HUB_SEO, type GlossaryLocale } from './glossaryTermDefinitions';
import { SLUG_TABLES } from '../routeSlugs.data';

const BASE_URL = 'https://frontaliereticino.ch';

/** The Italian copy the hydrated glossary has always declared. */
const IT_SET_COPY = {
  name: 'Glossario del Frontaliere - Termini Fiscali, Previdenziali e Legali',
  description: 'Glossario completo dei termini fiscali, previdenziali e legali per i lavoratori frontalieri in Svizzera.',
};

/**
 * The DefinedTermSet the SPA glossary injects on hydration, in the page's
 * language. It used to carry the Italian name, description and URL on
 * `/en|de|fr/…glossary…/` too, next to the localized one the static page ships.
 */
export function buildGlossaryHubSchema(
  terms: ReadonlyArray<{ name: string; description: string }>,
  requested: GlossaryLocale,
): Record<string, unknown> {
  const locale: GlossaryLocale = GLOSSARY_HUB_SEO[requested] ? requested : 'it';
  const hub = GLOSSARY_HUB_SEO[locale];
  const copy = locale === 'it' ? IT_SET_COPY : { name: hub.title, description: hub.description };
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'DefinedTermSet',
    name: copy.name,
    description: copy.description,
    url: `${BASE_URL}${prefix}/${SLUG_TABLES[locale].glossario}/`,
    hasDefinedTerm: terms.map((term) => ({
      '@type': 'DefinedTerm',
      name: term.name,
      description: term.description,
      inDefinedTermSet: { '@type': 'DefinedTermSet', name: hub.title },
    })),
  };
}
