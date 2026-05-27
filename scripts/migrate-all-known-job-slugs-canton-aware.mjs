// scripts/migrate-all-known-job-slugs-canton-aware.mjs
// Phase 8 Sub-PR (c): one-shot migration that rewrites every per-locale path in
// data/all-known-job-slugs.json so that non-TI jobs use their canton-aware
// section slug (e.g. /cerca-lavoro-zurigo/...) instead of the legacy TI section.
//
// Before this migration, every tracking entry was emitted under the frozen TI
// section path because the builder at jobsSeoPagesPlugin.ts (~line 8057) used
// `sectionByLocale[locale]` unconditionally. With cathedral now emitting the
// active per-job pages at canton-aware URLs, expired soft-landings written
// from the TI-section tracking path are stale (best case) or clobber an
// active non-TI page that happens to slug-collide (worst case).
//
// Strategy:
//   1. Build a slug -> canton index from data/jobs.json. Index by job.slug,
//      every slugByLocale.* value, and every previousSlugs[*] entry.
//   2. For every tracking entry, look up the master slug in that index.
//        Found  -> rewrite each per-locale path's section slug using the
//                  canton-aware resolver (mirrors build-plugins/shared/
//                  cantonSection.ts so the migration has no .ts dependency).
//        Missing-> keep the TI path (orphan slug; preserves prior behaviour).
//   3. Preserve any non-locale metadata on the entry (e.g. `source`,
//      `importedAt` from the GSC-404 import path).
//   4. Re-emit the file with 2-space indent + trailing newline.
//
// TI invariance: jobs whose resolved canton is TI keep the legacy section
// path verbatim — resolveCantonSection short-circuits on 'TI'.
import fs from 'node:fs';
import path from 'node:path';

const TRACKING_PATH = path.resolve('data/all-known-job-slugs.json');
const JOBS_PATH = path.resolve('data/jobs.json');
const CANTON_SLUGS_PATH = path.resolve('data/canton-url-slugs.json');
const MUNI_PATH = path.resolve('data/canton-municipalities.json');

const LOCALES = ['it', 'en', 'de', 'fr'];
const LOCALE_PREFIX = { it: '', en: '/en', de: '/de', fr: '/fr' };

const TI_SECTION_BY_LOCALE = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const SECTION_PREFIX_BY_LOCALE = {
  it: 'cerca-lavoro',
  en: 'find-jobs',
  de: 'jobs-in',
  fr: 'trouver-emploi',
};

const AGGREGATE_KEY = '_AGGREGATE_';

// ── Load canton + municipality reference data (mirrors cantonSection.ts) ──
const cantonSlugFile = JSON.parse(fs.readFileSync(CANTON_SLUGS_PATH, 'utf8'));
const muniFile = JSON.parse(fs.readFileSync(MUNI_PATH, 'utf8'));
const cantons = cantonSlugFile.cantons;
const cantonGroups = cantonSlugFile.cantonGroups || {};
const aggregateSlugs = cantonSlugFile.aggregate;

const memberToGroup = {};
for (const [group, info] of Object.entries(cantonGroups)) {
  for (const member of info.members) memberToGroup[member] = group;
}

function resolveCantonGroup(cantonCode) {
  const code = String(cantonCode || '').toUpperCase().trim();
  if (!code) return 'TI';
  return memberToGroup[code] ?? code;
}

function getCantonUrlSlug(code, locale) {
  if (code === AGGREGATE_KEY) return aggregateSlugs[locale] ?? aggregateSlugs.it;
  const entry = cantons[code];
  return entry?.[locale] ?? aggregateSlugs[locale] ?? aggregateSlugs.it;
}

function resolveCantonSection(locale, cantonCode) {
  const raw = String(cantonCode || '').toUpperCase();
  if (!raw || raw === 'TI') return TI_SECTION_BY_LOCALE[locale];
  if (raw === AGGREGATE_KEY) {
    return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlug(AGGREGATE_KEY, locale)}`;
  }
  const code = resolveCantonGroup(raw);
  if (locale === 'de') {
    const entry = cantons[code];
    if (entry?.dePrefix) return `${entry.dePrefix}${entry.de}`;
  }
  return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlug(code, locale)}`;
}

function normalizeCityKey(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

const CITY_TO_CANTON = (() => {
  const out = {};
  for (const [canton, info] of Object.entries(muniFile.cantons)) {
    for (const city of info.municipalities) {
      out[normalizeCityKey(city).split(' (')[0].trim()] = canton;
    }
  }
  return out;
})();

function resolveJobCanton(job) {
  const explicit = String(job.canton || '').toUpperCase().trim();
  if (explicit && (cantons[explicit] || memberToGroup[explicit])) {
    return resolveCantonGroup(explicit);
  }
  const locRaw = normalizeCityKey(String(job.location || ''));
  const loc = locRaw.replace(/\bsankt\s+/g, 'st. ');
  const fullCity = loc.split(/[,(]/)[0].trim();
  if (fullCity && CITY_TO_CANTON[fullCity]) return resolveCantonGroup(CITY_TO_CANTON[fullCity]);
  const tokens = loc.replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (CITY_TO_CANTON[token]) return resolveCantonGroup(CITY_TO_CANTON[token]);
    const up = token.toUpperCase();
    if (cantons[up] || memberToGroup[up]) return resolveCantonGroup(up);
  }
  return 'TI';
}

// ── Migration body ─────────────────────────────────────────────────
const tracking = JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));

// 1. Index every job slug-alias -> job (so we can resolve its canton).
const slugToJob = new Map();
for (const job of jobs) {
  const aliases = new Set();
  if (job?.slug) aliases.add(String(job.slug));
  if (job?.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const v of Object.values(job.slugByLocale)) {
      if (v) aliases.add(String(v));
    }
  }
  if (Array.isArray(job?.previousSlugs)) {
    for (const v of job.previousSlugs) {
      if (v) aliases.add(String(v));
    }
  }
  for (const alias of aliases) {
    if (!slugToJob.has(alias)) slugToJob.set(alias, job);
  }
}

// 2. Pre-compute TI legacy path prefixes for cheap matching.
const TI_PATH_PREFIX = {};
for (const locale of LOCALES) {
  TI_PATH_PREFIX[locale] = `${LOCALE_PREFIX[locale]}/${TI_SECTION_BY_LOCALE[locale]}/`;
}

let rewritten = 0;
let kept = 0;
let orphanKept = 0;
const cantonStats = new Map();

const out = {};
for (const [trackingSlug, entry] of Object.entries(tracking)) {
  if (!entry || typeof entry !== 'object') {
    out[trackingSlug] = entry;
    continue;
  }
  const job = slugToJob.get(trackingSlug);
  if (!job) {
    orphanKept++;
    out[trackingSlug] = entry;
    continue;
  }
  const canton = resolveJobCanton({ canton: job.canton, location: job.location });
  cantonStats.set(canton, (cantonStats.get(canton) || 0) + 1);
  if (canton === 'TI') {
    kept++;
    out[trackingSlug] = entry;
    continue;
  }
  const newEntry = { ...entry };
  let touched = false;
  for (const locale of LOCALES) {
    const oldPath = entry[locale];
    if (typeof oldPath !== 'string') continue;
    const tiPrefix = TI_PATH_PREFIX[locale];
    if (!oldPath.startsWith(tiPrefix)) continue; // already canton-aware or hand-edited
    const remainder = oldPath.slice(tiPrefix.length);
    const newSection = resolveCantonSection(locale, canton);
    newEntry[locale] = `${LOCALE_PREFIX[locale]}/${newSection}/${remainder}`.replace(/\/+/g, '/');
    touched = true;
  }
  if (touched) rewritten++;
  else kept++;
  out[trackingSlug] = newEntry;
}

fs.writeFileSync(TRACKING_PATH, JSON.stringify(out, null, 2) + '\n');

console.log('all-known-job-slugs canton-aware migration:');
console.log(`  total tracking entries:      ${Object.keys(tracking).length}`);
console.log(`  rewritten (non-TI job):      ${rewritten}`);
console.log(`  kept (TI job — invariance):  ${kept}`);
console.log(`  kept (orphan, no live job):  ${orphanKept}`);
console.log('  canton distribution of matched jobs:');
const cantonSorted = [...cantonStats.entries()].sort((a, b) => b[1] - a[1]);
for (const [c, n] of cantonSorted) console.log(`    ${c.padEnd(6)} ${n}`);
