/**
 * github-issue-creator.mjs — Auto-create GitHub Issues on workflow failure.
 *
 * Drop-in replacement for the legacy github-issue-creator.mjs. Same CLI
 * surface and function signature so existing workflows migrate via a
 * single import path swap.
 *
 * Usage from CLI:
 *   node scripts/lib/github-issue-creator.mjs \
 *     --title "Crawler Failure: Update Coop" \
 *     --description "Stack trace + context" \
 *     --priority 2 \
 *     --label Bug \
 *     --workflow "Update Coop Ticino"
 *
 * Usage as module:
 *   import { createGithubIssue } from './github-issue-creator.mjs';
 *   await createGithubIssue({ title, description, priority, labels, workflow });
 *
 * Auth: requires `gh` CLI authenticated via GITHUB_TOKEN (default in GH
 * Actions) or local `gh auth login`. Repo is auto-detected from the working
 * directory; override with $GH_REPO if needed.
 *
 * Priority → label mapping (1-4 scale so call sites don't need to change):
 *   1 → priority:urgent
 *   2 → priority:high
 *   3 → priority:medium (default)
 *   4 → priority:low
 *
 * De-duplication: searches for OPEN issues whose title shares the first
 * 60 chars of the new title; if found, posts a comment with the new context
 * instead of creating a duplicate. The lookup queries the search index FIRST
 * and, when that returns nothing, falls back to a plain repository listing —
 * the index is eventually consistent and does not see an issue opened seconds
 * ago, so search alone lets two near-simultaneous reporters both believe they
 * are the first (how #5305/#5306 were minted 3s apart).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PRIORITY_LABEL = {
  1: 'priority:urgent',
  2: 'priority:high',
  3: 'priority:medium',
  4: 'priority:low',
};

const DEDUP_TITLE_PREFIX_LEN = 60;
const MAX_BODY_LEN = 60000; // GH issue body cap is 65536; leave margin

// Crawler failure reporters fire from `if: failure()` steps with this stable
// title. A SINGLE transient network blip (`fetch failed`, timeout, 429/5xx)
// must NOT immediately open a priority:high issue — the layer-1 retry usually
// self-heals on the next scheduled run. Auto-gate these titles by consecutive
// failures: the first N-1 land as a low-priority breadcrumb; only the Nth
// failure within the rolling window escalates to the caller's priority.
const CRAWLER_FAILURE_TITLE_PREFIX = 'Crawler Failure:';
const DEFAULT_CRAWLER_GATE_THRESHOLD = 3; // escalate on the 3rd failure
// Window must comfortably span (threshold-1) crawl cadences so a genuinely-broken
// source reliably reaches the threshold. orchestrate-crawlers.yml dispatches each
// crawler-group-*.yml (each bundling ~25 crawlers as background steps) twice
// daily (~12h apart), so 3 consecutive failures of a given crawler span ~24h; a
// 24h window leaves the oldest event sitting on the cutoff (CI jitter decides
// inclusion) → escalation becomes a coin-flip and real breakage can decay
// silently. 48h gives a full cadence of margin so the 3rd consecutive failure
// deterministically escalates, while a lone transient still expires as intended.
const DEFAULT_CRAWLER_GATE_WINDOW_HOURS = 48; // failures older than this don't count
const CRAWLER_TRANSIENT_LABEL = 'crawler-transient';
const RECURRENCE_MARKER = '🔁'; // prefixes every recurrence comment we post

// Sub-threshold failures are recorded HERE instead of each minting its own
// issue (#5139/#5137). The gate above always downgraded a lone blip to a
// `crawler-transient` breadcrumb — but a breadcrumb is still an issue: 333 of
// them had been opened by 2026-08-05, and although a bot auto-closes each one
// once the crawler goes green (~14h later), every one still fires notifications,
// enters triage, and buries real bugs. The ones that DON'T recover quickly reach
// a human, which is how two priority:low network blips ended up hand-triaged.
//
// One long-lived ledger issue absorbs all of them. Consecutive-failure counting
// keeps working — the ordinal is read from ledger comments carrying the
// crawler's stable title key — so the Nth failure still escalates into a real,
// routable per-crawler issue. Nobody ever has to close the ledger.
const TRANSIENT_LEDGER_TITLE = 'Crawler transient failures (rolling ledger)';
const LEDGER_KEY_PREFIX = 'transient-key:'; // machine-readable per-crawler key in each ledger comment
// Counter issue: never eligible for followup-drainer's age-out close (#5615).
// Without this, a stretch of healthy crawlers — no sub-threshold comments to
// refresh `updatedAt` — makes the ledger look old+idle and the drainer closes
// it, resetting every in-progress streak. Checked in isAgeOutEligible
// (scripts/ci/followup-drainer.mjs); keep the literal in sync.
const LBL_NO_AGE_OUT = 'agent:no-age-out';

// How close to the `closed` event a `referenced` commit event must sit before we
// accept it AS the closing commit (see findClosingCommitSha). GitHub emits the
// two in the same second when a merge commit's `Closes #N` retires the issue —
// measured 0s apart on #5729 (`referenced eb7eac6a` and `closed`, both
// 2026-08-13T19:40:34Z). The window exists only to reject an UNRELATED older
// reference: #5729 also carried `referenced d72549e1` 25 minutes earlier, from a
// PR that merely mentioned the issue. Widening this trades precision for the
// risk of attributing the close to a commit that did not cause it.
const CLOSING_REFERENCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Run `gh` with explicit args. Returns trimmed stdout, or null on failure.
 * stderr is forwarded for visibility (workflow logs will show the actual error).
 */
function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

/**
 * Append one line to the job summary, when running inside Actions. The issue
 * comment is the primary trace for an abstention, but it goes through `gh` and
 * `gh` is allowed to fail silently here; the summary is written locally and
 * survives that. A SILENT abstention is indistinguishable from a broken
 * reopener — which is the very defect this guard repairs — so the trace is part
 * of the behaviour, not decoration. No-op outside CI, never throws.
 */
function appendStepSummary(line) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch { /* best-effort: a summary write must never break a reporter */ }
}

function repoFlag() {
  // Honor explicit override; otherwise gh auto-detects from cwd's git remote.
  return process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
}

function ensureLabelsExist(labels) {
  // Best-effort: try to create each label. `gh label create` errors if it
  // exists, which is fine — we proceed.
  for (const name of labels) {
    if (!name) continue;
    gh(['label', 'create', name, ...repoFlag()], { allowFailure: true });
  }
}

// Cut a string at the first opening bracket that is never closed within it, so
// no UNBALANCED `(`/`[`/`{` survives into the search phrase. A balanced group
// (`…(Dedicated)`) is preserved; an open group (`…(KSSG / HOCH` cut by the
// slice, or `…HIB (Hôpital Intercantonal de la`) is dropped from its opener on.
function stripUnbalancedBracketTail(s) {
  const OPEN = { '(': ')', '[': ']', '{': '}' };
  const CLOSE = new Set([')', ']', '}']);
  const stack = []; // each entry: { char, index }
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (OPEN[c]) stack.push({ char: c, index: i });
    else if (CLOSE.has(c) && stack.length) stack.pop();
  }
  // Anything left on the stack is an unmatched opener → cut at the FIRST one.
  return stack.length ? s.slice(0, stack[0].index) : s;
}

// Make a title prefix SAFE for `gh issue list --search 'in:title "<phrase>"'`.
// The naive `title.slice(0, 60)` can cut mid-token, leaving a partial word
// and/or an UNBALANCED opening bracket (e.g. `...Jobs (Dedicat`, or names with
// an internal parenthetical like `HIB (Hôpital Intercantonal de la Broye)` /
// `Kantonsspital St. Gallen (KSSG / HOCH)` cut mid-group). GitHub's phrase
// search ZERO-matches on a dangling partial word OR an unbalanced bracket →
// dedup never finds the canonical issue → a fresh duplicate opens every run
// (observed: 8 identical "Crawler Failure: …(Dedicated)" issues for SVAR alone,
// 2× each for HIB/KSSG-shaped names). Trim back to a whole-token,
// balanced-bracket, punctuation-clean prefix so the search resolves. The
// shorter prefix is still a valid `startsWith` discriminator because the
// crawler/company name sits before the dropped tail.
// Takes the FULL title (not a pre-sliced prefix) so it can tell whether
// slice(0,LEN) actually split a word — the only reliable signal for whether the
// trailing token is a fragment that must be dropped.
function searchSafePrefix(fullTitle) {
  const LEN = DEDUP_TITLE_PREFIX_LEN;
  const full = String(fullTitle);
  let p = full.slice(0, LEN);
  // Strip the dangling trailing token ONLY when slice(0,LEN) actually SPLIT a
  // word — i.e. the title is longer than the ceiling AND the char AT the cut is
  // a non-space. Gating on the cut char (not on p.length) is essential: a title
  // whose 60th char is a space — e.g.
  // "escalation(harvester): reviewer-finding/workflow-scope-creds ricorre…"
  // (the key is space-free, only the space before "ricorre" precedes the cut) —
  // must KEEP its discriminator. Gating on length alone would strip the whole
  // space-free key and collapse every escalation to "escalation(harvester)",
  // making distinct buckets dedup onto one canonical.
  const cutSplitWord = full.length > LEN && /\S/.test(full[LEN]);
  if (cutSplitWord && p.includes(' ')) p = p.replace(/\s+\S*$/, '');
  // Drop any tail from the first unmatched opening bracket (internal or trailing).
  p = stripUnbalancedBracketTail(p);
  // Strip trailing chars that break/destabilize phrase search: leftover openers,
  // quotes, slashes, and dangling punctuation. A balanced closing bracket
  // (e.g. full short title "…(Dedicated)") is intentionally kept.
  p = p.replace(/[\s"'([{/:;,.\-]+$/u, '').trim();
  // Guard: never return an over-short/empty prefix (would over-match); fall
  // back to the raw quote-stripped slice.
  return p.length >= 8 ? p : full.slice(0, LEN).replace(/"/g, '').trim();
}

// How many issues the index-lag fallback listing pulls. `gh issue list` WITHOUT
// `--search` is a plain repository listing (immediately consistent), so it sees
// an issue the instant it exists; the search index does not.
const LISTING_FALLBACK_LIMIT = 100;

/** Run `gh issue list` with the given extra args and parse the JSON array. */
function ghIssueList(state, extraArgs) {
  const out = gh([
    'issue', 'list',
    '--state', state,
    ...extraArgs,
    '--json', 'number,title,url,closedAt,state',
    ...repoFlag(),
  ], { allowFailure: true });
  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// `fullTitle` is the complete issue title (callers must NOT pre-slice it — the
// mid-word-cut detection in searchSafePrefix needs the char at the ceiling).
function searchIssuesByTitlePrefix(fullTitle, state) {
  const safePrefix = searchSafePrefix(fullTitle);
  // `gh issue list --search "in:title ..."` è token-match (fuzzy): titoli che
  // condividono token (es. "...(dist): post-deploy" vs "...(live): post-deploy",
  // o "CI Failure: Refresh Job Popularity" vs "...Refresh BFS Stats") possono
  // entrambi comparire. Filtra al match esatto di prefisso → niente commento
  // sul canonical sbagliato (altrimenti dist commenterebbe su issue live).
  // Match sul prefisso SANITIZZATO (stesso usato per la query) così il filtro
  // resta coerente quando lo slice grezzo era stato troncato a metà token.
  const matching = (issues) =>
    issues.filter((i) => typeof i.title === 'string' && i.title.startsWith(safePrefix));

  const viaSearch = matching(ghIssueList(state, [
    '--search', `in:title "${safePrefix.replace(/"/g, '\\"')}"`,
    '--limit', '10',
  ]));
  if (viaSearch.length > 0) return viaSearch;

  // WHY the fallback: `--search` goes through GitHub's SEARCH INDEX, which is
  // eventually consistent — an issue created seconds ago is routinely NOT in it
  // yet. Two reporters firing back-to-back for the same stable title (e.g. two
  // jobs of one run reported by scan-job-timeouts) therefore both saw "no
  // duplicate" and both opened one: that is exactly how #5305/#5306 were born,
  // 3 seconds apart, same run, identical title. A listing WITHOUT `--search`
  // reads the repository directly and is immediately consistent, so it closes
  // the window — including ACROSS processes, which an in-process memo cannot.
  // Only paid when the search came back empty (the no-duplicate common path).
  return matching(ghIssueList(state, ['--limit', String(LISTING_FALLBACK_LIMIT)]));
}

function findOpenIssueByTitlePrefix(fullTitle) {
  return searchIssuesByTitlePrefix(fullTitle, 'open')[0] || null;
}

/**
 * Find a recently-closed issue with the same stable title prefix, closed within
 * `withinHours`. Collapses FLAPPING transient failures (fail → auto-close on
 * green → fail again) onto a single canonical issue instead of spawning a new
 * one every deploy. This was the residual churn behind #928/#931/#937/#941: the
 * post-deploy validation titles were already stable, but the dedup matched only
 * OPEN issues, so each per-deploy transient that had been closed reopened as a
 * brand-new issue. Returns the most-recently-closed matching issue, or null.
 */
function findRecentlyClosedIssueByTitlePrefix(fullTitle, withinHours) {
  if (!withinHours || withinHours <= 0) return null;
  const cutoff = Date.now() - withinHours * 3600 * 1000;
  const matches = searchIssuesByTitlePrefix(fullTitle, 'closed')
    .filter((i) => i.closedAt && Date.parse(i.closedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  return matches[0] || null;
}

// `gh api` resolves the literal placeholders `{owner}/{repo}` from the cwd's
// git remote; GH_REPO (when set) must win over that auto-detection, same as
// repoFlag() does for `gh issue`/`gh pr`.
function apiRepoPath(suffix) {
  const repo = process.env.GH_REPO;
  return repo ? `repos/${repo}${suffix}` : `repos/{owner}/{repo}${suffix}`;
}

/**
 * The commit SHA of the event that most recently CLOSED an issue (issue #5539).
 *
 * Two sources, tried in order, because the first one is EMPTY for the entire
 * class of issues this guard exists to protect:
 *
 *  1. `/issues/N/events` — a `closed` event carries `commit_id` only when GitHub
 *     itself retired the issue from a closing keyword. Measured 2026-08-13: on
 *     #5729, #5786 and #5752 every `closed` event has `commit_id: null`, because
 *     `frontaliere-automation[bot]` closes them explicitly (`gh issue close`)
 *     rather than letting the keyword do it. So this rung returns null on 3/3 of
 *     the observed reopens — the #5539 guard was structurally dead here, not
 *     merely unlucky, and that is why it never fired.
 *
 *  2. `/issues/N/timeline` — the richer endpoint still records the merge commit
 *     as a `referenced` event. On #5729 that is `eb7eac6a` (the merge commit of
 *     PR #5778) at 2026-08-13T19:40:34Z, the same second as the `closed` event.
 *     We accept the LATEST such commit within CLOSING_REFERENCE_WINDOW_MS before
 *     `closedAt`, which excludes the unrelated `d72549e1` referenced 25 minutes
 *     earlier by a different PR.
 *
 * Returns null on any degradation (manual close with no reference; API error;
 * malformed JSON) so the caller keeps the fail-safe: no proof of staleness →
 * reopen. `closedAt` is optional; without it only rung 1 is attempted.
 */
function findClosingCommitSha(issueNumber, closedAt = null) {
  const fromEvents = gh([
    'api', apiRepoPath(`/issues/${issueNumber}/events`), '--paginate',
    '--jq', '[.[] | select(.event == "closed" and .commit_id != null) | .commit_id] | last',
  ], { allowFailure: true });
  const eventSha = fromEvents?.trim();
  if (eventSha && eventSha !== 'null') return eventSha;

  const closedMs = closedAt ? Date.parse(closedAt) : NaN;
  if (!Number.isFinite(closedMs)) return null;

  // `.[]` guards against the endpoint returning an object (error payload)
  // instead of an array — `--jq` would otherwise abort the whole call.
  const raw = gh([
    'api', apiRepoPath(`/issues/${issueNumber}/timeline`), '--paginate',
    '--jq', '.[] | select(.event == "referenced" and .commit_id != null) '
      + '| "\\(.created_at)\\t\\(.commit_id)"',
  ], { allowFailure: true });
  if (!raw) return null;

  let best = null;
  for (const line of raw.split('\n')) {
    const [at, sha] = line.split('\t');
    const atMs = Date.parse(at || '');
    if (!sha || !Number.isFinite(atMs)) continue;
    // At or before the close, and near enough to have caused it.
    if (atMs > closedMs || closedMs - atMs > CLOSING_REFERENCE_WINDOW_MS) continue;
    if (!best || atMs >= best.atMs) best = { atMs, sha: sha.trim() };
  }
  return best?.sha || null;
}

/**
 * True when the commit under validation was authored into the repo STRICTLY
 * BEFORE the issue was closed — the coarse rung of the staleness ladder, used
 * only when no closing commit SHA is recoverable at all.
 *
 * Less precise than the ancestor check by design: it proves "this code predates
 * the close", not "this code predates the specific fix". The two coincide
 * whenever the close is caused by the fix, which is the automated path here —
 * measured 2s between merge and close on both #5729 (eb7eac6a merged
 * 19:40:32Z, closed 19:40:34Z) and #5752 (PR #5761 merged 03:52:30Z, closed
 * 03:52:32Z). They diverge when a HUMAN closes an issue long after the fix
 * landed: a build committed inside that gap does contain the fix, yet is judged
 * stale. That over-abstention is bounded — it costs one deploy cycle, because
 * the next build (committed after the close) is not stale and reopens normally.
 *
 * Fails CLOSED on every uncertainty (unknown commit, unparseable date, API
 * error): no proof of staleness → the caller reopens, as before.
 */
function buildPredatesClose(buildSha, closedAt) {
  const closedMs = closedAt ? Date.parse(closedAt) : NaN;
  if (!buildSha || !Number.isFinite(closedMs)) return null;
  const out = gh([
    'api', apiRepoPath(`/commits/${buildSha}`), '--jq', '.commit.committer.date',
  ], { allowFailure: true });
  const date = out?.trim();
  if (!date || date === 'null') return null;
  const builtMs = Date.parse(date);
  if (!Number.isFinite(builtMs) || builtMs >= closedMs) return null;
  return date;
}

/**
 * True when `earlierSha` is an ANCESTOR of `laterSha` — i.e. a build built at
 * `earlierSha` cannot possibly contain whatever landed at `laterSha`. Used to
 * tell "the fix predates this failing build" (latency, not a real recurrence)
 * apart from "this build already has the fix and still failed" (real
 * recurrence). `gh compare base...head` returns `status: "ahead"` exactly when
 * base is an ancestor of head (fast-forwardable) — the same check
 * `gh api .../compare/<buildSha>...<closingSha>` from the issue body.
 * Fails CLOSED on any error/identical/diverged/unknown commit (never claims
 * staleness it can't prove), so the caller falls back to reopening as before.
 */
function isAncestorCommit(earlierSha, laterSha) {
  if (!earlierSha || !laterSha || earlierSha === laterSha) return false;
  const out = gh([
    'api', apiRepoPath(`/compare/${earlierSha}...${laterSha}`), '--jq', '.status',
  ], { allowFailure: true });
  return out?.trim() === 'ahead';
}

/**
 * Count failure events recorded on an issue within the rolling window. An
 * "event" is the issue's own creation plus every `🔁`-marked recurrence comment
 * we posted. Used by the crawler-failure gate to decide whether THIS failure is
 * the Nth consecutive one (→ escalate) or still an isolated transient blip
 * (→ keep low-priority breadcrumb). Returns the count of in-window events
 * (does NOT include the current run yet). Best-effort: returns 0 on any gh/parse
 * error so the gate fails OPEN to the low-priority breadcrumb (never louder).
 */
function countRecentFailureEvents(issueNumber, windowHours) {
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const out = gh([
    'issue', 'view', String(issueNumber),
    '--json', 'createdAt,comments',
    ...repoFlag(),
  ], { allowFailure: true });
  if (!out) return 0;
  try {
    const data = JSON.parse(out);
    let count = 0;
    if (data.createdAt && Date.parse(data.createdAt) >= cutoff) count += 1;
    for (const c of data.comments || []) {
      const at = c.createdAt && Date.parse(c.createdAt);
      if (at && at >= cutoff && typeof c.body === 'string' && c.body.includes(RECURRENCE_MARKER)) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

// The ledger is a SINGLETON, and its lookup is the one place where losing the
// read-then-create race is not cosmetic: two ledgers split the streak counters
// between them, so a crawler sitting at 2/3 on one ledger never reaches 3/3 and
// NEVER escalates — the counter stops counting, silently. That is what happened
// on the corpus repo (nanakokyobashi-rgb/frontaliere-articles #24 and #25,
// created 3 seconds apart on 2026-08-07).
//
// So this lookup does NOT go through the search index at all. `gh issue list
// --label crawler-transient --state open` is a plain repository listing:
// immediately consistent, and narrow enough that the ledger can never be paged
// out by unrelated backlog. The title-search path is kept only as a secondary
// probe for a ledger that somehow lost its label.
const LEDGER_LOOKUP_LIMIT = 200;

/**
 * The single open ledger issue that absorbs sub-threshold crawler blips.
 * Looked up by exact title; created on first use. Best-effort: returns null on
 * any gh error so the caller falls back to the previous per-crawler-issue
 * behaviour rather than losing the failure signal entirely.
 */
function findOrCreateTransientLedger() {
  const exactTitle = (issues) => issues.find((i) => i.title === TRANSIENT_LEDGER_TITLE);

  // Primary: immediately-consistent, label-scoped listing (no search index).
  const byLabel = exactTitle(ghIssueList('open', [
    '--label', CRAWLER_TRANSIENT_LABEL,
    '--limit', String(LEDGER_LOOKUP_LIMIT),
  ]));
  if (byLabel) return byLabel.number;

  // Secondary: title lookup, for a ledger whose label was stripped by hand.
  const byTitle = exactTitle(searchIssuesByTitlePrefix(TRANSIENT_LEDGER_TITLE, 'open'));
  if (byTitle) return byTitle.number;

  ensureLabelsExist([CRAWLER_TRANSIENT_LABEL, PRIORITY_LABEL[4], LBL_NO_AGE_OUT]);
  const body = [
    'Rolling log of **sub-threshold** crawler failures.',
    '',
    `A crawler that fails fewer than ${DEFAULT_CRAWLER_GATE_THRESHOLD} times in a`,
    `${DEFAULT_CRAWLER_GATE_WINDOW_HOURS}h window is almost always a network blip that`,
    'self-heals on the next scheduled run. Those land here as a comment instead of',
    'opening their own issue, so the backlog is not flooded with breadcrumbs that a',
    'bot opens and closes hours later.',
    '',
    `On the ${DEFAULT_CRAWLER_GATE_THRESHOLD}rd consecutive failure the crawler gets a real,`,
    'routable issue at full priority — that is the signal worth acting on.',
    '',
    '**Leave this issue open.** It is the counter; closing it resets every streak.',
    `The \`${LBL_NO_AGE_OUT}\` label keeps followup-drainer's age-out close from`,
    'doing that automatically during a healthy stretch.',
  ].join('\n');
  const url = gh([
    'issue', 'create',
    '--title', TRANSIENT_LEDGER_TITLE,
    '--body', body,
    '--label', CRAWLER_TRANSIENT_LABEL,
    '--label', PRIORITY_LABEL[4],
    '--label', LBL_NO_AGE_OUT,
    ...repoFlag(),
  ], { allowFailure: true });
  if (!url) return null;
  const m = url.split('\n').pop().trim().match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Count in-window ledger entries for one crawler key. Mirrors
 * countRecentFailureEvents but reads the shared ledger instead of a
 * dedicated issue. Fails OPEN (0) so the gate can never escalate on a
 * counting error.
 */
function countLedgerEvents(ledgerNumber, key, windowHours) {
  if (!ledgerNumber) return 0;
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const out = gh([
    'issue', 'view', String(ledgerNumber),
    '--json', 'comments',
    ...repoFlag(),
  ], { allowFailure: true });
  if (!out) return 0;
  try {
    const marker = `${LEDGER_KEY_PREFIX} ${key}`;
    let count = 0;
    for (const c of JSON.parse(out).comments || []) {
      const at = c.createdAt && Date.parse(c.createdAt);
      if (at && at >= cutoff && typeof c.body === 'string' && c.body.includes(marker)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/** Append one sub-threshold failure to the ledger. Returns true when recorded. */
function recordLedgerEvent(ledgerNumber, key, ordinal, threshold, body) {
  if (!ledgerNumber) return false;
  const comment = [
    `${RECURRENCE_MARKER} **${key}** — transient failure ${ordinal}/${threshold} in the rolling window.`,
    '',
    `\`${LEDGER_KEY_PREFIX} ${key}\``,
    '',
    body,
  ].join('\n');
  const res = gh([
    'issue', 'comment', String(ledgerNumber),
    '--body', comment.slice(0, MAX_BODY_LEN),
    ...repoFlag(),
  ], { allowFailure: true });
  return res !== null;
}

/** Replace an issue's priority label (remove all priority:* labels, add the target). */
function setIssuePriorityLabel(issueNumber, targetPriorityLabel, extraAdd = []) {
  const removable = Object.values(PRIORITY_LABEL).filter((l) => l !== targetPriorityLabel);
  ensureLabelsExist([targetPriorityLabel, ...extraAdd]);
  gh([
    'issue', 'edit', String(issueNumber),
    ...['--add-label', targetPriorityLabel],
    ...extraAdd.flatMap((l) => ['--add-label', l]),
    ...removable.flatMap((l) => ['--remove-label', l]),
    ...repoFlag(),
  ], { allowFailure: true });
}

/**
 * Resolve (close) the canonical OPEN issue with the given stable title prefix.
 *
 * The mirror of the `reopenWithinHours` flap-collapse logic: failure reporters
 * REOPEN the canonical issue on red, so a green run must CLOSE it again —
 * otherwise the issue stays open while the state is already OK (stale-issue
 * churn). Idempotent: a no-op when no matching OPEN issue exists, so it's safe
 * to run on every green pass. Best-effort — never throws; returns the closed
 * issue ref or null.
 *
 * @param {string} titlePrefix  Stable title (first DEDUP_TITLE_PREFIX_LEN chars
 *                              are matched, exactly as createGithubIssue dedups).
 * @param {{ workflow?: string, runUrl?: string }} [ctx]
 */
export function resolveGithubIssue(titlePrefix, { workflow, runUrl } = {}) {
  if (process.env.ENABLE_FAILURE_REPORT === 'false') {
    console.log('[github-issue-creator] ENABLE_FAILURE_REPORT=false, skipping resolve');
    return null;
  }
  if (!titlePrefix) {
    console.error('[github-issue-creator] resolve: title is required');
    return null;
  }
  // Pass the FULL title — searchSafePrefix slices + sanitizes internally and
  // needs the un-sliced title to detect a mid-word cut.
  const existing = findOpenIssueByTitlePrefix(titlePrefix);
  if (!existing) {
    const prefix = titlePrefix.slice(0, DEDUP_TITLE_PREFIX_LEN);
    console.log(`[github-issue-creator] resolve: no open issue matching "${prefix}" — nothing to close`);
    return null;
  }
  const note = [
    '✅ Auto-resolved — the failing check is green again' + (workflow ? ` (${workflow})` : '') + '.',
    runUrl ? `\nGreen run: ${runUrl}` : '',
    '\nClosed automatically; it will reopen if the same failure recurs.',
  ].join('');
  gh(['issue', 'comment', String(existing.number), '--body', note, ...repoFlag()], { allowFailure: true });
  const closed = gh(
    ['issue', 'close', String(existing.number), '--reason', 'completed', ...repoFlag()],
    { allowFailure: true },
  );
  if (closed !== null) {
    console.log(`[github-issue-creator] resolve: closed #${existing.number} — ${existing.title}`);
    return { number: existing.number, title: existing.title, url: existing.url };
  }
  console.error(`[github-issue-creator] resolve: could not close #${existing.number} (best-effort)`);
  return null;
}

/**
 * Post a comment on an issue whose number the caller ALREADY knows.
 *
 * For a reporter that has just created (or matched) the canonical issue inside
 * the same process, going back through `createGithubIssue` would mean another
 * title search — and the search index may not have caught up yet, which is the
 * very race that mints duplicates. Commenting by number skips the lookup
 * entirely, so a second occurrence in the same pass is *structurally* unable to
 * open a second issue while still preserving its context.
 *
 * Best-effort, never throws. Returns true when the comment landed.
 *
 * @param {number|string} issueNumber
 * @param {string} body
 */
export function commentOnGithubIssue(issueNumber, body) {
  if (process.env.ENABLE_FAILURE_REPORT === 'false') {
    console.log('[github-issue-creator] ENABLE_FAILURE_REPORT=false, skipping comment');
    return false;
  }
  if (!issueNumber || !body) return false;
  const out = gh(
    ['issue', 'comment', String(issueNumber), '--body', body, ...repoFlag()],
    { allowFailure: true },
  );
  if (out === null) {
    console.error(`[github-issue-creator] Failed to comment on #${issueNumber} (best-effort)`);
    return false;
  }
  console.log(`[github-issue-creator] Commented on #${issueNumber}`);
  return true;
}

/**
 * Create a GitHub issue, or comment on an existing open duplicate.
 */
export async function createGithubIssue({
  title,
  description = '',
  priority = 3,
  labels = [],
  workflow,
  // When set (hours), a recently-closed issue with the same stable title prefix
  // is REOPENED + commented instead of opening a fresh duplicate. Use for
  // transient per-run reporters (post-deploy validation) where the issue may
  // have been auto-closed on a green run and then flaps red again. CLI:
  // --reopen-within-hours N. Default 0 = disabled (legacy behaviour preserved).
  reopenWithinHours = 0,
  // Commit the CURRENT run actually validated (e.g. `deploy_ref` for a
  // post-deploy validation triggered by workflow_run, NOT `github.sha`).
  // Optional — only reporters that can tell "build commit" apart from "the run
  // that observed it" have one to give. When present, the reopen path below
  // uses it to distinguish "the same broken build observed twice" (a real
  // recurrence) from "a stale build validated again inside the deploy-latency
  // window, before a build containing the fix could run" (issue #5539: NOT a
  // recurrence — the reopener was reporting deploy latency as regression).
  buildSha = null,
  // Consecutive-failure gate. When > 0, the first (threshold-1) failures within
  // the rolling window land as a low-priority `crawler-transient` breadcrumb
  // instead of the caller's priority; only the Nth failure escalates. Auto-set
  // to DEFAULT_CRAWLER_GATE_THRESHOLD for stable `Crawler Failure:` titles so
  // a single transient blip never opens a priority:high issue. 0 = disabled.
  // CLI: --consecutive-gate N --gate-window-hours H.
  consecutiveGate = 0,
  gateWindowHours = DEFAULT_CRAWLER_GATE_WINDOW_HOURS,
  // `project` accepted for backward compatibility but not used (GH issues
  // don't have a free-form project field; the workflow name is preserved
  // in the body for grouping instead).
} = {}) {
  if (process.env.ENABLE_FAILURE_REPORT === 'false') {
    console.log('[github-issue-creator] ENABLE_FAILURE_REPORT=false, skipping');
    return null;
  }
  if (!title) {
    console.error('[github-issue-creator] --title is required');
    return null;
  }

  // Pass the FULL title to dedup — searchSafePrefix slices/sanitizes internally
  // and needs the un-sliced title to detect a real mid-word cut. `titlePrefix`
  // stays for logging/gate messages only.
  const titlePrefix = title.slice(0, DEDUP_TITLE_PREFIX_LEN);
  const existing = findOpenIssueByTitlePrefix(title);

  // Auto-enable the consecutive-failure gate for the stable crawler-failure
  // reporter title, unless a caller explicitly opted out (consecutiveGate < 0).
  const gateThreshold =
    consecutiveGate > 0
      ? consecutiveGate
      : (consecutiveGate === 0 && title.startsWith(CRAWLER_FAILURE_TITLE_PREFIX)
          ? DEFAULT_CRAWLER_GATE_THRESHOLD
          : 0);

  // Decide the EFFECTIVE priority for this failure. With the gate active, count
  // how many failures the canonical issue already recorded in the window; this
  // run is event #(priorEvents + 1). Below threshold → low-priority breadcrumb
  // (`crawler-transient`, non-routable); at/above → caller's priority. Gate
  // fails OPEN (low) on any gh error, never louder.
  let effectivePriority = priority;
  let gatedBelowThreshold = false;
  if (gateThreshold > 0) {
    // Where the streak is counted depends on whether this crawler already has a
    // real issue. Once escalated, the issue itself is the counter; before that,
    // the shared ledger is — so a blip never needs an issue of its own.
    const ledgerNumber = existing ? null : findOrCreateTransientLedger();
    const priorEvents = existing
      ? countRecentFailureEvents(existing.number, gateWindowHours)
      : countLedgerEvents(ledgerNumber, titlePrefix, gateWindowHours);
    const thisEventOrdinal = priorEvents + 1;

    if (thisEventOrdinal < gateThreshold) {
      effectivePriority = 4; // priority:low breadcrumb
      gatedBelowThreshold = true;
      console.log(
        `[github-issue-creator] Gate: failure ${thisEventOrdinal}/${gateThreshold} for `
        + `"${titlePrefix}" within ${gateWindowHours}h → low-priority breadcrumb (no escalation).`,
      );

      // No issue for this crawler yet → record in the ledger and stop. This is
      // the line that keeps a lone network blip out of the backlog entirely;
      // the old behaviour opened a `crawler-transient` issue here (#5139/#5137).
      // If the ledger is unavailable we deliberately fall through to the legacy
      // per-crawler issue rather than dropping the signal.
      if (!existing && ledgerNumber) {
        const recorded = recordLedgerEvent(
          ledgerNumber, titlePrefix, thisEventOrdinal, gateThreshold,
          [workflow ? `**Workflow:** ${workflow}` : '', description || '_no details provided_']
            .filter(Boolean).join('\n\n'),
        );
        if (recorded) {
          console.log(
            `[github-issue-creator] Recorded transient failure in ledger #${ledgerNumber} `
            + `— no per-crawler issue opened (${thisEventOrdinal}/${gateThreshold}).`,
          );
          return { number: ledgerNumber, title: TRANSIENT_LEDGER_TITLE, url: null, ledger: true };
        }
        console.error('[github-issue-creator] Ledger write failed; falling back to per-crawler issue.');
      }
    } else {
      console.log(
        `[github-issue-creator] Gate: failure ${thisEventOrdinal}/${gateThreshold} for `
        + `"${titlePrefix}" → escalating to priority ${priority}.`,
      );
    }
  }

  // Build label set: priority label + caller-supplied labels. While gated below
  // threshold, attach `crawler-transient` so triage/fixer skip the breadcrumb.
  const priorityLabel = PRIORITY_LABEL[Number(effectivePriority)] || PRIORITY_LABEL[3];
  const labelSet = Array.from(
    new Set([
      priorityLabel,
      ...(gatedBelowThreshold ? [CRAWLER_TRANSIENT_LABEL] : []),
      ...labels,
    ].filter(Boolean)),
  );

  // Body: workflow name + description, truncated to GH limit.
  const bodyLines = [];
  if (workflow) bodyLines.push(`**Workflow:** ${workflow}`);
  if (bodyLines.length > 0) bodyLines.push('');
  bodyLines.push(description || '_no details provided_');
  let body = bodyLines.join('\n');
  if (body.length > MAX_BODY_LEN) body = body.slice(0, MAX_BODY_LEN - 30) + '\n\n...(truncated)';

  if (existing) {
    // Post a comment instead of opening a duplicate.
    try {
      gh([
        'issue', 'comment', String(existing.number),
        '--body', `${RECURRENCE_MARKER} Recurrence on workflow run.\n\n${body}`,
        ...repoFlag(),
      ]);
      // Gate escalation: this failure reached/passed the threshold → promote the
      // canonical breadcrumb from priority:low/crawler-transient to the caller's
      // priority so the fixer pipeline picks it up. Idempotent if already there.
      if (gateThreshold > 0 && !gatedBelowThreshold) {
        const targetLabel = PRIORITY_LABEL[Number(priority)] || PRIORITY_LABEL[3];
        setIssuePriorityLabel(existing.number, targetLabel, labels);
        gh([
          'issue', 'edit', String(existing.number),
          '--remove-label', CRAWLER_TRANSIENT_LABEL,
          ...repoFlag(),
        ], { allowFailure: true });
        console.log(`[github-issue-creator] Escalated #${existing.number} → ${targetLabel}`);
      }
      console.log(`[github-issue-creator] Commented on existing #${existing.number} — ${existing.title}`);
      return { number: existing.number, title: existing.title, url: existing.url };
    } catch (err) {
      console.error(`[github-issue-creator] Failed to comment on #${existing.number}: ${err.message}`);
      return existing;
    }
  }

  // No OPEN duplicate. For transient reporters, check whether the SAME canonical
  // issue was recently closed (e.g. auto-closed on a green deploy) and is now
  // flapping red again. Reopen + comment instead of minting a new issue — this
  // is what stops the per-deploy-run churn (#928/#931/#937/#941) from recurring.
  if (reopenWithinHours > 0) {
    const recentlyClosed = findRecentlyClosedIssueByTitlePrefix(title, reopenWithinHours);
    if (recentlyClosed) {
      // Deploy-latency guard (#5539): a build started BEFORE the fix that closed
      // this issue merged cannot possibly contain it — a validation failing on
      // that stale build is the same pre-fix breakage observed again, not a
      // recurrence. Only checked when the caller can supply buildSha; degrades
      // to the pre-#5539 unconditional reopen on any lookup failure.
      //
      // TWO rungs, strongest first. #5539 shipped only the first, and the first
      // needs a closing commit SHA that this repo's automation does not leave
      // behind (see findClosingCommitSha): measured 2026-08-13, all three
      // reopens of the day — #5729, #5786, #5752 — got null from it and were
      // reopened unconditionally on builds that predated their own fix by 3, 3
      // and 26 minutes. The ladder is what makes the guard reachable; either
      // rung firing means the same thing (this build cannot contain the fix)
      // and both abstain LOUDLY, never in silence.
      if (buildSha) {
        const closingSha = findClosingCommitSha(recentlyClosed.number, recentlyClosed.closedAt);
        let staleReason = null;
        if (closingSha) {
          // Rung 1 — graph proof. A closing SHA we could not prove stale is NOT
          // downgraded to the timestamp rung: the strong answer was available
          // and it said "this build already has the fix", which is a real
          // recurrence. Falling through would let the coarse rung overturn it.
          if (isAncestorCommit(buildSha, closingSha)) {
            staleReason = `precede la fix (commit \`${closingSha}\`) che ha chiuso questa issue`;
          }
        } else {
          // Rung 2 — timestamp proof, only when no closing SHA exists at all.
          const builtAt = buildPredatesClose(buildSha, recentlyClosed.closedAt);
          if (builtAt) {
            staleReason = `è stata committata (\`${builtAt}\`) prima che questa issue venisse chiusa (\`${recentlyClosed.closedAt}\`); il commit di chiusura non è ricavabile, quindi il confronto è sui timestamp`;
          }
        }
        if (staleReason) {
          const note = `⏳ Build \`${buildSha}\` ${staleReason} — è latenza del deploy dentro la finestra post-merge, non una ricorrenza. Riapertura saltata; in attesa di una build che contenga la fix.`;
          gh([
            'issue', 'comment', String(recentlyClosed.number),
            '--body', `${note}\n\n${body}`,
            ...repoFlag(),
          ], { allowFailure: true });
          appendStepSummary(`⏳ **Riapertura saltata** — la run su \`${buildSha}\` non contiene la fix che ha chiuso #${recentlyClosed.number}. ${staleReason}.`);
          console.log(`[github-issue-creator] Stale build ${buildSha} predates the close of #${recentlyClosed.number} — not reopening (deploy latency).`);
          return { number: recentlyClosed.number, title: recentlyClosed.title, url: recentlyClosed.url, staleBuild: true };
        }
      }
      const reopened = gh(
        ['issue', 'reopen', String(recentlyClosed.number), ...repoFlag()],
        { allowFailure: true },
      );
      if (reopened !== null) {
        gh([
          'issue', 'comment', String(recentlyClosed.number),
          '--body', `🔁 Reopened — same failure recurred within ${reopenWithinHours}h of being closed.\n\n${body}`,
          ...repoFlag(),
        ], { allowFailure: true });
        console.log(`[github-issue-creator] Reopened #${recentlyClosed.number} — ${recentlyClosed.title}`);
        return { number: recentlyClosed.number, title: recentlyClosed.title, url: recentlyClosed.url };
      }
      // Reopen failed (e.g. closed-as-duplicate locked) → fall through to create.
      console.error(`[github-issue-creator] Could not reopen #${recentlyClosed.number}; creating fresh issue.`);
    }
  }

  // Create labels if missing, then open the issue.
  ensureLabelsExist(labelSet);
  const args = [
    'issue', 'create',
    '--title', title.slice(0, 200),
    '--body', body,
    ...labelSet.flatMap((l) => ['--label', l]),
    ...repoFlag(),
  ];
  try {
    const url = gh(args).split('\n').pop().trim();
    console.log(`[github-issue-creator] Created: ${url}`);
    // Parse issue number from URL for return value
    const m = url.match(/\/issues\/(\d+)/);
    return { number: m ? Number(m[1]) : null, title, url };
  } catch (err) {
    // Why: this helper runs in `if: failure()` reporter steps. If posting to
    // GH fails (missing GH_TOKEN, API outage, perms), we must NOT lose the
    // diagnostics — dump them so the workflow log preserves the upstream
    // error context. Callers should still treat this as best-effort (CLI
    // mode exits 0 below).
    console.error(`[github-issue-creator] Failed to create issue: ${err.message}`);
    console.error('[github-issue-creator] --- begin issue body fallback ---');
    console.error(`Title: ${title}`);
    if (workflow) console.error(`Workflow: ${workflow}`);
    console.error(body);
    console.error('[github-issue-creator] --- end issue body fallback ---');
    return null;
  }
}

// CLI mode — mirrors github-issue-creator.mjs flag set so workflow scripts
// only need to swap the .mjs filename in the path.
if (process.argv[1]?.endsWith('github-issue-creator.mjs')) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  const collect = (flag) => {
    const values = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) values.push(args[i + 1]);
    }
    return values;
  };

  const title = get('--title');
  if (!title) {
    console.error('Usage: node github-issue-creator.mjs --title "..." [--description "..."] [--priority N] [--label Bug] [--workflow "Update Coop"] [--reopen-within-hours N] [--build-sha SHA] [--consecutive-gate N] [--gate-window-hours H] [--resolve]');
    process.exit(1);
  }

  // --resolve: close the OPEN canonical issue with this stable title (green run).
  // Mirror of the failure reporter; runs from `if: success()` steps so a recovered
  // gate doesn't leave a stale open issue. Best-effort, always exits 0.
  if (args.includes('--resolve')) {
    resolveGithubIssue(title, { workflow: get('--workflow'), runUrl: get('--run-url') });
    process.exit(0);
  }

  // --consecutive-gate: N>0 forces the gate (escalate on the Nth failure);
  // N<0 opts a `Crawler Failure:` title OUT of the auto-gate; omitted = auto.
  const rawGate = get('--consecutive-gate');
  const consecutiveGate = rawGate === undefined ? 0 : Number(rawGate);

  createGithubIssue({
    title,
    description: get('--description') || '',
    priority: Number(get('--priority') || 3),
    labels: (() => {
      const single = get('--label');
      const many = collect('--label');
      return many.length > 0 ? many : (single ? [single] : ['bug']);
    })(),
    workflow: get('--workflow'),
    reopenWithinHours: Number(get('--reopen-within-hours') || 0),
    // Same semantics as the `buildSha` option: the commit the BUILD was made
    // from (`workflow_run.head_sha` / `deploy_ref`), NEVER the head_sha of the
    // run that observed the failure — for a workflow_run-triggered validation
    // those differ, and only the build one proves staleness. Measured on the
    // 2nd reopen of #5729: validation head_sha ae8b2d9a compares "behind" the
    // fix (→ would have reopened, wrongly), while build 8085cd36 compares
    // "ahead" of it, i.e. built 37 min BEFORE the fix landed.
    // Empty string → null → unconditional reopen, the fail-safe default: a
    // caller that has no build SHA must not get an abstention built on a value
    // it never supplied.
    buildSha: get('--build-sha') || null,
    consecutiveGate: Number.isFinite(consecutiveGate) ? consecutiveGate : 0,
    gateWindowHours: Number(get('--gate-window-hours') || DEFAULT_CRAWLER_GATE_WINDOW_HOURS),
  }).then(() => {
    // Why: this CLI is a best-effort reporter invoked from `if: failure()`
    // steps after the real failure has already been recorded. Exiting non-zero
    // here would add a second red step and risk hiding the upstream cause —
    // the body fallback above keeps the diagnostics in the workflow log.
    process.exit(0);
  }).catch((err) => {
    console.error(`[github-issue-creator] Error: ${err.message}`);
    process.exit(0);
  });
}

