#!/usr/bin/env node
/**
 * INP probe on the live site, one interaction per scenario.
 *
 *   node scripts/perf/inp-interaction-probe.mjs [--url https://frontaliereticino.ch] [--runs 3] [--out tmp/inp-probe]
 *
 * Pixel 5 emulation, CPU 4x (the setup of the 2026-10-24 measurements that
 * found 1.8 s on the job-board «Lugano» chip and 1.2 s on the calculator 75k
 * preset). Every run is a cold page: load, wait for the app to settle, accept
 * the consent dialog when shown (that click is a scenario too), then perform
 * the scenario's single tap and read:
 *  - Event Timing entries with an interactionId (duration = INP candidate,
 *    split in input delay / processing / presentation delay);
 *  - Long Animation Frames overlapping the interaction: blocking time and the
 *    forced style+layout spent by scripts (the autoAdOverlay MutationObserver
 *    showed up there before the fix);
 *  - LoAF blocking time during the load window, as a TBT proxy.
 * Third parties are NOT blocked: the field INP includes them.
 *
 * It writes JSON plus a Markdown table (to $GITHUB_STEP_SUMMARY when set).
 * Production is only read; the probe opens no issue and gates nothing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { isValidRun, parseRuns, scenariosWithoutMeasurement, summarizeInteraction } from './lib/inp-probe-summary.mjs';
import { SECTION_LEGACY_TI } from '../../build-plugins/shared/cantonResolvers.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const origin = String(option('--url', 'https://frontaliereticino.ch')).replace(/\/$/, '');
const runs = parseRuns(option('--runs', '3'));
const outDir = option('--out', 'tmp/inp-probe');
const SETTLE_MS = 8000;
const AFTER_TAP_MS = 4000;

const SCENARIOS = [
 {
 id: 'jobboard-chip-lugano',
 path: `/${SECTION_LEGACY_TI.it}/`,
 locate: (page) => page.getByRole('button', { name: 'Lugano', exact: true }).first(),
 },
 {
 id: 'calculator-preset-75k',
 path: '/calcola-stipendio/',
 locate: (page) => page.getByRole('button', { name: /^(75k|Stipendio annuo 75 mila CHF)$/ }).first(),
 },
];

function observeInit() {
 window.__inpProbe = { events: [], loaf: [], loafSupported: false };
 new PerformanceObserver((list) => {
 for (const e of list.getEntries()) {
 if (!e.interactionId) continue;
 window.__inpProbe.events.push({
 interactionId: e.interactionId,
 name: e.name,
 start: e.startTime,
 duration: e.duration,
 inputDelay: e.processingStart - e.startTime,
 processing: e.processingEnd - e.processingStart,
 presentation: e.startTime + e.duration - e.processingEnd,
 });
 }
 }).observe({ type: 'event', durationThreshold: 16, buffered: true });
 try {
 new PerformanceObserver((list) => {
 for (const e of list.getEntries()) {
 window.__inpProbe.loaf.push({
 start: e.startTime,
 duration: e.duration,
 blocking: e.blockingDuration,
 scripts: (e.scripts || []).map((s) => ({
 invoker: String(s.invoker || '').slice(0, 80),
 duration: s.duration,
 forcedLayout: s.forcedStyleAndLayoutDuration || 0,
 source: String(s.sourceURL || '').split('/').pop().slice(0, 60),
 fn: String(s.sourceFunctionName || '').slice(0, 40),
 })),
 });
 }
 }).observe({ type: 'long-animation-frame', buffered: true });
 window.__inpProbe.loafSupported = (PerformanceObserver.supportedEntryTypes || []).includes('long-animation-frame');
 } catch {
 // LoAF is Chromium-only; the Event Timing numbers still stand.
 }
}

async function acceptConsent(page) {
 const button = page.locator('.fc-cta-consent').first();
 try {
 await button.waitFor({ state: 'visible', timeout: 4000 });
 } catch {
 return null;
 }
 const since = await page.evaluate(() => performance.now());
 await button.click({ timeout: 5000 });
 await page.waitForTimeout(2500);
 return summarizeInteraction(await page.evaluate(() => window.__inpProbe), since);
}

async function runScenario(browser, scenario) {
 const context = await browser.newContext({ ...devices['Pixel 5'] });
 await context.addInitScript(observeInit);
 const page = await context.newPage();
 const cdp = await context.newCDPSession(page);
 await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
 try {
 await page.goto(`${origin}${scenario.path}`, { waitUntil: 'load', timeout: 120000 });
 await page.waitForTimeout(SETTLE_MS);
 const loadBlocking = await page.evaluate(() => Math.round(window.__inpProbe.loaf.reduce((s, f) => s + (f.blocking || 0), 0)));
 const consent = await acceptConsent(page);
 const target = scenario.locate(page);
 await target.scrollIntoViewIfNeeded({ timeout: 20000 });
 await page.waitForTimeout(1500);
 const since = await page.evaluate(() => performance.now());
 await target.click({ timeout: 10000 });
 await page.waitForTimeout(AFTER_TAP_MS);
 const tap = summarizeInteraction(await page.evaluate(() => window.__inpProbe), since);
 const ok = Number.isFinite(tap.inp);
 return { scenario: scenario.id, ok, loadBlocking, consent, tap, ...(ok ? {} : { error: 'no Event Timing entry for the tap' }) };
 } catch (error) {
 return { scenario: scenario.id, ok: false, error: String(error?.message || error).slice(0, 300) };
 } finally {
 await context.close();
 }
}

const median = (values) => {
 const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
 if (!xs.length) return null;
 const mid = Math.floor(xs.length / 2);
 return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
};

const browser = await chromium.launch();
const results = [];
try {
 for (const scenario of SCENARIOS) {
 for (let i = 0; i < runs; i += 1) results.push({ run: i + 1, ...(await runScenario(browser, scenario)) });
 }
} finally {
 await browser.close();
}

const rows = [];
for (const scenario of SCENARIOS) {
 const ok = results.filter((r) => r.scenario === scenario.id && isValidRun(r));
 const pick = (fn) => median(ok.map(fn));
 rows.push({
 interaction: scenario.id,
 runs: `${ok.length}/${runs}`,
 inp: pick((r) => r.tap.inp),
 inputDelay: pick((r) => r.tap.inputDelay),
 processing: pick((r) => r.tap.processing),
 presentation: pick((r) => r.tap.presentation),
 loafBlocking: pick((r) => r.tap.loafBlocking),
 forcedLayout: pick((r) => r.tap.forcedLayout),
 loadBlocking: pick((r) => r.loadBlocking),
 });
 const consent = ok.map((r) => r.consent).filter(Boolean);
 if (consent.length) {
 rows.push({
 interaction: `consent-accept (${scenario.path})`,
 runs: `${consent.length}/${runs}`,
 inp: median(consent.map((c) => c.inp)),
 inputDelay: median(consent.map((c) => c.inputDelay)),
 processing: median(consent.map((c) => c.processing)),
 presentation: median(consent.map((c) => c.presentation)),
 loafBlocking: median(consent.map((c) => c.loafBlocking)),
 forcedLayout: median(consent.map((c) => c.forcedLayout)),
 loadBlocking: null,
 });
 }
}

const fmt = (v) => (v === null || v === undefined ? '—' : String(v));
const markdown = [
 `### INP probe — ${origin} (Pixel 5, CPU 4x, median of ${runs})`,
 '',
 '| interaction | runs | INP ms | input delay | processing | presentation | LoAF blocking | forced layout | load LoAF blocking |',
 '|---|---|---|---|---|---|---|---|---|',
 ...rows.map((r) => `| ${r.interaction} | ${r.runs} | ${fmt(r.inp)} | ${fmt(r.inputDelay)} | ${fmt(r.processing)} | ${fmt(r.presentation)} | ${fmt(r.loafBlocking)} | ${fmt(r.forcedLayout)} | ${fmt(r.loadBlocking)} |`),
 '',
 ...results.filter((r) => !r.ok).map((r) => `- ${r.scenario} run ${r.run}: ${r.error}`),
].join('\n');

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, 'inp-probe.json'), JSON.stringify({ origin, runs, measuredAt: new Date().toISOString(), rows, results }, null, 2));
await fs.writeFile(path.join(outDir, 'inp-probe.md'), `${markdown}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
console.log(markdown);
const missing = scenariosWithoutMeasurement(results, SCENARIOS.map((s) => s.id));
if (missing.length) {
 console.error(`no valid INP measurement for: ${missing.join(', ')}`);
 process.exitCode = 1;
}
