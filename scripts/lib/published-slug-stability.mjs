/**
 * Stability of a job's published per-locale slug.
 *
 * Rule (SEO, ratified 2026-11-13): once a job's slug for a locale has been
 * served, that slug stays canonical. A writer may replace it only when
 *
 *   - the slot is empty, or
 *   - the slug was never served (no canonical URL with it ever reached a
 *     sitemap — `data/url-first-seen.json` — or the job is still held out of
 *     publication for translation), or
 *   - the job's IDENTITY no longer matches the slug: the slug carries neither
 *     the job's company nor its location any more (a real relocation, a
 *     declared brand relabel, a legacy slug without the company/location tail).
 *
 * A different TITLE is not an identity change. Title-derived rules — re-derive
 * when the slug no longer encodes the current title, fall back to the
 * employer's title when a translation drops words (`localeTitleDropsSourceWords`),
 * translate a slug that still copies another locale — apply to NEW slugs only.
 * The title a page shows may keep following its own quality rules
 * (`localizedJobDisplayTitle`); the URL does not.
 *
 * Why: `hardenJobLocaleFields` runs at deploy on `data/jobs.json` and re-derived
 * the source-locale slug from the current title whenever the slug no longer
 * matched it. The slice kept the indexed slug, the build published another
 * one, and the indexed URL became a noindex bridge (cippatrasporti-c38396f76831:
 * `servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso`, canonical
 * since 2026-09-02, 425 GSC impressions in 28 days, replaced by the
 * title-derived `customer-service-transport-specialist-cippa-trasporti-sa-chiasso`).
 *
 * Why the served-URL ledger and not the slice alone: on 2026-11-13 the same
 * deploy-time pass served a title-derived slug instead of the slice's for 3,286
 * locale slots, and for 2,516 of them the slice slug never reached a sitemap
 * while the derived one did (137 of those derived URLs have GSC impressions,
 * against 9 slice slugs). The slug that was SERVED is the published one; the
 * slice value is only the published one when it was served. Without the ledger
 * (a checkout that excludes it) the rule falls back to "slice slug present =
 * published", which is the conservative reading for the slice writers.
 *
 * Explicit slug DEFECT repairs (German/French trade words in an Italian slug,
 * boilerplate, garbled registry pin, low-quality or federal-placeholder slugs)
 * and the immutable slug-registry pin are not title re-derivations: callers
 * keep them outside this gate.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './read-large-json.mjs';
import { JOB_BOARD_COMPANY_HUB_PATH_RX } from './jobBoardCompanyHubPath.mjs';
import { slugify, slugTokenSet } from './regenerate-slugs-helpers.mjs';
import { loadFirstSeen, urlFirstSeenStorePaths } from './url-first-seen-store.mjs';
import {
  TRANSLATION_HOLD_RELEASED_FIELD,
  isHeldFromPublication,
} from './translation-publication-hold.mjs';

const DEFAULT_LEDGER_STORE = urlFirstSeenStorePaths(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
);
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
let jobBoardDetailPathMatcher;
let jobBoardDetailPathCore;

// This module is also imported by slug writers in script-only checkouts that
// omit build-plugins/ and the canton data. The detail-path core imports the
// shared canton resolver, so defer loading it until a present served-URL
// ledger actually needs route classification.
function getJobBoardDetailPathCore() {
  if (!jobBoardDetailPathCore) {
    jobBoardDetailPathCore = createRequire(import.meta.url)('./job-board-detail-path-core.mjs');
  }
  return jobBoardDetailPathCore;
}

function getJobBoardDetailPathMatcher() {
  if (!jobBoardDetailPathMatcher) {
    const { createJobBoardDetailPathMatcher } = getJobBoardDetailPathCore();
    jobBoardDetailPathMatcher = createJobBoardDetailPathMatcher({
      cantonSlugFile: readJsonFile(path.join(DATA_DIR, 'canton-url-slugs.json')),
      municipalitiesFile: readJsonFile(path.join(DATA_DIR, 'canton-municipalities.json')),
    });
  }
  return jobBoardDetailPathMatcher;
}

/**
 * An agency job held for translation is not published, and translate-pending
 * releases it (`release-translation-holds.mjs`) in the step right before it
 * regenerates the locale slugs: its slug is first published by that commit.
 * Six hours cover the release → regeneration window of one run and no more.
 */
export const RELEASED_HOLD_SLUG_WINDOW_MS = 6 * 60 * 60 * 1000;

function identityTokens(value) {
  return slugTokenSet(slugify(String(value || '')));
}

/**
 * Match the pathname form written by refresh-url-first-seen: leading slash,
 * no trailing slash. Keep case and locale prefixes exact so aliases cannot
 * stand in for a renderer-generated canonical path.
 *
 * @param {string} urlPath
 * @returns {string}
 */
export function normalizeServedPath(urlPath) {
  let clean = String(urlPath || '').trim();
  if (!clean.startsWith('/')) clean = `/${clean}`;
  clean = clean.replace(/\/index\.html$/, '').replace(/\/+$/, '');
  return clean || '/';
}

// Loaded on first use, like the ledger: the slug writers that import this
// module also run from script-only sandboxes and sparse checkouts that carry
// neither build-plugins/ nor the canton data, and only a lookup needs them.
let routeResolvers = null;
function cantonResolvers() {
  if (!routeResolvers) {
    const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
    const { SECTION_LEGACY_TI, createCantonResolvers } = createRequire(import.meta.url)('../../build-plugins/shared/cantonResolvers.mjs');
    routeResolvers = {
      SECTION_LEGACY_TI,
      ...createCantonResolvers({
        cantonSlugFile: JSON.parse(fs.readFileSync(path.join(dataDir, 'canton-url-slugs.json'), 'utf8')),
        municipalitiesFile: JSON.parse(fs.readFileSync(path.join(dataDir, 'canton-municipalities.json'), 'utf8')),
      }),
    };
  }
  return routeResolvers;
}

function normalizeCanonicalSlug(slug) {
  return String(slug ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

/**
 * The canonical detail paths a build serves for `job` in `locale` with
 * `slug`: the job's canton section — the formula of
 * `buildCanonicalJobDetailPath` (build-plugins/shared/jobDetailPath.ts, TS-only,
 * so mirrored here with the same `resolveJobCanton` + `resolveCantonSection`
 * resolvers). The only additional path is the Italian legacy-TI active-job
 * bridge emitted for a non-TI job when its slug equals `job.slug`; other
 * locale mirrors are not part of the active canonical-path contract. Detail
 * routes are always `/[locale/]<section>/<slug>/`: there is no city-nested
 * detail route. Exact paths ensure a different section, hub, company page,
 * pagination or article that shares only the last segment never counts.
 *
 * @param {string} locale
 * @param {string} slug
 * @param {object | null} job
 * @returns {string[]}
 */
export function jobDetailPathsFor(locale, slug, job = null) {
  const clean = normalizeCanonicalSlug(slug);
  if (!clean || !job || typeof job !== 'object' || !['it', 'en', 'de', 'fr'].includes(locale)) return [];
  const { SECTION_LEGACY_TI, resolveCantonSection, resolveJobCanton } = cantonResolvers();
  const canton = resolveJobCanton(job);
  const section = resolveCantonSection(locale, canton);
  const canonicalPath = normalizeServedPath(
    `/${locale === 'it' ? '' : `${locale}/`}${section}/${clean}/`,
  );
  const paths = [canonicalPath];

  // jobsSeoPagesPlugin emits this compatibility route only for the active IT
  // master slug of a non-TI job. The canonical renderer path remains the
  // canton-specific path above.
  if (locale === 'it' && canton !== 'TI' && normalizeCanonicalSlug(job.slug) === clean) {
    paths.push(normalizeServedPath(`/${SECTION_LEGACY_TI.it}/${clean}/`));
  }

  return [...new Set(paths)];
}

let ledgerCache = { path: null, index: undefined };

/**
 * Where the ledger lives for this call. `URL_FIRST_SEEN_PATH_OVERRIDE` points
 * tests at a fixture: a directory is read as a shard store, anything else as
 * the legacy single file.
 */
function ledgerLocation() {
  const override = process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
  if (!override) {
    return { key: DEFAULT_LEDGER_STORE.dir, dir: DEFAULT_LEDGER_STORE.dir, legacyFile: DEFAULT_LEDGER_STORE.legacyFile };
  }
  let isDirectory = false;
  try { isDirectory = fs.statSync(override).isDirectory(); } catch { /* absent: treated as a file path */ }
  return isDirectory
    ? { key: override, dir: override, legacyFile: null }
    : { key: override, dir: null, legacyFile: override };
}

/**
 * The served-URL ledger as normalized path → first date the URL reached a
 * sitemap. The ledger is `data/url-first-seen/<h>.json` (sharded: the single
 * file outgrew GitHub's 100 MB limit), written by every deploy
 * (`refresh-url-first-seen.mjs`) and monotonic; the legacy
 * `data/url-first-seen.json` is merged in while it still exists, earliest date
 * per path. `URL_FIRST_SEEN_PATH_OVERRIDE` points tests at a fixture.
 *
 * A checkout without the ledger returns null and the callers fall back to the
 * conservative slice reading. A ledger that IS there but cannot be read as an
 * object throws: silently falling back there would flip thousands of served
 * slugs back to never-served slice values in one deploy (measured 2026-11-13:
 * 3,286 locale slots), which is worse than a failed step. That includes ONE
 * unreadable shard, which would flip its sixteenth of them.
 *
 * @returns {Map<string, string> | null}
 */
export function loadServedSlugLedger() {
  const location = ledgerLocation();
  if (ledgerCache.path === location.key && ledgerCache.index !== undefined) return ledgerCache.index;
  const dirPresent = Boolean(location.dir) && fs.existsSync(location.dir);
  const legacyPresent = Boolean(location.legacyFile) && fs.existsSync(location.legacyFile);
  if (!dirPresent && !legacyPresent) {
    ledgerCache = { path: location.key, index: null };
    return null;
  }
  let raw;
  try {
    raw = loadFirstSeen({ dir: location.dir, legacyFile: location.legacyFile, strict: true }).entries;
  } catch (error) {
    throw new Error(`[published-slug-stability] served-URL ledger ${location.key} is present but unreadable: ${error?.message || error}`);
  }
  // Only job DETAIL routes enter the index. The parser validates the route
  // shape, the data-backed matcher rejects unknown sections and city hubs, and
  // the company matcher removes company pages. Keep the complete normalized
  // path as the key so lookups compare the route emitted for this job.
  const index = new Map();
  // An empty present ledger is known to contain no served routes, so it needs
  // no route-core (which is absent from script-only sparse checkouts).
  if (raw.size === 0) {
    ledgerCache = { path: location.key, index };
    return index;
  }
  const { parseJobBoardDetailPath } = getJobBoardDetailPathCore();
  for (const [urlPath, date] of raw) {
    const key = normalizeServedPath(urlPath);
    if (
      !parseJobBoardDetailPath(key)
      || JOB_BOARD_COMPANY_HUB_PATH_RX.test(key.toLowerCase())
      || !getJobBoardDetailPathMatcher()(key)
    ) continue;
    const prev = index.get(key);
    if (!prev || String(date) < prev) index.set(key, String(date));
  }
  ledgerCache = { path: location.key, index };
  return index;
}

/**
 * Whether one of the job's canonical `locale` detail URLs with `slug` was
 * ever served. null when the ledger is not available in this checkout.
 *
 * @param {string} locale
 * @param {string} slug
 * @param {object | null} [job]
 * @returns {boolean | null}
 */
export function slugWasServed(locale, slug, job = null) {
  const firstServedAt = slugFirstServedAt(locale, slug, job);
  if (firstServedAt === undefined) return null;
  return firstServedAt !== null;
}

/**
 * Earliest date on which one of the job's exact canonical detail paths was
 * served. `undefined` means the ledger is unavailable; `null` means the
 * ledger is present and none of the exact paths was served.
 *
 * Keeping those states distinct is required by the source-backed repair
 * writers: an absent ledger must stop the repair, while a present ledger may
 * prove that the slice slug was never public.
 *
 * @param {string} locale
 * @param {string} slug
 * @param {object | null} [job]
 * @returns {string | null | undefined}
 */
export function slugFirstServedAt(locale, slug, job = null) {
  const ledger = loadServedSlugLedger();
  if (!ledger) return undefined;
  let earliest = null;
  for (const detailPath of jobDetailPathsFor(locale, slug, job)) {
    const servedAt = ledger.get(detailPath);
    if (servedAt && (!earliest || String(servedAt) < earliest)) {
      earliest = String(servedAt);
    }
  }
  return earliest;
}

/**
 * True when `slug` still carries the identity of the job: at least one
 * company token (when the company has any) and at least one location token
 * (when the location has any). Tokens shorter than 3 chars and connectives are
 * ignored (`slugTokenSet`); location tokens shared with the company name count
 * for the location only, so "PUK Zürich" relabelled to "Psychiatrische
 * Universitätsklinik Zürich" in Zürich is an identity change.
 *
 * @param {string} slug
 * @param {{ company?: string, location?: string }} identity
 * @returns {boolean}
 */
export function publishedSlugKeepsIdentity(slug, { company = '', location = '' } = {}) {
  const clean = String(slug || '').trim();
  if (!clean) return false;
  const slugTokens = slugTokenSet(clean);
  const locationTokens = identityTokens(location);
  const companyTokens = new Set([...identityTokens(company)].filter((t) => !locationTokens.has(t)));
  if (companyTokens.size === 0 && locationTokens.size === 0) return false;
  const hasAny = (tokens) => tokens.size === 0 || [...tokens].some((t) => slugTokens.has(t));
  return hasAny(companyTokens) && hasAny(locationTokens);
}

/**
 * True when the job's slugs have not been served yet: it is held out of
 * publication for translation or — only for the translate-run regeneration
 * that follows `release-translation-holds.mjs` (`justReleased: true`) — it was
 * released from that hold moments ago. The deploy-time pass never gets the
 * release window: a slug it re-derived there would be served for six hours
 * and then flip back to the slice's.
 *
 * @param {object | null | undefined} job
 * @param {{ justReleased?: boolean, nowMs?: number }} [opts]
 * @returns {boolean}
 */
export function jobSlugsUnpublished(job, { justReleased = false, nowMs = Date.now() } = {}) {
  if (!job || typeof job !== 'object') return false;
  if (isHeldFromPublication(job)) return true;
  if (!justReleased) return false;
  const releasedAt = Date.parse(String(job[TRANSLATION_HOLD_RELEASED_FIELD] || ''));
  return Number.isFinite(releasedAt) && nowMs - releasedAt >= 0 && nowMs - releasedAt <= RELEASED_HOLD_SLUG_WINDOW_MS;
}

/**
 * Whether a writer may replace `currentSlug` with a title-derived slug.
 *
 * @param {string} currentSlug - the slug the locale has now ('' when missing)
 * @param {{ company?: string, location?: string }} identity
 * @param {{ job?: object | null, locale?: string, justReleased?: boolean, nowMs?: number }} [opts]
 * @returns {boolean}
 */
export function mayReplacePublishedSlug(
  currentSlug,
  identity = {},
  { job = null, locale = '', justReleased = false, nowMs } = {},
) {
  if (!String(currentSlug || '').trim()) return true;
  if (jobSlugsUnpublished(job, { justReleased, nowMs })) return true;
  if (locale && slugWasServed(locale, currentSlug, job) === false) return true;
  return !publishedSlugKeepsIdentity(currentSlug, identity);
}
