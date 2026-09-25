// build-plugins/shared/cantonResolvers.mjs
//
// Single source of truth for the canton URL-section + job→canton resolver
// logic. Pure and data-injected (no `fs`, no JSON import) so it loads unchanged
// in BOTH runtimes that need it:
//   • the Vite-bundled build-plugin context, via the typed shim
//     `cantonSection.ts` (which feeds the JSON it imports statically), and
//   • raw-`node` CI scripts, via
//     `scripts/migrate-all-known-job-slugs-canton-aware.mjs` (which reads the
//     JSON with `fs` and passes it in).
//
// Before this module the resolver logic existed as TWO literal copies — the
// migration script "mirrored" `cantonSection.ts` by hand. That left a silent
// drift risk (#1890): if the copies diverged on a future refactor, the slug
// registry migration and the active page-emit would resolve DIFFERENT canton
// sections → a non-TI job whose soft-landing is no longer skipped via
// `activeJobDirs` → wrong (TI) canonical. Keeping ONE implementation here makes
// that drift impossible by construction.
//
// Same shim pattern as `viteAssetHashRx.mjs` (+ its `.ts` re-export).

export const AGGREGATE_KEY = '_AGGREGATE_';

export const SECTION_LEGACY_TI = {
  it: 'cerca-lavoro-ticino', // cathedral-allow: canonical TI legacy section table (single source of truth)
  en: 'find-jobs-ticino', // cathedral-allow: canonical TI legacy section table (single source of truth)
  de: 'jobs-im-tessin', // cathedral-allow: canonical TI legacy section table (single source of truth)
  fr: 'trouver-emploi-tessin', // cathedral-allow: canonical TI legacy section table (single source of truth)
};

const SECTION_PREFIX_BY_LOCALE = {
  it: 'cerca-lavoro', en: 'find-jobs', de: 'jobs-in', fr: 'trouver-emploi',
};

// Normalize for city → canton lookup. NFD-decompose, strip combining diacritics
// (U+0300–U+036F), lowercase, trim. Matches input "Zurich" against stored
// "Zürich" so jobs whose `location` comes from a non-German source still
// resolve to ZH.
export function normalizeCityKey(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Bind the resolver logic to a set of reference data. Callers supply the parsed
 * `canton-url-slugs.json` and `canton-municipalities.json` (however their
 * runtime loads them) and receive the resolver functions.
 *
 * @param {{ cantonSlugFile: any, municipalitiesFile: any }} data
 */
export function createCantonResolvers({ cantonSlugFile, municipalitiesFile }) {
  const cantons = cantonSlugFile.cantons;
  const cantonGroups = cantonSlugFile.cantonGroups ?? {};
  const aggregateSlugs = cantonSlugFile.aggregate;

  const memberToGroup = {};
  for (const [group, info] of Object.entries(cantonGroups)) {
    for (const member of info.members) memberToGroup[member] = group;
  }

  function resolveCantonGroup(cantonCode) {
    const code = String(cantonCode || '').toUpperCase().trim();
    if (!code) return 'TI';
    return memberToGroup[code] ?? code;
  }

  function getCantonUrlSlug(code, locale) {
    if (code === AGGREGATE_KEY) return aggregateSlugs[locale] ?? aggregateSlugs.it;
    const entry = cantons[code];
    return entry?.[locale] ?? aggregateSlugs[locale] ?? aggregateSlugs.it;
  }

  function resolveCantonSection(locale, cantonCode) {
    const raw = String(cantonCode || '').toUpperCase();
    if (!raw || raw === 'TI') return SECTION_LEGACY_TI[locale];
    if (raw === AGGREGATE_KEY) {
      return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlug(AGGREGATE_KEY, locale)}`;
    }
    const code = resolveCantonGroup(raw);
    if (locale === 'de') {
      const entry = cantons[code];
      if (entry?.dePrefix) return `${entry.dePrefix}${entry.de}`;
    }
    return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlug(code, locale)}`;
  }

  const CITY_TO_CANTON = (() => {
    const out = {};
    const cantonsData = municipalitiesFile.cantons;
    for (const [canton, info] of Object.entries(cantonsData)) {
      for (const city of info.municipalities) {
        out[normalizeCityKey(city).split(' (')[0].trim()] = canton;
      }
    }
    return out;
  })();

  function resolveJobCanton(job) {
    const explicit = String(job.canton || '').toUpperCase().trim();
    if (explicit && (cantons[explicit] || memberToGroup[explicit])) {
      return resolveCantonGroup(explicit);
    }
    // German long form "Sankt X" → canonical "St. X" so it hits the same
    // municipality keys ("st. gallen", "st. margrethen") indexed below.
    // Cheap normalisation done once before splitting on commas/parens.
    const locRaw = normalizeCityKey(String(job.location || ''));
    const loc = locRaw.replace(/\bsankt\s+/g, 'st. ');
    // 1) Try the full city up to the first comma/paren (handles "Lugano, TI" → "lugano").
    const fullCity = loc.split(/[,(]/)[0].trim();
    if (fullCity && CITY_TO_CANTON[fullCity]) return resolveCantonGroup(CITY_TO_CANTON[fullCity]);
    // 2) Tokenize the remainder for compound locations like "Davos Klosters",
    //    "Aesch ZH", "Biel Bienne", etc. Walk tokens and first match wins.
    const tokens = loc.replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (CITY_TO_CANTON[token]) return resolveCantonGroup(CITY_TO_CANTON[token]);
      // Bare two-letter canton code embedded in the location string
      // (e.g. "Aesch ZH"). Cheap last-mile fallback before TI.
      const up = token.toUpperCase();
      if (cantons[up] || memberToGroup[up]) return resolveCantonGroup(up);
    }
    return 'TI';
  }

  const ALL_CANTON_CODES = Object.freeze(Object.keys(cantons).sort());

  return {
    resolveCantonGroup,
    getCantonUrlSlug,
    resolveCantonSection,
    resolveJobCanton,
    ALL_CANTON_CODES,
  };
}
