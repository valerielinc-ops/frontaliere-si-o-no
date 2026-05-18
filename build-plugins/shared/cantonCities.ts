import municipalitiesFile from '../../data/canton-municipalities.json';
import cantonSlugFile from '../../data/canton-url-slugs.json';

type CityFile = { cantons: Record<string, { municipalities: string[] }> };
const data = municipalitiesFile as CityFile;

// Half-canton URL groups (BL+BS → BASILEA, AI+AR → APPENZELLO, see
// data/canton-url-slugs.json `cantonGroups`). Router parses URLs like
// `/cerca-lavoro-basilea/basel/` with `jobBoardCanton: 'BASILEA'`, but
// canton-municipalities.json keys jobs by real BFS codes (BS, BL, …).
// Without expansion, `getCantonCities('BASILEA')` would return [] and
// `isKnownCityHub('basel', 'BASILEA')` would falsely return false —
// the bug where SPA clicks on canton-index city links land on the
// "Annuncio non trovato" view while new-tab opens work (because the
// static HTML for the city page exists in dist/).
const GROUP_TO_MEMBERS: Record<string, readonly string[]> = (() => {
  const out: Record<string, readonly string[]> = {};
  const groups = (cantonSlugFile as { cantonGroups?: Record<string, { members?: readonly string[] }> }).cantonGroups ?? {};
  for (const [group, info] of Object.entries(groups)) {
    if (info?.members?.length) out[group.toUpperCase()] = info.members.map((m) => String(m).toUpperCase());
  }
  return out;
})();

// ASCII-fold city names so canton-aware helpers expose URL-safe, display-stable
// strings. The source data preserves native spelling ("Zürich"), but cathedral
// emitters and tests work with the unaccented form ("Zurich"). Removing diacritics
// at the API boundary keeps every downstream consumer (slug emission, display,
// lookup) operating in a single normalized space. TI municipalities are entirely
// ASCII so this is a no-op for the legacy invariance set.
function asciiFold(s: string): string {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const CANTON_TO_CITIES: Record<string, string[]> = Object.fromEntries(
  Object.entries(data.cantons).map(([canton, info]) => [
    canton,
    info.municipalities.map(asciiFold),
  ])
);

// Normalize a city name to its lookup key: NFD-decompose, strip combining diacritics,
// lowercase, trim. This makes lookups insensitive to umlauts/accents so user inputs
// like "Zurich" (no umlaut) match stored values like "Zürich".
function normalizeForLookup(s: string): string {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Two-tier lookup: (1) disambiguated form `aesch (zh)` → 'ZH', (2) bare `aesch` ONLY
// stored when unambiguous (a single canton has it). Cities listed in multiple cantons
// only resolve via the disambiguated form. Prevents the Aesch (BL/LU/ZH) bug where
// first-write-wins on lowercase silently returned the wrong canton.
const CITY_TO_CANTON_DISAMBIGUATED: Record<string, string> = {};
const CITY_TO_CANTON_BARE: Record<string, string | 'AMBIGUOUS'> = {};
for (const [canton, cities] of Object.entries(CANTON_TO_CITIES)) {
  for (const city of cities) {
    const norm = normalizeForLookup(city);
    // disambiguated form (with parenthetical)
    if (norm.includes(' (')) CITY_TO_CANTON_DISAMBIGUATED[norm] = canton;
    // bare form (without parenthetical)
    const bare = norm.split(' (')[0].trim();
    if (!CITY_TO_CANTON_BARE[bare]) {
      CITY_TO_CANTON_BARE[bare] = canton;
    } else if (CITY_TO_CANTON_BARE[bare] !== canton) {
      CITY_TO_CANTON_BARE[bare] = 'AMBIGUOUS';
    }
  }
}

export function getCantonCities(canton: string): string[] {
  const key = String(canton).toUpperCase();
  const direct = CANTON_TO_CITIES[key];
  if (direct) return direct;
  // Virtual URL group (BASILEA, APPENZELLO): union of member-canton cities.
  const members = GROUP_TO_MEMBERS[key];
  if (members) {
    return members.flatMap((m) => CANTON_TO_CITIES[m] ?? []);
  }
  return [];
}

export function getCityCanton(city: string): string | null {
  const norm = normalizeForLookup(city);
  // 1. Try exact disambiguated form first (e.g. 'aesch (zh)' → ZH)
  if (CITY_TO_CANTON_DISAMBIGUATED[norm]) return CITY_TO_CANTON_DISAMBIGUATED[norm];
  // 2. Try bare form — but only if unambiguous (single canton claims it)
  const bare = norm.split(' (')[0].trim();
  const hit = CITY_TO_CANTON_BARE[bare];
  if (hit && hit !== 'AMBIGUOUS') return hit;
  return null;
}

export function normalizeCitySlug(city: string): string {
  return String(city)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\([a-z]+\)/g, '')             // strip (zh), (bl), etc. from slug
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
