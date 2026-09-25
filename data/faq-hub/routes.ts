/**
 * FAQ hub — router-safe slug + path helpers.
 *
 * This file deliberately does NOT import the 10 category data files
 * (~340KB of TS source → ~200KB bloat in the SPA bundle). The router
 * only needs the canonical paths to recognise FAQ hub URLs; the full
 * `ALL_FAQ_HUB` aggregate is plugin-only (build-time).
 */

import type { FaqHubLocale } from './types';
import { FAQ_HUB_LOCALES } from './types';

export const FAQ_HUB_LOCALE_PREFIX: Record<FaqHubLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

export const FAQ_HUB_SLUG: Record<FaqHubLocale, string> = {
  it: 'domande-frequenti-frontalieri',
  en: 'frequently-asked-questions',
  de: 'haeufige-fragen',
  fr: 'questions-frequentes',
};

export function buildFaqHubPath(locale: FaqHubLocale): string {
  const prefix = FAQ_HUB_LOCALE_PREFIX[locale];
  const slug = FAQ_HUB_SLUG[locale];
  return `${prefix}/${slug}/`.replace(/\/+/g, '/');
}

export const FAQ_HUB_ROUTES: ReadonlyArray<string> = FAQ_HUB_LOCALES.map((loc) =>
  buildFaqHubPath(loc),
);

export function parseFaqHubPath(pathname: string): { locale: FaqHubLocale } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of FAQ_HUB_LOCALES) {
    if (buildFaqHubPath(locale) === normalized) return { locale };
  }
  return null;
}

export function isFaqHubPath(pathname: string): boolean {
  return parseFaqHubPath(pathname) !== null;
}

/**
 * Per-question page path: `<hub>/<entry id>/`.
 *
 * Entry ids are already unique, lowercase and URL-safe (`avs-lpp-contributi-
 * volontari`), so they are used verbatim as the slug — no second naming scheme
 * to keep in sync, and the slug stays stable when the question wording is
 * edited.
 *
 * The slug is NOT localised. Four locale-specific slug tables for 103 entries
 * would be 412 strings to translate and keep aligned with the id, and the
 * locale is already carried by the path prefix (`/en/…`, `/de/…`).
 */
export function buildFaqEntryPath(locale: FaqHubLocale, entryId: string): string {
  return `${buildFaqHubPath(locale)}${entryId}/`.replace(/\/+/g, '/');
}

/**
 * Recognise a per-question page path.
 *
 * Matched STRUCTURALLY — one path segment under a known hub path — rather than
 * against the list of real entry ids, because this module deliberately does not
 * import the ~340 KB category corpus (see the header): the router ships in the
 * SPA bundle. A path with a nonexistent id therefore parses here, which is
 * harmless: no static file was ever emitted for it, so the request 404s at the
 * edge and the SPA is never reached.
 */
export function parseFaqEntryPath(
  pathname: string,
): { locale: FaqHubLocale; entryId: string } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of FAQ_HUB_LOCALES) {
    const base = buildFaqHubPath(locale);
    if (!normalized.startsWith(base)) continue;
    const rest = normalized.slice(base.length);
    // Exactly one segment, and a plausible slug.
    const m = /^([a-z0-9][a-z0-9-]*)\/$/.exec(rest);
    if (m) return { locale, entryId: m[1] };
  }
  return null;
}

export function isFaqEntryPath(pathname: string): boolean {
  return parseFaqEntryPath(pathname) !== null;
}
