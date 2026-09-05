/**
 * Per-crawler expired-jobs archival.
 *
 * Dedicated crawlers refetch the upstream ATS each run and overwrite their
 * `data/jobs/by-crawler/<key>.json` slice with the current vacancies. When a
 * job disappears from upstream (vacancy filled, listing removed) it is
 * dropped from the slice silently — `mergePreserveLocaleData` iterates only
 * the fresh batch, so any prior entry not present in the new fetch is gone.
 *
 * Without archival, indexed-by-Google detail URLs (and their previousSlug
 * bridges) 404 on the next deploy instead of rendering JobExpiredView. This
 * module captures those drops into `data/jobs/expired/by-crawler/<key>.json`
 * so the build plugin can emit the soft-landing page.
 *
 * Shape of an expired entry mirrors `cleanup-jobs.mjs:buildExpiredEntry`
 * so both code paths produce the same on-disk format.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-write-json.mjs';
import { compareExpiredAt } from './compare-expired-at.mjs';
import {
  addPreviousSlugForLocale,
  DEFAULT_PREV_SLUG_CAP,
  getPreviousSlugsForLocale,
  LOCALES,
  promotePreviousSlugToLegacy,
} from './dedicated-crawler-common.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_EXPIRED_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');

/**
 * Build an expired-job archive entry from a job object. Preserves the fields
 * the build plugin needs to render an enriched JobExpiredView under any
 * locale prefix (slugByLocale, descriptionByLocale, previousSlugs, salary +
 * address). Mirrors `scripts/cleanup-jobs.mjs:buildExpiredEntry` byte for byte.
 *
 * @param {object} job
 * @returns {object} expired entry
 */
export function buildExpiredEntry(job) {
  const entry = {
    slug: job.slug,
    title: job.title || '',
    titleByLocale: job.titleByLocale || {},
    company: job.company || '',
    companyKey: job.companyKey || '',
    location: job.location || '',
    addressLocality: job.addressLocality || '',
    descriptionByLocale: job.descriptionByLocale || {},
    slugByLocale: job.slugByLocale || {},
    sector: job.sector || '',
    expiredAt: new Date().toISOString(),
    previousSlugs:
      Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0
        ? [...job.previousSlugs]
        : undefined,
    previousSlugsByLocale:
      job.previousSlugsByLocale &&
      typeof job.previousSlugsByLocale === 'object' &&
      Object.keys(job.previousSlugsByLocale).length > 0
        ? JSON.parse(JSON.stringify(job.previousSlugsByLocale))
        : undefined,
    postalCode: job.postalCode || '',
    streetAddress: job.streetAddress || '',
    salaryMin: job.salaryMin || null,
    salaryMax: job.salaryMax || null,
    salaryCurrency: job.salaryCurrency || 'CHF',
    salaryPeriod: job.salaryPeriod || 'YEAR',
    dedupArchive: job.dedupArchive === true ? true : undefined,
  };
  if (!entry.postalCode) delete entry.postalCode;
  if (!entry.streetAddress) delete entry.streetAddress;
  if (!entry.salaryMin) delete entry.salaryMin;
  if (!entry.salaryMax) delete entry.salaryMax;
  if (entry.dedupArchive !== true) delete entry.dedupArchive;
  return entry;
}

/**
 * Archive removed jobs to a per-crawler expired slice file.
 *
 * Merges with any existing entries by `slug`, keeping the most-recently
 * expired entry per slug. Skips jobs without a slug (no static page to land
 * on). Returns the number of newly-added entries; zero means the on-disk
 * file is unchanged.
 *
 * @param {object[]} removedJobs - Full job objects (NOT `{ id }` refs)
 * @param {string} crawlerKey
 * @param {object} [opts]
 * @param {string} [opts.dir] - Override directory (default: data/jobs/expired/by-crawler)
 * @returns {number} added count
 */
export function archiveRemovedJobsToSlice(removedJobs, crawlerKey, opts = {}) {
  if (!crawlerKey) return 0;
  if (!Array.isArray(removedJobs) || removedJobs.length === 0) return 0;

  const dir = opts.dir || DEFAULT_EXPIRED_SLICES_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const slicePath = path.join(dir, `${crawlerKey}.json`);

  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
  } catch {
    existing = [];
  }

  const bySlug = new Map();
  for (const ej of existing) {
    if (ej?.slug) bySlug.set(ej.slug, ej);
  }
  const sizeBefore = bySlug.size;

  let added = 0;
  for (const job of removedJobs) {
    if (!job?.slug) continue;
    const entry = buildExpiredEntry(job);
    const prev = bySlug.get(entry.slug);
    if (!prev) {
      bySlug.set(entry.slug, entry);
      added++;
    } else if (compareExpiredAt(entry.expiredAt, prev.expiredAt) >= 0) {
      bySlug.set(entry.slug, entry);
    }
  }

  if (added === 0 && bySlug.size === sizeBefore) return 0;

  const archived = collapseDuplicateRouteEntries(
    [...bySlug.values()].sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt)),
    { source: 'archive-removed-jobs-to-slice' },
  ).entries;
  writeJsonAtomic(slicePath, archived);
  return added;
}

/** Every locale-qualified URL token served by an active or expired record. */
export function localeRouteKeys(job = {}) {
  const routes = new Set();
  for (const locale of LOCALES) {
    const localeSlug = job.slugByLocale?.[locale];
    const current = localeSlug || (locale === 'it' ? job.slug : '');
    if (current) routes.add(`${locale}:${current}`);
    if (locale === 'it' && job.slug && (!localeSlug || localeSlug === job.slug)) {
      routes.add(`${locale}:${job.slug}`);
    }
    for (const slug of getPreviousSlugsForLocale(job, locale)) {
      if (slug) routes.add(`${locale}:${slug}`);
    }
  }
  return routes;
}

/** Preserve every route known by `removed` on `survivor`. */
export function transferSlugHistory(survivor, removed, source = 'reconcile-crawler-company-ownership') {
  let transferred = 0;
  const requiredRoutes = new Map(LOCALES.map((locale) => [
    locale,
    new Set([
      ...getPreviousSlugsForLocale(survivor, locale),
      ...getPreviousSlugsForLocale(removed, locale),
      ...(removed.slugByLocale?.[locale] ? [removed.slugByLocale[locale]] : []),
      ...(locale === 'it' && removed.slug ? [removed.slug] : []),
    ]),
  ]));
  const add = (locale, slug) => {
    if (!slug || slug === survivor.slugByLocale?.[locale]) return;
    const before = new Set(survivor.previousSlugsByLocale?.[locale] || []).size;
    addPreviousSlugForLocale(
      survivor,
      locale,
      slug,
      DEFAULT_PREV_SLUG_CAP,
      source,
    );
    const after = new Set(survivor.previousSlugsByLocale?.[locale] || []).size;
    if (after > before) transferred += 1;
  };

  for (const locale of LOCALES) {
    add(locale, removed.slugByLocale?.[locale]);
    for (const slug of removed.previousSlugsByLocale?.[locale] || []) add(locale, slug);
  }
  add('it', removed.slug);

  // A flat-only legacy slug has no locale provenance. The SEO bridge contract
  // deliberately serves it under every locale prefix. Attributing it to `it`
  // would silently remove the existing EN/DE/FR routes. Keep those entries
  // flat while locale-attributed history stays in its exact bucket.
  const attributed = new Set();
  for (const slugs of Object.values(removed.previousSlugsByLocale || {})) {
    if (Array.isArray(slugs)) for (const slug of slugs) attributed.add(slug);
  }
  const flatOnly = new Set(
    (removed.previousSlugs || []).filter((slug) => slug && !attributed.has(slug)),
  );
  for (const slug of flatOnly) {
    if (promotePreviousSlugToLegacy(
      survivor,
      slug,
      undefined,
      `${source}/flat-history`,
    )) transferred += 1;
  }

  // Merging two histories can overflow a 20-entry locale bucket. Promote an
  // evicted route to unattributed legacy history: that bucket remains capped,
  // while the old URL is still served (conservatively under every locale).
  for (const [locale, required] of requiredRoutes) {
    const served = new Set(getPreviousSlugsForLocale({
      ...survivor,
    }, locale));
    const activeSlug = survivor.slugByLocale?.[locale] || survivor.slug;
    if (activeSlug) served.add(activeSlug);
    for (const slug of required) {
      if (!slug || served.has(slug)) continue;
      promotePreviousSlugToLegacy(
        survivor,
        slug,
        undefined,
        `${source}/cap-overflow`,
      );
      served.add(slug);
      transferred += 1;
    }
  }
  return transferred;
}

/**
 * Collapse archive entries that already share a locale route.
 *
 * The writers above key an archive by `slug` — the entry's CURRENT slug — but
 * the invariant the site actually needs is that every locale-qualified URL is
 * served by exactly one record. Two entries whose current slugs differ while
 * their `previousSlugs` overlap (a retired crawler alias surviving inside the
 * history of two vacancies) both pass a slug-keyed dedup and then own the same
 * route, which is what `assertNoDuplicateRoutesWithin` refuses.
 *
 * Routes are namespaced by `companyKey`: two companies may legitimately compute
 * the same slug (the collision class of issue #3734), and an entry without a
 * companyKey claims no route at all rather than merging across companies.
 *
 * A merge is applied only when it provably preserves the component's whole
 * route union. Two histories can be too deep to fit the legacy previousSlugs
 * cap, and `promotePreviousSlugToLegacy` correctly refuses to drop the
 * overflow; measured on 2026-09-05, 9 of the 547 committed slices hit that
 * wall. Such a component is left exactly as it was: a duplicated route is an
 * ambiguity, a lost route is a 404 on an indexed URL, and this runs inside the
 * crawler cron where a throw would abort the whole archival step. The residual
 * duplicates stay visible to `assertNoDuplicateRoutesWithin`.
 */
export function collapseDuplicateRouteEntries(entries, { source = 'expired-archive-dedup' } = {}) {
  const namespaced = (entry) => (entry?.companyKey
    ? [...localeRouteKeys(entry)].map((route) => `${entry.companyKey}::${route}`)
    : []);
  const out = [];
  const owners = new Map();
  let collapsed = 0;
  let slugsTransferred = 0;
  let unmergeable = 0;
  let capRefused = 0;
  // The index is maintained incrementally, never rebuilt: this runs over the
  // ~30k-entry aggregate archive, where a full rebuild per entry would be
  // quadratic. An entry whose merge was refused is kept in `out` but claims no
  // route, so a later entry cannot try (and fail) to collapse onto it again.
  const keep = (entry, { claimsRoutes = true } = {}) => {
    out.push(entry);
    if (claimsRoutes) for (const route of namespaced(entry)) owners.set(route, entry);
  };

  for (const entry of entries) {
    const claimed = new Set(namespaced(entry).map((route) => owners.get(route)).filter(Boolean));
    if (claimed.size === 0) {
      keep(entry);
      continue;
    }
    // One entry can bridge several previously separate records through
    // different locale/history routes: collapse the whole connected component
    // onto the most recently expired payload.
    const component = [...claimed, entry].sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt));
    const required = new Set(component.flatMap(namespaced));
    const survivor = structuredClone(component[0]);
    let transferred = 0;
    let merged = true;
    try {
      for (const removed of component) {
        if (removed === component[0]) continue;
        transferred += transferSlugHistory(survivor, removed, source);
      }
    } catch (error) {
      // Only the legacy-bucket cap refusal is an expected outcome. Anything
      // else is a defect in the entry or in this code, and swallowing it would
      // make the component silently `unmergeable` — indistinguishable from a
      // legitimate refusal, and invisible in the cron log.
      if (!/Cannot preserve \d+ legacy routes/.test(String(error?.message || ''))) throw error;
      merged = false;
      capRefused += 1;
    }
    if (merged) {
      const served = new Set(namespaced(survivor));
      // `promotePreviousSlugToLegacy` moves a slug out of its per-locale bucket
      // into flat `previousSlugs`, which the SEO bridge serves under EVERY
      // locale prefix. The survivor can therefore gain routes neither original
      // entry served — and one of those may already belong to a third record.
      // Requiring the union is not enough: the gained routes must be free.
      merged = [...required].every((route) => served.has(route))
        && [...served].every((route) => required.has(route) || !owners.has(route));
    }
    if (!merged) {
      unmergeable += 1;
      keep(entry, { claimsRoutes: false });
      continue;
    }
    for (let index = out.length - 1; index >= 0; index -= 1) {
      if (!claimed.has(out[index])) continue;
      for (const route of namespaced(out[index])) owners.delete(route);
      out.splice(index, 1);
    }
    slugsTransferred += transferred;
    collapsed += component.length - 1;
    // Safe to re-add wholesale: the survivor was accepted only after proving it
    // serves the component's entire route union, so it re-claims every route
    // just deleted plus its own.
    keep(survivor);
  }

  // A survivor is pushed at the position of the OLDEST member of its component
  // while carrying the NEWEST payload, so collapsing scrambles the expiredAt
  // ordering the callers rely on: `assemble-jobs-dataset` and `cleanup-jobs`
  // both `slice(0, EXPIRED_JOBS_CAP)` and document that cut as "the 5000 most
  // recent". Without this re-sort, 350 of the entries that belong in that
  // window fall past index 5000 and are dropped — the soft landings of the
  // jobs that expired last, i.e. the URLs Google indexed most recently.
  return {
    entries: out.sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt)),
    collapsed,
    slugsTransferred,
    unmergeable,
    capRefused,
  };
}
