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
import { EJP_STRIPPED_MARKER } from '../build-plugins/shared/ejpMarker.mjs';
import { JOB_BOARD_SECTION_RX } from './lib/jobBoardSections.mjs';
import { EVENTS_SECTION_RX } from './lib/eventsSections.mjs';
import { FUEL_SECTION_RX } from './lib/fuelSections.mjs';
import { BLOG_SECTION_RX } from './lib/articleSections.mjs';

const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));

// Quote-flexible — PR #478 baked removeAttributeQuotes upstream.
const NOINDEX_RE = /<meta[^>]+name=["']?robots["']?[^>]+content=["']?[^"'>]*noindex/i;
const META_REFRESH_RE = /<meta[^>]+http-equiv=["']?refresh["']?(?=[\s/>])/i;

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
  if (FUEL_SECTION_RX.test(p)) return 'fuel-daily';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\/[^/]+\/[^/]+\//.test(p)) return 'weekly-employers';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\//.test(p)) return 'weekly-employers-hub';
  // Canton-aware job-board sections (TI legacy, every canton, + svizzera
  // aggregator) → shared matcher. See scripts/lib/jobBoardSections.mjs.
  if (JOB_BOARD_SECTION_RX.test(p)) return 'job-board';
  if (/(?:^|\/)(?:premi-cassa-malati|health-insurance-premiums|health-premiums|krankenkassenpraemien|krankenkassen-praemien|primes-assurance-maladie|primes-assurance-maladie-communes|primi-cassa-malati-comuni)\//.test(p)) return 'health-premiums';
  if (/(?:^|\/)(?:mercato-lavoro-ticino|ticino-job-market|tessiner-arbeitsmarkt|tessin-arbeitsmarkt|marche-travail-tessin|tessin-marche-emploi|mercato-lavoro|job-market|arbeitsmarkt|marche-emploi)\//.test(p)) return 'job-market-snapshot';
  if (BLOG_SECTION_RX.test(p) || /(?:^|\/)(?:blog|articles)\//.test(p)) return 'blog';
  if (/(?:^|\/)(?:traffico-dogane|border-wait|wartezeit-grenze|temps-attente-douane|tempi-attesa-frontiera|border-wait-times|grenzwartezeiten|temps-attente-frontiere)\//.test(p)) return 'border-wait';
  if (/(?:^|\/)(?:meteo-frontalieri|commute-weather|pendler-wetter|meteo-frontaliers|allerte-meteo|weather-alerts|wetter-warnungen|alertes-meteo)\//.test(p)) return 'weather';
  // Canton-aware events hub + per-comune pages (all 4 locale section slugs,
  // every canton — shared matcher, scripts/lib/eventsSections.mjs). These
  // are inherently markup-heavy (event cards + Event JSON-LD + maps) with a
  // low text-to-HTML ratio, exactly like border-wait/fuel-daily/weather.
  // Give them their own ratchet bucket so they don't pollute the
  // spa-locale/spa-other catch-all. Was TI-only, which leaked non-TI canton
  // events pages into spa-locale/spa-other once nationwide event sourcing
  // shipped (#3125/#3243), causing the #3232 regression (same
  // classifier-drift class as #2853/#2910 fuel/svizzera leaks).
  if (EVENTS_SECTION_RX.test(p)) return 'eventi';
  if (/^\/(en|de|fr)\//.test(p)) return 'spa-locale';
  return 'spa-other';
}

export function createAuditor(opts = {}) {
  const threshold = opts.threshold ?? 10; // percent — hard fail floor (Semrush gate)
  // Soft warn band (threshold, warnThreshold]. Pages here pass today but are
  // within 2 pp of the floor; one cron content refresh can push them under.
  // Surfaced in `extra.nearFloor` so reviewers see drift before it becomes a
  // hard-fail regression.
  const warnThreshold = opts.warnThreshold ?? 12;
  const limit = opts.limit ?? 30;
  const featureFilter = opts.featureFilter ?? null;
  const includeNoindex = !!opts.includeNoindex;
  const failOnOffenders = !!opts.failOnOffenders;
  const baselinePath = opts.baselinePath ?? null;
  const writeBaselinePath = opts.writeBaselinePath ?? null;

  const samples = [];
  const ejpSamples = [];
  let skippedNoindex = 0;
  let skippedEjpStripped = 0;

  return {
    name: 'text-html-ratio',
    collect(file, html) {
      if (!html) return;
      const htmlBytes = Buffer.byteLength(html, 'utf8');
      if (htmlBytes === 0) return;
      // Expired-job / active-job / bridge pages whose SEO prose was
      // deliberately stripped via STRIP_EXPIRED_JOB_PROSE /
      // STRIP_ACTIVE_JOB_PROSE / STRIP_BRIDGE_PAGE_PROSE carry this marker.
      // The low text/HTML ratio is by design (dist size reduction for the
      // GitHub Pages 10 GB cap), so skip them. Marker is UPPERCASE so it
      // survives the HTML minifier's comment-strip pass (which only
      // preserves <!--[A-Z][A-Z0-9_]*-->); accept the legacy lowercase
      // form as well for backward compat with un-minified test fixtures.
      if (html.includes(EJP_STRIPPED_MARKER) || html.includes('<!--ejp-stripped-->')) {
        skippedEjpStripped++;
        // Drift visibility: marked shells are excluded from the offender
        // ratchet by design, so they never enter `samples` — which left them
        // invisible to the nearFloor band (the prior "keep nearFloor
        // un-suppressed" mitigation was a no-op because skipped pages never
        // reach sampling). The index,follow ones stay in Google's index, so a
        // silent further shrink (prose-helper/template regression) must still
        // be seen. Sample their ratio into a separate, non-blocking band.
        // noindex/redirect marked pages are out of the index → no SEO drift.
        if (includeNoindex || !(NOINDEX_RE.test(html) || META_REFRESH_RE.test(html))) {
          const textBytes = Buffer.byteLength(extractVisibleText(html), 'utf8');
          const rel = relative(ROOT, file);
          ejpSamples.push({
            file: rel,
            feature: classifyFeature(rel),
            htmlBytes,
            textBytes,
            ratio: (textBytes / htmlBytes) * 100,
          });
        }
        return;
      }
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
      // Per-feature SCANNED denominators (all sampled pages, not just
      // offenders) — required for the rate-based ratchet so organic content
      // growth (more pages of the same template, same per-page quality) does
      // NOT trip the gate. Only a genuine per-template quality regression
      // raises the offender RATE.
      const scannedByFeature = {};
      for (const r of samples) scannedByFeature[r.feature] = (scannedByFeature[r.feature] ?? 0) + 1;
      const rateByFeature = {};
      for (const f of Object.keys(scannedByFeature)) {
        rateByFeature[f] = (byFeature[f] ?? 0) / scannedByFeature[f] * 100;
      }
      const totalRatePct = samples.length ? (offenders.length / samples.length) * 100 : 0;
      // maxDeltaPp caps the relative term so a high-base feature can't earn
      // unbounded absolute slack (a 12%-rate feature would otherwise tolerate
      // +2.4pp from relPct alone before the cap bites).
      const DEFAULT_TOL = { relPct: 20, absPp: 1.0, minAbsDelta: 5, maxDeltaPp: 3 };

      if (writeBaselinePath) {
        const byFeatureRate = {};
        for (const f of Object.keys(scannedByFeature)) {
          byFeatureRate[f] = {
            scanned: scannedByFeature[f],
            offenders: byFeature[f] ?? 0,
            ratePct: Number(rateByFeature[f].toFixed(4)),
          };
        }
        const baseline = {
          generated: new Date().toISOString(),
          mode: 'rate',
          threshold,
          tolerance: DEFAULT_TOL,
          scanned: samples.length,
          totalOffenders: offenders.length,
          totalRatePct: Number(totalRatePct.toFixed(4)),
          byFeature: byFeatureRate,
          _comment: `Rate-based baseline for audit-text-html-ratio (page ratio ≤ ${threshold}%). The per-page threshold is the hard quality gate; this ratchet tracks the offender RATE (offenders/scanned) per feature so organic content growth does not regress the build. A feature fails only when its rate exceeds baseRate*(1+relPct/100)+absPp AND its absolute offender count grows by more than minAbsDelta. Rates must only DECREASE going forward (modulo tolerance).`,
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
            extra: { scanned: samples.length, skippedNoindex, skippedEjpStripped, baselineError: err.message },
            humanSummary: `cannot read baseline ${baselinePath}: ${err.message}`,
          };
        }
        if (baseline.mode === 'rate') {
          const tol = { ...DEFAULT_TOL, ...(baseline.tolerance ?? {}) };
          const baseByFeature = baseline.byFeature ?? {};
          for (const f of Object.keys(scannedByFeature)) {
            const curOff = byFeature[f] ?? 0;
            const curRate = rateByFeature[f];
            const base = baseByFeature[f];
            const baseRate = base ? Number(base.ratePct ?? 0) : 0;
            const baseOff = base ? Number(base.offenders ?? 0) : 0;
            const rateCap = baseRate + Math.min(baseRate * tol.relPct / 100, tol.maxDeltaPp) + tol.absPp;
            // Denominator-shrink (fewer pages scanned) is INTENTIONALLY not gated,
            // same as the orphan-pages / bfs-depth gates: if `scanned` drops while
            // the offender count stays flat, curRate spikes from the smaller
            // denominator, but the count floor (`curOff > baseOff + minAbsDelta`)
            // stays false → pass. A pure shrink adds NO new low-text page; the harm
            // metric is the absolute offender count, unchanged. The count floor is
            // denominator-independent, so every real regression above the noise
            // floor still fires regardless of how `scanned` moved. Gating a bare
            // rate spike from contraction would deploy-block legitimate content
            // pruning — a new organic false-fail (class #1604). (#1605 item #3.)
            if (curRate > rateCap && curOff > baseOff + tol.minAbsDelta) {
              regressedFeatures.push({ feature: f, count: curOff, max: baseOff, rate: Number(curRate.toFixed(3)), maxRate: Number(rateCap.toFixed(3)), scanned: scannedByFeature[f] });
            }
          }
          const baseTotalRate = Number(baseline.totalRatePct ?? 0);
          const baseTotalOff = Number(baseline.totalOffenders ?? 0);
          const totalCap = baseTotalRate + Math.min(baseTotalRate * tol.relPct / 100, tol.maxDeltaPp) + tol.absPp;
          const totalRegression = totalRatePct > totalCap && offenders.length > baseTotalOff + tol.minAbsDelta;
          baselineDelta = { before: baseTotalOff, after: offenders.length, beforeRate: baseTotalRate, afterRate: Number(totalRatePct.toFixed(3)), regression: Math.max(0, offenders.length - baseTotalOff) };
          if (totalRegression || regressedFeatures.length > 0) passed = false;
        } else {
          // Legacy absolute-count baseline (pre rate-ratchet). Kept so the
          // script still runs against an un-migrated baseline file.
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
      }

      const structuredOffenders = offenders.map((r) => ({
        path: r.file,
        feature: r.feature,
        metric: Number(r.ratio.toFixed(2)),
        ratio: Number(r.ratio.toFixed(2)),
        htmlBytes: r.htmlBytes,
        textBytes: r.textBytes,
      }));

      // Near-floor band: pages that pass the hard gate but sit in the
      // (threshold, warnThreshold] zone. Treated as an early-warning signal,
      // never blocks the build.
      const nearFloorSamples = samples
        .filter((r) => r.ratio > threshold && r.ratio <= warnThreshold)
        .sort((a, b) => a.ratio - b.ratio);
      const nearFloorByFeature = {};
      for (const r of nearFloorSamples) {
        nearFloorByFeature[r.feature] = (nearFloorByFeature[r.feature] ?? 0) + 1;
      }
      const nearFloor = {
        warnThreshold,
        total: nearFloorSamples.length,
        byFeature: nearFloorByFeature,
        top: nearFloorSamples.slice(0, limit).map((r) => ({
          path: r.file,
          feature: r.feature,
          ratio: Number(r.ratio.toFixed(2)),
          htmlBytes: r.htmlBytes,
          textBytes: r.textBytes,
        })),
      };

      // Drift band for EJP-marked index,follow shells. They are excluded from
      // the offender ratchet by design (intentionally thin), so they never
      // enter `samples` and the nearFloor band can't see them. This band
      // restores that visibility WITHOUT gating — it surfaces the marked
      // shells' ratios (lowest first) so a silent regression on indexed thin
      // pages is caught before Google does. Never affects `passed`.
      const ejpDriftSorted = [...ejpSamples].sort((a, b) => a.ratio - b.ratio);
      const ejpDriftByFeature = {};
      for (const r of ejpSamples) {
        ejpDriftByFeature[r.feature] = (ejpDriftByFeature[r.feature] ?? 0) + 1;
      }
      const ejpDrift = {
        total: ejpSamples.length,
        byFeature: ejpDriftByFeature,
        lowest: ejpDriftSorted.slice(0, limit).map((r) => ({
          path: r.file,
          feature: r.feature,
          ratio: Number(r.ratio.toFixed(2)),
          htmlBytes: r.htmlBytes,
          textBytes: r.textBytes,
        })),
      };

      const humanSummary = passed
        ? `${offenders.length} offender(s) within baseline (threshold ${threshold} %), ${nearFloor.total} page(s) in near-floor band (${threshold}-${warnThreshold} %), ${ejpDrift.total} EJP-marked index,follow shell(s) tracked for drift`
        : `${offenders.length} offender(s) ≤ ${threshold} % — regressed features: ${regressedFeatures.map(r => r.rate != null ? `${r.feature}(${r.rate}% > ${r.maxRate}% allowed, ${r.count} vs ${r.max})` : `${r.feature}(${r.count}>${r.max})`).join(', ') || 'total rate cap exceeded'}`;

      return {
        passed,
        offendersTotal: offenders.length,
        offenders: structuredOffenders,
        threshold: { metric: 'ratio', value: threshold, comparator: '>=' },
        baselineFile: relBaseline(baselinePath),
        baselineDelta,
        byFeature,
        extra: { scanned: samples.length, skippedNoindex, skippedEjpStripped, regressedFeatures, scannedByFeature, rateByFeature, totalRatePct: Number(totalRatePct.toFixed(4)), limit, threshold, warnThreshold, nearFloor, ejpDrift, rawSamples: samples },
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
      console.error(`  Total offenders: ${result.offendersTotal} (baseline ${baseTotal})`);
    }
    for (const f of regr) {
      if (f.rate != null) {
        console.error(`  Feature "${f.feature}": rate ${f.rate}% (allowed ≤ ${f.maxRate}%) — ${f.count} offenders / ${f.scanned} scanned vs baseline ${f.max}`);
      } else {
        console.error(`  Feature "${f.feature}": ${f.count} offenders (baseline allows ${f.max})`);
      }
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
    console.error('\nThe rate ratchet trips only when the offender RATE rises beyond');
    console.error('tolerance AND the offender count grows meaningfully — i.e. a real');
    console.error('per-template quality regression, not organic content growth.');
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
