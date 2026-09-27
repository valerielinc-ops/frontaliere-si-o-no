#!/usr/bin/env node
/**
 * probe-live-consent-message.mjs
 *
 * Post-deploy gate: a NEW visitor must be offered the GDPR consent message.
 *
 * Every ad on the site waits for consent: the TCF bridge writes
 * `frontaliere_ads_consent` only after the Funding Choices CMP, and the ad
 * loaders stay idle until then. The CMP reaches the screen only if the
 * Offerwall gate lets the Funding Choices call that carries it through. On
 * 2026-09-27 it did not (#9974 read the live string MessageTypeEnum as
 * missing and answered proceed(false) everywhere): ad revenue fell 73% for
 * about six hours while sessions stayed normal, and no gate noticed. See
 * scripts/lib/consent-message-probe.mjs for the verdict.
 *
 * One clean browser profile per page, one page per copy of the gate:
 *   /                      inline gate in index.html (SPA shell, apex)
 *   /cerca-lavoro-ticino/  gate inlined in the job-board section shell
 *   /cerca-lavoro-zurigo/  gate carried by the CDN gpt-loader/adsense-loader
 *
 * The probe never clicks the consent button, so no ad is requested from CI,
 * and it aborts analytics beacons so its visits stay out of GA4 and Clarity.
 * It presents a regular Chrome user agent and hides navigator.webdriver:
 * the ad loaders skip automation (services/botPatterns.ts), which would
 * otherwise read as "Funding Choices never loaded".
 *
 * Usage:
 *   node scripts/probe-live-consent-message.mjs            # exit 1 on a fail
 *   node scripts/probe-live-consent-message.mjs --json     # JSON report on stdout
 *   node scripts/probe-live-consent-message.mjs --paths=/,/cerca-lavoro-ticino/
 *
 * Env:
 *   LIVE_BASE_URL           default https://frontaliereticino.ch
 *   PLAYWRIGHT_BROWSERS_PATH  as installed by the calling workflow
 *   CHROMIUM_EXECUTABLE_PATH  optional, local runs whose Playwright cache lacks
 *                             the pinned headless revision
 */

import { pathToFileURL } from 'node:url';

import { writeAuditReport } from './lib/auditReport.mjs';
import {
  CMF_RECORDER_INIT_JS,
  FC_PREVIEW_QUERY,
  bestVerdict,
  classifyConsentProbe,
} from './lib/consent-message-probe.mjs';

const DEFAULT_PATHS = ['/', '/cerca-lavoro-ticino/', '/cerca-lavoro-zurigo/'];
const WAIT_MS = 30_000;
const ATTEMPTS = 2;

// Analytics and ad-serving hosts. Funding Choices (fundingchoicesmessages.google.com)
// and the site's own scripts stay reachable.
const BLOCKED_REQUEST_RX =
  /(?:google-analytics\.com|analytics\.google\.com|\/g\/collect|clarity\.ms|cloudflareinsights\.com|performancehorizon\.com|posthog|pagead2\.googlesyndication\.com|tpc\.googlesyndication\.com|googleads\.g\.doubleclick\.net|securepubads\.g\.doubleclick\.net)/;
const FC_REQUEST_RX = /fundingchoicesmessages\.google\.com/;
const CONSENT_DIALOG_SELECTOR = '.fc-consent-root, .fc-dialog-container';

function parseArgs(argv) {
  const pathsArg = argv.find((a) => a.startsWith('--paths='))?.slice('--paths='.length);
  return {
    json: argv.includes('--json'),
    paths: pathsArg ? pathsArg.split(',').map((p) => p.trim()).filter(Boolean) : DEFAULT_PATHS,
  };
}

export function probeUrl(baseUrl, path, stamp = Date.now()) {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, '')}/`);
  // The unique stamp keeps the edge from answering with a copy cached before this deploy.
  url.search = `${FC_PREVIEW_QUERY}&_ftprobe=${stamp}`;
  return url.toString();
}

async function probeOnce(browser, userAgent, url) {
  const context = await browser.newContext({
    locale: 'it-CH',
    timezoneId: 'Europe/Zurich',
    userAgent,
    viewport: { width: 1280, height: 900 },
  });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
    });
    await context.addInitScript(CMF_RECORDER_INIT_JS);
    await context.route(BLOCKED_REQUEST_RX, (route) => route.abort());
    const page = await context.newPage();
    let fcRequested = false;
    page.on('request', (request) => {
      if (FC_REQUEST_RX.test(request.url())) fcRequested = true;
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Some loaders arm on the first interaction; a real visitor moves the mouse.
    await page.mouse.move(320, 420).catch(() => {});
    const deadline = Date.now() + WAIT_MS;
    let dialogVisible = false;
    while (Date.now() < deadline) {
      dialogVisible = await page
        .locator(CONSENT_DIALOG_SELECTOR)
        .first()
        .isVisible()
        .catch(() => false);
      if (dialogVisible) break;
      await page.waitForTimeout(500);
    }
    const calls = await page.evaluate(() => (window.__ftConsentProbe && window.__ftConsentProbe.calls) || []).catch(() => []);
    return { ...classifyConsentProbe({ calls, fcRequested, dialogVisible }), calls, fcRequested, dialogVisible };
  } finally {
    await context.close();
  }
}

async function main() {
  const { json, paths } = parseArgs(process.argv.slice(2));
  const baseUrl = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');
  const { chromium } = await import('playwright');
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  // Headless Chromium announces itself as HeadlessChrome, which the ad loaders skip.
  const major = browser.version().split('.')[0];
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

  const results = [];
  try {
    for (const path of paths) {
      const attempts = [];
      for (let i = 0; i < ATTEMPTS; i++) {
        const url = probeUrl(baseUrl, path);
        try {
          attempts.push({ url, ...(await probeOnce(browser, userAgent, url)) });
        } catch (error) {
          attempts.push({ url, verdict: 'inconclusive', reason: 'navigation_error', detail: String(error?.message || error).slice(0, 300), calls: [], fcRequested: false, dialogVisible: false });
        }
        if (attempts[attempts.length - 1].verdict === 'pass') break;
      }
      results.push({ path, ...bestVerdict(attempts), attempts: attempts.length });
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => r.verdict === 'fail');
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const decisions = r.calls
        .map((c) => `enum=${c.enumKeys ? c.offerwallType : 'empty'}→${c.decision ? `proceed(${c.decision.allow}${c.decision.types ? `,[${c.decision.types.join(',')}]` : ''})` : 'unanswered'}`)
        .join(' ');
      console.log(`[consent-probe] ${r.verdict.toUpperCase().padEnd(12)} ${r.path}  ${r.reason}  fc=${r.fcRequested} dialog=${r.dialogVisible} attempts=${r.attempts}  ${decisions}`);
      if (r.verdict === 'fail') console.log(`::error::[consent-probe] ${r.path}: ${r.detail}`);
      if (r.verdict === 'inconclusive') console.log(`::warning::[consent-probe] ${r.path}: ${r.detail}`);
    }
  }

  await writeAuditReport({
    audit: 'consent-message-live',
    passed: failed.length === 0,
    offenders: failed.map((r) => ({ path: r.path, feature: r.reason, metric: r.verdict })),
    extra: { results: results.map(({ path, verdict, reason, fcRequested, dialogVisible, calls }) => ({ path, verdict, reason, fcRequested, dialogVisible, calls })) },
  });

  if (failed.length > 0) process.exit(1);
  if (!json) console.log(`✅ [consent-probe] no page suppresses the consent message (${results.length} page(s) probed)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`::error::[consent-probe] probe crashed: ${error?.stack || error}`);
    process.exit(1);
  });
}
