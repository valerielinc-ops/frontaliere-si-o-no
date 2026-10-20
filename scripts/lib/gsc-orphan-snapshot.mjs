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
  const segments = url.pathname.split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/** Merge a limited GSC sample without treating absent URLs as recovered. */
export function mergeGscOrphanRecords(existing, incoming) {
  const byRoute = new Map();
  for (const entry of [...existing, ...incoming]) byRoute.set(gscOrphanRouteKey(entry), entry);
  return [...byRoute.values()];
}
