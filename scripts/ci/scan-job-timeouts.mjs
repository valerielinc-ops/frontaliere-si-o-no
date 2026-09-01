#!/usr/bin/env node
/**
 * scan-job-timeouts.mjs — zero-workflow-file-touch timeout reporter.
 *
 * WHY centralized (one cron scan, not N workflow-file edits):
 * ~647 workflow files gate their failure reporter on `if: failure()`. GitHub Actions
 * marks a job that hit `timeout-minutes` as `cancelled`, not `failure` — `failure()`
 * never evaluates true for it, so a timed-out job silently reports nothing (the bug
 * that hid the `Send Job Alert Emails` timeout, run 28701746896, from ever opening an
 * issue). Patching the condition in every workflow file is the same 647-file-churn
 * problem `close-recovered-failure-issues.mjs` already solved for the mirror case
 * (issue auto-close): a single reconciler covers every workflow — present and future —
 * by construction, without touching any of them.
 *
 * TWO SIGNATURES, one reason to exist: a job that dies in a way `if: failure()`
 * cannot observe. (A) `timeout-minutes` — GitHub marks it `cancelled`, so
 * `failure()` is false. (B) HOST-KILL — the runner host itself dies mid-step, so
 * the job IS `failure` but the workflow's own reporter step never gets to run.
 *
 * (B) is issue #5773/#5772/#5771. Run 31672320271 (2026-08-13T06:01:15Z, `Deploy to
 * GitHub Pages`): `build-locale (it)` died INSIDE step 15 «Build (BUILD_LOCALE=it)»
 * at 06:19:48Z — no error, no stack, no exit code, and the step is still reported
 * `in_progress` by the API on a job whose conclusion is `failure`. Step 59 «Report
 * failure to GitHub Issues (build)» was one of the 50 steps left `pending`, so it
 * never ran; `deploy-publish.yml` is gated on `workflow_run.conclusion == success`
 * so it was a no-op too. The IT CDN push therefore never happened, which blocks
 * de/fr/en by design (the #2569 guard requires IT published first) — and the only
 * thing anybody could see were those three downstream symptoms. The dead leg itself
 * was invisible. This scanner is the observer that was missing.
 *
 * ALGORITHM (best-effort, no persisted cursor):
 *   1. List runs completed/updated within the lookback window, twice: conclusion
 *      `cancelled` (signature A) and conclusion `failure` (signature B). `created_at`
 *      is deliberately NOT the clock: a 350-minute job is already older than an
 *      hourly lookback when its timeout first becomes observable.
 *   2A. For each cancelled run, list its jobs; a `cancelled` job is a *candidate*
 *      (concurrency groups with `cancel-in-progress: true` also cancel superseded
 *      runs — that is normal, not a timeout, so conclusion alone is not proof).
 *   3A. Fetch the job's check-run annotations. GitHub stamps a literal
 *      "... exceeded ... maximum execution time ..." annotation ONLY when the job was
 *      cancelled by `timeout-minutes`. That message is the actual timeout signature.
 *   2B. For each failed run, a job is host-killed when it is `failure` AND at least
 *      one of its steps is still `in_progress`. A job that failed normally always
 *      leaves every step concluded — the failing step carries `conclusion: failure`
 *      and the rest are absent. Measured over the 8 most recent failure runs of this
 *      repo: 7 had zero `in_progress` steps, and the only one that did was 31672320271.
 *      Costs no extra API call — `steps[]` ships inside the jobs listing already.
 *   4. On a match, report via the shared `createGithubIssue` — same stable
 *      `CI Failure: <workflow>` title every other reporter in this repo uses, so it
 *      dedupes onto (and is later auto-closed by) the same issue thread.
 *
 * WHY the same `CI Failure: <workflow>` title for both, and not a prettier one:
 * `close-recovered-failure-issues.mjs` closes on `TITLE_RE = /^(?:Workflow|Crawler|CI)
 * Failure: (.+)$/` and resolves the capture as a workflow name. A host-kill is a
 * transient host fault, so "the workflow went green again" IS the repair — this title
 * is on the auto-closing side of that regex on purpose. The rule it obeys is the one
 * in `report-workflow-failure.mjs`: no reporter ships until the same change says WHO
 * closes its issues, because with title dedup an unclosable issue is a permanent one.
 *
 * No persisted scan cursor by design. The lookback window is sized wider than the
 * cron interval so no run is missed. Overlap is deduped against the durable issue
 * body/comments by run URL: the same physical run is emitted once, while a different
 * run of the same workflow remains a real recurrence on the canonical issue.
 *
 * DEDUP, and why one layer was not enough. A single run can time out in SEVERAL
 * jobs, and every one of them maps to the same `CI Failure: <workflow>` title. The
 * title-based dedup in `createGithubIssue` resolved through GitHub's SEARCH INDEX,
 * which is eventually consistent: the second job, seconds behind the first, did not
 * see the issue the first had just opened and opened its own. That is #5305/#5306 —
 * same run 31171006342, same title, 3 seconds apart. Three layers now close it:
 *   a) every run is aggregated into ONE deterministic issue write containing all
 *      of its dead jobs. There is no secondary best-effort comment whose failure
 *      could leave a partially-recorded run.
 *   b) search results and the immediately-consistent open listing are ALWAYS
 *      merged by issue number. An old indexed issue therefore cannot mask a new
 *      canonical issue that search has not indexed yet.
 *   c) `findIssueReportingRun` — body/comment lookup by run URL before the first
 *      emission for a title in each scan. Title dedup alone cannot distinguish
 *      "same run seen twice" from "a later run really recurred"; this layer can.
 *
 * BRANCH-SCOPED TITLE (#6036): `close-recovered-failure-issues.mjs` measures
 * recurrence/chronic-escalation on `gh run list -w <workflow> -b main` — a population
 * that by construction never contains a `pull_request` (or any non-`main`) run. This
 * scanner, unlike that reconciler, lists runs across every branch/trigger on purpose
 * (a timeout is worth seeing wherever it happens). Left unguarded, a PR-branch timeout
 * reported under the plain `CI Failure: <workflow>` title lands in the SAME thread the
 * reconciler reads as "main's health": it can reopen/comment on an issue the recurrence
 * gate can never corroborate, and its `🔁` recurrence marker inflates the chronic-escalation
 * count with events from a population that gate was never measuring. `scopedTitle()` below
 * keeps the plain title only for `head_branch === 'main'` (the exact population
 * `recentCompletedRuns()` queries); anything else gets the trigger folded into the title,
 * FIRST — before the workflow name — since dedup only compares the first 60 chars
 * (`DEDUP_TITLE_PREFIX_LEN` in `github-issue-creator.mjs`) and a suffix would be silently
 * dropped for long workflow names. The reshaped title no longer matches `TITLE_RE` in
 * `close-recovered-failure-issues.mjs`, so that reconciler leaves it alone entirely —
 * separate population, separate thread, no cross-contamination either direction.
 */
import { execFileSync } from 'node:child_process';
import {
  createGithubIssue,
  commentOnGithubIssue,
  searchSafePrefix,
} from '../lib/github-issue-creator.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const LOOKBACK_MINUTES = Number(process.env.TIMEOUT_SCAN_LOOKBACK_MINUTES || 75);
// `updated_at` e' il clock dell'osservatore, ma l'API filtra solo `created`.
// Non basta quindi sommare il timeout del singolo job: una run puo' aspettare
// in coda, attraversare job `needs` e restare in attesa di un'approvazione.
// GitHub documenta 35 giorni come limite dell'INTERA run, inclusi waiting e
// approval; oltre questo orizzonte la run viene cancellata. E' il solo bound
// lato server che non esclude una run ancora capace di aggiornarsi nel cutoff.
const MAX_WORKFLOW_RUN_AGE_MIN = 35 * 24 * 60;

// Con qualunque filtro (`status` e `created` qui) GitHub restituisce al massimo
// 1.000 risultati PER SEARCH. Un cap locale piu' alto sarebbe irraggiungibile:
// per coprire l'intero orizzonte si biseca la finestra `created` finche' ogni
// search e' sotto il limite, poi si paginano tutte le sue pagine.
const RUN_SEARCH_RESULT_CAP = 1000;
const RUN_SEARCH_MAX_SPLIT_DEPTH = 20;
const TIMEOUT_ANNOTATION_RE = /exceeded[^.]*(maximum execution time|maximum number of minutes)/i;
// A job that has only just failed can be read back mid-finalisation, with a step
// still momentarily `in_progress` — indistinguishable from a host-kill. Ignore
// anything that finished less than this ago; the 75m lookback is 15m wider than the
// hourly cron, so the next scan still sees it. Cheap insurance against a false
// host-kill issue on an ordinary red build.
const HOST_KILL_SETTLE_MS = Number(process.env.HOST_KILL_SETTLE_MS || 120_000);

function repoPath(suffix) {
  return REPO ? `repos/${REPO}/${suffix}` : `repos/{owner}/{repo}/${suffix}`;
}

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

function ghJson(path, { allowFailure = true } = {}) {
  const out = gh(['api', path], { allowFailure });
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function listRunsByStatus(status, cutoffMs, nowMs = Date.now()) {
  const runsById = new Map();
  const perPage = 100;

  const observe = (batch) => {
    for (const run of batch) {
      const observedAt = Date.parse(run.updated_at || run.created_at || '');
      if (Number.isFinite(observedAt) && observedAt >= cutoffMs) {
        runsById.set(run.id, run);
      }
    }
  };

  const fetchCreatedSlice = (startMs, endMs, depth = 0) => {
    const created = encodeURIComponent(
      `${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`,
    );
    const pagePath = (page) => repoPath(
      `actions/runs?status=${status}&created=${created}&per_page=${perPage}&page=${page}`,
    );
    const first = ghJson(pagePath(1));
    if (!first) return;

    const totalCount = Number(first.total_count);
    if (Number.isFinite(totalCount) && totalCount > RUN_SEARCH_RESULT_CAP) {
      const midpoint = Math.floor((startMs + endMs) / 2);
      if (depth >= RUN_SEARCH_MAX_SPLIT_DEPTH || midpoint < startMs || midpoint >= endMs) {
        console.warn(
          `::warning::[scan-job-timeouts] search ${status} ancora oltre il limite API `
            + `(${totalCount} > ${RUN_SEARCH_RESULT_CAP}) dopo ${depth} split — `
            + `possibile troncamento tra ${new Date(startMs).toISOString()} e ${new Date(endMs).toISOString()}.`,
        );
        observe(first.workflow_runs || []);
        return;
      }
      // Intervalli disgiunti al millisecondo: nessun buco, nessun doppio
      // conteggio sul confine (runsById resta comunque l'ultima difesa).
      fetchCreatedSlice(startMs, midpoint, depth + 1);
      fetchCreatedSlice(midpoint + 1, endMs, depth + 1);
      return;
    }

    const expectedPages = Number.isFinite(totalCount)
      ? Math.ceil(totalCount / perPage)
      : null;
    let page = 1;
    let data = first;
    while (data) {
      const batch = data.workflow_runs || [];
      if (batch.length === 0) break;
      observe(batch);
      if (batch.length < perPage) break;
      if (expectedPages !== null && page >= expectedPages) break;
      if (expectedPages === null && page >= RUN_SEARCH_RESULT_CAP / perPage) {
        console.warn(
          `::warning::[scan-job-timeouts] search ${status} ha raggiunto il limite API `
            + `senza total_count — possibile troncamento nella slice created.`,
        );
        break;
      }
      page += 1;
      data = ghJson(pagePath(page));
    }
  };

  fetchCreatedSlice(cutoffMs - MAX_WORKFLOW_RUN_AGE_MIN * 60_000, nowMs);
  return [...runsById.values()];
}

function listJobs(runId) {
  const data = ghJson(repoPath(`actions/runs/${runId}/jobs?per_page=100`));
  return data?.jobs || [];
}

// The one branch `close-recovered-failure-issues.mjs` measures (`-b main` there). Kept as
// a local literal, same convention that file uses for its own `-b main` — see the
// BRANCH-SCOPED TITLE note in the module docstring above.
const RECURRENCE_GATE_BRANCH = 'main';

/**
 * `CI Failure: <workflow>` for a run on the branch the recurrence gate measures, else
 * `CI Failure (<event>): <workflow>` — discriminant FIRST, so it survives the 60-char
 * dedup-prefix cut and the reshaped title falls outside `TITLE_RE` in
 * `close-recovered-failure-issues.mjs` on purpose. See the module docstring.
 */
export function scopedTitle(run) {
  if (run?.head_branch === RECURRENCE_GATE_BRANCH) return `CI Failure: ${run.name}`;
  return `CI Failure (${run?.event || 'unknown'}): ${run.name}`;
}

function findTimeoutAnnotation(job) {
  if (job.conclusion !== 'cancelled' || !job.check_run_url) return null;
  const annotations = ghJson(`${job.check_run_url}/annotations`) || [];
  return annotations.find((a) => TIMEOUT_ANNOTATION_RE.test(a.message || '')) || null;
}

/**
 * Host-kill signature: the job is `failure` but at least one step never got a
 * conclusion and is still `in_progress` — i.e. the runner host went away while that
 * step was executing, so nothing downstream of it (including the workflow's own
 * `if: failure()` reporter) ever ran.
 *
 * Returns null for an ordinary failure, where every step is concluded.
 */
export function detectHostKill(job, nowMs = Date.now()) {
  if (job?.conclusion !== 'failure' || job?.status !== 'completed') return null;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const stuck = steps.filter((s) => s?.status === 'in_progress');
  if (stuck.length === 0) return null;

  const completedAt = Date.parse(job.completed_at || '');
  if (Number.isFinite(completedAt) && nowMs - completedAt < HOST_KILL_SETTLE_MS) return null;

  // Steps that never started at all: the blast radius of the kill, and the reason
  // the workflow reported nothing about itself.
  const neverRan = steps.filter((s) => s?.status === 'queued' || s?.status === 'pending');
  return { stuck, neverRan };
}

function issueRepoFlag() {
  return REPO ? ['--repo', REPO] : [];
}

// Rete di sicurezza, non filtro primario (#692, Item 3). Il listing sotto e'
// il fallback per l'eventual consistency dell'indice di ricerca (una issue
// appena creata potrebbe non comparire ancora in `--search`); prima del fix
// era troncato a un `--limit 200` fisso, quindi oltre 200 issue aperte la
// canonica poteva restare fuori e la dedup per run-URL falliva in silenzio,
// aprendo un duplicato invece di commentare su quella esistente. Alzato e
// segnalato ad alta voce se toccato, stesso stile di `RUN_LISTING_SAFETY_CAP`.
const OPEN_ISSUE_LISTING_SAFETY_CAP = 1000;

function parseIssueList(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Find the canonical issue only when it already contains THIS physical run.
 *
 * The title identifies a workflow across recurrences; the run URL identifies one
 * occurrence. Search handles old/closed canonical issues, while the plain open
 * listing is the immediately-consistent fallback for a just-created issue. Every
 * read is best-effort: a GitHub read failure must not hide a real dead job.
 */
function findIssueReportingRun(title, runUrl) {
  if (!runUrl) return null;
  const titlePrefix = searchSafePrefix(title);
  const common = ['--json', 'number,title,state', ...issueRepoFlag()];
  const searched = parseIssueList(gh([
    'issue', 'list', '--state', 'all', '--search', `${titlePrefix} in:title`,
    '--limit', '20', ...common,
  ], { allowFailure: true }));
  const listed = parseIssueList(gh([
    'issue', 'list', '--state', 'open', '--limit', String(OPEN_ISSUE_LISTING_SAFETY_CAP), ...common,
  ], { allowFailure: true }));
  if (listed.length >= OPEN_ISSUE_LISTING_SAFETY_CAP) {
    console.warn(
      `::warning::[scan-job-timeouts] cap di sicurezza (${OPEN_ISSUE_LISTING_SAFETY_CAP}) raggiunto `
        + 'sul listing issue aperte — possibile troncamento della canonica.',
    );
  }
  const candidates = [...searched, ...listed]
    .filter((issue) => String(issue?.title || '').startsWith(titlePrefix))
    .filter((issue, index, all) => all.findIndex((candidate) => candidate?.number === issue?.number) === index);

  for (const issue of candidates) {
    const raw = gh([
      'issue', 'view', String(issue.number), '--json', 'body,comments', ...issueRepoFlag(),
    ], { allowFailure: true });
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const text = [data?.body, ...(data?.comments || []).map((comment) => comment?.body)]
        .filter(Boolean).join('\n');
      if (text.includes(runUrl)) return issue;
    } catch {
      // Fail open: dedup uncertainty may add noise, but never hides a dead job.
    }
  }
  return null;
}

export async function main() {
  const nowMs = Date.now();
  const cutoffMs = nowMs - LOOKBACK_MINUTES * 60 * 1000;
  const cancelledRuns = listRunsByStatus('cancelled', cutoffMs, nowMs);
  const failedRuns = listRunsByStatus('failure', cutoffMs, nowMs);
  console.log(
    `[scan-job-timeouts] ${cancelledRuns.length} cancelled + ${failedRuns.length} failed run(s) `
      + `in the last ${LOOKBACK_MINUTES}m`,
  );

  let reported = 0;
  // title → issue ref already opened/matched during THIS scan. See the DEDUP note
  // in the header: this is layer (a), the one that removes the intra-scan race.
  // SHARED by both detectors on purpose: a host-kill takes out every job on that
  // host, so one run can produce several hits that all map to the same title.
  const emittedByTitle = new Map();

  async function emit({ title, description, labels, workflow, runUrl, jobCount }) {
    const already = emittedByTitle.get(title);

    // Every emission is atomic at run level, so the durable run URL proves that
    // all dead jobs in this run were recorded together.
    if (already?.persistedRunUrl === runUrl) {
      console.log(`[scan-job-timeouts] run già segnalata su #${already.number} — skip ${runUrl}`);
      return;
    }

    // A different run of the same workflow is a real recurrence. It is already
    // aggregated, so one comment records the whole occurrence atomically. A
    // CLOSED canonical deliberately falls through to createGithubIssue: that
    // helper owns the guarded reopen path; commenting here would leave the new
    // incident closed and invisible to triage.
    if (already && already.state !== 'CLOSED') {
      reported += jobCount;
      if (DRY_RUN) {
        console.log(`[scan-job-timeouts] (dry-run) would report "${title}" (already emitted → would COMMENT)`);
        return;
      }
      if (already.number) {
        const commented = commentOnGithubIssue(
          already.number,
          `🔁 Nuova run con lo stesso titolo.\n\n${description}`,
        );
        if (!commented) {
          throw new Error(`failed to persist recurrence for ${runUrl} on #${already.number}`);
        }
        console.log(`[scan-job-timeouts] deduped onto #${already.number} — ${runUrl}`);
        return;
      }
      throw new Error(`cannot persist recurrence for ${runUrl}: canonical issue has no number`);
    }

    const persisted = findIssueReportingRun(title, runUrl);
    if (persisted) {
      emittedByTitle.set(title, { ...persisted, persistedRunUrl: runUrl });
      console.log(`[scan-job-timeouts] run già segnalata su #${persisted.number} — skip ${runUrl}`);
      return;
    }

    reported += jobCount;
    if (DRY_RUN) {
      console.log(`[scan-job-timeouts] (dry-run) would report "${title}"`);
      emittedByTitle.set(title, { number: null, state: 'OPEN' });
      return;
    }

    const issue = await createGithubIssue({ title, description, priority: 2, labels, workflow });
    if (!issue?.number || issue.persisted !== true) {
      throw new Error(`failed to persist ${runUrl}: issue create/reopen did not confirm the write`);
    }
    emittedByTitle.set(title, {
      ...issue,
      state: 'OPEN',
      persistedRunUrl: runUrl,
    });
  }

  // (A) timeout — `cancelled`, proven by the check-run annotation.
  for (const run of cancelledRuns) {
    const hits = listJobs(run.id)
      .map((job) => ({ job, hit: findTimeoutAnnotation(job) }))
      .filter(({ hit }) => hit)
      .sort((a, b) => String(a.job?.name || '').localeCompare(String(b.job?.name || '')));
    if (hits.length === 0) continue;
    for (const { job } of hits) {
      console.log(`[scan-job-timeouts] TIMEOUT: ${run.name} / ${job.name} (run ${run.id})`);
    }
    const jobBlocks = hits.flatMap(({ job, hit }, index) => [
      `### Job ${index + 1}: ${job.name}`,
      `**Motivo:** ${hit.message}`,
      '',
    ]);
    const description = [
        '## Job cancellati per timeout',
        '',
        `**Run:** ${run.html_url}`,
        `**Trigger:** ${run.event}`,
        `**Ref:** ${run.head_branch}`,
        '',
        ...jobBlocks,
        'Rilevato da `scripts/ci/scan-job-timeouts.mjs` (scan periodico, non dal workflow stesso — '
          + 'un job cancellato per timeout non passa mai `if: failure()`).',
      ].join('\n');
    await emit({
      title: scopedTitle(run),
      description,
      labels: ['Bug', 'ci-timeout'],
      workflow: run.name,
      runUrl: run.html_url,
      jobCount: hits.length,
    });
  }

  // (B) host-kill — `failure` with a step frozen `in_progress`.
  for (const run of failedRuns) {
    const kills = listJobs(run.id)
      .map((job) => ({ job, kill: detectHostKill(job, nowMs) }))
      .filter(({ kill }) => kill)
      .sort((a, b) => String(a.job?.name || '').localeCompare(String(b.job?.name || '')));
    if (kills.length === 0) continue;
    for (const { job } of kills) {
      console.log(`[scan-job-timeouts] HOST-KILL: ${run.name} / ${job.name} (run ${run.id})`);
    }
    const jobBlocks = kills.flatMap(({ job, kill }, index) => {
      const stuckNames = kill.stuck.map((s) => `#${s.number} «${s.name}»`).join(', ');
      return [
        `### Job ${index + 1}: ${job.name}`,
        `**Step rimasto \`in_progress\`:** ${stuckNames}`,
        `**Step mai partiti:** ${kill.neverRan.length}`,
        '',
      ];
    });
    const description = [
        '## Job uccisi dall’host (runner morto a metà step)',
        '',
        `**Run:** ${run.html_url}`,
        `**Trigger:** ${run.event}`,
        `**Ref:** ${run.head_branch}`,
        '',
        ...jobBlocks,
        'Il job risulta `failure` ma nessuno step ha prodotto un errore, uno stack o un exit '
          + 'code: lo step di cui sopra è ancora `in_progress` via API su un job concluso. È la '
          + 'firma di un kill del runner host (OOM o perdita della VM), **non** di un bug '
          + 'applicativo.',
        '',
        '**Perché il workflow non ha segnalato niente da solo:** gli step di reporting sono a '
          + 'valle di quello ucciso, quindi sono rimasti `pending` e non hanno mai girato — '
          + '`if: failure()` non è mai stato valutato. Ogni consumer a valle gated su '
          + '`workflow_run.conclusion == "success"` è a sua volta un no-op. Senza questo scan '
          + 'l’evento è invisibile: si vedono solo i sintomi downstream.',
        '',
        '**Prima di rimediare, guarda i campioni di memoria nel log del run.** Un retry cieco '
          + 'maschererebbe un OOM ricorrente invece di misurarlo.',
        '',
        'Rilevato da `scripts/ci/scan-job-timeouts.mjs`.',
      ].join('\n');
    await emit({
      title: scopedTitle(run),
      description,
      labels: ['Bug', 'ci-host-kill'],
      workflow: run.name,
      runUrl: run.html_url,
      jobCount: kills.length,
    });
  }

  console.log(`[scan-job-timeouts] done — ${reported} dead job(s) reported (dry-run=${DRY_RUN}).`);
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if (process.argv[1]?.endsWith('scan-job-timeouts.mjs')) {
  main().catch((err) => {
    console.error(`[scan-job-timeouts] fatal: ${err.message}`);
    process.exit(1);
  });
}
