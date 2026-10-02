#!/usr/bin/env node
/**
 * Reproducible component lab, not a field-INP measurement or a full site build.
 * node scripts/perf/benchmark-border-municipalities.mjs --ref <base> --out tmp/border-before
 * node scripts/perf/benchmark-border-municipalities.mjs --out tmp/border-after
 * Real React production, Leaflet, municipality data, tax engine and site CSS.
 * Isolates the component: fixed FX, Italian translations and no external network.
 */
import { build } from 'esbuild';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const ref = option('--ref');
const output = path.resolve(root, option('--out') || 'tmp/border-interactions');
const component = 'components/guide/BorderMunicipalitiesMap.tsx';
await mkdir(output, { recursive: true });
const buildDir = path.join(output, 'bundle');
await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import BorderMunicipalitiesMap from './${component}';
      import {MUNICIPALITIES} from './data/municipalities';
      window.labMunicipalityNames=MUNICIPALITIES.map(m=>m.name);
      createRoot(document.getElementById('root')).render(<BorderMunicipalitiesMap/>);`,
    resolveDir: root, loader: 'tsx', sourcefile: 'benchmark-entry.tsx',
  },
  bundle: true, format: 'esm', minify: true, sourcemap: true,
  outdir: buildDir, entryNames: 'entry', alias: { '@': root }, loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'isolated-component-fixtures',
    setup(b) {
      if (ref) b.onLoad({ filter: /BorderMunicipalitiesMap\.tsx$/ }, () => ({
        contents: execFileSync('git', ['show', `${ref}:${component}`], { cwd: root, encoding: 'utf8' }),
        loader: 'tsx', resolveDir: path.join(root, 'components/guide'),
      }));
      b.onResolve({ filter: /services\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
      b.onLoad({ filter: /^i18n$/, namespace: 'fixture' }, () => ({
        contents: `import core from './services/locales/it-core'; import guide from './services/locales/it-guide';
          const texts={...core,...guide};
          const t=(key,params)=>Object.entries(params||{}).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',String(v)),texts[key]||key);
          export const getLocaleTick=()=>0; export const useTranslation=()=>({locale:'it',t});`,
        loader: 'js', resolveDir: root,
      }));
      b.onResolve({ filter: /exchangeRateService$/ }, () => ({ path: 'fx', namespace: 'fixture' }));
      b.onLoad({ filter: /^fx$/, namespace: 'fixture' }, () => ({ contents: 'export const useExchangeRate=()=>({rate:1.05});', loader: 'js' }));
    },
  }],
});
const css = await postcss([tailwind()]).process(await readFile(path.join(root, 'index.css'), 'utf8'), { from: path.join(root, 'index.css') });
await writeFile(path.join(buildDir, 'site.css'), css.css);
await writeFile(path.join(buildDir, 'index.html'), '<!doctype html><html lang="it"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="entry.css"><link rel="stylesheet" href="site.css"><div id="root"></div><script type="module" src="entry.js"></script></html>');
const server = createServer(async (req, res) => {
  const file = (req.url || '/').split('?')[0];
  if (!['/', '/entry.js', '/entry.css', '/site.css'].includes(file)) { res.writeHead(404).end(); return; }
  const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
  res.setHeader('Content-Type', mime);
  res.end(await readFile(path.join(buildDir, file === '/' ? 'index.html' : file.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    window.labEvents = []; window.labTasks = [];
    new PerformanceObserver(list => window.labEvents.push(...list.getEntries().map(e => ({ name: e.name, duration: e.duration, processing: e.processingEnd-e.processingStart, delay: e.processingStart-e.startTime, id: e.interactionId, start: e.startTime })))).observe({ type: 'event', durationThreshold: 16, buffered: true });
    new PerformanceObserver(list => window.labTasks.push(...list.getEntries().map(e => ({ duration: e.duration, start: e.startTime })))).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(origin);
  await page.waitForSelector('h4');
  await page.waitForTimeout(2000);
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler', transferMode: 'ReturnAsStream' });
  const records = [];
  const measure = async (action, operation) => {
    await page.evaluate(() => { window.labEvents = []; window.labTasks = []; window.labStart = performance.now(); });
    await operation();
    await page.waitForTimeout(700);
    records.push({ action, ...await page.evaluate(() => ({
      events: window.labEvents.filter(e => e.start >= window.labStart),
      tasks: window.labTasks.filter(e => e.start >= window.labStart),
      nodes: document.querySelectorAll('*').length, cards: document.querySelectorAll('h4').length,
    })) });
  };
  for (let i = 0; i < 5; i++) {
    for (const name of ['Nome', 'Tassa']) {
      const button = page.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded(); await page.waitForTimeout(150);
      await measure(`sort:${name}:${i}`, () => button.click());
    }
  }
  const settings = page.getByRole('button', { name: /Impatto Fiscale per Comune/ });
  await settings.scrollIntoViewIfNeeded();
  await measure('settings:open', () => settings.click());
  const salary = page.locator('#salary-input-mobile');
  await salary.focus();
  await measure('salary:arrow-up', () => salary.press('ArrowUp'));
  await measure('salary:arrow-down', () => salary.press('ArrowDown'));
  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream } = await complete;
  let trace = '';
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream }); trace += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  await writeFile(path.join(output, 'trace.json'), trace);
  let pagination = null;
  const next = page.getByRole('button', { name: 'Successiva', exact: true });
  if (await next.count()) {
    const names = [];
    let pages = 0;
    for (;;) {
      const visible = await page.locator('#border-municipality-results h4').allTextContents();
      if (visible.length > 24) throw new Error('More than 24 cards mounted');
      names.push(...visible); pages++;
      if (await next.isDisabled()) break;
      await next.click();
    }
    const expected = await page.evaluate(() => window.labMunicipalityNames);
    if (JSON.stringify(names.sort()) !== JSON.stringify(expected.sort())) throw new Error('Pagination lost or duplicated a municipality');
    pagination = { pages, reachableMunicipalities: names.length, complete: true };
  }
  const summary = {
    source: ref || 'working-tree', head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    browser: browser.version(), viewport: '390x844', cpuSlowdown: 4, exchangeRate: 1.05,
    limitations: 'Isolated production component; fixed FX/Italian translations; no external requests/ads/app shell. Event Timing is lab evidence, not field INP. No event below 16ms is reported.',
    errors, records, pagination,
  };
  await writeFile(path.join(output, 'measurements.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(records.map(r => ({ action: r.action, maxEventMs: Math.max(0, ...r.events.map(e => e.duration)), maxLongTaskMs: Math.max(0, ...r.tasks.map(e => e.duration)), nodes: r.nodes, cards: r.cards })), null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
