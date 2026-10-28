#!/usr/bin/env node
/**
 * Admit the production canary only when no workflow is actively mutating the
 * live site. The canary is a between-deploys observer; probing while a build
 * is uploading CDN assets or Pages is propagating can turn a temporary mixed
 * edge state into a false production outage.
 *
 * The GitHub API read is deliberately fail-closed. An unreadable run list
 * cannot prove that production is idle, so the caller fails instead of
 * running a probe with an unknown deployment state.
 */

import fs from 'node:fs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';

const API = 'https://api.github.com';
const API_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const ACTIVE_STATUSES = Object.freeze(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/**
 * These workflows can change the bytes or edge state served by production.
 * Keep the path and name together: the Actions runs API exposes both, and
 * either one is sufficient to identify a writer when an API representation
 * omits the other field.
 */
export const PRODUCTION_WRITERS = Object.freeze([
  Object.freeze({ path: '.github/workflows/deploy.yml', name: 'Deploy to GitHub Pages' }),
  Object.freeze({ path: '.github/workflows/deploy-publish.yml', name: 'Publish to GitHub Pages (deploy + validate)' }),
  Object.freeze({ path: '.github/workflows/restore-from-artifact.yml', name: 'Restore GitHub Pages from previous artifact' }),
  Object.freeze({ path: '.github/workflows/fast-publish-article.yml', name: 'Fast Publish Article (near-instant single-article shard push)' }),
  Object.freeze({ path: '.github/workflows/runtime-reliability-watch.yml', name: 'Runtime reliability watchdog' }),
]);

const writerPaths = new Set(PRODUCTION_WRITERS.map(({ path }) => path));
const writerNames = new Set(PRODUCTION_WRITERS.map(({ name }) => name));
const activeStatuses = new Set(ACTIVE_STATUSES);

function normalizePath(value) {
  return String(value || '').trim().replace(/^\/+/, '');
}

function runIdentity(run) {
  const path = normalizePath(run?.path);
  const name = String(run?.name || '').trim();
  if (!path && !name) {
    throw new Error(`Active GitHub Actions run ${run?.id ?? '<unknown>'} has no workflow path or name`);
  }
  return { path, name };
}

/**
 * Select active live-site writers from a GitHub Actions run listing.
 *
 * @param {unknown} runs
 * @returns {Array<Record<string, unknown>>}
 */
export function selectActiveProductionWriters(runs) {
  if (!Array.isArray(runs)) throw new Error('GitHub Actions run listing is not an array');

  return runs
    .filter((run) => {
      if (!run || typeof run !== 'object') throw new Error('GitHub Actions run listing contains a malformed run');
      const status = String(run.status || '').trim();
      if (!status) throw new Error(`GitHub Actions run ${run.id ?? '<unknown>'} is missing its status`);
      if (!activeStatuses.has(status)) return false;
      if (!run.id) throw new Error('Active GitHub Actions run is missing its id');
      const { path, name } = runIdentity(run);
      return writerPaths.has(path) || writerNames.has(name);
    });
}

function authToken(token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN required');
  return token;
}

async function readJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: githubApiHeaders(authToken(token)),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub API ${url} → HTTP ${response.status}`);
  const body = await response.json();
  if (!body || !Array.isArray(body.workflow_runs)) {
    throw new Error(`GitHub API ${url} returned no workflow_runs array`);
  }
  if (!Number.isInteger(body.total_count) || body.total_count < 0) {
    throw new Error(`GitHub API ${url} returned an invalid total_count`);
  }
  if (body.workflow_runs.length > PAGE_SIZE) {
    throw new Error(`GitHub API ${url} returned more than ${PAGE_SIZE} workflow runs`);
  }
  return body;
}

async function readStatusRuns({ repository, status, token, fetchImpl }) {
  const runs = [];
  let page = 1;

  while (true) {
    const body = await readJson(
      `${API}/repos/${encodeURIComponent(repository)}/actions/runs?status=${encodeURIComponent(status)}&per_page=${PAGE_SIZE}&page=${page}`,
      token,
      fetchImpl,
    );
    runs.push(...body.workflow_runs);

    if (runs.length >= body.total_count) return runs;
    if (body.workflow_runs.length === 0 || body.workflow_runs.length < PAGE_SIZE) {
      throw new Error(`GitHub API ${status} run listing was truncated (${runs.length}/${body.total_count})`);
    }
    page += 1;
    if (page > MAX_PAGES) {
      throw new Error(`GitHub API ${status} run listing exceeded ${MAX_PAGES} pages`);
    }
  }
}

/**
 * Read all active statuses in parallel and deduplicate runs returned by more
 * than one status query while the API state changes.
 */
export async function readActiveProductionWriters({
  repository,
  token,
  fetchImpl = fetch,
} = {}) {
  if (!repository) throw new Error('GITHUB_REPOSITORY required');

  const batches = await Promise.all(ACTIVE_STATUSES.map((status) => readStatusRuns({
    repository,
    status,
    token,
    fetchImpl,
  })));
  const byId = new Map();
  for (const run of batches.flat()) {
    const selected = selectActiveProductionWriters([run]);
    for (const candidate of selected) byId.set(String(candidate.id), candidate);
  }
  return [...byId.values()];
}

function appendFileIfConfigured(filePath, contents) {
  if (filePath) fs.appendFileSync(filePath, contents);
}

function describeRun(run) {
  const { path, name } = runIdentity(run);
  const label = name || path;
  const url = typeof run.html_url === 'string' ? ` — ${run.html_url}` : '';
  return `- #${run.id}: ${label}${url}`;
}

/**
 * @returns {Promise<number>}
 */
export async function runAdmission({
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  fetchImpl = fetch,
  outputPath = process.env.GITHUB_OUTPUT,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
} = {}) {
  const active = await readActiveProductionWriters({ repository, token, fetchImpl });
  if (active.length > 0) {
    const details = active.map(describeRun).join('\n');
    console.log(`⏭️ Production canary skipped: ${active.length} live-site writer run(s) active.\n${details}`);
    appendFileIfConfigured(outputPath, 'skip_probe=true\n');
    appendFileIfConfigured(summaryPath, `## Production canary admission\n\n**Skipped:** active production writer run(s) detected.\n\n${details}\n`);
    return 0;
  }

  console.log('✅ Production canary admitted: no active live-site writer runs detected.');
  appendFileIfConfigured(outputPath, 'skip_probe=false\n');
  appendFileIfConfigured(summaryPath, '## Production canary admission\n\n**Admitted:** no active live-site writer runs detected.\n');
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  runAdmission()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`::error::Production canary admission failed closed: ${error?.message || error}`);
      process.exitCode = 1;
    });
}
