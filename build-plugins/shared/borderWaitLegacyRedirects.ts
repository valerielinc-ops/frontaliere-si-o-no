import {
  BORDER_WAIT_CROSSINGS,
  buildOggiPath,
  buildRootHubPath,
  type BorderCrossingSlug,
  type BorderWaitLocale,
} from '../borderWaitData';

/**
 * The four legacy guide roots that were actually emitted in the static
 * sitemap. They now bridge to the data-driven border-wait vertical; keeping
 * this list explicit avoids manufacturing thousands of redirects for aliases
 * that were never published.
 */
export const BORDER_WAIT_PRIMARY_LEGACY_BASES: Readonly<Record<BorderWaitLocale, string>> = {
  it: '/guida-frontaliere/tempi-attesa-dogana',
  en: '/en/cross-border-guide/border-waiting-times',
  de: '/de/grenzgaenger-ratgeber/wartezeiten-grenze',
  fr: '/fr/guide-frontalier/temps-attente-douane',
};

/** Slugs used by the hand-authored guide before the crossing registry was normalized. */
const LEGACY_CROSSING_SLUG_ALIASES: Readonly<Record<string, BorderCrossingSlug>> = {
  'brogeda-chiasso': 'chiasso-brogeda',
  'chiasso-centro-ponte-chiasso': 'chiasso-centro',
  'gaggiolo-cantello-stabio': 'gaggiolo',
  // Slugs still present in the evergreen Chiasso editorial copy.
  'ponte-chiasso': 'chiasso-centro',
  novazzano: 'bizzarone-novazzano',
  stabio: 'gaggiolo',
};

/** Observed compatibility URLs outside the four sitemap roots. */
const OBSERVED_LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  '/tempi-attesa-confine/chiasso-brogeda/': buildOggiPath('it', 'chiasso-brogeda'),
  '/traffico-dogane/campione-ditalia-bissone/oggi/': buildOggiPath('it', 'campione-d-italia-bissone'),
  '/traffico-dogane/lanzo-dintelvi-arogno/oggi/': buildOggiPath('it', 'lanzo-d-intelvi-arogno'),
};

function withSlash(path: string): string {
  return `${path.replace(/\/+$/, '')}/`;
}

/** Build every emitted legacy bridge and return source-to-canonical paths. */
export function buildBorderWaitLegacyRedirects(): Map<string, string> {
  const redirects = new Map<string, string>();

  for (const [locale, base] of Object.entries(BORDER_WAIT_PRIMARY_LEGACY_BASES) as Array<[BorderWaitLocale, string]>) {
    redirects.set(withSlash(base), buildRootHubPath(locale));
    for (const crossing of BORDER_WAIT_CROSSINGS) {
      redirects.set(withSlash(`${base}/${crossing}`), buildOggiPath(locale, crossing));
    }
    for (const [legacySlug, crossing] of Object.entries(LEGACY_CROSSING_SLUG_ALIASES)) {
      redirects.set(withSlash(`${base}/${legacySlug}`), buildOggiPath(locale, crossing));
    }
  }

  for (const [from, to] of Object.entries(OBSERVED_LEGACY_REDIRECTS)) {
    redirects.set(withSlash(from), withSlash(to));
  }

  return redirects;
}

export const BORDER_WAIT_LEGACY_REDIRECTS = buildBorderWaitLegacyRedirects();

const LEGACY_BORDER_WAIT_LINK_RE = /\/(?:guida-frontaliere\/tempi-attesa-dogana|en\/cross-border-guide\/border-waiting-times|de\/grenzgaenger-ratgeber\/wartezeiten-grenze|fr\/guide-frontalier\/temps-attente-douane)(?:\/[^/"'<>?#]+)?\/?/g;

/** Rewrite old border-wait links embedded in generated editorial HTML. */
export function canonicalizeBorderWaitLinks(value: string): string {
  return value.replace(LEGACY_BORDER_WAIT_LINK_RE, (match) => {
    const normalized = `${match.replace(/\/+$/, '')}/`;
    return BORDER_WAIT_LEGACY_REDIRECTS.get(normalized) ?? match;
  });
}
