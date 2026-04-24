#!/usr/bin/env node
/**
 * Dedicated Migros crawler runner.
 * Runs only Migros Ticino jobs and enforces full locale coverage
 * for SEO-critical fields.
 *
 * The Migros careers portal at jobs.migros.ch is a Nuxt.js SPA.
 * The listing page renders ~7 pinned jobs in the SSR HTML, but the
 * full result set (54+ positions across Ticino/Grigioni) is only
 * visible after client-side hydration and pagination clicks.
 *
 * This script:
 *   1. Launches a headless Chromium via Playwright on the listing
 *      URL with REGION=868,871,878 (Ticino + Svizzera meridionale
 *      + Grigioni Italiani), accepts the cookie banner, then clicks
 *      "Pagina successiva" repeatedly until the button is disabled.
 *   2. Collects every job detail href (any locale prefix) and sets
 *      them as adapter seed URLs.
 *   3. Runs the base crawler which fetches each detail page and
 *      parses the HTML content (no JSON-LD — Migros uses Nuxt
 *      with __NUXT_DATA__ hydration payloads).
 *
 * Listing URL pattern:
 *   https://jobs.migros.ch/it/le-nostre-imprese/gruppo-migros/posti-di-lavoro-vacanti?REGION={ids}
 *
 * Detail page URL pattern:
 *   https://jobs.migros.ch/{it|de|fr|en}/{le-nostre-imprese|unsere-unternehmen|nos-entreprises|our-companies}/job/{company-slug}/{job-slug}/{uuid}
 *
 * Region IDs (Migros internal taxonomy):
 *   868 = Grigioni
 *   871 = Svizzera meridionale (includes Ticino area)
 *   878 = Regione bilingue Grigioni italiano
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, normalize } from './lib/dedicated-crawler-common.mjs';
import { runQualityGuards } from './lib/crawler-quality-guards.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const MIGROS_KEY = 'migros-ticino';

/**
 * Migros listing page URL with all Italian-speaking/adjacent region IDs combined.
 *
 *   868 = Grigioni
 *   871 = Svizzera meridionale (includes Ticino)
 *   878 = Regione bilingue Grigioni italiano
 */
const LISTING_URL =
  'https://jobs.migros.ch/it/le-nostre-imprese/gruppo-migros/posti-di-lavoro-vacanti?REGION=868,871,878';

/**
 * Regex matching a Migros job detail href in any of the four locale prefixes.
 * Pattern: /{locale}/{segment}/job/{company-slug}/{job-slug}/{uuid}
 */
const JOB_DETAIL_HREF_RE =
  /^\/(it|de|fr|en)\/(le-nostre-imprese|unsere-unternehmen|nos-entreprises|our-companies)\/job\/[^/]+\/[^/]+\/[a-f0-9-]{36}$/;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Match a job object as belonging to the Migros crawl.
 */
function isMigrosJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === MIGROS_KEY ||
    key.includes('migros-ticino') ||
    host.includes('jobs.migros.ch') ||
    (company.includes('migros') && (company.includes('ticino') || company.includes('cooperativa'))) ||
    (company.includes('scuola club') && company.includes('migros'))
  );
}

/**
 * Check whether a URL belongs to one of Migros' trusted domains.
 */
function isTrustedMigrosDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.endsWith('migros.ch') ||
      host.endsWith('migrosticino.ch')
    );
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
// Listing page fetching
// ──────────────────────────────────────────────────────────────

/**
 * Discover Migros job detail URLs via headless Chromium (Playwright).
 *
 * The listing is a Nuxt.js SPA: SSR only renders ~7 pinned jobs; the full
 * search result set is populated after client-side hydration, and pagination
 * is driven by a "Pagina successiva" button (no query-string paging).
 *
 * This function:
 *   1. Opens the listing with REGION=868,871,878 in Chromium.
 *   2. Accepts the OneTrust cookie banner (required — without it, the results
 *      panel renders only a handful of "suggested" jobs).
 *   3. Collects every anchor matching {locale}/{segment}/job/... .
 *   4. Clicks "Pagina successiva" until disabled, merging results each time.
 *
 * Returns absolute job detail URLs in whatever locale Migros served them
 * (mixed IT/DE is normal — individual job sourceLang is detected downstream).
 */
async function fetchMigrosJobDetailUrls() {
  const headless = process.env.JOBS_MIGROS_HEADLESS !== '0';
  const navTimeoutMs = Number(process.env.JOBS_MIGROS_NAV_TIMEOUT_MS) || 30000;
  const paginationTimeoutMs = Number(process.env.JOBS_MIGROS_PAGINATION_TIMEOUT_MS) || 2000;
  const maxPages = Number(process.env.JOBS_MIGROS_MAX_PAGES) || 25;

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'it-CH',
    viewport: { width: 1400, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'it-CH,it;q=0.9' },
  });
  const page = await context.newPage();

  const allUrls = new Set();

  try {
    console.log(`🔍 Opening Migros listing (${LISTING_URL})`);
    await page.goto(LISTING_URL, { waitUntil: 'networkidle', timeout: navTimeoutMs });

    // Accept cookies — without this the results panel stays at ~4 suggested items
    const consent = page
      .locator(
        'button:has-text("Accetta tutti i cookie"), #onetrust-accept-btn-handler, button:has-text("Accetta")',
      )
      .first();
    if (await consent.isVisible().catch(() => false)) {
      await consent.click().catch(() => {});
      await page.waitForTimeout(1500);
      console.log('  🍪 Cookie consent accepted');
    }

    // Wait for hydration — result panel populates a second or two after consent
    await page.waitForTimeout(3000);

    const collect = () =>
      page.evaluate((reSrc) => {
        const re = new RegExp(reSrc);
        const out = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const p = a.getAttribute('href');
          if (p && re.test(p)) out.add(p);
        }
        return [...out];
      }, JOB_DETAIL_HREF_RE.source);

    let pageIdx = 1;
    for (const u of await collect()) allUrls.add(u);
    console.log(`  📄 Page ${pageIdx}: ${allUrls.size} unique URLs so far`);

    while (pageIdx < maxPages) {
      const nextBtn = page
        .locator('button[aria-label*="successiva" i], button:has-text("Pagina successiva")')
        .first();

      const visible = await nextBtn.isVisible().catch(() => false);
      const disabled = await nextBtn.isDisabled().catch(() => true);
      if (!visible || disabled) break;

      await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
      await nextBtn.click().catch(() => {});
      await page.waitForTimeout(paginationTimeoutMs);
      pageIdx += 1;

      const before = allUrls.size;
      for (const u of await collect()) allUrls.add(u);
      const added = allUrls.size - before;
      console.log(`  📄 Page ${pageIdx}: +${added} (${allUrls.size} total)`);
      if (added === 0) break;
    }
  } finally {
    await browser.close();
  }

  const absoluteUrls = [...allUrls].map((p) => `https://jobs.migros.ch${p}`);
  console.log(`✅ Total unique Migros detail URLs discovered: ${absoluteUrls.length}`);
  return absoluteUrls;
}

// ──────────────────────────────────────────────────────────────
// Adapter setup
// ──────────────────────────────────────────────────────────────

/**
 * Ensure the Migros adapter JSON has the correct seed URLs
 * (detail page URLs discovered from the listing page).
 */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${MIGROS_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${MIGROS_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: MIGROS_KEY,
      companyName: 'Migros Ticino',
      companyHost: 'jobs.migros.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html'],
      seedUrls,
      notes: 'Nuxt.js SSR careers portal — detail URLs scraped from listing pages, each page has rich HTML content.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.companyHost = 'jobs.migros.ch';
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.unshift('generic_ats');
    }
    // Remove jsonld mode since Migros doesn't have JSON-LD
    adapter.crawlerModes = adapter.crawlerModes.filter((m) => m !== 'jsonld');
    if (!adapter.crawlerModes.includes('html')) adapter.crawlerModes.push('html');
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes = 'Nuxt.js SSR careers portal — detail URLs scraped from listing pages, each page has rich HTML content.';
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${MIGROS_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: MIGROS_KEY,
    localizeOnlyCompanyKeys: MIGROS_KEY,
    forceLocalizationWhenAiEnabledOnly: true,
    disableWorkdayForce: true,
  });
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logMigrosJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const migrosJobs = allJobs.filter(isMigrosJob);
  const ticinoJobs = migrosJobs.filter((job) => normalize(job?.canton) === 'ti');
  const grJobs = migrosJobs.filter((job) => normalize(job?.canton) === 'gr');
  const otherJobs = migrosJobs.length - ticinoJobs.length - grJobs.length;

  console.log(`\n📊 === Migros Ticino Job Stats ===`);
  console.log(`  🛒 Job totali trovati (Migros): ${migrosJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  console.log(`  ✅ Job in Grigioni (canton=GR): ${grJobs.length}`);
  if (otherJobs > 0) {
    console.log(`  ℹ️ Job in altri cantoni: ${otherJobs}`);
    const examples = migrosJobs
      .filter((job) => !['ti', 'gr'].includes(normalize(job?.canton)))
      .map((job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`)
      .slice(0, 10);
    for (const loc of examples) console.log(`     - ${loc}`);
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(migrosJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Migros');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Migros');

  return { total: migrosJobs.length, ticino: ticinoJobs.length, crawlDiff };

}

function validateMigrosLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MIGROS_STRICT',
    label: 'Migros',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isMigrosJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedMigrosDomain,
    untrustedDomainReason: 'untrusted_domain_for_migros_job',
    noJobsMessage: 'Nessun job Migros trovato dopo il crawl — niente da validare.',
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(MIGROS_KEY, 'Migros');
  console.log('🛒 Running dedicated Migros Ticino jobs crawler...');
  console.log('   Platform: Nuxt.js SPA (jobs.migros.ch) via Playwright');
  console.log('   Regions: 868 (Grigioni) + 871 (Svizzera meridionale) + 878 (bilingue)');
  console.log('');

  // Step 1: Fetch job detail URLs from the SSR listing pages
  const detailUrls = await fetchMigrosJobDetailUrls();
  if (detailUrls.length === 0) {
    console.log('ℹ️ Nessun URL di dettaglio Migros trovato dalla listing. Uscita OK.');
    return;
  }

  // Step 2: Update the adapter with the discovered detail URLs as seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(MIGROS_KEY, DATA_JOBS).filter(isMigrosJob))

  // Step 3: Run the base crawler which fetches each SSR detail page
  // and parses the HTML content
  await runBaseCrawler();

  // Step 3b: Ensure sourceLang is set on all Migros jobs
  {
    const raw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
    const allJobs = Array.isArray(raw) ? raw : [];
    let patched = 0;
    for (const job of allJobs) {
      if (!isMigrosJob(job)) continue;
      if (!job.sourceLang) {
        job.sourceLang = detectLang(job.description || job.title, 'it');
        patched++;
      }
    }
    if (patched > 0) {
      fs.writeFileSync(DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
      console.log(`  🏷️ Set sourceLang on ${patched} Migros job(s).`);
    }
  }

  // Step 3c: Quality guards — reject jobs with thin descriptions or an
  // implausible company name (implements docs/copilot-crawler-fix-prompts.md
  // for Migros). Gated behind SKIP_QUALITY_GUARDS=1 for emergency bypass.
  if (process.env.SKIP_QUALITY_GUARDS !== '1') {
    const raw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
    const allJobs = Array.isArray(raw) ? raw : [];
    const migrosJobs = allJobs.filter(isMigrosJob);
    const report = runQualityGuards(migrosJobs, {
      companyName: ['Migros', 'Migros Ticino', 'Migros Aare', 'Gruppo Migros'],
      minDescription: 200,
      logger: (msg) => console.warn(msg),
    });
    if (report.rejected > 0) {
      const keptIds = new Set(migrosJobs.map((j) => j.id || j.url));
      const filtered = allJobs.filter((j) => !isMigrosJob(j) || keptIds.has(j.id || j.url));
      fs.writeFileSync(DATA_JOBS, JSON.stringify(filtered, null, 2) + '\n');
      console.log(
        `  🧹 Migros quality guards: rejected ${report.rejected} job(s) — ${JSON.stringify(report.reasons)}`,
      );
    }
  }

  // Step 4: Log stats and validate
  const stats = logMigrosJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job Migros trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  validateMigrosLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isMigrosJob) : [];
  writeJobsCrawlerSlice(MIGROS_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: MIGROS_KEY,
    label: 'Migros',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ Migros crawler failed: ${err?.message || err}`);
  process.exit(1);
});
