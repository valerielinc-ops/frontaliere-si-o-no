#!/usr/bin/env node
/**
 * audit-title-length.mjs
 *
 * Walks `dist/**\/*.html` and reports pages whose `<title>` exceeds the
 * SERP-display budget (default 60 char) plus the brand suffix
 * `" | Frontaliere Ticino"` (22 char) → 82-char practical floor.
 *
 * Why the gate exists. After the universal "never truncate <title>" fix
 * (commit a7eab849d), pages with a long disambiguator (city, canton,
 * address, age bracket) now overflow Google's SERP-display budget. This is
 * the intentional trade-off: uniqueness > SERP length. But we still want
 * to *track* the long-titles bucket so a future template change that
 * inflates titles further doesn't go unnoticed.
 *
 * Usage:
 *   node scripts/audit-title-length.mjs                          # human summary
 *   node scripts/audit-title-length.mjs --threshold=90           # custom char limit
 *   node scripts/audit-title-length.mjs --json                   # JSON report
 *   node scripts/audit-title-length.mjs --csv > out.csv          # CSV report
 *   node scripts/audit-title-length.mjs --limit=50               # show top N
 *   node scripts/audit-title-length.mjs --feature=fuel-daily     # one bucket
 *   node scripts/audit-title-length.mjs --fail-on-offenders
 *   node scripts/audit-title-length.mjs --include-noindex
 *   node scripts/audit-title-length.mjs --baseline=path.json     # ratchet mode
 *   node scripts/audit-title-length.mjs --write-baseline=path.json
 *
 * Baseline / ratchet: same semantics as audit-text-html-ratio and
 * audit-h1-title-duplicates. The deploy gate uses `--baseline=` to fail
 * only on regressions; improvements are always accepted. After a fix
 * lands, regenerate the baseline with `--write-baseline=` and commit.
 *
 * Exit code:
 *   0 — within baseline budget (or --fail-on-offenders not set).
 *   1 — `--fail-on-offenders` set OR baseline regression detected.
 *   2 — dist/ missing / fatal error.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

const argv = process.argv.slice(2);
const args = new Map();
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? true);
  }
}

// Default threshold: 60 (SERP-display target) + 10 % tolerance = 66.
// Aligned with build-plugins/shared/titleSuffix.ts:TITLE_MAX_CHARS.
const THRESHOLD = Number(args.get('threshold') ?? 66);
const LIMIT = Number(args.get('limit') ?? 30);
const MODE_JSON = args.has('json');
const MODE_CSV = args.has('csv');
const FAIL = args.has('fail-on-offenders');
const FEATURE_FILTER = args.get('feature') ?? null;
const INCLUDE_NOINDEX = args.has('include-noindex');
const BASELINE_PATH = args.get('baseline');
const WRITE_BASELINE_PATH = args.get('write-baseline');

const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));

const NOINDEX_RE = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i;
const META_REFRESH_RE = /<meta[^>]+http-equiv=["']refresh["']/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

async function walk(dir) {
  // Iterative — the cathedral expansion produced dist/ trees deep enough
  // to blow the call stack via async recursion + array spread.
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const e of entries) {
      // Skip dot-prefixed dirs (e.g. dist/.write-collisions-data/ — debug
      // artifacts from writeRegistryLifecyclePlugin, not deployed pages).
      if (e.isDirectory() && e.name.startsWith('.')) continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && p.endsWith('.html')) {
        out.push(p);
      }
    }
  }
  return out;
}

function normalizeText(raw) {
  if (!raw) return '';
  let s = raw.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  return s.replace(/\s+/g, ' ').trim();
}

/** Mirror of audit-h1-title-duplicates classifier. */
function classifyFeature(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  if (/(?:^|\/)(prezzi-benzina-svizzera|prezzi-carburante-svizzera|prix-essence-suisse|fuel-prices-switzerland|benzinpreise?-schweiz|prezzi-benzina|prezzi-diesel|gasoline-price|diesel-price|benzinpreis|dieselpreis|prix-essence|prix-gasoil|prix-diesel)\//.test(p)) return 'fuel-daily';
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\/(?:azienda|company|unternehmen|entreprise)-/.test(p)) return 'weekly-employers';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|firmen-die-einstellen|unternehmen-die-einstellen|entreprises-qui-recrutent)\//.test(p)) return 'weekly-employers-hub';
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test(p)) return 'job-board';
  if (/(?:^|\/)(?:premi-cassa-malati|cassa-malati|health-premiums|health-insurance|krankenkassen-praemien|krankenkasse|primes-assurance-maladie)\//.test(p)) return 'health-premiums';
  if (/(?:^|\/)(?:mercato-lavoro|mercato-lavoro-ticino|job-market|ticino-job-market|arbeitsmarkt|arbeitsmarkt-tessin|marche-emploi|marche-travail|marche-emploi-tessin|marche-travail-tessin)\//.test(p)) return 'job-market-snapshot';
  if (/(?:^|\/)(?:articoli-frontaliere|cross-border-articles|grenzgaenger-artikel|articles-frontalier)\//.test(p)) return 'blog';
  if (/(?:^|\/)(?:tempi-attesa-frontiera|border-wait-times|grenzwartezeiten|wartezeit-grenze|temps-attente-frontiere)\//.test(p)) return 'border-wait';
  if (/^\/(en|de|fr)\//.test(p)) return 'spa-locale';
  return 'spa-other';
}

function inferLocale(relPath) {
  const seg = relPath.replace(/\\/g, '/').replace(/^dist\//, '').split('/')[0];
  if (seg === 'en' || seg === 'de' || seg === 'fr') return seg;
  return 'it';
}

async function main() {
  const stats = await stat(DIST).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    console.error(`audit-title-length: dist/ not found at ${DIST}. Run a build first.`);
    process.exit(2);
  }

  const files = await walk(DIST);
  const offenders = [];
  let scanned = 0;
  let skippedNoindex = 0;
  let missingTitle = 0;

  for (const file of files) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!html) continue;
    if (!INCLUDE_NOINDEX && (NOINDEX_RE.test(html) || META_REFRESH_RE.test(html))) {
      skippedNoindex++;
      continue;
    }
    scanned++;
    const titleMatch = html.match(TITLE_RE);
    const title = normalizeText(titleMatch?.[1] ?? '');
    if (!title) { missingTitle++; continue; }
    if (title.length <= THRESHOLD) continue;
    const rel = relative(ROOT, file);
    const feature = classifyFeature(rel);
    if (FEATURE_FILTER && feature !== FEATURE_FILTER) continue;
    const locale = inferLocale(rel);
    offenders.push({ file: rel, feature, locale, title, length: title.length });
  }

  offenders.sort((a, b) => b.length - a.length);

  const byFeatureCount = {};
  const byLocaleCount = {};
  for (const r of offenders) {
    byFeatureCount[r.feature] = (byFeatureCount[r.feature] ?? 0) + 1;
    byLocaleCount[r.locale] = (byLocaleCount[r.locale] ?? 0) + 1;
  }

  if (MODE_CSV) {
    console.log('file,feature,locale,length,title');
    for (const r of offenders) {
      const safe = (s) => `"${String(s).replace(/"/g, '""')}"`;
      console.log(`${r.file},${r.feature},${r.locale},${r.length},${safe(r.title)}`);
    }
    process.exit(FAIL && offenders.length > 0 ? 1 : 0);
  }

  if (MODE_JSON) {
    console.log(JSON.stringify({
      scanned,
      skippedNoindex,
      missingTitle,
      threshold: THRESHOLD,
      offenders: offenders.length,
      byFeature: byFeatureCount,
      byLocale: byLocaleCount,
      worst: offenders.slice(0, LIMIT),
    }, null, 2));
    process.exit(FAIL && offenders.length > 0 ? 1 : 0);
  }

  console.log(`audit-title-length: scanned ${scanned} HTML files in dist/ (skipped ${skippedNoindex} noindex/redirect, ${missingTitle} missing <title>)`);
  console.log(`Threshold: ${THRESHOLD} chars`);
  console.log(`Offenders (length > ${THRESHOLD}): ${offenders.length} (${((offenders.length / Math.max(scanned, 1)) * 100).toFixed(1)} % of scanned)`);

  if (Object.keys(byFeatureCount).length > 0) {
    console.log('\nOffenders by feature:');
    for (const [f, c] of Object.entries(byFeatureCount).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(6)}  ${f}`);
    }
  }
  if (Object.keys(byLocaleCount).length > 0) {
    console.log('\nOffenders by locale:');
    for (const [l, c] of Object.entries(byLocaleCount).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(6)}  ${l}`);
    }
  }
  if (offenders.length > 0) {
    console.log(`\nWorst ${Math.min(LIMIT, offenders.length)} offenders:`);
    for (const r of offenders.slice(0, LIMIT)) {
      console.log(`  ${String(r.length).padStart(4)} ch  [${r.locale}] ${r.feature.padEnd(22)}  ${r.file}`);
      console.log(`        ${JSON.stringify(r.title.slice(0, 120))}`);
    }
  }

  // Baseline write / ratchet check.
  if (WRITE_BASELINE_PATH && typeof WRITE_BASELINE_PATH === 'string') {
    const baseline = {
      generated: new Date().toISOString(),
      threshold: THRESHOLD,
      total: offenders.length,
      byFeature: byFeatureCount,
      byLocale: byLocaleCount,
    };
    await writeFile(resolvePath(WRITE_BASELINE_PATH), JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    console.log(`\nWrote baseline → ${WRITE_BASELINE_PATH}`);
  }

  if (BASELINE_PATH && typeof BASELINE_PATH === 'string') {
    let baseline;
    try {
      baseline = JSON.parse(await readFile(resolvePath(BASELINE_PATH), 'utf8'));
    } catch (err) {
      console.error(`audit-title-length: cannot read baseline ${BASELINE_PATH}: ${err.message}`);
      process.exit(2);
    }
    let regression = false;
    const regressedFeatures = [];
    if (typeof baseline.total === 'number' && offenders.length > baseline.total) {
      console.error(`\nREGRESSION: total offenders ${offenders.length} > baseline ${baseline.total}`);
      regression = true;
    }
    if (baseline.byFeature && typeof baseline.byFeature === 'object') {
      for (const [feat, count] of Object.entries(byFeatureCount)) {
        const cap = baseline.byFeature[feat] ?? 0;
        if (count > cap) {
          console.error(`REGRESSION: feature "${feat}" offenders ${count} > baseline ${cap}`);
          regressedFeatures.push({ feat, cap, count });
          regression = true;
        }
      }
    }
    if (regression) {
      // Dump ALL offenders for each regressed feature so the CI log alone is
      // enough to diagnose without downloading the dist artifact (which can
      // exceed 1 GB and take 30-60 min). Sorted by length desc so the longest
      // titles surface first.
      for (const { feat, cap, count } of regressedFeatures) {
        const featOffenders = offenders
          .filter((o) => o.feature === feat)
          .sort((a, b) => b.length - a.length);
        console.error(`\nFull offender list for feature "${feat}" (${count} pages, baseline ${cap}, +${count - cap}):`);
        for (const o of featOffenders) {
          console.error(`  ${String(o.length).padStart(3)} ch  [${o.locale}]  ${o.file}`);
          console.error(`        ${o.title}`);
        }
      }
      console.error('\nThe title-length baseline ratchet only allows the count to go DOWN.');
      console.error('Shorten the offending titleBases, then regenerate with --write-baseline=<path>.');
      process.exit(1);
    }
    console.log('\nBaseline ratchet: OK (no regressions vs ' + BASELINE_PATH + ')');
  }

  process.exit(FAIL && offenders.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('audit-title-length: fatal', err);
  process.exit(2);
});
