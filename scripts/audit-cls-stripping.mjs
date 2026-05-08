#!/usr/bin/env node
/**
 * audit-cls-stripping.mjs (P0.1.E)
 *
 * Validates that the `min-height` reservations our React component sets on
 * the `<ins class="adsbygoogle">` wrapper survive after Google's adsbygoogle.js
 * has run. Per third-party reports, AdSense's loader will strip class-targeted
 * min-height from ad parents — only inline `style="min-height: ..."` and
 * ID-targeted CSS are preserved.
 *
 * What it does:
 *   1. Launches Chromium via Playwright on a list of live URLs (default:
 *      `/` and `/cerca-lavoro-ticino/`).
 *   2. Waits 8s for ads to load (adsbygoogle.js + first push + fill).
 *   3. For every `ins.adsbygoogle` and every `.google-auto-placed` div on the
 *      page, captures: tag, slot id, data-ad-status, computed min-height,
 *      computed height, the explicit `style="min-height: ..."` attribute.
 *   4. Reports any element where the rendered min-height is 0 or "auto" but
 *      our component intends a reservation. That's the smoking gun for
 *      stripping.
 *
 * Usage:
 *   node scripts/audit-cls-stripping.mjs                   # mobile + desktop, default URLs
 *   node scripts/audit-cls-stripping.mjs --url=/foo --url=/bar
 *   node scripts/audit-cls-stripping.mjs --json
 *
 * Auth: none — fetches public production URLs.
 *
 * Dependencies: `playwright` is already a project dep (used by e2e tests).
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const urlArgs = args.filter((a) => a.startsWith('--url=')).map((a) => a.slice('--url='.length));
const urls = urlArgs.length ? urlArgs : ['/', '/cerca-lavoro-ticino/'];
const BASE = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');
const FILL_WAIT_MS = 8000;

async function probeOne(page, url, viewport, label) {
  await page.setViewportSize(viewport);
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(FILL_WAIT_MS);
  return await page.evaluate(() => {
    const out = { ins: [], autoPlaced: [], userAgent: navigator.userAgent };
    const inses = document.querySelectorAll('ins.adsbygoogle');
    inses.forEach((el) => {
      const cs = getComputedStyle(el);
      const parent = el.parentElement;
      const parentStyle = parent ? getComputedStyle(parent) : null;
      out.ins.push({
        slot: el.getAttribute('data-ad-slot'),
        format: el.getAttribute('data-ad-format'),
        adStatus: el.getAttribute('data-ad-status'),
        adsbygoogleStatus: el.getAttribute('data-adsbygoogle-status'),
        inlineStyle: el.getAttribute('style') || '',
        parentInlineStyle: parent?.getAttribute('style') || '',
        computedMinHeight: cs.minHeight,
        computedHeight: cs.height,
        parentComputedMinHeight: parentStyle?.minHeight || null,
        parentComputedHeight: parentStyle?.height || null,
        parentClass: parent?.className || '',
      });
    });
    const placed = document.querySelectorAll('.google-auto-placed');
    placed.forEach((el) => {
      const cs = getComputedStyle(el);
      out.autoPlaced.push({
        class: el.className,
        computedMinHeight: cs.minHeight,
        computedHeight: cs.height,
        computedAspectRatio: cs.aspectRatio,
        computedContain: cs.contain,
        inlineStyle: el.getAttribute('style') || '',
        offsetHeight: el.offsetHeight,
      });
    });
    return out;
  });
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  // Use a real desktop UA so AdSense doesn't bot-skip us — same UA we're
  // trying to validate the experience for.
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

const results = [];
for (const url of urls) {
  for (const [label, vp] of [
    ['mobile', { width: 390, height: 844 }],
    ['desktop', { width: 1440, height: 900 }],
  ]) {
    try {
      const data = await probeOne(page, url, vp, label);
      results.push({ url, viewport: label, ...data });
      if (!JSON_OUT) {
        console.log(`\n${label.padEnd(7)} ${url}`);
        console.log(`  ins.adsbygoogle: ${data.ins.length}  ·  google-auto-placed: ${data.autoPlaced.length}`);
        for (const i of data.ins) {
          const stripped = (i.parentComputedMinHeight === '0px' || i.parentComputedMinHeight === 'auto') && /min-height/.test(i.parentInlineStyle);
          console.log(`    slot=${i.slot} fmt=${i.format} status=${i.adStatus || 'pending'}  parent.minHeight=${i.parentComputedMinHeight} ${stripped ? '🔴 STRIPPED' : ''}`);
        }
        for (const ap of data.autoPlaced) {
          console.log(`    auto-placed offsetH=${ap.offsetHeight}px  contain=${ap.computedContain}  ar=${ap.computedAspectRatio}`);
        }
      }
    } catch (e) {
      results.push({ url, viewport: label, error: e.message });
      if (!JSON_OUT) console.error(`❌ ${label} ${url}: ${e.message}`);
    }
  }
}

await browser.close();

if (JSON_OUT) {
  console.log(JSON.stringify({ baseUrl: BASE, urls, results, generatedAt: new Date().toISOString() }, null, 2));
}
