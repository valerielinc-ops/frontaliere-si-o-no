#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const STATIC_PAGES_PATH = 'build-plugins/staticPagesPlugin.ts';
const ROUTE_MAP_PATH = 'build-plugins/staticPagePreloadMap.ts';
const ROUTE = '/vivere-in-ticino/';
const COST_ROUTE = '/vivere-in-ticino/costo-della-vita/';
const APP_BOOT_MS = 160;
const CHUNK_LATENCY_MS = 200;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const baselineRef = option('--baseline-ref', 'HEAD^');
const runs = Number(option('--runs', '5'));
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('--runs must be a positive integer');
}

function sourceAt(ref, path) {
  if (ref === 'WORKTREE') return readFileSync(resolve(ROOT, path), 'utf8');
  return execFileSync('git', ['show', `${ref}:${path}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function sectionChunk(source, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`['"]${escaped}['"]\\s*:\\s*\\[\\s*['"]([^'"]+)['"]`));
  if (!match) throw new Error(`No chunk mapping found for ${section}`);
  return match[1];
}

function exactRouteChunk(source, route) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`\\[\\s*['"]${escaped}['"]\\s*,\\s*\\[\\s*['"]([^'"]+)['"]`));
  return match?.[1];
}

function mappingsAt(ref) {
  const sectionSource = sourceAt(ref, STATIC_PAGES_PATH);
  let routeSource = '';
  try {
    routeSource = sourceAt(ref, ROUTE_MAP_PATH);
  } catch {
    // The route-specific map did not exist before it was introduced.
  }
  const fallback = sectionChunk(sectionSource, 'vivere-in-ticino');
  return {
    landing: exactRouteChunk(routeSource, ROUTE) ?? fallback,
    cost: exactRouteChunk(routeSource, COST_ROUTE) ?? fallback,
  };
}

const baseline = mappingsAt(baselineRef);
const post = mappingsAt('WORKTREE');

if (baseline.landing !== 'CostOfLiving') {
  throw new Error(`Expected baseline landing to preload CostOfLiving, got ${baseline.landing}`);
}
if (post.landing !== 'FrontierGuide') {
  throw new Error(`Expected post landing to preload FrontierGuide, got ${post.landing}`);
}
if (post.cost !== 'CostOfLiving') {
  throw new Error(`Expected post cost route to preload CostOfLiving, got ${post.cost}`);
}

function html(preloadChunk) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="modulepreload" href="/assets/${preloadChunk}.js">
    <script>
      new PerformanceObserver((list) => {
        globalThis.__lastLcp = list.getEntries().at(-1)?.startTime ?? null;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      setTimeout(async () => {
        await import('/assets/FrontierGuide.js');
        const main = document.createElement('main');
        main.textContent = 'Guida ai comuni di frontiera del Canton Ticino';
        main.style = 'font: 700 48px sans-serif; width: 760px; height: 420px; padding: 40px; background: white';
        document.body.append(main);
      }, ${APP_BOOT_MS});
    </script>
  </head>
  <body style="margin:0;background:#eee"></body>
</html>`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://replay.local');
  if (url.pathname.startsWith('/assets/')) {
    setTimeout(() => {
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'no-store',
      });
      response.end('export default true;');
    }, CHUNK_LATENCY_MS);
    return;
  }
  const preloadChunk = url.searchParams.get('case') === 'pre' ? baseline.landing : post.landing;
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html(preloadChunk));
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const { port } = server.address();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

async function measure(caseName) {
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/?case=${caseName}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => globalThis.__lastLcp !== undefined && document.querySelector('main'));
    samples.push(await page.evaluate(() => {
      const frontier = performance.getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === '/assets/FrontierGuide.js');
      if (!frontier) throw new Error('FrontierGuide resource timing is missing');
      return {
        discoveryMs: Math.round(frontier.startTime),
        lcpMs: Math.round(globalThis.__lastLcp),
      };
    }));
    await context.close();
  }
  return samples;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

try {
  const preSamples = await measure('pre');
  const postSamples = await measure('post');
  const result = {
    baselineRef,
    controls: { runs, appBootMs: APP_BOOT_MS, chunkLatencyMs: CHUNK_LATENCY_MS },
    mappings: { baseline, post },
    pre: {
      discoveryMsMedian: median(preSamples.map((sample) => sample.discoveryMs)),
      lcpMsMedian: median(preSamples.map((sample) => sample.lcpMs)),
      samples: preSamples,
    },
    post: {
      discoveryMsMedian: median(postSamples.map((sample) => sample.discoveryMs)),
      lcpMsMedian: median(postSamples.map((sample) => sample.lcpMs)),
      samples: postSamples,
    },
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
