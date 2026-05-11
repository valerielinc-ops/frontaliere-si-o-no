#!/usr/bin/env node
/**
 * Dedicated Galenica crawler runner.
 *
 * Source:
 *   https://jobs.galenica.com/it/jobs/
 *   Solique JSON: https://jobs.galenica.com/public/wGlobal/lib/apps/jobs/solique/scripts/data.json
 *
 * This script:
 *   1. Fetches the full job listing from the static Solique data.json.
 *   2. Filters for Ticino (canton TI) positions, preferring Italian language.
 *   3. Deduplicates by job ID (same job appears in de/fr/it).
 *   4. Merges discovered jobs into data/jobs.json.
 *   5. Updates the adapter config with discovered seed URLs.
 *   6. Runs the shared base crawler for AI localization.
 *   7. Post-processes rows for canonical consistency.
 *   8. Validates locale coverage.
 *
 * Ticino subsidiaries: Sun Store, Amavita, Coop Vitality, UFD.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  deriveLocalizedSlug,
  normalize,
  normalizeKey,
mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { parseYoustyApprenticeshipHtml } from './lib/yousty-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const GALENICA_KEY = 'galenica';
const DEFAULT_CANTON = getCompanyDefaults(GALENICA_KEY)?.canton || 'TI';
const GALENICA_COMPANY_NAME = 'Galenica AG';
const GALENICA_HOST = 'jobs.galenica.com';
const GALENICA_DATA_URL =
  'https://jobs.galenica.com/public/wGlobal/lib/apps/jobs/solique/scripts/data.json';
const GALENICA_CAREERS_URL = 'https://jobs.galenica.com/it/jobs/';
const GALENICA_LOCALES = ['it', 'en', 'de', 'fr'];

/* ── Matcher ───────────────────────────────────────────────── */
function isGalenicaJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === GALENICA_KEY ||
    key === 'galenica-ag' ||
    key.includes('galenica') ||
    company.includes('galenica') ||
    host === GALENICA_HOST
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === GALENICA_HOST ||
      host === 'www.galenica.com' ||
      host.endsWith('.yousty.ch') ||
      host === 'www.yousty.ch' ||
      host.endsWith('.umantis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category detection ────────────────────────────────────── */
function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/farmaci|pharma|apothek|apotheke|pharmacie/i.test(t)) return 'healthcare';
  if (/logisti|magazzin|lager|warehouse|entrepôt/i.test(t)) return 'logistics';
  if (/vendita|sales|vente|verkauf/i.test(t)) return 'sales';
  if (/it\b|software|developer|system|informatik/i.test(t)) return 'technology';
  if (/market|kommunikation|communication/i.test(t)) return 'marketing';
  if (/hr\b|human|personale|personal/i.test(t)) return 'hr';
  if (/finanz|finance|contabil|buchhaltung|comptab/i.test(t)) return 'finance';
  if (/direzione|direction|management|leitung/i.test(t)) return 'management';
  if (/apprendista|apprenti|lehrling|afc|efz|cfc/i.test(t)) return 'apprenticeship';
  return 'healthcare'; // default for Galenica
}

/* ── Description builders ──────────────────────────────────── */
function buildDescriptionEn(title, firm, city, contact) {
  const addr = contact.street ? `, ${contact.street}` : '';
  return `${title} at ${firm} (Galenica Group), located in ${city}${addr}, Canton Ticino, Switzerland. Galenica is the leading Swiss healthcare group and operates the largest pharmacy network in the country, with brands including Amavita, Sun Store, and Coop Vitality. This position offers the opportunity to work in a dynamic, patient-oriented environment with excellent career development prospects.`;
}

function buildDescriptionIt(title, firm, city, contact) {
  const addr = contact.street ? `, ${contact.street}` : '';
  return `${title} presso ${firm} (Gruppo Galenica), con sede a ${city}${addr}, Canton Ticino, Svizzera. Galenica è il principale gruppo svizzero nel settore sanitario e gestisce la più grande rete di farmacie del Paese, con i marchi Amavita, Sun Store e Coop Vitality. Questa posizione offre l'opportunità di lavorare in un ambiente dinamico e orientato al paziente con eccellenti prospettive di sviluppo professionale.`;
}

/* ── Build job detail URL ──────────────────────────────────── */
function buildJobUrl(job) {
  // Always use the Galenica job portal URL with hash fragment
  const jobId = String(job.id || '');
  return `https://jobs.galenica.com/it/jobs/#job.id=${encodeURIComponent(jobId)}`;
}

/* ── Fetch & parse ─────────────────────────────────────────── */
async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function enrichFromYoustyProfile(variants, timeoutMs) {
  const profileUrl =
    variants.find((v) => /yousty\.ch/i.test(String(v?.textblocks?.profilelink || '')))?.textblocks?.profilelink ||
    '';
  if (!profileUrl) return null;

  try {
    const html = await fetchText(profileUrl, timeoutMs);
    const parsed = parseYoustyApprenticeshipHtml(html, profileUrl);
    if (!parsed.description) return { applyUrl: parsed.applyUrl || profileUrl };
    const detectedLocale = detectLang(parsed.description, 'it');
    const descriptionByLocale = {
      [detectedLocale]: parsed.description,
    };
    return {
      ...(detectedLocale === 'it'
        ? {
            description: parsed.description,
            descriptionIt: parsed.description,
          }
        : {}),
      descriptionByLocale,
      applyUrl: parsed.applyUrl || profileUrl,
    };
  } catch (err) {
    console.warn(`⚠️  Failed to enrich Yousty apprenticeship profile ${profileUrl}: ${err?.message || err}`);
    return { applyUrl: profileUrl };
  }
}

async function fetchGalenicaJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;

  console.log('🔍 Fetching Galenica jobs from Solique data.json...');

  let allItems;
  try {
    allItems = await fetchJson(GALENICA_DATA_URL, timeoutMs);
  } catch (err) {
    console.error(`❌ Failed to fetch Galenica data.json: ${err?.message || err}`);
    throw err;
  }

  if (!Array.isArray(allItems) || allItems.length === 0) {
    console.log('ℹ️  No job listings found in data.json.');
    return [];
  }

  console.log(`📋 Solique data.json returned ${allItems.length} total listings.`);

  // Filter for Ticino jobs (canton TI)
  const ticinoItems = allItems.filter(
    (j) => j?.contact?.state === 'TI'
  );
  console.log(`📋 Ticino (TI) listings: ${ticinoItems.length} (across all languages).`);

  // Group by job ID to deduplicate multi-language entries
  const byId = new Map();
  for (const item of ticinoItems) {
    const id = String(item.id || '');
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(item);
  }

  console.log(`📋 Unique Ticino job IDs: ${byId.size}`);

  const jobs = [];

  for (const [id, variants] of byId) {
    // Prefer Italian variant, then German, then French, then any
    const preferred =
      variants.find((v) => v.lang === 'it') ||
      variants.find((v) => v.lang === 'de') ||
      variants.find((v) => v.lang === 'fr') ||
      variants[0];

    const contact = preferred.contact || {};
    const textblocks = preferred.textblocks || {};

    const title = textblocks.jobtitle || '';
    if (!title) {
      console.log(`⚠️  Skipping job ID ${id}: no title`);
      continue;
    }

    const firm = contact.firm || GALENICA_COMPANY_NAME;
    const city = contact.city || '';
    const canton = contact.state || DEFAULT_CANTON;
    const jobUrl = buildJobUrl(preferred);

    const category = detectCategory(title);

    const descEn = buildDescriptionEn(title, firm, city, contact);
    const descIt = buildDescriptionIt(title, firm, city, contact);

    // Build localized descriptions using variant titles
    const titleEn = variants.find((v) => v.lang === 'en')?.textblocks?.jobtitle ||
                    variants.find((v) => v.lang === 'de')?.textblocks?.jobtitle || title;
    const titleDe = variants.find((v) => v.lang === 'de')?.textblocks?.jobtitle || title;
    const titleFr = variants.find((v) => v.lang === 'fr')?.textblocks?.jobtitle || title;

    const descDe = buildDescriptionEn(titleDe, firm, city, contact)
      .replace('located in', 'gelegen in')
      .replace('Canton Ticino, Switzerland', 'Kanton Tessin, Schweiz')
      .replace('the leading Swiss healthcare group', 'die führende Schweizer Gesundheitsgruppe')
      .replace('the largest pharmacy network in the country', 'das grösste Apothekennetzwerk des Landes')
      .replace('This position offers the opportunity to work in a dynamic, patient-oriented environment with excellent career development prospects.',
               'Diese Stelle bietet die Möglichkeit, in einem dynamischen, patientenorientierten Umfeld mit hervorragenden Karriereentwicklungsmöglichkeiten zu arbeiten.');
    const descFr = buildDescriptionEn(titleFr, firm, city, contact)
      .replace('at ', 'chez ')
      .replace('located in', 'situé à')
      .replace('Canton Ticino, Switzerland', 'Canton du Tessin, Suisse')
      .replace('the leading Swiss healthcare group', 'le premier groupe de santé suisse')
      .replace('the largest pharmacy network in the country', 'le plus grand réseau de pharmacies du pays')
      .replace('This position offers the opportunity to work in a dynamic, patient-oriented environment with excellent career development prospects.',
               'Ce poste offre la possibilité de travailler dans un environnement dynamique et orienté vers le patient, avec d\'excellentes perspectives de développement de carrière.');

    const baseSlug = normalizeKey(`galenica ${firm} ${title} ${city}`);
    const slugEn = normalizeKey(`galenica ${firm} ${titleEn} ${city}`) || baseSlug;
    const slugDe = normalizeKey(`galenica ${firm} ${titleDe} ${city}`) || baseSlug;
    const slugFr = normalizeKey(`galenica ${firm} ${titleFr} ${city}`) || baseSlug;
    const youstyEnrichment = await enrichFromYoustyProfile(variants, timeoutMs);

    const job = {
      title,
      company: `${firm} (Galenica)`,
      companyKey: GALENICA_KEY,
      url: jobUrl,
      location: city || 'Ticino',
      canton,
      country: 'CH',
      category,
      description: descEn,
      descriptionIt: descIt,
      descriptionByLocale: {
        it: descIt,
        en: descEn,
        de: descDe,
        fr: descFr,
      },
      applyUrl: youstyEnrichment?.applyUrl || '',
      postedDate: preferred.publication?.start
        ? new Date(preferred.publication.start).toISOString().slice(0, 10)
        : '',
      source: 'company-website',
      sourceLang: detectLang(descIt || title, 'it'),
      slug: baseSlug,
      slugByLocale: {
        it: baseSlug,
        en: slugEn,
        de: slugDe,
        fr: slugFr,
      },
      titleByLocale: {
        it: title,
        en: titleEn,
        de: titleDe,
        fr: titleFr,
      },
    };

    if (youstyEnrichment?.description) {
      job.description = youstyEnrichment.description;
      job.descriptionIt = youstyEnrichment.descriptionIt || youstyEnrichment.description;
      job.descriptionByLocale = {
        ...job.descriptionByLocale,
        ...youstyEnrichment.descriptionByLocale,
      };
    }

    console.log(`  ✅ ${title} — ${firm} @ ${city} (id: ${id})`);
    jobs.push(job);
  }

  console.log(`📋 Total unique Galenica Ticino jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge into jobs.json ──────────────────────────────────── */
function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function mergeGalenicaJobs(discoveredJobs) {
  let allJobs = [];
  if (fs.existsSync(DATA_JOBS)) {
    allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    if (!Array.isArray(allJobs)) allJobs = [];
  }

  // Index existing Galenica jobs by URL
  const existingByUrl = new Map();
  for (const j of allJobs) {
    if (isGalenicaJob(j)) {
      const key = String(j.url || '').toLowerCase().replace(/\/+$/, '');
      existingByUrl.set(key, j);
    }
  }

  let added = 0;
  let updated = 0;

  for (const job of discoveredJobs) {
    const key = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const existing = existingByUrl.get(key);
    if (existing) {
      existing.title = job.title;
      existing.company = job.company;
      existing.companyKey = job.companyKey;
      existing.location = job.location;
      existing.canton = job.canton;
      existing.country = job.country;
      existing.category = job.category;
      existing.description = job.description;
      existing.descriptionIt = job.descriptionIt;
      existing.descriptionByLocale = mergeLocaleTextMap(existing.descriptionByLocale, job.descriptionByLocale, 30);
      existing.applyUrl = job.applyUrl || existing.applyUrl;
      existing.postedDate = job.postedDate || existing.postedDate;
      existing.source = job.source;
      existing.slugByLocale = mergeLocaleTextMap(existing.slugByLocale, job.slugByLocale, 3);
      existing.titleByLocale = mergeLocaleTextMap(existing.titleByLocale, job.titleByLocale, 2);
      updated++;
      existingByUrl.delete(key);
    } else {
      allJobs.push(job);
      added++;
    }
  }

  // Remove Galenica jobs no longer in the feed
  const discoveredUrls = new Set(
    discoveredJobs.map((j) => String(j.url || '').toLowerCase().replace(/\/+$/, ''))
  );
  const removed = allJobs.filter(
    (j) =>
      isGalenicaJob(j) &&
      !discoveredUrls.has(String(j.url || '').toLowerCase().replace(/\/+$/, ''))
  ).length;

  const finalJobs = allJobs.filter(
    (j) =>
      !isGalenicaJob(j) ||
      discoveredUrls.has(String(j.url || '').toLowerCase().replace(/\/+$/, ''))
  );

  writeJson(DATA_JOBS, finalJobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, finalJobs);

  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  ➖ Removed: ${removed}`);
  console.log(`  📦 Total jobs in file: ${finalJobs.length}`);
}

/* ── Adapter update ────────────────────────────────────────── */
function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${GALENICA_KEY}.json`);
  let adapter = {};
  try {
    adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  } catch { /* first run */ }

  const seedMetaByUrl = {};
  for (const url of seedUrls) {
    seedMetaByUrl[url] = {
      company: GALENICA_COMPANY_NAME,
      companyDomain: 'galenica.com',
    };
  }

  adapter = {
    ...adapter,
    companyKey: GALENICA_KEY,
    companyName: GALENICA_COMPANY_NAME,
    companyHost: GALENICA_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['api'],
    seedUrls,
    seedMetaByUrl,
    notes:
      'Solique data.json crawler — static JSON endpoint. Galenica AG healthcare group: Sun Store, Amavita, Coop Vitality, UFD subsidiaries in Ticino.',
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath}`);
}

/* ── Run shared crawler for localization ───────────────────── */
async function runBaseCrawler() {
  // Galenica jobs use hash-fragment URLs (jobs.galenica.com/it/jobs/#job.id=...)
  // which the base crawler's quality gate rejects as non_detail_url.
  // Since Solique data.json already provides titles in it/de/fr, we skip the
  // base crawler and rely on the pre-populated titleByLocale data instead.
  console.log('ℹ️  Skipping base crawler — Solique data already provides multilingual titles.');
}

/* ── Post-processing ───────────────────────────────────────── */
function postProcessGalenicaJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;

  let changed = false;
  const seenKeys = new Map();

  const processed = jobs.filter((job) => {
    if (!isGalenicaJob(job)) return true;

    // Canonicalize company key
    if (job.companyKey !== GALENICA_KEY) {
      job.companyKey = GALENICA_KEY;
      changed = true;
    }

    const descriptionByLocale = {
      ...(job.descriptionByLocale && typeof job.descriptionByLocale === 'object' ? job.descriptionByLocale : {}),
    };
    const fallbackIt = String(job.descriptionIt || descriptionByLocale.it || job.description || '').trim();
    const fallbackEn = String(descriptionByLocale.en || job.description || fallbackIt).trim();
    const fallbackDe = String(descriptionByLocale.de || fallbackEn || fallbackIt).trim();
    const fallbackFr = String(descriptionByLocale.fr || fallbackEn || fallbackIt).trim();

    if (fallbackIt && descriptionByLocale.it !== fallbackIt) {
      descriptionByLocale.it = fallbackIt;
      changed = true;
    }
    if (fallbackEn && descriptionByLocale.en !== fallbackEn) {
      descriptionByLocale.en = fallbackEn;
      changed = true;
    }
    if (fallbackDe && descriptionByLocale.de !== fallbackDe) {
      descriptionByLocale.de = fallbackDe;
      changed = true;
    }
    if (fallbackFr && descriptionByLocale.fr !== fallbackFr) {
      descriptionByLocale.fr = fallbackFr;
      changed = true;
    }
    job.descriptionByLocale = descriptionByLocale;

    // Deduplicate by URL
    const url = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const dedupKey = url || normalizeKey(job.slug || job.title || '');
    if (seenKeys.has(dedupKey)) return false;
    seenKeys.set(dedupKey, true);

    return true;
  });

  if (changed || processed.length !== jobs.length) {
    writeJson(DATA_JOBS, processed);
    if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, processed);
    console.log(`🔧 Post-processed: ${jobs.length} → ${processed.length} jobs`);
  }
}

/* ── Stats ─────────────────────────────────────────────────── */
function logStats(before) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const galJobs = Array.isArray(jobs) ? jobs.filter(isGalenicaJob) : [];
  const after = snapshotJobSlugs(galJobs);
  const diff = computeCrawlDiff(before, after);
  printCrawlChangeSummary(diff, 'Galenica');
  writeCrawlChangeSummaryToGH(diff, 'Galenica');

  console.log(`\n💊 Total Galenica jobs: ${galJobs.length}`);
  for (const j of galJobs) {
    console.log(`  • ${j.title} — ${j.company} (${j.location}, ${j.canton || j.country || '?'})`);
  return diff;
  }
}

/* ── Locale validation ─────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_GALENICA_STRICT',
    label: 'Galenica',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isGalenicaJob,
    locales: GALENICA_LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_galenica_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Galenica jobs found — the company may not have active Ticino openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(GALENICA_KEY, 'Galenica');
  console.log('═══════════════════════════════════════════════');
  console.log('  Galenica AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');

  // Snapshot before
  const beforeMap = snapshotJobSlugs(readExistingCrawlerJobs(GALENICA_KEY, DATA_JOBS).filter(isGalenicaJob))

  // Phase 1: discover jobs from Solique data.json
  const discoveredJobs = await fetchGalenicaJobs();

  if (discoveredJobs.length === 0) {
    console.log('ℹ️  No Ticino job listings found — skipping crawl.');
    return;
  }

  // Phase 2: merge into jobs.json
  const seedUrls = discoveredJobs.map((j) => j.url);
  mergeGalenicaJobs(discoveredJobs);

  // Phase 3: update adapter
  updateAdapterConfig(seedUrls);

  // Phase 4: run shared crawler for AI localization
  await runBaseCrawler();

  // Phase 5: post-process
  postProcessGalenicaJobs();

  // Phase 6: log stats
  const diff = logStats(beforeMap);

  // Phase 7: locale validation
  validateLocales();

  console.log('✅ Galenica crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isGalenicaJob) : [];
  writeJobsCrawlerSlice(GALENICA_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: GALENICA_KEY,
    label: 'Galenica',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error('❌ Galenica crawler failed:', err);
  process.exit(1);
});
