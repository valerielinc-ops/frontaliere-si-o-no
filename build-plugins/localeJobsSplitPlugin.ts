import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import {
 buildLocaleJob,
 buildLocaleJobSlim,
 FIRST_PAGE_SLICE_SIZE,
 firstPageIndexFileName,
 type JobEntry,
} from './shared/slimJobIndex';
// Relative import (no `@/` alias): this file is in the vite.config plugin
// graph, where alias VALUE imports fail at config load time.
import { buildJobSlugShards, type SlugMapJobEntry } from '../services/jobSlugShards';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

// Fixture-data guard — mirror of scripts/lib/fixture-data-filter.mjs.
// Inlined so this plugin has no .mjs dependency at TypeScript compile time.
const FIXTURE_SLUG_RE = /^fixture-|-fixture-corp-|-fixture-canonical-/i;
const FIXTURE_ID_RE = /^fixture-/i;
const FIXTURE_COMPANY_KEY_RE = /^fixture(?:-|$)/i;
const FIXTURE_COMPANY_NAMES = new Set(['fixture corp sa', 'fixture corp']);
function isFixtureJobEntry(j: Record<string, unknown>): boolean {
 if (!j || typeof j !== 'object') return false;
 const id = j.id;
 if (typeof id === 'string' && FIXTURE_ID_RE.test(id)) return true;
 const ck = j.companyKey;
 if (typeof ck === 'string' && FIXTURE_COMPANY_KEY_RE.test(ck)) return true;
 const co = j.company;
 if (typeof co === 'string' && FIXTURE_COMPANY_NAMES.has(co.trim().toLowerCase())) return true;
 const slug = j.slug;
 if (typeof slug === 'string' && FIXTURE_SLUG_RE.test(slug)) return true;
 const sbl = j.slugByLocale;
 if (sbl && typeof sbl === 'object') {
 for (const v of Object.values(sbl as Record<string, unknown>)) {
 if (typeof v === 'string' && FIXTURE_SLUG_RE.test(v)) return true;
 }
 }
 return false;
}

// SLIM_INDEX_FIELDS / JobEntry / buildLocaleJob / buildLocaleJobSlim now live in
// ./shared/slimJobIndex — shared with jobsSeoPagesPlugin's window.__JOB_SEED__
// emit so the seeded record stays byte-shape-identical to the index entry
// (AGENTS.md §6: a literal-duplicated field set across ≥2 files → one module).

/** Fields included in per-job detail files (fetched on-demand when a job detail is opened).
 * This avoids fetching the full 11MB locale file just to show one job's details. */
const DETAIL_FIELDS = new Set([
 'description', 'descriptionByLocale',
 'requirements', 'requirementsByLocale',
 'canonicalContent',
 'baseSalary', 'streetAddress', 'postalCode', 'applyUrl',
 'addressLocality', 'addressRegion', 'addressCountry',
 'employmentType', 'hiringOrganization',
 'titleByLocale', 'slugByLocale',
 'sector', 'experienceLevel',
 'validThrough', 'benefits',
 'contactPerson', 'contactPhone',
 'pensum', 'pensumMin', 'pensumMax',
 'workModel', 'remote',
 'applicationDeadline',
 // Publisher-ad fields (logo, markdown description, in-house apply wiring).
 'companyLogo', 'descriptionMd', 'tier', 'applyMode', 'publisherUid', 'publisherJobId',
]);


/**
 * Generates locale-specific job JSON files at build time.
 *
 * Reads `data/jobs.json` and emits, for each locale, the slim listing index
 * `dist/data/jobs-{locale}-index.json` (+ first-page slim slice), plus a shared
 * `jobs-slug-map.json` and per-job `job-detail/{id}.json` files. Records are
 * flattened from *ByLocale to base fields for the locale. The full
 * `jobs-{locale}.json` monolith is intentionally NOT emitted — its descriptions
 * duplicated job-detail and were never needed for listing (see inline note).
 *
 * Also generates files in `public/data/` for the Vite dev server.
 */
export function localeJobsSplitPlugin(rootDir: string): Plugin {
 const dataJobsPath = path.resolve(rootDir, 'data', 'jobs.json');

 function generateFiles(outDir: string): number {
 if (!fs.existsSync(dataJobsPath)) return 0;

 const rawJobs: JobEntry[] = JSON.parse(fs.readFileSync(dataJobsPath, 'utf-8'));
 if (!Array.isArray(rawJobs)) return 0;

 // Strip fixture-data records (e.g. "Fixture Corp SA" seed) so they cannot
 // leak into dist/data/jobs-*.json or dist/data/job-detail/*.json.
 const jobs = rawJobs.filter((j) => !isFixtureJobEntry(j));
 const dropped = rawJobs.length - jobs.length;
 if (dropped > 0) {
 console.log(`[locale-jobs-split] Filtered ${dropped} fixture job(s) before locale split`);
 }

 const dataDir = path.resolve(outDir, 'data');
 if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

 for (const locale of LOCALES) {
 // Locale-flattened records (full *ByLocale → base fields). Kept in memory
 // to derive the slim index + first-page slim below, but no longer written
 // to disk: the full `jobs-{locale}.json` monolith (~48MB each, descriptions
 // ×4 locales) duplicated prose already canonical in job-detail/{id}.json and
 // was only ever a listing fallback (listing never reads descriptions). All
 // consumers repointed to jobs-{locale}-index.json + job-detail.
 const localeJobs = jobs.map((j) => buildLocaleJob(j, locale));
 // Slim index: listing-only fields for fast initial LCP (FRO-386)
 const slimJobs = localeJobs.map(buildLocaleJobSlim);
 fs.writeFileSync(
 path.resolve(dataDir, `jobs-${locale}-index.json`),
 JSON.stringify(slimJobs),
 'utf-8',
 );
 // First-page slim asset: the first N records of the slim index (same
 // recency-desc disk order as data/jobs.json). The JobBoard listing fetches
 // this tiny payload first so page-1 cards paint without waiting on the
 // ~1.9 MB full index + the synchronous normalize of all ~5.5k records
 // (#2580). The full index then loads in the background and replaces it.
 // Additive + reversible: if this asset is missing (CDN-offloaded), the SPA
 // degrades to fetching the full index directly (prior behavior).
 const firstPageSlim = slimJobs.slice(0, FIRST_PAGE_SLICE_SIZE);
 fs.writeFileSync(
 path.resolve(dataDir, firstPageIndexFileName(locale)),
 JSON.stringify(firstPageSlim),
 'utf-8',
 );
 }

 // Slug map: minimal file for router.ts slug translation (~2MB vs 44MB full).
 // Also includes `id` + `canton` so the SPA can resolve a bridge URL whose
 // target job lives in a canton shard that wasn't loaded by the initial
 // referrer-aware fetch (e.g. /cerca-lavoro-ticino/<bridge>/ for a job now
 // in AI — JobBoard would otherwise show JobOrphanView even though the job
 // is alive). With id+canton the SPA can lazy-fetch /data/job-detail/{id}.json.
 const slugMap = jobs.map((j) => {
 const entry: Record<string, unknown> = {};
 if (j.id) entry.id = j.id;
 if (j.slug) entry.slug = j.slug;
 if (j.slugByLocale) entry.slugByLocale = j.slugByLocale;
 if (j.canton) entry.canton = j.canton;
 if (Array.isArray(j.previousSlugs) && j.previousSlugs.length) entry.previousSlugs = j.previousSlugs;
 if (j.previousSlugsByLocale) entry.previousSlugsByLocale = j.previousSlugsByLocale;
 return entry;
 }).filter((e) => Object.keys(e).length > 0);
 fs.writeFileSync(
 path.resolve(dataDir, 'jobs-slug-map.json'),
 JSON.stringify(slugMap),
 'utf-8',
 );

 // Sharded slug map (issue #3526): the monolith above is ~12 MB raw /
 // ~1.5 MB br and the SPA used to fetch it on effectively every page view.
 // Emit data/jobs-slug-map/{00..ff}.json shards keyed by lookup slug
 // (current slugs + previousSlugs* aliases) so the router can fetch only
 // the ~16 KB br shard covering one slug (ensureJobSlugEntriesLoaded).
 // The monolith stays: old cached SPA chunks still fetch it, and
 // corpus-wide consumers (UserProfile, stats leader links) still need it.
 // Shard hashing + record shape live in services/jobSlugShards.ts, shared
 // with the router by construction. All shard files are written (empty
 // shards as {}), so an unknown slug gets a 200 + miss (confirmed absent)
 // instead of a 404 (which the router treats as "shards unavailable" and
 // falls back to the monolith).
 const shardDir = path.resolve(dataDir, 'jobs-slug-map');
 if (!fs.existsSync(shardDir)) fs.mkdirSync(shardDir, { recursive: true });
 const shards = buildJobSlugShards(slugMap as SlugMapJobEntry[]);
 for (const [shardKey, shard] of Object.entries(shards)) {
 fs.writeFileSync(
 path.resolve(shardDir, `${shardKey}.json`),
 JSON.stringify(shard),
 'utf-8',
 );
 }

 // Per-job detail files: ~15KB each vs 11MB full locale file (FRO-detail-split)
 const detailDir = path.resolve(dataDir, 'job-detail');
 if (!fs.existsSync(detailDir)) fs.mkdirSync(detailDir, { recursive: true });
 for (const job of jobs) {
 const detail: Record<string, unknown> = {};
 for (const key of DETAIL_FIELDS) {
 if (key in job && (job as Record<string, unknown>)[key] !== undefined) {
 detail[key] = (job as Record<string, unknown>)[key];
 }
 }
 if (Object.keys(detail).length > 0) {
 fs.writeFileSync(
 path.resolve(detailDir, `${job.id || job.slug || 'unknown'}.json`),
 JSON.stringify(detail),
 'utf-8',
 );
 }
 }

 return jobs.length;
 }

 return {
 name: 'locale-jobs-split',
 apply: 'build',
 closeBundle() {
 const distDir = path.resolve(rootDir, 'dist');
 const count = generateFiles(distDir);
 if (count > 0) {
 console.log(`[locale-jobs-split] Generated 4 slim index files + 4 first-page slim files + slug map (+ sharded slug map) + ${count} detail files (${count} jobs)`);
 }
 },
 configureServer(server) {
 // In dev, generate files in public/data/ so the dev server can serve them
 const publicDir = path.resolve(rootDir, 'public');
 const count = generateFiles(publicDir);
 if (count > 0) {
 console.log(`[locale-jobs-split] Dev: generated 4 slim index files + slug map + detail files in public/data/`);
 }
 },
 };
}
