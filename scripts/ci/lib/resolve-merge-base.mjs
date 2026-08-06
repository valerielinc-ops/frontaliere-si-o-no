/**
 * resolve-merge-base.mjs — shared shallow-clone-safe merge-base resolver
 * (issue #5195).
 *
 * Why this lives in one module: `check-sibling-patterns.mjs` and
 * `check-below-floor-bridge.mjs` both computed their diff base as
 * `git(['merge-base', base, 'HEAD'], { allowFail: true }).trim() || base`
 * — copy-pasted verbatim. On a shallow clone `git merge-base` can exit 0
 * with EMPTY output when the shallow boundary cuts off before the real
 * common ancestor is reached; the `|| base` fallback then substitutes
 * `base` itself as the "merge-base", so the two-dot diff that follows
 * compares the FULL tree of `base` against HEAD instead of just the
 * branch's own changes — every file that merely differs from `base`
 * (unrelated in-flight work on other branches/PRs) surfaces as a
 * false-positive "sibling candidate", up to ~100-370 per push (measured
 * in #5195).
 *
 * Fix: if merge-base is empty and the repo is shallow, incrementally
 * `git fetch --deepen` (bounded by DEEPEN_STEPS — never a full
 * `--unshallow`, which would defeat the point of staying shallow: the
 * reporting machine keeps the repo shallow because a full clone is ~9.6GB
 * and doesn't fit on disk) until a common ancestor is found. If it still
 * can't be found — deepening exhausted, no network, or histories are
 * genuinely unrelated — return `mergeBase: null` so the caller can skip
 * the comparison with an explicit message instead of emitting a
 * misleading fallback diff.
 */
import { execFileSync } from 'node:child_process';

const DEEPEN_STEPS = [100, 500, 2000];

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } catch {
    return '';
  }
}

/**
 * @param {string} base ref to diff against (e.g. `origin/main`)
 * @returns {{ mergeBase: string|null, deepened: boolean }}
 */
export function resolveMergeBase(base) {
  let mergeBase = git(['merge-base', base, 'HEAD']).trim();
  if (mergeBase) return { mergeBase, deepened: false };

  const isShallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  if (!isShallow) return { mergeBase: null, deepened: false };

  for (const step of DEEPEN_STEPS) {
    git(['fetch', `--deepen=${step}`, 'origin']);
    mergeBase = git(['merge-base', base, 'HEAD']).trim();
    if (mergeBase) return { mergeBase, deepened: true };
  }
  return { mergeBase: null, deepened: true };
}

/** Explicit, human-readable bail-out message for the `mergeBase === null` case. */
export function formatUnresolvableMergeBaseMessage(base, deepened) {
  return (
    `merge-base tra ${base} e HEAD non calcolabile` +
    (deepened
      ? ' (anche dopo aver approfondito il clone shallow con git fetch --deepen)'
      : ' su clone shallow') +
    ' — confronto non affidabile su alberi potenzialmente non imparentati, salto ' +
    "l'analisi invece di produrre falsi positivi. Per un confronto affidabile: " +
    '`git fetch --unshallow` (o un clone completo) prima del push.'
  );
}
