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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './read-large-json.mjs';
import { slugify, slugTokenSet } from './regenerate-slugs-helpers.mjs';
import {
  TRANSLATION_HOLD_RELEASED_FIELD,
  isHeldFromPublication,
} from './translation-publication-hold.mjs';

const DEFAULT_LEDGER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'url-first-seen.json',
);

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

function pathLocale(urlPath) {
  if (urlPath.startsWith('/en/')) return 'en';
  if (urlPath.startsWith('/de/')) return 'de';
  if (urlPath.startsWith('/fr/')) return 'fr';
  return 'it';
}

let ledgerCache = { path: null, index: undefined };

/**
 * The served-URL ledger as `locale|slug` → first date a canonical URL ending in
 * that slug reached a sitemap. `data/url-first-seen.json` is written by every
 * deploy (`refresh-url-first-seen.mjs`) and is monotonic. Returns null when the
 * file is not in this checkout or unreadable. `URL_FIRST_SEEN_PATH_OVERRIDE`
 * points tests at a fixture.
 *
 * @returns {Map<string, string> | null}
 */
export function loadServedSlugLedger() {
  const ledgerPath = process.env.URL_FIRST_SEEN_PATH_OVERRIDE || DEFAULT_LEDGER_PATH;
  if (ledgerCache.path === ledgerPath && ledgerCache.index !== undefined) return ledgerCache.index;
  let index = null;
  try {
    if (fs.existsSync(ledgerPath)) {
      const raw = readJsonFile(ledgerPath);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        index = new Map();
        for (const [urlPath, date] of Object.entries(raw)) {
          const segments = urlPath.split('/').filter(Boolean);
          if (segments.length < 2) continue;
          const key = `${pathLocale(urlPath)}|${segments[segments.length - 1]}`;
          const prev = index.get(key);
          if (!prev || String(date) < prev) index.set(key, String(date));
        }
      }
    }
  } catch {
    index = null;
  }
  ledgerCache = { path: ledgerPath, index };
  return index;
}

/**
 * Whether a canonical `locale` URL ending in `slug` was ever served.
 * null when the ledger is not available in this checkout.
 *
 * @param {string} locale
 * @param {string} slug
 * @returns {boolean | null}
 */
export function slugWasServed(locale, slug) {
  const ledger = loadServedSlugLedger();
  if (!ledger) return null;
  const clean = String(slug || '').trim();
  if (!clean || !locale) return false;
  return ledger.has(`${locale}|${clean}`);
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
  if (locale && slugWasServed(locale, currentSlug) === false) return true;
  return !publishedSlugKeepsIdentity(currentSlug, identity);
}
