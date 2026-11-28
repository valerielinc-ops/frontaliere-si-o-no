/**
 * Route bookkeeping for the assembler's ghost pass (`reconcileGhostExpired`).
 *
 * Two rules:
 *  - history moves to an active job only on proof that both records are the same
 *    single posting, from the identity each record declares for ITSELF;
 *  - nothing is ever evicted to make room. What does not fit stays on the
 *    archive record, which the caller then keeps.
 */
import {
  addPreviousSlugForLocale,
  promotePreviousSlugToLegacy,
  DEFAULT_PREV_SLUG_CAP,
  LEGACY_PREV_SLUGS_CAP,
} from './dedicated-crawler-common.mjs';
import { localeRouteKeys } from './expired-jobs-archive.mjs';
import { sourcePostingUrlHref } from './job-identity.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'];
const SOURCE = 'assemble-jobs-dataset.reconcileGhostExpired';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_NUMBER_RE = /\d{5,}/;
const LONG_HEX_RE = /(?<![0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}(?![0-9a-z])/i;

/**
 * Whether an identity carries a token that names one posting. A careers listing
 * page (`…/it/jobs`) has none, and every posting read from it shares its URL.
 * Four digits are not enough: they are as often a year or a postal code.
 */
export function hasSinglePostingToken(value) {
  return UUID_RE.test(value) || LONG_NUMBER_RE.test(value) || LONG_HEX_RE.test(value);
}

/**
 * Identities a record declares for itself: its own `url` and `sourceIdentity`.
 * `sourceIdentityHistory` is left out on purpose — dedup merges accumulate the
 * identities of other postings there. URL comparison keeps case, query and
 * fragment. The raw crawler `id` is left out too: it can be derived from a
 * listing page or a title.
 */
export function ownPostingIdentities(record = {}) {
  const identities = new Set();
  const declared = String(record?.sourceIdentity ?? '').trim();
  for (const url of [record?.url, declared.startsWith('url:') ? declared.slice(4) : '']) {
    const href = sourcePostingUrlHref(String(url ?? '').trim());
    if (href) identities.add(`url:${href}`);
  }
  if (/^id:/iu.test(declared)) identities.add(`id:${declared.slice(3).trim().toLowerCase()}`);
  return identities;
}

/**
 * Index who declares each identity, across the active and archived corpus.
 * Returns `sameSinglePosting(archived, active, metadataKey)`: true only when
 * both name one identity with a single-posting token, `active` is its only
 * active declarer, and every declarer has the same title, company and location.
 */
export function createSinglePostingProof(activeJobs, archivedJobs, metadataKey) {
  const declarers = new Map();
  const register = (record, isActive) => {
    for (const identity of ownPostingIdentities(record)) {
      let entry = declarers.get(identity);
      if (!entry) declarers.set(identity, entry = { actives: 0, keys: new Set() });
      if (isActive) entry.actives += 1;
      entry.keys.add(metadataKey(record));
    }
  };
  for (const job of activeJobs) register(job, true);
  for (const job of archivedJobs) register(job, false);

  return (archived, active) => {
    const activeIdentities = ownPostingIdentities(active);
    return [...ownPostingIdentities(archived)].some((identity) => {
      if (!activeIdentities.has(identity) || !hasSinglePostingToken(identity)) return false;
      const entry = declarers.get(identity);
      return entry?.actives === 1 && entry.keys.size === 1;
    });
  };
}

function flatUnion(job, slug) {
  const union = new Set(Array.isArray(job.previousSlugs) ? job.previousSlugs : []);
  for (const values of Object.values(job.previousSlugsByLocale || {})) {
    if (Array.isArray(values)) for (const value of values) union.add(value);
  }
  union.add(slug);
  return union;
}

/**
 * Add one locale history route unless that would push another route out: either
 * the locale bucket or the flat union the helper keeps in sync is full.
 */
export function addGhostSlugWithoutEviction(job, locale, slug, source = SOURCE) {
  const bucket = job.previousSlugsByLocale?.[locale];
  if (Array.isArray(bucket) && !bucket.includes(slug) && bucket.length >= DEFAULT_PREV_SLUG_CAP) return false;
  if (flatUnion(job, slug).size > LEGACY_PREV_SLUGS_CAP) return false;
  addPreviousSlugForLocale(job, locale, slug, DEFAULT_PREV_SLUG_CAP, source);
  return true;
}

function isInSomeBucket(job, slug) {
  return LOCALES.some((locale) => job.previousSlugsByLocale?.[locale]?.includes(slug));
}

/**
 * Carry the ghost's flat-only slugs (locale unknown, served under all four) as
 * flat-only: banking them under one locale would drop the other three routes.
 */
function transferUnattributedSlugs(match, ghost, added) {
  const unattributed = new Set(
    (ghost.previousSlugs || []).filter((slug) => slug && !isInSomeBucket(ghost, slug)),
  );
  for (const slug of unattributed) {
    // Already attributed to a locale on the match: do not widen or narrow it.
    if (isInSomeBucket(match, slug)) continue;
    const served = localeRouteKeys(match);
    if (LOCALES.every((locale) => served.has(`${locale}:${slug}`))) continue;
    if (flatUnion(match, slug).size > LEGACY_PREV_SLUGS_CAP) continue;
    promotePreviousSlugToLegacy(match, slug, LEGACY_PREV_SLUGS_CAP, SOURCE);
    added.add(slug);
  }
}

/** The ghost's live routes: its locale slugs, and the master slug when it is the Italian one. */
function currentRoutes(ghost) {
  const routes = Object.entries(ghost.slugByLocale || {}).filter(([locale]) => LOCALES.includes(locale));
  if (!ghost.slugByLocale?.it && ghost.slug) routes.push(['it', ghost.slug]);
  return routes;
}

/** Per-locale history. Only the proven path may call this. */
function historyRoutes(ghost) {
  return LOCALES.flatMap((locale) => (ghost.previousSlugsByLocale?.[locale] || []).map((slug) => [locale, slug]));
}

/**
 * Copy a ghost's routes to its active match, each under its own locale, without
 * evicting anything. Current slugs and flat-only slugs always travel; the
 * per-locale history only when `proven`. Without proof it is assigned to nobody,
 * including its copies in the flat `previousSlugs` union. Returns the number of
 * distinct slugs added (one slug can fill several locale routes).
 */
export function mergeGhostRoutes(match, ghost, { proven = false } = {}) {
  const added = new Set();
  transferUnattributedSlugs(match, ghost, added);
  const routes = proven ? [...currentRoutes(ghost), ...historyRoutes(ghost)] : currentRoutes(ghost);
  for (const [locale, slug] of routes) {
    if (!slug || localeRouteKeys(match).has(`${locale}:${slug}`)) continue;
    if (addGhostSlugWithoutEviction(match, locale, slug)) added.add(slug);
  }
  return added.size;
}

/**
 * Whether every route `record` serves is served by the active dataset: by its
 * match, or by the job a later ownership pass moved the route to. `activeRoutes`
 * is only asked for when the match alone does not cover the record.
 */
export function holdsEveryRoute(match, record, activeRoutes) {
  if (!match) return false;
  const held = localeRouteKeys(match);
  const missing = [...localeRouteKeys(record)].filter((route) => !held.has(route));
  if (missing.length === 0) return true;
  const everywhere = activeRoutes();
  return missing.every((route) => everywhere.has(route));
}
