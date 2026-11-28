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

// Segments after which the next one names a posting, whether or not it is the leaf.
const JOB_SEGMENTS = new Set(['job', 'jobs', 'offer', 'position', 'vacancy', 'vacancies']);
// A token in the leaf needs one of these above it. The additions to
// JOB_SEGMENTS are the ones seen in committed posting URLs.
const POSTING_CONTEXT_SEGMENTS = new Set([
  ...JOB_SEGMENTS,
  'emplois', 'job-advertisement', 'job-detail', 'job-posting-page', 'job-vacancies', 'jobdetail',
  'offene-stellen', 'open-jobs', 'postes-vacantes', 'postes-vacants', 'posti-vacanti', 'stellen',
  'stellenangebot',
]);
// A path with one of these anywhere is a search, a list or a filter.
const LIST_SEGMENTS = new Set([
  'categories', 'category', 'filter', 'filters', 'job-search', 'list', 'page', 'results', 'search',
  'tag', 'tags',
]);
// A path ending in one of these is a list too.
const LIST_LEAVES = new Set(['jobs', 'vacancies']);
// A segment with one of these names says the next one is not a posting.
const OTHER_ID_SEGMENTS = new Set([
  'board', 'category', 'client', 'companies', 'company', 'department', 'employer', 'location', 'org',
  'organisation', 'organization', 'plz', 'postalcode', 'postcode', 'session', 'sid', 'team',
  'tenant', 'token', 'widget', 'widgetid', 'zip',
]);
// Query or fragment names (without `.`, `_`, `-`) that identify a posting.
const POSTING_PARAMS = new Set([
  'ghjid', 'id', 'jid', 'jobid', 'offerid', 'positionid', 'postingid', 'reqid', 'requisitionid', 'vacancyid',
]);

const hasToken = (value) => UUID_RE.test(value) || LONG_NUMBER_RE.test(value) || LONG_HEX_RE.test(value);

/**
 * A token in a path counts only under an explicit posting segment, for bare
 * numbers, slug+id and UUIDs alike: right after a JOB_SEGMENTS one, or in the
 * leaf below a POSTING_CONTEXT_SEGMENTS one. A bare-number leaf is also a page
 * or a filter value, so it must follow that segment or a hyphenated title.
 * Never in a search, list or filter path. `;…` matrix parameters are ignored.
 */
function pathNamesPosting(path) {
  const segments = path.split('/').map((segment) => segment.split(';')[0]).filter(Boolean);
  const names = segments.map((segment) => segment.toLowerCase());
  if (names.some((name) => LIST_SEGMENTS.has(name))) return false;
  const endsInList = LIST_LEAVES.has(names.at(-1));
  return segments.some((segment, index) => {
    const previous = names[index - 1];
    if (!hasToken(segment) || OTHER_ID_SEGMENTS.has(previous)) return false;
    if (index < segments.length - 1) return !endsInList && JOB_SEGMENTS.has(previous);
    if (!names.slice(0, index).some((name) => POSTING_CONTEXT_SEGMENTS.has(name))) return false;
    return !/^\d+(?:\.html?)?$/i.test(segment)
      || POSTING_CONTEXT_SEGMENTS.has(previous) || /[-_%]/.test(previous);
  });
}

function paramNamesPosting(params) {
  return [...params].some(([name, value]) => (
    POSTING_PARAMS.has(name.toLowerCase().replace(/[._-]/g, '')) && hasToken(value)
  ));
}

/**
 * Whether an identity carries a token that names one posting. In a URL the token
 * must sit in the path as pathNamesPosting reads it, in a posting-id parameter,
 * or in a hash route or parameter read the same way: a host, a tenant folder, a session
 * or tracking value and a postal-code filter are all shared by a listing's
 * postings. An `id:` identity is judged whole. A careers listing page
 * (`…/it/jobs`) has no such token. Four digits are not enough: they are as often
 * a year or a postal code. `mergeUrlKey` is not reused: it reads a token from
 * any query parameter and misses five-digit ids such as `/job/12345`.
 */
export function hasSinglePostingToken(value) {
  if (!value.startsWith('url:')) return hasToken(value);
  const href = sourcePostingUrlHref(value.slice(4));
  if (!href) return false;
  const { pathname, searchParams, hash } = new URL(href);
  if (pathNamesPosting(pathname) || paramNamesPosting(searchParams)) return true;
  const fragment = hash.slice(1);
  return /^(?:\/|(?:job|offer)\/)/i.test(fragment)
    ? pathNamesPosting(fragment.split('?')[0])
    : paramNamesPosting(new URLSearchParams(fragment));
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
