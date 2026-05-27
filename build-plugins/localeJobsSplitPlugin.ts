import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

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

/** Fields included in the slim index file (used for listing + filtering + routing).
 * Detail-only fields (description, requirements, canonicalContent, baseSalary,
 * streetAddress, postalCode, applyUrl) are excluded to keep the index small. */
const SLIM_INDEX_FIELDS = new Set([
 'id', 'slug', 'previousSlugs', 'previousSlugsByLocale',
 'title',
 'company', 'companyKey', 'companyDomain', 'url',
 'location', 'canton',
 'addressLocality', 'sector',
 'category', 'contract', 'department',
 'salaryMin', 'salaryMax', 'currency',
 'postedDate', 'crawledAt', 'firstSeenAt',
 'featured', 'source', 'qualityScore',
]);

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
]);

interface JobEntry {
 id?: string;
 title?: string;
 description?: string;
 requirements?: string[];
 slug?: string;
 titleByLocale?: Record<string, string>;
 descriptionByLocale?: Record<string, string>;
 requirementsByLocale?: Record<string, string[]>;
 slugByLocale?: Record<string, string>;
 canonicalContent?: { byLocale?: Record<string, unknown>; [k: string]: unknown };
 [key: string]: unknown;
}

function buildLocaleJobSlim(localeJob: Record<string, unknown>): Record<string, unknown> {
 const slim: Record<string, unknown> = {};
 for (const key of SLIM_INDEX_FIELDS) {
 if (key in localeJob) slim[key] = localeJob[key];
 }
 return slim;
}

function buildLocaleJob(job: JobEntry, locale: string): Record<string, unknown> {
 const {
 titleByLocale,
 descriptionByLocale,
 requirementsByLocale,
 slugByLocale,
 canonicalContent,
 ...rest
 } = job;

 // Strip byLocale from canonicalContent too (it holds per-locale keywords/excerpts)
 let strippedCanonical: Record<string, unknown> | undefined;
 if (canonicalContent) {
 const { byLocale, ...canonRest } = canonicalContent;
 const localeContent = byLocale?.[locale];
 strippedCanonical = { ...canonRest, ...(localeContent ? { content: localeContent } : {}) };
 }

 return {
 ...rest,
 title: titleByLocale?.[locale] || job.title || '',
 description: descriptionByLocale?.[locale] || job.description || '',
 requirements: requirementsByLocale?.[locale] || job.requirements || [],
 slug: slugByLocale?.[locale] || job.slug || '',
 ...(strippedCanonical ? { canonicalContent: strippedCanonical } : {}),
 };
}

/**
 * Generates locale-specific job JSON files at build time.
 *
 * Reads `data/jobs.json` and emits `dist/data/jobs-{locale}.json` for each locale.
 * Each file flattens the *ByLocale fields into the base fields for that locale,
 * reducing per-request payload by ~35%.
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
 const localeJobs = jobs.map((j) => buildLocaleJob(j, locale));
 fs.writeFileSync(
 path.resolve(dataDir, `jobs-${locale}.json`),
 JSON.stringify(localeJobs),
 'utf-8',
 );
 // Slim index: listing-only fields for fast initial LCP (FRO-386)
 const slimJobs = localeJobs.map(buildLocaleJobSlim);
 fs.writeFileSync(
 path.resolve(dataDir, `jobs-${locale}-index.json`),
 JSON.stringify(slimJobs),
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
 console.log(`[locale-jobs-split] Generated 4 locale files + 4 slim index files + slug map + ${count} detail files (${count} jobs)`);
 }
 },
 configureServer(server) {
 // In dev, generate files in public/data/ so the dev server can serve them
 const publicDir = path.resolve(rootDir, 'public');
 const count = generateFiles(publicDir);
 if (count > 0) {
 console.log(`[locale-jobs-split] Dev: generated 4 locale files in public/data/`);
 }
 },
 };
}
