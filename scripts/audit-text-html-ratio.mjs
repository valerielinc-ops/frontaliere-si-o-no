#!/usr/bin/env node
/**
 * audit-text-html-ratio.mjs
 *
 * Walk `dist/**\/*.html` and compute the text-to-HTML ratio Semrush uses to
 * flag "Low text-to-HTML ratio" issues:
 *
 *   ratio = visibleTextBytes / totalHtmlBytes * 100
 *
 * "Visible text" = HTML with <script>, <style>, <noscript>, comments, and all
 * remaining tags stripped, then whitespace collapsed. Pages with ratio ≤ 10 %
 * are flagged (Semrush threshold).
 *
 * The script also classifies offenders by SEO feature so we can see whether
 * the Semrush-reported 1,193 pages cluster in fuel-daily / weekly-employers /
 * job-employer landings (the suspected culprits) or are spread across the
 * codebase.
 *
 * Usage:
 *   node scripts/audit-text-html-ratio.mjs                       # human summary
 *   node scripts/audit-text-html-ratio.mjs --threshold=10        # custom %
 *   node scripts/audit-text-html-ratio.mjs --limit=50            # show top N
 *   node scripts/audit-text-html-ratio.mjs --json                # JSON report
 *   node scripts/audit-text-html-ratio.mjs --csv > out.csv       # CSV report
 *   node scripts/audit-text-html-ratio.mjs --feature=fuel-daily  # one bucket
 *   node scripts/audit-text-html-ratio.mjs --fail-on-offenders   # exit 1 if any
 *   node scripts/audit-text-html-ratio.mjs --include-noindex     # don't skip noindex
 *   node scripts/audit-text-html-ratio.mjs --baseline=path.json  # ratchet mode
 *   node scripts/audit-text-html-ratio.mjs --write-baseline=path.json  # snapshot
 *
 * By default the audit SKIPS pages with `<meta name="robots" content="noindex">`
 * or a `<meta http-equiv="refresh">` redirect, because they aren't indexed and
 * Semrush won't include them in its "low text/HTML ratio" issue. Pass
 * `--include-noindex` to count them anyway.
 *
 * Baseline / ratchet mode
 * -----------------------
 * The repo ships a snapshot at `data/text-html-ratio-baseline.json` that
 * records the current per-feature offender count. With `--baseline=<file>`
 * the audit reads that snapshot and FAILS only when:
 *   - total offenders > baseline.total, OR
 *   - any feature's offender count > baseline.byFeature[feature]
 *
 * This lets the deploy gate stop *regressions* (new templates leaking thin
 * markup) without failing on the legacy backlog. To accept improvements after
 * a fix lands, regenerate the baseline with `--write-baseline=<file>` and
 * commit the JSON. The number must only ever go DOWN — never raise it without
 * documenting why in the PR description.
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

const THRESHOLD = Number(args.get('threshold') ?? 10); // percent
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

/** @param {string} dir */
async function walk(dir) {
  // Iterative — the cathedral expansion produced dist/ trees deep enough
  // to blow the call stack via async recursion + array spread.
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length > 0) {
    const cur = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue;
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

/**
 * Strip HTML to its visible-text portion using the same heuristic Semrush
 * documents in its "Low text-to-HTML ratio" rule:
 *   - drop <script>, <style>, <noscript>, <template>, <svg> blocks (incl. content)
 *   - drop HTML comments and DOCTYPE
 *   - drop all remaining tags
 *   - decode the most common entities so text bytes are realistic
 *   - collapse runs of whitespace
 *
 * @param {string} html
 * @returns {string}
 */
function extractVisibleText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<!doctype[^>]*>/gi, ' ');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<template\b[\s\S]*?<\/template>/gi, ' ');
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
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
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Best-effort feature bucket from URL path. Mirrors the SEO build plugins
 * documented in CLAUDE.md so we can group offenders by the pipeline that
 * produced them.
 * @param {string} relPath
 */
function classifyFeature(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  // Career-landings (per-company hub, no city) come from careerLandingsPlugin
  // and live at /<jobs-locale>/(azienda|company|unternehmen|entreprise)-<slug>/.
  // Match those FIRST, before the weeklyEmployers per-company×city template.
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\/(?:azienda|company|unternehmen|entreprise)-[^/]+\/?$/.test(p)) {
    return 'career-landings';
  }
  // Fuel-daily slugs cover both petrol and diesel for every locale, with
  // separate roots for the Ticino-side (`-svizzera`/`-suisse`/`-schweiz`
  // suffix) and the Italy-side stations (no suffix). Diesel mirrors petrol
  // with the relevant translation. Legacy spellings stay as fallbacks.
  if (/(?:^|\/)(prezzi-benzina-svizzera|prezzi-benzina|prezzi-diesel|prezzi-carburante-svizzera|gasoline-price-switzerland|diesel-price-switzerland|prix-essence-suisse|prix-diesel-suisse|prix-gasoil-suisse|fuel-prices-switzerland|benzinpreis-schweiz|dieselpreis-schweiz|benzinpreise-schweiz)\//.test(p)) return 'fuel-daily';
  // Weekly-employers per-company×city pages live UNDER /aziende-che-assumono/<city>/<company>/...
  // Locale slugs: companies-hiring (en), unternehmen-einstellen (de),
  // entreprises-recrutent (fr) — keep the previous slug spellings as
  // historical fallbacks.
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\/[^/]+\/[^/]+\//.test(p)) {
    return 'weekly-employers';
  }
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\//.test(p)) {
    return 'weekly-employers-hub';
  }
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test(p)) return 'job-board';
  // Health premiums: EN slug is `health-insurance-premiums`, DE is
  // `krankenkassenpraemien` (one word, no hyphen), FR keeps the previous
  // `primes-assurance-maladie`. Legacy short forms stay as fallbacks.
  if (/(?:^|\/)(?:premi-cassa-malati|health-insurance-premiums|health-premiums|krankenkassenpraemien|krankenkassen-praemien|primes-assurance-maladie|primes-assurance-maladie-communes|primi-cassa-malati-comuni)\//.test(p)) return 'health-premiums';
  // Job market: IT slug carries the `-ticino` suffix; locale variants are
  // ticino-job-market (en), tessiner-arbeitsmarkt (de, genitive form),
  // marche-travail-tessin (fr).
  if (/(?:^|\/)(?:mercato-lavoro-ticino|ticino-job-market|tessiner-arbeitsmarkt|tessin-arbeitsmarkt|marche-travail-tessin|tessin-marche-emploi|mercato-lavoro|job-market|arbeitsmarkt|marche-emploi)\//.test(p)) return 'job-market-snapshot';
  // Blog locale slugs: cross-border-articles (en), grenzgaenger-artikel (de),
  // articles-frontalier (fr).
  if (/(?:^|\/)(?:articoli-frontaliere|cross-border-articles|grenzgaenger-artikel|articles-frontalier|blog|articles)\//.test(p)) return 'blog';
  // Border wait pages: IT canonical is `traffico-dogane`; locale variants are
  // border-wait (en), wartezeit-grenze (de), temps-attente-douane (fr).
  if (/(?:^|\/)(?:traffico-dogane|border-wait|wartezeit-grenze|temps-attente-douane|tempi-attesa-frontiera|border-wait-times|grenzwartezeiten|temps-attente-frontiere)\//.test(p)) return 'border-wait';
  // Weather city + hub pages emit ~40 inline-`<svg>` icons + sprite + Tailwind
  // shell on a fairly compact text body, so they have a distinct ratio
  // profile vs the generic SPA prerender. Keep them in their own bucket so
  // baseline tracking doesn't conflate weather with SPA-locale failures.
  // IT: /meteo-frontalieri/, EN: /commute-weather/, DE: /pendler-wetter/,
  // FR: /meteo-frontaliers/. Alert pages: /allerte-meteo/, /weather-alerts/,
  // /wetter-warnungen/, /alertes-meteo/.
  if (/(?:^|\/)(?:meteo-frontalieri|commute-weather|pendler-wetter|meteo-frontaliers|allerte-meteo|weather-alerts|wetter-warnungen|alertes-meteo)\//.test(p)) return 'weather';
  if (/^\/(en|de|fr)\//.test(p)) return 'spa-locale';
  return 'spa-other';
}

async function main() {
  const stats = await stat(DIST).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    console.error(`audit-text-html-ratio: dist/ not found at ${DIST}. Run a build first.`);
    process.exit(2);
  }

  const files = await walk(DIST);
  /** @type {{file:string, feature:string, htmlBytes:number, textBytes:number, ratio:number}[]} */
  const report = [];
  let skippedNoindex = 0;

  for (const file of files) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch (err) {
      // Tolerate races: autonomous build/translation pipelines may delete
      // pages between walk() and readFile(). Skip and move on — the next
      // run will pick the file up if it still exists.
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue;
      throw err;
    }
    const htmlBytes = Buffer.byteLength(html, 'utf8');
    if (htmlBytes === 0) continue;
    if (!INCLUDE_NOINDEX && (NOINDEX_RE.test(html) || META_REFRESH_RE.test(html))) {
      skippedNoindex++;
      continue;
    }
    const text = extractVisibleText(html);
    const textBytes = Buffer.byteLength(text, 'utf8');
    const ratio = (textBytes / htmlBytes) * 100;
    const rel = relative(ROOT, file);
    const feature = classifyFeature(rel);
    if (FEATURE_FILTER && feature !== FEATURE_FILTER) continue;
    report.push({ file: rel, feature, htmlBytes, textBytes, ratio });
  }

  const offenders = report.filter(r => r.ratio <= THRESHOLD).sort((a, b) => a.ratio - b.ratio);

  // Structured offenders for the JSON report — same data the human summary
  // uses, normalised to the shared schema (`metric` = ratio percent).
  const structuredOffenders = offenders.map((r) => ({
    path: r.file,
    feature: r.feature,
    metric: Number(r.ratio.toFixed(2)),
    ratio: Number(r.ratio.toFixed(2)),
    htmlBytes: r.htmlBytes,
    textBytes: r.textBytes,
  }));
  /** @type {Record<string, number>} */
  const byFeatureCountForReport = {};
  for (const r of offenders) {
    byFeatureCountForReport[r.feature] = (byFeatureCountForReport[r.feature] ?? 0) + 1;
  }
  /** Shared writer wrapping the helper so each exit branch is one line. */
  const writeReport = (passed, baselineDelta) => writeAuditReport({
    audit: 'text-html-ratio',
    passed,
    threshold: { metric: 'ratio', value: THRESHOLD, comparator: '>=' },
    baselineFile: relBaseline(typeof BASELINE_PATH === 'string' ? BASELINE_PATH : null),
    baselineDelta,
    offenders: structuredOffenders,
    byFeature: byFeatureCountForReport,
  });

  if (MODE_CSV) {
    console.log('file,feature,html_bytes,text_bytes,ratio_pct');
    for (const r of offenders) {
      console.log(`${r.file},${r.feature},${r.htmlBytes},${r.textBytes},${r.ratio.toFixed(2)}`);
    }
    await writeReport(!(FAIL && offenders.length > 0), null);
    process.exit(FAIL && offenders.length > 0 ? 1 : 0);
  }

  if (MODE_JSON) {
    /** @type {Record<string,{count:number, avgRatio:number}>} */
    const byFeature = {};
    for (const r of offenders) {
      byFeature[r.feature] ??= { count: 0, avgRatio: 0 };
      byFeature[r.feature].count++;
      byFeature[r.feature].avgRatio += r.ratio;
    }
    for (const k of Object.keys(byFeature)) {
      byFeature[k].avgRatio = +(byFeature[k].avgRatio / byFeature[k].count).toFixed(2);
    }
    console.log(JSON.stringify({
      scanned: report.length,
      threshold: THRESHOLD,
      offenders: offenders.length,
      byFeature,
      worst: offenders.slice(0, LIMIT),
    }, null, 2));
    await writeReport(!(FAIL && offenders.length > 0), null);
    process.exit(FAIL && offenders.length > 0 ? 1 : 0);
  }

  // Human-readable summary.
  console.log(`audit-text-html-ratio: scanned ${report.length} HTML files in dist/ (skipped ${skippedNoindex} noindex/redirect pages)`);
  console.log(`Threshold (Semrush "low text/HTML"): ratio ≤ ${THRESHOLD} %`);
  console.log(`Offenders: ${offenders.length} (${((offenders.length / Math.max(report.length, 1)) * 100).toFixed(1)} % of scanned)`);

  /** @type {Map<string, {count:number, sumRatio:number}>} */
  const byFeature = new Map();
  for (const r of offenders) {
    const cur = byFeature.get(r.feature) ?? { count: 0, sumRatio: 0 };
    cur.count++;
    cur.sumRatio += r.ratio;
    byFeature.set(r.feature, cur);
  }
  if (byFeature.size > 0) {
    console.log('\nOffenders by feature:');
    const rows = [...byFeature.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [feature, { count, sumRatio }] of rows) {
      console.log(`  ${String(count).padStart(6)}  ${(sumRatio / count).toFixed(2).padStart(5)} %  ${feature}`);
    }
  }

  if (offenders.length > 0) {
    console.log(`\nWorst ${Math.min(LIMIT, offenders.length)} offenders:`);
    for (const r of offenders.slice(0, LIMIT)) {
      console.log(`  ${r.ratio.toFixed(2).padStart(5)} %  ${(r.htmlBytes / 1024).toFixed(1).padStart(6)} KB  ${r.file}`);
    }
  }

  // ── Baseline write / ratchet check ─────────────────────────────────────────
  /** @type {Record<string, number>} */
  const byFeatureCount = {};
  for (const r of offenders) {
    byFeatureCount[r.feature] = (byFeatureCount[r.feature] ?? 0) + 1;
  }

  if (WRITE_BASELINE_PATH && typeof WRITE_BASELINE_PATH === 'string') {
    const baseline = {
      generated: new Date().toISOString(),
      threshold: THRESHOLD,
      scanned: report.length,
      total: offenders.length,
      byFeature: byFeatureCount,
      _comment:
        'Baseline for audit-text-html-ratio.mjs. Numbers must only DECREASE — ' +
        'this gate is a ratchet. Regenerate after lowering offenders by improving a template; ' +
        'never raise the numbers without explicit justification (it means new pages dropped below ' +
        `the ${THRESHOLD} % text/HTML ratio Semrush flags as "low text/HTML").`,
    };
    const outPath = resolvePath(WRITE_BASELINE_PATH);
    await writeFile(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    console.log(`\n→ wrote baseline to ${relative(ROOT, outPath)}`);
  }

  if (BASELINE_PATH && typeof BASELINE_PATH === 'string') {
    const inPath = resolvePath(BASELINE_PATH);
    let baseline;
    try {
      baseline = JSON.parse(await readFile(inPath, 'utf8'));
    } catch (err) {
      console.error(`\nFAIL: baseline file ${relative(ROOT, inPath)} could not be read: ${(/** @type {Error} */ (err)).message}`);
      console.error('   Generate one first with --write-baseline=' + relative(ROOT, inPath));
      process.exit(2);
    }
    const baseTotal = Number(baseline.total ?? 0);
    /** @type {Record<string, number>} */
    const baseByFeature = baseline.byFeature ?? {};
    const featureRegressions = [];
    for (const [feature, count] of Object.entries(byFeatureCount)) {
      const max = baseByFeature[feature] ?? 0;
      if (count > max) featureRegressions.push({ feature, count, max });
    }
    const totalRegression = offenders.length > baseTotal;
    if (totalRegression || featureRegressions.length > 0) {
      console.error('\n══════════════════════════════════════════════════════════════════════');
      console.error('FAIL: Semrush "low text-to-HTML ratio" gate REGRESSED');
      console.error('══════════════════════════════════════════════════════════════════════');
      console.error('');
      console.error('Why this gate exists');
      console.error('--------------------');
      console.error(`Semrush flags any page with text/HTML ratio ≤ ${THRESHOLD} % as`);
      console.error('"low text/HTML". Pages that hit this threshold rank worse because');
      console.error('search engines see lots of code wrapping very little content. The');
      console.error('Apr 2026 audit caught 1,193 such pages on frontaliereticino.ch.');
      console.error('');
      console.error('What just happened');
      console.error('------------------');
      if (totalRegression) {
        console.error(`  Total offenders: ${offenders.length} (baseline allows ${baseTotal})`);
      }
      for (const f of featureRegressions) {
        console.error(`  Feature "${f.feature}": ${f.count} offenders (baseline allows ${f.max})`);
      }
      console.error('');
      // Dump ALL offenders for each regressed feature so the CI log alone is
      // enough to diagnose without downloading the dist artifact (which can
      // exceed 1 GB and take 30-60 min). Sorted by ratio asc (worst first).
      for (const f of featureRegressions) {
        const featOffenders = offenders
          .filter((o) => o.feature === f.feature)
          .sort((a, b) => a.ratio - b.ratio);
        console.error(`Full offender list for feature "${f.feature}" (${f.count} pages, baseline ${f.max}, +${f.count - f.max}):`);
        for (const o of featOffenders) {
          console.error(`  ${o.ratio.toFixed(2).padStart(6)} %  ${(o.htmlBytes / 1024).toFixed(1).padStart(7)} KB  ${o.file}`);
        }
        console.error('');
      }
      console.error('How to fix');
      console.error('----------');
      console.error('1. Run locally to see the actual offending pages:');
      console.error('     node scripts/audit-text-html-ratio.mjs --limit=50');
      console.error('     node scripts/audit-text-html-ratio.mjs --feature=<name>');
      console.error('');
      console.error('2. For each offending TEMPLATE, add COHERENT page-relevant content —');
      console.error('   not filler. Good extensions: methodology paragraph, FAQ block,');
      console.error('   contextual prose tying the page to the frontaliere use case,');
      console.error('   cross-references to related comparators. NEVER add hidden text');
      console.error('   or boilerplate that repeats across pages — Google penalises that.');
      console.error('');
      console.error('3. The build plugins to inspect (one per feature bucket):');
      console.error('     fuel-daily          → build-plugins/fuelDailyPagesPlugin.ts');
      console.error('     weekly-employers*   → build-plugins/weeklyEmployersPlugin.ts');
      console.error('     health-premiums     → build-plugins/healthPremiumsLandingPlugin.ts');
      console.error('     job-board           → build-plugins/jobsSeoPagesPlugin.ts');
      console.error('     blog                → scripts/create-article.mjs (article generator)');
      console.error('     spa-locale / -other → htmlTemplate.ts + the SPA prerender shell');
      console.error('');
      console.error('4. After lowering the count, regenerate the baseline:');
      console.error('     npm run build && \\');
      console.error('       node scripts/audit-text-html-ratio.mjs \\');
      console.error('         --write-baseline=data/text-html-ratio-baseline.json');
      console.error('   Commit the new baseline JSON together with the template change.');
      console.error('');
      console.error('5. The baseline number must only ever DECREASE. Raising it means new');
      console.error('   pages have dropped below the threshold — fix that, do not ratchet up.');
      console.error('');
      console.error('See CLAUDE.md > "SEO content gate" for the full playbook.');
      await writeReport(false, { before: baseTotal, after: offenders.length, regression: offenders.length - baseTotal });
      process.exit(1);
    }
    const totalDelta = baseTotal - offenders.length;
    console.log(`\nratchet OK: ${offenders.length} offenders ≤ baseline ${baseTotal} (${totalDelta >= 0 ? '−' : '+'}${Math.abs(totalDelta)})`);
    await writeReport(true, { before: baseTotal, after: offenders.length, regression: Math.max(0, offenders.length - baseTotal) });
    process.exit(FAIL && offenders.length > 0 ? 1 : 0);
  }

  await writeReport(!(FAIL && offenders.length > 0), null);
  process.exit(FAIL && offenders.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('audit-text-html-ratio crashed:', err);
  process.exit(2);
});
