/**
 * Shared parser for the related-search cluster URL family.
 *
 * The refresh job and the build plugin consume the same indexed-path dataset.
 * Keeping the grammar and canonicalisation here prevents either side from
 * bucketing one observed URL differently from the other.
 */

const CLUSTER_PATH_HEAD =
  '^/(?:(en|de|fr)/)?(?:cerca-lavoro|find-jobs|jobs-im|jobs-in|jobs-in-der|trouver-emploi)-';
const CLUSTER_PATH_TAIL =
  '[a-z-]+/((?:ricerca|search|suche|recherche)-[a-z0-9-]+)/?$';

const MIRROR_CLUSTER_PATH_RX = new RegExp(
  CLUSTER_PATH_HEAD
    + '(?!svizzera(?:/|$)|switzerland(?:/|$)|schweiz(?:/|$)|suisse(?:/|$))'
    + CLUSTER_PATH_TAIL,
  'i',
);
const ANY_CLUSTER_PATH_RX = new RegExp(CLUSTER_PATH_HEAD + CLUSTER_PATH_TAIL, 'i');

function pathnameOf(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let pathname = trimmed;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    try {
      pathname = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  } else if (trimmed.startsWith('//')) {
    try {
      pathname = new URL('https:' + trimmed).pathname;
    } catch {
      return null;
    }
  }

  const queryOrHash = pathname.search(/[?#]/);
  if (queryOrHash !== -1) pathname = pathname.slice(0, queryOrHash);
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  return pathname;
}

function slashAndLowercase(value) {
  const pathname = pathnameOf(value);
  if (!pathname) return null;
  const withSlash = pathname.endsWith('/') ? pathname : pathname + '/';
  return withSlash.toLowerCase();
}

/**
 * Canonicalise and validate a non-aggregator related-search cluster path.
 * Returns null for unsupported or aggregator paths.
 */
export function normalizeRelatedSearchClusterPath(value) {
  const normalized = slashAndLowercase(value);
  return normalized && MIRROR_CLUSTER_PATH_RX.test(normalized) ? normalized : null;
}

/** Parse a non-aggregator path into the key used by the indexed URL map. */
export function parseRelatedSearchClusterPathKey(value) {
  const normalized = normalizeRelatedSearchClusterPath(value);
  if (!normalized) return null;
  const match = MIRROR_CLUSTER_PATH_RX.exec(normalized);
  if (!match) return null;
  return { locale: match[1] || 'it', slug: match[2] };
}

/** Parse any related-search cluster path, including the aggregate section. */
export function relatedSearchClusterKeyFromAnyPath(value) {
  const normalized = slashAndLowercase(value);
  if (!normalized) return null;
  const match = ANY_CLUSTER_PATH_RX.exec(normalized);
  if (!match) return null;
  return (match[1] || 'it') + '::' + match[2];
}
