#!/usr/bin/env node
/**
 * audit-duplicate-crawler-companies.mjs — the same employer, published twice.
 *
 * ## What it looks for
 *
 * Two findings, both read straight off `data/jobs/by-crawler/*.json`:
 *
 *   1. **duplicate-identity** — two crawler keys serving the SAME vacancy URL.
 *      One vacancy is one job posting; publishing it under two employer
 *      identities puts two company pages on the site for one employer.
 *   2. **coverage-gap** — inside such a pair, the vacancies one side has and the
 *      other does not. This is the valuable half: it means the crawler we keep
 *      is missing real, live postings that the other one found.
 *
 * ## Why the predicate is the vacancy URL and not the host
 *
 * A shared host proves nothing on its own — `jobs.smartrecruiters.com` is the
 * front door of 24 unrelated employers we crawl, and flagging it would bury the
 * signal under 46 hosts of noise (measured). A shared vacancy URL proves
 * everything, and there were 24 such pairs when this audit was written.
 *
 * It is not the title either. The duplicate that prompted this script carried
 * `Collaboratrice-ore dell'economia domestica a ore Collaboratrice-ore dell` —
 * two job cards concatenated by a half-finished extractor — so text matching
 * would have missed the very case it was written for.
 *
 * ## Cost
 *
 * Deterministic set arithmetic, zero Claude calls, per `AGENTS.md → Auth
 * automazioni & frugalità quota`. Findings are reported as ONE aggregated issue
 * per kind with a stable title, so a standing problem comments on its own issue
 * instead of minting a new one every morning.
 *
 * ## Usage
 *
 *   node scripts/audit-duplicate-crawler-companies.mjs            # report only
 *   node scripts/audit-duplicate-crawler-companies.mjs --issues   # + open/update issues
 *
 * Exit code is 0 whenever the audit itself ran: a finding is a backlog item, not
 * a broken workflow. Non-zero only when the audit could not be performed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceHostOwnership, findOverlappingCrawlers } from './lib/crawler-source-hosts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** How many URLs to spell out in an issue body before summarising the rest. */
const MAX_LISTED = 15;

/** Stable family keys also shared by the historical count-bearing titles. */
export const DUPLICATE_ISSUE_KEY = '[duplicate-crawler]';
export const COVERAGE_GAP_ISSUE_KEY = '[crawler-coverage-gap]';
export const STALE_SNAPSHOT_ISSUE_KEY = '[crawler-snapshot-stale]';

/**
 * @param {string[]} urls
 * @returns {string}
 */
function bulletList(urls) {
  const shown = urls.slice(0, MAX_LISTED).map((u) => `  - ${u}`);
  if (urls.length > MAX_LISTED) shown.push(`  - …e altri ${urls.length - MAX_LISTED}`);
  return shown.join('\n');
}

/**
 * How much of the smaller crawler's catalogue the bigger one must already hold
 * before we treat the two as reading the same source. Below this they are two
 * employers that merely happen to share a few postings, and their differences
 * are not a coverage gap at all.
 */
const SAME_SOURCE_CONTAINMENT = 0.5;

/**
 * Gaps are meaningful only between snapshots from the same crawler cycle.
 * Comparing a fresh keeper with a witness that has not run for days turns
 * already-expired jobs into fake coverage defects (Spital Davos, issue 6760).
 * Daily crawler groups can legitimately finish hours apart, so one day is the
 * conservative comparability window; missing/legacy timestamps stay eligible.
 */
const MAX_COMPARABLE_SNAPSHOT_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * A skewed witness is temporarily non-comparable, but after two missed daily
 * cycles that same evidence means the crawler itself is stale. Keep this cap
 * independent from the skew window so suppressing a false coverage gap never
 * suppresses the stopped-crawler signal as well.
 */
const MAX_CRAWLER_SNAPSHOT_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Pairs where one side deliberately owns a subset of a shared group feed.
 * Exclusive jobs on the dedicated side must NOT be widened into the group
 * crawler: that would publish the same vacancy under two company identities.
 * Duplicate-identity findings are intentionally unaffected and continue to
 * drive the separate slug-preserving consolidation work.
 *
 * - `confederazione-ticino` has a `COVERED_KEYS` skip-set for Agroscope/VTG.
 * - `posta-svizzera-centro-regionale` and PostAuto split `job.post.ch` by the
 *   source's `cust_brandCompanyJobSearch` brand tag.
 * - Denner and migrolino have dedicated crawlers on the shared Migros portal;
 *   their brand-exclusive postings belong to those company identities, not to
 *   the broad `migros-ticino` group slice.
 *
 * The audit elects `keeper` from the current cardinality, so direction is not
 * stable: a temporarily larger dedicated slice can reverse keeper/witness.
 * Ownership belongs to the unordered pair and must survive that reversal.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function unorderedCrawlerPair(a, b) {
  return JSON.stringify([a, b].sort());
}

const NON_COVERAGE_GAP_PAIRS = new Set([
  unorderedCrawlerPair('confederazione-ticino', 'agroscope'),
  unorderedCrawlerPair('confederazione-ticino', 'vtg'),
  unorderedCrawlerPair('confederazione-ticino', 'agroscope-defr'),
  unorderedCrawlerPair('posta-svizzera-centro-regionale', 'postauto'),
  unorderedCrawlerPair('migros-ticino', 'denner'),
  unorderedCrawlerPair('migros-ticino', 'migrolino'),
]);

/**
 * Compatibility shape accepted by the audit classifier. Active fields were
 * added after the original raw-URL audit and remain optional so old fixtures
 * and pre-upgrade callers retain the previous conservative behaviour.
 *
 * @typedef {Object} AuditOverlapPair
 * @property {[string, string]} keys
 * @property {string[]} shared
 * @property {string[]} onlyA
 * @property {string[]} onlyB
 * @property {string[]} [activeShared]
 * @property {string[]} [activeOnlyA]
 * @property {string[]} [activeOnlyB]
 * @property {number|null} [activeTotalA]
 * @property {number|null} [activeTotalB]
 * @property {number|null} [snapshotSkewMs]
 * @property {string|null} [olderSnapshotKey]
 * @property {number|null} [olderSnapshotAtMs]
 */

/**
 * Split the overlap pairs into the two things we report.
 *
 * The gap is deliberately ONE-DIRECTIONAL. `coop-ticino` is a group crawler that
 * legitimately covers Fust, Jumbo and Interdiscount, so "coop-ticino has 2422
 * vacancies Jumbo lacks" is not a defect, it is the design — reporting both
 * directions drowned the real finding under 14'697 phantom gaps on the first
 * run. What IS a defect is the reverse: postings the SMALLER, more specific
 * crawler found and the bigger one missed, because the bigger one is the one we
 * keep. That is exactly the EOC shape — the retired duplicate had read three
 * live vacancies the surviving crawler's snapshot had never contained.
 *
 * @param {AuditOverlapPair[]} pairs
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ duplicates: AuditOverlapPair[], gaps: { key: string, twin: string, missing: string[] }[],
 *   ignored: { key: string, twin: string, missing: string[], reason: string }[],
 *   staleSnapshots: { key: string, twin: string, assembledAtMs: number, ageMs: number,
 *     maskedMissing: string[] }[] }}
 */
export function classifyFindings(pairs, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const duplicates = pairs.filter((p) => p.shared.length > 0);
  /** @type {{ key: string, twin: string, missing: string[] }[]} */
  const gaps = [];
  /** @type {{ key: string, twin: string, missing: string[], reason: string }[]} */
  const ignored = [];
  /** @type {{ key: string, twin: string, assembledAtMs: number, ageMs: number,
   *   maskedMissing: string[] }[]} */
  const staleSnapshots = [];
  for (const p of duplicates) {
    const hasActiveCardinality = Number.isFinite(p.activeTotalA)
      && Number.isFinite(p.activeTotalB)
      && Array.isArray(p.activeShared);
    const totalA = hasActiveCardinality
      ? p.activeTotalA
      : p.shared.length + p.onlyA.length;
    const totalB = hasActiveCardinality
      ? p.activeTotalB
      : p.shared.length + p.onlyB.length;
    // The bigger catalogue is the crawler we would keep; the smaller one is the
    // witness that it is missing something.
    const aIsBigger = totalA >= totalB;
    const keeper = aIsBigger ? p.keys[0] : p.keys[1];
    const witness = aIsBigger ? p.keys[1] : p.keys[0];
    const rawMissing = aIsBigger ? p.onlyB : p.onlyA;
    // A grace-period record (`crawlerMissStreak > 0`) was not observed by the
    // witness's latest crawl, so it cannot prove the keeper missed a live job.
    const missing = aIsBigger
      ? (Array.isArray(p.activeOnlyB) ? p.activeOnlyB : p.onlyB)
      : (Array.isArray(p.activeOnlyA) ? p.activeOnlyA : p.onlyA);
    const smallerTotal = Math.min(totalA, totalB);
    if (!smallerTotal || !rawMissing.length) continue;
    const sharedTotal = hasActiveCardinality ? p.activeShared.length : p.shared.length;
    if (sharedTotal / smallerTotal < SAME_SOURCE_CONTAINMENT) continue;
    const retained = rawMissing.filter((url) => !missing.includes(url));
    if (retained.length) {
      ignored.push({ key: keeper, twin: witness, missing: retained, reason: 'grace-period-retained' });
    }
    if (!missing.length) continue;
    if (
      Number.isFinite(p.snapshotSkewMs)
      && p.snapshotSkewMs > MAX_COMPARABLE_SNAPSHOT_SKEW_MS
      && p.olderSnapshotKey === witness
    ) {
      ignored.push({ key: keeper, twin: witness, missing, reason: 'snapshot-skew' });
      if (
        Number.isFinite(p.olderSnapshotAtMs)
        && nowMs - p.olderSnapshotAtMs > MAX_CRAWLER_SNAPSHOT_AGE_MS
      ) {
        staleSnapshots.push({
          key: witness,
          twin: keeper,
          assembledAtMs: p.olderSnapshotAtMs,
          ageMs: nowMs - p.olderSnapshotAtMs,
          maskedMissing: missing,
        });
      }
      continue;
    }
    if (NON_COVERAGE_GAP_PAIRS.has(unorderedCrawlerPair(keeper, witness))) {
      ignored.push({ key: keeper, twin: witness, missing, reason: 'source-ownership' });
      continue;
    }
    gaps.push({ key: keeper, twin: witness, missing });
  }
  gaps.sort((x, y) => y.missing.length - x.missing.length || x.key.localeCompare(y.key));
  ignored.sort((x, y) => y.missing.length - x.missing.length || x.key.localeCompare(y.key));
  staleSnapshots.sort((x, y) => y.ageMs - x.ageMs || x.key.localeCompare(y.key));
  return { duplicates, gaps, ignored, staleSnapshots };
}

/**
 * @param {{ keys: [string, string], shared: string[] }[]} duplicates
 * @returns {{ title: string, description: string, dedupKey: string }}
 */
export function duplicateIssue(duplicates) {
  const title = `${DUPLICATE_ISSUE_KEY} crawler diversi pubblicano le stesse vacancy sotto companyKey diverse`;
  const body = [
    'Rilevato da `scripts/audit-duplicate-crawler-companies.mjs` (audit deterministico, zero Claude).',
    '',
    `Totale corrente: **${duplicates.length} coppie di crawler**.`,
    '',
    'Ogni coppia qui sotto serve **le stesse URL di vacancy** sotto due `companyKey` diverse.',
    "Una vacancy e' un solo annuncio: pubblicarla sotto due identita' aziendali mette due",
    "schede azienda sul sito per lo stesso datore, ed e' esattamente il difetto che ha prodotto",
    '`eoc-candidati-posizioni` accanto a `eoc-ente-ospedaliero-cantonale`.',
    '',
    'Per ogni coppia: decidere quale `companyKey` e\' quella reale, ritirare l\'altra portandone',
    'gli slug in `previousSlugs` (mai una cancellazione secca: gli slug sono indicizzati).',
    '',
    ...duplicates.map(
      (p) =>
        `- **${p.keys[0]}** + **${p.keys[1]}** — ${p.shared.length} vacancy in comune\n${bulletList(p.shared.slice(0, 3))}`,
    ),
  ].join('\n');
  return { title, description: body, dedupKey: DUPLICATE_ISSUE_KEY };
}

/**
 * @param {ReturnType<typeof classifyFindings>['gaps']} gaps
 * @returns {{ title: string, description: string, dedupKey: string }}
 */
export function gapIssue(gaps) {
  const total = gaps.reduce((n, g) => n + g.missing.length, 0);
  const title = `${COVERAGE_GAP_ISSUE_KEY} vacancy viste da un crawler gemello e assenti dal crawler principale`;
  const body = [
    'Rilevato da `scripts/audit-duplicate-crawler-companies.mjs` (audit deterministico, zero Claude).',
    '',
    `Totale corrente: **${total} vacancy**.`,
    '',
    'Queste vacancy esistono nello slice di un crawler che legge le STESSE pagine, ma non in',
    "quello del crawler indicato: il suo seed o la sua paginazione ha un buco di copertura reale.",
    "E' il caso che su EOC aveva lasciato tre annunci veri raggiungibili solo dal crawler duplicato,",
    'incluso quello segnalato da un lettore.',
    '',
    'Per ognuno: allargare il seed/la paginazione del crawler principale finche\' non copre le URL elencate.',
    '',
    ...gaps.map(
      (g) =>
        `- **${g.key}** — ${g.missing.length} vacancy che \`${g.twin}\` vede e lui no:\n${bulletList(g.missing)}`,
    ),
  ].join('\n');
  return { title, description: body, dedupKey: COVERAGE_GAP_ISSUE_KEY };
}

/**
 * @param {ReturnType<typeof classifyFindings>['staleSnapshots']} staleSnapshots
 * @returns {{ title: string, description: string, dedupKey: string }}
 */
export function staleSnapshotIssue(staleSnapshots) {
  const title = `${STALE_SNAPSHOT_ISSUE_KEY} crawler witness senza snapshot aggiornato oltre due cicli`;
  const body = [
    'Rilevato da `scripts/audit-duplicate-crawler-companies.mjs` (audit deterministico, zero Claude).',
    '',
    `Totale corrente: **${staleSnapshots.length} witness stale**.`,
    '',
    'Questi witness sono troppo vecchi per provare un coverage gap: le vacancy esclusive restano',
    'correttamente escluse dal finding di copertura, ma lo skew non nasconde piu\' che il crawler',
    'non produce uno snapshot da oltre 48 ore. Ripristinare il crawler e rieseguire l\'audit prima',
    'di allargare il keeper sulla base di URL potenzialmente scadute.',
    '',
    ...staleSnapshots.map((finding) => {
      const hours = Math.floor(finding.ageMs / (60 * 60 * 1000));
      return `- **${finding.key}** (gemello \`${finding.twin}\`) — snapshot fermo da ${hours}h, `
        + `${finding.maskedMissing.length} vacancy non comparabili; ultimo assembly `
        + `\`${new Date(finding.assembledAtMs).toISOString()}\``;
    }),
  ].join('\n');
  return { title, description: body, dedupKey: STALE_SNAPSHOT_ISSUE_KEY };
}

async function main() {
  const withIssues = process.argv.includes('--issues');

  const ownership = loadSourceHostOwnership(ROOT, { urls: true });
  if (!ownership.slices.length) {
    console.error('✗ nessuno slice in data/jobs/by-crawler/ — checkout sparse o directory assente.');
    process.exitCode = 1;
    return;
  }

  const pairs = findOverlappingCrawlers(ownership);
  const { duplicates, gaps, ignored, staleSnapshots } = classifyFindings(pairs);

  console.log(`slice letti: ${ownership.slices.length}`);
  console.log(`host distinti: ${ownership.byHost.size} (dedicati ${ownership.dedicatedHosts.size}, condivisi ${ownership.sharedHosts.size})`);
  console.log(`coppie che condividono almeno una vacancy: ${duplicates.length}`);
  console.log(`buchi di copertura: ${gaps.length} crawler, ${gaps.reduce((n, g) => n + g.missing.length, 0)} vacancy\n`);
  console.log(`differenze non-gap motivate: ${ignored.length} coppie, ${ignored.reduce((n, g) => n + g.missing.length, 0)} vacancy`);
  console.log(`witness stale oltre 48h: ${staleSnapshots.length}`);

  for (const p of duplicates) {
    console.log(`  DUP  ${p.keys[0]} + ${p.keys[1]} — ${p.shared.length} in comune, ${p.onlyA.length}/${p.onlyB.length} esclusive`);
  }
  for (const g of gaps.slice(0, 20)) {
    console.log(`  GAP  ${g.key} — ${g.missing.length} vacancy viste da ${g.twin}`);
  }
  for (const g of ignored.slice(0, 20)) {
    console.log(`  OK   ${g.key} ← ${g.twin} — ${g.missing.length} (${g.reason})`);
  }
  for (const finding of staleSnapshots.slice(0, 20)) {
    console.log(`  STALE ${finding.key} — ${Math.floor(finding.ageMs / (60 * 60 * 1000))}h, `
      + `${finding.maskedMissing.length} vacancy non comparabili (gemello ${finding.twin})`);
  }

  if (!withIssues) {
    console.log('\n(report-only: passa --issues per aprire/aggiornare le issue di backlog)');
    return;
  }
  if (!duplicates.length && !gaps.length && !staleSnapshots.length) {
    console.log('\nnessun finding — nessuna issue da aprire.');
    return;
  }

  const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
  if (duplicates.length) {
    const { title, description, dedupKey } = duplicateIssue(duplicates);
    await createGithubIssue({ title, description, dedupKey, priority: 2, labels: ['crawler'], workflow: 'audit-duplicate-crawlers' });
    console.log(`\n→ issue duplicate-identity: ${title}`);
  }
  if (gaps.length) {
    const { title, description, dedupKey } = gapIssue(gaps);
    await createGithubIssue({ title, description, dedupKey, priority: 2, labels: ['crawler'], workflow: 'audit-duplicate-crawlers' });
    console.log(`→ issue coverage-gap: ${title}`);
  }
  if (staleSnapshots.length) {
    const { title, description, dedupKey } = staleSnapshotIssue(staleSnapshots);
    await createGithubIssue({ title, description, dedupKey, priority: 2, labels: ['crawler'], workflow: 'audit-duplicate-crawlers' });
    console.log(`→ issue snapshot-stale: ${title}`);
  }
}

// Only run when invoked directly, so the tests can import the pure helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`✗ audit fallito: ${err?.stack || err}`);
    process.exitCode = 1;
  });
}
