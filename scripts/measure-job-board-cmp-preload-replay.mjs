#!/usr/bin/env node
// Replay of the CMP preload on /cerca-lavoro-ticino/ (#16739).
// Baseline is the live page; the variant is the same response with exactly the
// tag this checkout's jobBoardGpt.ts emits inserted in <head>. That tag is the
// only output change of the PR, so the delta is attributable to it.
// Runs alternate baseline/variant to share network and CMP conditions.
//
//   npx -y tsx@4 scripts/measure-job-board-cmp-preload-replay.mjs --runs 5
//   PLAYWRIGHT_CHANNEL=chrome ... (system Chrome where bundled Chromium is unsupported)

import { launchChromium } from './lib/ensure-chromium.mjs';
import { JOB_BOARD_FC_PRELOAD_TAG } from '../build-plugins/jobBoardGpt.ts';

const URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/';
const WAIT_MS = 15000;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const runs = Number(option('--runs', '5'));
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function sample(browser, withPreload) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 150, downloadThroughput: 204800, uploadThroughput: 96000, connectionType: 'cellular4g',
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (withPreload) {
    await page.route(URL, async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      if (!/<head[^>]*>/i.test(html)) throw new Error('live page has no <head>');
      await route.fulfill({ response, body: html.replace(/<head[^>]*>/i, (head) => `${head}\n ${JOB_BOARD_FC_PRELOAD_TAG}`) });
    });
  }
  await page.addInitScript(() => {
    window.__lcp = null;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__lcp = { startTime: entry.startTime, tag: entry.element?.tagName ?? null };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(WAIT_MS);
  const lcp = await page.evaluate(() => window.__lcp);
  await context.close();
  return lcp;
}

const browser = await launchChromium({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const baseline = [];
const variant = [];
try {
  for (let run = 0; run < runs; run += 1) {
    baseline.push(await sample(browser, false));
    variant.push(await sample(browser, true));
  }
} finally {
  await browser.close();
}

const baselineMs = median(baseline.map((entry) => entry?.startTime));
const variantMs = median(variant.map((entry) => entry?.startTime));
console.log(JSON.stringify({
  url: URL,
  controls: { runs, viewport: '390x844', cpuThrottling: 4, network: 'Slow 4G (150 ms, 1.6 Mbps)' },
  tag: JOB_BOARD_FC_PRELOAD_TAG,
  baselineLcpMs: baseline.map((entry) => entry?.startTime ?? null),
  variantLcpMs: variant.map((entry) => entry?.startTime ?? null),
  baselineMedianMs: baselineMs,
  variantMedianMs: variantMs,
  deltaMedianMs: baselineMs != null && variantMs != null ? variantMs - baselineMs : null,
}, null, 2));
