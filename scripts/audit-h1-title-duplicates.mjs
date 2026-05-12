#!/usr/bin/env node
/**
 * audit-h1-title-duplicates.mjs
 *
 * Walks `dist/**\/*.html` and flags pages whose <title> equals their first
 * <h1>. Mirrors the Semrush Site Audit rule "Duplicate H1 and title tags".
 *
 * Comparison is case-insensitive and whitespace-normalized (collapsed runs +
 * trimmed). Pages without a <title> or without an <h1> are not offenders —
 * they're tracked separately as `missing-title` / `missing-h1` for context.
 *
 * Pages with `<meta name="robots" content="noindex">` or a meta-refresh
 * redirect are skipped by default (Semrush doesn't flag them either). Pass
 * `--include-noindex` to count them anyway.
 *
 * Usage:
 *   node scripts/audit-h1-title-duplicates.mjs                  # human summary
 *   node scripts/audit-h1-title-duplicates.mjs --json           # JSON report
 *   node scripts/audit-h1-title-duplicates.mjs --csv > out.csv  # CSV report
 *   node scripts/audit-h1-title-duplicates.mjs --limit=50       # show top N
 *   node scripts/audit-h1-title-duplicates.mjs --feature=blog   # one bucket
 *   node scripts/audit-h1-title-duplicates.mjs --fail-on-offenders
 *   node scripts/audit-h1-title-duplicates.mjs --include-noindex
 *   node scripts/audit-h1-title-duplicates.mjs --baseline=path.json
 *   node scripts/audit-h1-title-duplicates.mjs --write-baseline=path.json
 *
 * Baseline / ratchet mode (mirrors audit-text-html-ratio.mjs)
 * ----------------------------------------------------------
 * The repo can ship a snapshot at `data/h1-title-duplicates-baseline.json`
 * that records the per-feature offender count. With `--baseline=<file>`
 * the audit reads that snapshot and FAILS only when:
 *   - total offenders > baseline.total, OR
 *   - any feature's offender count > baseline.byFeature[feature]
 * Improvements (count goes down) are always accepted. After a fix lands
 * regenerate the baseline with `--write-baseline=<file>` and commit it.
 *
 * Exit code:
 *   0 — no offenders / within baseline budget.
 *   1 — `--fail-on-offenders` set (or baseline regression) and ≥1 offender.
 *   2 — dist/ missing (run a build first) or fatal error.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { writeAuditReport, relBaseline } from './lib/auditReport.mjs';

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
const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;

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
      // Skip dot-prefixed dirs (debug artifacts, not deployed pages).
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

/** Strip inner tags + decode common entities + collapse whitespace. */
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

/** Mirror of audit-text-html-ratio classifier — see CLAUDE.md SEO features. */
function classifyFeature(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  if (/(?:^|\/)(prezzi-benzina-svizzera|prezzi-carburante-svizzera|prix-essence-suisse|fuel-prices-switzerland|benzinpreise?-schweiz)\//.test(p)) return 'fuel-daily';
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\/(?:azienda|company|unternehmen|entreprise)-/.test(p)) return 'weekly-employers';
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test(p)) return 'job-board';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|firmen-die-einstellen|entreprises-qui-recrutent)\//.test(p)) return 'weekly-employers-hub';
  if (/(?:^|\/)(?:premi-cassa-malati|health-premiums|krankenkassen-praemien|primes-assurance-maladie)\//.test(p)) return 'health-premiums';
  if (/(?:^|\/)(?:mercato-lavoro|job-market|arbeitsmarkt|marche-emploi)\//.test(p)) return 'job-market-snapshot';
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
    console.error(`audit-h1-title-duplicates: dist/ not found at ${DIST}. Run a build first.`);
    process.exit(2);
  }

  const files = await walk(DIST);
  const report = [];
  let scanned = 0;
  let skippedNoindex = 0;
  let missingTitle = 0;
  let missingH1 = 0;

  for (const file of files) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch (err) {
      // Concurrent build (other agents/plugins) may delete files between
      // walk() and readFile(); just skip — they'll be recounted next run.
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
    const h1Match = html.match(H1_RE);
    const title = normalizeText(titleMatch?.[1] ?? '');
    const h1 = normalizeText(h1Match?.[1] ?? '');

    if (!title) { missingTitle++; continue; }
    if (!h1) { missingH1++; continue; }

    const isDup = title.toLowerCase() === h1.toLowerCase();
    if (!isDup) continue;

    const rel = relative(ROOT, file);
    const feature = classifyFeature(rel);
    if (FEATURE_FILTER && feature !== FEATURE_FILTER) continue;
    const locale = inferLocale(rel);
    report.push({ file: rel, feature, locale, title, h1 });
  }

  const offenders = report;
  const byFeatureCount = {};
  const byLocaleCount = {};
  for (const r of offenders) {
    byFeatureCount[r.feature] = (byFeatureCount[r.feature] ?? 0) + 1;
    byLocaleCount[r.locale] = (byLocaleCount[r.locale] ?? 0) + 1;
  }

  const structuredOffenders = offenders.map((r) => ({
    path: r.file,
    feature: r.feature,
    metric: 1,
    ratio: null,
    locale: r.locale,
    title: r.title,
    h1: r.h1,
  }));
  const writeReport = (passed, baselineDelta) => writeAuditReport({
    audit: 'h1-title-duplicates',
    passed,
    threshold: { metric: 'count', value: 0, comparator: '<=baseline' },
    baselineFile: relBaseline(typeof BASELINE_PATH === 'string' ? BASELINE_PATH : null),
    baselineDelta,
    offenders: structuredOffenders,
    byFeature: byFeatureCount,
    extra: { byLocale: byLocaleCount },
  });

  if (MODE_CSV) {
    console.log('file,feature,locale,title');
    for (const r of offenders) {
      const safe = (s) => `"${String(s).replace(/"/g, '""')}"`;
      console.log(`${r.file},${r.feature},${r.locale},${safe(r.title)}`);
    }
    await writeReport(!(FAIL && offenders.length > 0), null);
    process.exit(FAIL && offenders.length > 0 ? 1 : 0);
  }

  if (MODE_JSON) {
    console.log(JSON.stringify({
      scanned,
      skippedNoindex,
      missingTitle,
      missingH1,
      offenders: offenders.length,
      byFeature: byFeatureCount,
      byLocale: byLocaleCount,
      worst: offenders.slice(0, LIMIT),
    }, null, 2));
    await writeReport(!(FAIL && offenders.length > 0), null);
    process.exit(FAIL && offenders.length > 0 ? 1 : 0);
  }

  // Human-readable summary.
  console.log(`audit-h1-title-duplicates: scanned ${scanned} HTML files in dist/ (skipped ${skippedNoindex} noindex/redirect, ${missingTitle} missing <title>, ${missingH1} missing <h1>)`);
  console.log(`Offenders (title === h1, case+whitespace-insensitive): ${offenders.length} (${((offenders.length / Math.max(scanned, 1)) * 100).toFixed(1)} % of scanned)`);

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
    console.log(`\nFirst ${Math.min(LIMIT, offenders.length)} offenders:`);
    for (const r of offenders.slice(0, LIMIT)) {
      console.log(`  [${r.locale}] ${r.feature.padEnd(22)}  ${r.file}`);
      console.log(`        title=h1=${JSON.stringify(r.title.slice(0, 120))}`);
    }
  }

  // ── Baseline write / ratchet check ─────────────────────────────────────────
  if (WRITE_BASELINE_PATH && typeof WRITE_BASELINE_PATH === 'string') {
    const baseline = {
      generated: new Date().toISOString(),
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
      console.error(`audit-h1-title-duplicates: cannot read baseline ${BASELINE_PATH}: ${err.message}`);
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
      // enough to diagnose without downloading the dist artifact.
      for (const { feat, cap, count } of regressedFeatures) {
        const featOffenders = offenders
          .filter((o) => o.feature === feat)
          .sort((a, b) => a.file.localeCompare(b.file));
        console.error(`\nFull offender list for feature "${feat}" (${count} pages, baseline ${cap}, +${count - cap}):`);
        for (const o of featOffenders) {
          console.error(`  [${o.locale}]  ${o.file}`);
          console.error(`        title: ${o.title}`);
          console.error(`        h1:    ${o.h1}`);
        }
      }
      console.error('\nThe duplicate-h1 baseline ratchet only allows the count to go DOWN.');
      console.error('Fix the new offenders, then regenerate with --write-baseline=<path>.');
      const baseTotal = Number(baseline.total ?? 0);
      await writeReport(false, { before: baseTotal, after: offenders.length, regression: Math.max(0, offenders.length - baseTotal) });
      process.exit(1);
    }
    console.log('\nBaseline ratchet: OK (no regressions vs ' + BASELINE_PATH + ')');
    const baseTotalOk = Number(baseline.total ?? 0);
    await writeReport(true, { before: baseTotalOk, after: offenders.length, regression: Math.max(0, offenders.length - baseTotalOk) });
    process.exit(FAIL && offenders.length > 0 ? 1 : 0);
  }

  await writeReport(!(FAIL && offenders.length > 0), null);
  process.exit(FAIL && offenders.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('audit-h1-title-duplicates: fatal', err);
  process.exit(2);
});
