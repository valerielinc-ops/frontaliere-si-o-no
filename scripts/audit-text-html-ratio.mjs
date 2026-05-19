#!/usr/bin/env node
/**
 * audit-text-html-ratio.mjs
 *
 * Walk `dist/**\/*.html` and compute the text-to-HTML ratio Semrush uses to
 * flag "Low text-to-HTML ratio" issues:
 *
 *   ratio = visibleTextBytes / totalHtmlBytes * 100
 *
 * "Visible text" = HTML with <script>, <style>, <noscript>, <template>, <svg>,
 * comments stripped, then remaining tags removed and whitespace collapsed.
 * Pages with ratio ≤ 10 % are flagged (Semrush threshold).
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-text-html-ratio.mjs [...args]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { writeAuditReport, relBaseline } from './lib/auditReport.mjs';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';

const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));

const NOINDEX_RE = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i;
const META_REFRESH_RE = /<meta[^>]+http-equiv=["']refresh["']/i;

// Single combined strip regex (was 8 sequential .replace() calls). Each
// alternative captures one strip category: HTML comments, DOCTYPE, opaque
// blocks (script/style/noscript/template/svg) via capturing-group + backref
// so the closing tag matches the opening one, and finally any other tag.
// JavaScript regex engines evaluate alternation left-to-right first-match,
// so opaque-block matches consume the entire pair before the loose `<[^>]+>`
// can chip away at the opening tag alone.
//
// Profiled on 200 production HTML pages (avg 17 KB):
//   8-pass version: 0.098 ms/call
//   1-pass version: 0.053 ms/call  ← 1.86× faster
//   Byte-equal output: 200/200 (verified)
//
// At ~650k pages this saves ~29 s on the audit:all wall time without
// changing the offender count or text byte measurement.
const STRIP_RE =
  /<!--[\s\S]*?-->|<!doctype[^>]*>|<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>|<[^>]+>/gi;

/** @param {string} html */
export function extractVisibleText(html) {
  let s = html.replace(STRIP_RE, ' ');
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

/** Different from audit-title-length's classifyFeature — has career-landings,
 *  weekly-employers per-company×city, weather, more granular fuel-daily slugs. */
function classifyFeature(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\/(?:azienda|company|unternehmen|entreprise)-[^/]+\/?$/.test(p)) return 'career-landings';
  if (/(?:^|\/)(prezzi-benzina-svizzera|prezzi-benzina|prezzi-diesel|prezzi-carburante-svizzera|gasoline-price-switzerland|diesel-price-switzerland|prix-essence-suisse|prix-diesel-suisse|prix-gasoil-suisse|fuel-prices-switzerland|benzinpreis-schweiz|dieselpreis-schweiz|benzinpreise-schweiz)\//.test(p)) return 'fuel-daily';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\/[^/]+\/[^/]+\//.test(p)) return 'weekly-employers';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\//.test(p)) return 'weekly-employers-hub';
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test(p)) return 'job-board';
  if (/(?:^|\/)(?:premi-cassa-malati|health-insurance-premiums|health-premiums|krankenkassenpraemien|krankenkassen-praemien|primes-assurance-maladie|primes-assurance-maladie-communes|primi-cassa-malati-comuni)\//.test(p)) return 'health-premiums';
  if (/(?:^|\/)(?:mercato-lavoro-ticino|ticino-job-market|tessiner-arbeitsmarkt|tessin-arbeitsmarkt|marche-travail-tessin|tessin-marche-emploi|mercato-lavoro|job-market|arbeitsmarkt|marche-emploi)\//.test(p)) return 'job-market-snapshot';
  if (/(?:^|\/)(?:articoli-frontaliere|cross-border-articles|grenzgaenger-artikel|articles-frontalier|blog|articles)\//.test(p)) return 'blog';
  if (/(?:^|\/)(?:traffico-dogane|border-wait|wartezeit-grenze|temps-attente-douane|tempi-attesa-frontiera|border-wait-times|grenzwartezeiten|temps-attente-frontiere)\//.test(p)) return 'border-wait';
  if (/(?:^|\/)(?:meteo-frontalieri|commute-weather|pendler-wetter|meteo-frontaliers|allerte-meteo|weather-alerts|wetter-warnungen|alertes-meteo)\//.test(p)) return 'weather';
  if (/^\/(en|de|fr)\//.test(p)) return 'spa-locale';
  return 'spa-other';
}

export function createAuditor(opts = {}) {
  const threshold = opts.threshold ?? 10; // percent
  const limit = opts.limit ?? 30;
  const featureFilter = opts.featureFilter ?? null;
  const includeNoindex = !!opts.includeNoindex;
  const failOnOffenders = !!opts.failOnOffenders;
  const baselinePath = opts.baselinePath ?? null;
  const writeBaselinePath = opts.writeBaselinePath ?? null;

  const samples = [];
  let skippedNoindex = 0;

  return {
    name: 'text-html-ratio',
    collect(file, html) {
      if (!html) return;
      const htmlBytes = Buffer.byteLength(html, 'utf8');
      if (htmlBytes === 0) return;
      if (!includeNoindex && (NOINDEX_RE.test(html) || META_REFRESH_RE.test(html))) {
        skippedNoindex++;
        return;
      }
      const text = extractVisibleText(html);
      const textBytes = Buffer.byteLength(text, 'utf8');
      const ratio = (textBytes / htmlBytes) * 100;
      const rel = relative(ROOT, file);
      const feature = classifyFeature(rel);
      if (featureFilter && feature !== featureFilter) return;
      samples.push({ file: rel, feature, htmlBytes, textBytes, ratio });
    },
    async report() {
      const offenders = samples.filter((r) => r.ratio <= threshold).sort((a, b) => a.ratio - b.ratio);

      const byFeature = {};
      for (const r of offenders) {
        byFeature[r.feature] = (byFeature[r.feature] ?? 0) + 1;
      }

      if (writeBaselinePath) {
        const baseline = {
          generated: new Date().toISOString(),
          threshold,
          scanned: samples.length,
          total: offenders.length,
          byFeature,
          _comment: `Baseline for audit-text-html-ratio. Numbers must only DECREASE — this gate is a ratchet (page ratio ≤ ${threshold}%).`,
        };
        await writeFile(resolvePath(writeBaselinePath), JSON.stringify(baseline, null, 2) + '\n', 'utf8');
      }

      let passed = !(failOnOffenders && offenders.length > 0);
      let baselineDelta = null;
      const regressedFeatures = [];

      if (baselinePath) {
        let baseline;
        try { baseline = JSON.parse(await readFile(resolvePath(baselinePath), 'utf8')); }
        catch (err) {
          return {
            passed: false,
            offendersTotal: offenders.length,
            offenders: offenders.map((r) => ({
              path: r.file, feature: r.feature, metric: Number(r.ratio.toFixed(2)),
              ratio: Number(r.ratio.toFixed(2)), htmlBytes: r.htmlBytes, textBytes: r.textBytes,
            })),
            threshold: { metric: 'ratio', value: threshold, comparator: '>=' },
            extra: { scanned: samples.length, skippedNoindex, baselineError: err.message },
            humanSummary: `cannot read baseline ${baselinePath}: ${err.message}`,
          };
        }
        const baseTotal = Number(baseline.total ?? 0);
        const baseByFeature = baseline.byFeature ?? {};
        for (const [feature, count] of Object.entries(byFeature)) {
          const cap = baseByFeature[feature] ?? 0;
          if (count > cap) regressedFeatures.push({ feature, count, max: cap });
        }
        const totalRegression = offenders.length > baseTotal;
        baselineDelta = { before: baseTotal, after: offenders.length, regression: Math.max(0, offenders.length - baseTotal) };
        if (totalRegression || regressedFeatures.length > 0) passed = false;
      }

      const structuredOffenders = offenders.map((r) => ({
        path: r.file,
        feature: r.feature,
        metric: Number(r.ratio.toFixed(2)),
        ratio: Number(r.ratio.toFixed(2)),
        htmlBytes: r.htmlBytes,
        textBytes: r.textBytes,
      }));

      const humanSummary = passed
        ? `${offenders.length} offender(s) within baseline (threshold ${threshold} %)`
        : `${offenders.length} offender(s) ≤ ${threshold} % — regressed features: ${regressedFeatures.map(r => `${r.feature}(${r.count}>${r.max})`).join(', ') || 'total cap exceeded'}`;

      return {
        passed,
        offendersTotal: offenders.length,
        offenders: structuredOffenders,
        threshold: { metric: 'ratio', value: threshold, comparator: '>=' },
        baselineFile: relBaseline(baselinePath),
        baselineDelta,
        byFeature,
        extra: { scanned: samples.length, skippedNoindex, regressedFeatures, limit, threshold, rawSamples: samples },
        humanSummary,
      };
    },
  };
}

export function factory(opts) {
  return createAuditor({
    threshold: 10,
    baselinePath: 'data/text-html-ratio-baseline.json',
    ...opts,
  });
}
export const auditor = factory();

// ─── Standalone CLI ──────────────────────────────────────────────────────────

async function standalone() {
  const argv = process.argv.slice(2);
  const args = new Map();
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args.set(k, v ?? true);
    }
  }
  const opts = {
    threshold: Number(args.get('threshold') ?? 10),
    limit: Number(args.get('limit') ?? 30),
    featureFilter: args.get('feature') ?? null,
    includeNoindex: args.has('include-noindex'),
    failOnOffenders: args.has('fail-on-offenders'),
    baselinePath: typeof args.get('baseline') === 'string' ? args.get('baseline') : null,
    writeBaselinePath: typeof args.get('write-baseline') === 'string' ? args.get('write-baseline') : null,
  };
  const MODE_JSON = args.has('json');
  const MODE_CSV = args.has('csv');

  const s = await stat(DEFAULT_DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`audit-text-html-ratio: dist/ not found at ${DEFAULT_DIST}. Run a build first.`);
    process.exit(2);
  }

  const a = createAuditor(opts);
  const files = await walkHtmlFiles(DEFAULT_DIST);
  for (const file of files) {
    let html;
    try { html = await readFile(file, 'utf8'); }
    catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    a.collect(file, html);
  }

  const result = await a.report();
  await writeAuditReport({
    audit: a.name,
    passed: result.passed,
    threshold: result.threshold ?? null,
    baselineFile: result.baselineFile ?? null,
    baselineDelta: result.baselineDelta ?? null,
    offenders: result.offenders ?? [],
    byFeature: result.byFeature,
  });

  const samples = result.extra.rawSamples;
  const offenders = samples.filter((r) => r.ratio <= opts.threshold).sort((a, b) => a.ratio - b.ratio);

  if (MODE_CSV) {
    console.log('file,feature,html_bytes,text_bytes,ratio_pct');
    for (const r of offenders) {
      console.log(`${r.file},${r.feature},${r.htmlBytes},${r.textBytes},${r.ratio.toFixed(2)}`);
    }
    process.exit(result.passed ? 0 : 1);
  }
  if (MODE_JSON) {
    const byFeatureWithAvg = {};
    for (const r of offenders) {
      byFeatureWithAvg[r.feature] ??= { count: 0, avgRatio: 0 };
      byFeatureWithAvg[r.feature].count++;
      byFeatureWithAvg[r.feature].avgRatio += r.ratio;
    }
    for (const k of Object.keys(byFeatureWithAvg)) {
      byFeatureWithAvg[k].avgRatio = +(byFeatureWithAvg[k].avgRatio / byFeatureWithAvg[k].count).toFixed(2);
    }
    console.log(JSON.stringify({
      scanned: result.extra.scanned,
      threshold: opts.threshold,
      offenders: offenders.length,
      byFeature: byFeatureWithAvg,
      worst: offenders.slice(0, opts.limit),
    }, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  console.log(`audit-text-html-ratio: scanned ${result.extra.scanned} HTML files in dist/ (skipped ${result.extra.skippedNoindex} noindex/redirect pages)`);
  console.log(`Threshold (Semrush "low text/HTML"): ratio ≤ ${opts.threshold} %`);
  console.log(`Offenders: ${offenders.length} (${((offenders.length / Math.max(result.extra.scanned, 1)) * 100).toFixed(1)} % of scanned)`);

  if (Object.keys(result.byFeature).length > 0) {
    console.log('\nOffenders by feature:');
    const offendersByFeatStats = new Map();
    for (const r of offenders) {
      const cur = offendersByFeatStats.get(r.feature) ?? { count: 0, sumRatio: 0 };
      cur.count++;
      cur.sumRatio += r.ratio;
      offendersByFeatStats.set(r.feature, cur);
    }
    const rows = [...offendersByFeatStats.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [feature, { count, sumRatio }] of rows) {
      console.log(`  ${String(count).padStart(6)}  ${(sumRatio / count).toFixed(2).padStart(5)} %  ${feature}`);
    }
  }

  if (offenders.length > 0) {
    console.log(`\nWorst ${Math.min(opts.limit, offenders.length)} offenders:`);
    for (const r of offenders.slice(0, opts.limit)) {
      console.log(`  ${r.ratio.toFixed(2).padStart(5)} %  ${(r.htmlBytes / 1024).toFixed(1).padStart(6)} KB  ${r.file}`);
    }
  }

  if (opts.writeBaselinePath) console.log(`\n→ wrote baseline to ${opts.writeBaselinePath}`);

  if (!result.passed && opts.baselinePath) {
    const regr = result.extra.regressedFeatures ?? [];
    const baseTotal = result.baselineDelta?.before ?? 0;
    console.error('\n══════════════════════════════════════════════════════════════════════');
    console.error('FAIL: Semrush "low text-to-HTML ratio" gate REGRESSED');
    console.error('══════════════════════════════════════════════════════════════════════');
    if (result.offendersTotal > baseTotal) {
      console.error(`  Total offenders: ${result.offendersTotal} (baseline allows ${baseTotal})`);
    }
    for (const f of regr) {
      console.error(`  Feature "${f.feature}": ${f.count} offenders (baseline allows ${f.max})`);
    }
    for (const f of regr) {
      const featOffenders = offenders
        .filter((o) => o.feature === f.feature)
        .sort((a, b) => a.ratio - b.ratio);
      console.error(`\nFull offender list for feature "${f.feature}" (${f.count} pages, baseline ${f.max}, +${f.count - f.max}):`);
      for (const o of featOffenders) {
        console.error(`  ${o.ratio.toFixed(2).padStart(6)} %  ${(o.htmlBytes / 1024).toFixed(1).padStart(7)} KB  ${o.file}`);
      }
    }
    console.error('\nThe baseline ratchet only allows the count to go DOWN.');
    console.error('Fix the offending templates, then regenerate with --write-baseline=<path>.');
  } else if (opts.baselinePath) {
    const baseTotal = result.baselineDelta?.before ?? 0;
    const delta = baseTotal - result.offendersTotal;
    console.log(`\nratchet OK: ${result.offendersTotal} offenders ≤ baseline ${baseTotal} (${delta >= 0 ? '−' : '+'}${Math.abs(delta)})`);
  }

  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('audit-text-html-ratio crashed:', err);
    process.exit(2);
  });
}
