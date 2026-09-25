#!/usr/bin/env node
/**
 * scripts/reconcile-fast-publish-articles.mjs — issue #4837 stream C
 *
 * Closes the "flicker race": a full deploy.yml build can start BEFORE a new
 * article's commit lands on main. That build's own full-replace shard push
 * (scripts/lib/push-section-shard.sh) then overwrites whatever
 * fast-publish-article.yml had already pushed for that article — the
 * build's dist/ doesn't contain the new article yet — leaving the article
 * missing from its shard until the NEXT full deploy happens to notice it.
 *
 * This script compares the article registries (data/blog-articles-data.ts,
 * data/swiss-articles-data.ts) as they existed at the just-completed
 * deploy's build SHA vs. current main HEAD, and re-dispatches
 * fast-publish-article.yml for every article id that is new since the
 * build. Idempotent: if nothing is new, it's a clean no-op.
 *
 * Uses the GitHub REST Contents API (not git clone/fetch) to read both file
 * versions — deliberate: this repo's .git object store is large/slow to
 * clone (docs/AGENTS-HISTORY.md#git-repo-maintenance), and this reconciler
 * only ever needs two small text files, not the whole tree.
 *
 * Env:
 *   GITHUB_REPOSITORY      — owner/repo (auto-set in Actions)
 *   BUILD_SHA              — SHA the just-completed deploy build ran against
 *                             (github.event.workflow_run.head_sha)
 *   GITHUB_PAT or GH_TOKEN — token (Contents API read + workflow dispatch;
 *                             GITHUB_TOKEN cannot dispatch other workflows —
 *                             GitHub anti-recursion rule)
 *   ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP / ARTICOLISVIZZERA_BUILD_EMIT_SKIP —
 *                             issue #4881 Fase 5. When a section's flag is
 *                             'true', deploy.yml's full build never emits
 *                             that section into dist/ AND excludes it from
 *                             the full-replace push loop entirely (same
 *                             two repo variables gate both, in lockstep —
 *                             see ogPagesPlugin.ts's closeBundle docblock).
 *                             This reconciler's entire premise — a full
 *                             deploy's OWN push overwriting a fast-published
 *                             article because the build raced ahead of it —
 *                             cannot occur for a section the full deploy
 *                             never pushes at all, so that registry is
 *                             skipped rather than dispatching a no-op
 *                             re-publish. Default (unset) = unchanged
 *                             legacy behavior for both registries.
 *
 * Exit codes: always 0 — best-effort. A failed re-dispatch just means the
 * article waits for the NEXT full deploy to pick it up, exactly the
 * behavior that existed before this reconciler — never worth failing the
 * job over.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY || '';
const BUILD_SHA = (process.env.BUILD_SHA || '').trim();
const TOKEN = process.env.GITHUB_PAT || process.env.GH_TOKEN || '';
const API_VERSION = '2022-11-28';

const REGISTRIES = [
  { file: 'data/blog-articles-data.ts', section: 'frontaliere', buildEmitSkipEnv: 'ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP' },
  { file: 'data/swiss-articles-data.ts', section: 'svizzera', buildEmitSkipEnv: 'ARTICOLISVIZZERA_BUILD_EMIT_SKIP' },
];

function extractArticleIds(source) {
  const ids = new Set();
  const rx = /\bid:\s*'([^']+)'/g;
  let match;
  while ((match = rx.exec(source))) ids.add(match[1]);
  return ids;
}

async function fetchFileAt(filePath, ref) {
  const url = `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'FrontaliereTicino-FastPublishReconcile/1.0 (+https://frontaliereticino.ch)',
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${filePath}@${ref} → HTTP ${res.status}`);
  }
  return res.text();
}

async function readRefSha(ref) {
  const url = `https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'FrontaliereTicino-FastPublishReconcile/1.0 (+https://frontaliereticino.ch)',
    },
  });
  if (!res.ok) throw new Error(`GET commits/${ref} → HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.sha !== 'string') throw new Error(`commits/${ref} response missing .sha`);
  return data.sha;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function dispatchFastPublish(articleId, section, sha) {
  const inputsJson = JSON.stringify({ article_id: articleId, section, sha });
  console.log(`🚀 Re-dispatching fast-publish-article.yml for '${articleId}' (section=${section}, sha=${sha})`);
  try {
    execFileSync(
      'bash',
      [path.join(scriptDir, 'lib', 'trigger-workflow.sh'), 'fast-publish-article.yml', inputsJson],
      { stdio: 'inherit', env: { ...process.env, TRIGGER_REF: 'main' } },
    );
  } catch (error) {
    console.warn(`⚠️ Re-dispatch failed for '${articleId}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  if (!REPO) {
    console.error('❌ GITHUB_REPOSITORY not set — cannot reconcile.');
    process.exit(0);
  }
  if (!BUILD_SHA) {
    console.log('ℹ️ No BUILD_SHA provided (github.event.workflow_run.head_sha empty) — nothing to compare against, no-op.');
    process.exit(0);
  }
  if (!TOKEN) {
    console.log('ℹ️ No GITHUB_PAT or GH_TOKEN — skipping reconciliation (cannot read Contents API / dispatch).');
    process.exit(0);
  }

  let currentSha;
  try {
    currentSha = await readRefSha('main');
  } catch (error) {
    console.warn(`⚠️ Could not resolve current main SHA — skipping reconciliation: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);
  }

  if (currentSha === BUILD_SHA) {
    console.log(`✅ main is still at the deploy's build SHA (${BUILD_SHA}) — nothing landed since, no-op.`);
    process.exit(0);
  }

  console.log(`🔍 Comparing article registries: build=${BUILD_SHA} vs current=${currentSha}`);

  let totalNew = 0;
  for (const { file, section, buildEmitSkipEnv } of REGISTRIES) {
    // Issue #4881 Fase 5: once the full build no longer emits (and
    // deploy.yml's full-replace push loop no longer touches) this section
    // at all, there is no "flicker race" left for this registry — the
    // fast-publish shard push is the section's ONLY writer, so re-dispatch
    // would just be a redundant no-op push. See file header for the full
    // rationale.
    if (process.env[buildEmitSkipEnv] === 'true') {
      console.log(`✅ ${file}: ${buildEmitSkipEnv}=true — full deploy no longer pushes this section, no race to reconcile — skipping.`);
      continue;
    }
    let buildContent;
    let currentContent;
    try {
      [buildContent, currentContent] = await Promise.all([
        fetchFileAt(file, BUILD_SHA),
        fetchFileAt(file, currentSha),
      ]);
    } catch (error) {
      console.warn(`⚠️ Could not fetch ${file} at both SHAs — skipping this registry: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const buildIds = extractArticleIds(buildContent);
    const currentIds = extractArticleIds(currentContent);
    const newIds = [...currentIds].filter((id) => !buildIds.has(id));

    if (newIds.length === 0) {
      console.log(`✅ ${file}: no new article ids since the build — no-op.`);
      continue;
    }

    console.log(`📰 ${file}: ${newIds.length} new article id(s) since the build: ${newIds.join(', ')}`);
    totalNew += newIds.length;
    for (const id of newIds) {
      dispatchFastPublish(id, section, currentSha);
    }
  }

  if (totalNew === 0) {
    console.log('✅ Reconciliation complete — no articles needed backfill.');
  } else {
    console.log(`✅ Reconciliation complete — re-dispatched fast-publish for ${totalNew} article(s).`);
  }
}

main().catch((error) => {
  console.error(`❌ Unexpected reconciler error (non-fatal, exiting 0): ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(0);
});
