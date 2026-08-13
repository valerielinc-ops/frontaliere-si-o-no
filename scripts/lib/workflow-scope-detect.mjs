/**
 * workflow-scope-detect.mjs — shared `.github/workflows/**`-scope detection.
 *
 * Extracted from followup-drainer.mjs (escalation #1724) so `check-workflows-scope.mjs`
 * (escalation #3887/#4227) shares the SAME regex + exclusion logic instead of a
 * hand-duplicated copy. The duplication was the direct cause of a false-positive
 * infinite loop (issue #4437, observed 2026-07-18→2026-07-27, 51 identical park
 * comments over 9 days): followup-drainer's `detectWorkflowScoped` correctly bails out
 * when the body ALSO cites non-workflow code paths (the fix might live there), but
 * check-workflows-scope.mjs's `extractWorkflowPaths` had no such exclusion — it blocked
 * on ANY `.github/workflows/*.yml` substring, even a passing reference inside an
 * unrelated "live-verification" checklist bullet. That asymmetry meant: the drainer
 * would happily re-promote the issue (its own check says "not scoped"), issue-fix.yml's
 * own pre-flight would immediately re-block it, and — because the block removed
 * `agent:fix` without adding any terminal label — issue-triage.yml's sweep would treat
 * it as unrouted and re-queue it, forever, ~4h cadence.
 *
 * CONSERVATIVE (bias to PROMOTE — a false park/block delays a real fix): a body is
 * "exclusively workflow-scoped" only when it cites ≥1 workflow path AND no non-workflow
 * code path (scripts/build-plugins/services/components/hooks/build/src/...). If it
 * cites both, the fix might live in the code file → let the fixer decide.
 *
 * ─── The bias was DECLARED but not HONOURED (issue #5595) ─────────────────────────────
 *
 * The exclusivity valve above is the whole safety mechanism, and it only opens on shapes
 * `CODE_PATH_RE` can see. It could not see the single most common shape a *planning*
 * issue uses for its implementation targets — a glob stem instead of a concrete
 * extension:
 *
 *     - `src/content-generation/claimVerifier.*` — evidence retrieval e classificazione
 *     - `scripts/audit-generated-articles.*` — audit schedulato e backfill storico
 *     - `.github/workflows/content-grounding-audit.yml` — workflow pianificato, SE il
 *       processo risiede nel repository
 *
 * That is issue #5595 verbatim (funnel-critical: generated articles asserting facts the
 * source never states). Six of its seven implementation bullets are code, one is an
 * explicitly optional workflow — yet `\.[A-Za-z0-9]+\b` matches none of the six, because
 * every one of them ends in `.*`. The valve stayed shut, the single `.yml` line decided
 * the verdict, and the detector answered "exclusively workflow-scoped" about an issue
 * whose fix is almost entirely a generation-pipeline change. Downstream that is terminal:
 * `blocked-workflows-scope` → `fu-parked` → with `needs-human` it becomes owner-only work
 * forever. A silently-too-narrow valve on a rule whose docstring says "bias to PROMOTE"
 * is worse than no valve: it reads as protected and is not.
 *
 * Two changes restore the declared behaviour, in opposite directions and for opposite
 * reasons — measured on the 62 open issues of both repos, 5 verdicts change in total:
 *
 *   1. WIDER promote-valve (`CODE_PATH_RE` accepts a `*` extension stem, and
 *      `NON_CODE_EXT` keeps data payloads from counting as code — see below). Citing a
 *      `.yml` next to code work is no longer proof of workflow-only.
 *   2. NARROWER, EXPLICIT block for the one family where "workflow-only" is not an
 *      inference from prose but the literal subject of the issue: a monitor auto-file on
 *      a workflow failure (`isMonitorFiledWorkflowFailure`). Those bodies always end with
 *      the auto-filer's own signature line ("Issue aperta automaticamente da
 *      `scripts/ci/scan-failed-runs.mjs`"), which is boilerplate, not a fix target — it
 *      opened the valve on every one of them and made a whole legitimate category
 *      invisible to both guards.
 *
 * What did NOT change, on purpose: a body that cites workflow file(s) and nothing else
 * still blocks. The real fixture for that is issue #1607 ("Suggested action: in
 * `.github/workflows/post-deploy-validate-dist.yml`, allargare il guard") — genuinely
 * unpushable by the fixer's token, and covered by an existing test. Removing the prose
 * rule outright would promote it and buy a guaranteed-wasted run.
 */

// Matches `.github/workflows/<name>.yml` (or `.yaml`) ANYWHERE in body text — backticks,
// fenced code blocks, or bare markdown prose/bullets.
export const WORKFLOW_PATH_RE = /\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml\b/g;

// Bare `<name>.yml` (a workflow is always .yml; in a follow-up a bare .yml that isn't a
// known config file indicates a workflow file almost every time).
export const BARE_YML_RE = /\b[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml\b/g;

// Non-workflow code paths: if cited, the fix might live there → not exclusively scoped.
// Must cover every top-level code dir in the repo (`ls -d */`), not just scripts/services/
// components/hooks/build/src — a PR review on #4778 caught this list missing `infra/`
// (infra/cloudflare-worker/locale-router.js — funnel-critical), `server/`
// (server/newsletterResendWebhook.js), and `functions/` (functions/index.js,
// functions/src/*.js): an issue citing a workflow path alongside one of those would be
// wrongly judged "exclusively workflow-scoped" and blocked, reproducing the #4437 bug
// class in a different directory.
//
// The extension slot accepts a literal `*` as well (issue #5595). An issue that PLANS a
// fix writes its targets as `src/content-generation/claimVerifier.*` far more often than
// as a concrete filename, because the extension is exactly the detail the plan defers
// (.ts vs .mjs). `\.[A-Za-z0-9]+` matched none of those, so the valve that exists to
// promote code-carrying issues could not see the code in the most code-heavy issue shape
// there is. Widening here can only ever PROMOTE — it never adds a block.
//
// ─── The match started at the DIRECTORY, not at the path (corpus half) ───────────────
//
// This module is `mode: identical` in `scripts/ci/loop-sync-manifest.json`: the SAME
// bytes run on the site and on the corpus mirror. The old pattern anchored with `\b`
// directly on the directory token, so on a corpus body citing
// `generator/scripts/create-article.mjs` it matched the SUFFIX `scripts/create-article.mjs`
// — a string that exists in no repo. `detectWorkflowScoped` only asks "is the list
// non-empty", so the valve kept working; `followup-drainer.mjs`'s overlap pre-flight
// compares the extracted paths against a PR's file list with an EXACT `Set.has`, so on
// the corpus it could never match anything. Measured there: 0 overlaps detected, ever —
// the pre-flight that exists to stop the fixer from working on a file another PR already
// has in flight was inert, which is the upstream cause of the `overlap-skip` markers that
// nanakokyobashi-rgb/frontaliere-articles#229 and #274 were opened about.
//
// Two changes, both PROMOTE-only for `detectWorkflowScoped` (they can add code refs,
// never remove one):
//
//   1. An optional leading path prefix, so the match starts where the PATH starts.
//      `generator/scripts/create-article.mjs` now yields itself, which is what a PR file
//      list on the corpus actually contains. The site form `scripts/x.mjs` still matches
//      with zero prefix segments — that half must not regress, it is the half that works.
//   2. `content/` joins the directory list. The corpus's article registries live there
//      (`content/**` is 14.748 files, the single most-edited tree of that repo), and the
//      site mirrors them under `packages/articles/content/**`, which change 1 also covers.
//      Data payloads under it are still filtered by `NON_CODE_EXT` (registries are `.ts`).
//
// Deliberately NOT added to the directory list: `engine`, `generator`, `tests`,
// `packages`. Those appear as EVIDENCE in bodies whose remedy is a workflow — the pinned
// fixture corpus#217 (`tests/fixtures/workflow-scope/corpus-217-lockstep-no-alarm.md`)
// cites `engine/rssFeeds.mjs`, `generator/tests/rss-feed-guid.test.mjs` and
// `tests/rss-feeds-module.test.ts` while asking for a new `.github/workflows/**` guardian.
// Adding them would open the exclusivity valve on it and promote a run whose push is
// refused for lack of the `workflows` scope — the exact true-positive that fixture pins.
export const CODE_DIRS = [
  'scripts', 'build-plugins', 'services', 'components', 'hooks', 'build', 'src',
  'infra', 'server', 'functions', 'content',
];
const CODE_DIR_ALT = CODE_DIRS.join('|');
// `(?<![\w.-])` (not `\b`) so the match can only start at a path boundary — it keeps
// `descripts/foo.mjs` from matching while still allowing a leading `/` (a path inside a
// URL keeps producing a code ref exactly as before, see `repoRelativeTail`).
export const CODE_PATH_RE = new RegExp(
  String.raw`(?<![\w.-])(?:[A-Za-z0-9._-]+\/)*(?:${CODE_DIR_ALT})\/[A-Za-z0-9._/-]+\.(?:[A-Za-z0-9]+\b|\*)`,
  'g',
);

// Lazy prefix → the group starts at the FIRST recognised code directory.
const CODE_PATH_TAIL_RE = new RegExp(String.raw`^(?:[A-Za-z0-9._-]+\/)*?((?:${CODE_DIR_ALT})\/.+)$`);

/**
 * The portion of `p` starting at its first recognised code directory, or `p` unchanged.
 *
 * The overlap pre-flight compares a body's cited paths against a PR's file list, and the
 * two are not always written from the same root: a body can cite a GitHub blob URL
 * (`github.com/o/r/blob/main/scripts/x.mjs`), and the site keeps under
 * `packages/articles/content/**` what the corpus keeps at `content/**`. Emitting the tail
 * ALONGSIDE the full path (never instead of it) makes the candidate set a strict superset
 * of what the pre-`CODE_PATH_RE`-fix code produced, so no comparison that matched before
 * can stop matching now. A false overlap only defers a candidate by one tick (the drainer
 * never parks on it — the blocking PR can merge), so the asymmetric cost points this way.
 * Pure → testable.
 * @param {string} p
 */
export function repoRelativeTail(p) {
  const s = String(p || '');
  const m = CODE_PATH_TAIL_RE.exec(s);
  return m ? m[1] : s;
}

// Extensions that make a cited path a data/doc PAYLOAD rather than a fix target. The
// valve's premise is "the fix might live in that file"; a quoted manifest or a report
// is cited as EVIDENCE, and counting it as code inverts the premise.
//
// Live case (corpus #217, "Nessun allarme quando la lockstep dell'engine si incaglia"):
// the body quotes `scripts/ci/loop-sync-manifest.json` to show where the missing alarm
// is *declared*, and its entire remedy is a new `.github/workflows/**` guardian. The
// `.json` opened the valve, the issue was promoted, and the run came back with the push
// refused verbatim — "refusing to allow a GitHub App to create or update workflow
// `.github/workflows/lockstep-stall-watchdog.yml` without `workflows` permission" — after
// paying the full diagnosis cost. Source extensions (.ts/.mjs/.js/.py/...) are NOT here:
// a cited script is a plausible fix target and must keep opening the valve.
export const NON_CODE_EXT = new Set([
  'json', 'jsonl', 'ndjson', 'md', 'txt', 'csv', 'tsv', 'lock', 'snap', 'log',
  'yml', 'yaml', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'pdf', 'zip',
]);

// `.yml` config files that are NOT workflows (don't imply the `workflows` scope).
export const NON_WORKFLOW_YML = new Set([
  'lighthouserc.yml', 'pnpm-workspace.yml', 'docker-compose.yml',
  '.prettierrc.yml', 'vitest.yml',
]);

// Title prefixes stamped by the CI monitors that auto-file on a workflow FAILURE:
// "Workflow Failure: <display name>" (`report-workflow-failure.mjs` here,
// `scan-failed-runs.mjs` on the corpus mirror — same title, different filer) and
// "CI Failure: <display name>" (`scan-job-timeouts.mjs`, both sides).
//
// Anchored at `^` — a title merely *containing* the words is a human-written issue and
// must not match. That anchor is the whole difference from the bare-word regex #5455 had
// to undo, which excluded every `Workflow Failure:` issue from parked-retry forever.
//
// `Crawler Failure:` is deliberately NOT here even though the three families are handled
// together by close-recovered-failure-issues.mjs / failure-issue-inventory.mjs: a broken
// crawler is fixed in `scripts/crawlers/**`, not in the workflow that launches it, so
// including it would bury fixable work.
export const MONITOR_FAILURE_TITLE_RE = /^\s*(?:workflow|ci)\s+failure\s*:/i;

// Labels applied by those same monitors. `ci-timeout` is scan-job-timeouts.mjs's own
// routing label (see check-workflows-scope.mjs `isCiTimeoutIssue`).
export const MONITOR_SCOPE_LABELS = new Set(['ci-timeout']);

/** Normalise `labels` from either `['a']` or `[{ name: 'a' }]` (both shapes reach here). */
function labelNames(labels) {
  return (labels || [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean);
}

/**
 * Was this issue auto-filed by a CI monitor because a workflow FAILED?
 *
 * This is the one family where "workflow-scoped" is not inferred from prose: the issue's
 * literal subject IS a `.github/workflows/**` file, named in the title by the monitor
 * that opened it. Recognised by the monitor's own output — the stable title prefix or its
 * routing label — never by a bare "workflow" word (which is what #5455 had to undo).
 *
 * Deliberately independent of the body: these bodies are templates that cite the
 * auto-filer's own script path ("Issue aperta automaticamente da
 * `scripts/ci/scan-failed-runs.mjs`"). That line is boilerplate, it is never the fix
 * target, and letting it open the exclusivity valve is why this whole category was
 * invisible to both guards.
 *
 * @param {{ title?: string, labels?: Array<string|{name?: string}> }} [meta]
 */
export function isMonitorFiledWorkflowFailure(meta = {}) {
  if (MONITOR_FAILURE_TITLE_RE.test(String((meta && meta.title) || ''))) return true;
  return labelNames(meta && meta.labels).some((n) => MONITOR_SCOPE_LABELS.has(n));
}

/** Non-workflow code paths cited by `text`, data/doc payloads excluded (`NON_CODE_EXT`). */
export function extractNonWorkflowCodeRefs(text) {
  return [...new Set(String(text || '').match(CODE_PATH_RE) || [])].filter((p) => {
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
    return ext === '*' || !NON_CODE_EXT.has(ext);
  });
}

/** True if `text` cites at least one non-workflow code path (scripts/, build-plugins/, ...). */
export function hasNonWorkflowCodeRefs(text) {
  return extractNonWorkflowCodeRefs(text).length > 0;
}

/**
 * Workflow file references cited by `text`: full `.github/workflows/**` paths plus bare
 * `<name>.yml` names that aren't known non-workflow config files. Deduped, order-stable.
 */
export function extractWorkflowRefs(text) {
  const s = String(text || '');
  const wfFull = s.match(WORKFLOW_PATH_RE) || [];
  const bareYml = (s.match(BARE_YML_RE) || []).filter(
    (y) => !NON_WORKFLOW_YML.has(y.toLowerCase()),
  );
  return [...new Set([...wfFull, ...bareYml])];
}

/**
 * True if the fix is EXCLUSIVELY workflow-scoped (requires editing `.github/workflows/**`),
 * so promoting it would burn quota on a run the push would block anyway. Pure → testable.
 *
 * @param {string} text  title + body of the issue
 * @param {{ title?: string, labels?: Array<string|{name?: string}> }} [meta]
 *   Title/labels when the caller has them. `title` defaults to the first line of `text`
 *   (both drainer call sites pass `` `${title}\n${body}` ``), so the monitor check still
 *   fires for callers that were written before this parameter existed.
 */
export function detectWorkflowScoped(text, meta = {}) {
  const s = String(text || '');
  const title = meta && meta.title !== undefined ? meta.title : s.split('\n', 1)[0];

  // The issue IS about a workflow that failed, said so by the monitor that filed it →
  // workflow-scoped without reading a single line of prose.
  if (isMonitorFiledWorkflowFailure({ title, labels: meta && meta.labels })) return true;

  if (extractWorkflowRefs(s).length === 0) return false; // no workflow reference → promote
  if (hasNonWorkflowCodeRefs(s)) return false; // also cites non-workflow code → might fix there → promote
  return true; // workflow-only → blocked-workflows-scope by construction
}
