import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * `scan-job-timeouts.mjs --resolve` — il chiuditore della famiglia
 * `CI Failure (<evento>): <workflow>`, che `scopedTitle` conia per un timeout
 * fuori da `main` e che il reconciler centrale lascia stare per costruzione.
 *
 * Il caso che l'ha reso necessario è la issue 10809 («CI Failure
 * (pull_request): Assisted application portal e2e», aperta il 2026-10-01T18:55:20Z):
 * le run dello stesso evento erano tornate pulite la sera stessa e lo erano
 * ancora il 03-10, ma nessun processo guardava quella famiglia sul verde, e la
 * issue è rimasta aperta finché una persona non l'ha chiusa.
 *
 * `gh` è finto e instradato per sotto-comando, come negli altri test dello
 * scanner; la chiusura vera (`resolveGithubIssue`) e il commento sono spiati.
 */
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});
const resolveGithubIssue = vi.fn();
const commentOnGithubIssue = vi.fn();
vi.mock('../scripts/lib/github-issue-creator.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGithubIssue: (...args: unknown[]) => resolveGithubIssue(...args),
    commentOnGithubIssue: (...args: unknown[]) => commentOnGithubIssue(...args),
  };
});

const {
  SCOPED_TITLE_EVENTS,
  SCOPED_TIMEOUT_TITLE_RE,
  JOB_TIMEOUT_REPORT_SIGNATURE,
  RESOLVE_CLEAN_RUNS,
  scopedTitle,
  parseScopedTimeoutTitle,
  hasScannerSignature,
  classifyRunForResolve,
  decideScopedTimeoutResolution,
  resolveEvidenceComment,
  resolveScopedTimeoutIssues,
  RESOLVE_EVIDENCE_MARKER,
} = await import('../scripts/ci/scan-job-timeouts.mjs');
const { timeoutReportSourceRun } = await import('../scripts/ci/route-already-fixed.mjs');

const WORKFLOWS_DIR = path.resolve(__dirname, '..', '.github', 'workflows');
const WF = 'Assisted application portal e2e';
const TITLE_10809 = `CI Failure (pull_request): ${WF}`;
const OPENED_10809 = '2026-10-01T18:55:20Z';
const RUN_URL = (id: number) => `https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/${id}`;

// Il body vero della 10809, ridotto alle righe che contano: la firma è la
// stessa che lo scanner scrive in ogni body (timeout e host-kill).
const BODY_10809 = [
  '## Job cancellati per timeout',
  '',
  `**Run:** ${RUN_URL(36893541451)}`,
  '**Trigger:** pull_request',
  '**Ref:** test-join-new-email-20261001',
  '',
  '### Job 1: e2e',
  '**Motivo:** The job has exceeded the maximum execution time of 15m0s',
  '',
  'Rilevato da `scripts/ci/scan-job-timeouts.mjs` (scan periodico, non dal workflow stesso — '
    + 'un job cancellato per timeout non passa mai `if: failure()`).',
].join('\n');

type Run = {
  databaseId: number; conclusion: string; status: string; createdAt: string;
  headBranch: string; event: string; url: string;
};
const run = (databaseId: number, conclusion: string, createdAt: string, headBranch: string, event = 'pull_request'): Run => ({
  databaseId, conclusion, status: 'completed', createdAt, headBranch, event, url: RUN_URL(databaseId),
});

// Storia REALE delle run `pull_request` completate di «Assisted application
// portal e2e» create dopo l'apertura della 10809, misurata il 2026-10-03 con
//   gh run list -w "Assisted application portal e2e" -e pull_request -s completed -L 100
const HISTORY_10809: Run[] = [
  run(37133614819, 'success', '2026-10-03T15:32:40Z', 'assisted-sf-cookie-manager'),
  run(37121175559, 'success', '2026-10-03T11:55:05Z', 'coop-sf-enter-20261003'),
  run(37121114059, 'success', '2026-10-03T11:53:54Z', 'assisted-form-title-employer'),
  run(37120413990, 'cancelled', '2026-10-03T11:40:34Z', 'assisted-form-title-employer'),
  run(37120300588, 'cancelled', '2026-10-03T11:38:30Z', 'coop-sf-enter-20261003'),
  run(37119557197, 'success', '2026-10-03T11:24:33Z', 'assisted-inline-password'),
  run(37118633227, 'cancelled', '2026-10-03T11:07:13Z', 'assisted-inline-password'),
  run(37117927068, 'cancelled', '2026-10-03T10:54:24Z', 'assisted-inline-password'),
  run(37117207390, 'success', '2026-10-03T10:40:46Z', 'coop-sf-widgets-20261003'),
  run(37117118424, 'cancelled', '2026-10-03T10:39:08Z', 'assisted-inline-password'),
  run(37116521680, 'cancelled', '2026-10-03T10:28:17Z', 'assisted-inline-password'),
  run(37116465191, 'cancelled', '2026-10-03T10:27:12Z', 'coop-sf-widgets-20261003'),
  run(37115596981, 'cancelled', '2026-10-03T10:11:45Z', 'assisted-inline-password'),
  run(37115403358, 'cancelled', '2026-10-03T10:08:20Z', 'assisted-inline-password'),
  run(37114781053, 'success', '2026-10-03T09:57:31Z', 'fix/issue-10989'),
  run(37113952547, 'cancelled', '2026-10-03T09:42:25Z', 'fix/issue-10989'),
  run(37113609592, 'success', '2026-10-03T09:36:17Z', 'coop-sf-form-20261003'),
  run(37113128056, 'cancelled', '2026-10-03T09:27:47Z', 'fix/issue-10989'),
  run(37112093819, 'success', '2026-10-03T09:09:25Z', 'coop-sf-form-20261003'),
  run(37111955077, 'failure', '2026-10-03T09:06:57Z', 'fix/issue-10989'),
  run(37109560060, 'success', '2026-10-03T08:23:54Z', 'coop-dpcs-20261003'),
  run(37108305493, 'success', '2026-10-03T08:01:39Z', 'coop-dpcs-20261003'),
  run(36913722350, 'success', '2026-10-01T19:21:47Z', 'assisted-portal-captcha-stop'),
  run(36912175291, 'cancelled', '2026-10-01T19:09:14Z', 'assisted-portal-captcha-stop'),
  // la run che ha aperto la issue: creata PRIMA dell'apertura, non conta
  run(36893541451, 'cancelled', '2026-10-01T18:30:00Z', 'test-join-new-email-20261001'),
];
const asOf = (iso: string) => HISTORY_10809.filter((r) => r.createdAt <= iso);

// Annotazioni misurate il 2026-10-03 sui check run dei job `e2e`: una
// cancellazione per concorrenza (37120413990) e il timeout che ha aperto la issue.
const CONCURRENCY_ANNOTATIONS = [
  { annotation_level: 'failure', message: 'Canceling since a higher priority waiting request for assisted-application-portal-e2e-11064 exists' },
  { annotation_level: 'failure', message: 'The operation was canceled.' },
];
const TIMEOUT_ANNOTATIONS = [
  { annotation_level: 'failure', message: 'The job has exceeded the maximum execution time of 15m0s' },
  { annotation_level: 'failure', message: 'The operation was canceled.' },
];

function jobsFor(r: Run) {
  if (r.conclusion === 'failure') {
    // 37111955077: `e2e` rosso su «Portal runner on the fake portal», nessuno step
    // rimasto in_progress — un fallimento normale, non un host-kill.
    return {
      total_count: 2,
      jobs: [
        { name: 'extension', status: 'completed', conclusion: 'success', steps: [] },
        {
          name: 'e2e', status: 'completed', conclusion: 'failure', completed_at: '2026-10-03T09:27:33Z',
          steps: [{ name: 'Portal runner on the fake portal', status: 'completed', conclusion: 'failure' }],
        },
      ],
    };
  }
  return {
    total_count: 2,
    jobs: [
      { name: 'extension', status: 'completed', conclusion: 'success', steps: [] },
      // Il job `e2e` cancellato ha GIRATO (concorrenza o timeout a meta' corsa):
      // e' il caso in cui le sue annotazioni vanno lette.
      {
        name: 'e2e', status: 'completed', conclusion: 'cancelled', check_run_url: `cr/${r.databaseId}`,
        steps: [
          { name: 'Set up job', status: 'completed', conclusion: 'success' },
          { name: 'Portal runner on the fake portal', status: 'completed', conclusion: 'cancelled' },
        ],
      },
    ],
  };
}

function classifier(annotationsFor: (r: Run) => unknown = (r) => (
  r.databaseId === 36893541451 ? TIMEOUT_ANNOTATIONS : CONCURRENCY_ANNOTATIONS
)) {
  const reads: number[] = [];
  const classify = (r: Run) => {
    reads.push(r.databaseId);
    return classifyRunForResolve(r, {
      jobsData: jobsFor(r),
      readAnnotations: () => annotationsFor(r),
      nowMs: Date.parse('2026-10-03T18:00:00Z'),
    });
  };
  return { classify, reads };
}

describe('la famiglia: elenco CHIUSO di eventi più la firma dello scanner', () => {
  it('`CI Failure (deploy)` e `CI Failure (build)` non sono mai esaminate', () => {
    // Hanno già il loro chiuditore nel workflow di deploy: un secondo, con un
    // criterio che parla di timeout, chiuderebbe guasti di un altro genere.
    for (const title of [
      'CI Failure (deploy): Publish to GitHub Pages (deploy + validate)',
      'CI Failure (build): Deploy to GitHub Pages',
    ]) {
      expect(SCOPED_TIMEOUT_TITLE_RE.test(title)).toBe(false);
      expect(parseScopedTimeoutTitle(title)).toBeNull();
    }
    expect(SCOPED_TITLE_EVENTS).not.toContain('deploy');
    expect(SCOPED_TITLE_EVENTS).not.toContain('build');
  });

  it('ogni titolo che `scopedTitle` conia per un evento dell\'elenco è riconosciuto (parità apertura/chiusura)', () => {
    for (const event of SCOPED_TITLE_EVENTS) {
      const title = scopedTitle({ head_branch: 'feat/x', event, name: WF });
      expect(parseScopedTimeoutTitle(title), title).toEqual({ event, workflow: WF });
    }
    // Una run senza evento cade sul segnaposto, che è nell'elenco.
    expect(parseScopedTimeoutTitle(scopedTitle({ head_branch: 'feat/x', name: WF }))).toEqual({ event: 'unknown', workflow: WF });
    // Il titolo di `main` resta del reconciler centrale.
    expect(parseScopedTimeoutTitle(scopedTitle({ head_branch: 'main', event: 'push', name: WF }))).toBeNull();
  });

  it('ogni evento dichiarato nell\'`on:` di un workflow del repo è nell\'elenco', () => {
    // Un workflow con un trigger nuovo produrrebbe, al primo timeout fuori da
    // `main`, un titolo che `--resolve` non riconosce: immortale di nuovo.
    // `workflow_call` non è un evento di run: i job del chiamato girano dentro
    // la run del chiamante, col suo evento.
    const missing = new Set<string>();
    for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      const doc = YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')) ?? {};
      const on = doc.on ?? doc[true as unknown as string];
      const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
      for (const event of events) {
        if (event !== 'workflow_call' && !SCOPED_TITLE_EVENTS.includes(event)) missing.add(`${file}: ${event}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('la firma è quella scritta nel body, fra backtick', () => {
    expect(JOB_TIMEOUT_REPORT_SIGNATURE).toBe('scripts/ci/scan-job-timeouts.mjs');
    expect(hasScannerSignature(BODY_10809)).toBe(true);
    expect(hasScannerSignature('Un timeout, senza dire chi l\'ha visto.')).toBe(false);
    // Citato in prosa senza backtick non è la firma del reporter.
    expect(hasScannerSignature('vedi scripts/ci/scan-job-timeouts.mjs')).toBe(false);
  });

  it('`route-already-fixed.mjs` riconosce le stesse issue (copia letterale della firma, allineata)', () => {
    for (const body of [BODY_10809, 'vedi scripts/ci/scan-job-timeouts.mjs', '', 'timeout visto a mano']) {
      expect(timeoutReportSourceRun(body, 'valerielinc-ops/frontaliere-si-o-no').required, body).toBe(hasScannerSignature(body));
    }
  });
});

describe('decideScopedTimeoutResolution — la storia vera della 10809', () => {
  it('replay al 2026-10-03T16:00Z: tre run pulite dopo l\'apertura → close', () => {
    const { classify, reads } = classifier();
    const d = decideScopedTimeoutResolution({
      title: TITLE_10809, issueCreatedAt: OPENED_10809, runs: asOf('2026-10-03T16:00:00Z'), classify,
    });
    expect(d.action).toBe('close');
    expect(d.counted.map((c: { run: Run }) => c.run.databaseId)).toEqual([37133614819, 37121175559, 37121114059]);
    // Pigra: si ferma appena decide, senza leggere il resto della storia.
    expect(reads).toEqual([37133614819, 37121175559, 37121114059]);
  });

  it('replay al 2026-10-03T11:45Z: le cancellate per concorrenza non contano, ma neanche bloccano', () => {
    const { classify } = classifier();
    const d = decideScopedTimeoutResolution({
      title: TITLE_10809, issueCreatedAt: OPENED_10809, runs: asOf('2026-10-03T11:45:00Z'), classify,
    });
    expect(d.action).toBe('close');
    expect(d.counted.map((c: { run: Run }) => c.run.databaseId)).toEqual([37119557197, 37117207390, 37114781053]);
    expect(d.ignored).toBe(asOf('2026-10-03T11:45:00Z')
      .filter((r) => r.conclusion === 'cancelled' && r.createdAt > '2026-10-03T09:57:31Z').length);
  });

  it('replay al 2026-10-03T09:20Z: un rosso SENZA timeout conta, e il commento lo dice', () => {
    const { classify } = classifier();
    const d = decideScopedTimeoutResolution({
      title: TITLE_10809, issueCreatedAt: OPENED_10809, runs: asOf('2026-10-03T09:20:00Z'), classify,
    });
    expect(d.action).toBe('close');
    expect(d.counted.map((c: { verdict: string }) => c.verdict)).toEqual(['clean', 'clean-failure', 'clean']);
    const comment = resolveEvidenceComment({ event: 'pull_request', workflow: WF, decision: d });
    expect(comment).toContain(RUN_URL(37111955077));
    expect(comment).toContain('failure senza timeout');
    expect(comment).not.toMatch(/\.github\/workflows\//);
  });

  it('subito dopo l\'apertura (2026-10-01T19:30Z) una sola run pulita → keep', () => {
    const { classify } = classifier();
    const d = decideScopedTimeoutResolution({
      title: TITLE_10809, issueCreatedAt: OPENED_10809, runs: asOf('2026-10-01T19:30:00Z'), classify,
    });
    expect(d.action).toBe('keep');
    expect(d.counted).toHaveLength(1);
  });
});

describe('decideScopedTimeoutResolution — i casi limite', () => {
  const T0 = '2026-10-01T00:00:00Z';
  const t = (h: number) => new Date(Date.parse(T0) + h * 3_600_000).toISOString();
  const decide = (runs: Run[], annotationsFor?: (r: Run) => unknown) => decideScopedTimeoutResolution({
    title: TITLE_10809, issueCreatedAt: T0, runs, classify: classifier(annotationsFor).classify,
  });

  it(`${RESOLVE_CLEAN_RUNS} run pulite dopo l'apertura → close; due → keep`, () => {
    const three = [run(3, 'success', t(3), 'a'), run(2, 'success', t(2), 'b'), run(1, 'success', t(1), 'c')];
    expect(decide(three).action).toBe('close');
    expect(decide(three.slice(0, 2)).action).toBe('keep');
  });

  it('una `cancelled` con annotazione di timeout fra le ultime tre → keep', () => {
    const runs = [run(4, 'success', t(4), 'a'), run(3, 'cancelled', t(3), 'b'), run(2, 'success', t(2), 'c'), run(1, 'success', t(1), 'd')];
    const d = decide(runs, (r) => (r.databaseId === 3 ? TIMEOUT_ANNOTATIONS : CONCURRENCY_ANNOTATIONS));
    expect(d.action).toBe('keep');
    expect(d.reason).toContain('timeout');
  });

  it('una `cancelled` da concorrenza senza annotazione di timeout è ignorata', () => {
    const runs = [run(4, 'success', t(4), 'a'), run(3, 'cancelled', t(3), 'b'), run(2, 'success', t(2), 'c'), run(1, 'success', t(1), 'd')];
    const d = decide(runs);
    expect(d.action).toBe('close');
    expect(d.ignored).toBe(1);
  });

  it('annotazioni illeggibili (null, vuote o malformate) → keep, fail-closed', () => {
    const runs = [run(4, 'success', t(4), 'a'), run(3, 'cancelled', t(3), 'b'), run(2, 'success', t(2), 'c'), run(1, 'success', t(1), 'd')];
    for (const unreadable of [null, [], [{ level: 'failure' }], 'x']) {
      const d = decide(runs, () => unreadable);
      expect(d.action, JSON.stringify(unreadable)).toBe('keep');
      expect(d.reason).toContain('illeggibil');
    }
  });

  it('un job cancellato che non ha eseguito step (attesa di `needs:`) non è un timeout né un\'illeggibile', () => {
    // Misurato su `tests` 37171177520 (pull_request, cancelled): `vitest` cancellato
    // con annotazioni leggibili, `post-review` cancellato con steps=[] e annotations=[].
    const reads: string[] = [];
    const v = classifyRunForResolve(run(1, 'cancelled', t(1), 'a'), {
      jobsData: {
        total_count: 2,
        jobs: [
          {
            name: 'vitest', status: 'completed', conclusion: 'cancelled', check_run_url: 'cr/vitest',
            steps: [{ name: 'Run vitest', status: 'completed', conclusion: 'cancelled' }],
          },
          { name: 'post-review', status: 'completed', conclusion: 'cancelled', check_run_url: 'cr/post-review', steps: [] },
        ],
      },
      readAnnotations: (job: { name: string }) => { reads.push(job.name); return job.name === 'post-review' ? [] : CONCURRENCY_ANNOTATIONS; },
    });
    expect(v.verdict).toBe('ignored');
    expect(reads).toEqual(['vitest']);
  });

  it('`steps` assente non prova che il job non sia partito: annotazioni vuote → keep', () => {
    const v = classifyRunForResolve(run(1, 'cancelled', t(1), 'a'), {
      jobsData: { total_count: 1, jobs: [{ name: 'e2e', status: 'completed', conclusion: 'cancelled', check_run_url: 'cr/e2e' }] },
      readAnnotations: () => [],
    });
    expect(v.verdict).toBe('unknown');
  });

  it('uno step `in_progress` ancora nella finestra di assestamento dell\'host-kill → illeggibile, non `clean-failure`', () => {
    const v = classifyRunForResolve(run(1, 'failure', t(1), 'a'), {
      jobsData: {
        total_count: 1,
        jobs: [{
          name: 'e2e', status: 'completed', conclusion: 'failure', completed_at: t(1),
          steps: [{ number: 5, name: 'Build', status: 'in_progress' }],
        }],
      },
      readAnnotations: () => null,
      nowMs: Date.parse(t(1)) + 30_000,
    });
    expect(v.verdict).toBe('unknown');
  });

  it('jobs incompleti (total_count ≠ jobs) → keep', () => {
    const v = classifyRunForResolve(run(1, 'cancelled', t(1), 'a'), {
      jobsData: { total_count: 3, jobs: [] }, readAnnotations: () => CONCURRENCY_ANNOTATIONS,
    });
    expect(v.verdict).toBe('unknown');
  });

  it('un host-kill fra le ultime tre → keep', () => {
    const killed = {
      total_count: 1,
      jobs: [{
        name: 'e2e', status: 'completed', conclusion: 'failure', completed_at: t(1),
        steps: [{ number: 5, name: 'Build', status: 'in_progress' }],
      }],
    };
    expect(classifyRunForResolve(run(1, 'failure', t(1), 'a'), {
      jobsData: killed, readAnnotations: () => null, nowMs: Date.parse(t(10)),
    }).verdict).toBe('host-kill');
  });

  it('`skipped` non conta; le run di `main` e di un altro evento non sono della popolazione', () => {
    const runs = [
      run(9, 'skipped', t(9), 'a'),
      run(8, 'cancelled', t(8), 'main'), // titolo del reconciler, non questo
      run(7, 'cancelled', t(7), 'b', 'push'), // altro evento, altro titolo
      run(3, 'success', t(3), 'c'), run(2, 'success', t(2), 'd'), run(1, 'success', t(1), 'e'),
    ];
    const timeoutsEverywhere = () => TIMEOUT_ANNOTATIONS;
    const d = decide(runs, timeoutsEverywhere);
    expect(d.action).toBe('close');
    expect(d.ignored).toBe(1);
  });

  it('le run create prima dell\'apertura non contano', () => {
    const runs = [run(3, 'success', t(-1), 'a'), run(2, 'success', t(-2), 'b'), run(1, 'success', t(1), 'c')];
    expect(decide(runs).action).toBe('keep');
  });
});

describe('resolveScopedTimeoutIssues — il cablaggio con `gh`', () => {
  let logs: string[];
  let issues: Array<{
    number: number; title: string; labels: Array<{ name: string }>; createdAt: string; body: string;
    comments?: Array<{ body: string }>;
  }>;
  let runList: Run[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    execFileSync.mockReset();
    resolveGithubIssue.mockReset();
    commentOnGithubIssue.mockReset();
    issues = [];
    runList = asOf('2026-10-03T16:00:00Z');
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== 'gh') throw new Error(`unexpected ${cmd}`);
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify(issues.map(({ body: _body, comments: _comments, ...rest }) => rest));
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        const found = issues.find((i) => String(i.number) === args[2]);
        return JSON.stringify({ body: found?.body ?? '', comments: found?.comments ?? [] });
      }
      if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(runList);
      if (args[0] === 'api' && /actions\/runs\/(\d+)\/jobs/.test(args[1])) {
        const id = Number(/actions\/runs\/(\d+)\/jobs/.exec(args[1])![1]);
        const r = HISTORY_10809.find((x) => x.databaseId === id)!;
        return JSON.stringify(jobsFor(r));
      }
      if (args[0] === 'api' && String(args[1]).endsWith('/annotations')) {
        return JSON.stringify([CONCURRENCY_ANNOTATIONS]);
      }
      throw new Error(`gh non instradato: ${args.join(' ')}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('dry-run senza issue della famiglia: «0 issue della famiglia», nessuna scrittura', async () => {
    issues = [
      { number: 1, title: 'CI Failure (deploy): Publish to GitHub Pages (deploy + validate)', labels: [], createdAt: OPENED_10809, body: BODY_10809 },
    ];
    await resolveScopedTimeoutIssues({ dryRun: true });
    expect(logs.join('\n')).toContain('0 issue della famiglia');
    // La issue di deploy non viene nemmeno aperta in lettura.
    expect(execFileSync.mock.calls.some(([, a]) => a[0] === 'issue' && a[1] === 'view')).toBe(false);
    expect(commentOnGithubIssue).not.toHaveBeenCalled();
    expect(resolveGithubIssue).not.toHaveBeenCalled();
  });

  it('la 10809 al 03-10: commento con le run, poi chiusura a titolo esatto', async () => {
    issues = [{ number: 10809, title: TITLE_10809, labels: [{ name: 'ci-timeout' }], createdAt: OPENED_10809, body: BODY_10809 }];
    commentOnGithubIssue.mockReturnValue(true);
    resolveGithubIssue.mockReturnValue({ number: 10809, persisted: true });
    await resolveScopedTimeoutIssues({ dryRun: false });
    expect(commentOnGithubIssue).toHaveBeenCalledTimes(1);
    expect(commentOnGithubIssue.mock.calls[0][0]).toBe(10809);
    expect(commentOnGithubIssue.mock.calls[0][1]).toContain(RUN_URL(37133614819));
    expect(resolveGithubIssue).toHaveBeenCalledWith(TITLE_10809, expect.objectContaining({
      exactTitle: true,
      issueNumber: 10809,
      workflow: WF,
    }));
    // Il listing delle run è quello della popolazione: stesso workflow, stesso evento.
    const listCall = execFileSync.mock.calls.find(([, a]) => a[0] === 'run' && a[1] === 'list')![1];
    expect(listCall).toEqual(expect.arrayContaining(['-w', WF, '-e', 'pull_request', '-s', 'completed']));
  });

  it('dry-run sulla 10809: stampa la decisione e non scrive', async () => {
    issues = [{ number: 10809, title: TITLE_10809, labels: [], createdAt: OPENED_10809, body: BODY_10809 }];
    await resolveScopedTimeoutIssues({ dryRun: true });
    expect(logs.join('\n')).toMatch(/#10809 .*→ close \(3 run senza timeout/);
    expect(commentOnGithubIssue).not.toHaveBeenCalled();
    expect(resolveGithubIssue).not.toHaveBeenCalled();
  });

  it('senza la firma dello scanner, o con keep-open / claim, non si tocca', async () => {
    issues = [
      { number: 1, title: TITLE_10809, labels: [], createdAt: OPENED_10809, body: 'timeout visto a mano' },
      { number: 2, title: `CI Failure (push): ${WF}`, labels: [{ name: 'keep-open' }], createdAt: OPENED_10809, body: BODY_10809 },
      { number: 3, title: `CI Failure (schedule): ${WF}`, labels: [{ name: 'agent:in-progress' }], createdAt: OPENED_10809, body: BODY_10809 },
      { number: 4, title: `CI Failure (workflow_run): ${WF}`, labels: [{ name: 'agent:no-age-out' }], createdAt: OPENED_10809, body: BODY_10809 },
    ];
    await resolveScopedTimeoutIssues({ dryRun: false });
    expect(logs.join('\n')).toContain('4 issue della famiglia');
    expect(execFileSync.mock.calls.some(([, a]) => a[0] === 'run' && a[1] === 'list')).toBe(false);
    expect(commentOnGithubIssue).not.toHaveBeenCalled();
    expect(resolveGithubIssue).not.toHaveBeenCalled();
  });

  it('due gemelle aperte con lo stesso titolo: nessun commento, nessuna chiusura', async () => {
    // `resolveGithubIssue` chiude per titolo la più recente: valutando la vecchia
    // chiuderebbe la nuova, che porta `keep-open` e non è mai stata esaminata.
    issues = [
      { number: 11000, title: TITLE_10809, labels: [{ name: 'keep-open' }], createdAt: '2026-10-02T08:00:00Z', body: 'aperta a mano' },
      { number: 10809, title: TITLE_10809, labels: [], createdAt: OPENED_10809, body: BODY_10809 },
    ];
    commentOnGithubIssue.mockReturnValue(true);
    resolveGithubIssue.mockReturnValue({ number: 11000, persisted: true });
    await resolveScopedTimeoutIssues({ dryRun: false });
    expect(logs.join('\n')).toMatch(/#10809 .*→ keep \(gemelle aperte: #11000, #10809\)/);
    expect(commentOnGithubIssue).not.toHaveBeenCalled();
    expect(resolveGithubIssue).not.toHaveBeenCalled();
  });

  it('una chiusura che conferma un numero diverso da quello valutato è un errore', async () => {
    issues = [{ number: 10809, title: TITLE_10809, labels: [], createdAt: OPENED_10809, body: BODY_10809 }];
    commentOnGithubIssue.mockReturnValue(true);
    resolveGithubIssue.mockReturnValue({ number: 11000, persisted: true });
    await expect(resolveScopedTimeoutIssues({ dryRun: false })).rejects.toThrow(/chiusa #11000 invece di #10809/);
  });

  it('evidenza già in coda dal tick precedente: non la ripete, ritenta solo la chiusura', async () => {
    issues = [{
      number: 10809, title: TITLE_10809, labels: [], createdAt: OPENED_10809, body: BODY_10809,
      comments: [{ body: '🔁 di nuovo' }, { body: `${RESOLVE_EVIDENCE_MARKER}\n✅ Timeout non più osservato` }],
    }];
    resolveGithubIssue.mockReturnValue({ number: 10809, persisted: true });
    await resolveScopedTimeoutIssues({ dryRun: false });
    expect(commentOnGithubIssue).not.toHaveBeenCalled();
    expect(resolveGithubIssue).toHaveBeenCalledTimes(1);
  });

  it('una ricorrenza dopo l\'evidenza precedente: l\'evidenza si riscrive', async () => {
    issues = [{
      number: 10809, title: TITLE_10809, labels: [], createdAt: OPENED_10809, body: BODY_10809,
      comments: [{ body: `${RESOLVE_EVIDENCE_MARKER}\nvecchia` }, { body: '🔁 di nuovo' }],
    }];
    commentOnGithubIssue.mockReturnValue(true);
    resolveGithubIssue.mockReturnValue({ number: 10809, persisted: true });
    await resolveScopedTimeoutIssues({ dryRun: false });
    expect(commentOnGithubIssue).toHaveBeenCalledTimes(1);
  });

  it('commento non scritto → niente chiusura, ed esce in errore', async () => {
    issues = [{ number: 10809, title: TITLE_10809, labels: [], createdAt: OPENED_10809, body: BODY_10809 }];
    commentOnGithubIssue.mockReturnValue(false);
    await expect(resolveScopedTimeoutIssues({ dryRun: false })).rejects.toThrow(/commento di evidenza/);
    expect(resolveGithubIssue).not.toHaveBeenCalled();
  });
});
