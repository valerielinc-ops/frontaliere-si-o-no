/**
 * The first crumb of a BreadcrumbList is the home of the page's own language.
 *
 * About 40 emitters hardcode `${BASE_URL}/` (or a bare `BASE_URL`) as "Home",
 * so an EN/DE/FR page declared the Italian home as its parent. The shell
 * receives every generator's JSON-LD, so this one pass closes the class
 * instead of patching each emitter; the pages that bypass the shell call
 * `localeHomeUrl` directly.
 */

const SITE_ORIGIN = 'https://frontaliereticino.ch';
const NON_DEFAULT_LOCALES = new Set(['en', 'de', 'fr']);

function normalizeLocale(locale: string | undefined): string {
  const short = String(locale || '').slice(0, 2).toLowerCase();
  return NON_DEFAULT_LOCALES.has(short) ? short : 'it';
}

/** Absolute home of a locale, trailing slash included. */
export function localeHomeUrl(locale: string | undefined, baseUrl: string = SITE_ORIGIN): string {
  const origin = baseUrl.replace(/\/+$/, '');
  const short = normalizeLocale(locale);
  return short === 'it' ? `${origin}/` : `${origin}/${short}/`;
}

function isSiteRoot(item: unknown): boolean {
  return typeof item === 'string' && item.replace(/\/+$/, '') === SITE_ORIGIN;
}

function localizeList(node: Record<string, unknown>, locale: string): Record<string, unknown> {
  const elements = node.itemListElement;
  if (!Array.isArray(elements)) return node;
  let changed = false;
  const next = elements.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const crumb = entry as Record<string, unknown>;
    if (Number(crumb.position) !== 1 || !isSiteRoot(crumb.item)) return entry;
    const item = localeHomeUrl(locale);
    if (item === crumb.item) return entry;
    changed = true;
    return { ...crumb, item };
  });
  return changed ? { ...node, itemListElement: next } : node;
}

/**
 * Rewrite the first crumb of every BreadcrumbList in a JSON-LD value (plain
 * node, array or `@graph`) when it points at the site root. Any other crumb,
 * and a first crumb that already names a section, stays untouched.
 */
export function localizeBreadcrumbHome<T>(value: T, locale: string | undefined): T {
  const short = normalizeLocale(locale);
  if (Array.isArray(value)) {
    return value.map((entry) => localizeBreadcrumbHome(entry, short)) as unknown as T;
  }
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const type = node['@type'];
  if (type === 'BreadcrumbList' || (Array.isArray(type) && type.includes('BreadcrumbList'))) {
    return localizeList(node, short) as unknown as T;
  }
  if (Array.isArray(node['@graph'])) {
    return { ...node, '@graph': localizeBreadcrumbHome(node['@graph'], short) } as unknown as T;
  }
  return value;
}
