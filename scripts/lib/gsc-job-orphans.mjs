/** Reserved hub prefixes — slugs starting with these are NOT job-details. */
const HUB_PREFIXES = [
  /^(ricerca|search|suche|recherche)-/,
  /^(azienda|company|localita|location|standort|ort|stadt|unternehmen|firma|entreprise|societe|ville|lieu|localite)-/,
  /^(categoria|category|kategorie|categorie)-/,
  /^(pagina|page|seite)-\d+$/,
];

const HUB_EXACT_SLUGS = new Set([
  'tutti', 'all', 'alle', 'tous',
  'settori', 'sectors', 'branchen', 'secteurs',
  'aziende', 'companies', 'unternehmen', 'entreprises',
]);

/** Parse a supported job-detail URL from a GSC export. */
export function urlToOrphan(url, jobSectionSlugs) {
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return null; }
  const segments = pathname.split('/').filter(Boolean);
  let locale = 'it';
  let cursor = 0;
  if (['en', 'de', 'fr'].includes(segments[0])) {
    locale = segments[0];
    cursor = 1;
  }
  const section = segments[cursor];
  const slug = segments[cursor + 1];
  if (!section || !slug || segments.length !== cursor + 2) return null;
  // `/lavoro/` was the shared legacy section for localized job pages.
  if (section !== 'lavoro' && !jobSectionSlugs[locale]?.has(section)) return null;
  if (HUB_EXACT_SLUGS.has(slug)) return null;
  if (HUB_PREFIXES.some((rx) => rx.test(slug))) return null;
  return { locale, slug, url };
}

export function gscJobOrphanRouteKey(entry) {
  try {
    const pathname = new URL(entry.url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    return segments.length ? `/${segments.join('/')}/` : '/';
  } catch {
    return `${entry.locale}::${entry.url}`;
  }
}

/** Merge imports by rendered route. Missing URLs are not evidence of recovery. */
export function mergeGscJobOrphans(existing, incoming) {
  const byRoute = new Map();
  for (const entry of [...existing, ...incoming]) byRoute.set(gscJobOrphanRouteKey(entry), entry);
  return [...byRoute.values()];
}
