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
 *
 * Second half of the fix (the one #5207 left open): `mergeBase: null` is a
 * SKIP, not a PASS. Returning it is only half a guard — every consumer that
 * reads the result as "no findings" turns a gate that could not run into a
 * gate that reports all-clear, which is strictly worse than the 640 false
 * positives it replaced: false positives are read and dismissed, a false
 * all-clear is never read at all. So the skip carries an explicit
 * `skipped`/`reason` in every JSON surface, prints to stderr (never only to
 * a stdout that the caller is parsing as JSON), and is BLOCKING under
 * `--strict`. The deliberate-override escape hatch is ALLOW_UNRESOLVED_ENV,
 * so "proceed anyway" is always a typed decision that leaves a trace,
 * never a default.
 */
import { execFileSync } from 'node:child_process';

const DEEPEN_STEPS = [100, 500, 2000];

/**
 * Opt-out for the blocking skip. Shared here rather than duplicated in the
 * three consumers (AGENTS.md #6: a literal constant in ≥2 files gets one
 * module, so it cannot drift).
 */
export const ALLOW_UNRESOLVED_ENV = 'CI_ALLOW_UNRESOLVED_MERGE_BASE';

/** True when the operator has explicitly opted into running without a base. */
export function unresolvedBaseOverrideActive(env = process.env) {
  const v = env[ALLOW_UNRESOLVED_ENV];
  return v === '1' || v === 'true';
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } catch {
    return null; // null = git itself failed; '' = ran fine, empty output
  }
}

function gitText(args) {
  return git(args) ?? '';
}

/**
 * @param {string} base ref to diff against (e.g. `origin/main`)
 * @param {string} [head] ref whose divergence from `base` we want (default
 *   `HEAD`, the checked-out commit of the invoking directory). A caller that
 *   knows WHICH BRANCH it is analysing — e.g. `sibling-check-gate.mjs`, which
 *   reads `--head` off the gated `gh pr create` — passes that branch instead,
 *   so the answer no longer depends on which working tree the process happens
 *   to run in. Worktrees share `.git`, so a branch ref resolves identically
 *   from any of them.
 * @returns {{ mergeBase: string|null, deepened: boolean, shallow: boolean, fetchFailed: boolean }}
 */
export function resolveMergeBase(base, head = 'HEAD') {
  let mergeBase = gitText(['merge-base', base, head]).trim();
  if (mergeBase) return { mergeBase, deepened: false, shallow: false, fetchFailed: false };

  const shallow = gitText(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  if (!shallow) return { mergeBase: null, deepened: false, shallow: false, fetchFailed: false };

  // A --deepen that dies (offline, ENOSPC on a 99%-full disk, auth) must not
  // read as "deepened and still unrelated": the two need different advice, and
  // on the reporting machine ENOSPC is the likelier of the two.
  let fetchFailed = false;
  for (const step of DEEPEN_STEPS) {
    if (git(['fetch', `--deepen=${step}`, 'origin']) === null) fetchFailed = true;
    mergeBase = gitText(['merge-base', base, head]).trim();
    if (mergeBase) return { mergeBase, deepened: true, shallow: true, fetchFailed };
  }
  return { mergeBase: null, deepened: true, shallow: true, fetchFailed };
}

/**
 * Explicit, human-readable bail-out message for the `mergeBase === null` case.
 *
 * `shallow` defaults to true only for the legacy 2-arg call shape; pass the
 * real value. Claiming "su clone shallow" on a NON-shallow checkout (CI runs
 * `fetch-depth: 0`) sends the reader after a disk-space problem when the
 * actual cause is a wrong/missing base ref or genuinely unrelated histories.
 */
export function formatUnresolvableMergeBaseMessage(base, deepened, shallow = true, fetchFailed = false) {
  const cause = deepened
    ? ' (anche dopo aver approfondito il clone shallow con git fetch --deepen)'
    : shallow
      ? ' su clone shallow'
      : ' su un checkout NON shallow — base ref mancante/errata, o storie non imparentate';
  const remedy = shallow
    ? 'Per un confronto affidabile: `git fetch --deepen=<N>` (o `--unshallow`) prima del push.'
    : `Per un confronto affidabile: verifica che \`${base}\` esista e sia imparentata con HEAD.`;
  return (
    `merge-base tra ${base} e HEAD non calcolabile${cause}` +
    ' — confronto non affidabile su alberi potenzialmente non imparentati, salto ' +
    "l'analisi invece di produrre falsi positivi. " +
    (fetchFailed ? 'ATTENZIONE: `git fetch --deepen` è FALLITO (rete? disco pieno?). ' : '') +
    remedy
  );
}

/**
 * The skip is a gate failure, not a pass — unless explicitly overridden.
 * Callers use this so the three consumers cannot drift apart on the question
 * "does an unresolvable base block?".
 *
 * @returns {{ blocking: boolean, overridden: boolean, banner: string }}
 */
export function formatUnresolvableMergeBaseVerdict(tool, base, resolution, env = process.env) {
  const { deepened, shallow, fetchFailed } = resolution;
  const overridden = unresolvedBaseOverrideActive(env);
  const detail = formatUnresolvableMergeBaseMessage(base, deepened, shallow, fetchFailed);
  const banner =
    `\n🚫 ${tool}: ANALISI NON ESEGUITA (base non calcolabile) — questo NON è un via libera.\n` +
    `   ${detail}\n` +
    (overridden
      ? `   ${ALLOW_UNRESOLVED_ENV} attivo → procedo comunque, ma NESSUN sibling è stato verificato.\n`
      : `   Per procedere deliberatamente senza verifica: ${ALLOW_UNRESOLVED_ENV}=1 (lo stai dichiarando, non subendo).\n`);
  return { blocking: !overridden, overridden, banner };
}
