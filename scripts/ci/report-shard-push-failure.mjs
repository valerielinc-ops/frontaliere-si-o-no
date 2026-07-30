/**
 * report-shard-push-failure.mjs — turn a failed shard push into ONE deduplicated
 * issue per locale instead of a `::warning::` nobody reads.
 *
 * Why (incident 2026-07-30, deploy run 30522223432): `uri-it`'s push failed on
 * every deploy for 3 days with "Permission to …frontaliere-uri-it.git denied to
 * deploy key". The step is `continue-on-error: true` on purpose — one broken
 * shard must not abort the other 26 nor the deploy — so the only trace was a
 * red sub-step inside a green run, and the shard kept serving stale HTML. The
 * tolerance is right; the silence was the defect (AGENTS.md: never silent-ignore).
 *
 * ONE issue per (locale, run) with a stable title, not one per shard: a
 * platform-wide hiccup would otherwise file 27 issues at once. Repeat failures
 * dedup onto the same issue as comments (github-issue-creator.mjs matches on the
 * first 60 title chars), so the issue doubles as the "still broken" log.
 *
 * Usage:
 *   node scripts/ci/report-shard-push-failure.mjs --locale it --shards uri,vaud
 */

import { pathToFileURL } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * @param {{ locale: string, shards: string[], runUrl?: string }} input
 * @returns {{ title: string, description: string }}
 */
export function buildFailureIssue({ locale, shards, runUrl }) {
  const list = shards.map((s) => `- \`${s}-${locale}\``).join('\n');
  return {
    // Stable across runs → dedup key. No run id / timestamp in the first 60 chars.
    title: `Shard push failed (${locale}): section shard(s) not published`,
    description: [
      `## 🔴 Push dello shard fallito — locale \`${locale}\``,
      '',
      'Shard che NON sono stati pubblicati in questo deploy:',
      '',
      list,
      '',
      // null, not '': the filter below drops only the absent run line. Dropping
      // every empty string would strip the blank lines markdown needs, and the
      // bullet list would swallow the paragraph after it.
      runUrl ? `Run: ${runUrl}` : null,
      '',
      '### Conseguenza',
      'Il sottoalbero resta in `dist/` (nessun 404), ma lo shard continua a servire',
      'la versione precedente: le pagine di quella sezione **invecchiano a ogni deploy**',
      'finché il push non torna a funzionare.',
      '',
      '### Cosa guardare, in ordine',
      '1. **Auth**: `denied to deploy key` / `Permission denied (publickey)` → la deploy key',
      '   di quel repo shard è read-only, revocata, o il secret è **shadowato**',
      '   (repo-level vs environment `shard-secrets-overflow`, dove vince l’environment).',
      '   Verifica con `node scripts/ci/check-shard-secret-shadowing.mjs --strict`.',
      '   Da 2026-07-30 il push ritenta automaticamente via PAT (HTTPS) quando la key',
      '   fallisce: se questa issue esiste, **anche il fallback PAT ha fallito**.',
      '2. **Owner del repo shard**: `gh api repos/<owner>/frontaliere-<section>-<locale> --jq .full_name`',
      '   — il path vecchio resta vivo per redirect dopo un transfer, quindi non dedurre',
      '   l’owner dal fatto che una URL risponda (`scripts/lib/section-shard-owners.json`).',
      '3. **Shrink guard**: `would shrink N -> M files` → è la build che ha smesso di',
      '   emettere la sezione, non il push. Non forzare l’override senza aver capito perché.',
      '',
      '_Filed automatically by deploy.yml (section shard push step)._',
    ]
      .filter((l) => l !== null)
      .join('\n'),
  };
}

async function main() {
  const locale = arg('locale');
  const shards = (arg('shards') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!locale || !shards.length) {
    console.warn('⚠️  --locale and --shards are required — nothing to report');
    return 0;
  }
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;

  const { title, description } = buildFailureIssue({ locale, shards, runUrl });
  await createGithubIssue({
    title,
    description,
    priority: 2,
    labels: ['automation'],
    workflow: 'Deploy to GitHub Pages',
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Never let issue filing turn a tolerated shard failure into a hard stop.
      console.warn(`⚠️  report-shard-push-failure failed: ${err?.message}`);
      process.exit(0);
    });
}
