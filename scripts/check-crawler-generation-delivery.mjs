#!/usr/bin/env node
/**
 * Gate: a crawler generation must not lose a delivery.
 *
 * Reads `data/crawler-generation-ledger.jsonl` (one finalizer verdict per
 * group run, token-bound) and the generated roster, picks the newest settled
 * generation (or `--token`), and exits 1 on any delivery fault: a group that
 * is `green_undelivered`, `crawler_failed`, `token_missing`, `not_persisted`
 * or unexpected. A green group run whose commit/receipt never reached `main`
 * is reported as `green_undelivered` instead of disappearing behind a green
 * conclusion.
 *
 * `delivered` still means N/N groups `published` and is always printed as
 * `published=N/M`. A group whose only reason is `wait_failed`
 * (`published_partial`: a minority of members failed their own crawl, every
 * member that crawled delivered) is not a delivery fault: the gate exits 0
 * and prints a warning. Green therefore means "no delivery fault", never
 * "complete generation".
 *
 * Usage:
 *   node scripts/check-crawler-generation-delivery.mjs [--token <token>]
 *     [--ledger <path>] [--roster <path>] [--settle-minutes <n>] [--now <iso>] [--json]
 *
 * Exit: 0 no delivery fault (delivered, or incomplete with a warning), 1 a
 * delivery fault or no settled generation, 2 invalid input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCrawlerGenerationLedgerEntry } from './crawler-group-generation-finalizer.mjs';
import { deriveCrawlerGroupIdsFromGroups } from './lib/crawler-generation-group-ids.mjs';
import {
  DEFAULT_DELIVERY_SETTLE_MS,
  evaluateCrawlerGenerationDelivery,
  formatCrawlerDeliveryMarker,
  formatCrawlerDeliveryMarkdown,
  generationFirstWriteAt,
  selectSettledGenerationToken,
} from './lib/crawler-generation-delivery.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_LEDGER = 'data/crawler-generation-ledger.jsonl';
const DEFAULT_ROSTER = 'scripts/ci/crawler-generation-roster.json';

class InputError extends Error {}

export function parseArgs(argv) {
  const options = { token: null, ledger: DEFAULT_LEDGER, roster: DEFAULT_ROSTER, settleMs: DEFAULT_DELIVERY_SETTLE_MS, now: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new InputError(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--token') options.token = value();
    else if (arg === '--ledger') options.ledger = value();
    else if (arg === '--roster') options.roster = value();
    else if (arg === '--settle-minutes') {
      const minutes = Number(value());
      if (!Number.isFinite(minutes) || minutes < 0) throw new InputError('--settle-minutes must be a non-negative number');
      options.settleMs = minutes * 60 * 1_000;
    } else if (arg === '--now') {
      options.now = Date.parse(value());
      if (Number.isNaN(options.now)) throw new InputError('--now must be an ISO timestamp');
    } else if (arg === '--json') options.json = true;
    else throw new InputError(`Unknown argument: ${arg}`);
  }
  return options;
}

export function readLedgerEntries(ledgerPath) {
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    // No ledger yet means no generation was ever finalized: judge it as empty
    // (no settled generation -> undelivered) instead of crashing before the marker.
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (raw.length > 0 && !raw.endsWith('\n')) throw new InputError('Crawler generation ledger has a partial final record');
  return raw.split('\n').filter((line) => line.length > 0).map((line, index) => {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new InputError(`Ledger line ${index + 1} is not JSON`); }
    const validation = validateCrawlerGenerationLedgerEntry(entry);
    if (!validation.valid) throw new InputError(`Ledger line ${index + 1} is invalid: ${validation.errors.join(', ')}`);
    return entry;
  });
}

/** 0 only for a judged generation without delivery faults; never for "nothing to judge". */
export function crawlerDeliveryGateExitCode(result) {
  return result?.generationToken !== null && result?.generationToken !== undefined
    && result.expectedGroups > 0 && result.deliveryFaults === 0 ? 0 : 1;
}

export function runCrawlerGenerationDeliveryCheck(options, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  // With --json, stdout stays one parseable document; marker and annotation go to stderr.
  const annotate = options.json ? (io.stderr ?? ((text) => process.stderr.write(text))) : stdout;
  const summaryPath = io.summaryPath ?? process.env.GITHUB_STEP_SUMMARY;
  const entries = readLedgerEntries(options.ledger);
  let roster;
  try { roster = JSON.parse(fs.readFileSync(options.roster, 'utf8')); } catch { throw new InputError(`Cannot read roster ${options.roster}`); }
  let expectedGroupIds;
  try { expectedGroupIds = deriveCrawlerGroupIdsFromGroups(roster?.groups); } catch (error) { throw new InputError(`Roster groups invalid: ${error.message}`); }

  let token = options.token;
  let skipped = [];
  let tokenlessSince;
  if (token === null) {
    const selection = selectSettledGenerationToken(entries, {
      now: options.now ?? Date.now(),
      settleMs: options.settleMs,
      minGroups: Math.ceil(expectedGroupIds.length / 2),
    });
    token = selection.token;
    skipped = selection.skipped;
    tokenlessSince = selection.tokenlessSince;
  } else {
    tokenlessSince = generationFirstWriteAt(entries, token);
  }
  const report = evaluateCrawlerGenerationDelivery({ entries, generationToken: token, expectedGroupIds, tokenlessSince });
  const result = { ...report, skippedTokens: skipped };

  if (options.json) stdout(`${JSON.stringify(result, null, 2)}\n`);
  else stdout(formatCrawlerDeliveryMarkdown(report));
  annotate(`${formatCrawlerDeliveryMarker(report)}\n`);
  const publishedOf = `published=${report.counts.published}/${report.expectedGroups}`;
  if (crawlerDeliveryGateExitCode(report) !== 0) {
    const why = token === null
      ? `no settled generation in the ledger (${report.counts.token_missing} group(s) with tokenless records)`
      : `${report.counts.published}/${report.expectedGroups} groups published, ${report.counts.green_undelivered} green run(s) without delivery, ${report.counts.token_missing} without generation token, `
        + `${report.counts.crawler_failed} crawler_failed (wait_failed plus at least one other reason, e.g. a crawl that succeeded left no receipt, half or more of the members failed, no sibling delivered, a crawl outcome unknown/systemic, or a remote/slice fault; see the per-group Reasons column), `
        + `${report.counts.not_persisted} not persisted, ${report.counts.published_partial} published_partial; ${publishedOf} delivery_faults=${report.deliveryFaults}`;
    annotate(`::error title=Crawler generation not delivered::${why}\n`);
  } else if (!report.delivered) {
    const partial = Object.keys(report.groups).sort()
      .filter((group) => report.groups[group].state === 'published_partial')
      .map((group) => `${group} (run ${report.groups[group].callerRunId ?? 'unknown'})`);
    annotate(`::warning title=Crawler generation incomplete::${publishedOf} published_partial=${report.counts.published_partial} `
      + `delivery_faults=0 delivered=false; partial groups: ${partial.join(', ')}. `
      + 'No delivery fault, but the generation is not complete: the group wait failed while every member that crawled delivered.\n');
  }
  if (summaryPath) {
    try { fs.appendFileSync(summaryPath, formatCrawlerDeliveryMarkdown(report)); } catch { /* summary is best-effort */ }
  }
  return result;
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    const result = runCrawlerGenerationDeliveryCheck(parseArgs(process.argv.slice(2)));
    process.exitCode = crawlerDeliveryGateExitCode(result);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof InputError ? 2 : 1;
  }
}
