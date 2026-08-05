/**
 * borderMunicipalityData — path surface of the ITALIAN border-municipality
 * family (`borderMunicipalityPagesPlugin.ts`), split out so the compat layer
 * can enumerate those URLs without importing the renderer.
 *
 * Why this module exists
 * ---------------------------------------------------------------------------
 * The four FOREIGN families (France, Germany, Austria, Liechtenstein) each ship
 * a data module beside their plugin, and `searchConsoleCompat.ts` imports the
 * `is*BorderMunicipalityPath` predicate from it to SELF-MAP every emitted URL.
 * The Italian family — the oldest and by far the largest of the five — never
 * got one, so it had no self-map branch. Its URLs therefore fell through to the
 * `SECTION_FALLBACKS` entry `^/vivere-in-ticino/` (plus the `/en/living-in-
 * ticino/`, `/de/leben-im-tessin/`, `/fr/vivre-au-tessin/` variants), which
 * resolves them to the section hub instead of to themselves.
 *
 * The blast radius is bounded — `resolveSearchConsoleCompatTarget` feeds the
 * confirmed-404 bridge (`cfHot404BridgePlugin.ts`), not live pages — but the
 * asymmetry is the bug: the other four families self-map defensively so a
 * comune that is renamed, re-slugged or briefly missing from a build resolves
 * to its own URL rather than being quietly folded into the hub. This family has
 * the most traffic of the five and had the least protection.
 *
 * Importing the plugin directly was not an option: it pulls in `vite`,
 * `node:fs`, `WriteCollector` and the crossings dataset, none of which belongs
 * in the compat path. This module holds only the path algebra.
 *
 * IMPORTANT — the path set is deliberately NOT built from the plugin's
 * `eligibleMunicipalities()`. That helper applies `BORDER_MUNICIPALITY_PAGE_LIMIT`,
 * a dev/CI truncation knob; deriving the compat surface from it would shrink
 * the self-map in exactly the builds where the limit is set, silently
 * reintroducing the hub-collapse for every truncated comune. The set below is
 * built from the unfiltered province filter, matching how the foreign families
 * enumerate their full above+below-floor lists.
 */

import { MUNICIPALITIES, type Municipality } from '../data/municipalities';
import { TICINO_VITA_CORRIDOR_PROVINCES } from './shared/borderMunicipalityCorridors';

export type BorderMunicipalityLocale = 'it' | 'en' | 'de' | 'fr';

export const BORDER_MUNICIPALITY_LOCALES: readonly BorderMunicipalityLocale[] = [
  'it',
  'en',
  'de',
  'fr',
] as const;

/** Per-locale base path (NO trailing municipality slug, NO trailing slash). */
export const BORDER_MUNICIPALITY_BASE_PATH: Record<BorderMunicipalityLocale, string> = {
  it: '/vivere-in-ticino/comuni-di-frontiera',
  en: '/en/living-in-ticino/border-municipalities',
  de: '/de/leben-im-tessin/grenzgemeinden',
  fr: '/fr/vivre-au-tessin/communes-frontiere',
};

/** Per-locale hub path (the family's index page). */
export const BORDER_MUNICIPALITY_HUB_PATH: Record<BorderMunicipalityLocale, string> = {
  it: `${BORDER_MUNICIPALITY_BASE_PATH.it}/`,
  en: `${BORDER_MUNICIPALITY_BASE_PATH.en}/`,
  de: `${BORDER_MUNICIPALITY_BASE_PATH.de}/`,
  fr: `${BORDER_MUNICIPALITY_BASE_PATH.fr}/`,
};

/**
 * Slug for a comune name. Byte-identical to the plugin's own `slugify` and to
 * `scripts/build-fiscal-municipalities.mjs` — the emitted URL and the compat
 * predicate must agree character for character or the self-map silently misses.
 */
export function slugifyMunicipalityName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function borderMunicipalityPathFor(
  locale: BorderMunicipalityLocale,
  municipalityName: string,
): string {
  return `${BORDER_MUNICIPALITY_BASE_PATH[locale]}/${slugifyMunicipalityName(municipalityName)}/`;
}

/**
 * Every comune the plugin is eligible to emit — the province filter WITHOUT
 * the page-limit truncation (see the module header).
 */
export function corridorMunicipalities(): Municipality[] {
  return MUNICIPALITIES.filter((m) => TICINO_VITA_CORRIDOR_PROVINCES.has(m.province)).sort(
    (a, b) => a.province.localeCompare(b.province) || a.name.localeCompare(b.name),
  );
}

/** Strips query/hash and forces a single trailing slash — same as the foreign families. */
function normalizePath(inputPath: string): string {
  const bare = inputPath.split(/[?#]/)[0];
  return bare.endsWith('/') ? bare : `${bare}/`;
}

const BORDER_MUNICIPALITY_PATH_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const m of corridorMunicipalities()) {
    for (const locale of BORDER_MUNICIPALITY_LOCALES) {
      set.add(borderMunicipalityPathFor(locale, m.name));
    }
  }
  return set;
})();

const BORDER_MUNICIPALITY_HUB_SET: ReadonlySet<string> = new Set(
  Object.values(BORDER_MUNICIPALITY_HUB_PATH),
);

/** True for a per-comune page of the Italian border family, in any locale. */
export function isBorderMunicipalityPath(inputPath: string): boolean {
  return BORDER_MUNICIPALITY_PATH_SET.has(normalizePath(inputPath));
}

/** True for the family's hub page, in any locale. */
export function isBorderMunicipalityHubPath(inputPath: string): boolean {
  return BORDER_MUNICIPALITY_HUB_SET.has(normalizePath(inputPath));
}
