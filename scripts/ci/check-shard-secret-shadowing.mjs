/**
 * check-shard-secret-shadowing.mjs — catch a shard deploy key that is defined
 * at TWO secret levels, where the one you edited is not the one CI reads.
 *
 * Why this exists (incident 2026-07-30, deploy run 30522223432). The main repo
 * sits at GitHub's hard cap of 100 Actions secrets per repository, so the
 * `SHARD_{URI,VAUD,VALLESE}_{IT,EN,DE,FR}_DEPLOY_KEY` keys were moved into the
 * `shard-secrets-overflow` ENVIRONMENT, which `deploy.yml`'s `build-locale` job
 * declares in order to see them. GitHub resolves `secrets.X` with the
 * environment level taking PRECEDENCE over the repository level. Consequence:
 *
 *   `uri-it`'s deploy key was broken. A fresh key was generated, verified with
 *   two real commits on the shard repo, and stored as a REPOSITORY-level
 *   `SHARD_URI_IT_DEPLOY_KEY` — which the environment-level secret of the same
 *   name silently shadowed. Every deploy kept using the broken key, kept
 *   emitting only a `::warning::`, and the shard served 3-day-stale HTML while
 *   the deploy run stayed green. The remediation was a no-op that looked done.
 *
 * A name present at both levels is therefore not a harmless duplicate: it is a
 * live trap that makes the next remediation invisible too. This check names the
 * collision and says which level actually wins.
 *
 * Auth: needs a token with ADMIN on the repo (reading secret NAMES — never
 * values — is an admin-only API). `GITHUB_PAT` (Firebase Remote Config, loaded
 * by scripts/load-rc-env.mjs) qualifies; the default `GITHUB_TOKEN` does not.
 *
 * Exit codes: 1 when a collision is found and --strict is passed, else 0 —
 * including on an inconclusive API read (fail open, matching every other
 * watchdog in this repo: an indeterminate result must not page).
 *
 * Usage:
 *   node scripts/ci/check-shard-secret-shadowing.mjs [--strict] [--json]
 */

import { pathToFileURL } from 'node:url';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';

const REPO = process.env.GH_REPO || 'valerielinc-ops/frontaliere-si-o-no';
const API = 'https://api.github.com';

/** GitHub's documented per-repository Actions secret cap. */
export const REPO_SECRET_CAP = 100;

/** A shard push credential — the class of secret this check is about. */
export const SHARD_KEY_RE = /^SHARD_[A-Z0-9]+_(IT|EN|DE|FR)_DEPLOY_KEY$/;

/**
 * Names defined at BOTH the repository level and an environment level. The
 * environment copy always wins, so the repository copy is dead weight that
 * makes editing it a silent no-op.
 *
 * @param {{ repoSecrets: string[], envSecrets: Record<string, string[]> }} input
 * @returns {{ name: string, environment: string, isShardKey: boolean }[]}
 */
export function findShadowedSecrets({ repoSecrets, envSecrets }) {
  const repo = new Set(repoSecrets);
  const out = [];
  for (const [environment, names] of Object.entries(envSecrets || {})) {
    for (const name of names) {
      if (repo.has(name)) {
        out.push({ name, environment, isShardKey: SHARD_KEY_RE.test(name) });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function secretsInventoryToken() {
  return process.env.GITHUB_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
}

async function api(urlPath, token) {
  const res = await fetch(`${API}${urlPath}`, { headers: githubApiHeaders(token) });
  if (!res.ok) throw new Error(`GET ${urlPath} → ${res.status}`);
  return res.json();
}

async function fetchRepoSecretNames(token) {
  const names = [];
  for (let page = 1; page <= 10; page++) {
    const json = await api(`/repos/${REPO}/actions/secrets?per_page=100&page=${page}`, token);
    const batch = (json.secrets || []).map((s) => s.name);
    names.push(...batch);
    if (batch.length < 100) break;
  }
  return names;
}

async function fetchEnvSecretNames(token) {
  const envs = await api(`/repos/${REPO}/environments`, token);
  const byEnv = {};
  for (const env of envs.environments || []) {
    const json = await api(
      `/repos/${REPO}/environments/${encodeURIComponent(env.name)}/secrets?per_page=100`,
      token,
    );
    byEnv[env.name] = (json.secrets || []).map((s) => s.name);
  }
  return byEnv;
}

async function main() {
  const strict = process.argv.includes('--strict');
  const asJson = process.argv.includes('--json');
  const token = secretsInventoryToken();
  if (!token) {
    console.warn('⚠️  no GITHUB_PAT/GH_TOKEN/GITHUB_TOKEN — skipping (fail open)');
    return 0;
  }

  let repoSecrets;
  let envSecrets;
  try {
    repoSecrets = await fetchRepoSecretNames(token);
    envSecrets = await fetchEnvSecretNames(token);
  } catch (err) {
    // 403 here almost always means "token lacks repo admin", not "misconfigured
    // secrets" — an indeterminate read must not page.
    console.warn(`⚠️  secret inventory unavailable (${err.message}) — skipping (fail open)`);
    return 0;
  }

  const shadowed = findShadowedSecrets({ repoSecrets, envSecrets });
  const envTotal = Object.values(envSecrets).reduce((n, v) => n + v.length, 0);

  if (asJson) {
    console.log(JSON.stringify({ repoSecrets: repoSecrets.length, envTotal, shadowed }, null, 2));
  } else {
    console.log(`repo-level secrets: ${repoSecrets.length}/${REPO_SECRET_CAP}`);
    for (const [env, names] of Object.entries(envSecrets)) {
      if (names.length) console.log(`environment ${env}: ${names.length} secret(s)`);
    }
    if (repoSecrets.length >= REPO_SECRET_CAP) {
      console.log(
        `⚠️  repo-level secrets are AT the ${REPO_SECRET_CAP} cap — a new secret cannot be added at repo level; ` +
          'it has to go into an environment the consuming job declares.',
      );
    }
  }

  if (!shadowed.length) {
    console.log('✓ no secret name is defined at both the repository and an environment level');
    return 0;
  }

  for (const s of shadowed) {
    const how = s.isShardKey ? '::error::' : '::warning::';
    console.log(
      `${how}${s.name} is defined BOTH at repo level AND in environment '${s.environment}'. ` +
        `The environment copy WINS for any job declaring 'environment: ${s.environment}' — ` +
        'editing the repo-level copy is a silent no-op. Keep exactly one.',
    );
  }
  return strict && shadowed.some((s) => s.isShardKey) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.warn(`⚠️  check-shard-secret-shadowing crashed: ${err?.message}`);
      process.exit(0); // fail open
    });
}
