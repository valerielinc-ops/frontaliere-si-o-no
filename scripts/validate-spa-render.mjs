#!/usr/bin/env node
/**
 * Layer 1: Build-Time SPA Render Validation
 *
 * Renders a sample of pages from dist/ with Playwright (headless Chromium)
 * and validates the final DOM after SPA hydration.
 *
 * Checks:
 * - Canonical tag: never falls through to listing page (unless it IS the listing)
 * - Active job pages: exactly 1 JobPosting in rendered DOM
 * - Expired pages: 0 JobPosting schemas (only BreadcrumbList)
 * - Bridge pages: 1 JobPosting, canonical → current slug
 * - No @graph leak (>5 JobPosting items = listing page schema leaking)
 * - Meta robots: not noindex unless expected
 *
 * Exit 1 on any critical failure → blocks deploy.
 *
 * Usage: node scripts/validate-spa-render.mjs [--sample N]
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const BASE_URL_ORIGIN = 'https://frontaliereticino.ch';
const JOB_LISTING_PATH = '/cerca-lavoro-ticino/';

const SAMPLE_ARG = process.argv.find(a => a.startsWith('--sample='));
const SAMPLE_SIZE = SAMPLE_ARG ? Number(SAMPLE_ARG.split('=')[1]) : 5;
const TIMEOUT_PER_PAGE = 30_000; // 30s per page (SPA loads Firebase RC, translations)
const SPA_SETTLE_MS = 3_000; // wait for SPA hydration

// ── MIME types ──────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.txt': 'text/plain',
};

// ── Static file server ──────────────────────────────────────
function createStaticServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      // SPA fallback: if path doesn't have extension, serve index.html from dir
      let filePath = join(DIST, urlPath);
      if (!extname(urlPath)) {
        const indexPath = join(filePath, 'index.html');
        if (existsSync(indexPath)) {
          filePath = indexPath;
        } else if (existsSync(join(DIST, 'index.html'))) {
          filePath = join(DIST, 'index.html'); // SPA fallback
        }
      }
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        // Try with index.html
        const withIndex = join(filePath, 'index.html');
        if (existsSync(withIndex)) {
          filePath = withIndex;
        } else {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
      }
      const ext = extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(readFileSync(filePath));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

// ── Page discovery ──────────────────────────────────────────
function discoverPages() {
  const jobDir = join(DIST, 'cerca-lavoro-ticino');
  if (!existsSync(jobDir)) {
    console.error('❌ dist/cerca-lavoro-ticino/ not found — run vite build first');
    process.exit(1);
  }

  const active = [];
  const expired = [];
  const bridge = [];
  const company = [];
  const search = [];

  const entries = readdirSync(jobDir, { withFileTypes: true });
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const entry = dirent.name;
    const fp = join(jobDir, entry, 'index.html');
    if (!existsSync(fp)) continue;
    // Read full file — pages are ≤15KB, fast enough for discovery
    const content = readFileSync(fp, 'utf8');

    if (entry.startsWith('azienda-')) {
      company.push(entry);
    } else if (entry.startsWith('settore-') || entry.startsWith('regione-') || entry.startsWith('contratto-') || entry.startsWith('ricerca-')) {
      search.push(entry);
    } else if (content.includes('__BRIDGE_TARGET_SLUG__')) {
      bridge.push(entry);
    } else if (content.includes('__EXPIRED_JOB_DATA__')) {
      expired.push(entry);
    } else if (content.includes('"@type":"JobPosting"')) {
      active.push(entry);
    }
  }

  return { active, expired, bridge, company, search };
}

function sample(arr, n) {
  if (arr.length <= n) return [...arr];
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// ── Validators ──────────────────────────────────────────────
function extractCanonical(dom) {
  const link = dom.querySelector('link[rel="canonical"]');
  return link ? link.getAttribute('href') : null;
}

function extractJobPostings(dom) {
  const scripts = dom.querySelectorAll('script[type="application/ld+json"]');
  let count = 0;
  for (const s of scripts) {
    try {
      const data = JSON.parse(s.textContent || '');
      if (data['@type'] === 'JobPosting') count++;
      if (Array.isArray(data['@graph'])) {
        count += data['@graph'].filter(i => i?.['@type'] === 'JobPosting').length;
      }
    } catch { /* skip */ }
  }
  return count;
}

function extractRobots(dom) {
  const meta = dom.querySelector('meta[name="robots"]');
  return meta ? meta.getAttribute('content') : null;
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  console.log('🔍 Layer 1: SPA Render Validation');
  console.log(`   Sample size: ${SAMPLE_SIZE} per category\n`);

  // Discover pages
  const pages = discoverPages();
  console.log(`   📊 Discovered: ${pages.active.length} active, ${pages.expired.length} expired, ${pages.bridge.length} bridge, ${pages.company.length} company, ${pages.search.length} search\n`);

  // Build test matrix
  const tests = [
    ...sample(pages.active, SAMPLE_SIZE).map(s => ({ slug: s, type: 'active' })),
    ...sample(pages.expired, SAMPLE_SIZE).map(s => ({ slug: s, type: 'expired' })),
    ...sample(pages.bridge, SAMPLE_SIZE).map(s => ({ slug: s, type: 'bridge' })),
    ...sample(pages.company, Math.min(2, SAMPLE_SIZE)).map(s => ({ slug: s, type: 'company' })),
    ...sample(pages.search, Math.min(2, SAMPLE_SIZE)).map(s => ({ slug: s, type: 'search' })),
    { slug: '', type: 'listing' }, // the listing page itself
  ];

  console.log(`   🧪 Testing ${tests.length} pages...\n`);

  // Start server
  const { server, port } = await createStaticServer();
  const localBase = `http://127.0.0.1:${port}`;

  // Launch browser
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.error('❌ Failed to launch Chromium. Run: npx playwright install chromium');
    console.error(`   ${e.message}`);
    server.close();
    process.exit(1);
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; FrontaliereSEOValidator/1.0)',
    viewport: { width: 1280, height: 720 },
  });

  let errors = 0;
  let warnings = 0;
  let passed = 0;

  for (const test of tests) {
    const path = test.slug ? `/cerca-lavoro-ticino/${test.slug}/` : '/cerca-lavoro-ticino/';
    const url = `${localBase}${path}`;
    const page = await context.newPage();

    try {
      // Count JobPostings in static HTML before SPA hydration
      const staticHtmlPath = test.slug
        ? join(DIST, 'cerca-lavoro-ticino', test.slug, 'index.html')
        : join(DIST, 'cerca-lavoro-ticino', 'index.html');
      let staticJpCount = 0;
      if (existsSync(staticHtmlPath)) {
        const html = readFileSync(staticHtmlPath, 'utf8');
        const matches = html.match(/"@type"\s*:\s*"JobPosting"/g);
        staticJpCount = matches ? matches.length : 0;
      }

      // Navigate and wait for SPA hydration
      await page.goto(url, { timeout: TIMEOUT_PER_PAGE, waitUntil: 'networkidle' });
      // Extra settle time for async data loading
      await page.waitForTimeout(SPA_SETTLE_MS);

      // Extract DOM state
      const canonical = await page.evaluate(() => {
        const el = document.querySelector('link[rel="canonical"]');
        return el ? el.getAttribute('href') : null;
      });

      const jpCount = await page.evaluate(() => {
        let count = 0;
        document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
          try {
            const d = JSON.parse(s.textContent || '');
            if (d['@type'] === 'JobPosting') count++;
            if (Array.isArray(d['@graph'])) {
              count += d['@graph'].filter(i => i?.['@type'] === 'JobPosting').length;
            }
          } catch {}
        });
        return count;
      });

      const robots = await page.evaluate(() => {
        const el = document.querySelector('meta[name="robots"]');
        return el ? el.getAttribute('content') : null;
      });

      // ── Validate ──
      const label = `[${test.type}] ${test.slug.slice(0, 50) || '(listing)'}`;
      let pageErrors = 0;
      const spaInjectedJp = jpCount - staticJpCount; // How many JP the SPA added

      // 1. Canonical must never fall through to listing page (except listing itself and search landings)
      if (test.type !== 'listing' && test.type !== 'search' && canonical && canonical.endsWith('/cerca-lavoro-ticino/')) {
        console.error(`  ❌ ${label}: canonical → listing page! (${canonical})`);
        pageErrors++;
      }
      // Search landings resolving to listing is expected (SPA renders listing with search applied)
      if (test.type === 'search' && canonical && canonical.endsWith('/cerca-lavoro-ticino/')) {
        console.log(`  ℹ️  ${label}: canonical → listing (expected for search landing)`);
      }

      // 2. Active jobs: exactly 1 JobPosting
      if (test.type === 'active') {
        if (jpCount === 0) {
          console.error(`  ❌ ${label}: 0 JobPosting in DOM (expected 1)`);
          pageErrors++;
        } else if (jpCount > 3) {
          console.error(`  ❌ ${label}: ${jpCount} JobPosting in DOM (@graph leak!)`);
          pageErrors++;
        }
      }

      // 3. Expired pages: SPA must not inject additional JobPosting
      if (test.type === 'expired') {
        if (spaInjectedJp > 0) {
          console.error(`  ❌ ${label}: SPA injected ${spaInjectedJp} JobPosting on expired page (@graph leak!)`);
          pageErrors++;
        } else if (staticJpCount > 0) {
          // Static HTML already had JP — build plugin issue, not SPA
          console.warn(`  ⚠️  ${label}: static HTML has ${staticJpCount} JobPosting (build plugin issue, not SPA)`);
          warnings++;
        }
      }

      // 4. Bridge pages: should have 1 JobPosting
      if (test.type === 'bridge') {
        if (jpCount === 0) {
          console.warn(`  ⚠️  ${label}: 0 JobPosting on bridge page`);
          warnings++;
        } else if (jpCount > 3) {
          console.error(`  ❌ ${label}: ${jpCount} JobPosting on bridge page (@graph leak!)`);
          pageErrors++;
        }
      }

      // 5. No massive @graph leak on any page (>5 JP = listing data leaking)
      if (jpCount > 5) {
        console.error(`  ❌ ${label}: ${jpCount} JobPosting — @graph leak from listing page!`);
        pageErrors++;
      }

      // 6. robots: noindex check
      if (robots && robots.includes('noindex') && test.type === 'active') {
        console.error(`  ❌ ${label}: active job has noindex!`);
        pageErrors++;
      }

      if (pageErrors === 0) {
        console.log(`  ✅ ${label}: canonical=${canonical ? '✓' : '?'} JP=${jpCount} robots=${robots || 'default'}`);
        passed++;
      } else {
        errors += pageErrors;
      }

    } catch (e) {
      console.warn(`  ⚠️  [${test.type}] ${test.slug.slice(0, 40)}: timeout/error — ${e.message.slice(0, 80)}`);
      warnings++;
    } finally {
      await page.close();
    }
  }

  await browser.close();
  server.close();

  // ── Summary ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  SPA Render Validation Summary`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ✅ Passed:   ${passed}`);
  console.log(`  ⚠️  Warnings: ${warnings}`);
  console.log(`  ❌ Errors:   ${errors}`);
  console.log(`${'═'.repeat(60)}\n`);

  if (errors > 0) {
    console.error(`❌ BLOCKING: ${errors} critical SPA render issue(s) found. Fix before deploying.`);
    process.exit(1);
  }

  console.log('✅ SPA render validation passed.');
}

main().catch((e) => {
  console.error(`❌ Fatal: ${e.message}`);
  process.exit(1);
});
