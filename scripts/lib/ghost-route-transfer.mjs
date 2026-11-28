/**
 * Route bookkeeping for the assembler's ghost pass (`reconcileGhostExpired`).
 *
 * Three rules:
 *  - no route at all moves unless both records declare for themselves a posting
 *    that nobody else declares differently (merge history, raw ids and
 *    fragment-less URL keys only find the candidate);
 *  - per-locale history moves to an active job only on proof that both records
 *    are the same single posting, from the identity each declares for ITSELF;
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
// A segment made of these words (plus LIST_FILLERS, `-` or `_` between, any
// extension) makes the path a search, a list or a filter. A title that merely
// contains one (`executive-search-consultant`) does not.
const LIST_WORDS = new Set([
  'categories', 'category', 'filter', 'filters', 'jobsearch', 'jobsuche', 'list', 'page',
  'recherche', 'result', 'results', 'ricerca', 'search', 'stellensuche', 'suche', 'tag', 'tags',
]);
const LIST_FILLERS = new Set(['job', 'jobs', 'stellen']);
// Search section seen in committed URLs that the words above do not spell.
const LIST_PHRASES = new Set(['suchen-und-bewerben']);
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

const PERCENT_RE = /%[0-9a-f]{2}/gi;
const DELIMITER_RE = /[/\\?#]/;

/**
 * The one normalisation every URL part goes through before it is classified:
 * percent-decode once, lowercase. `null` means doubt, and then nothing in the
 * URL is proof: bad or double encoding, a needlessly encoded letter, digit or
 * `-._~` (it can spell a word the rules look for), control characters, or
 * surrounding whitespace.
 */
function normalizePart(raw) {
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  const disguised = (raw.match(PERCENT_RE) || [])
    .some((code) => /[\w.~-]/.test(String.fromCharCode(parseInt(code.slice(1), 16))));
  if (disguised || decoded.match(PERCENT_RE) || /\p{Cc}/u.test(decoded) || decoded !== decoded.trim()) return null;
  return decoded.toLowerCase();
}

/**
 * Path segments without `;…` matrix parameters. A segment hiding a delimiter,
 * an empty one (`//`) and a `.`/`..` the URL parser left are doubt too.
 */
function normalizePath(path) {
  const trimmed = path.replace(/^\//, '').replace(/\/$/, '');
  if (!trimmed) return [];
  const segments = trimmed.split('/').map((raw) => {
    const part = normalizePart(raw);
    if (part === null || DELIMITER_RE.test(part)) return null;
    const name = part.split(';')[0];
    return ['', '.', '..'].includes(name) ? null : name;
  });
  return segments.includes(null) ? null : segments;
}

/** `[name, value]` pairs of a query or a parameter fragment. */
function normalizeParams(query) {
  const pairs = query.split('&').filter(Boolean).map((pair) => {
    const [name, ...value] = pair.replace(/\+/g, ' ').split('=');
    return [normalizePart(name), normalizePart(value.join('='))];
  });
  return pairs.some((pair) => pair.includes(null)) ? null : pairs;
}

/** Every part of a posting URL, normalised; `null` when any of them is doubtful. */
function normalizePostingUrl(href) {
  const { pathname, search, hash } = new URL(href);
  const fragment = hash.slice(1);
  // A hash route (`#/…`, `#offer/…`) is a path with its own query.
  const isRoute = /^(?:\/|(?:job|offer)\/)/i.test(fragment);
  const [route, ...routeQuery] = fragment.split('?');
  const parts = {
    path: normalizePath(pathname),
    query: normalizeParams(search.slice(1)),
    route: isRoute ? normalizePath(route) : [],
    fragment: normalizeParams(isRoute ? routeQuery.join('?') : fragment),
  };
  return Object.values(parts).includes(null) ? null : { ...parts, isRoute };
}

function isListSegment(name) {
  const stem = name.replace(/\.[a-z]{2,5}$/, '');
  const words = stem.split(/[-_]/);
  return LIST_PHRASES.has(stem) || (words.some((word) => LIST_WORDS.has(word))
    && words.every((word) => LIST_WORDS.has(word) || LIST_FILLERS.has(word)));
}

/**
 * A token in a path counts only under an explicit posting segment, for bare
 * numbers, slug+id and UUIDs alike: right after a JOB_SEGMENTS one, or in the
 * leaf below a POSTING_CONTEXT_SEGMENTS one. A bare-number leaf is also a page
 * or a filter value, so it must follow that segment or a hyphenated title.
 * Never in a search, list or filter path.
 */
function pathNamesPosting(segments) {
  if (segments.some(isListSegment)) return false;
  const endsInList = LIST_LEAVES.has(segments.at(-1));
  return segments.some((segment, index) => {
    const previous = segments[index - 1];
    if (!hasToken(segment) || OTHER_ID_SEGMENTS.has(previous)) return false;
    if (index < segments.length - 1) return !endsInList && JOB_SEGMENTS.has(previous);
    if (!segments.slice(0, index).some((name) => POSTING_CONTEXT_SEGMENTS.has(name))) return false;
    return !/^\d+(?:\.html?)?$/.test(segment)
      || POSTING_CONTEXT_SEGMENTS.has(previous) || /[-_]/.test(previous);
  });
}

function paramNamesPosting(params) {
  return params.some(([name, value]) => (
    POSTING_PARAMS.has(name.replace(/[._-]/g, '')) && !DELIMITER_RE.test(value) && hasToken(value)
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
  const url = href && normalizePostingUrl(href);
  if (!url) return false;
  if (pathNamesPosting(url.path) || paramNamesPosting(url.query)) return true;
  return url.isRoute ? pathNamesPosting(url.route) : paramNamesPosting(url.fragment);
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

/** Title, company and location: what every declarer of one posting must share. */
export function postingMetadataKey(job) {
  // JSON, not a joined string: a delimiter inside a field must not merge two tuples.
  return JSON.stringify([job.title, job.company, job.location].map((value) => (value || '').toLowerCase().trim()));
}

/** A trailing slash on the path names the same page; query, hash and case do not change. */
function declarerKey(identity) {
  if (!identity.startsWith('url:')) return identity;
  const url = new URL(identity.slice(4));
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `url:${url.href}`;
}

/**
 * Index who declares each identity, across the active and archived corpus. Both
 * answers need one identity the two records declare for themselves, with
 * `active` as its only active declarer.
 *  - `sameDeclaredPosting`: enough to move current and flat slugs. A trailing
 *    slash may differ, and no third title, company or location may declare the
 *    identity (the two records may differ: a title in another language).
 *  - `sameSinglePosting`: needed for per-locale history. Every declarer has the
 *    same title, company and location, and the identity is written identically
 *    and carries a single-posting token.
 */
export function createPostingProof(activeJobs, archivedJobs) {
  const declarers = new Map();
  const register = (record, isActive) => {
    for (const key of new Set([...ownPostingIdentities(record)].map(declarerKey))) {
      let entry = declarers.get(key);
      if (!entry) declarers.set(key, entry = { actives: 0, keys: new Set() });
      if (isActive) entry.actives += 1;
      entry.keys.add(postingMetadataKey(record));
    }
  };
  for (const job of activeJobs) register(job, true);
  for (const job of archivedJobs) register(job, false);

  const soleActive = (key) => (declarers.get(key)?.actives === 1 ? declarers.get(key) : null);

  return {
    sameDeclaredPosting(archived, active) {
      const activeKeys = new Set([...ownPostingIdentities(active)].map(declarerKey));
      const pair = new Set([postingMetadataKey(archived), postingMetadataKey(active)]);
      return [...ownPostingIdentities(archived)].map(declarerKey).some((key) => {
        const entry = activeKeys.has(key) && soleActive(key);
        return Boolean(entry) && [...entry.keys].every((metadata) => pair.has(metadata));
      });
    },
    sameSinglePosting(archived, active) {
      const activeIdentities = ownPostingIdentities(active);
      return [...ownPostingIdentities(archived)].some((identity) => (
        activeIdentities.has(identity) && hasSinglePostingToken(identity)
          && soleActive(declarerKey(identity))?.keys.size === 1
      ));
    },
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
 * evicting anything. The caller has shown that both are one posting
 * (`sameDeclaredPosting`, or neither declares any identity). Current slugs and
 * flat-only slugs then travel; the per-locale history only when `proven`.
 * Without proof it is assigned to nobody, including its copies in the flat `previousSlugs` union. Returns the number of
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
