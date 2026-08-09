#!/usr/bin/env node
/**
 * close-recovered-failure-issues.mjs — zero-Claude reconciler.
 *
 * Auto-closes the auto-generated `Workflow Failure: <name>` / `Crawler Failure: <name>` /
 * `CI Failure: <name>` issues once the workflow has recovered — i.e. its NEXT run after
 * the failure is green. These three are the only failure-title prefixes minted by the
 * github-issue-creator.mjs reporters across all workflows (Crawler 439, Workflow 50, CI 8).
 *
 * WHY this is centralized (one reconciler, not 300 per-workflow steps):
 * Every scheduled workflow already opens a stable-titled issue on `if: failure()` via
 * scripts/lib/github-issue-creator.mjs. The mirror `--resolve` step (close on green) was
 * only ever wired into ~5 workflows (deploy/lighthouse/post-deploy/watchdog), so the
 * ~300 `update-jobs-*` crawlers, `update-fuel-prices`, `quality-alerts`, etc. left their
 * failure issue OPEN even when the very next run went green (e.g. #2354: failed run
 * 27646211111, then two green runs, issue stayed open). Wiring `--resolve` into every
 * workflow file = 300-file churn that silently misses any future workflow. Instead this
 * single cron job reconciles ALL of them — present and future — by construction.
 *
 * ALGORITHM for `Workflow Failure:` / `CI Failure:` issues (unchanged):
 *   1. Parse the workflow display name out of the stable title prefix.
 *   2. Ask GitHub for that workflow's most-recent COMPLETED run on `main`.
 *   3. If that run is `success` AND started after the issue was opened (so it is a run
 *      that happened *after* the reported failure, not a stale pre-failure green) →
 *      close the issue via the same resolveGithubIssue() the inline `--resolve` uses
 *      (posts the "✅ Auto-resolved — green again" comment; reopens automatically if the
 *      same failure recurs) — UNLESS the STRUCTURAL HOLD below applies.
 *   4. Otherwise (latest completed run still red, or no completed run / renamed workflow)
 *      → leave the issue open. Bias is conservative: never close while currently red.
 *
 * ── STRUCTURAL HOLD (#5454): a green run is a statement about the SYMPTOM ──────────────
 *
 * Steps 1-3 close on the symptom. For a transient failure (a network `ETIMEDOUT`, a
 * provider 429) that is exactly right: the condition is gone and the issue is noise.
 * For a STRUCTURAL defect it is a loss, because the diagnosis written into the issue's
 * comments goes with it — and the defect returns the moment its condition recurs.
 *
 * MEASURED, both repos:
 *   - corpus #76 / #77, closed 2026-08-09T08:25:1{4,7}Z with "✅ Auto-resolved — the
 *     failing check is green again". Neither fix had been applied: `scripts/lib/
 *     npm-ci-retry.sh` was a 404 and `fast-publish-article.yml` still ran a bare
 *     `npm ci`. #77 was then REOPENED by a human at 12:13:57Z and re-closed by this
 *     very reconciler at 12:17:55Z — four minutes later.
 *   - this repo: `CI Failure: PR auto-rebase (near-merge only, no-Claude)` came back as a
 *     NEW issue EIGHT times in thirteen days (#4712, #4977, #5038, #5054, #5090, #5144,
 *     #5145, #5173) — same structural defect, a fresh issue each time because the
 *     previous one had been closed. Ten issues here have ever had a failure title and
 *     the `blocked-workflows-scope` label; all ten carried that marker as their LAST
 *     verdict, and six were auto-closed by this script on green.
 *
 * THE SIGNAL — the LAST `<!-- FIX_OUTCOME: <code> -->` marker in the issue's comments,
 * restricted to the three BLOCKED codes (see STRUCTURAL_OUTCOMES). That marker is the
 * fixer's own verdict: `blocked-*` means "the root cause was found and a fix was
 * written, and the automation cannot push it" — a permission/credential fact that no
 * amount of green changes. Parsed with the same regex and the same last-marker-wins rule
 * followup-drainer.mjs already uses, so there is one reading of the marker in the repo.
 *
 * WHY NOT the other two candidates — both were falsified against the incident, not
 * reasoned about:
 *   - the `blocked-workflows-scope` LABEL: absent from corpus #76/#77 (labels were
 *     `bug, agent:triaged, fu-prio:high, fu-parked, priority:high`). Only
 *     check-workflows-scope.mjs's applyBlockedOutcome() applies it, and that function
 *     posts the SAME marker in the same breath; the followup-drainer pre-flight path
 *     that actually parked #76/#77 posts the marker with NO label. Marker ⊋ label: the
 *     label adds zero coverage where the marker fires and misses the incident itself.
 *   - the `fu-parked` LABEL: too wide, and wide in the worst direction. The drainer
 *     parks after MAX_ATTEMPTS, and the documented road to `fu-attempt:3 → fu-parked`
 *     runs through three Claude quota 429s (followup-drainer.mjs, claude-rate-limit.mjs
 *     naming #5004/#5001/#4974). `fu-parked` therefore means "out of the active queue",
 *     transient causes included — holding on it would pin open the exact class this
 *     reconciler exists to close.
 *
 * THE OPPOSITE RISK — a hold that never releases turns the queue into a graveyard, and
 * scan-failed-runs.mjs opens one issue per failing workflow. Four bounded valves:
 *   1. The hold RELEASES ITSELF. Only the LAST marker counts, so when the fix finally
 *      lands the next verdict (`pr-created`, `already-fixed`) makes the issue closeable
 *      and this reconciler closes it on the following pass. No human bookkeeping.
 *   2. Holding SHRINKS the queue for a recurring defect instead of growing it.
 *      createGithubIssue() dedups against OPEN issues by title prefix and comments on
 *      the match rather than minting a duplicate — so one held issue absorbs every
 *      recurrence. The `PR auto-rebase` defect above would have been 1 issue, not 8.
 *      Replayed over the last 250 closed issues here: of the 33 that this reconciler
 *      auto-closed, 26 still close and 7 would be held — and those 7 collapse to 4
 *      distinct titles, i.e. 4 open issues in steady state.
 *   3. A TTL (HOLD_MAX_DAYS, default 14). A blocked verdict that is still the last word
 *      after 14 days, with the check green, is a stale diagnosis, not a live fix: the
 *      issue closes anyway, with a comment saying so. 14 is above every observed
 *      lifetime of a `blocked-workflows-scope` issue in this repo (31 issues ever, max
 *      8.7 days, second-longest 3.9) — so it is a ceiling, not a schedule.
 *   4. Comments unreadable → hold, but only until the TTL measured from the issue's own
 *      createdAt. A permanently broken comment read degrades to "closes 14 days late",
 *      never to "never closes".
 *
 * The hold posts ONE comment (idempotent via HOLD_MARKER) and leaves the issue open. It
 * never labels, never reopens, never edits: the reconciler's blast radius stays "close
 * or don't close".
 *
 * ALGORITHM for `Crawler Failure:` issues — DIFFERENT since the crawler-workflow
 * consolidation (2026-07, see scripts/generate-crawler-group-workflows.mjs): 581
 * individual per-crawler workflows were replaced by 23 grouped `crawler-group-*.yml`
 * workflows, each running ~25 crawlers as concurrent `background: true` steps inside
 * ONE job. `Crawler Failure:` titles now embed `Run <slug>` (the crawler's OWN
 * background-step name, baked in as a literal at generation time — see that script's
 * "HAZARD FIX 3" comment) instead of a dispatchable workflow name, because
 * `${{ github.workflow }}` would otherwise resolve to the shared GROUP's name for every
 * crawler in it. `Run <slug>` cannot be looked up via `gh run list -w <name>` (it isn't a
 * workflow) — it identifies one STEP inside a group's shared job. So for these:
 *   1. Extract the crawler slug from `Run <slug>`.
 *   2. Find which `crawler-group-*.yml` file currently contains that crawler (greps each
 *      group file's `id: crawler-<slug>` markers — group membership can shift whenever
 *      the generator re-runs, so this is resolved fresh each time, not cached).
 *   3. Ask GitHub for that GROUP workflow's most-recent COMPLETED run on `main`.
 *   4. Fetch that run's job(s) via the Jobs API and find the STEP named `Run <slug>`
 *      inside it — steps have their OWN independent `conclusion` in the API response
 *      (confirmed empirically against a live run using this repo's other background-step
 *      workflow), so a sibling crawler's failure in the same job does NOT affect this
 *      step's own conclusion.
 *   5. If that STEP's conclusion is `success` and the run started after the issue was
 *      opened → close, exactly as the non-crawler path (structural hold included).
 *      Otherwise keep open.
 *   If the crawler can't be found in any current group file (renamed/removed), or the
 *   step can't be found in the run's job list (renamed background step id) → keep open
 *   (same conservative bias as the "no completed run" case).
 *
 * Best-effort and idempotent: safe to run on a schedule. `--dry-run` reports without
 * mutating. Scope is strictly the three auto-generated failure-title prefixes; follow-up,
 * tracker, validation-failure and other issues are never touched.
 *
 * Known edge: a workflow whose failure title names something that does NOT equal its
 * `name:` won't resolve via `gh run list -w <title>` → its issue stays open forever
 * (conservative/safe, but indistinguishable from "covered" by eye — the title HAS the
 * right prefix, so this reconciler picks it up and then finds no run).
 *
 * This docstring used to claim `persist-job-stats` was the ONLY such workflow. It is
 * not: the mismatch is now MEASURED rather than asserted, by
 * `node scripts/ci/failure-issue-inventory.mjs --json` (rows carrying a `detail`), and
 * pinned as a shrink-only baseline in tests/failure-issue-closers.test.ts. Three at the
 * time of writing (#5437):
 *   - persist-job-stats.yml   "CI Failure: Persist Job Stats"        vs "Persist Job Stats History"
 *   - fast-publish-article.yml"Workflow Failure: Fast Publish Article" vs "Fast Publish Article (near-instant …)"
 *   - crawl-events.yml        "Crawler Failure: events pipeline (…)" vs "Crawl Ticino + nationwide + …"
 * Fixing each mismatch belongs in its own workflow file, not here — and must be done
 * while no issue with the OLD title is open, because dedup is by title and a rename
 * orphans whatever is already open.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGithubIssue, commentOnGithubIssue } from '../lib/github-issue-creator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const DRY_RUN = process.argv.includes('--dry-run');
// Stable titles minted by github-issue-creator.mjs failure reporters. For `Workflow`/`CI`
// prefixes, group 2 is the workflow display name (equals `github.workflow` and `gh run
// list -w <name>`). For `Crawler` prefixes (post-consolidation), group 2 is instead the
// literal `Run <slug>` background-step identifier — see the module docstring above.
export const TITLE_RE = /^(?:Workflow|Crawler|CI) Failure: (.+)$/;
export const CRAWLER_STEP_RE = /^Run (.+)$/;
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

// ── Structural hold (#5454) ───────────────────────────────────────────────────────────

// Same shape followup-drainer.mjs parses (`FIX_OUTCOME_RE` there). Kept as a local
// literal rather than an import: this module is `mode: identical` in the corpus
// loop-sync manifest and must stay copyable with only scripts/lib/github-issue-creator
// alongside it.
export const FIX_OUTCOME_RE = /<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i;

/**
 * Verdicts that mean "root cause found, fix written, automation cannot apply it".
 * Deliberately NOT the whole FIX_OUTCOME vocabulary:
 *   `pr-created`     → the fix is in flight and its PR carries `Closes #n`; holding here
 *                      would double-handle what the PR layers already own.
 *   `already-fixed`  → applied by definition.
 *   `no-root-cause`  → nothing was written down, so closing loses nothing — holding it
 *                      would be pure graveyard.
 *   `overlap-skip` / `pr-already-open` → scheduling, resolved by the next pass.
 *   `rate-limited`   → transient by construction; check-quota-backoff.mjs re-queues.
 */
export const STRUCTURAL_OUTCOMES = Object.freeze([
  'blocked-workflows-scope',
  'blocked-secrets',
  'blocked-admin-settings',
]);

/** Idempotency marker for the "held open" comment — posted once, never per pass. */
export const HOLD_MARKER = '<!-- CLOSE_RECOVERED: structural-hold -->';

/** Graveyard valve. See docstring valve 3 for why 14 and not "forever". */
// 9, non 14. Il `followup-drainer` — anch'esso `mode: identical`, quindi vivo
// su entrambi i repo — chiude per age-out a FOLLOWUP_AGEOUT_DAYS=10 le issue
// che `classifyIssue` instrada in coda, e i titoli «Workflow Failure:» /
// «CI Failure:» ci finiscono tutti (osservato: #4641 chiusa a 13,4 giorni con
// «Auto-chiusa dal followup-drainer»). Un TTL a 14 sarebbe quindi in gran parte
// IRRAGGIUNGIBILE: la diagnosi verrebbe buttata da un altro strato, ~4 giorni
// prima, con una nota («mai entrato in lavorazione») falsa per una issue tenuta
// apposta. Stare sotto i 10 rende questo TTL quello che decide davvero.
export const DEFAULT_HOLD_MAX_DAYS = 9;

function holdMaxDays() {
  const raw = Number(process.env.CLOSE_RECOVERED_HOLD_MAX_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOLD_MAX_DAYS;
}

/**
 * The LAST `<!-- FIX_OUTCOME: <code> -->` in a comment list, as `{ code, at }`, or null.
 *
 * "Last" is by comment timestamp, not array position: the REST listing is oldest-first
 * today, but ordering is not part of that contract and a wrong pick here inverts the
 * decision (an old `blocked-*` beating a newer `pr-created` would pin the issue open
 * forever). Comments without a parseable timestamp keep their relative array position,
 * so a caller passing plain `{ body }` objects still gets last-wins.
 *
 * Accepts both `createdAt` (gh --json) and `created_at` (REST) spellings.
 *
 * @param {Array<{body?: string, createdAt?: string, created_at?: string}>} comments
 */
export function lastFixOutcome(comments) {
  if (!Array.isArray(comments)) return null;
  const ordered = comments
    .map((c, i) => {
      const stamp = Date.parse(c?.createdAt ?? c?.created_at ?? '');
      return { c, i, t: Number.isNaN(stamp) ? null : stamp };
    })
    .sort((a, b) => (a.t !== null && b.t !== null && a.t !== b.t ? a.t - b.t : a.i - b.i));

  let found = null;
  for (const { c, t } of ordered) {
    const m = FIX_OUTCOME_RE.exec(String(c?.body || ''));
    if (m) found = { code: m[1].toLowerCase(), at: t };
  }
  return found;
}

/** True when any comment already carries the hold marker (so we comment once). */
export function alreadyHeld(comments) {
  return Array.isArray(comments)
    && comments.some((c) => String(c?.body || '').includes(HOLD_MARKER));
}

/**
 * Decide whether a recovered issue must be HELD OPEN instead of closed.
 *
 * Called only once the check is already green and the green run post-dates the issue —
 * i.e. exactly at the moment the old code would have closed.
 *
 * @param {Array|null} comments  the issue's comments, or `null` when unreadable
 * @param {{ issueCreatedAt?: string, now?: number, maxDays?: number }} [opts]
 * @returns {{ hold: boolean, code: string|null, unknown: boolean, notified: boolean,
 *            ageDays: number|null, reason: string }}
 */
export function decideStructuralHold(comments, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxDays = opts.maxDays ?? holdMaxDays();
  const ageInDays = (ms) => (now - ms) / 86400000;

  // Unreadable comments: we cannot tell transient from structural. Hold — but bounded by
  // the SAME TTL, measured on the issue itself, so a permanently failing read degrades
  // to "closes late", not "never closes". `notified: true` suppresses the comment: we
  // would not be able to see our own marker, so posting one would spam every pass.
  if (comments === null || comments === undefined) {
    const opened = Date.parse(opts.issueCreatedAt ?? '');
    const age = Number.isNaN(opened) ? null : ageInDays(opened);
    if (age !== null && age > maxDays) {
      return {
        hold: false,
        code: null,
        unknown: true,
        notified: true,
        ageDays: age,
        reason: `comments unreadable and issue is ${age.toFixed(1)}d old (> ${maxDays}d TTL) — closing`,
      };
    }
    return {
      hold: true,
      code: null,
      unknown: true,
      notified: true,
      ageDays: age,
      reason: 'comments unreadable — holding until the next pass (bounded by the TTL)',
    };
  }

  const verdict = lastFixOutcome(comments);
  if (!verdict) {
    return { hold: false, code: null, unknown: false, notified: false, ageDays: null, reason: 'no FIX_OUTCOME verdict — transient by default' };
  }
  if (!STRUCTURAL_OUTCOMES.includes(verdict.code)) {
    return { hold: false, code: verdict.code, unknown: false, notified: false, ageDays: null, reason: `last verdict '${verdict.code}' is not structural` };
  }

  // F3: un verdetto il cui commento non ha timestamp parsabile lasciava `age`
  // a null, saltava il ramo TTL e teneva la issue in hold PER SEMPRE — cioe'
  // la quinta valvola non c'era. Si ricade sull'eta' della issue, esattamente
  // come fa gia' il ramo «commenti illeggibili» qui sopra: un hold non deve
  // mai poter essere illimitato, qualunque cosa non si riesca a leggere.
  let age = verdict.at === null ? null : ageInDays(verdict.at);
  if (age === null) {
    const opened = Date.parse(opts.issueCreatedAt ?? '');
    if (!Number.isNaN(opened)) age = ageInDays(opened);
  }
  if (age !== null && age > maxDays) {
    return {
      hold: false,
      code: verdict.code,
      unknown: false,
      notified: alreadyHeld(comments),
      ageDays: age,
      reason: `structural verdict '${verdict.code}' is ${age.toFixed(1)}d old (> ${maxDays}d TTL) — stale diagnosis, closing`,
    };
  }
  return {
    hold: true,
    code: verdict.code,
    unknown: false,
    notified: alreadyHeld(comments),
    ageDays: age,
    reason: `last verdict '${verdict.code}' is structural — the written fix was never applied`,
  };
}

/** The one comment the hold posts. Contains HOLD_MARKER, which makes it idempotent. */
export function structuralHoldNote({ code, workflow, runUrl, maxDays = DEFAULT_HOLD_MAX_DAYS } = {}) {
  return [
    `⏸️ **Sintomo rientrato, issue tenuta aperta.** L'ultimo run${workflow ? ` di \`${workflow}\`` : ''} è verde${runUrl ? ` (${runUrl})` : ''}, quindi il *sintomo* non c'è più.`,
    '',
    `Non la chiudo: l'ultimo verdetto registrato qui è \`${code}\`, cioè la root cause è stata trovata e **il fix è scritto nei commenti ma non è mai stato applicato** (l'automazione non ha i permessi per pusharlo). Il guasto è strutturale: si ripresenta appena ricapita la condizione che l'ha causato, e chiuderla ora butterebbe via il fix già scritto.`,
    '',
    `Si sblocca da sola: appena il fix atterra, il verdetto successivo (\`pr-created\` / \`already-fixed\`) rende la issue di nuovo chiudibile e questo reconciler la chiude al giro dopo, senza che nessuno debba toccarla.`,
    '',
    `Valvola anti-cimitero: se \`${code}\` resta l'ultimo verdetto per più di ${maxDays} giorni con il check verde, la issue viene chiusa comunque.`,
    '',
    HOLD_MARKER,
  ].join('\n');
}

/** The note posted just before a TTL-released close, so the close is never silent. */
export function ttlReleaseNote({ code, maxDays = DEFAULT_HOLD_MAX_DAYS, ageDays } = {}) {
  const age = typeof ageDays === 'number' ? `${ageDays.toFixed(1)} giorni` : `oltre ${maxDays} giorni`;
  return [
    `🗓️ **Chiusa dopo il TTL del hold strutturale.** Il verdetto \`${code}\` è fermo da ${age} (soglia: ${maxDays}) e nel frattempo il check è tornato verde e non è più fallito.`,
    '',
    'Una diagnosi che nessuno applica per così a lungo, su un guasto che non si ripresenta, è una diagnosi stantia — non un fix in coda. Se il guasto torna, il reporter riapre questa stessa issue (dedup per titolo) con il contesto nuovo.',
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────────────

function repoFlag() {
  return REPO ? ['--repo', REPO] : [];
}

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

function listFailureIssues() {
  const out = gh([
    'issue', 'list', '--state', 'open', '--limit', '300',
    '--json', 'number,title,createdAt', ...repoFlag(),
  ]);
  return JSON.parse(out)
    .map((i) => ({ issue: i, m: TITLE_RE.exec(i.title) }))
    .filter(({ m }) => m)
    .map(({ issue, m }) => ({
      number: issue.number,
      title: issue.title,
      createdAt: issue.createdAt,
      workflow: m[1].trim(),
    }));
}

/**
 * The issue's comments, oldest-first, or `null` when they cannot be read.
 *
 * Fetched LAZILY — only for an issue that is already about to be closed. On the common
 * path (still red, or green but pre-dating the issue) this costs zero extra API calls,
 * which is what keeps a 300-issue listing from turning into 300 comment fetches.
 *
 * `null` (not `[]`) on failure is load-bearing: `[]` would read as "no verdict → close",
 * which is precisely the mistake this whole section exists to stop.
 */
function fetchIssueComments(issueNumber) {
  const out = gh(
    ['api', `repos/${REPO || '{owner}/{repo}'}/issues/${issueNumber}/comments`, '--paginate'],
    { allowFailure: true },
  );
  if (out === null) return null;
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // `--paginate` concatenates pages as separate JSON arrays; splice them.
    try {
      const spliced = JSON.parse(`[${out.replace(/\]\s*\[/g, ',').replace(/^\s*\[|\]\s*$/g, '')}]`);
      return Array.isArray(spliced) ? spliced : null;
    } catch {
      return null;
    }
  }
}

// Most-recent COMPLETED run of the named workflow on main, or null if the workflow has
// no runs (e.g. renamed/deleted) — in which case we conservatively leave the issue open.
function latestCompletedRun(workflowName) {
  const out = gh([
    'run', 'list', '-w', workflowName, '-b', 'main', '-L', '20',
    '--json', 'databaseId,conclusion,status,createdAt', ...repoFlag(),
  ], { allowFailure: true });
  if (out === null) return null;
  let runs;
  try {
    runs = JSON.parse(out);
  } catch {
    return null;
  }
  return runs.find((r) => r.status === 'completed') || null;
}

// Find which crawler-group-*.yml currently contains a crawler's background step
// (`id: crawler-<slug>`). Group membership can shift whenever
// scripts/generate-crawler-group-workflows.mjs re-runs, so this reads the CURRENT
// workflow files directly each run (this script itself runs as a single short-lived
// process per cron invocation, so a fresh checkout is picked up naturally on the next
// scheduled run; no cross-invocation cache is kept). Returns the group workflow's
// `name:` (the dispatchable display name `gh run list -w` needs), or null if the
// crawler isn't found in any current group file.
export function findCrawlerGroupWorkflowName(slug, workflowsDir = WORKFLOWS_DIR) {
  const groupFiles = fs.existsSync(workflowsDir)
    ? fs.readdirSync(workflowsDir).filter((f) => /^crawler-group-\d+\.yml$/.test(f))
    : [];
  // Anchored, whole-line match (not a plain substring check): a naive
  // `content.includes('id: crawler-' + slug)` would false-positive when one
  // crawler's slug is a prefix of another's in the same file (e.g. looking up
  // slug "hoch" would substring-match the UNRELATED "id: crawler-hoch-health"
  // line and return the wrong group) — the exact bug class flagged in
  // AdminPanel.tsx's failedSteps narrowing, guarded here too.
  const idLineRe = new RegExp(`^\\s*id:\\s*crawler-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  for (const file of groupFiles) {
    const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    if (idLineRe.test(content)) {
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      if (nameMatch) return nameMatch[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

// Most-recent COMPLETED run of the named GROUP workflow, then the conclusion of the
// SPECIFIC background step named `Run <slug>` inside that run's job (steps carry their
// own independent conclusion in the Jobs API — a sibling crawler's failure in the same
// job does not affect this step's own conclusion). Returns
// { conclusion, status: 'completed', createdAt, databaseId } shaped like a run object
// (so the caller's existing green/afterFailure logic works unchanged), or null if the
// run, job, or step can't be resolved.
function latestCompletedCrawlerStepRun(slug) {
  const groupWorkflowName = findCrawlerGroupWorkflowName(slug);
  if (!groupWorkflowName) return null;

  const run = latestCompletedRun(groupWorkflowName);
  if (!run) return null;

  const jobsOut = gh(['api', `repos/${REPO || '{owner}/{repo}'}/actions/runs/${run.databaseId}/jobs`], { allowFailure: true });
  if (jobsOut === null) return null;
  let jobsData;
  try {
    jobsData = JSON.parse(jobsOut);
  } catch {
    return null;
  }
  const stepName = `Run ${slug}`;
  for (const job of jobsData.jobs || []) {
    const step = (job.steps || []).find((s) => s.name === stepName);
    if (step) {
      return {
        databaseId: run.databaseId,
        status: step.status,
        conclusion: step.conclusion,
        createdAt: run.createdAt,
      };
    }
  }
  return null; // background step not found in this run's job (renamed/removed?)
}

function main() {
  const issues = listFailureIssues();
  const maxDays = holdMaxDays();
  console.log(`[close-recovered] ${issues.length} open Workflow/Crawler/CI Failure issue(s)${DRY_RUN ? ' (dry-run)' : ''}, structural-hold TTL ${maxDays}d`);
  let closed = 0;
  let kept = 0;
  let skipped = 0;
  let held = 0;

  for (const it of issues) {
    const crawlerStepMatch = CRAWLER_STEP_RE.exec(it.workflow);
    const isCrawlerStepIdentifier = it.title.startsWith('Crawler Failure:') && crawlerStepMatch;

    const run = isCrawlerStepIdentifier
      ? latestCompletedCrawlerStepRun(crawlerStepMatch[1])
      : latestCompletedRun(it.workflow);

    if (!run) {
      const reason = isCrawlerStepIdentifier
        ? `crawler '${crawlerStepMatch[1]}' not found in any current crawler-group-*.yml, or its step/run not resolvable`
        : 'no completed run on main (renamed/deleted?)';
      console.log(`  #${it.number} "${it.workflow}" — ${reason}, keep open`);
      skipped++;
      continue;
    }
    const green = run.conclusion === 'success';
    // The failing run that opened the issue started BEFORE the issue's createdAt (the
    // reporter step runs after the job failed). So a green run created at/after the issue
    // is necessarily a LATER run — the "next run is ok" the user asked for.
    const afterFailure = Date.parse(run.createdAt) >= Date.parse(it.createdAt);

    if (green && afterFailure) {
      const runUrl = REPO ? `https://github.com/${REPO}/actions/runs/${run.databaseId}` : undefined;

      // #5454: green answers "is the symptom back?", not "was the fault fixed?".
      const comments = fetchIssueComments(it.number);
      const decision = decideStructuralHold(comments, {
        issueCreatedAt: it.createdAt,
        maxDays,
      });

      if (decision.hold) {
        if (DRY_RUN) {
          console.log(`  #${it.number} WOULD HOLD — ${decision.reason}`);
        } else if (decision.notified) {
          console.log(`  #${it.number} HELD (already notified) — ${decision.reason}`);
        } else {
          commentOnGithubIssue(
            it.number,
            structuralHoldNote({ code: decision.code, workflow: it.workflow, runUrl, maxDays }),
          );
          console.log(`  #${it.number} HELD — ${decision.reason}`);
        }
        held++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  #${it.number} WOULD CLOSE — recovered (run ${run.databaseId} success @ ${run.createdAt}); ${decision.reason}`);
      } else {
        // A TTL-released close must say why, or it looks exactly like the symptom-only
        // close #5454 was opened about.
        if (decision.code && STRUCTURAL_OUTCOMES.includes(decision.code)) {
          commentOnGithubIssue(it.number, ttlReleaseNote({ code: decision.code, maxDays, ageDays: decision.ageDays }));
        }
        resolveGithubIssue(it.title, { workflow: it.workflow, runUrl });
        console.log(`  #${it.number} CLOSED — recovered via run ${run.databaseId}; ${decision.reason}`);
      }
      closed++;
    } else if (green && !afterFailure) {
      console.log(`  #${it.number} latest green run ${run.databaseId} predates issue — keep open`);
      kept++;
    } else {
      console.log(`  #${it.number} still red (latest completed run ${run.databaseId}=${run.conclusion}) — keep open`);
      kept++;
    }
  }

  console.log(`[close-recovered] done: closed=${closed} held=${held} kept=${kept} skipped=${skipped}`);
}

// CLI entry point (guarded so this module can be imported for unit tests without
// triggering real `gh` calls at import time).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
