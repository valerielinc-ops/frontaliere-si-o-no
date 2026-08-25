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
 * @param {ReturnType<typeof findOverlappingCrawlers>} pairs
 * @returns {{ duplicates: typeof pairs, gaps: { key: string, twin: string, missing: string[] }[] }}
 */
export function classifyFindings(pairs) {
  const duplicates = pairs.filter((p) => p.shared.length > 0);
  /** @type {{ key: string, twin: string, missing: string[] }[]} */
  const gaps = [];
  for (const p of duplicates) {
    const totalA = p.shared.length + p.onlyA.length;
    const totalB = p.shared.length + p.onlyB.length;
    // The bigger catalogue is the crawler we would keep; the smaller one is the
    // witness that it is missing something.
    const aIsBigger = totalA >= totalB;
    const keeper = aIsBigger ? p.keys[0] : p.keys[1];
    const witness = aIsBigger ? p.keys[1] : p.keys[0];
    const missing = aIsBigger ? p.onlyB : p.onlyA;
    const smallerTotal = Math.min(totalA, totalB);
    if (!smallerTotal || !missing.length) continue;
    if (p.shared.length / smallerTotal < SAME_SOURCE_CONTAINMENT) continue;
    gaps.push({ key: keeper, twin: witness, missing });
  }
  gaps.sort((x, y) => y.missing.length - x.missing.length || x.key.localeCompare(y.key));
  return { duplicates, gaps };
}

/**
 * @param {ReturnType<typeof classifyFindings>['duplicates']} duplicates
 * @returns {{ title: string, description: string }}
 */
export function duplicateIssue(duplicates) {
  const title = `[duplicate-crawler] ${duplicates.length} coppie di crawler pubblicano le stesse vacancy sotto companyKey diverse`;
  const body = [
    'Rilevato da `scripts/audit-duplicate-crawler-companies.mjs` (audit deterministico, zero Claude).',
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
  return { title, description: body };
}

/**
 * @param {ReturnType<typeof classifyFindings>['gaps']} gaps
 * @returns {{ title: string, description: string }}
 */
export function gapIssue(gaps) {
  const total = gaps.reduce((n, g) => n + g.missing.length, 0);
  const title = `[crawler-coverage-gap] ${total} vacancy viste da un crawler gemello e assenti dal crawler principale`;
  const body = [
    'Rilevato da `scripts/audit-duplicate-crawler-companies.mjs` (audit deterministico, zero Claude).',
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
  return { title, description: body };
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
  const { duplicates, gaps } = classifyFindings(pairs);

  console.log(`slice letti: ${ownership.slices.length}`);
  console.log(`host distinti: ${ownership.byHost.size} (dedicati ${ownership.dedicatedHosts.size}, condivisi ${ownership.sharedHosts.size})`);
  console.log(`coppie che condividono almeno una vacancy: ${duplicates.length}`);
  console.log(`buchi di copertura: ${gaps.length} crawler, ${gaps.reduce((n, g) => n + g.missing.length, 0)} vacancy\n`);

  for (const p of duplicates) {
    console.log(`  DUP  ${p.keys[0]} + ${p.keys[1]} — ${p.shared.length} in comune, ${p.onlyA.length}/${p.onlyB.length} esclusive`);
  }
  for (const g of gaps.slice(0, 20)) {
    console.log(`  GAP  ${g.key} — ${g.missing.length} vacancy viste da ${g.twin}`);
  }

  if (!withIssues) {
    console.log('\n(report-only: passa --issues per aprire/aggiornare le issue di backlog)');
    return;
  }
  if (!duplicates.length && !gaps.length) {
    console.log('\nnessun finding — nessuna issue da aprire.');
    return;
  }

  const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
  if (duplicates.length) {
    const { title, description } = duplicateIssue(duplicates);
    await createGithubIssue({ title, description, priority: 2, labels: ['crawler'], workflow: 'audit-duplicate-crawlers' });
    console.log(`\n→ issue duplicate-identity: ${title}`);
  }
  if (gaps.length) {
    const { title, description } = gapIssue(gaps);
    await createGithubIssue({ title, description, priority: 2, labels: ['crawler'], workflow: 'audit-duplicate-crawlers' });
    console.log(`→ issue coverage-gap: ${title}`);
  }
}

// Only run when invoked directly, so the tests can import the pure helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`✗ audit fallito: ${err?.stack || err}`);
    process.exitCode = 1;
  });
}
