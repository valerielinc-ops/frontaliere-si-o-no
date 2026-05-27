#!/usr/bin/env node
/**
 * Visual audit — uses Playwright to check rendered layout:
 *   - <footer> position (must appear at END of viewport/DOM, not floated)
 *   - <nav class="seo-hub-subnav"> coherent structure
 *   - Webcam <img> actually loads (naturalWidth > 0) on border-wait-detail pages
 *   - Console errors count
 *   - H1 visible post-hydration (not wiped by SPA)
 *
 * Samples 25 representative URLs covering all SEO page types.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT_DIR = '.orchestration/audit';
mkdirSync(OUT_DIR, { recursive: true });

const BASE = 'https://frontaliereticino.ch';
const URLS = [
  // Oggi landings
  { url: `${BASE}/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/`, type: 'oggi-ticino' },
  { url: `${BASE}/cerca-lavoro-ticino/offerte-di-lavoro-grigioni-oggi/`, type: 'oggi-grigioni' },
  // Recency
  { url: `${BASE}/cerca-lavoro-ticino/da-ieri/`, type: 'recency-da-ieri' },
  { url: `${BASE}/cerca-lavoro-ticino/ultimi-3-giorni/`, type: 'recency-3gg' },
  // Border wait
  { url: `${BASE}/traffico-dogane/chiasso-brogeda/oggi/`, type: 'border-brogeda', webcam: true },
  { url: `${BASE}/traffico-dogane/ponte-tresa/oggi/`, type: 'border-ponte-tresa', webcam: true },
  { url: `${BASE}/traffico-dogane/gaggiolo/oggi/`, type: 'border-gaggiolo', webcam: true },
  { url: `${BASE}/traffico-dogane/`, type: 'border-hub' },
  { url: `${BASE}/guida-frontaliere/mappa-live-valichi/`, type: 'border-map' },
  // Fuel
  { url: `${BASE}/prezzi-diesel/oggi/`, type: 'fuel-hub' },
  { url: `${BASE}/prezzi-diesel/lugano/oggi/`, type: 'fuel-zone-lugano' },
  { url: `${BASE}/prezzi-diesel/bellinzona/oggi/`, type: 'fuel-zone-bellinzona' },
  { url: `${BASE}/prezzi-diesel/chiasso/stazioni/piccadilly-via-s-gottardo/`, type: 'fuel-station' },
  { url: `${BASE}/prezzi-diesel/italia/como/oggi/`, type: 'fuel-italian-city' },
  // Weekly employers
  { url: `${BASE}/aziende-che-assumono/ticino/settimana-corrente/`, type: 'weekly-ticino' },
  { url: `${BASE}/aziende-che-assumono/lugano/settimana-corrente/`, type: 'weekly-lugano' },
  { url: `${BASE}/aziende-che-assumono/bellinzona/eoc-ente-ospedaliero-cantonale/settimana-corrente/`, type: 'weekly-per-company' },
  // Job market
  { url: `${BASE}/mercato-lavoro-ticino/`, type: 'job-market-hub' },
  { url: `${BASE}/mercato-lavoro-ticino/settimana-16-2026/`, type: 'job-market-week' },
  // Annual / market report
  { url: `${BASE}/report/frontalieri-2026/`, type: 'annual-report' },
  { url: `${BASE}/reports/mercato-lavoro-frontalieri-ticino-2026/`, type: 'market-report' },
  // Landings
  { url: `${BASE}/agenzie-del-lavoro-lugano/`, type: 'career-landing' },
  { url: `${BASE}/costo-vita-lugano-ticino/`, type: 'cost-of-living' },
  { url: `${BASE}/lavoro-infermieri-svizzera/`, type: 'nursing' },
  { url: `${BASE}/ricerca/offerte-di-lavoro-svizzera/`, type: 'orphan' },
  { url: `${BASE}/lavoro-ticino-infermiere/`, type: 'profession' },
  { url: `${BASE}/cerca-lavoro-ticino/infermieri/`, type: 'sector' },
  // Other
  { url: `${BASE}/confronti-frontalieri/`, type: 'comparisons' },
  { url: `${BASE}/premi-cassa-malati/`, type: 'health-premiums' },
  { url: `${BASE}/guida-frontaliere/tempi-attesa-dogana/`, type: 'guide-border-wait' },
  { url: `${BASE}/statistiche/prezzi-benzina-confine/`, type: 'stats-fuel' },
];

async function checkUrl(browser, entry) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  const issues = [];
  const result = { url: entry.url, type: entry.type };
  try {
    const resp = await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    result.status = resp?.status() ?? 0;
    await page.waitForTimeout(3500); // SPA hydration

    const metrics = await page.evaluate(() => {
      const footer = document.querySelector('footer');
      const footerRect = footer ? footer.getBoundingClientRect() : null;
      const root = document.querySelector('#root');
      const rootRect = root ? root.getBoundingClientRect() : null;
      const main = document.querySelector('main.seo-static-content') || document.querySelector('main');
      const mainRect = main ? main.getBoundingClientRect() : null;
      const h1 = document.querySelector('h1');
      const subnav = document.querySelector('.seo-hub-subnav, nav[data-hub]');
      const webcamImgs = Array.from(document.querySelectorAll('figure img[referrerpolicy], img[data-webcam-base-url], img[alt*="webcam" i]'))
        .map(img => ({ src: img.src.slice(0, 120), nw: img.naturalWidth, nh: img.naturalHeight, complete: img.complete }));
      return {
        hasFooter: !!footer,
        footerRect: footerRect ? { top: footerRect.top, bottom: footerRect.bottom, left: footerRect.left, right: footerRect.right, width: footerRect.width, height: footerRect.height, pos: getComputedStyle(footer).position, float: getComputedStyle(footer).float } : null,
        rootBottom: rootRect?.bottom,
        mainBottom: mainRect?.bottom,
        mainClass: main?.className,
        h1Text: h1?.textContent?.slice(0, 120),
        h1Visible: h1 ? h1.getBoundingClientRect().height > 0 : false,
        hasSubnav: !!subnav,
        subnavClass: subnav?.className?.slice(0, 120),
        webcamImgs,
        bodyWidth: document.body.getBoundingClientRect().width,
      };
    });
    result.metrics = metrics;

    // Checks
    if (!metrics.hasFooter) issues.push({ code: 'NO_FOOTER', severity: 'high' });
    else {
      if (metrics.footerRect?.float && metrics.footerRect.float !== 'none') {
        issues.push({ code: 'FOOTER_FLOATED', severity: 'high', detail: `float=${metrics.footerRect.float}` });
      }
      if (metrics.footerRect?.right < metrics.bodyWidth * 0.5) {
        issues.push({ code: 'FOOTER_NOT_FULL_WIDTH', severity: 'high', detail: `right=${metrics.footerRect.right} body=${metrics.bodyWidth}` });
      }
      // Footer bottom > main bottom means footer IS below main (correct)
      if (metrics.mainBottom && metrics.footerRect && metrics.footerRect.top < metrics.mainBottom - 50) {
        issues.push({ code: 'FOOTER_ABOVE_MAIN', severity: 'high', detail: `footer.top=${metrics.footerRect.top} main.bottom=${metrics.mainBottom}` });
      }
    }
    if (!metrics.h1Visible) issues.push({ code: 'H1_NOT_VISIBLE', severity: 'high' });
    if (entry.webcam) {
      const webcamsOk = metrics.webcamImgs.filter(w => w.nw > 0 && w.complete);
      if (metrics.webcamImgs.length === 0) issues.push({ code: 'WEBCAM_MISSING', severity: 'high' });
      else if (webcamsOk.length === 0) issues.push({ code: 'WEBCAM_NOT_LOADED', severity: 'high', detail: JSON.stringify(metrics.webcamImgs[0]) });
    }
    if (consoleErrors.length > 10) issues.push({ code: 'MANY_CONSOLE_ERRORS', severity: 'medium', detail: `count=${consoleErrors.length}` });
    result.consoleErrorsCount = consoleErrors.length;
    result.consoleErrorsSample = consoleErrors.slice(0, 3);
  } catch (e) {
    issues.push({ code: 'NAVIGATION_ERROR', severity: 'high', detail: String(e).slice(0, 200) });
  }
  result.issues = issues;
  await ctx.close();
  return result;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const entry of URLS) {
    console.log(`[${entry.type}] ${entry.url}`);
    const r = await checkUrl(browser, entry);
    const highIssues = r.issues.filter(i => i.severity === 'high').length;
    console.log(`  → ${highIssues} high issues, ${r.consoleErrorsCount ?? 0} console errors`);
    results.push(r);
  }
  await browser.close();

  writeFileSync(`${OUT_DIR}/visual.json`, JSON.stringify(results, null, 2));

  const md = [];
  md.push(`# Visual audit — ${new Date().toISOString()}\n`);
  const allIssues = results.flatMap(r => r.issues.map(i => ({ ...i, url: r.url, type: r.type })));
  const high = allIssues.filter(i => i.severity === 'high');
  md.push(`Total URLs: ${results.length}`);
  md.push(`High-severity issues: **${high.length}**\n`);
  md.push('## Issues by code\n');
  const byCode = {};
  for (const i of allIssues) (byCode[i.code] ||= []).push(i);
  for (const [code, list] of Object.entries(byCode).sort((a, b) => b[1].length - a[1].length)) {
    md.push(`\n### ${code} (${list.length})\n`);
    for (const i of list) {
      md.push(`- [${i.type}] ${i.url}${i.detail ? ` — ${i.detail}` : ''}`);
    }
  }
  md.push('\n## Per-URL details\n');
  for (const r of results) {
    const status = r.issues.some(i => i.severity === 'high') ? '❌' : '✅';
    md.push(`- ${status} **${r.type}** ${r.url} — ${r.issues.length} issues, ${r.consoleErrorsCount ?? 0} console errors`);
  }
  writeFileSync(`${OUT_DIR}/visual-summary.md`, md.join('\n') + '\n');

  console.log(`\nDone. ${high.length} high-severity issues. See ${OUT_DIR}/visual-summary.md`);
}

run().catch(e => { console.error(e); process.exit(1); });
