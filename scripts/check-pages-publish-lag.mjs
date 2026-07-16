/**
 * check-pages-publish-lag.mjs — Watchdog for the deploy→PUBLISH gap.
 *
 * `deploy.yml` only BUILDS and uploads a `github-pages` artifact. A separate
 * workflow, `deploy-publish.yml` (triggered via `workflow_run` on deploy.yml
 * completion), does the actual `actions/deploy-pages` PUBLISH, under
 * `concurrency: { group: pages-deploy, cancel-in-progress: false }`. Per
 * GitHub's documented 1-running+1-pending cap for a concurrency group, a
 * burst of push-triggered build completions (bot articles, jobs-sync,
 * dist-history-append commits...) routinely supersedes/skips most pending
 * publish attempts before `actions/deploy-pages` ever runs — deploy-
 * starvation, the same failure class `deploy.yml`'s own `paths-ignore`
 * comment names and partially mitigates.
 *
 * Content is not permanently lost — a later successful publish carries every
 * earlier commit forward, since main is linear — but it can sit
 * built-and-not-yet-live for hours with zero visibility. That's exactly what
 * happened 2026-07-16: two published articles weren't visible for several
 * hours and only surfaced because a journalist personally asked, instead of
 * being caught by automation before anyone had to notice.
 *
 * This watchdog finds the last successful `github-pages` deployment (GitHub
 * Deployments API) and lists the files changed on `main` since that SHA. It
 * ignores exactly the paths `deploy.yml` itself ignores (parsed directly from
 * that file, not re-declared, so the two can never drift apart — AGENTS.md
 * #6). If real dist-affecting content has been waiting longer than the
 * threshold, it pages.
 *
 * Exit code: non-zero if lag exceeds threshold; 0 otherwise (including on
 * inconclusive API results — fail open, matching the rest of this repo's
 * watchdogs: an indeterminate read must not page).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubApiHeaders } from './lib/githubApiHeaders.mjs';

const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const API = 'https://api.github.com';
const DEFAULT_LAG_HOURS = 4;

// ── Pure logic (unit-tested; NO network/IO) ─────────────────────────

/**
 * Extract the `paths-ignore` glob list from deploy.yml's raw YAML text.
 * Deliberately NOT a full YAML parser: the block is a flat `- 'glob'` list
 * under a `paths-ignore:` key, and reading it as text keeps this script from
 * ever re-declaring (and drifting from) deploy.yml's own copy.
 * @param {string} yamlText
 * @returns {string[]}
 */
export function parsePathsIgnore(yamlText) {
  const lines = yamlText.split('\n');
  const startIdx = lines.findIndex((l) => /^\s*paths-ignore:\s*$/.test(l));
  if (startIdx === -1) return [];
  const globs = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*'([^']+)'\s*$/);
    if (!m) break;
    globs.push(m[1]);
  }
  return globs;
}

/**
 * Minimal glob → RegExp. A double-star crosses directories, a single `*`
 * does not (stops at `/`). A bare pattern with no `/` (e.g. `*.md`) matches
 * only at the repo root, mirroring deploy.yml's own documented intent (root
 * `*.md` vs a recursive `docs` glob, deliberately not a recursive `*.md` —
 * see that file's comment on why press-kit assets under public/ must stay
 * dist-bound).
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string} filePath
 * @param {string[]} globs
 * @returns {boolean}
 */
export function isIgnoredPath(filePath, globs) {
  return globs.some((g) => globToRegExp(g).test(filePath));
}

/**
 * @param {string[]} changedFiles
 * @param {string[]} globs
 * @returns {string[]} files NOT covered by any ignore glob
 */
export function filterUnignored(changedFiles, globs) {
  return changedFiles.filter((f) => !isIgnoredPath(f, globs));
}

// ── Network (not unit-tested; exercised live) ───────────────────────

function authToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN required');
  return token;
}

async function ghJson(urlPath) {
  const res = await fetch(`${API}${urlPath}`, { headers: githubApiHeaders(authToken()) });
  if (!res.ok) throw new Error(`GitHub API ${urlPath} → HTTP ${res.status}`);
  return res.json();
}

/** Newest-first deployments; returns the first one whose latest status is `success`. */
async function findLastSuccessfulDeployment() {
  const deployments = await ghJson(`/repos/${REPO}/deployments?environment=github-pages&per_page=10`);
  for (const d of deployments) {
    const statuses = await ghJson(`/repos/${REPO}/deployments/${d.id}/statuses?per_page=5`);
    if (statuses[0]?.state === 'success') {
      return { sha: d.sha, publishedAt: statuses[0].created_at };
    }
  }
  return null;
}

async function getChangedFilesSince(baseSha, headRef) {
  const compare = await ghJson(`/repos/${REPO}/compare/${baseSha}...${headRef}`);
  return (compare.files || []).map((f) => f.filename);
}

// ── Orchestration ───────────────────────────────────────────────────

async function main() {
  const lagHours = Number(process.env.LAG_HOURS || DEFAULT_LAG_HOURS);

  const deployYmlPath = path.resolve(process.cwd(), '.github/workflows/deploy.yml');
  const globs = parsePathsIgnore(fs.readFileSync(deployYmlPath, 'utf8'));
  if (globs.length === 0) {
    console.log('⚠️ Could not parse paths-ignore from deploy.yml — skipping (fail open)');
    process.exit(0);
  }

  const last = await findLastSuccessfulDeployment();
  if (!last) {
    console.log('⚠️ No successful github-pages deployment found in the last 10 — skipping (fail open)');
    process.exit(0);
  }

  const ageMinutes = Math.round((Date.now() - Date.parse(last.publishedAt)) / 60000);
  const changed = await getChangedFilesSince(last.sha, 'main');
  const pending = filterUnignored(changed, globs);

  console.log('── Pages publish-lag report ──');
  console.log(`Last successful publish: ${last.sha.slice(0, 10)} at ${last.publishedAt} (${ageMinutes} min ago)`);
  console.log(`Dist-affecting file(s) changed on main since then: ${pending.length} (of ${changed.length} total)`);
  if (pending.length > 0) {
    console.log('Sample pending paths:');
    for (const f of pending.slice(0, 15)) console.log(`  - ${f}`);
  }
  console.log('────────────────────────────────');

  const thresholdMin = lagHours * 60;
  if (pending.length > 0 && ageMinutes > thresholdMin) {
    console.log(
      `❌ DEGRADED — ${pending.length} dist-affecting file(s) built but not live for ${ageMinutes} min (threshold ${thresholdMin} min / ${lagHours}h).`,
    );
    if (process.env.GITHUB_OUTPUT) {
      const summary = [
        `Last successful GitHub Pages publish: ${last.sha.slice(0, 10)} at ${last.publishedAt} (${ageMinutes} min ago, threshold ${thresholdMin} min / ${lagHours}h).`,
        `${pending.length} dist-affecting file(s) changed on main since then and are NOT yet confirmed live:`,
        ...pending.slice(0, 20).map((f) => `- ${f}`),
        pending.length > 20 ? `...and ${pending.length - 20} more.` : '',
      ]
        .filter(Boolean)
        .join('\n')
        .split('"')
        .join("'")
        .split(String.fromCharCode(96))
        .join("'");
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary<<EOF_SUMMARY\n${summary}\nEOF_SUMMARY\n`);
    }
    process.exit(1);
  }

  console.log(`✅ HEALTHY — last publish ${ageMinutes} min ago, ${pending.length} dist-affecting file(s) pending (within threshold).`);
  process.exit(0);
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[check-pages-publish-lag] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
