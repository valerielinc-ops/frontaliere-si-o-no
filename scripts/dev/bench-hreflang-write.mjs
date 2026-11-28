#!/usr/bin/env node
/**
 * bench-hreflang-write — byte identity and timing of the final hreflang pass,
 * this checkout against a baseline git ref, on the same generated dist.
 *
 *   node scripts/dev/bench-hreflang-write.mjs [--ref origin/main]
 *     [--pages 20000] [--reps 3] [--write-workers 8] [--flow it|full]
 *     [--identity-only]
 *
 * `--flow it` (default) is the deploy.yml IT leg: dry pre-pass with its page
 * cache, then the final pass that reuses it, with three foreign manifests.
 * `--flow full` is one pass owning all four locales.
 *
 * The baseline is `scripts/ci/hreflang-index-manifest.mjs` at `--ref`, with
 * its relative imports, extracted into a temporary directory. Both run as
 * child processes on freshly generated, identical dists. Identity covers every
 * file of dist (path, mode, sha256), the manifests without `generatedAt` and
 * the summary counters. Exit code 1 on any difference.
 *
 * Timings are those of THIS machine and filesystem. They compare the two
 * implementations; they do not predict the seconds saved on a CI runner.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serializeHreflangManifest, classifyHreflangPage } from '../lib/hreflang-index-manifest.mjs';
import { distFileToUrlPath } from '../lib/externally-served-paths.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = 'scripts/ci/hreflang-index-manifest.mjs';
const BASE = 'https://frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];

const args = { ref: 'origin/main', pages: 20000, reps: 3, writeWorkers: null, flow: 'it', identityOnly: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--ref') args.ref = process.argv[++i];
  else if (a === '--pages') args.pages = Number(process.argv[++i]);
  else if (a === '--reps') args.reps = Number(process.argv[++i]);
  else if (a === '--write-workers') args.writeWorkers = process.argv[++i];
  else if (a === '--flow') args.flow = process.argv[++i];
  else if (a === '--identity-only') args.identityOnly = true;
  else throw new Error(`unknown option ${a}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-hreflang-'));

/** Extract the entry at `ref` and everything it imports by relative path. */
function extractBaseline(ref) {
  const root = path.join(work, 'baseline');
  const queue = [ENTRY];
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = execFileSync('git', ['-C', REPO, 'show', `${ref}:${file}`], { encoding: 'utf-8', maxBuffer: 1 << 26 });
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
    for (const m of source.matchAll(/^(?:import|export)\b[^;]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      queue.push(path.posix.join(path.posix.dirname(file), m[1]));
    }
  }
  return path.join(root, ENTRY);
}

const prefixOf = (locale) => (locale === 'it' ? '' : `${locale}/`);
const urlOf = (locale, slug) => `/${prefixOf(locale)}${slug}/`;

function html(urlPath, cluster, { robots = 'index,follow', canonical = urlPath, xDefault = 'it', variant = 0, bodyBytes }) {
  const tags = [];
  if (cluster) {
    for (const [code, target] of Object.entries(cluster)) {
      tags.push(variant % 7 === 3
        ? `<link rel=alternate hreflang=${code} href=${BASE}${target}>`
        : `<link rel="alternate" hreflang="${code}" href="${BASE}${target}">`);
    }
    if (xDefault && cluster[xDefault]) tags.push(`<link rel="alternate" hreflang="x-default" href="${BASE}${cluster[xDefault]}">`);
  }
  const nl = variant % 11 === 5 ? '\r\n' : variant % 13 === 6 ? '' : '\n';
  // One head larger than the 64 KB read window in every 997 pages.
  const hugeHead = variant % 997 === 41 ? `<style>${'.h{x:1}'.repeat(11000)}</style>` : '';
  const filler = 'perché città Zürich — frontaliere 漢 '.repeat(Math.ceil(bodyBytes / 40));
  return [
    '<!doctype html><html lang="it"><head><meta charset="utf-8"><title>t</title>',
    `<meta name="robots" content="${robots}">`,
    `<link rel="canonical" href="${BASE}${canonical}">`,
    '<script>const s = \'<link rel="alternate" hreflang="zz" href="/no/">\';</script>',
    '<!-- <link rel="alternate" hreflang="zz" href="/no/"> -->',
    hugeHead,
    ...tags,
    `</head><body><p>${filler}</p><a hreflang="de" href="/de/x/">de</a></body></html>`,
  ].filter(Boolean).join(nl);
}

/**
 * Deterministic four-locale dist. The mix follows run 46130986291 (about 80%
 * of the pages rewritten, almost all noindex strips, ~14 KB each), plus a few
 * pages for every other decision and for the awkward bytes.
 */
function generate(distDir, pages) {
  const clusters = Math.max(30, Math.ceil(pages / 4));
  const made = new Set();
  const put = (relative, content, mode) => {
    const file = path.join(distDir, relative);
    const dir = path.dirname(file);
    if (!made.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    fs.writeFileSync(file, content);
    if (mode !== undefined) fs.chmodSync(file, mode);
  };
  for (let i = 0; i < clusters; i++) {
    const slug = `s${i % 40}/page-${i}`;
    const cluster = Object.fromEntries(LOCALES.map((l) => [l, urlOf(l, i % 53 === 7 ? `${slug}-città` : slug)]));
    const kind = i % 100;
    for (const [n, locale] of LOCALES.entries()) {
      const variant = i * 4 + n;
      const options = { variant, bodyBytes: 8000 + ((variant * 7919) % 12000) };
      let block = cluster;
      if (kind < 76) options.robots = 'noindex,follow';
      else if (kind === 76) options.canonical = urlOf(locale, 'elsewhere');
      else if (kind === 77 && locale === 'de') options.robots = 'noindex';
      else if (kind === 78) block = { it: cluster.it, en: cluster.en };
      else if (kind === 79 && locale === 'fr') block = { ...cluster, de: urlOf('de', 'missing') };
      else if (kind === 80) options.xDefault = null;
      else if (kind === 81) options.xDefault = 'en';
      else if (kind === 82) block = { ...cluster, IT: urlOf('it', 'duplicate') };
      else if (kind === 83) block = { ...cluster, [locale]: urlOf(locale, 'not-me') };
      // A member on a foreign host: no manifest can judge it.
      else if (kind === 84 && locale !== 'de') block = { ...cluster, de: '.example.com/de/foreign/' };
      else if (kind >= 95) block = null;
      let content = html(cluster[locale], block, options);
      // Bytes that are not valid UTF-8, in the body of a page being stripped.
      if (variant % 1009 === 4) content = Buffer.concat([Buffer.from(content), Buffer.from([0xff, 0xfe, 0xc3])]);
      put(`${cluster[locale].slice(1)}index.html`, content, variant % 499 === 8 ? 0o600 : undefined);
    }
  }
  put('twin.html', html('/twin', null, { canonical: '/twin-flat/', bodyBytes: 500 }));
  put('twin/index.html', html('/twin/', null, { bodyBytes: 500 }));
  put('assets/ignored.html', html('/assets/ignored/', null, { robots: 'noindex', bodyBytes: 500 }));
}

function listHtml(distDir, out = [], dir = distDir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listHtml(distDir, out, p);
    else out.push(p);
  }
  return out;
}

function hashDist(distDir) {
  const all = createHash('sha256');
  const files = listHtml(distDir).sort();
  for (const file of files) {
    const body = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    all.update(`${path.relative(distDir, file)}\0${fs.statSync(file).mode & 0o777}\0${body}\n`);
  }
  return { files: files.length, sha256: all.digest('hex') };
}

/** Foreign manifests as the other legs would publish them. */
function writeForeignManifests(distDir, manifestDir) {
  const entries = Object.fromEntries(LOCALES.slice(1).map((l) => [l, new Map()]));
  for (const file of listHtml(distDir)) {
    const urlPath = distFileToUrlPath(file, distDir);
    const locale = urlPath === null ? null : /^\/(en|de|fr)(?:\/|$)/.exec(urlPath)?.[1];
    if (!locale) continue;
    const page = classifyHreflangPage(fs.readFileSync(file, 'utf-8'), urlPath, { baseUrl: BASE });
    if (page.eligible) entries[locale].set(urlPath, page.clusterKey);
  }
  fs.mkdirSync(manifestDir, { recursive: true });
  for (const [locale, map] of Object.entries(entries)) {
    fs.writeFileSync(path.join(manifestDir, `${locale}.json`), serializeHreflangManifest({ locale, entries: map, runId: 'bench' }));
  }
}

function runCli(script, distDir, manifestDir, extra) {
  const child = spawnSync(process.execPath, [script, distDir, '--manifest-dir', manifestDir, ...extra], {
    encoding: 'utf-8',
    maxBuffer: 1 << 26,
    env: { ...process.env, GITHUB_RUN_ID: 'bench', BUILD_LOCALE: args.flow === 'it' ? 'it' : '' },
  });
  if (child.status !== 0) throw new Error(`${script} exited ${child.status}\n${child.stdout}\n${child.stderr}`);
  const line = child.stdout.split('\n').find((l) => l.startsWith('[hreflang-index-manifest] {'));
  return JSON.parse(line.slice(line.indexOf('{')));
}

let generation = 0;
function measure(label, script, { hash }) {
  const dir = path.join(work, `run-${generation++}`);
  const distDir = path.join(dir, 'dist');
  const manifestDir = path.join(dir, 'manifests');
  generate(distDir, args.pages);
  const finalArgs = [];
  if (args.flow === 'it') {
    writeForeignManifests(distDir, manifestDir);
    const cache = path.join(manifestDir, 'it.pages.jsonl');
    runCli(script, distDir, manifestDir, ['--dry-run', '--manifest-only', '--prepass-cache', cache]);
    finalArgs.push('--require-foreign-manifests', '--reuse-prepass-cache', cache);
  }
  // Flush the generated dist so its writeback is not billed to the pass.
  spawnSync('sync');
  if (label === 'candidate' && args.writeWorkers !== null) finalArgs.push('--write-workers', args.writeWorkers);
  const summary = runCli(script, distDir, manifestDir, finalArgs);
  let identity = null;
  if (hash) {
    const manifests = LOCALES.map((l) => fs.readFileSync(path.join(manifestDir, `${l}.json`), 'utf-8').replace(/"generatedAt":"[^"]*",/, ''));
    const counters = ['pagesScanned', 'pagesByReason', 'pagesWithHreflang', 'pagesDeferred', 'blocksByDecision', 'unknownMembers', 'manifestCounts', 'filesToRewrite', 'filesRewritten'];
    identity = {
      dist: hashDist(distDir),
      manifestsSha256: createHash('sha256').update(manifests.join('\n')).digest('hex'),
      counters: JSON.stringify(Object.fromEntries(counters.map((k) => [k, summary[k]]))),
    };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { summary, identity };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

try {
  const baseline = extractBaseline(args.ref);
  const candidate = path.join(REPO, ENTRY);
  const reps = args.identityOnly ? 1 : Math.max(1, args.reps);
  const samples = { baseline: [], candidate: [] };
  let identities = null;
  for (let rep = 0; rep < reps; rep++) {
    // Alternate the order so a drifting machine load does not favour one side.
    const order = rep % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    const round = {};
    for (const label of order) {
      round[label] = measure(label, label === 'baseline' ? baseline : candidate, { hash: rep === 0 });
      const s = round[label].summary;
      samples[label].push(s.phaseMs.write);
      console.log(`rep ${rep + 1} ${label}: files=${s.filesRewritten} write=${s.phaseMs.write}ms total=${s.phaseMs.total}ms rss=${s.memoryMB.rss}MB load=${os.loadavg()[0].toFixed(1)}${s.writeDetail ? ` writeDetail=${JSON.stringify(s.writeDetail)}` : ''}`);
    }
    if (rep === 0) identities = round;
  }
  const a = identities.baseline.identity;
  const b = identities.candidate.identity;
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(`identity: ${same ? 'IDENTICAL' : 'DIFFERENT'}`);
  console.log(`  baseline  ${a.dist.files} files dist=${a.dist.sha256} manifests=${a.manifestsSha256}`);
  console.log(`  candidate ${b.dist.files} files dist=${b.dist.sha256} manifests=${b.manifestsSha256}`);
  console.log(`  counters  ${b.counters}`);
  if (!args.identityOnly) {
    const before = median(samples.baseline);
    const after = median(samples.candidate);
    console.log(`write median over ${reps} rep(s): baseline=${before}ms candidate=${after}ms ratio=${(before / Math.max(1, after)).toFixed(2)}x`);
  }
  process.exitCode = same ? 0 : 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
