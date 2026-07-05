#!/usr/bin/env node
/**
 * audit-h1-title-duplicates
 *
 * Walks `dist/**\/*.html` and flags pages whose <title> equals their first
 * <h1>. Mirrors the Semrush Site Audit rule "Duplicate H1 and title tags".
 *
 * Comparison is case-insensitive and whitespace-normalized. Pages without a
 * <title> or <h1> are not offenders — tracked separately as `missing-title`
 * / `missing-h1`. Pages with `<meta name="robots" content="noindex">` or a
 * meta-refresh redirect are skipped by default (Semrush doesn't flag them).
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-h1-title-duplicates.mjs [...]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { writeAuditReport, relBaseline } from './lib/auditReport.mjs';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { classifyFeature, inferLocale } from './audit-title-length.mjs';
import { evaluateMixAdjustedTotalRegression } from './lib/mixAdjustedRateGate.mjs';

const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));

// Quote-flexible — PR #478 baked removeAttributeQuotes upstream.
const NOINDEX_RE = /<meta[^>]+name=["']?robots["']?[^>]+content=["']?[^"'>]*noindex/i;
const META_REFRESH_RE = /<meta[^>]+http-equiv=["']?refresh["']?(?=[\s/>])/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;

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

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 30;
  const featureFilter = opts.featureFilter ?? null;
  const includeNoindex = !!opts.includeNoindex;
  const failOnOffenders = !!opts.failOnOffenders;
  const baselinePath = opts.baselinePath ?? null;
  const writeBaselinePath = opts.writeBaselinePath ?? null;

  let scanned = 0;
  const scannedByFeature = {};
  let skippedNoindex = 0;
  let missingTitle = 0;
  let missingH1 = 0;
  const offenders = [];

  return {
    name: 'h1-title-duplicates',
    collect(file, html) {
      if (!html) return;
      if (!includeNoindex && (NOINDEX_RE.test(html) || META_REFRESH_RE.test(html))) {
        skippedNoindex++;
        return;
      }
      const rel = relative(ROOT, file);
      const feature = classifyFeature(rel);
      scanned++;
      scannedByFeature[feature] = (scannedByFeature[feature] ?? 0) + 1;
      const titleMatch = html.match(TITLE_RE);
      const h1Match = html.match(H1_RE);
      const title = normalizeText(titleMatch?.[1] ?? '');
      const h1 = normalizeText(h1Match?.[1] ?? '');
      if (!title) { missingTitle++; return; }
      if (!h1) { missingH1++; return; }
      if (title.toLowerCase() !== h1.toLowerCase()) return;
      if (featureFilter && feature !== featureFilter) return;
      const locale = inferLocale(rel);
      offenders.push({ path: rel, file: rel, feature, locale, title, h1, metric: 1 });
    },
    async report() {
      const byFeature = {};
      const byLocale = {};
      for (const o of offenders) {
        byFeature[o.feature] = (byFeature[o.feature] ?? 0) + 1;
        byLocale[o.locale] = (byLocale[o.locale] ?? 0) + 1;
      }
      // Rate ratchet (mirrors audit-title-length.mjs / mixAdjustedRateGate.mjs)
      // so organic page-count growth at a flat per-template duplicate rate
      // does not trip the gate — only a genuine per-template quality
      // regression (rising rate) does.
      const rateByFeature = {};
      for (const f of Object.keys(scannedByFeature)) {
        rateByFeature[f] = (byFeature[f] ?? 0) / scannedByFeature[f] * 100;
      }
      const totalRatePct = scanned ? (offenders.length / scanned) * 100 : 0;
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
          tolerance: DEFAULT_TOL,
          scanned,
          totalOffenders: offenders.length,
          totalRatePct: Number(totalRatePct.toFixed(4)),
          byFeature: byFeatureRate,
          byLocale,
          _comment: 'Rate-based baseline for audit-h1-title-duplicates (title === h1). Tracks the offender RATE (offenders/scanned) per feature so organic page growth does not regress the build. A feature fails only when its rate exceeds baseRate*(1+relPct/100)+absPp AND its absolute offender count grows by more than minAbsDelta. Rates must only DECREASE going forward (modulo tolerance).',
        };
        await writeFile(resolvePath(writeBaselinePath), JSON.stringify(baseline, null, 2) + '\n', 'utf8');
      }

      let passed = !(failOnOffenders && offenders.length > 0);
      let baselineDelta = null;
      let totalCapInfo = null;
      const regressedFeatures = [];

      if (baselinePath) {
        let baseline;
        try { baseline = JSON.parse(await readFile(resolvePath(baselinePath), 'utf8')); }
        catch (err) {
          return {
            passed: false,
            offendersTotal: offenders.length,
            offenders,
            threshold: { metric: 'count', value: 0, comparator: '<=baseline' },
            extra: { scanned, skippedNoindex, missingTitle, missingH1, byLocale, baselineError: err.message },
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
            if (curRate > rateCap && curOff > baseOff + tol.minAbsDelta) {
              regressedFeatures.push({ feature: f, feat: f, count: curOff, max: baseOff, cap: baseOff, rate: Number(curRate.toFixed(3)), maxRate: Number(rateCap.toFixed(3)), scanned: scannedByFeature[f] });
            }
          }
          const baseTotalRate = Number(baseline.totalRatePct ?? 0);
          const baseTotalOff = Number(baseline.totalOffenders ?? 0);
          const {
            expectedOffenders, expectedTotalRate, totalCap, regression: totalRegression,
          } = evaluateMixAdjustedTotalRegression({
            scannedByFeature, baseByFeature, tol,
            actualOffenders: offenders.length, actualScanned: scanned,
          });
          baselineDelta = {
            before: baseTotalOff, after: offenders.length,
            beforeRate: baseTotalRate, afterRate: Number(totalRatePct.toFixed(3)),
            expectedRate: Number(expectedTotalRate.toFixed(3)), expectedOffenders: Number(expectedOffenders.toFixed(2)),
            regression: Math.max(0, offenders.length - Math.round(expectedOffenders)),
          };
          totalCapInfo = { actual: Number(totalRatePct.toFixed(3)), expected: Number(expectedTotalRate.toFixed(3)), cap: Number(totalCap.toFixed(3)) };
          if (totalRegression || regressedFeatures.length > 0) passed = false;
        } else {
          // Legacy absolute-count baseline (pre rate-ratchet). Kept so the
          // script still runs against an un-migrated baseline file.
          const baseTotal = Number(baseline.total ?? 0);
          let totalRegression = typeof baseline.total === 'number' && offenders.length > baseTotal;
          if (baseline.byFeature && typeof baseline.byFeature === 'object') {
            for (const [feat, count] of Object.entries(byFeature)) {
              const cap = baseline.byFeature[feat] ?? 0;
              if (count > cap) {
                regressedFeatures.push({ feat, feature: feat, cap, max: cap, count });
                totalRegression = true;
              }
            }
          }
          baselineDelta = {
            before: baseTotal,
            after: offenders.length,
            regression: Math.max(0, offenders.length - baseTotal),
          };
          if (totalRegression) passed = false;
        }
      }

      const humanSummary = passed
        ? `${offenders.length} duplicate(s) within baseline`
        : `${offenders.length} title=h1 duplicate(s)${regressedFeatures.length > 0 ? ` — regressed features: ${regressedFeatures.map(r => r.rate != null ? `${r.feat}(${r.rate}% > ${r.maxRate}% allowed, ${r.count} vs ${r.max})` : `${r.feat}(${r.count}>${r.cap})`).join(', ')}` : (totalCapInfo ? ` — total rate cap exceeded (actual ${totalCapInfo.actual}% > mix-adjusted expected ${totalCapInfo.expected}% + tolerance = ${totalCapInfo.cap}%)` : '')}`;

      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'count', value: 0, comparator: '<=baseline' },
        baselineFile: relBaseline(baselinePath),
        baselineDelta,
        byFeature,
        extra: { scanned, skippedNoindex, missingTitle, missingH1, byLocale, regressedFeatures, scannedByFeature, rateByFeature, totalRatePct: Number(totalRatePct.toFixed(4)), limit },
        humanSummary,
      };
    },
  };
}

export function factory(opts) {
  return createAuditor({
    baselinePath: 'data/h1-title-duplicates-baseline.json',
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
    console.error(`audit-h1-title-duplicates: dist/ not found at ${DEFAULT_DIST}. Run a build first.`);
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
    extra: { byLocale: result.extra.byLocale },
  });

  if (MODE_CSV) {
    console.log('file,feature,locale,title');
    for (const r of result.offenders) {
      const safe = (s) => `"${String(s).replace(/"/g, '""')}"`;
      console.log(`${r.file},${r.feature},${r.locale},${safe(r.title)}`);
    }
    process.exit(result.passed ? 0 : 1);
  }
  if (MODE_JSON) {
    console.log(JSON.stringify({
      scanned: result.extra.scanned,
      skippedNoindex: result.extra.skippedNoindex,
      missingTitle: result.extra.missingTitle,
      missingH1: result.extra.missingH1,
      offenders: result.offendersTotal,
      byFeature: result.byFeature,
      byLocale: result.extra.byLocale,
      worst: result.offenders.slice(0, opts.limit),
    }, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  console.log(`audit-h1-title-duplicates: scanned ${result.extra.scanned} HTML files in dist/ (skipped ${result.extra.skippedNoindex} noindex/redirect, ${result.extra.missingTitle} missing <title>, ${result.extra.missingH1} missing <h1>)`);
  console.log(`Offenders (title === h1, case+whitespace-insensitive): ${result.offendersTotal} (${((result.offendersTotal / Math.max(result.extra.scanned, 1)) * 100).toFixed(1)} % of scanned)`);

  if (Object.keys(result.byFeature).length > 0) {
    console.log('\nOffenders by feature:');
    for (const [f, c] of Object.entries(result.byFeature).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(6)}  ${f}`);
    }
  }
  if (Object.keys(result.extra.byLocale).length > 0) {
    console.log('\nOffenders by locale:');
    for (const [l, c] of Object.entries(result.extra.byLocale).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(6)}  ${l}`);
    }
  }
  if (result.offendersTotal > 0) {
    console.log(`\nFirst ${Math.min(opts.limit, result.offendersTotal)} offenders:`);
    for (const r of result.offenders.slice(0, opts.limit)) {
      console.log(`  [${r.locale}] ${r.feature.padEnd(22)}  ${r.file}`);
      console.log(`        title=h1=${JSON.stringify(r.title.slice(0, 120))}`);
    }
  }

  if (opts.writeBaselinePath) console.log(`\nWrote baseline → ${opts.writeBaselinePath}`);

  if (!result.passed && result.extra.regressedFeatures?.length > 0) {
    for (const { feat, cap, count, rate, maxRate, scanned: featScanned } of result.extra.regressedFeatures) {
      const featOffenders = result.offenders
        .filter((o) => o.feature === feat)
        .sort((a, b) => a.file.localeCompare(b.file));
      if (rate != null) {
        console.error(`\nFeature "${feat}": rate ${rate}% (allowed ≤ ${maxRate}%) — ${count} offenders / ${featScanned} scanned vs baseline ${cap}`);
      } else {
        console.error(`\nFull offender list for feature "${feat}" (${count} pages, baseline ${cap}, +${count - cap}):`);
      }
      for (const o of featOffenders) {
        console.error(`  [${o.locale}]  ${o.file}`);
        console.error(`        title: ${o.title}`);
        console.error(`        h1:    ${o.h1}`);
      }
    }
    console.error('\nThe rate ratchet trips only when the offender RATE rises beyond tolerance');
    console.error('AND the offender count grows meaningfully — i.e. a real per-template');
    console.error('quality regression, not organic content growth.');
    console.error('Fix the new offenders, then regenerate with --write-baseline=<path>.');
  } else if (opts.baselinePath && result.passed) {
    console.log(`\nBaseline ratchet: OK (no regressions vs ${opts.baselinePath})`);
  }

  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('audit-h1-title-duplicates: fatal', err);
    process.exit(2);
  });
}
