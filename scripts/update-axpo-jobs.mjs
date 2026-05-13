#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  printPublishedJobUrls,
  writeJobsSummary,
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import {
  htmlToMarkdown,
  decodeEntities,
  validateAxpoDescription,
} from './lib/axpo-job-parser.mjs';
import { isTargetSwissLocation, inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'axpo-group.json');

const COMPANY_KEY = 'axpo-group';
const COMPANY_NAME = 'Axpo Group';
const COMPANY_DOMAIN = 'axpo.com';
const RSS_URL = 'https://careers.axpo.com/jobs.rss';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '15000', 10);
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoCrawler/1.0)';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function slugify(value = '') {
  return String(value || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function stripHtml(html = '') {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function isTargetJob(job) {
  if (!job) return false;
  if (job.companyKey === COMPANY_KEY) return true;
  const cn = normalize(job.company || '');
  return cn.includes('axpo');
}

function jobMatchKey(job) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function isGrCity(city = '') {
  return isTargetSwissLocation(city);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────
// Category inference
// ──────────────────────────────────────────────────────────────

function inferCategory(department = '', title = '') {
  const hay = `${department} ${title}`.toLowerCase();
  if (/(engineering|techni|bau|construction|anlagen|elektr)/i.test(hay)) return 'engineering';
  if (/(finance|finanzbuch|account|controlling|revision)/i.test(hay)) return 'finance';
  if (/(operation|production|betrieb|dispatch|schicht)/i.test(hay)) return 'operations';
  if (/(it|digital|software|data|cyber|security)/i.test(hay)) return 'it';
  if (/(sales|customer|account manager|vertrieb|kundengeschäft)/i.test(hay)) return 'sales';
  if (/(legal|compliance|recht)/i.test(hay)) return 'legal';
  if (/(hr|human|personal|talent)/i.test(hay)) return 'hr';
  if (/(marketing|communication|kommunikation)/i.test(hay)) return 'marketing';
  if (/(project|projekt)/i.test(hay)) return 'project-management';
  return 'energy';
}

function mapEmploymentType(role = '') {
  const r = role.toLowerCase();
  if (r.includes('praktik') || r.includes('intern') || r.includes('trainee') || r.includes('stage')) return 'internship';
  if (r.includes('teilzeit') || r.includes('part')) return 'part_time';
  if (r.includes('temporär') || r.includes('befristet')) return 'temporary';
  return 'full_time';
}

// ──────────────────────────────────────────────────────────────
// RSS parsing
// ──────────────────────────────────────────────────────────────

function parseRssItems(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
    };
    const getAll = (tag) => {
      const results = [];
      const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
      let m2;
      while ((m2 = re.exec(block)) !== null) results.push(m2[1].trim());
      return results;
    };

    // Parse locations
    const locations = [];
    const locRegex = /<tt:location>([\s\S]*?)<\/tt:location>/g;
    let locMatch;
    while ((locMatch = locRegex.exec(block)) !== null) {
      const locBlock = locMatch[1];
      const locGet = (tag) => {
        const m = locBlock.match(new RegExp(`<tt:${tag}>([\\s\\S]*?)<\/tt:${tag}>`));
        return m ? m[1].trim() : '';
      };
      locations.push({
        name: locGet('name'),
        address: locGet('address'),
        zip: locGet('zip'),
        city: locGet('city'),
        country: locGet('country'),
      });
    }

    items.push({
      title: get('title'),
      description: get('description'),
      pubDate: get('pubDate'),
      link: get('link'),
      guid: get('guid'),
      companyName: get('company_name'),
      department: get('tt:department'),
      role: get('tt:role'),
      remoteStatus: get('remoteStatus'),
      locations,
    });
  }
  return items;
}

// ──────────────────────────────────────────────────────────────
// Fetch
// ──────────────────────────────────────────────────────────────

async function fetchRss() {
  console.log(`🔍 Fetching RSS from ${RSS_URL} ...`);
  const res = await fetch(RSS_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const items = parseRssItems(xml);
  console.log(`📋 Total items in RSS: ${items.length}`);
  return items;
}

// ──────────────────────────────────────────────────────────────
// Filter and build
// ──────────────────────────────────────────────────────────────

function filterSwissGrJobs(items) {
  const grJobs = [];
  for (const item of items) {
    // Check if any location is in GR canton
    const grLocations = item.locations.filter(
      (loc) => loc.country === 'Switzerland' && isGrCity(loc.city)
    );
    if (grLocations.length > 0) {
      grJobs.push({ ...item, grLocations });
    }
  }
  return grJobs;
}

function buildJob(item) {
  const title = item.title || '';
  const link = item.link || '';
  const grLoc = item.grLocations[0] || {};
  const city = grLoc.city || '';
  const slug = slugify(`${title}-${item.guid || ''}`);

  // Convert entity-encoded HTML from RSS to structured markdown
  const rssHtml = item.description || '';
  const detail = htmlToMarkdown(rssHtml);
  const description = detail.markdown.slice(0, 5000);

  // Validate quality
  const validation = validateAxpoDescription(detail);
  if (!validation.ok) {
    console.warn(`  ⚠️ Quality warnings for "${title}":`);
    for (const w of validation.warnings) console.warn(`    - ${w}`);
  }

  const sourceLang = detectLang(title + ' ' + description) || 'de';
  const category = inferCategory(item.department, title);
  const empType = mapEmploymentType(item.role || title);

  // Parse pubDate
  let postedDate = todayIso();
  if (item.pubDate) {
    try {
      const d = new Date(item.pubDate);
      if (!isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
    } catch { /* keep default */ }
  }

  return {
    title,
    slug,
    url: link,
    applyUrl: link,
    company: item.companyName || COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: inferAnyCanton(city) || 'GR',
    addressCountry: 'CH',
    canton: inferAnyCanton(city) || 'GR',
    country: 'CH',
    category,
    sector: 'Energia & Utilities',
    department: item.department || '',
    source: 'axpo-dedicated-crawler',
    sourceLang,
    postedDate,
    validThrough: '',
    employmentType: empType,
    contractType: empType === 'internship' ? 'stage' : 'permanent',
    description,
    titleByLocale: {},
    descriptionByLocale: {},
    slugByLocale: {},
    crawledAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────
// Merge
// ──────────────────────────────────────────────────────────────

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = discoveredJobs.map((job) => {
    const prev = existingByKey.get(jobMatchKey(job));
    if (!prev) {
      added += 1;
      return job;
    }
    updated += 1;
    // If description changed substantially, mark for re-translation
    const prevDesc = (prev.description || '').trim();
    const newDesc = (job.description || '').trim();
    const descChanged =
      newDesc.length > 0 &&
      prevDesc.length > 0 &&
      Math.abs(newDesc.length - prevDesc.length) > 100;

    return {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(
        descChanged ? {} : prev.descriptionByLocale,
        job.descriptionByLocale,
        30,
      ),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
      ...(descChanged ? { needsRetranslation: true } : {}),
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
    writeJson(PUBLIC_JOBS, allJobs);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  return { total: allJobs.length, added, updated, targetCount: mergedTarget.length, diff };
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'axpo');
  console.log(`\n⚡ Axpo Group — Dedicated Job Crawler`);
  console.log(`   Source: Teamtailor RSS (careers.axpo.com)`);
  console.log(`   Company key: ${COMPANY_KEY}\n`);

  // Validate adapter
  const adapter = readJson(ADAPTER_PATH, null);
  if (!adapter || !adapter.enabled) {
    console.warn('⚠️ Adapter not found or disabled — exiting.');
    process.exit(0);
  }

  // Phase 1 — Fetch RSS
  console.log('═══════════════════════════════════════');
  console.log('Phase 1: Fetch RSS');
  console.log('═══════════════════════════════════════');
  const allItems = await fetchRss();

  // Phase 2 — Filter for GR
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 2: Filter Swiss GR jobs');
  console.log('═══════════════════════════════════════');
  const grItems = filterSwissGrJobs(allItems);
  console.log(`📋 GR jobs found: ${grItems.length}`);
  for (const item of grItems) {
    const cities = item.grLocations.map((l) => l.city).join(', ');
    console.log(`  📄 ${item.title} | ${cities} | ${item.department}`);
  }

  if (grItems.length === 0) {
    console.log('ℹ️ No GR jobs found — nothing to update.');
    process.exit(0);
  }

  // Phase 3 — Build jobs
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 3: Build job objects');
  console.log('═══════════════════════════════════════');
  const jobs = grItems.map(buildJob);
  console.log(`📊 Built ${jobs.length} job objects`);

  // Phase 4 — Merge
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 4: Merge');
  console.log('═══════════════════════════════════════');
  const stats = mergeJobs(jobs);
  const diff = stats.diff;
  console.log(`\n📈 Result: ${stats.targetCount} Axpo GR jobs (${stats.added} new, ${stats.updated} updated)`);
  console.log(`   Total jobs in file: ${stats.total}`);

  // Phase 5 — Translate + validate
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 5: Translate');
  console.log('═══════════════════════════════════════');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_AXPO_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    failWhenNoJobs: true,
    noJobsMessage: 'No Axpo GR jobs found after dedicated crawl.',
  });

  // Phase 6 — Summary
  printPublishedJobUrls(jobs);
  writeJobsSummary(COMPANY_KEY, stats);

  console.log('\n✅ Axpo Group crawler complete.\n');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'axpo',
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
  console.error('❌ Fatal crawler error:', err);
  process.exit(1);
});
