/**
 * mergePreviewCheck.mjs — merge-preview duplicate-declaration gate (#5215).
 *
 * Root cause of #5215: #5187 and #5170 each added the SAME helper to
 * DIFFERENT line ranges of `build-plugins/constants.ts`, independently, on a
 * base that didn't contain the other. Neither PR's own vitest run could ever
 * see the collision — each was green against a base that didn't contain the
 * other's addition. Git merged the two additions with NO conflict (different
 * line ranges), and esbuild rejected the resulting module (duplicate
 * top-level binding). The ancestry-only `collision-risk` gate (#2424,
 * `collisionGateDecision` in `auto-merge-eval.mjs`) cannot catch this class:
 * it only checks whether a merged PEER's commit is an ancestor of head, not
 * whether the RESULT of combining them still parses.
 *
 * This builds the REAL merge tree of the PR head into the CURRENT main tip
 * (read fresh by the caller right before merge, not a value cached earlier
 * in the gate evaluation — narrows, doesn't eliminate, the TOCTOU window)
 * via `git merge-tree --write-tree`, purely as an in-memory object-database
 * operation — no working-tree/index mutation, no checkout, no `npm run
 * build`. For every `build-plugins/**` file present in the resulting tree it
 * re-runs the AST duplicate-top-level-binding detector added in #5212
 * (`duplicateDeclarations.mjs`, shared — not re-implemented here).
 *
 * Deliberately narrow, matching the issue's own cost/benefit framing
 * ("un check di merge-preview... molto più economico di una suite completa,
 * coglie esattamente questa classe"): scoped to `build-plugins/**` (where
 * the incident happened and where the AST checker already exists), and
 * best-effort — any failure to fetch/resolve the three commit objects
 * (network, or a merge-base older than what's practical to fetch by exact
 * SHA) SKIPS the check (`ok: true`) rather than blocking merge, so a
 * best-effort extra gate can never starve an unrelated PR. The existing
 * LGTM + vitest + collision gates remain the primary safety net.
 */
import { execFileSync } from 'node:child_process';
import { findDuplicateTopLevelNames } from './duplicateDeclarations.mjs';

const CHECKED_PATH_RE = /^build-plugins\/(shared\/)?[^/]+\.m?ts$/;

/** True for the same file set `tests/build-plugins-no-duplicate-declarations.test.ts` checks. */
export function isMergePreviewCheckedPath(path) {
  return CHECKED_PATH_RE.test(path);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fetchShaQuiet(sha) {
  try {
    git(['fetch', '--depth=1', 'origin', sha]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ headSha: string, baseSha: string, mergeBaseSha: string }} args
 *   `baseSha` = current main tip (caller reads it FRESH, right before this
 *   call). `mergeBaseSha` = merge-base of baseSha and headSha (e.g. from the
 *   GitHub compare API — avoids needing local history deep enough to compute
 *   it via `git merge-base`).
 * @returns {{ ok: boolean, reason: string, dupesByFile?: Record<string,string[]> }}
 */
export function checkMergePreviewDuplicates({ headSha, baseSha, mergeBaseSha }) {
  if (!headSha || !baseSha || !mergeBaseSha) {
    return { ok: true, reason: 'merge-preview: sha mancante (head/base/merge-base) — skip conservativo' };
  }

  for (const sha of new Set([headSha, baseSha, mergeBaseSha])) {
    if (!fetchShaQuiet(sha)) {
      return { ok: true, reason: `merge-preview: impossibile fetchare ${sha.slice(0, 12)} (rete o sha non raggiungibile per hash esatto) — skip, non blocca` };
    }
  }

  let tree;
  try {
    tree = git(['merge-tree', '--write-tree', '--merge-base', mergeBaseSha, baseSha, headSha]);
  } catch (e) {
    // merge-tree esce non-zero su conflitto reale o storia non risolvibile:
    // non è compito di QUESTO gate (i conflitti veri sono già coperti dal
    // gate mergeStateStatus=DIRTY a monte in auto-merge-eval.mjs) — skip.
    return { ok: true, reason: `merge-preview: merge-tree non risolvibile (conflitto o storia insufficiente) — skip, gestito altrove: ${String(e).slice(0, 120)}` };
  }
  const treeOid = (tree || '').split('\n')[0].trim();
  if (!treeOid) return { ok: true, reason: 'merge-preview: nessun tree risultante — skip' };

  let files;
  try {
    files = git(['ls-tree', '-r', '--name-only', treeOid])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(isMergePreviewCheckedPath);
  } catch (e) {
    return { ok: true, reason: `merge-preview: ls-tree fallito (${String(e).slice(0, 120)}) — skip conservativo` };
  }

  const dupesByFile = {};
  for (const f of files) {
    let content;
    try {
      content = git(['show', `${treeOid}:${f}`]);
    } catch {
      continue; // file non leggibile dal tree risultante -> skip quel file
    }
    const dupes = findDuplicateTopLevelNames(content, f);
    if (dupes.length) dupesByFile[f] = dupes;
  }

  if (Object.keys(dupesByFile).length > 0) {
    const detail = Object.entries(dupesByFile).map(([f, ds]) => `${f}: ${ds.join(', ')}`).join(' · ');
    return {
      ok: false,
      reason: `merge-preview: il merge con main risultante dichiarerebbe due volte a livello di modulo — ${detail}. Base superata (classe #5215/#5187+#5170): serve rebase/dedup prima del merge.`,
      dupesByFile,
    };
  }
  return { ok: true, reason: 'merge-preview: nessuna dichiarazione duplicata nel merge risultante con main ✔' };
}
