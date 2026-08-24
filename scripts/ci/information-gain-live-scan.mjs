#!/usr/bin/env node
/**
 * information-gain-live-scan.mjs — the measuring half of the self-improving
 * Information-Gain loop (issue #5002).
 *
 * WHY A LIVE SCAN AND NOT THE DIST GATE
 * ---------------------------------------------------------------------------
 * `audit-information-gain.mjs` already runs inside `audit-all.mjs`, on the
 * rehydrated `dist/` of `post-deploy-validate-dist.yml`. That gate answers
 * "did the emission break?" and blocks. It cannot answer two other questions,
 * and both are the ones that make the mechanism improve instead of merely hold:
 *
 *   1. Which family is the WORST one still above the floor? The gate is silent
 *      about everything that passes, so a family sitting at 6 % forever is
 *      indistinguishable from one at 50 %.
 *   2. Has an inventoried family RECOVERED? The gate prints a "remove this
 *      line" notice into a log nobody reads, so the inventory only ever
 *      shrinks when a human happens to look.
 *
 * This scan samples the LIVE sitemaps instead — 12 URLs per declared family,
 * evenly spaced — so it needs no build, no dist and no `npm ci`, and it
 * measures what Google actually has. It opens nothing itself: it prints a
 * verdict the workflow turns into issues, which the existing autonomous loop
 * (`issue-triage` → `issue-fix` → `pr-review-loop` → `auto-merge-on-lgtm`)
 * then implements. The next run of this scan re-measures and resolves the
 * issue, which is what closes the loop.
 *
 * THREE BUCKETS, THREE DIFFERENT LOOPS
 * ---------------------------------------------------------------------------
 *   regression  — a cohort below the floor and not inventoried, or an
 *                 inventoried one now worse than its recorded value. Fix the
 *                 content. This is the only bucket that is a defect.
 *   ratchet     — an inventoried cohort now above the floor. Remove its line
 *                 from `KNOWN_LOW_GAIN_COHORTS`; the gate tightens by itself.
 *   opportunity — the worst gated cohort that is above the floor but below the
 *                 issue's 40 % target. One at a time, deliberately: this is a
 *                 content-improvement queue, and a queue that opens ten issues
 *                 a day gets muted.
 *
 * SAMPLING HONESTY
 * ---------------------------------------------------------------------------
 * Two ways to fake a good number here, both of which this script avoids and
 * `docs/INFORMATION-GAIN.md` documents:
 *   - mixing locales in a small sample: prose in different languages never
 *     matches, so every page looks unique. URLs are filtered to ONE locale.
 *   - `head -N` on a sitemap: the first N URLs are one province or one canton,
 *     so the "cohort" is not the family. URLs are taken evenly spaced.
 *
 * Usage:
 *   node scripts/ci/information-gain-live-scan.mjs [--per-family=12]
 *   node scripts/ci/information-gain-live-scan.mjs --out=verdict.json
 *   node scripts/ci/information-gain-live-scan.mjs --json      # verdetto su stdout
 */

import { fileURLToPath } from 'node:url';
import { fingerprintPage, scoreCohorts } from '../lib/informationGain.mjs';
import { INFORMATION_GAIN_GATE } from '../audit-information-gain.mjs';

const { MEDIAN_IGS_FLOOR_PCT, REGRESSION_TOLERANCE_PCT, KNOWN_LOW_GAIN_COHORTS } =
  INFORMATION_GAIN_GATE;

const BASE = 'https://frontaliereticino.ch';

/** The issue's own target, reported but never gated. See the auditor's header. */
const ISSUE_TARGET_PCT = 40;

/**
 * The sitemaps whose pages are TEMPLATE families — one plugin, one `copy.h1()`,
 * many entities. Declared instead of derived from `sitemap.xml`: that index
 * lists ~60 sitemaps, most of which are single hubs, feeds or archives where
 * "does this page repeat its siblings" is not a question with an answer, and
 * sampling all of them would be ~700 requests a day to measure nothing.
 *
 * Adding a family here is the intended way to widen the loop's coverage.
 */
const MONITORED_SITEMAPS = [
  'sitemap-comuni-frontiera.xml',
  'sitemap-comuni-fiscale.xml',
  'sitemap-comuni-francia.xml',
  'sitemap-comuni-germania.xml',
  'sitemap-comuni-austria.xml',
  'sitemap-comuni-liechtenstein.xml',
  'sitemap-bfs-salary.xml',
  'sitemap-professions.xml',
  'sitemap-profession-cities.xml',
  'sitemap-employer-profiles.xml',
  'sitemap-salary-hub.xml',
  'sitemap-comparisons.xml',
];

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PER_FAMILY = Math.max(4, Number(arg('per-family', '12')) || 12);
const EMIT_JSON = process.argv.includes('--json');
/**
 * Con `--out` il verdetto va su FILE e stdout resta il riassunto leggibile.
 * Serve al workflow: `--json > file` costringeva a rileggere il JSON con un
 * `node -e` per stampare due righe di log, e `require()` dentro `node -e` non
 * funziona in un repo `"type": "module"` — un dettaglio che si scopre solo
 * quando la run è già rossa.
 */
const OUT_FILE = arg('out', '');

/** Evenly spaced picks — never the first N, which are one province. */
function evenlySpaced(items, count) {
  if (items.length <= count) return items;
  const step = items.length / count;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(items[Math.floor(i * step)]);
  return out;
}

async function fetchText(url, timeoutMs = 25_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      // A plain `fetch` without a UA is 403'd by the edge on some paths while
      // curl is let through (measured on the job pages). Declare what this is.
      headers: { 'user-agent': 'frontaliereticino-information-gain-scan/1 (+internal monitor)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `https://host/a/b/` → `a/b/index.html`, the shape the auditor derives from. */
function distRelPath(url) {
  const rel = url.replace(`${BASE}/`, '').replace(/\/$/, '');
  return `${rel || 'index'}/index.html`;
}

async function collectFamily(sitemap) {
  const xml = await fetchText(`${BASE}/${sitemap}`, 45_000);
  if (!xml) return { sitemap, urls: [], fingerprints: [], error: 'sitemap non raggiungibile' };

  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].trim())
    .filter((u) => !u.endsWith('.xml'))
    // One locale only: see the sampling note in the header.
    .filter((u) => !/frontaliereticino\.ch\/(en|de|fr)\//.test(u));

  const picked = evenlySpaced(all, PER_FAMILY);
  const fingerprints = [];
  // Sequential on purpose: a dozen GETs per family is not worth a concurrency
  // bug, and a monitor that hammers the origin is a monitor someone turns off.
  for (const url of picked) {
    const html = await fetchText(url);
    if (!html) continue;
    fingerprints.push(fingerprintPage(distRelPath(url), html));
  }
  return { sitemap, urls: all.length, sampled: picked.length, fingerprints };
}

/**
 * The bucket decision, pure and exported so it can be tested without network.
 *
 * It is the only place that decides what the loop DOES, and each branch is a
 * different loop: a regression is a defect to fix, a ratchet is the gate
 * tightening, an opportunity is the improvement queue. Getting the order wrong
 * would be silent — e.g. classifying an inventoried cohort that recovered as
 * an "opportunity" would leave its inventory line in place forever, and the
 * gate would never tighten again.
 */
export function classifyCohorts(cohorts, { floor, tolerance, target, inventory }) {
  const regressions = [];
  const ratchets = [];
  const opportunities = [];

  for (const cohort of cohorts) {
    const recorded = inventory.get(cohort.label);
    if (recorded === undefined) {
      if (cohort.medianIgs < floor) {
        regressions.push({ ...cohort, recorded: null, reason: 'below-floor' });
      } else if (cohort.medianIgs < target) {
        opportunities.push(cohort);
      }
      continue;
    }
    if (cohort.medianIgs < recorded - tolerance) {
      regressions.push({ ...cohort, recorded, reason: 'regressed-vs-inventory' });
    } else if (cohort.medianIgs >= floor) {
      ratchets.push({ ...cohort, recorded });
    }
  }

  // Worst first: the improvement queue is a queue, and one issue at a time.
  opportunities.sort((a, b) => a.medianIgs - b.medianIgs);
  return { regressions, ratchets, opportunities };
}

async function main() {
  const families = [];
  const fingerprints = [];
  for (const sitemap of MONITORED_SITEMAPS) {
    const fam = await collectFamily(sitemap);
    families.push({ sitemap: fam.sitemap, urls: fam.urls, sampled: fam.sampled ?? 0, error: fam.error });
    fingerprints.push(...fam.fingerprints);
  }

  // Gating threshold lowered vs the dist gate: a live sample is 12 pages per
  // family by construction, so MIN_COHORT_PAGES=12 would gate nothing. 6 is
  // the smallest cohort where "shared with half the cohort" is not noise.
  const { cohorts, pagesScored } = scoreCohorts(fingerprints, { minCohortPages: 6 });
  const gated = cohorts.filter((c) => c.gated);

  const { regressions, ratchets, opportunities } = classifyCohorts(gated, {
    floor: MEDIAN_IGS_FLOOR_PCT,
    tolerance: REGRESSION_TOLERANCE_PCT,
    target: ISSUE_TARGET_PCT,
    inventory: KNOWN_LOW_GAIN_COHORTS,
  });
  const opportunity = opportunities[0] ?? null;

  const pct = (v) => `${v.toFixed(1).replace('.', ',')} %`;
  const table = gated
    .map(
      (c) =>
        `  ${pct(c.medianIgs).padStart(8)}  n=${String(c.pages).padStart(3)}  ` +
        `zero=${String(c.zeroGainPages).padStart(3)}  ${c.label}` +
        (KNOWN_LOW_GAIN_COHORTS.has(c.label)
          ? `  [inventario: ${pct(KNOWN_LOW_GAIN_COHORTS.get(c.label))}]`
          : ''),
    )
    .join('\n');

  const summary = [
    `famiglie campionate: ${families.length}, pagine in coorte: ${pagesScored}, coorti gated: ${gated.length}`,
    table || '  (nessuna coorte ha raggiunto la soglia di gating)',
    '',
    `regressioni: ${regressions.length} · righe di inventario da togliere: ${ratchets.length} · ` +
      `sotto il target ${ISSUE_TARGET_PCT} %: ${opportunities.length}`,
  ].join('\n');

  const verdict = {
    ranAt: new Date().toISOString(),
    floor: MEDIAN_IGS_FLOOR_PCT,
    target: ISSUE_TARGET_PCT,
    perFamily: PER_FAMILY,
    families,
    cohorts: gated.map((c) => ({
      label: c.label,
      pages: c.pages,
      medianIgs: Number(c.medianIgs.toFixed(2)),
      zeroGainPages: c.zeroGainPages,
      recorded: KNOWN_LOW_GAIN_COHORTS.get(c.label) ?? null,
      worst: c.worst.map((p) => ({ urlPath: p.urlPath, igs: Number(p.igs.toFixed(2)) })),
    })),
    regressions: regressions.map((r) => ({
      label: r.label,
      medianIgs: Number(r.medianIgs.toFixed(2)),
      recorded: r.recorded,
      reason: r.reason,
      pages: r.pages,
      zeroGainPages: r.zeroGainPages,
      worst: r.worst.map((p) => ({ urlPath: p.urlPath, igs: Number(p.igs.toFixed(2)) })),
    })),
    ratchets: ratchets.map((r) => ({
      label: r.label,
      medianIgs: Number(r.medianIgs.toFixed(2)),
      recorded: r.recorded,
    })),
    opportunity: opportunity
      ? {
          label: opportunity.label,
          medianIgs: Number(opportunity.medianIgs.toFixed(2)),
          pages: opportunity.pages,
          worst: opportunity.worst.map((p) => ({
            urlPath: p.urlPath,
            igs: Number(p.igs.toFixed(2)),
            segments: p.segments,
            pageSpecific: p.pageSpecific,
          })),
        }
      : null,
    summary,
  };

  if (OUT_FILE) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OUT_FILE, `${JSON.stringify(verdict, null, 2)}\n`);
    console.log(summary);
    console.log(`\nverdetto: ${OUT_FILE}`);
  } else if (EMIT_JSON) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log(summary);
  }

  // GitHub Actions outputs. Multi-line values go through the heredoc form.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    const out = [
      `has_regression=${regressions.length > 0}`,
      `has_ratchet=${ratchets.length > 0}`,
      `has_opportunity=${opportunity ? 'true' : 'false'}`,
      `opportunity_label=${opportunity?.label ?? ''}`,
      `opportunity_median=${opportunity ? pct(opportunity.medianIgs) : ''}`,
      `verdict_json<<VERDICT_EOF\n${JSON.stringify(verdict)}\nVERDICT_EOF`,
      `summary<<SUMMARY_EOF\n${summary}\nSUMMARY_EOF`,
    ].join('\n');
    appendFileSync(process.env.GITHUB_OUTPUT, `${out}\n`);
  }

  // Exit 0 always. This is a REPORTER: the blocking gate is the dist one, and
  // a red cron that nobody can turn green from a PR is how a monitor gets
  // deleted instead of read.
  process.exit(0);
}

// Il modulo è importabile per i test: `main()` parte solo da CLI.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[information-gain-live-scan] fatal', err);
    // Fail loudly on an internal error — a scan that silently reports "nothing
    // to do" because it crashed is worse than no scan.
    process.exit(1);
  });
}
