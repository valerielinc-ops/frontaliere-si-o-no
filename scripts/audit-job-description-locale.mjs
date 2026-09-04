#!/usr/bin/env node
/**
 * audit-job-description-locale — the measurement behind
 * tests/job-locale-consistency.test.ts's DESCRIPTIONS ratchet, run on a
 * schedule instead of only when a PR happens to be open.
 *
 * WHY IT EXISTS. On 2026-08-11 that ratchet read 0.320% against its 0.300%
 * limit and turned `vitest` red on EVERY open PR at once. Nothing had reported
 * the drift: the gate only speaks inside a PR run, it reports a rate with no
 * offender list, and no branch could fix it because the defect was in main's
 * DATA, not in any diff. Diagnosing it took a manual walk from a red check to a
 * batch of Confederazione Svizzera apprenticeship postings whose `it`
 * description was a byte-identical copy of the `de` source. This script is that
 * walk, done deterministically, so the next occurrence arrives as an issue with
 * the offenders already named.
 *
 * IT ALSO WATCHES THE MARGIN, NOT ONLY THE BREACH — the part the ratchet cannot
 * do. The gate went green again the same day WITHOUT anything being repaired:
 * the offender count stayed at 100 while the dataset grew from 31,266 to 34,594
 * description slots, so the rate fell to 0.289% purely by dilution. A gate
 * sitting 0.011pp under its limit is one crawl away from red and looks
 * identical to a healthy one. `--min-headroom-pp` is what makes that state
 * visible.
 *
 * MEASUREMENT PARITY. The rate here must be the rate the gate computes, or the
 * alert is about a different number than the one that breaks CI: same assembled
 * `data/jobs.json`, same `detectLanguageWithConfidence`, same 120-char floor,
 * same 0.65 confidence, same `needsRetranslation` skip. `MAX_RATE` is duplicated
 * from the test rather than imported (the test declares it inline, and this
 * script must not import a vitest file); tests/audit-job-description-locale.test.ts
 * asserts the two constants stay equal so the duplication cannot drift.
 *
 * IT ALSO COUNTS WHAT THE RATCHET CANNOT SEE AT ALL — the queue. Both this
 * audit and the gate skip `needsRetranslation` jobs in the NUMERATOR, on the
 * stated ground that "queued slots are expected to hold source-language
 * fallbacks UNTIL translate-pending processes them"
 * (scripts/lib/job-locale-population.mjs). That is the right call for a
 * QUALITY rate — merge order must not move it — but it makes one population
 * invisible: a job that is queued and stays queued. The site serves its German
 * text on the Italian page every day it sits there, and no number anywhere
 * counts it.
 *
 * SAY WHICH POPULATION EVERY NUMBER CAME FROM. This audit reads the ASSEMBLED
 * `data/jobs.json`, and the committed `data/jobs/by-crawler/*.json` slices are a
 * different, larger set — assemble drops postings before publication. The two
 * disagree by more than a rounding error and the first version of this header
 * quoted only the slices, which made its own diagnosis paragraph contradict the
 * table printed under it in the very first live issue. Both, measured
 * 2026-08-19:
 *
 *                                    slices        ASSEMBLED (what this reads)
 *   jobs                             27,590        23,061
 *   queued (needsRetranslation)      11,637        15,042
 *   still serving the source text       793           665
 *   ...for more than 7 days             376           180  (oldest 101 days)
 *   ...of those, NOT in a Swiss comune  357 (94.9%)     2 (1.1%)
 *
 * So the stuck tail is real on both, but the EXPLANATION is not transferable:
 * on the slices it is dominated by postings in Shanghai, Madrid and Singapore
 * that no cross-border reader would ever search for; on the published corpus
 * those are almost all gone, and what remains is jobs in real Swiss
 * municipalities that the cascade simply never reached. The issue body derives
 * which of the two it is on every run instead of storing the conclusion.
 * Either way, every one of them is invisible to the rate above.
 *
 * THE EXISTING ANTI-STARVATION MACHINERY IS NOT THE GAP, and this does not
 * duplicate it. `scripts/lib/job-traffic-priority.mjs` already draws
 * `RESERVE_FOR_OLDEST` (20%) of every batch oldest-first precisely so the tail
 * cannot starve, and `QUEUE_AGE_ALERT_DAYS` (150) ratchets on the age of the
 * single OLDEST job — measured at 127 days, correctly not firing. What neither
 * does is count the POPULATION currently being served in the wrong language,
 * or name the crawlers it concentrates in. A max is not a count.
 *
 * BYTE-IDENTITY, NOT THE DETECTOR, for this section. `detectLanguageWithConfidence`
 * answers "does this read as another language", which needs a confidence floor
 * and can be argued with. "The it slot is character-for-character the de slot"
 * cannot: no translation was attempted. Zero false positives is what makes the
 * number safe to put in an issue that opens work.
 *
 * Report-only: always exits 0 on a successful measurement. The repair path is
 * mark-locale-mismatched-jobs.mjs inside .github/workflows/translate-pending-logic.yml
 * — the SOURCE that scripts/generate-crawler-group-workflows.mjs renders into
 * .github/corpus-workflows/translate-pending.yml, which is what the corpus pool
 * actually runs. Edit the -logic.yml one and regenerate; the site's own
 * .github/workflows/translate-pending.yml is dormant (last run 2026-08-25) and
 * editing it changes nothing. The regression gate is the vitest ratchet.
 *
 * Usage:
 *   node scripts/audit-job-description-locale.mjs [--min-headroom-pp N] [--out PATH]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';
import {
  measureDescriptionLocales,
  DESCRIPTION_POPULATION,
  MIN_SERVED_SHARE,
} from './lib/job-locale-population.mjs';

// L'allarme sulla coda vive in un modulo SENZA import: lo carica anche lo
// script inline di job-description-locale-audit.yml, che non deve tirarsi
// dietro il rilevatore di lingua per confrontare due numeri. Ri-esportato qui
// perche' resti raggiungibile da chi legge questo script.
export { evaluateQueueAlarm, parseNonNegativeInteger } from './lib/queue-alarm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const LOCALES = ['it', 'en', 'de', 'fr'];

const MIN_DESCRIPTION_CHARS = 120;
const DESCRIPTION_CONFIDENCE = 0.65;

/**
 * Kept equal to `MAX_RATE` in tests/job-locale-consistency.test.ts by
 * tests/audit-job-description-locale.test.ts. Raising one without the other
 * makes this audit report health while CI is red, which is worse than no audit.
 */
export const MAX_RATE = 0.003;

/** Default headroom below which a still-green gate is worth saying out loud. */
export const DEFAULT_MIN_HEADROOM_PP = 0.05;

/**
 * Days a job may sit in the retranslation queue still serving its source text
 * before the queue is, for that job, not draining.
 *
 * 7 is the drain's own cadence rounded up, not a taste: translate-pending runs
 * five times a day, so a job still holding source text a full week later has
 * been passed over ~35 times. Below 7 the number would mostly count normal
 * churn (1,401 jobs entered the queue in the last day alone).
 */
export const QUEUE_STALE_DAYS = 7;

/**
 * Age (ms) at which a queued job counts as stale. `firstSeenAt` is the age
 * signal with full coverage on the queue and is the SAME field
 * `jobQueuedAtMs()` sorts the oldest-first reserve by, so this number and the
 * reserve cannot disagree about which jobs are old. `postedDate` is present on
 * ~2% of the queue and carries values as absurd as 4,915 days, so it is used
 * only as a fallback and never alone.
 */
function queuedForMs(job, now) {
  const raw = job?.firstSeenAt || job?.crawledAt || null;
  if (!raw) return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? now - t : null;
}

/** Whitespace-insensitive key — a re-wrapped copy is still a copy. */
const textKey = (t) => String(t || '').trim().split(/\s+/).join(' ');

/**
 * Count the jobs the site is serving in the wrong language RIGHT NOW because
 * their translation never happened, grouped by how long they have waited and
 * by which crawler produced them.
 *
 * Pure and now-injected so tests/job-translation-queue.test.ts can drive every
 * bucket from synthetic fixtures with no dataset and no clock.
 *
 * @param {Array<object>} jobs
 * @param {{ now?: number, staleDays?: number }} [opts]
 */
export function measureTranslationQueue(
  jobs,
  { now = Date.now(), staleDays = QUEUE_STALE_DAYS, isSwissLocation = null } = {},
) {
  const list = Array.isArray(jobs) ? jobs : [];
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  const buckets = { '0-7d': 0, '8-30d': 0, '31-90d': 0, '>90d': 0, unknown: 0 };
  const byCompany = new Map();
  const byLocation = new Map();
  const samples = [];
  let queuedJobs = 0;
  let sourceCopyJobs = 0;
  let staleSourceCopyJobs = 0;
  let staleNonSwiss = 0;
  let oldestStaleDays = 0;

  for (const job of list) {
    if (!job?.needsRetranslation) continue;
    queuedJobs += 1;

    // NO DEFAULT SOURCE LANGUAGE. "Copied from the source" is meaningless
    // without knowing which slot the source is, and guessing turns a wrong
    // guess into a confident defect count. Measured 2026-08-19: 0 of the 11,637
    // queued jobs lack `sourceLang` (de 8,999 · en 1,818 · fr 589 · it 231), so
    // this skip costs nothing today and cannot start lying tomorrow. The rest
    // of this file defaults to 'it' and this section deliberately does not
    // adopt that — a display fallback and a measurement are different things.
    const sourceLang = String(job?.sourceLang || '').toLowerCase();
    if (!sourceLang) continue;
    const source = String(job?.descriptionByLocale?.[sourceLang] || '').trim();
    if (source.length < MIN_DESCRIPTION_CHARS) continue;
    // Normalised once, not once per locale: these are multi-KB strings and the
    // loop runs across the whole corpus.
    const sourceKey = textKey(source);
    const copied = LOCALES.filter(
      (locale) => locale !== sourceLang && textKey(job?.descriptionByLocale?.[locale]) === sourceKey,
    );
    if (!copied.length) continue;
    sourceCopyJobs += 1;

    const waitedMs = queuedForMs(job, now);
    const waitedDays = waitedMs === null ? null : Math.floor(waitedMs / 86_400_000);
    const bucket = waitedDays === null ? 'unknown'
      : waitedDays <= 7 ? '0-7d'
      : waitedDays <= 30 ? '8-30d'
      : waitedDays <= 90 ? '31-90d'
      : '>90d';
    buckets[bucket] += 1;

    if (waitedMs !== null && waitedMs >= staleMs) {
      staleSourceCopyJobs += 1;
      if (waitedDays > oldestStaleDays) oldestStaleDays = waitedDays;
      const company = String(job?.company || '?');
      byCompany.set(company, (byCompany.get(company) || 0) + 1);

      // WHERE the stuck jobs are is the diagnosis, not decoration. Measured
      // 2026-08-19: 357 of 376 (94.9%) are not in a Swiss municipality —
      // Shanghai 35, Madrid 32, Petaling Jaya 14, Jundiai 14, Singapore 13.
      // That reframes the whole finding: these are not translations the
      // cascade failed to do, they are postings with no cross-border audience,
      // so they earn no traffic, so the traffic-first ordering never reaches
      // them and the 20% oldest-first reserve is all that ever could. The
      // repair question is "why is a Roche Shanghai posting in this corpus",
      // not "raise the translation cap".
      //
      // Injected, never imported: the real predicate lives in
      // scripts/lib/target-swiss-locations.mjs, which reads
      // data/canton-municipalities.json at module scope. Importing it here
      // would make this function unusable from a sparse worktree and take the
      // test's synthetic fixtures down with it.
      const location = String(job?.location || '').trim();
      if (typeof isSwissLocation === 'function' && !isSwissLocation(location)) {
        staleNonSwiss += 1;
        byLocation.set(location || '(vuota)', (byLocation.get(location || '(vuota)') || 0) + 1);
      }

      if (samples.length < 20) {
        samples.push({
          company,
          companyKey: String(job?.companyKey || ''),
          slug: String(job?.slug || '?'),
          location,
          sourceLang,
          copiedLocales: copied,
          waitedDays,
        });
      }
    }
  }

  return {
    queuedJobs,
    sourceCopyJobs,
    staleSourceCopyJobs,
    staleDays,
    oldestStaleDays,
    staleNonSwiss,
    staleNonSwissMeasured: typeof isSwissLocation === 'function',
    byAge: buckets,
    topLocations: [...byLocation.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([key, count]) => ({ key, count })),
    topCompanies: [...byCompany.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => ({ key, count })),
    samples,
  };
}

/**
 * Measure the descriptions ratchet. Pure: takes jobs, returns the report.
 * Exported so the test can exercise it without a dataset on disk.
 */
export function auditDescriptionLocales(jobs, { now = Date.now(), isSwissLocation = null } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];

  // THE RATE COMES FROM THE GATE'S OWN MEASUREMENT, not a copy of it.
  // Until #5638 this file re-implemented the loop and divided by the NON-queued
  // slots; the gate divides by the FULL queue-free population. Two different
  // denominators means the alert would have been about a different number than
  // the one that breaks CI — the exact defect this audit exists to prevent, in
  // the audit itself. `measureDescriptionLocales` is now the single source.
  const { slots, servedSlots, mismatches } = measureDescriptionLocales(
    list,
    detectLanguageWithConfidence,
    LOCALES
  );

  const rate = slots > 0 ? mismatches.length / slots : 0;
  const servedShare = slots > 0 ? servedSlots / slots : 0;
  const headroomPp = (MAX_RATE - rate) * 100;

  // GATE-BLIND is a distinct alarm from a breach, and it is the one that looks
  // most like health: if the served slice collapses, almost nothing is measured
  // and the rate goes green because the gate can no longer see. #5638 added the
  // floor to the gate; the audit has to be able to say it out loud too.
  const gateBlind = slots > 0 && servedShare < MIN_SERVED_SHARE;

  // The breakdown below is the audit's own contribution — the gate reports a
  // rate with no offenders, which is what made the 2026-08-11 breach take a
  // manual walk to diagnose. It mirrors the lib's skip rules exactly (queued
  // jobs are not detected on) so the counts stay reconcilable with `mismatches`.
  const offenders = [];
  const byCompany = new Map();
  const byPair = new Map();
  const actionableSlugs = new Set();

  for (const job of list) {
    if (job?.needsRetranslation) continue;
    for (const locale of LOCALES) {
      const description = String(job?.descriptionByLocale?.[locale] || '').trim();
      if (description.length < MIN_DESCRIPTION_CHARS) continue;
      const detected = detectLanguageWithConfidence(description, locale);
      if (detected.confidence < DESCRIPTION_CONFIDENCE) continue;
      if (detected.lang === locale) continue;

      const company = String(job?.company || '?');
      const slug = String(job?.slug || '?');
      const sourceLang = String(job?.sourceLang || 'it').toLowerCase();
      const sourceDesc = String(job?.descriptionByLocale?.[sourceLang] || job?.description || '').trim();
      const sourceCopy = sourceDesc.length > 0 && description.toLowerCase() === sourceDesc.toLowerCase();

      offenders.push({
        company, slug, locale,
        detected: detected.lang,
        confidence: Number(detected.confidence.toFixed(2)),
        sourceLang, sourceCopy,
        suppressed: Boolean(job?.localeMismatchSuppressed),
      });
      byCompany.set(company, (byCompany.get(company) || 0) + 1);
      const pair = `${sourceLang}->${locale}`;
      byPair.set(pair, (byPair.get(pair) || 0) + 1);
      if (!job?.localeMismatchSuppressed) actionableSlugs.add(slug);
    }
  }

  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ key: k, count: n }));

  return {
    datasetPresent: list.length > 0,
    totalJobs: list.length,
    population: DESCRIPTION_POPULATION.id,
    slots,
    servedSlots,
    servedShare,
    minServedShare: MIN_SERVED_SHARE,
    gateBlind,
    flagged: mismatches.length,
    rate,
    maxRate: MAX_RATE,
    headroomPp,
    breached: rate > MAX_RATE,
    sourceCopyCount: offenders.filter((o) => o.sourceCopy).length,
    actionableJobs: actionableSlugs.size,
    topCompanies: top(byCompany),
    topPairs: top(byPair),
    offenders: offenders.slice(0, 200),
    // The population the rate above cannot see, by construction. Reported
    // alongside it, never folded into it: mixing a queue count into a quality
    // rate is the denominator mistake this whole file exists to prevent.
    queue: measureTranslationQueue(list, { now, isSwissLocation }),
  };
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const raw = Number(get('--min-headroom-pp'));
  return {
    minHeadroomPp: Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_HEADROOM_PP,
    out: get('--out') || path.join(ROOT, 'data', 'job-description-locale-audit.json'),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let jobs = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf8'));
    if (Array.isArray(parsed) && parsed.length > 0) jobs = parsed;
  } catch {
    jobs = null;
  }

  if (!jobs) {
    // No dataset means no measurement. Emit an explicit absent-report rather
    // than a zero one: a zero would read as "healthy" and close the tracking
    // issue on an empty run.
    const report = { datasetPresent: false, minHeadroomPp: opts.minHeadroomPp };
    fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));
    console.log('data/jobs.json absent or empty — no measurement. Run scripts/assemble-jobs-dataset.mjs first.');
    return;
  }

  // The Swiss-municipality predicate is loaded HERE, not at module scope, and
  // its absence degrades the extra dimension to "not measured" instead of
  // crashing the audit: scripts/lib/target-swiss-locations.mjs reads
  // data/canton-municipalities.json at import time, and the whole point of
  // keeping measureTranslationQueue pure is that the audit still runs without it.
  let isSwissLocation = null;
  try {
    const { isKnownSwissMunicipality } = await import('./lib/target-swiss-locations.mjs');
    isSwissLocation = (location) => {
      if (!location) return false;
      const city = location.replace(/\s*\([^)]*\)\s*$/, '').split(',')[0].trim();
      return Boolean(city) && Boolean(isKnownSwissMunicipality(city));
    };
  } catch {
    isSwissLocation = null;
  }

  const report = { ...auditDescriptionLocales(jobs, { isSwissLocation }), minHeadroomPp: opts.minHeadroomPp };
  report.thinMargin = !report.breached && report.headroomPp < opts.minHeadroomPp;
  fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));

  const pct = (v) => `${(v * 100).toFixed(3)}%`;
  console.log(
    `[audit] ${report.population} ${report.flagged}/${report.slots} = ${pct(report.rate)} `
      + `(max ${pct(report.maxRate)}, headroom ${report.headroomPp.toFixed(3)}pp) `
      + `served ${report.servedSlots}/${report.slots} = ${(report.servedShare * 100).toFixed(1)}% `
      + `(min ${(report.minServedShare * 100).toFixed(0)}%) `
      + `source-copy ${report.sourceCopyCount} · actionable jobs ${report.actionableJobs}`
  );
  if (report.gateBlind) {
    console.log('❌ GATE-BLIND — la quota servita e sotto il floor: un tasso verde qui e vacuo.');
  }
  if (report.breached) console.log('❌ BREACHED — the vitest ratchet is red on every open PR.');
  else if (report.thinMargin) console.log(`⚠️  THIN MARGIN — under ${opts.minHeadroomPp}pp of headroom.`);
  else console.log('✅ healthy');
  for (const c of report.topCompanies.slice(0, 5)) console.log(`   ${c.count}\t${c.key}`);

  const q = report.queue;
  console.log(
    `[queue] ${q.queuedJobs} jobs queued · ${q.sourceCopyJobs} still serving their source text · `
      + `${q.staleSourceCopyJobs} of those for more than ${q.staleDays}d (oldest ${q.oldestStaleDays}d) `
      + `— none of them counted in the rate above`
  );
  if (q.staleSourceCopyJobs > 0) {
    console.log(`   by age: ${Object.entries(q.byAge).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (q.staleNonSwissMeasured) {
      const share = q.staleSourceCopyJobs > 0 ? (q.staleNonSwiss / q.staleSourceCopyJobs) * 100 : 0;
      console.log(`   non-Swiss location: ${q.staleNonSwiss}/${q.staleSourceCopyJobs} = ${share.toFixed(1)}%`);
      for (const l of q.topLocations.slice(0, 5)) console.log(`   ${l.count}\t${l.key}`);
    }
    for (const c of q.topCompanies.slice(0, 5)) console.log(`   ${c.count}\t${c.key}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // main() is async only because it lazily imports the BFS predicate; an
  // unhandled rejection here would exit 0 with no report, which reads as a
  // clean run to the workflow.
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}