/**
 * corpus-local-preserve.mjs — helpers for pull-articles-corpus.mjs's mirror
 * safety: snapshot shared files before overwrite, and classify known generated
 * destination-only churn separately from article-tree shrinkage.
 *
 * Extracted out of pull-articles-corpus.mjs (2026-08-15) so the snapshot step can be
 * exercised in a test without running the rest of the script — the clone, the manifest
 * fetch, the registry gate. This is the exact logic that used two undefined variables
 * (`srcFiles`, `dstFiles`): the loop shipped with PR #5357 (2026-08-08, the sync pin)
 * and sat dormant, because it only runs when `preserveIds.size > 0` — i.e. only when a
 * local registry id is missing upstream. `node --check` cannot catch a ReferenceError
 * that only fires when the branch actually executes, and the branch first executed on
 * 2026-08-15, when three bridged retirements made three ids local-only.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Image-credit records are corpus-owned, but their generated file set can
 * churn between the site checkout and an older API-pinned snapshot. The pull
 * guard excludes only destination-only files under this prefix from its coarse
 * file-count comparison; mirrorTree still converges the files to the pinned
 * corpus state.
 */
export const CORPUS_GENERATED_CHURN_PREFIXES = Object.freeze([
  'image-credits/',
]);

/**
 * Every file under `dir`, as a Set of POSIX-style paths relative to `dir`
 * (e.g. `"blog-body/it/foo.ts"`).
 */
export function listRelFiles(dir) {
  const out = new Set();
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else out.add(r);
    }
  };
  walk(dir, '');
  return out;
}

function hasPathPrefix(rel, prefixes) {
  return [...prefixes].some((prefix) => {
    const normalized = String(prefix).replace(/\/+$/, '');
    return rel === normalized || rel.startsWith(`${normalized}/`);
  });
}

/**
 * Return destination-only files whose generated surface is allowed to churn.
 * The corpus registry/manifest gates remain responsible for article safety;
 * this set only keeps generated image-credit churn from tripping the coarse
 * file-count shrink alarm. The mirror still deletes or replaces these paths.
 */
export function destinationOnlyPaths({
  src,
  dest,
  prefixes = CORPUS_GENERATED_CHURN_PREFIXES,
}) {
  const srcFiles = listRelFiles(src);
  const destFiles = listRelFiles(dest);
  return new Set(
    [...destFiles].filter((rel) => !srcFiles.has(rel) && hasPathPrefix(rel, prefixes)),
  );
}

/**
 * Drop from `preserveIds` every id whose absence upstream is a *deliberate,
 * bridged retirement* — the registry gate has already approved its removal,
 * and the mirror is about to delete its body module on purpose.
 *
 * Without this, a retired id is indistinguishable from a locally-published
 * one (both are "present local, absent upstream"): the merge-back would put
 * its registry entries back while its body is gone — a registry row with no
 * module (red of class #5298) — and since the id stays local-only forever,
 * every subsequent sync would re-preserve it.
 *
 * `removals` is `verdict.removals` from `evaluateCorpusRemoval()`: entries
 * with `ledgered === true` carry a bridge in the retirement ledger.
 */
export function dropLedgeredRetirements(preserveIds, removals) {
  for (const r of removals ?? []) {
    if (r?.ledgered) preserveIds.delete(r.id);
  }
  return preserveIds;
}

/**
 * Snapshot the local content of files that the mirror can overwrite or delete
 * (shared files and destination-only files) and mention at least one
 * locally-only article id.
 *
 * `preserveIds` is the Set of ids `localOnlyIds()` found: present downstream,
 * absent upstream. A file mentioning none of them needs no snapshot —
 * upstream's copy carries nothing that would be lost. Source-only files are
 * skipped because there is no local content to preserve.
 */
export function collectPreserveSnapshots({ src, dest, preserveIds }) {
  const srcFiles = listRelFiles(src);
  const dstFiles = listRelFiles(dest);
  const snapshots = [];
  const candidateFiles = new Set([...srcFiles, ...dstFiles]);
  for (const rel of candidateFiles) {
    if (!dstFiles.has(rel)) continue; // upstream-only: nothing of ours to lose
    const abs = path.join(dest, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
    const ids = [...preserveIds].filter((id) => text.includes(id));
    if (ids.length > 0) snapshots.push({ rel, text, ids });
  }
  return snapshots;
}
