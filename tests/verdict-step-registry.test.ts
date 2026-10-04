// @vitest-environment node
/**
 * LC-03 — registro degli step-verdetto: un rosso VOLUTO non apre un secondo thread.
 *
 * `crawler-health-monitor.yml` chiude rossa la run apposta (`Fail if any crawler stale`)
 * dopo aver aperto le issue `[crawler-health] <slug>:`. Il reporter interno lo sapeva,
 * lo scanner centrale no: dal 2026-09-19 «CI Failure: crawler-health-monitor» (issue
 * 9243) riceveva una ricorrenza per ogni run del monitor e il closer, vedendo l'ultima
 * run rossa, non la chiudeva mai.
 *
 * Le fixture dei job sono payload REALI di `GET /actions/runs/<id>/jobs`, ridotti ai
 * campi letti: 37121059160 (2026-10-03, solo verdetto) e 36717595714 (2026-09-30,
 * guasto vero in `Commit updated health state`, verdetto saltato).
 *
 * Se questa suite diventa rossa il titolo del guasto è:
 * «Step-verdetto non registrato: un rosso voluto apre un secondo thread di fallimento».
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

// Lo scanner e il closer leggono GH_REPO una volta, all'import.
process.env.GH_REPO = 'o/r';
const {
  VERDICT_STEPS,
  VERDICT_JOBS_READ_LIMIT,
  CLOSE_ACTIONS,
  decideFailureIssueClose,
  decideVerdictOnlyThread,
  decidingRun,
  dropVerdictOnlyRuns,
  isVerdictOnlyFailure,
  markVerdictOnlyRuns,
  verdictOnlyThreadNote,
  verdictStepEntryForWorkflowName,
} = await import('../scripts/ci/close-recovered-failure-issues.mjs');
const { scanFailures } = await import('../scripts/ci/scan-unreported-failures.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'verdict-step-registry');
const MONITOR_PATH = '.github/workflows/crawler-health-monitor.yml';
const MONITOR_NAME = 'crawler-health-monitor';

type Step = { name: string; conclusion: string; status?: string; number?: number };
type Job = { name: string; conclusion: string; steps: Step[]; html_url?: string };
type Jobs = { total_count: number; jobs: Job[] };

const readFixture = (runId: string): Jobs => JSON.parse(fs.readFileSync(path.join(FIXTURES, `run-${runId}-jobs.json`), 'utf8'));
const VERDICT_ONLY = readFixture('37121059160');
const REAL_FAILURE = readFixture('36717595714');

/** Una copia della fixture con alcuni step portati a un esito diverso. */
function withSteps(base: Jobs, overrides: Record<string, string>): Jobs {
  const copy: Jobs = structuredClone(base);
  for (const job of copy.jobs) {
    for (const step of job.steps) {
      if (step.name in overrides) step.conclusion = overrides[step.name];
    }
  }
  return copy;
}

describe('isVerdictOnlyFailure — fixture reali del monitor', () => {
  it('la run 37121059160 è rossa per il solo verdetto', () => {
    expect(isVerdictOnlyFailure(MONITOR_PATH, VERDICT_ONLY)).toBe(true);
  });

  it('la run 36717595714 (guasto vero, verdetto saltato) non lo è', () => {
    expect(isVerdictOnlyFailure(MONITOR_PATH, REAL_FAILURE)).toBe(false);
  });

  it('verdetto fallito insieme a «Commit updated health state» → non è di solo verdetto', () => {
    const mixed = withSteps(REAL_FAILURE, { 'Fail if any crawler stale': 'failure' });
    expect(isVerdictOnlyFailure(MONITOR_PATH, mixed)).toBe(false);
  });

  it('crash dello script di salute: «Open issues for stale crawlers» fallisce → resta segnalabile', () => {
    // Exit 2: il file delle issue non viene scritto e lo step che le apre esce 1. Il
    // verdetto, senza funzione di stato nel suo `if:`, viene saltato; anche se fallisse
    // la run non sarebbe di solo verdetto.
    const crashSkipped = withSteps(VERDICT_ONLY, {
      'Open issues for stale crawlers': 'failure',
      'Fail if any crawler stale': 'skipped',
    });
    const crashBoth = withSteps(VERDICT_ONLY, { 'Open issues for stale crawlers': 'failure' });
    expect(isVerdictOnlyFailure(MONITOR_PATH, crashSkipped)).toBe(false);
    expect(isVerdictOnlyFailure(MONITOR_PATH, crashBoth)).toBe(false);
  });

  it('il produttore del verdetto può comparire fallito accanto a lui', () => {
    const withProducer = withSteps(VERDICT_ONLY, { 'Run health check': 'failure' });
    expect(isVerdictOnlyFailure(MONITOR_PATH, withProducer)).toBe(true);
    // ... ma da solo, senza verdetto, non è un verdetto.
    const producerOnly = withSteps(VERDICT_ONLY, { 'Run health check': 'failure', 'Fail if any crawler stale': 'skipped' });
    expect(isVerdictOnlyFailure(MONITOR_PATH, producerOnly)).toBe(false);
  });

  it('job illeggibili, startup failure, job cancellato o non attribuibile → false (fail-closed)', () => {
    expect(isVerdictOnlyFailure(MONITOR_PATH, null)).toBe(false);
    expect(isVerdictOnlyFailure(MONITOR_PATH, {} as Jobs)).toBe(false);
    expect(isVerdictOnlyFailure(MONITOR_PATH, { total_count: 0, jobs: [] })).toBe(false);
    expect(isVerdictOnlyFailure(MONITOR_PATH, { ...VERDICT_ONLY, total_count: 101 })).toBe(false);
    const missingTotalCount = structuredClone(VERDICT_ONLY) as Partial<Jobs>;
    delete missingTotalCount.total_count;
    expect(isVerdictOnlyFailure(MONITOR_PATH, missingTotalCount)).toBe(false);
    const cancelled = structuredClone(VERDICT_ONLY);
    cancelled.jobs.push({ name: 'other', conclusion: 'cancelled', steps: [] });
    expect(isVerdictOnlyFailure(MONITOR_PATH, cancelled)).toBe(false);
    const unattributed = structuredClone(VERDICT_ONLY);
    unattributed.jobs.push({ name: 'other', conclusion: 'failure', steps: [] });
    expect(isVerdictOnlyFailure(MONITOR_PATH, unattributed)).toBe(false);
  });

  it('un workflow fuori registro non è mai di solo verdetto', () => {
    expect(isVerdictOnlyFailure('.github/workflows/altro.yml', VERDICT_ONLY)).toBe(false);
  });

  // Un job `success` può contenere uno step fallito: è il caso `continue-on-error`. Il
  // guasto vero vive lì anche se il job (e quindi la sua conclusion) resta verde, quindi
  // gli step falliti si leggono in OGNI job, non solo in quelli `failure`.
  it('job `success` con uno step continue-on-error estraneo fallito + verdetto fallito → non è di solo verdetto', () => {
    const jobs: Jobs = {
      total_count: 2,
      jobs: [
        { name: 'side', conclusion: 'success', steps: [{ name: 'Unrelated continue-on-error step', conclusion: 'failure' }] },
        { name: 'check', conclusion: 'failure', steps: [{ name: 'Fail if any crawler stale', conclusion: 'failure' }] },
      ],
    };
    expect(isVerdictOnlyFailure(MONITOR_PATH, jobs)).toBe(false);
    // Stessa cosa nel medesimo job della fixture vera, accanto al verdetto.
    const sameRun = structuredClone(VERDICT_ONLY);
    sameRun.jobs.push({ name: 'side', conclusion: 'success', steps: [{ name: 'Commit updated health state', conclusion: 'failure' }] });
    sameRun.total_count = sameRun.jobs.length;
    expect(isVerdictOnlyFailure(MONITOR_PATH, sameRun)).toBe(false);
    // Un job `success` di cui non si leggono gli step non si può dire pulito (fail-closed).
    const unreadable = structuredClone(VERDICT_ONLY);
    unreadable.jobs.push({ name: 'side', conclusion: 'success' } as Job);
    unreadable.total_count = unreadable.jobs.length;
    expect(isVerdictOnlyFailure(MONITOR_PATH, unreadable)).toBe(false);
  });

  it('job `success` il cui solo step fallito è registrato (produttore continue-on-error) → resta di solo verdetto', () => {
    const jobs: Jobs = {
      total_count: 3,
      jobs: [
        { name: 'side', conclusion: 'success', steps: [{ name: 'Run health check', conclusion: 'failure' }, { name: 'Other', conclusion: 'success' }] },
        { name: 'clean', conclusion: 'success', steps: [{ name: 'Other', conclusion: 'success' }] },
        { name: 'check', conclusion: 'failure', steps: [{ name: 'Fail if any crawler stale', conclusion: 'failure' }] },
      ],
    };
    expect(isVerdictOnlyFailure(MONITOR_PATH, jobs)).toBe(true);
    // Un job `skipped` porta `steps: []`: nessuno step fallito, nessun ostacolo.
    jobs.jobs.push({ name: 'skipped', conclusion: 'skipped', steps: [] });
    jobs.total_count = jobs.jobs.length;
    expect(isVerdictOnlyFailure(MONITOR_PATH, jobs)).toBe(true);
  });
});

describe('markVerdictOnlyRuns — lettura limitata e fail-closed', () => {
  const runs = (conclusions: string[]) => conclusions.map((conclusion, i) => ({
    databaseId: 100 + i,
    conclusion,
    status: 'completed',
    createdAt: new Date(Date.parse('2026-10-03T12:00:00Z') - i * 86_400_000).toISOString(),
  }));

  it('legge i job solo delle rosse più recenti, fino al limite', () => {
    const history = runs([...Array(VERDICT_JOBS_READ_LIMIT + 3).fill('failure'), 'success']);
    const read: number[] = [];
    const marked = markVerdictOnlyRuns(history, MONITOR_PATH, (id: number) => {
      read.push(id);
      return VERDICT_ONLY;
    });
    expect(read).toEqual(history.slice(0, VERDICT_JOBS_READ_LIMIT).map((r) => r.databaseId));
    expect(marked.filter((r: { verdictOnly?: boolean }) => r.verdictOnly).length).toBe(VERDICT_JOBS_READ_LIMIT);
    expect(dropVerdictOnlyRuns(marked).map((r: { databaseId: number }) => r.databaseId))
      .toEqual(history.slice(VERDICT_JOBS_READ_LIMIT).map((r) => r.databaseId));
  });

  it('job illeggibili → la run resta rossa, ed è marcata come esaminata', () => {
    const history = runs(['failure', 'failure']);
    const marked = markVerdictOnlyRuns(history, MONITOR_PATH, () => null);
    expect(marked.some((r: { verdictOnly?: boolean }) => r.verdictOnly)).toBe(false);
    expect(marked.map((r: { verdictOnly?: boolean }) => r.verdictOnly)).toEqual([false, false]);
  });

  it('cancelled / timed_out / startup_failure non spendono letture e restano rosse', () => {
    const others = ['cancelled', 'timed_out', 'startup_failure'];
    const history = runs([...others, ...Array(VERDICT_JOBS_READ_LIMIT + 1).fill('failure')]);
    const read: number[] = [];
    const marked = markVerdictOnlyRuns(history, MONITOR_PATH, (id: number) => {
      read.push(id);
      return VERDICT_ONLY;
    });
    const failures = history.filter((r) => r.conclusion === 'failure');
    expect(read).toEqual(failures.slice(0, VERDICT_JOBS_READ_LIMIT).map((r) => r.databaseId));
    expect(marked.slice(0, others.length).map((r: { verdictOnly?: boolean }) => r.verdictOnly))
      .toEqual(others.map(() => false));
    // Oltre la finestra nessuno ha letto: la run non porta il campo.
    expect('verdictOnly' in marked[marked.length - 1]).toBe(false);
  });

  it('workflow fuori registro: storico invariato e nessuna lettura', () => {
    const history = runs(['failure']);
    const readJobs = vi.fn(() => VERDICT_ONLY);
    expect(markVerdictOnlyRuns(history, '.github/workflows/altro.yml', readJobs)).toBe(history);
    expect(readJobs).not.toHaveBeenCalled();
  });
});

describe('decideFailureIssueClose — regola verdict-only-thread', () => {
  const NOW = Date.parse('2026-10-03T18:00:00Z');
  const DAY = 86_400_000;
  const OPTIONS = {
    recurrence: { windowHours: 8, maxRecurrences: 1, minGreenStreak: 3, maxFailureRate: 0.02 },
    chronic: { threshold: 5, windowHours: 168 },
    holdMaxDays: 9,
  };
  let id = 5000;
  const run = (conclusion: string, daysAgo: number, extra: Record<string, unknown> = {}) => ({
    databaseId: id++,
    status: 'completed',
    conclusion,
    createdAt: new Date(NOW - daysAgo * DAY).toISOString(),
    ...extra,
  });
  const verdictRun = (daysAgo: number) => run('failure', daysAgo, { verdictOnly: true });
  const issue = (title: string, openedDaysAgo: number) => ({
    number: 9243,
    title,
    createdAt: new Date(NOW - openedDaysAgo * DAY).toISOString(),
    labels: [],
  });
  const decide = (input: Record<string, unknown>) => decideFailureIssueClose({ now: NOW, options: OPTIONS, ...input });
  const CI = `CI Failure: ${MONITOR_NAME}`;
  const tenVerdicts = () => Array.from({ length: 10 }, (_, i) => verdictRun(i + 0.5));

  it('dieci rosse-verdetto dopo l\'apertura → close-not-planned', () => {
    const history = tenVerdicts();
    const verdict = decide({ issue: issue(CI, 14), history, comments: null });
    expect(CLOSE_ACTIONS).toContain('close-not-planned');
    expect(verdict.action).toBe('close-not-planned');
    expect(verdict.reason).toBe('verdict-only-thread');
    expect(verdict.runId).toBe(history[0].databaseId);
    expect(verdict.verdictThread.entry.owner).toBe(VERDICT_STEPS[MONITOR_PATH].owner);
  });

  it('nove rosse-verdetto e una mista in testa → keep', () => {
    const history = [run('failure', 0.2), ...tenVerdicts().slice(1)];
    const verdict = decide({ issue: issue(CI, 14), history, comments: null });
    expect(verdict.action).toBe('keep');
    expect(verdict.reason).toBe('still-red');
    expect(verdict.runId).toBe(history[0].databaseId);
  });

  it('un guasto vero OLTRE la finestra letta, seguito da rosse-verdetto → close-not-planned (caso 9243)', () => {
    // 09-30: run 36717595714, guasto vero con il suo thread `Workflow Failure:` (issue
    // 10523). Uscita dalla finestra delle rosse lette non porta `verdictOnly`.
    const history = [verdictRun(0.2), verdictRun(1.2), verdictRun(2.2), run('failure', 3.2), verdictRun(4.2)];
    const verdict = decide({ issue: issue(CI, 14), history, comments: null });
    expect(verdict.action).toBe('close-not-planned');
  });

  it('un guasto vero LETTO dopo l\'apertura tiene aperto il thread; prima dell\'apertura no', () => {
    const realAfter = [verdictRun(0.2), verdictRun(1.2), run('failure', 2.2, { verdictOnly: false }), verdictRun(3.2)];
    const kept = decide({ issue: issue(CI, 14), history: realAfter, comments: null });
    expect(kept.action).toBe('keep');
    expect(kept.reason).toBe('still-red');

    const realBefore = [verdictRun(0.2), verdictRun(1.2), run('failure', 20, { verdictOnly: false })];
    expect(decide({ issue: issue(CI, 14), history: realBefore, comments: null }).action).toBe('close-not-planned');
  });

  // La forma della chiamata di `main()`: la run che decide è SEMPRE passata, calcolata
  // dallo storico. Con una verde vecchia o una rossa non letta in fondo allo storico è
  // non-null, e la regola deve scattare lo stesso.
  it('chiamata come main(): `run` = decidingRun(storico) non spegne la regola', () => {
    const asMain = (history: unknown[]) => decide({
      issue: issue(CI, 14),
      run: decidingRun({ run: null, history }),
      history,
      comments: null,
    });
    const oldGreen = [...tenVerdicts(), run('success', 20)];
    expect(decidingRun({ run: null, history: oldGreen })).not.toBeNull();
    expect(asMain(oldGreen).action).toBe('close-not-planned');

    const unreadRed = [...tenVerdicts(), run('failure', 12)];
    expect(asMain(unreadRed).action).toBe('close-not-planned');
  });

  it('percorso crawler-step (senza storico): la regola non si applica', () => {
    const verdict = decide({ issue: issue(CI, 14), run: verdictRun(0.2), history: null, comments: null });
    expect(verdict.action).toBe('keep');
  });

  it('nessuna rossa dopo l\'apertura → decisione invariata', () => {
    const before = [verdictRun(20), run('success', 21)];
    const registered = decide({ issue: issue(CI, 14), history: before, comments: null });
    const unflagged = decide({
      issue: issue(CI, 14),
      history: before.map(({ verdictOnly: _drop, ...r }) => r),
      comments: null,
    });
    expect(registered.action).toBe('keep');
    expect(registered.action).toBe(unflagged.action);

    const green = [run('success', 0.5), run('success', 1.5)];
    expect(decide({ issue: issue(CI, 14), history: green, comments: [] }).action).toBe('close');
  });

  it('un verde vero dopo l\'apertura resta il ramo `recovered`, con i suoi hold', () => {
    const history = [verdictRun(0.2), run('success', 1.2), run('success', 2.2)];
    const verdict = decide({ issue: issue(CI, 14), history, comments: [] });
    expect(verdict.action).toBe('close');
    expect(verdict.runId).toBe(history[1].databaseId);
  });

  it('`Workflow Failure:` sullo stesso workflow (il crash vero) non è toccato dalla regola', () => {
    const verdict = decide({ issue: issue(`Workflow Failure: ${MONITOR_NAME}`, 14), history: tenVerdicts(), comments: null });
    expect(verdict.action).toBe('keep');
  });

  it('un `CI Failure:` fuori registro non viene chiuso, nemmeno con run marcate', () => {
    const verdict = decideVerdictOnlyThread({ issue: issue('CI Failure: Altro', 14), history: tenVerdicts() });
    expect(verdict.close).toBe(false);
  });

  it('il commento di chiusura rimanda alla famiglia proprietaria e alla run', () => {
    const entry = verdictStepEntryForWorkflowName(MONITOR_NAME);
    const note = verdictOnlyThreadNote({ workflow: MONITOR_NAME, entry, runUrl: 'https://github.com/o/r/actions/runs/1' });
    expect(note).toContain(entry.owner);
    expect(note).toContain(entry.verdict);
    expect(note).toContain('https://github.com/o/r/actions/runs/1');
  });
});

describe('scan-unreported-failures — una run di solo verdetto non è un fallimento non segnalato', () => {
  const WF_ID = '7777';
  const SCAN_AT = '2026-10-03T14:00:00Z';
  const RED_RUN = {
    id: '37121059160',
    event: 'schedule',
    head_branch: 'main',
    created_at: '2026-10-03T11:52:52Z',
    updated_at: '2026-10-03T12:03:10Z',
    html_url: 'https://github.com/o/r/actions/runs/37121059160',
  };
  const tsv = (rows: string[][]) => rows.map((r) => r.join('\t')).join('\n');
  const issueCalls = (sub: string) => execFileSync.mock.calls
    .filter((c) => c[0] === 'gh' && (c[1] as string[])[0] === 'issue' && (c[1] as string[])[1] === sub);

  function mockGithub({ jobs, openIssue }: { jobs: Jobs; openIssue: boolean }) {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        if (args[3] !== 'open' || !openIssue) return '[]';
        return JSON.stringify([{
          number: 9243,
          title: `CI Failure: ${MONITOR_NAME}`,
          updatedAt: '2026-10-01T00:00:00Z',
          body: '',
        }]);
      }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ body: '', comments: [] });
      if (args[0] === 'api') {
        const p = String(args[1]);
        if (p.includes('/actions/workflows?')) return tsv([[WF_ID, MONITOR_NAME, MONITOR_PATH, 'active', '2026-01-01T00:00:00Z']]);
        if (p.includes('/actions/runs?created=')) {
          return tsv([[RED_RUN.id, WF_ID, RED_RUN.event, RED_RUN.head_branch, 'failure', RED_RUN.created_at,
            RED_RUN.updated_at, RED_RUN.html_url, MONITOR_PATH]]);
        }
        if (p.includes(`/actions/workflows/${WF_ID}/runs`)) {
          return tsv([[RED_RUN.id, 'completed', 'failure', RED_RUN.created_at, RED_RUN.event, RED_RUN.head_branch]]);
        }
        if (/\/actions\/runs\/\d+\/jobs/.test(p)) return JSON.stringify(jobs);
        if (p.includes('/issues?state=closed')) return '[]';
        return '';
      }
      if (args[0] === 'issue' && ['reopen', 'comment', 'create', 'edit'].includes(args[1])) {
        return 'https://github.com/o/r/issues/9243';
      }
      return '';
    });
  }

  beforeEach(() => {
    execFileSync.mockReset();
    delete process.env.GITHUB_STEP_SUMMARY;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(SCAN_AT));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('thread aperto e fermo: la run di solo verdetto non aggiunge una ricorrenza', async () => {
    mockGithub({ jobs: VERDICT_ONLY, openIssue: true });
    const code = await scanFailures();
    expect(issueCalls('comment')).toEqual([]);
    expect(issueCalls('create')).toEqual([]);
    expect(code).toBe(0);
  });

  it('thread aperto e fermo: la run mista registra la ricorrenza, come prima', async () => {
    mockGithub({ jobs: withSteps(REAL_FAILURE, { 'Fail if any crawler stale': 'failure' }), openIssue: true });
    await scanFailures();
    expect(issueCalls('comment').map((c) => (c[1] as string[])[2])).toEqual(['9243']);
  });

  it('nessun thread: la run di solo verdetto non apre «CI Failure:», quella mista sì', async () => {
    mockGithub({ jobs: VERDICT_ONLY, openIssue: false });
    await scanFailures();
    expect(issueCalls('create')).toEqual([]);

    execFileSync.mockReset();
    mockGithub({ jobs: REAL_FAILURE, openIssue: false });
    await scanFailures();
    const created = issueCalls('create').map((c) => (c[1] as string[]));
    expect(created.length).toBe(1);
    expect(created[0][created[0].indexOf('--title') + 1]).toBe(`CI Failure: ${MONITOR_NAME}`);
  });
});

describe('lint del registro contro i YAML veri', () => {
  type WorkflowDoc = { name?: string; jobs?: Record<string, { steps?: Array<{ name?: string }> }> };
  const readWorkflow = (rel: string) => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return { text, doc: YAML.parse(text) as WorkflowDoc };
  };
  const stepNames = (doc: WorkflowDoc) => Object.values(doc.jobs ?? {})
    .flatMap((job) => (job?.steps ?? []).map((s) => s?.name).filter((n): n is string => typeof n === 'string'));

  /**
   * Workflow con uno step-verdetto NON ancora registrato. Il loro reporter INTERNO
   * segnala apposta anche il verdetto: registrarli prima di dar loro una issue
   * proprietaria aprirebbe un ciclo chiudi/riapri. Li registra LC-07, che svuota questa
   * lista. Solo in diminuzione.
   */
  const PENDING_VERDICT_WORKFLOWS = new Set([
    '.github/workflows/seo-health-loop.yml',
    '.github/workflows/refresh-plate-auctions.yml',
  ]);

  /**
   * Step che il pattern intercetta ma che NON sono verdetti, verificati a mano: restano
   * guasti segnalabili.
   */
  const REVIEWED_NON_VERDICT_STEPS = new Set([
    // Timeout di propagazione di Pages: il deploy non è live, un guasto vero (la parola
    // «stale» qui descrive la build live precedente, non un verdetto di monitor).
    '.github/workflows/post-deploy-validate-live.yml#Fail on propagation timeout (skip smoke against stale live)',
  ]);

  const VERDICT_STEP_NAME_RE = /^Fail .*(verdict|finding|stale)/i;

  it('ogni voce del registro esiste nel YAML con quei nomi (una rinomina fa fallire qui)', () => {
    const entries = Object.entries(VERDICT_STEPS) as Array<[string, { workflowName: string; verdict: string; producers: string[]; owner: string }]>;
    expect(entries.length).toBeGreaterThan(0);
    for (const [rel, entry] of entries) {
      const { text, doc } = readWorkflow(rel);
      expect(doc.name, `${rel}: name:`).toBe(entry.workflowName);
      const names = stepNames(doc);
      expect(names, `${rel}: step-verdetto`).toContain(entry.verdict);
      for (const producer of entry.producers) expect(names, `${rel}: produttore`).toContain(producer);
      expect(text, `${rel}: prefisso della famiglia proprietaria`).toContain(entry.owner);
      expect(verdictStepEntryForWorkflowName(entry.workflowName)?.workflowPath).toBe(rel);
    }
  });

  it('nessuno step-verdetto fuori registro, salvo la lista in attesa di LC-07', () => {
    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
    expect(files.length).toBeGreaterThan(0);
    const unregistered: string[] = [];
    const pendingSeen = new Set<string>();
    for (const file of files) {
      const rel = `.github/workflows/${file}`;
      const { doc } = readWorkflow(rel);
      for (const name of stepNames(doc ?? {})) {
        if (!VERDICT_STEP_NAME_RE.test(name)) continue;
        if (VERDICT_STEPS[rel]?.verdict === name) continue;
        if (REVIEWED_NON_VERDICT_STEPS.has(`${rel}#${name}`)) continue;
        if (PENDING_VERDICT_WORKFLOWS.has(rel)) {
          pendingSeen.add(rel);
          continue;
        }
        unregistered.push(`${rel}#${name}`);
      }
    }
    expect(
      unregistered,
      'Step-verdetto non registrato: un rosso voluto apre un secondo thread di fallimento. '
        + 'Registralo in VERDICT_STEPS (scripts/ci/close-recovered-failure-issues.mjs) oppure, se è un guasto vero, '
        + 'in REVIEWED_NON_VERDICT_STEPS con il motivo.',
    ).toEqual([]);
    // La lista in attesa si accorcia soltanto: una voce registrata o sparita va tolta.
    expect([...PENDING_VERDICT_WORKFLOWS].filter((rel) => !pendingSeen.has(rel))).toEqual([]);
  });
});
