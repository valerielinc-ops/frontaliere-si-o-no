#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
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
 * No persisted scan cursor by design, but the window is not fixed either: it
 * reaches back to the start of the previous SUCCESSFUL scan of this workflow
 * (read from GitHub's own run history) plus a 15-minute overlap, and never below
 * TIMEOUT_SCAN_LOOKBACK_MINUTES. The hourly cron is a promise GitHub does not
 * keep: the 20 scans up to 2026-09-28 ran ~5.4 times a day, 157-514 minutes
 * apart (median 265), so a fixed 75-minute window watched ~27% of the day. The
 * send-newsletter timeout of run 36407582573 (cancelled 16:06Z) fell in the gap
 * between the 15:23Z scan and the next one, and no issue was ever opened.
 * Overlap is deduped against the durable issue body/comments by run URL: the
 * same physical run is emitted once, while a different run of the same workflow
 * remains a real recurrence on the canonical issue.
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
 * ATTRIBUZIONE DEL TEMPO (#7421). Il body diceva CHE un job era andato in timeout e
 * mai DOVE fossero finite le ore, benché `steps[]` — con `name`, `conclusion`,
 * `started_at` e `completed_at` — arrivi già dentro la stessa risposta di
 * `actions/runs/{id}/jobs` che questo scanner sta leggendo. Su #7421 il timeout fu
 * imputato a occhio al download dell'artifact `github-pages` e la issue finì nel
 * cluster sbagliato; le due misure indipendenti che servirono per correggere il tiro
 * dissero 10 secondi per quel download e 2h24m per lo step `Run gates check`, cioè
 * l'80% della vita del job. `stepTimingLines()` mette quella tabella nel body,
 * ordinata per durata e con lo step tagliato dal cap marcato ✂️. È best-effort per
 * costruzione: niente `steps[]` utilizzabili ⇒ nessuna riga aggiunta e il body torna
 * identico a quello di prima. Nessun log viene scaricato: il log di un job ancora in
 * corso non è ottenibile via API, e gli step bastano.
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
 *
 * CHI CHIUDE `CI Failure (<evento>): <workflow>` — `--resolve`, in questo stesso file.
 * Tenere quel titolo fuori dal reconciler era giusto, ma lasciava la famiglia senza
 * nessun chiuditore sul verde: l'unica uscita era l'age-out del drainer (≥10 giorni
 * di silenzio), cioè una chiusura per inattività, non per guarigione. La issue 10809
 * («CI Failure (pull_request): Assisted application portal e2e», aperta il 01-10) era
 * risolta da 4 run pulite dello stesso evento il 03-10 ed è rimasta aperta finché non
 * l'ha chiusa una persona. `node scripts/ci/scan-job-timeouts.mjs --resolve` chiude una
 * issue di questa famiglia quando le ultime `RESOLVE_CLEAN_RUNS` run della STESSA
 * popolazione che l'ha aperta (stesso workflow, stesso evento, fuori da `main`: la
 * parità è `scopedTitle(run) === title`) create dopo l'apertura non hanno job morti per
 * timeout né uccisi dall'host. Le run `skipped` e le `cancelled` senza annotazione di
 * timeout (concorrenza, annullo a mano) non contano né pro né contro. Fail-closed: jobs
 * o annotazioni illeggibili, meno di tre run utili, label `keep-open` /
 * `agent:no-age-out` / claim `agent:in-progress`, oppure un body senza la firma dello
 * scanner → la issue resta aperta. `CI Failure (deploy|build):` NON sono eventi: hanno
 * il loro chiuditore nel workflow di deploy e questo non le guarda mai.
 */
import { execFileSync } from 'node:child_process';
import {
  createGithubIssue,
  commentOnGithubIssue,
  isFailureReportingDisabled,
  resolveGithubIssueByNumber,
  searchSafePrefix,
} from '../lib/github-issue-creator.mjs';
// Il body di queste issue non deve MAI citare un path `.github/workflows/**`:
// `check-workflows-scope.mjs` (Mode 1) terminerebbe `issue-fix.yml` a zero token.
// Il nome di uno step arriva dal `name:` scritto a mano nel workflow e può
// contenerlo (`Run .github/workflows/foo.yml`), quindi la redazione è applicata
// al body INTERO — stessa regola e stessa funzione di `report-workflow-failure.mjs`.
import { redactWorkflowPaths } from './report-validate-dist-failure.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const RESOLVE_MODE = process.argv.includes('--resolve');
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const LOOKBACK_MINUTES = intFromEnv('TIMEOUT_SCAN_LOOKBACK_MINUTES', 75);
// `updated_at` e' il clock dell'osservatore, ma l'API filtra solo `created`.
// Non basta quindi sommare il timeout del singolo job: una run puo' aspettare
// in coda, attraversare job `needs` e restare in attesa di un'approvazione.
// GitHub documenta 35 giorni come limite dell'INTERA run, inclusi waiting e
// approval; oltre questo orizzonte la run viene cancellata. E' il solo bound
// lato server che non esclude una run ancora capace di aggiornarsi nel cutoff.
// ...but walking 35 days of `cancelled`/`failure` runs costs hundreds of paginated
// `gh api` calls in this repo (thousands of superseded runs per day) and, since
// 2026-09-21, never finished inside the job's 23-minute budget: every hourly scan
// was killed before printing a single line, so no timeout was reported at all.
// Default to 3 days (still > the 6h hosted-runner job cap plus queueing), keep the
// full 35-day horizon available via env for a one-off deep scan.
const WORKFLOW_RUN_RETENTION_MINUTES = 35 * 24 * 60;
const MAX_WORKFLOW_RUN_AGE_MIN = intFromEnv('TIMEOUT_SCAN_MAX_RUN_AGE_MINUTES', 3 * 24 * 60);

// Ceiling of the gap-covering window (see the header). Widening the window does
// not widen the listing, which already spans MAX_WORKFLOW_RUN_AGE_MIN of
// `created`; it only adds the jobs/annotations reads of the extra cancelled
// runs. Measured on 36443176349: 36 runs in 75 minutes took ~50 s after a
// 2m22s listing, so 12 hours stays well inside the job's 23 minutes.
const MAX_LOOKBACK_MINUTES = intFromEnv('TIMEOUT_SCAN_MAX_LOOKBACK_MINUTES', 12 * 60);
const LOOKBACK_OVERLAP_MINUTES = 15;

export function assertRunAgeHorizon({
  maxRunAgeMinutes = MAX_WORKFLOW_RUN_AGE_MIN,
  retentionMinutes = WORKFLOW_RUN_RETENTION_MINUTES,
  allowTruncated = process.env.TIMEOUT_SCAN_ALLOW_TRUNCATED_CREATED_HORIZON === 'true',
} = {}) {
  if (maxRunAgeMinutes < retentionMinutes && !allowTruncated) {
    throw new Error(
      'TIMEOUT_SCAN_MAX_RUN_AGE_MINUTES truncates the 35-day run retention; '
        + 'set TIMEOUT_SCAN_ALLOW_TRUNCATED_CREATED_HORIZON=true only for an explicitly '
        + 'budgeted realtime scan, or raise the horizon for a retention-complete scan.',
    );
  }
}

// Con qualunque filtro (`status` e `created` qui) GitHub restituisce al massimo
// 1.000 risultati PER SEARCH. Un cap locale piu' alto sarebbe irraggiungibile:
// per coprire l'intero orizzonte si biseca la finestra `created` finche' ogni
// search e' sotto il limite, poi si paginano tutte le sue pagine.
const RUN_SEARCH_RESULT_CAP = 1000;
const RUN_SEARCH_MAX_SPLIT_DEPTH = 20;
// This file is transported as a byte-identical twin. Keep this signature
// self-contained: importing the shared module would require a matching corpus
// manifest entry, while the twin must remain runnable with its declared graph.
const TIMEOUT_ANNOTATION_RE = /exceeded[^.]*(maximum execution time|maximum number of minutes)/i;
// A job that has only just failed can be read back mid-finalisation, with a step
// still momentarily `in_progress` — indistinguishable from a host-kill. Ignore
// anything that finished less than this ago; the next scan's window reaches back
// to this scan's start plus a 15-minute overlap, so it still sees it. Cheap insurance against a false
// host-kill issue on an ordinary red build.
const HOST_KILL_SETTLE_MS = intFromEnv('HOST_KILL_SETTLE_MS', 120_000);

// Quanti step mostrare nell'attribuzione del tempo. Il body di una issue che
// nessuno legge è inutile quanto uno vuoto: un job lungo ha decine di step e
// la coda è fatta di secondi. Gli omessi vengono comunque dichiarati.
const MAX_TIMED_STEPS = 8;

/** `2h24m` / `32m33s` / `6s`. Una durata che si legge a colpo d'occhio. */
export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Delimitatore variable-length per un inline code span che può contenere backtick. */
export function markdownCodeSpan(value) {
  const text = String(value ?? '');
  const longestRun = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
  const delimiter = '`'.repeat(longestRun + 1);
  return `${delimiter}${text}${delimiter}`;
}

/**
 * DOVE è finito il tempo, non solo CHE il tempo è finito.
 *
 * `repos/{repo}/actions/runs/{id}/jobs` spedisce già `steps[]` con `name`,
 * `conclusion`, `started_at` e `completed_at`: bastano per attribuire le ore a
 * uno step invece di lasciare che chi legge la issue le attribuisca a occhio.
 * Il costo di non farlo è misurato su #7421: il timeout era stato imputato al
 * download dell'artifact `github-pages` (durato 10 secondi su 10.818) e la issue
 * era finita nel cluster sbagliato; ci sono volute due misure indipendenti per
 * spostarlo sullo step `Run gates check`, che da solo valeva 2h24m.
 *
 * Nessun log: uno step `if: failure()` gira mentre il suo job è ancora in corso
 * e il log di un job in corso non è scaricabile via API. Qui bastano gli step.
 *
 * Best-effort per costruzione: `steps[]` assente, vuoto o senza timestamp
 * utilizzabili ⇒ `[]`, e il body degrada esattamente a quello di prima. Un
 * reporter che fallisce non deve aggiungere un fallimento.
 *
 * @returns {string[]} righe markdown, già ordinate per durata decrescente.
 */
export function stepTimingLines(job, { maxSteps = MAX_TIMED_STEPS, nowMs = Date.now() } = {}) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  if (steps.length === 0) return [];

  const jobEndMs = Number.isFinite(Date.parse(job?.completed_at || ''))
    ? Date.parse(job.completed_at)
    : nowMs;

  const timed = [];
  for (const step of steps) {
    const startedAt = Date.parse(step?.started_at || '');
    if (!Number.isFinite(startedAt)) continue;
    const completedAt = Date.parse(step?.completed_at || '');
    // Uno step senza `completed_at` è quello che stava girando quando il cap ha
    // tagliato: la sua durata arriva dalla fine del JOB, altrimenti sparirebbe
    // proprio lo step che ha consumato le ore.
    const endMs = Number.isFinite(completedAt) ? completedAt : jobEndMs;
    const durationMs = endMs - startedAt;
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    timed.push({
      name: String(step?.name ?? '(senza nome)'),
      durationMs,
      startedAt,
      open: !Number.isFinite(completedAt),
      cancelled: step?.conclusion === 'cancelled',
    });
  }
  if (timed.length === 0) return [];

  const firstStepStartMs = timed.reduce((min, step) => Math.min(min, step.startedAt), Infinity);
  const reportedJobStartMs = Number.isFinite(Date.parse(job?.started_at || ''))
    ? Date.parse(job.started_at)
    : firstStepStartMs;
  const firstStepPrecedesJobStart = Number.isFinite(reportedJobStartMs)
    && firstStepStartMs < reportedJobStartMs;
  // GitHub can stamp setup steps a few seconds before `job.started_at`. Use the
  // earliest observable timestamp as the attribution window's start; otherwise
  // a complete first step can be longer than the reported job life.
  const jobStartMs = firstStepPrecedesJobStart ? firstStepStartMs : reportedJobStartMs;
  const jobWindowMs = Number.isFinite(jobStartMs) && jobEndMs >= jobStartMs
    ? jobEndMs - jobStartMs
    : 0;

  // Lo step tagliato dal cap. GitHub non è coerente: sulla run 33919268604 lo
  // step troncato ha `completed_at` valorizzato e `conclusion: cancelled`,
  // altrove resta senza `completed_at`. Ultimo fallback: l'ultimo iniziato.
  const cut = timed.find((s) => s.open)
    || timed.find((s) => s.cancelled)
    || timed.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a));

  const totalMs = timed.reduce((acc, s) => acc + s.durationMs, 0);
  const unattributedMs = Math.max(0, jobWindowMs - totalMs);
  // Steps are normally sequential, but the API can expose overlapping setup
  // work. Never let their summed percentages exceed 100%.
  const attributionWindowMs = Math.max(jobWindowMs, totalMs);
  const timingNotes = [
    firstStepPrecedesJobStart
      ? '⚠️ finestra estesa all’avvio del primo step: gli step precedono `started_at` del job'
      : '',
    totalMs > jobWindowMs
      ? 'percentuali rapportate al tempo attribuito per evitare valori oltre il 100%'
      : '',
  ].filter(Boolean);
  const ranked = [...timed].sort((a, b) => b.durationMs - a.durationMs);
  const shown = ranked.slice(0, maxSteps);
  const omitted = ranked.slice(maxSteps);

  const lines = [
    '',
    `**Dove è finito il tempo** (${formatDurationMs(jobWindowMs)} di vita del job; `
      + `${formatDurationMs(totalMs)} attribuiti agli step; `
      + `${formatDurationMs(unattributedMs)} non attribuiti, `
      + (timingNotes.length > 0 ? `${timingNotes.join('; ')}; ` : '')
      + 'ordinati per durata; ✂️ = lo step in corso quando il cap ha tagliato):',
  ];
  for (const step of shown) {
    const share = attributionWindowMs > 0
      ? ` (${Math.round((step.durationMs / attributionWindowMs) * 100)}%)`
      : '';
    lines.push(
      `- ${step === cut ? '✂️ ' : ''}${markdownCodeSpan(step.name)} — **${formatDurationMs(step.durationMs)}**${share}`,
    );
  }
  if (omitted.length > 0) {
    lines.push(
      `- _…e altri ${omitted.length} step, nessuno oltre `
        + `${formatDurationMs(omitted[0].durationMs)}._`,
    );
  }
  return lines;
}

function repoPath(suffix) {
  return REPO ? `repos/${REPO}/${suffix}` : `repos/{owner}/{repo}/${suffix}`;
}

function gh(args, { allowFailure = false, warnOnFailure = false } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', warnOnFailure ? 'pipe' : 'inherit'],
    }).trim();
  } catch (err) {
    if (allowFailure) {
      if (warnOnFailure) {
        const stderr = String(err?.stderr ?? '').trim();
        const detail = stderr || `exit status ${err?.status ?? 'sconosciuto'}`;
        console.warn(
          `::warning::[scan-job-timeouts] lettura annotazioni fallita con gh api --paginate --slurp: ${detail}`,
        );
      }
      return null;
    }
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

/** The workflow file running this scan, from GITHUB_WORKFLOW_REF. */
export function monitorWorkflowFile(env = process.env) {
  const match = /\.github\/workflows\/([^@/]+)@/.exec(String(env.GITHUB_WORKFLOW_REF || ''));
  return match ? match[1] : 'job-timeout-monitor.yml';
}

/**
 * Minutes of `updated_at` this scan must cover so nothing falls between it and
 * the previous successful scheduled scan. A readable empty history (first
 * run) keeps the fixed base window; an unreadable history fails the pass so a
 * gap cannot be silently mistaken for a complete scan.
 */
export function scanLookbackMinutes({
  nowMs,
  previousScanStartedMs,
  baseMinutes = LOOKBACK_MINUTES,
  maxMinutes = MAX_LOOKBACK_MINUTES,
  overlapMinutes = LOOKBACK_OVERLAP_MINUTES,
}) {
  const cappedBaseMinutes = Math.min(baseMinutes, maxMinutes);
  if (!Number.isFinite(previousScanStartedMs) || previousScanStartedMs > nowMs) {
    return {
      minutes: cappedBaseMinutes,
      neededMinutes: null,
      truncated: baseMinutes > maxMinutes,
    };
  }
  const neededMinutes = Math.ceil((nowMs - previousScanStartedMs) / 60_000) + overlapMinutes;
  const minutes = Math.max(cappedBaseMinutes, Math.min(maxMinutes, neededMinutes));
  return {
    minutes,
    neededMinutes,
    truncated: baseMinutes > maxMinutes || neededMinutes > maxMinutes,
  };
}

function previousSuccessfulScanStartedMs() {
  const workflow = encodeURIComponent(monitorWorkflowFile());
  const data = ghJson(
    repoPath(`actions/workflows/${workflow}/runs?status=success&event=schedule&per_page=1`),
  );
  if (!data || !Array.isArray(data.workflow_runs)) {
    throw new Error('impossibile leggere la history delle scansioni schedule riuscite');
  }
  if (data.workflow_runs.length === 0) return Number.NaN;

  const run = data.workflow_runs[0];
  if (run?.event !== 'schedule') {
    throw new Error('la history filtrata delle scansioni contiene una run non-schedule');
  }
  const startedMs = Date.parse(run.run_started_at || run.created_at || '');
  if (!Number.isFinite(startedMs)) {
    throw new Error('la scansione schedule precedente non ha un timestamp leggibile');
  }
  return startedMs;
}

function readPaginatedAnnotations(job) {
  const out = gh([
    'api',
    `${job.check_run_url}/annotations`,
    '--paginate',
    '--slurp',
  ], { allowFailure: true, warnOnFailure: true });
  if (!out) return null;

  let pages;
  try {
    pages = JSON.parse(out);
  } catch {
    return null;
  }

  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    const shape = Array.isArray(pages)
      ? `array con ${pages.length} pagina/e non-array`
      : typeof pages;
    console.warn(
      `::warning::[scan-job-timeouts] annotazioni non leggibili per il job "${job.name || '?'}" `
        + `(shape=${shape}); timeout non confermato.`,
    );
    return null;
  }
  return pages.flat();
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

// Il segnaposto di `scopedTitle` per una run senza `event`.
const UNKNOWN_EVENT = 'unknown';

/**
 * Gli eventi GitHub che `scopedTitle` puo' mettere fra parentesi, cioe' la famiglia che
 * `--resolve` chiude. Elenco CHIUSO e non `[a-z_]+`: `CI Failure (deploy):` e
 * `CI Failure (build):` hanno la stessa forma, non sono eventi, e hanno gia' il loro
 * chiuditore nel workflow di deploy — una regex aperta darebbe loro un secondo
 * chiuditore con un criterio (assenza di timeout) che non c'entra con il loro guasto.
 * `tests/scan-job-timeouts-resolve.test.ts` verifica che ogni evento dichiarato nell'
 * `on:` di un workflow del repo sia qui: un evento nuovo senza questa riga darebbe di
 * nuovo una issue immortale. `unknown` e' il segnaposto per una run senza `event`: e'
 * riconosciuto ma non chiudibile (nessuna run ha quell'evento, quindi restano sempre
 * meno di tre run utili).
 */
export const SCOPED_TITLE_EVENTS = Object.freeze([
  'issue_comment',
  'issues',
  'merge_group',
  'pull_request',
  'pull_request_review',
  'pull_request_target',
  'push',
  'repository_dispatch',
  'schedule',
  'workflow_dispatch',
  'workflow_run',
  UNKNOWN_EVENT,
]);

/** `CI Failure (<evento>): <workflow>` per un evento dell'elenco chiuso. */
export const SCOPED_TIMEOUT_TITLE_RE = new RegExp(
  `^CI Failure \\((${SCOPED_TITLE_EVENTS.join('|')})\\): (.+)$`,
);

/**
 * La firma che OGNI body scritto da questo scanner porta (timeout e host-kill), fra
 * backtick. E' la seconda condizione obbligatoria di `--resolve`: un titolo della forma
 * giusta senza firma non e' di questa famiglia e non si tocca. `route-already-fixed.mjs`
 * ne tiene una copia letterale (`JOB_TIMEOUT_REPORT_SIGNATURE`) per non importare il
 * grafo di questo scanner; `tests/scan-job-timeouts-resolve.test.ts` le tiene allineate.
 */
export const JOB_TIMEOUT_REPORT_SIGNATURE = 'scripts/ci/scan-job-timeouts.mjs';

/**
 * `CI Failure: <workflow>` for a run on the branch the recurrence gate measures, else
 * `CI Failure (<event>): <workflow>` — discriminant FIRST, so it survives the 60-char
 * dedup-prefix cut and the reshaped title falls outside `TITLE_RE` in
 * `close-recovered-failure-issues.mjs` on purpose. See the module docstring.
 */
export function scopedTitle(run) {
  if (run?.head_branch === RECURRENCE_GATE_BRANCH) return `CI Failure: ${run.name}`;
  return `CI Failure (${run?.event || UNKNOWN_EVENT}): ${run.name}`;
}

/** `{ event, workflow }` per un titolo della famiglia, altrimenti `null`. */
export function parseScopedTimeoutTitle(title) {
  const m = SCOPED_TIMEOUT_TITLE_RE.exec(String(title ?? ''));
  return m ? { event: m[1], workflow: m[2] } : null;
}

/** Il body porta la firma dello scanner (fra backtick, come la scrive il body)? */
export function hasScannerSignature(body) {
  return String(body ?? '').includes(`\`${JOB_TIMEOUT_REPORT_SIGNATURE}\``);
}

function findTimeoutAnnotation(job) {
  if (job.conclusion !== 'cancelled' || !job.check_run_url) return null;
  const annotations = readPaginatedAnnotations(job);
  if (!Array.isArray(annotations)) return null;
  return annotations.find((a) => TIMEOUT_ANNOTATION_RE.test(
    [a?.message, a?.title, a?.raw_details]
      .filter((value) => typeof value === 'string')
      .join('\n'),
  )) || null;
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

/* ── --resolve: chi chiude `CI Failure (<evento>): <workflow>` ─────────── */

/** Quante run pulite consecutive (le piu' recenti) servono per chiudere. */
export const RESOLVE_CLEAN_RUNS = 3;

/**
 * Label che sottraggono una issue a ogni chiusura automatica: `keep-open` e
 * `agent:no-age-out` sono le esenzioni del proprietario (`FIXER_EXEMPT_LABELS` in
 * `scripts/lib/classify-issue.mjs`), `agent:in-progress` e' il claim di chi ci sta
 * lavorando. Letterali e non importati: questo file scende `identical` nel corpus e
 * un import nuovo allargherebbe la chiusura del trasporto.
 */
export const RESOLVE_SKIP_LABELS = Object.freeze(['keep-open', 'agent:no-age-out', 'agent:in-progress']);

// Conclusioni di run che non hanno esercitato i job: niente da misurare, ne' pro ne' contro.
const NOT_EXERCISED_CONCLUSIONS = new Set(['skipped', 'startup_failure', 'action_required', 'stale']);

/**
 * Annotazioni lette davvero? `null` (lettura fallita), una forma non-array, o un
 * elenco VUOTO non provano l'assenza di un timeout: misurato il 2026-10-03 sulle run
 * cancellate per concorrenza di «Assisted application portal e2e» (37120413990,
 * 37115403358), un job cancellato CHE HA ESEGUITO STEP porta 2-3 annotazioni
 * («Canceling since a higher priority waiting request …», «The operation was
 * canceled.»), quindi per lui «nessuna annotazione» e' un silenzio, non una misura.
 * Il job cancellato prima di partire (steps vuoti) non arriva qui: vedi `neverRan`.
 * Stessa regola di
 * `hasReadableAnnotations` in `close-recovered-failure-issues.mjs`.
 */
function annotationsReadable(annotations) {
  return Array.isArray(annotations)
    && annotations.length > 0
    && annotations.every((a) => a && typeof a.message === 'string');
}

function stepsOf(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

/**
 * Il job non ha mai eseguito niente: `steps` e' un array (letto davvero) e nessuno
 * step ha raggiunto `in_progress` o `completed`. `steps` assente o malformato NON e'
 * una prova: si ricade sulla lettura delle annotazioni (fail-closed).
 */
function neverRan(job) {
  return Array.isArray(job?.steps)
    && !job.steps.some((s) => s?.status === 'in_progress' || s?.status === 'completed');
}

function isTimeoutAnnotation(a) {
  return TIMEOUT_ANNOTATION_RE.test(
    [a?.message, a?.title, a?.raw_details].filter((v) => typeof v === 'string').join('\n'),
  );
}

/**
 * Verdetto di UNA run completata per `--resolve`. Puro: jobs e annotazioni arrivano
 * dal chiamante (`readAnnotations(job)` → array piatto, o `null` se illeggibile).
 *
 *   clean          `success`/`neutral`: nessun job morto (lo scanner apre solo su
 *                  run `cancelled`/`failure`, quindi non legge i job di una verde).
 *   clean-failure  `failure` senza timeout ne' host-kill: rossa, ma per un'altra
 *                  ragione. Conta come run senza timeout e va DETTA nel commento.
 *   timeout        un job con l'annotazione «exceeded … maximum execution time»,
 *                  o `timed_out` dichiarato dall'API.
 *   host-kill      un job `failure` con uno step rimasto `in_progress`.
 *   ignored        `skipped` & co. (non ha girato) o `cancelled` senza timeout
 *                  (concorrenza, annullo a mano): non prova niente. Un job
 *                  cancellato che non ha eseguito nessuno step non e' un timeout
 *                  e non si leggono le sue annotazioni (sono vuote).
 *   unknown        jobs o annotazioni illeggibili, o un possibile host-kill ancora
 *                  nella finestra di assestamento → fail-closed.
 *
 * @returns {{ verdict: string, detail?: string }}
 */
export function classifyRunForResolve(run, { jobsData, readAnnotations, nowMs = Date.now() } = {}) {
  const conclusion = run?.conclusion;
  if (NOT_EXERCISED_CONCLUSIONS.has(conclusion)) return { verdict: 'ignored', detail: conclusion };
  if (conclusion === 'success' || conclusion === 'neutral') return { verdict: 'clean' };
  if (conclusion === 'timed_out') return { verdict: 'timeout', detail: 'run timed_out' };
  if (conclusion !== 'cancelled' && conclusion !== 'failure') {
    return { verdict: 'unknown', detail: `conclusione ${conclusion ?? 'assente'}` };
  }

  const jobs = jobsData?.jobs;
  const total = Number(jobsData?.total_count);
  if (!Array.isArray(jobs) || !Number.isInteger(total) || total !== jobs.length) {
    return { verdict: 'unknown', detail: 'jobs illeggibili o incompleti' };
  }
  let unreadable = null;
  for (const job of jobs) {
    if (job?.conclusion === 'timed_out') return { verdict: 'timeout', detail: job?.name };
    if (detectHostKill(job, nowMs)) return { verdict: 'host-kill', detail: job?.name };
    // Uno step ancora `in_progress` in un job `failure` che `detectHostKill` non
    // conferma solo per la finestra di assestamento: forse un host-kill, non si sa
    // ancora → illeggibile, non `clean-failure` (chiudere ora perderebbe la
    // ricorrenza: lo scan successivo non riapre una issue chiusa dopo il fatto).
    if (job?.conclusion === 'failure' && stepsOf(job).some((s) => s?.status === 'in_progress')) {
      unreadable ??= `${job?.name || '?'}: step in_progress in assestamento`;
      continue;
    }
    if (job?.conclusion !== 'cancelled') continue;
    // Un job cancellato prima di eseguire un solo step (tipicamente in attesa di un
    // `needs:` quando la concorrenza annulla la run) non puo' aver superato
    // `timeout-minutes`, e le sue annotazioni sono vuote per costruzione: misurato su
    // `tests` 37171177520, job `post-review` cancellato con steps=[] e annotations=[].
    if (neverRan(job)) continue;
    const annotations = job?.check_run_url ? readAnnotations(job) : null;
    if (!annotationsReadable(annotations)) {
      unreadable ??= `annotazioni illeggibili: ${job?.name || '?'}`;
      continue;
    }
    if (annotations.some(isTimeoutAnnotation)) return { verdict: 'timeout', detail: job?.name };
  }
  // Un timeout certo vince su un'annotazione illeggibile altrove; il contrario no.
  if (unreadable !== null) return { verdict: 'unknown', detail: unreadable };
  return conclusion === 'failure'
    ? { verdict: 'clean-failure' }
    : { verdict: 'ignored', detail: 'cancelled senza timeout' };
}

/**
 * Chiudere o no una issue `CI Failure (<evento>): <workflow>`. Puro e pigro:
 * `classify(run)` e' invocato solo finche' la decisione non e' presa, quindi il costo
 * in chiamate API e' limitato alle run davvero lette.
 *
 * La popolazione e' quella che ha APERTO la issue: run completate dello stesso
 * workflow il cui `scopedTitle` coincide col titolo (stesso evento, fuori da `main`),
 * create dopo l'apertura. Dalla piu' recente: la prima run morta (timeout/host-kill)
 * o illeggibile tiene aperto; `RESOLVE_CLEAN_RUNS` run senza timeout chiudono.
 *
 * @param {{ title: string, issueCreatedAt: string,
 *           runs: Array<{databaseId?: number, conclusion?: string, status?: string,
 *                        createdAt?: string, headBranch?: string, event?: string, url?: string}>,
 *           classify: (run: object) => {verdict: string, detail?: string},
 *           k?: number }} input
 */
export function decideScopedTimeoutResolution({ title, issueCreatedAt, runs, classify, k = RESOLVE_CLEAN_RUNS }) {
  const parsed = parseScopedTimeoutTitle(title);
  if (!parsed) return { action: 'keep', reason: 'titolo fuori dalla famiglia', counted: [], ignored: 0 };
  const openedMs = Date.parse(issueCreatedAt || '');
  if (!Number.isFinite(openedMs)) {
    return { action: 'keep', reason: 'data di apertura illeggibile', counted: [], ignored: 0 };
  }
  const population = (Array.isArray(runs) ? runs : [])
    .filter((r) => r?.status === undefined || r.status === 'completed')
    .filter((r) => Date.parse(r?.createdAt || '') > openedMs)
    .filter((r) => scopedTitle({ head_branch: r?.headBranch, event: r?.event, name: parsed.workflow }) === title)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
      || Number(b?.databaseId ?? 0) - Number(a?.databaseId ?? 0));

  const counted = [];
  let ignored = 0;
  for (const run of population) {
    const { verdict, detail } = classify(run);
    if (verdict === 'ignored') { ignored += 1; continue; }
    if (verdict === 'clean' || verdict === 'clean-failure') {
      counted.push({ run, verdict });
      if (counted.length >= k) {
        return { action: 'close', reason: `${k} run senza timeout dopo l'apertura`, counted, ignored };
      }
      continue;
    }
    const where = run?.url || run?.databaseId || '?';
    const label = verdict === 'unknown' ? 'run illeggibile' : `run ${verdict}`;
    return {
      action: 'keep',
      reason: `${label} ${where}${detail ? ` (${detail})` : ''} prima di ${k} run pulite`,
      counted,
      ignored,
    };
  }
  return {
    action: 'keep',
    reason: `solo ${counted.length} run senza timeout dopo l'apertura (ne servono ${k})`,
    counted,
    ignored,
  };
}

/** Il marcatore del commento di evidenza di `--resolve`. */
export const RESOLVE_EVIDENCE_MARKER = '<!-- scan-job-timeouts:resolve -->';

/** Il commento che accompagna la chiusura: le run che la giustificano, senza tacere i rossi. */
export function resolveEvidenceComment({ event, workflow, decision }) {
  const lines = [
    RESOLVE_EVIDENCE_MARKER,
    `✅ Timeout non più osservato: le ultime ${decision.counted.length} run di «${workflow}» `
      + `per l'evento \`${event}\` fuori da \`main\`, create dopo l'apertura di questa issue, `
      + 'non hanno job morti per timeout né uccisi dall’host.',
    '',
  ];
  for (const { run, verdict } of decision.counted) {
    const url = run?.url || `run ${run?.databaseId ?? '?'}`;
    lines.push(verdict === 'clean-failure'
      ? `- ${url} — **failure senza timeout**: non riguarda questa issue, ma è un rosso da guardare.`
      : `- ${url} — ${run?.conclusion || 'success'}`);
  }
  if (decision.ignored > 0) {
    lines.push('', `Run non contate (\`skipped\`, o \`cancelled\` senza annotazione di timeout — concorrenza o annullo a mano): ${decision.ignored}.`);
  }
  lines.push('', 'Chiusa da `scripts/ci/scan-job-timeouts.mjs --resolve`; se il timeout torna, lo scan la riapre.');
  return lines.join('\n');
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

function normalizedIssueState(issue) {
  const state = String(issue?.state ?? '').trim().toUpperCase();
  return state === 'OPEN' || state === 'CLOSED' ? state : 'UNKNOWN';
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
  // Once the base already reaches the ceiling, the previous successful start
  // cannot widen the window. Avoid paying a third Actions API request for a
  // value that cannot affect the result.
  const previousScanStartedMs = LOOKBACK_MINUTES >= MAX_LOOKBACK_MINUTES
    ? Number.NaN
    : previousSuccessfulScanStartedMs();
  const lookback = scanLookbackMinutes({ nowMs, previousScanStartedMs });
  if (lookback.truncated) {
    const cause = lookback.neededMinutes === null
      ? `il lookback base di ${LOOKBACK_MINUTES}m supera il ceiling`
      : `l'ultima scansione riuscita risale a ${lookback.neededMinutes - LOOKBACK_OVERLAP_MINUTES}m fa`;
    console.warn(
      `::warning::[scan-job-timeouts] ${cause}: la finestra resta a ${lookback.minutes}m `
        + '(TIMEOUT_SCAN_MAX_LOOKBACK_MINUTES) e le run chiuse prima non vengono rilette.',
    );
  }
  const cutoffMs = nowMs - lookback.minutes * 60 * 1000;
  const cancelledRuns = listRunsByStatus('cancelled', cutoffMs, nowMs);
  const failedRuns = listRunsByStatus('failure', cutoffMs, nowMs);
  console.log(
    `[scan-job-timeouts] ${cancelledRuns.length} cancelled + ${failedRuns.length} failed run(s) `
      + `in the last ${lookback.minutes}m`
      + (lookback.neededMinutes === null ? ' (no previous successful scan found: base window)' : ''),
  );

  let reported = 0;
  // title → issue ref already opened/matched during THIS scan. See the DEDUP note
  // in the header: this is layer (a), the one that removes the intra-scan race.
  // SHARED by both detectors on purpose: a host-kill takes out every job on that
  // host, so one run can produce several hits that all map to the same title.
  const emittedByTitle = new Map();

  async function emit({ title, description, labels, workflow, runUrl, jobCount, occurredAt }) {
    if (isFailureReportingDisabled()) {
      console.log(`[scan-job-timeouts] ENABLE_FAILURE_REPORT=false; skipping issue persistence for ${runUrl}`);
      return;
    }

    // L'apertura e la chiusura sono accoppiate: un titolo con scope fuori dall'elenco
    // chiuso di `SCOPED_TITLE_EVENTS` non lo chiude nessuno, quindi va detto ad alta
    // voce invece di aprire in silenzio una issue immortale.
    if (!title.startsWith('CI Failure: ') && !SCOPED_TIMEOUT_TITLE_RE.test(title)) {
      console.warn(
        `::warning::[scan-job-timeouts] Reporter di timeout: titolo per evento senza un chiuditore `
          + `registrato — "${title}". Aggiungi l'evento a SCOPED_TITLE_EVENTS.`,
      );
    }

    const already = emittedByTitle.get(title);

    // Every emission is atomic at run level, so the durable run URL proves that
    // all dead jobs in this run were recorded together.
    if (already?.persistedRunUrl === runUrl) {
      console.log(`[scan-job-timeouts] run già segnalata su #${already.number} — skip ${runUrl}`);
      return;
    }

    // A different run of the same workflow is a real recurrence. It is already
    // aggregated, so one comment records the whole occurrence atomically. A
    // CLOSED or unknown-state canonical deliberately falls through to
    // createGithubIssue: that helper owns the guarded reopen path; commenting
    // here would leave a closed or uncertain incident invisible to triage.
    if (already && normalizedIssueState(already) === 'OPEN') {
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

    // `occurredAt` (#9761): the lookback re-reads runs that may have STARTED
    // before a fix closed the canonical issue. Such a run cannot contain the
    // fix, so the creator leaves the closed issue alone instead of reopening it.
    const issue = await createGithubIssue({
      title, description, priority: 2, labels, workflow, occurredAt,
    });
    if (!issue?.number || issue.persisted !== true) {
      throw new Error(`failed to persist ${runUrl}: issue create/reopen did not confirm the write`);
    }
    if (issue.predatesClose === true) {
      reported -= jobCount;
      console.log(
        `[scan-job-timeouts] ${runUrl} started (${occurredAt}) before #${issue.number} was closed — `
          + 'history, not a recurrence: not reopened.',
      );
    }
    emittedByTitle.set(title, {
      ...issue,
      // `createGithubIssue` can return a persisted CLOSED issue when a stale
      // build is observed inside the deploy-latency window. Preserve that
      // authoritative state (and keep UNKNOWN fail-safe) so the next same-title
      // hit calls the creator again instead of commenting on a closed or
      // uncertain canonical.
      state: normalizedIssueState(issue),
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
      ...stepTimingLines(job, { nowMs }),
      '',
    ]);
    const rawDescription = [
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
    // vedi la nota sull'import: nessun path `.github/workflows/**` nel body.
    const description = redactWorkflowPaths(rawDescription);
    await emit({
      title: scopedTitle(run),
      description,
      labels: ['Bug', 'ci-timeout'],
      workflow: run.name,
      runUrl: run.html_url,
      jobCount: hits.length,
      occurredAt: run.created_at,
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
    const rawDescription = [
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
    // vedi la nota sull'import: nessun path `.github/workflows/**` nel body.
    const description = redactWorkflowPaths(rawDescription);
    await emit({
      title: scopedTitle(run),
      description,
      labels: ['Bug', 'ci-host-kill'],
      workflow: run.name,
      runUrl: run.html_url,
      jobCount: kills.length,
      occurredAt: run.created_at,
    });
  }

  console.log(`[scan-job-timeouts] done — ${reported} dead job(s) reported (dry-run=${DRY_RUN}).`);
}

/** Run completate di `workflow` per `event` create dal giorno di `sinceIso`, o `null` se illeggibili. */
function listScopedRuns(workflow, event, sinceIso) {
  const raw = gh([
    'run', 'list', '-w', workflow, '-e', event, '-s', 'completed',
    '--created', `>=${String(sinceIso).slice(0, 10)}`,
    '-L', '100',
    '--json', 'databaseId,conclusion,status,createdAt,headBranch,event,url',
    ...issueRepoFlag(),
  ], { allowFailure: true });
  if (raw === null) return null;
  try {
    const runs = JSON.parse(raw);
    return Array.isArray(runs) ? runs : null;
  } catch {
    return null;
  }
}

/**
 * `--resolve`: chiude le `CI Failure (<evento>): <workflow>` guarite. Vedi la nota
 * «CHI CHIUDE» nel docstring del modulo e `decideScopedTimeoutResolution`.
 * Con `--dry-run` stampa la decisione per issue e non scrive niente.
 */
export async function resolveScopedTimeoutIssues({ dryRun = DRY_RUN, nowMs = Date.now() } = {}) {
  const listed = gh([
    'issue', 'list', '--state', 'open', '--limit', String(OPEN_ISSUE_LISTING_SAFETY_CAP),
    '--json', 'number,title,labels,createdAt', ...issueRepoFlag(),
  ], { allowFailure: true });
  if (listed === null) throw new Error('listing delle issue aperte fallito');
  const issues = parseIssueList(listed);
  if (issues.length >= OPEN_ISSUE_LISTING_SAFETY_CAP) {
    console.warn(
      `::warning::[scan-job-timeouts] --resolve: cap di sicurezza (${OPEN_ISSUE_LISTING_SAFETY_CAP}) `
        + 'raggiunto sul listing issue aperte — possibile troncamento della famiglia.',
    );
  }
  const family = issues.filter((issue) => parseScopedTimeoutTitle(issue?.title));
  console.log(
    `[scan-job-timeouts] --resolve: ${family.length} issue della famiglia \`CI Failure (<evento>)\` `
      + `(dry-run=${dryRun}).`,
  );

  const failures = [];
  let closed = 0;
  for (const issue of family) {
    const { event, workflow } = parseScopedTimeoutTitle(issue.title);
    const tag = `#${issue.number} «${issue.title}»`;
    const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l?.name));
    const exempt = RESOLVE_SKIP_LABELS.find((l) => labels.includes(l));
    if (exempt) {
      console.log(`[scan-job-timeouts] --resolve: ${tag} → keep (label ${exempt})`);
      continue;
    }
    // Le gemelle gia' visibili restano aperte e si dice perche'; il listing e' in
    // memoria. Se una gemella nasce nella race dopo questo controllo, il resolver
    // riceve comunque il numero valutato e non puo' reindirizzare la chiusura.
    const twins = issues.filter((other) => other?.title === issue.title);
    if (twins.length > 1) {
      console.log(
        `[scan-job-timeouts] --resolve: ${tag} → keep (gemelle aperte: ${twins.map((t) => `#${t.number}`).join(', ')})`,
      );
      continue;
    }
    const viewed = gh(['issue', 'view', String(issue.number), '--json', 'body,comments', ...issueRepoFlag()], { allowFailure: true });
    let body = null;
    let comments = [];
    try {
      const parsedView = viewed === null ? null : JSON.parse(viewed);
      body = parsedView === null ? null : parsedView?.body ?? '';
      comments = Array.isArray(parsedView?.comments) ? parsedView.comments : [];
    } catch { body = null; }
    if (body === null) {
      console.log(`[scan-job-timeouts] --resolve: ${tag} → keep (body illeggibile)`);
      continue;
    }
    if (!hasScannerSignature(body)) {
      console.log(`[scan-job-timeouts] --resolve: ${tag} → non toccata (body senza la firma dello scanner)`);
      continue;
    }
    const runs = listScopedRuns(workflow, event, issue.createdAt);
    if (runs === null) {
      console.log(`[scan-job-timeouts] --resolve: ${tag} → keep (run illeggibili)`);
      continue;
    }
    const decision = decideScopedTimeoutResolution({
      title: issue.title,
      issueCreatedAt: issue.createdAt,
      runs,
      classify: (run) => classifyRunForResolve(run, {
        // I jobs servono solo a una run rossa o cancellata: una verde non li legge.
        jobsData: run?.conclusion === 'cancelled' || run?.conclusion === 'failure'
          ? ghJson(repoPath(`actions/runs/${run.databaseId}/jobs?per_page=100`))
          : null,
        readAnnotations: readPaginatedAnnotations,
        nowMs,
      }),
    });
    console.log(
      `[scan-job-timeouts] --resolve: ${tag} → ${decision.action} (${decision.reason}; `
        + `${decision.counted.length} run pulite, ${decision.ignored} non contate)`,
    );
    if (decision.action !== 'close' || dryRun) continue;
    if (isFailureReportingDisabled()) {
      console.log(`[scan-job-timeouts] ENABLE_FAILURE_REPORT=false; ${tag} non chiusa`);
      continue;
    }

    // Il commento PRIMA della chiusura: e' lui a dire quali run la giustificano e se
    // fra quelle c'e' un rosso non-timeout. Senza commento, niente chiusura. Se
    // l'ultimo commento e' gia' un'evidenza (chiusura fallita al tick precedente),
    // non se ne aggiunge un'altra ogni ora: una ricorrenza nel frattempo avrebbe
    // lasciato il suo commento 🔁 in coda e l'evidenza si riscriverebbe.
    // Non si usa `preface` di resolveGithubIssueByNumber: e' best-effort e perderebbe
    // la garanzia «niente commento, niente chiusura» (prezzo: un'evidenza puo' restare
    // su un'issue chiusa o rinominata fra la decisione e la rilettura).
    const lastComment = comments.length > 0 ? String(comments[comments.length - 1]?.body ?? '') : '';
    const evidenceAlreadyLast = lastComment.includes(RESOLVE_EVIDENCE_MARKER);
    if (!evidenceAlreadyLast
      && !commentOnGithubIssue(issue.number, resolveEvidenceComment({ event, workflow, decision }))) {
      failures.push(`${tag}: commento di evidenza non scritto`);
      continue;
    }
    // Si chiude il NUMERO valutato, riletto subito prima della scrittura: chiusa o
    // rinominata dopo la decisione → nessuna scrittura (stessa API di LC-24c).
    try {
      const result = resolveGithubIssueByNumber(issue.number, {
        expectedTitle: issue.title,
        workflow,
        runUrl: decision.counted[0]?.run?.url,
      });
      if (result?.persisted === true) closed += 1;
      else if (result?.skipped === 'not-open' || result?.skipped === 'title-changed') {
        console.log(`[scan-job-timeouts] --resolve: ${tag} → non chiusa (${result.skipped} dopo la decisione)`);
      } else failures.push(`${tag}: resolve senza conferma di chiusura${result?.skipped ? ` (${result.skipped})` : ''}`);
    } catch (err) {
      failures.push(`${tag}: ${err.message}`);
    }
  }
  console.log(`[scan-job-timeouts] --resolve: ${closed} issue chiuse (dry-run=${dryRun}).`);
  if (failures.length > 0) {
    throw new Error(`--resolve: ${failures.length} chiusura/e fallite — ${failures.join('; ')}`);
  }
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })() && RESOLVE_MODE) {
  Promise.resolve()
    .then(() => resolveScopedTimeoutIssues())
    .catch((err) => {
      // Il passo gira con `continue-on-error`: senza un'annotazione un chiuditore rotto
      // resterebbe visibile solo nei log, e la famiglia tornerebbe immortale in silenzio.
      console.warn(`::warning::[scan-job-timeouts] --resolve fallito: ${err.message}`);
      console.error(`[scan-job-timeouts] fatal: ${err.message}`);
      process.exit(1);
    });
} else if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  Promise.resolve()
    .then(() => assertRunAgeHorizon())
    .then(() => main())
    .catch((err) => {
      console.error(`[scan-job-timeouts] fatal: ${err.message}`);
      process.exit(1);
    });
}
