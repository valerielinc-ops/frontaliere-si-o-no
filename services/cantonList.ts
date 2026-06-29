/**
 * Canton list helper — exposes the 26 Swiss canton ISO codes plus per-locale
 * display labels.
 *
 * URL slugs are sourced from `data/canton-url-slugs.json` (single source of
 * truth used by the URL router + every SEO build plugin). That file collapses
 * AI/AR onto "APPENZELLO" and BL/BS onto "BASILEA" so the URL/shard emission
 * layer can group half-cantons, but the UI still surfaces the 26 individual
 * codes — when the user picks AI we expand it to a full "Appenzello Interno"
 * label here.
 *
 * Cathedral CH-wide expansion (PRs #54-60) — used by the Job Alert form's
 * canton geo-filter selector.
 */

import CANTON_URL_SLUGS_RAW from '../data/canton-url-slugs.json';

export type CantonLocale = 'it' | 'en' | 'de' | 'fr';

interface CantonUrlSlugsShape {
  cantons: Record<string, Record<CantonLocale, string>>;
  cantonGroups?: Record<string, { members: readonly string[] }>;
}

const RAW = CANTON_URL_SLUGS_RAW as unknown as CantonUrlSlugsShape;

// Member → group lookup (e.g. AI → APPENZELLO). Built once at module load.
const MEMBER_TO_GROUP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const groups = RAW.cantonGroups ?? {};
  for (const [groupKey, def] of Object.entries(groups)) {
    for (const member of def?.members ?? []) {
      map.set(String(member).toUpperCase(), groupKey);
    }
  }
  return map;
})();

// Localized full names for the half-cantons (AI/AR/BL/BS). The group slug only
// stores the shared "Appenzello"/"Basilea" prefix — these tables provide the
// disambiguator that users expect in a 26-canton picker.
const HALF_CANTON_LABELS: Record<string, Record<CantonLocale, string>> = {
  AI: {
    it: 'Appenzello Interno',
    de: 'Appenzell Innerrhoden',
    fr: 'Appenzell Rhodes-Intérieures',
    en: 'Appenzell Innerrhoden',
  },
  AR: {
    it: 'Appenzello Esterno',
    de: 'Appenzell Ausserrhoden',
    fr: 'Appenzell Rhodes-Extérieures',
    en: 'Appenzell Ausserrhoden',
  },
  BL: {
    it: 'Basilea Campagna',
    de: 'Basel-Landschaft',
    fr: 'Bâle-Campagne',
    en: 'Basel-Landschaft',
  },
  BS: {
    it: 'Basilea Città',
    de: 'Basel-Stadt',
    fr: 'Bâle-Ville',
    en: 'Basel-Stadt',
  },
};

/**
 * Expand a URL canton code to its member BFS codes. For real cantons the
 * input is returned as a single-element array unchanged. For group codes
 * (`BASILEA` → `['BL','BS']`, `APPENZELLO` → `['AI','AR']`) the members
 * are returned.
 *
 * Used wherever a downstream filter compares against `job.canton` (the
 * BFS code on the data side) but the URL-driven canton may be a group
 * code. Without this expansion, `scopeJobsToCanton(jobs, 'BASILEA')`
 * silently yields zero rows because no job has `canton === 'BASILEA'`.
 */
export function expandCantonGroup(code: string): string[] {
  const upper = String(code || '').toUpperCase().trim();
  if (!upper) return [];
  const groupDef = RAW.cantonGroups?.[upper];
  if (groupDef?.members && groupDef.members.length > 0) {
    return groupDef.members.map((m) => String(m).toUpperCase());
  }
  return [upper];
}

/**
 * 2-letter ISO canton codes (uppercase) — sorted alphabetically for stable
 * UI ordering. Frozen at module load. Always 26 entries (expands AI/AR/BL/BS
 * even though the URL slugs collapse them onto APPENZELLO/BASILEA).
 */
export const CANTON_CODES: ReadonlyArray<string> = Object.freeze(
  (() => {
    const set = new Set<string>();
    for (const key of Object.keys(RAW.cantons)) {
      const members = RAW.cantonGroups?.[key]?.members;
      if (members && members.length > 0) {
        for (const m of members) set.add(String(m).toUpperCase());
      } else {
        set.add(key);
      }
    }
    return [...set].sort();
  })(),
);

function slugToLabel(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * Localised display label for a canton (e.g. `TI` + `it` → "Ticino", `TI` +
 * `de` → "Tessin"). Falls back to the canton code if no localized label is
 * available.
 */
export function getCantonLabel(code: string, locale: CantonLocale): string {
  const upper = String(code || '').toUpperCase();
  const halfCanton = HALF_CANTON_LABELS[upper];
  if (halfCanton) return halfCanton[locale] || halfCanton.it || upper;

  const directEntry = RAW.cantons[upper];
  if (directEntry) {
    const slug = directEntry[locale] || directEntry.it || upper;
    return slugToLabel(slug);
  }

  const groupKey = MEMBER_TO_GROUP.get(upper);
  if (groupKey) {
    const groupEntry = RAW.cantons[groupKey];
    if (groupEntry) {
      const slug = groupEntry[locale] || groupEntry.it || groupKey;
      return slugToLabel(slug);
    }
  }
  return upper;
}

const SEARCH_TOKEN_LOCALES: ReadonlyArray<CantonLocale> = ['it', 'en', 'de', 'fr'];

/**
 * Locale-agnostic search tokens for a canton/group code: every distinct
 * localized canton name (e.g. `TI` → "ticino tessin", `BL` → "basilea
 * campagna basilea citta basel-landschaft bale-campagne"), lowercased and
 * space-joined. Returns `''` for empty/unknown codes.
 *
 * Why: a job stores only its CITY in `location` (e.g. "Bellinzona") and the
 * 2-letter `canton` code ("TI") — never the canton NAME. So a search whose
 * query carries the canton ("fust bellinzona ticino", a real related-search
 * cluster slug) could never satisfy the strict AND-match and was forced into
 * the fuzzy "Nessun risultato esatto" fallback even though the source job is a
 * Fust vacancy in Bellinzona/Ticino (issue #2967). Enriching the search
 * haystack with these tokens makes the canton name a first-class match term.
 *
 * Locale-agnostic on purpose: the SAME string is appended in every locale's
 * haystack so the SPA, the static cluster build plugin, and the off-thread
 * postings worker stay byte-identical (the lockstep contract), and a query in
 * any locale ("ticino"/"tessin") matches.
 */
export function cantonSearchTokens(code: string): string {
  const upper = String(code || '').toUpperCase();
  if (!upper) return '';
  const names = new Set<string>();
  for (const loc of SEARCH_TOKEN_LOCALES) {
    const label = getCantonLabel(upper, loc);
    // getCantonLabel echoes the code back when no localized name exists; skip
    // that so an unknown code contributes no junk token.
    if (label && label.toUpperCase() !== upper) names.add(label.toLowerCase());
  }
  return Array.from(names).join(' ');
}

export interface CantonOption {
  code: string;
  label: string;
}

/**
 * Locale-aware ordered list of canton options for UI rendering. Sorted by
 * the localised label so users see a familiar alphabetical order regardless
 * of the underlying ISO code order.
 */
export function listCantonOptions(locale: CantonLocale): CantonOption[] {
  return CANTON_CODES.map((code) => ({
    code,
    label: getCantonLabel(code, locale),
  })).sort((a, b) => a.label.localeCompare(b.label, locale));
}
