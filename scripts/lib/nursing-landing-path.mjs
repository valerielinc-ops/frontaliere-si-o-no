/**
 * Shared nursing landing routes and GSC orphan-query aliases.
 *
 * The build plugins are TypeScript, while the GSC/L2 jobs run directly in
 * Node. Keeping the route table here gives both sides the same canonical
 * target when an orphan query is already covered by a nursing landing.
 */

export const NURSING_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const NURSING_LANDING_IDS = Object.freeze(['nurses', 'oss', 'healthcare-ticino']);

export const NURSING_LOCALE_PREFIX = Object.freeze({
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
});

export const NURSING_LANDING_SLUGS = Object.freeze({
  it: Object.freeze({
    nurses: 'lavoro-infermieri-svizzera',
    oss: 'lavoro-oss-svizzera',
    'healthcare-ticino': 'lavoro-sanitario-ticino',
  }),
  en: Object.freeze({
    nurses: 'nursing-jobs-switzerland',
    oss: 'healthcare-assistant-jobs-switzerland',
    'healthcare-ticino': 'healthcare-jobs-ticino',
  }),
  de: Object.freeze({
    nurses: 'pflegejobs-schweiz',
    oss: 'pflegehilfe-jobs-schweiz',
    'healthcare-ticino': 'gesundheitsjobs-tessin',
  }),
  fr: Object.freeze({
    nurses: 'emplois-infirmiers-suisse',
    oss: 'emplois-aide-soignante-suisse',
    'healthcare-ticino': 'emplois-sante-tessin',
  }),
});

/**
 * Query slugs that are already served by the evergreen nursing landing.
 * These aliases are intentionally explicit: only unambiguous nursing intent
 * may bypass the generic orphan-query page generator.
 */
export const NURSING_ORPHAN_QUERY_TARGETS = Object.freeze({
  'nursing-jobs': Object.freeze({ locale: 'en', id: 'nurses' }),
  'nursing-jobs-in-switzerland': Object.freeze({ locale: 'en', id: 'nurses' }),
  'nursing-jobs-switzerland': Object.freeze({ locale: 'en', id: 'nurses' }),
  'nurse-jobs': Object.freeze({ locale: 'en', id: 'nurses' }),
  'nurse-jobs-in-switzerland': Object.freeze({ locale: 'en', id: 'nurses' }),
  'nurse-jobs-switzerland': Object.freeze({ locale: 'en', id: 'nurses' }),
});

export function buildNursingLandingPath(locale, id) {
  const prefix = NURSING_LOCALE_PREFIX[locale];
  const slug = NURSING_LANDING_SLUGS[locale]?.[id];
  if (typeof prefix !== 'string' || typeof slug !== 'string') {
    throw new Error(`unsupported nursing landing route: ${locale}/${id}`);
  }
  return `${prefix}/${slug}/`.replace(/\/+/gu, '/');
}

function queryAliasKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/gu, '-');
}

/**
 * Resolve an orphan cluster to an existing nursing landing, if it is an
 * explicit alias. `canonicalSlug` is checked first so historical clusters
 * remain routable even when their query text is no longer available.
 */
export function resolveNursingOrphanQueryTarget(canonicalQuery, canonicalSlug = '') {
  const keys = [String(canonicalSlug ?? '').trim().toLowerCase(), queryAliasKey(canonicalQuery)];
  for (const key of keys) {
    const target = NURSING_ORPHAN_QUERY_TARGETS[key];
    if (!target) continue;
    return {
      ...target,
      path: buildNursingLandingPath(target.locale, target.id),
    };
  }
  return null;
}
