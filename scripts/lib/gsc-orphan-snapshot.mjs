const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const GSC_ORPHAN_HOSTS = new Set(['frontaliereticino.ch', 'www.frontaliereticino.ch']);

function parseGscOrphanUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported GSC orphan URL protocol: ${url.protocol}`);
  }
  if (!GSC_ORPHAN_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new Error(`Unsupported GSC orphan URL host: ${url.host}`);
  }
  return url;
}

/** Ignore URLs outside the verified GSC property before classifying CSV rows. */
export function isAllowedGscOrphanUrl(value) {
  try {
    parseGscOrphanUrl(value);
    return true;
  } catch {
    return false;
  }
}

/** Fail closed on malformed historical records instead of overwriting them. */
export function assertGscOrphanSnapshot(snapshot, {
  file,
  recordsKey,
  identityField,
  kinds,
  validateRoute,
  validateRecord,
}) {
  const records = snapshot?.[recordsKey];
  const valid = Array.isArray(snapshot?.sources)
    && snapshot.sources.every((source) => typeof source === 'string')
    && Array.isArray(records)
    && records.every((entry) => {
      if (!entry || !LOCALES.has(entry.locale)
        || typeof entry[identityField] !== 'string'
        || !entry[identityField]
        || typeof entry.csvOrigin !== 'string'
        || !entry.csvOrigin
        || typeof entry.url !== 'string'
        || !kinds.includes(entry.kind)) return false;
      try {
        parseGscOrphanUrl(entry.url);
        return (!validateRoute || validateRoute(entry) === true)
          && (!validateRecord || validateRecord(entry) === true);
      } catch {
        return false;
      }
    });
  if (!valid) throw new Error(`${file} has an invalid ${recordsKey} snapshot; refusing to overwrite it.`);
}

/** Normalize a reported URL to the route the static bridge emitter writes. */
export function gscOrphanRouteKey(entry) {
  let url;
  try { url = parseGscOrphanUrl(entry.url); } catch (error) {
    if (error?.message?.startsWith('Unsupported GSC orphan URL')) throw error;
    throw new Error(`Invalid GSC orphan URL: ${entry.url}`);
  }
  return gscOrphanPathKey(url.pathname);
}

/** Normalize an already parsed site pathname to the bridge's emitted route. */
export function gscOrphanPathKey(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')
    || pathname.includes('?') || pathname.includes('#') || pathname.includes(String.fromCharCode(92))) {
    throw new Error(`Invalid GSC orphan pathname: ${pathname}`);
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Invalid GSC orphan pathname: ${pathname}`);
  }
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/** Merge a limited GSC sample without treating absent URLs as recovered. */
export function mergeGscOrphanRecords(existing, incoming, routeKey = gscOrphanRouteKey) {
  const byRoute = new Map();
  for (const entry of [...existing, ...incoming]) byRoute.set(routeKey(entry), entry);
  return [...byRoute.values()];
}

/** Validate the path-based legacy-alias snapshot before replacing its data. */
export function assertGscLegacyAliasSnapshot(snapshot, { file, validateRoute }) {
  const aliases = snapshot?.aliases;
  const valid = Array.isArray(aliases)
    && aliases.every((entry) => {
      if (!entry || !LOCALES.has(entry.locale)
        || typeof entry.orphanPath !== 'string'
        || typeof entry.canonicalPath !== 'string'
        || !['matched', 'unmatched'].includes(entry.kind)
        || typeof entry.cohort !== 'string'
        || !entry.cohort) return false;
      try {
        return entry.orphanPath === gscOrphanPathKey(entry.orphanPath)
          && entry.canonicalPath === gscOrphanPathKey(entry.canonicalPath)
          && (!validateRoute || validateRoute(entry) === true);
      } catch {
        return false;
      }
    });
  if (!valid) throw new Error(`${file} has an invalid aliases snapshot; refusing to overwrite it.`);
}
