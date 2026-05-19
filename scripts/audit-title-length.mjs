#!/usr/bin/env node
/**
 * audit-title-length.mjs
 *
 * Walks `dist/**\/*.html` and reports pages whose `<title>` exceeds the
 * SERP-display budget (default 60 char + 10 % tolerance = 66).
 *
 * Why the gate exists. After the universal "never truncate <title>" fix
 * (commit a7eab849d), pages with a long disambiguator (city, canton,
 * address, age bracket) now overflow Google's SERP-display budget. This is
 * the intentional trade-off: uniqueness > SERP length. But we still want
 * to *track* the long-titles bucket so a future template change that
 * inflates titles further doesn't go unnoticed.
 *
 * Two execution modes:
 *   1. Standalone CLI:   node scripts/audit-title-length.mjs [...args]
 *   2. Unified runner:   imported by scripts/audit-all.mjs via factory().
 *
 * CLI args (standalone only):
 *   --threshold=N             char limit (default 66)
 *   --limit=N                 show top N offenders (default 30)
 *   --feature=<name>          filter to one feature bucket
 *   --json                    JSON output
 *   --csv                     CSV output
 *   --fail-on-offenders       exit 1 on any offender (overrides baseline)
 *   --include-noindex         count noindex/redirect pages
 *   --baseline=<path>         ratchet against baseline (fail on regression)
 *   --write-baseline=<path>   regenerate baseline snapshot
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAuditReport, relBaseline } from './lib/auditReport.mjs';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';

const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));

const NOINDEX_RE = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i;
const META_REFRESH_RE = /<meta[^>]+http-equiv=["']refresh["']/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

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
export function classifyFeature(relPath) {
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

export function inferLocale(relPath) {
  const seg = relPath.replace(/\\/g, '/').replace(/^dist\//, '').split('/')[0];
  if (seg === 'en' || seg === 'de' || seg === 'fr') return seg;
  return 'it';
}

/**
 * Factory: returns a fresh stateful Auditor closure.
 *
 * @param {{
 *   threshold?: number,
 *   limit?: number,
 *   featureFilter?: string|null,
 *   includeNoindex?: boolean,
 *   failOnOffenders?: boolean,
 *   baselinePath?: string|null,
 *   writeBaselinePath?: string|null,
 * }} [opts]
 */
export function createAuditor(opts = {}) {
  const threshold = opts.threshold ?? 66;
  const limit = opts.limit ?? 30;
  const featureFilter = opts.featureFilter ?? null;
  const includeNoindex = !!opts.includeNoindex;
  const failOnOffenders = !!opts.failOnOffenders;
  const baselinePath = opts.baselinePath ?? null;
  const writeBaselinePath = opts.writeBaselinePath ?? null;

  let scanned = 0;
  let skippedNoindex = 0;
  let missingTitle = 0;
  const offenders = [];

  return {
    name: 'title-length',
    collect(file, html) {
      if (!html) return;
      if (!includeNoindex && (NOINDEX_RE.test(html) || META_REFRESH_RE.test(html))) {
        skippedNoindex++;
        return;
      }
      scanned++;
      const titleMatch = html.match(TITLE_RE);
      const title = normalizeText(titleMatch?.[1] ?? '');
      if (!title) { missingTitle++; return; }
      if (title.length <= threshold) return;
      const rel = relative(ROOT, file);
      const feature = classifyFeature(rel);
      if (featureFilter && feature !== featureFilter) return;
      const locale = inferLocale(rel);
      offenders.push({ path: rel, file: rel, feature, locale, title, metric: title.length });
    },
    async report() {
      offenders.sort((a, b) => b.metric - a.metric);

      const byFeature = {};
      const byLocale = {};
      for (const o of offenders) {
        byFeature[o.feature] = (byFeature[o.feature] ?? 0) + 1;
        byLocale[o.locale] = (byLocale[o.locale] ?? 0) + 1;
      }

      // Write baseline snapshot if requested
      if (writeBaselinePath) {
        const baseline = {
          generated: new Date().toISOString(),
          threshold,
          total: offenders.length,
          byFeature,
          byLocale,
        };
        await writeFile(resolvePath(writeBaselinePath), JSON.stringify(baseline, null, 2) + '\n', 'utf8');
      }

      let passed = !(failOnOffenders && offenders.length > 0);
      let baselineDelta = null;
      const regressedFeatures = [];

      // Baseline ratchet check
      if (baselinePath) {
        let baseline;
        try { baseline = JSON.parse(await readFile(resolvePath(baselinePath), 'utf8')); }
        catch (err) {
          return {
            passed: false,
            offendersTotal: offenders.length,
            offenders,
            threshold: { metric: 'length', value: threshold, comparator: '<=' },
            extra: { scanned, skippedNoindex, missingTitle, byLocale, baselineError: err.message },
            humanSummary: `cannot read baseline ${baselinePath}: ${err.message}`,
          };
        }
        let regression = false;
        const baseTotal = Number(baseline.total ?? 0);
        if (typeof baseline.total === 'number' && offenders.length > baseline.total) {
          regression = true;
        }
        if (baseline.byFeature && typeof baseline.byFeature === 'object') {
          for (const [feat, count] of Object.entries(byFeature)) {
            const cap = baseline.byFeature[feat] ?? 0;
            if (count > cap) {
              regressedFeatures.push({ feat, cap, count });
              regression = true;
            }
          }
        }
        baselineDelta = {
          before: baseTotal,
          after: offenders.length,
          regression: Math.max(0, offenders.length - baseTotal),
        };
        if (regression) passed = false;
      }

      const humanSummary =
        passed
          ? `${offenders.length} offender(s) within baseline (threshold ${threshold})`
          : `${offenders.length} offender(s) over threshold ${threshold}${regressedFeatures.length > 0 ? ` — regressed features: ${regressedFeatures.map(r => `${r.feat}(${r.count}>${r.cap})`).join(', ')}` : ''}`;

      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'length', value: threshold, comparator: '<=' },
        baselineFile: relBaseline(baselinePath),
        baselineDelta,
        byFeature,
        extra: { scanned, skippedNoindex, missingTitle, byLocale, regressedFeatures, limit, threshold },
        humanSummary,
      };
    },
  };
}

// Factory export for runner registration. Default opts match the npm script
// `audit:title-length`: --threshold=66 --baseline=data/title-length-baseline.json
export function factory(opts) {
  return createAuditor({
    threshold: 66,
    baselinePath: 'data/title-length-baseline.json',
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
    threshold: Number(args.get('threshold') ?? 66),
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
    console.error(`audit-title-length: dist/ not found at ${DEFAULT_DIST}. Run a build first.`);
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

  // Output formats
  if (MODE_CSV) {
    console.log('file,feature,locale,length,title');
    for (const r of result.offenders) {
      const safe = (s) => `"${String(s).replace(/"/g, '""')}"`;
      console.log(`${r.file},${r.feature},${r.locale},${r.metric},${safe(r.title)}`);
    }
    process.exit(result.passed ? 0 : 1);
  }
  if (MODE_JSON) {
    console.log(JSON.stringify({
      scanned: result.extra.scanned,
      skippedNoindex: result.extra.skippedNoindex,
      missingTitle: result.extra.missingTitle,
      threshold: result.extra.threshold,
      offenders: result.offendersTotal,
      byFeature: result.byFeature,
      byLocale: result.extra.byLocale,
      worst: result.offenders.slice(0, opts.limit),
    }, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  console.log(`audit-title-length: scanned ${result.extra.scanned} HTML files in dist/ (skipped ${result.extra.skippedNoindex} noindex/redirect, ${result.extra.missingTitle} missing <title>)`);
  console.log(`Threshold: ${opts.threshold} chars`);
  console.log(`Offenders (length > ${opts.threshold}): ${result.offendersTotal} (${((result.offendersTotal / Math.max(result.extra.scanned, 1)) * 100).toFixed(1)} % of scanned)`);

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
    console.log(`\nWorst ${Math.min(opts.limit, result.offendersTotal)} offenders:`);
    for (const r of result.offenders.slice(0, opts.limit)) {
      console.log(`  ${String(r.metric).padStart(4)} ch  [${r.locale}] ${r.feature.padEnd(22)}  ${r.file}`);
      console.log(`        ${JSON.stringify(r.title.slice(0, 120))}`);
    }
  }

  if (opts.writeBaselinePath) {
    console.log(`\nWrote baseline → ${opts.writeBaselinePath}`);
  }

  // Baseline regression dump (mirror of original)
  if (!result.passed && result.extra.regressedFeatures?.length > 0) {
    for (const { feat, cap, count } of result.extra.regressedFeatures) {
      const featOffenders = result.offenders
        .filter((o) => o.feature === feat)
        .sort((a, b) => b.metric - a.metric);
      console.error(`\nFull offender list for feature "${feat}" (${count} pages, baseline ${cap}, +${count - cap}):`);
      for (const o of featOffenders) {
        console.error(`  ${String(o.metric).padStart(3)} ch  [${o.locale}]  ${o.file}`);
        console.error(`        ${o.title}`);
      }
    }
    console.error('\nThe title-length baseline ratchet only allows the count to go DOWN.');
    console.error('Shorten the offending titleBases, then regenerate with --write-baseline=<path>.');
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
    console.error('audit-title-length: fatal', err);
    process.exit(2);
  });
}
