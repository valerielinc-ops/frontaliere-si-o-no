#!/usr/bin/env node
/**
 * Dedicated Sintetica SA (Mendrisio, TI) crawler runner.
 *
 * Sintetica uses the NCore Platform at:
 *   https://app.ncoreplat.com/jobboard/1255/sintetica
 * Detail pages at: /jobposition/{id}/{slug}/sintetica
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData, detectLang } from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parseListingPage, parseDetailPage, slugify, detectCategory, detectExperienceLevel, inferEmploymentType, MIN_DESC_LENGTH } from './lib/sintetica-job-parser.mjs';
import { normalizeAnyCantonCode, isTargetCanton } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'sintetica';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Sintetica SA';
const COMPANY_HOST = 'app.ncoreplat.com';
const CAREERS_URL = 'https://app.ncoreplat.com/jobboard/1255/sintetica';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Sintetica operates two Swiss production sites; address attribution must
// follow the site named in the job title, not the HQ default.
export const SINTETICA_SITES = {
  mendrisio: {
    location: 'Mendrisio', addressLocality: 'Mendrisio',
    canton: 'TI', addressRegion: 'TI', addressCountry: 'CH',
    postalCode: '6850', streetAddress: 'Via Penate 5',
  },
  couvet: {
    location: 'Couvet', addressLocality: 'Couvet',
    canton: 'NE', addressRegion: 'NE', addressCountry: 'CH',
    postalCode: '2108', streetAddress: "Rue de l'Ecluse 28",
  },
};

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }

/** Detect Sintetica production site from job title. Returns 'mendrisio' | 'couvet' | ''. */
export function detectSinteticaSite(title = '') {
  const t = normalize(title);
  if (/\bcouvet\b/.test(t)) return 'couvet';
  if (/\bmendrisio\b/.test(t)) return 'mendrisio';
  return '';
}

/** Extract canton from title patterns like "... - Mendrisio site (Ticino)" or "... (Neuchâtel)" */
function detectCantonFromTitle(title = '') {
  const m = title.match(/\(([^)]+)\)\s*$/);
  if (!m) return '';
  return normalizeAnyCantonCode(m[1]);
}
function isCompanyJob(job) {
  const key = normalize(job?.companyKey || ''); const company = normalize(job?.company || ''); const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('sintetica') || company.includes('sintetica') || url.includes('sintetica');
}
function isTrustedDomain(rawUrl = '') { try { const h = new URL(rawUrl).hostname.toLowerCase(); return h.includes('ncoreplat.com') || h.includes('sintetica'); } catch { return false; } }

// NCore Platform (app.ncoreplat.com) returns a 919-byte SPA shell to
// identify-as-bot User-Agents and the full server-rendered HTML (~95 KB)
// to standard browser UAs. Empirically: with our default bot UA, every
// Sintetica detail page returned <1 KB and parseDetailPage fell back to
// the boilerplate; with a Chrome UA, descriptions clock in at 6-8 K chars.
// The override env var is preserved for tests/custom deployments.
const SINTETICA_DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchPage(url, timeoutMs = 20000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9,it-CH;q=0.8', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || SINTETICA_DEFAULT_UA } });
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status}`); return null; } return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; }
  finally { clearTimeout(timer); }
}

async function fetchJobs() {
  console.log(`🔍 Fetching Sintetica SA jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('❌ Failed to fetch Sintetica careers page.'); return []; }
  const listings = parseListingPage(html);
  console.log(`  📋 Jobs found: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const raw of listings) {
    // Resolve the production site from the title (Mendrisio vs Couvet).
    // Default to Mendrisio when the title has no site marker (HQ + most postings).
    const siteKey = detectSinteticaSite(raw.title) || 'mendrisio';
    const site = SINTETICA_SITES[siteKey];
    if (!site) {
      console.log(`  ⏭️ Skipping job at unknown Sintetica site: "${raw.title}"`);
      continue;
    }
    // Drop jobs at sites whose canton is outside our target list.
    if (!isTargetCanton(site.canton)) {
      console.log(`  ⏭️ Skipping non-target canton job: "${raw.title}" (canton: ${site.canton})`);
      continue;
    }
    // Belt-and-braces: the title may parenthesise a canton that disagrees
    // with the site we picked (e.g. typo, future site). Trust the explicit
    // canton tag when it points outside our target list.
    const titleCanton = detectCantonFromTitle(raw.title);
    if (titleCanton && !isTargetCanton(titleCanton)) {
      console.log(`  ⏭️ Skipping non-target canton job: "${raw.title}" (canton: ${titleCanton})`);
      continue;
    }

    const slug = slugify(raw.title, 'sintetica');
    const fallbackDesc = `${raw.title} — posizione aperta presso Sintetica SA al sito di ${site.location} (${site.canton}), Svizzera. Sintetica SA è un'azienda farmaceutica svizzera specializzata nella produzione di farmaci sterili iniettabili.`;

    // Fetch detail page for full job description
    let description = raw.snippet || '';
    let detailClosed = false;
    if (raw.url) {
      console.log(`    🔗 Fetching detail page: ${raw.url}`);
      const detailHtml = await fetchPage(raw.url);
      if (detailHtml) {
        const detail = parseDetailPage(detailHtml);
        if (detail.closed) {
          // NCore reports the position as closed — skip rather than persist
          // a stub. The listing-page link is stale; the live job is gone.
          console.log(`    🚫 Detail page reports position closed: "${raw.title}"`);
          detailClosed = true;
        } else if (detail.body && detail.body.length >= MIN_DESC_LENGTH) {
          description = `${raw.title} — Sintetica SA, ${site.location} (${site.canton}).\n\n${detail.body}`;
          console.log(`    ✅ Detail description: ${detail.body.length} chars`);
        } else {
          console.log(`    ⚠️ Detail page description too short (${(detail.body || '').length} chars), using fallback`);
        }
      } else {
        console.log(`    ⚠️ Could not fetch detail page, using fallback`);
      }
    }
    if (detailClosed) continue;
    if (!description || description.length < MIN_DESC_LENGTH) {
      description = fallbackDesc;
    }

    jobs.push({
      url: raw.url, applyUrl: raw.url, title: raw.title,
      company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: site.location, canton: site.canton, country: 'CH',
      addressLocality: site.addressLocality, addressRegion: site.addressRegion, addressCountry: site.addressCountry,
      postalCode: site.postalCode, streetAddress: site.streetAddress,
      description,
      titleByLocale: { en: raw.title }, descriptionByLocale: {},
      slug, slugByLocale: { en: slug, it: slug },
      category: detectCategory(raw.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'sintetica-careers-crawler', employmentType: inferEmploymentType(raw.title, raw.snippet || ''),
      experienceLevel: detectExperienceLevel(raw.title),
      sector: 'Farmaceutica',
      _targetScope: { canton: site.canton, location: site.location },
      sourceLang: detectLang(description || raw.title, 'en'),
    });
  }
  return jobs;
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingCompanyJobs = (Array.isArray(existing) ? existing : []).filter(isCompanyJob);

  const existingKeys = new Set(existingCompanyJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const discoveredKeys = new Set(discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingCompanyJobs, discoveredJobs);

  const final = [...nonCompanyJobs, ...merged];
  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);
  console.log(`📦 Merge: ➕ ${added}, 🔄 ${updated}, 📊 ${final.length} total`);
}

function updateAdapterConfig(seedUrls) {
  const p = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const a = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: 'NCore Platform — Sintetica SA pharma jobs in Mendrisio, TI.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Sintetica SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Sintetica jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_SINTETICA_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_sintetica_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  // Read from data/jobs.json (just written by mergeJobs above) — NOT via
  // readExistingCrawlerJobs which prefers the slice and would otherwise echo
  // back the stale committed slice, losing this run's fetches entirely.
  const _afterMerge = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = (Array.isArray(_afterMerge) ? _afterMerge : []).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Sintetica SA crawler complete.');
}

main().catch((err) => exitCrawlerOnError(err, 'Sintetica'));
