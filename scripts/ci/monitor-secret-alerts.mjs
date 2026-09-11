#!/usr/bin/env node
/**
 * Sweep open GitHub secret-scanning alerts for every repository owned by one
 * GitHub account. The script prints repository/alert metadata only — never the
 * detected value or a location that could contain it.
 *
 * Usage:
 *   SECRET_SCAN_OWNER=valerielinc-ops SECRET_SCAN_TOKEN=... \
 *     node scripts/ci/monitor-secret-alerts.mjs
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_API_URL = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export function parseRepositoryAllowlist(value = '') {
  return new Set(
    String(value)
      .split(',')
      .map((repository) => repository.trim())
      .filter(Boolean),
  );
}

function createClient({ token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  if (!token) throw new Error('SECRET_SCAN_TOKEN/GH_TOKEN mancante');

  return {
    async get(path) {
      const response = await fetchImpl(new URL(path, apiUrl), {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
        },
      });
      if (!response.ok) {
        const error = new Error(`GitHub API ${response.status} su ${path}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    },
  };
}

export async function listOwnerRepos(client, owner) {
  const repos = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await client.get(
      `/user/repos?affiliation=owner&visibility=all&per_page=100&page=${page}&sort=full_name`,
    );
    if (!Array.isArray(result)) throw new Error(`GitHub API: elenco repo non valido per ${owner}`);
    for (const repo of result) {
      const repositoryOwner = repo?.owner?.login || String(repo?.full_name || '').split('/')[0];
      if (repositoryOwner === owner) repos.push(repo);
    }
    if (result.length < 100) return repos;
  }
  throw new Error(`GitHub API: oltre 100 pagine repo per ${owner}`);
}

async function listOpenAlerts(client, fullName) {
  const alerts = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await client.get(
      `/repos/${fullName}/secret-scanning/alerts?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(result)) throw new Error(`GitHub API: alert non valido per ${fullName}`);
    alerts.push(...result);
    if (result.length < 100) return alerts;
  }
  throw new Error(`GitHub API: oltre 100 pagine alert per ${fullName}`);
}

export async function sweepOwner({ owner, token, apiUrl, fetchImpl = fetch }) {
  if (!owner) throw new Error('SECRET_SCAN_OWNER mancante');
  const client = createClient({ token, apiUrl, fetchImpl });
  const identity = await client.get('/user');
  if (identity?.login !== owner) {
    throw new Error(`Token GitHub autenticato come ${identity?.login || 'sconosciuto'}, non come ${owner}`);
  }
  const repos = await listOwnerRepos(client, owner);
  const openAlerts = [];
  const unavailable = [];

  for (const repo of repos) {
    const fullName = repo.full_name || `${owner}/${repo.name}`;
    try {
      const alerts = await listOpenAlerts(client, fullName);
      for (const alert of alerts) {
        openAlerts.push({
          repository: fullName,
          number: alert.number,
          type: alert.secret_type_display_name || alert.secret_type || 'unknown',
          createdAt: alert.created_at || null,
        });
      }
    } catch (error) {
      // 404 means secret scanning is disabled or unavailable for this repo. It
      // is reported explicitly so the sweep cannot silently claim full cover.
      if (error.status === 404) {
        unavailable.push(fullName);
        continue;
      }
      throw error;
    }
  }

  return { owner, repositories: repos.length, openAlerts, unavailable };
}

export async function runSweep({
  owner,
  token,
  apiUrl,
  fetchImpl = fetch,
  allowedUnavailable = process.env.SECRET_SCAN_ALLOWED_UNAVAILABLE,
  failOnUnavailable = process.env.SECRET_SCAN_FAIL_ON_UNAVAILABLE === 'true',
} = {}) {
  const result = await sweepOwner({
    owner: owner || process.env.SECRET_SCAN_OWNER,
    token: token || process.env.SECRET_SCAN_TOKEN || process.env.GH_TOKEN,
    apiUrl: apiUrl || process.env.GITHUB_API_URL || DEFAULT_API_URL,
    fetchImpl,
  });

  const observed = result.repositories - result.unavailable.length;
  const allowlist = parseRepositoryAllowlist(allowedUnavailable);
  const unexpectedUnavailable = result.unavailable.filter(
    (repository) => !allowlist.has(repository),
  );
  process.stdout.write(
    `[secret-alert-sweep] ${result.owner}: ${result.repositories} repo, `
    + `${observed} osservati, ${result.unavailable.length} non monitorabili, `
    + `${result.openAlerts.length} alert aperti.\n`,
  );
  for (const repository of result.unavailable) {
    const suffix = allowlist.has(repository) ? ' (gap noto e dichiarato)' : '';
    process.stderr.write(`[secret-alert-sweep] secret scanning non disponibile: ${repository}${suffix}\n`);
  }
  for (const alert of result.openAlerts) {
    process.stderr.write(
      `[secret-alert-sweep] ALERT ${alert.repository}#${alert.number} — ${alert.type}`
      + `${alert.createdAt ? ` (creato ${alert.createdAt})` : ''}\n`,
    );
  }

  if (result.openAlerts.length) {
    const error = new Error(`${result.openAlerts.length} alert secret-scanning aperti`);
    error.code = 'OPEN_SECRET_ALERTS';
    throw error;
  }
  if (unexpectedUnavailable.length && failOnUnavailable) {
    const error = new Error(`${unexpectedUnavailable.length} repo senza secret scanning monitorabile`);
    error.code = 'UNMONITORED_REPOSITORIES';
    throw error;
  }
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runSweep().catch((error) => {
    process.stderr.write(`[secret-alert-sweep] fallimento: ${error.message}\n`);
    process.exitCode = error.code === 'OPEN_SECRET_ALERTS' || error.code === 'UNMONITORED_REPOSITORIES' ? 1 : 2;
  });
}
