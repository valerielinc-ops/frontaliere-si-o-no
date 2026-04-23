#!/usr/bin/env node
/**
 * enrich-compat-orphan-slugs.mjs
 *
 * Recovers rich content for 404-compat slugs (from data/seo-404-compat-paths.json)
 * by looking them up in data/translation-cache/*.json. Slugs found in the cache
 * get appended to data/orphan-enriched-data.json with real title/description per
 * locale, so the jobsSeoPagesPlugin soft-landing turns from a generic template
 * into a content-rich page.
 *
 * Why not extend reconcile-job-slugs.mjs? That script matches orphans to
 * *active* jobs. Here the source job is gone — we're rebuilding content from
 * the translation cache that was produced when it was still live.
 *
 * Usage:
 *   node scripts/enrich-compat-orphan-slugs.mjs [--dry-run] [--max <N>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const COMPAT = path.resolve(ROOT, 'data/seo-404-compat-paths.json');
const ORPHAN_ENRICHED = path.resolve(ROOT, 'data/orphan-enriched-data.json');
const ORPHAN_SLUGS = path.resolve(ROOT, 'data/orphan-indexed-job-slugs.json');
const JOBS = path.resolve(ROOT, 'data/jobs.json');
const CACHE_DIR = path.resolve(ROOT, 'data/translation-cache');
const ADAPTERS_DIR = path.resolve(ROOT, 'data/jobs-crawler-adapters/adapters');

const JOB_PATTERNS = [
  { re: /\/cerca-lavoro-ticino\/([^/]+)\/?$/, locale: 'it', prefix: '/cerca-lavoro-ticino/' },
  { re: /\/en\/find-jobs?-ticino\/([^/]+)\/?$/, locale: 'en', prefix: '/en/find-jobs-ticino/' },
  { re: /\/de\/jobs-im-tessin\/([^/]+)\/?$/, locale: 'de', prefix: '/de/jobs-im-tessin/' },
  { re: /\/fr\/trouver-emploi-tessin\/([^/]+)\/?$/, locale: 'fr', prefix: '/fr/trouver-emploi-tessin/' },
];
const SKIP_PREFIX_RE = /^(?:search|ricerca|suche|recherche|azienda|company|unternehmen|entreprise)-/;

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, v) {
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
}

/** Load translation cache: slug -> { titles, descriptions, sourceFile }. */
function loadCache() {
  const map = new Map();
  const keys = [];
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (!f.endsWith('.json')) continue;
    const data = readJson(path.join(CACHE_DIR, f), {});
    for (const [slug, entry] of Object.entries(data)) {
      if (map.has(slug)) continue;
      const t = entry?.translations || {};
      map.set(slug, {
        titles: t.titles || {},
        descriptions: t.descriptions || {},
        sourceFile: f,
      });
      keys.push(slug);
    }
  }
  keys.sort();
  return { map, keys };
}

/** Known companyKeys from adapter files. */
function loadCompanyKeys() {
  const keys = [];
  for (const f of fs.readdirSync(ADAPTERS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const a = readJson(path.join(ADAPTERS_DIR, f));
    if (a?.companyKey) keys.push(a.companyKey);
  }
  keys.sort((a, b) => b.length - a.length);
  return keys;
}

function extractCompanyKey(slug, companyKeys) {
  for (const k of companyKeys) {
    if (slug.includes(k)) return k;
  }
  return '';
}

/**
 * Extract locality from the tail of the slug (last 1-3 hyphen-separated tokens
 * after the companyKey). Returns a display-case string like "Bioggio".
 */
/**
 * Slugs end with the job location, e.g. "...guess-europe-sagl-bioggio" → "Bioggio".
 * Take the last token (skip legal-form suffixes like "sagl", "sa", "ag").
 */
function extractLocation(slug) {
  const LEGAL_FORMS = new Set(['sagl', 'sa', 'ag', 'gmbh', 'spa', 'srl', 'plc', 'llc']);
  const tokens = slug.split('-').filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.length < 3) continue;
    if (LEGAL_FORMS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return '';
}

function buildLocalePaths(slug) {
  const paths = {};
  for (const { locale, prefix } of JOB_PATTERNS) {
    paths[locale] = `${prefix}${slug}`;
  }
  return paths;
}

function buildSlugByLocale(slug) {
  const out = {};
  for (const { locale } of JOB_PATTERNS) out[locale] = slug;
  return out;
}

function hasTranslations(entry) {
  const t = entry.titles || {};
  return ['it', 'en', 'de', 'fr'].some((l) => t[l] && t[l].trim().length > 0);
}

function firstLocaleForSlug(slug, compatPathBySlug) {
  return compatPathBySlug.get(slug)?.locale || 'it';
}

function deriveTitleFromSlug(slug, companyKey) {
  let s = slug;
  if (companyKey) s = s.replace(companyKey, '').replace(/--+/g, '-').replace(/^-+|-+$/g, '');
  const loc = s.split('-').pop() || '';
  if (loc && loc.length >= 3) s = s.slice(0, s.length - loc.length).replace(/-+$/, '');
  return s.split('-').filter(Boolean).slice(0, 10).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const maxIdx = args.indexOf('--max');
  const max = maxIdx !== -1 ? Number(args[maxIdx + 1]) : Infinity;

  console.log(`🔄 enrich-compat-orphan-slugs — ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  const compat = readJson(COMPAT, { paths: [] });
  const compatPaths = Array.isArray(compat.paths) ? compat.paths : [];
  const enriched = readJson(ORPHAN_ENRICHED, []);
  const orphanSlugsList = readJson(ORPHAN_SLUGS, []);
  const activeJobs = readJson(JOBS, []);

  // Build compat slug -> {locale, path} (prefer IT if multi-locale dupe)
  const compatPathBySlug = new Map();
  for (const p of compatPaths) {
    const raw = String(p || '');
    for (const { re, locale, prefix } of JOB_PATTERNS) {
      const m = raw.match(re);
      if (!m) continue;
      const slug = m[1];
      if (!slug || SKIP_PREFIX_RE.test(slug)) break;
      const current = compatPathBySlug.get(slug);
      if (!current || (current.locale !== 'it' && locale === 'it')) {
        compatPathBySlug.set(slug, { locale, path: `${prefix}${slug}` });
      }
      break;
    }
  }

  // Excluded: slugs already mapped to active jobs or already enriched.
  const activeSlugSet = new Set();
  for (const j of activeJobs) {
    if (j.slug) activeSlugSet.add(j.slug);
    if (j.slugByLocale) for (const s of Object.values(j.slugByLocale)) if (s) activeSlugSet.add(s);
    if (Array.isArray(j.previousSlugs)) for (const s of j.previousSlugs) activeSlugSet.add(s);
  }
  const enrichedSlugSet = new Set(enriched.map((e) => e.slug).filter(Boolean));
  const orphanSlugStringSet = new Set(
    orphanSlugsList.map((o) => (typeof o === 'string' ? o : o?.slug || '')).filter(Boolean),
  );

  const { map: cacheMap, keys: cacheKeys } = loadCache();
  const companyKeys = loadCompanyKeys();

  console.log(`📊 Loaded:`);
  console.log(`   - ${compatPathBySlug.size} unique job slugs in compat`);
  console.log(`   - ${activeSlugSet.size} slugs in active jobs`);
  console.log(`   - ${enrichedSlugSet.size} in orphan-enriched`);
  console.log(`   - ${cacheMap.size} translation-cache entries`);
  console.log(`   - ${companyKeys.length} known company keys`);

  let exactHits = 0, prefixHits = 0, skipped = 0, noTranslations = 0, noMatch = 0, processed = 0;
  const newEntries = [];
  const newOrphanSlugs = [];

  for (const [slug, info] of compatPathBySlug) {
    if (processed >= max) break;
    if (activeSlugSet.has(slug) || enrichedSlugSet.has(slug)) { skipped++; continue; }

    // Exact or prefix match
    let cacheEntry = cacheMap.get(slug);
    let matchedSlug = slug;
    let matchType = 'exact';
    if (!cacheEntry && slug.length >= 50) {
      const hit = cacheKeys.find((k) => k.startsWith(slug));
      if (hit) {
        cacheEntry = cacheMap.get(hit);
        matchedSlug = hit;
        matchType = 'prefix';
      }
    }
    if (!cacheEntry) { noMatch++; continue; }
    if (!hasTranslations(cacheEntry)) { noTranslations++; continue; }

    processed++;
    if (matchType === 'exact') exactHits++; else prefixHits++;

    const companyKey = extractCompanyKey(matchedSlug, companyKeys);
    const location = extractLocation(matchedSlug);
    const titlesIt = cacheEntry.titles.it || '';

    const entry = {
      slug,
      locale: info.locale,
      path: `${info.path}/`,
      queries: [],
      totalImpressions: 0,
      totalClicks: 0,
      topQuery: null,
      title: titlesIt || deriveTitleFromSlug(slug, companyKey),
      titleByLocale: {
        it: cacheEntry.titles.it || '',
        en: cacheEntry.titles.en || '',
        de: cacheEntry.titles.de || '',
        fr: cacheEntry.titles.fr || '',
      },
      descriptionByLocale: {
        it: cacheEntry.descriptions.it || '',
        en: cacheEntry.descriptions.en || '',
        de: cacheEntry.descriptions.de || '',
        fr: cacheEntry.descriptions.fr || '',
      },
      company: '',
      companyKey,
      location,
      sector: '',
      salaryMin: 0,
      salaryCurrency: 'CHF',
      slugByLocale: buildSlugByLocale(slug),
      localePaths: buildLocalePaths(slug),
      sourceUrl: '',
      googleStatus: 'unknown',
      googleCanonical: '',
      lastCrawlTime: '',
      source: ['seo-404-compat', `translation-cache:${matchType}`, cacheEntry.sourceFile],
    };

    newEntries.push(entry);
    if (!orphanSlugStringSet.has(slug)) {
      newOrphanSlugs.push({ slug, locale: info.locale, path: entry.path });
    }
  }

  console.log('');
  console.log('📈 Results:');
  console.log(`   exact cache hits:  ${exactHits}`);
  console.log(`   prefix cache hits: ${prefixHits}`);
  console.log(`   no translations:   ${noTranslations}`);
  console.log(`   no match:          ${noMatch}`);
  console.log(`   already known:     ${skipped}`);
  console.log(`   → new entries:     ${newEntries.length}`);

  if (dryRun) {
    console.log('\n(dry run — no writes)');
    if (newEntries.length > 0) {
      console.log('\nSample:', JSON.stringify({ slug: newEntries[0].slug, titles: newEntries[0].titleByLocale, companyKey: newEntries[0].companyKey }, null, 2));
    }
    return;
  }

  if (newEntries.length === 0) {
    console.log('\nℹ️  Nothing to write.');
    return;
  }

  const updatedEnriched = [...enriched, ...newEntries];
  writeJson(ORPHAN_ENRICHED, updatedEnriched);
  console.log(`💾 Wrote ${ORPHAN_ENRICHED} (+${newEntries.length})`);

  if (newOrphanSlugs.length > 0) {
    const updatedOrphan = [...orphanSlugsList, ...newOrphanSlugs];
    writeJson(ORPHAN_SLUGS, updatedOrphan);
    console.log(`💾 Wrote ${ORPHAN_SLUGS} (+${newOrphanSlugs.length})`);
  }
}

main();
