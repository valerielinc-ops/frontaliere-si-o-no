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
 * instead of creating a duplicate.
 */

import { execFileSync } from 'node:child_process';

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
// update-jobs-* twice daily (~12h apart), so 3 consecutive failures span ~24h; a
// 24h window leaves the oldest event sitting on the cutoff (CI jitter decides
// inclusion) → escalation becomes a coin-flip and real breakage can decay
// silently. 48h gives a full cadence of margin so the 3rd consecutive failure
// deterministically escalates, while a lone transient still expires as intended.
const DEFAULT_CRAWLER_GATE_WINDOW_HOURS = 48; // failures older than this don't count
const CRAWLER_TRANSIENT_LABEL = 'crawler-transient';
const RECURRENCE_MARKER = '🔁'; // prefixes every recurrence comment we post

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

// `fullTitle` is the complete issue title (callers must NOT pre-slice it — the
// mid-word-cut detection in searchSafePrefix needs the char at the ceiling).
function searchIssuesByTitlePrefix(fullTitle, state) {
  const safePrefix = searchSafePrefix(fullTitle);
  const out = gh([
    'issue', 'list',
    '--state', state,
    '--search', `in:title "${safePrefix.replace(/"/g, '\\"')}"`,
    '--limit', '10',
    '--json', 'number,title,url,closedAt,state',
    ...repoFlag(),
  ], { allowFailure: true });
  if (!out) return [];
  try {
    const issues = JSON.parse(out);
    // `gh issue list --search "in:title ..."` è token-match (fuzzy): titoli che
    // condividono token (es. "...(dist): post-deploy" vs "...(live): post-deploy",
    // o "CI Failure: Refresh Job Popularity" vs "...Refresh BFS Stats") possono
    // entrambi comparire. Filtra al match esatto di prefisso → niente commento
    // sul canonical sbagliato (altrimenti dist commenterebbe su issue live).
    // Match sul prefisso SANITIZZATO (stesso usato per la query) così il filtro
    // resta coerente quando lo slice grezzo era stato troncato a metà token.
    return issues.filter((i) => typeof i.title === 'string' && i.title.startsWith(safePrefix));
  } catch {
    return [];
  }
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
    const priorEvents = existing ? countRecentFailureEvents(existing.number, gateWindowHours) : 0;
    const thisEventOrdinal = priorEvents + 1;
    if (thisEventOrdinal < gateThreshold) {
      effectivePriority = 4; // priority:low breadcrumb
      gatedBelowThreshold = true;
      console.log(
        `[github-issue-creator] Gate: failure ${thisEventOrdinal}/${gateThreshold} for `
        + `"${titlePrefix}" within ${gateWindowHours}h → low-priority breadcrumb (no escalation).`,
      );
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
    console.error('Usage: node github-issue-creator.mjs --title "..." [--description "..."] [--priority N] [--label Bug] [--workflow "Update Coop"] [--reopen-within-hours N] [--consecutive-gate N] [--gate-window-hours H] [--resolve]');
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

