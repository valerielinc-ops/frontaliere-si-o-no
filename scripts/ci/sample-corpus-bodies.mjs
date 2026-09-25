#!/usr/bin/env node
/**
 * Regenerates `tests/__fixtures__/corpus-body-sample.json` — the real article
 * bodies `tests/corpus-body-render-regression.test.ts` renders (issue #5415).
 *
 * The bodies live in the CORPUS repo (`nanakokyobashi-rgb/frontaliere-articles`,
 * `content/blog-body/<locale>/<slug>.ts`), which this repo does not vendor, so
 * the sample is checked in rather than read at test time. Point this at a corpus
 * checkout when the sample needs refreshing:
 *
 *     node scripts/ci/sample-corpus-bodies.mjs ~/Projects/frontaliere-articles
 *
 * Sampling is deterministic — same corpus in, same fixture out — so a refresh
 * produces a reviewable diff instead of 46 unrelated bodies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'tests', '__fixtures__', 'corpus-body-sample.json');
const LOCALES = ['it', 'en', 'de', 'fr'];
const SEPARATOR_RX = /^\|(\s*:?-{2,}:?\s*\|)+\s*$/m;

// Under 400 chars a body is a stub with nothing to render.
const MIN_LEN = 400;

// Per-group ceilings, because the groups assert different things. The two
// groups whose assertions read the WHOLE rendered output (a table must appear;
// every pipe must survive) have to stay under the static renderer's
// 1.800-RENDERED-character budget or they would assert truncation instead —
// source length ≥ rendered length, so 1.700 is a safe ceiling and not a guess.
// The plain group only asserts that no table appeared, which truncation cannot
// affect, so it takes longer bodies and keeps the sample varied.
const MAX_LEN = { table: 1700, pipeProse: 1700, plain: 4000 };

// `it` has only ten bodies corpus-wide with a stray `|` in prose and none of
// them is short, so its pipe-prose group is sampled without the ceiling: the
// false-positive assertion (no table appeared) holds under truncation too.
const PIPE_PROSE_UNCAPPED_LOCALES = new Set(['it']);

const corpusRoot = process.argv[2] || path.resolve(ROOT, '..', 'frontaliere-articles');
const bodyRoot = path.join(corpusRoot, 'content', 'blog-body');
if (!fs.existsSync(bodyRoot)) {
  console.error(`❌ no corpus bodies at ${bodyRoot}\n   usage: node scripts/ci/sample-corpus-bodies.mjs <corpus-checkout>`);
  process.exit(1);
}

/**
 * The body files are generated TypeScript — one object literal of
 * `'blog.article.<id>.bodyN': '<markdown>'` pairs. Evaluating the literal is the
 * only exact way to undo the TS string escaping; these are this project's own
 * generated files, read from a local checkout.
 */
function loadBodies(file) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('= {');
  const end = src.lastIndexOf('};');
  if (start < 0 || end < 0) return {};
  return new Function(`return ${src.slice(start + 2, end + 1)}`)();
}

/**
 * Evenly spaced picks over the alphabetically sorted pool, one body per article:
 * spreads the sample across the corpus (evergreen guides, news, job pages)
 * instead of clustering on one article's bodyN run, and stays deterministic.
 */
function spread(pool, count) {
  const seenSlugs = new Set();
  const picked = [];
  for (let i = 0; i < count && pool.length; i++) {
    for (let step = 0; step < pool.length; step++) {
      const index = (Math.floor((i * pool.length) / count) + step) % pool.length;
      const slug = pool[index][0].split('#')[0];
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      picked.push(pool[index]);
      break;
    }
  }
  return picked;
}

const sample = {};
for (const locale of LOCALES) {
  const dir = path.join(bodyRoot, locale);
  const groups = { table: [], pipeProse: [], plain: [] };

  for (const name of fs.readdirSync(dir).sort()) {
    // The daily brief is the article the fix was FOR: it belongs in the
    // targeted tests, not in the sample that proves everything else is intact.
    if (!name.endsWith('.ts') || name.startsWith('bollettino-frontaliere-')) continue;
    let bodies;
    try {
      bodies = loadBodies(path.join(dir, name));
    } catch {
      continue;
    }
    for (const [key, text] of Object.entries(bodies)) {
      if (!/\.body\d+$/.test(key)) continue;
      if (typeof text !== 'string' || text.length < MIN_LEN) continue;
      const group = SEPARATOR_RX.test(text) ? 'table' : text.includes('|') ? 'pipeProse' : 'plain';
      const uncapped = group === 'pipeProse' && PIPE_PROSE_UNCAPPED_LOCALES.has(locale);
      if (!uncapped && text.length > MAX_LEN[group]) continue;
      groups[group].push([`${name.replace(/\.ts$/, '')}#${key.split('.').pop()}`, text]);
    }
  }

  sample[locale] = Object.fromEntries([
    ...spread(groups.table, 4),
    ...spread(groups.pipeProse, 3),
    ...spread(groups.plain, 5),
  ]);
  console.log(
    `${locale}: pools table=${groups.table.length} pipe-prose=${groups.pipeProse.length} plain=${groups.plain.length}`
    + ` → sampled ${Object.keys(sample[locale]).length}`,
  );
}

fs.writeFileSync(OUT, `${JSON.stringify(sample, null, 2)}\n`);
console.log(`✅ ${path.relative(ROOT, OUT)} — ${Object.values(sample).reduce((n, m) => n + Object.keys(m).length, 0)} bodies, ${fs.statSync(OUT).size} bytes`);
