#!/usr/bin/env node

/**
 * Durable handoff state for the build -> shard/Pages publisher.
 *
 * Artifacts describe what a particular Actions run produced, but they are not
 * an idempotency record for a later retry. These commit statuses are keyed by
 * the immutable source SHA and a source run id, so a retry can prove that a
 * locale shard or the Pages deployment already succeeded without looking at
 * the aggregate conclusion of the old publish run.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const PAGES_RECEIPT_PREFIX = 'frontaliere/pages-deployed';
export const LOCALE_RECEIPT_PREFIX = 'frontaliere/shard-published';

const SHA_RE = /^[0-9a-f]{40}$/i;
const RUN_ID_RE = /^\d+$/;
const STATUS_SUCCESS = 'success';

function text(value) {
  return value == null ? '' : String(value).trim();
}

function validateRunId(sourceRunId) {
  const value = text(sourceRunId);
  return RUN_ID_RE.test(value) ? value : '';
}

function validateSha(sourceSha) {
  const value = text(sourceSha);
  return SHA_RE.test(value) ? value : '';
}

export function pagesReceiptContext(sourceRunId) {
  const runId = validateRunId(sourceRunId);
  return runId ? `${PAGES_RECEIPT_PREFIX}/${runId}` : '';
}

export function localeReceiptContext(sourceRunId, locale) {
  const runId = validateRunId(sourceRunId);
  const normalizedLocale = text(locale).toLowerCase();
  return runId && LOCALES.includes(normalizedLocale)
    ? `${LOCALE_RECEIPT_PREFIX}/${runId}/${normalizedLocale}`
    : '';
}

function statusContext(status) {
  return text(status?.context);
}

function statusSucceeded(status, context) {
  return statusContext(status) === context && text(status?.state).toLowerCase() === STATUS_SUCCESS;
}

/**
 * Resolve the durable state for one source run from the commit status list.
 * Unknown/malformed status entries are ignored; absence is deliberately not
 * treated as success.
 */
export function resolvePublishReceipts({ statuses = [], sourceRunId, locales = LOCALES } = {}) {
  const entries = Array.isArray(statuses) ? statuses : [];
  const pagesContext = pagesReceiptContext(sourceRunId);
  const requestedLocales = [...new Set(
    (Array.isArray(locales) ? locales : [])
      .map((locale) => text(locale).toLowerCase())
      .filter((locale) => LOCALES.includes(locale)),
  )];
  const publishedLocales = requestedLocales.filter((locale) => entries.some((status) => statusSucceeded(
    status,
    localeReceiptContext(sourceRunId, locale),
  )));
  const pendingLocales = requestedLocales.filter((locale) => !publishedLocales.includes(locale));
  return {
    pagesDeployed: Boolean(pagesContext && entries.some((status) => statusSucceeded(status, pagesContext))),
    publishedLocales,
    pendingLocales,
    pagesContext,
    localeContexts: Object.fromEntries(requestedLocales.map((locale) => [
      locale,
      localeReceiptContext(sourceRunId, locale),
    ])),
  };
}

function requireWorkflowContext() {
  const repo = text(process.env.GITHUB_REPOSITORY);
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY is missing or malformed');
  const token = text(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN required');
  return { repo, token };
}

function gh(args, { maxBuffer = 2 * 1024 * 1024 } = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  }).trim();
}

function listStatuses(repo, sourceSha) {
  const sha = validateSha(sourceSha);
  if (!sha) throw new Error('source SHA is missing or malformed');
  // A long-lived commit can accumulate more than one page of statuses after
  // the receipt was written. `--paginate --slurp` keeps the durable marker
  // readable instead of silently losing it behind the newest 100 entries.
  const raw = gh(['api', '--paginate', '--slurp', `repos/${repo}/commits/${sha}/statuses?per_page=100`]);
  const pages = JSON.parse(raw || '[]');
  if (!Array.isArray(pages)) throw new Error('commit status response is malformed');
  const statuses = pages.flatMap((page) => {
    if (!Array.isArray(page)) throw new Error('commit status page is malformed');
    return page;
  });
  return statuses;
}

function writeGithubOutputs(file, state) {
  if (!file) return;
  const lines = [
    `pages_deployed=${state.pagesDeployed}`,
    `published_locales=${JSON.stringify(state.publishedLocales)}`,
    `published_locales_csv=${state.publishedLocales.join(',')}`,
    `pending_locales=${JSON.stringify(state.pendingLocales)}`,
    `pending_locales_csv=${state.pendingLocales.join(',')}`,
    `pages_context=${state.pagesContext}`,
  ];
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

function writeReceipt({ kind, sourceRunId, sourceSha, locale }) {
  const { repo } = requireWorkflowContext();
  const runId = validateRunId(sourceRunId);
  const sha = validateSha(sourceSha);
  if (!runId) throw new Error('source run id is missing or malformed');
  if (!sha) throw new Error('source SHA is missing or malformed');
  const context = kind === 'pages'
    ? pagesReceiptContext(runId)
    : localeReceiptContext(runId, locale);
  if (!context) throw new Error(`unsupported receipt kind/locale: ${kind}/${locale || ''}`);
  const normalizedLocale = text(locale).toLowerCase();
  const description = kind === 'pages'
    ? `Pages deploy succeeded for source run ${runId}`
    : `Shard push succeeded for ${normalizedLocale} source run ${runId}`;
  const targetUrl = `https://github.com/${repo}/actions/runs/${runId}`;
  gh([
    'api',
    '--method', 'POST',
    `repos/${repo}/statuses/${sha}`,
    '--field', `state=${STATUS_SUCCESS}`,
    '--field', `context=${context}`,
    '--field', `description=${description}`,
    '--field', `target_url=${targetUrl}`,
  ]);
  console.log(JSON.stringify({ kind, sourceRunId: runId, sourceSha: sha, locale: normalizedLocale || null, context }));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    args[key] = argv[index + 1]?.startsWith('--') ? true : (argv[index + 1] ?? true);
    if (args[key] !== true) index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.resolve) {
    const { repo } = requireWorkflowContext();
    const sourceRunId = validateRunId(args['source-run-id']);
    if (!sourceRunId) throw new Error('source run id is missing or malformed');
    const state = resolvePublishReceipts({
      statuses: listStatuses(repo, args['source-sha']),
      sourceRunId,
      locales: args.locales === undefined || args.locales === true
        ? LOCALES
        : String(args.locales).split(','),
    });
    writeGithubOutputs(args['github-output'], state);
    console.log(JSON.stringify(state));
    return;
  }
  if (args.write) {
    writeReceipt({
      kind: text(args.write),
      sourceRunId: args['source-run-id'],
      sourceSha: args['source-sha'],
      locale: args.locale,
    });
    return;
  }
  console.error('Usage: publish-receipts.mjs --resolve --source-run-id <id> --source-sha <sha> [--github-output <file>] | --write pages|locale --source-run-id <id> --source-sha <sha> [--locale <locale>]');
  process.exitCode = 2;
}

if (process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})()) {
  try {
    main();
  } catch (error) {
    console.error(`::error::publish receipt failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
