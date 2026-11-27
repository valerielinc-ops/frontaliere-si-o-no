import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Incidente 2026-11-27: un ramo di PR chiusa senza merge (`fix/issue-…`) ha pushato
// `${{ runner.temp }}` nell'`env:` di job di 25 workflow `workflow_call`-only → startup
// failure; lo scanner ha aperto 25 issue «CI Failure (push): …» che nessuno poteva
// correggere e che il resolver non poteva chiudere (zero run è lo stato sano).
// Qui: (B) filtro dei rami di PR, (C) chiusura senza run pulite, (D) una issue per causa.
// Tutti i dati sono inventati. `gh` è finto e instradato per sotto-comando.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = {
    execFileSync: (cmd: string, args: string[], ...rest: unknown[]) => {
      if (cmd === 'gh' && args[0] === 'api'
        && String(args[1]).includes('/runs?status=success&event=schedule')) {
        return JSON.stringify({ workflow_runs: [] });
      }
      return execFileSync(cmd, args, ...rest);
    },
  };
  return { ...mock, default: mock };
});
const resolveGithubIssueByNumber = vi.fn();
const commentOnGithubIssue = vi.fn();
vi.mock('../scripts/lib/github-issue-creator.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGithubIssueByNumber: (...a: unknown[]) => resolveGithubIssueByNumber(...a),
    commentOnGithubIssue: (...a: unknown[]) => commentOnGithubIssue(...a),
  };
});

const ghCalls = () => execFileSync.mock.calls.filter((c) => c[0] === 'gh').map((c) => c[1] as string[]);
const callsFor = (sub: string) => ghCalls().filter((a) => a[0] === 'issue' && a[1] === sub);
const titleOf = (args: string[]) => args[args.indexOf('--title') + 1];

beforeEach(() => {
  execFileSync.mockReset();
  resolveGithubIssueByNumber.mockReset();
  commentOnGithubIssue.mockReset();
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.GH_REPO = 'o/r';
  delete process.env.ENABLE_FAILURE_REPORT;
});
afterEach(() => {
  delete process.env.GH_REPO;
  vi.restoreAllMocks();
});

const SHA = '0123456789abcdef0123456789abcdef01234567';
const startupRun = (n: number, over: Record<string, unknown> = {}) => ({
  id: 9000 + n,
  workflow_id: 500 + n,
  name: `Crawler Group ${String(n).padStart(2, '0')} logic`,
  html_url: `https://github.com/o/r/actions/runs/${9000 + n}`,
  event: 'push',
  head_branch: 'fix/issue-1',
  head_sha: SHA,
  conclusion: 'startup_failure',
  created_at: new Date().toISOString(),
  ...over,
});

type PrState = 'open' | 'closed' | 'unreadable' | 'none';
function installGh({ runs, pr = 'none', branchExists = false }: {
  runs: Array<Record<string, unknown>>; pr?: PrState; branchExists?: boolean;
}) {
  execFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'api') {
      const path = String(args[1]);
      if (path.includes('actions/runs?status=startup_failure')) {
        return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
      }
      if (path.includes('actions/runs?status=')) return JSON.stringify({ total_count: 0, workflow_runs: [] });
      const wf = /actions\/workflows\/(\d+)/.exec(path);
      if (wf) {
        const r = runs.find((x) => String(x.workflow_id) === wf[1])!;
        return JSON.stringify({ name: r.name });
      }
      if (/actions\/runs\/\d+\/jobs/.test(path)) return JSON.stringify({ total_count: 0, jobs: [] });
      if (path.includes('/pulls?head=')) {
        if (pr === 'unreadable') throw new Error('HTTP 502');
        if (pr === 'none') return '[]';
        return JSON.stringify([{ number: 77, state: pr }]);
      }
      if (path.includes('/git/matching-refs/heads/')) {
        return JSON.stringify(branchExists ? [{ ref: 'refs/heads/fix/issue-1' }] : []);
      }
      if (path.includes('/git/matching-refs/tags/')) return '[]';
      return '{}';
    }
    if (args[0] === 'issue' && args[1] === 'list') return '[]';
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/7001';
    return '';
  });
}

describe('(B) startup failure su un ramo di PR — nessuna issue', () => {
  it('PR chiusa senza merge → nessuna emit', async () => {
    installGh({ runs: [startupRun(1), startupRun(2)], pr: 'closed' });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    expect(callsFor('create')).toHaveLength(0);
    expect(callsFor('comment')).toHaveLength(0);
  });

  it('ramo eliminato e nessuna PR → nessuna emit', async () => {
    installGh({ runs: [startupRun(1)], pr: 'none', branchExists: false });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    expect(callsFor('create')).toHaveLength(0);
  });

  it('PR aperta → nessuna emit (il segnale è del check di PR)', async () => {
    installGh({ runs: [startupRun(1)], pr: 'open' });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    expect(callsFor('create')).toHaveLength(0);
  });

  it('lettura della PR fallita → fail-closed: issue come oggi', async () => {
    installGh({ runs: [startupRun(1)], pr: 'unreadable' });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    expect(callsFor('create')).toHaveLength(1);
    expect(titleOf(callsFor('create')[0])).toBe('CI Failure (push): Crawler Group 01 logic');
  });

  it('ramo esistente senza PR (es. workflow_dispatch) → issue come oggi', async () => {
    installGh({ runs: [startupRun(1, { event: 'workflow_dispatch' })], pr: 'none', branchExists: true });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    expect(callsFor('create')).toHaveLength(1);
  });

  it('startup failure su main → issue come oggi, senza leggere PR', async () => {
    installGh({ runs: [startupRun(1, { head_branch: 'main' })] });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    expect(callsFor('create')).toHaveLength(1);
    expect(titleOf(callsFor('create')[0])).toBe('CI Failure: Crawler Group 01 logic');
    expect(ghCalls().some((a) => a[0] === 'api' && String(a[1]).includes('/pulls?head='))).toBe(false);
  });
});

describe('(D) stesso commit → una sola issue con l\'elenco dei workflow', () => {
  it('25 workflow sullo stesso head_sha su main → 1 issue', async () => {
    const runs = Array.from({ length: 25 }, (_, i) => startupRun(i + 1, { head_branch: 'main' }));
    installGh({ runs });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    const created = callsFor('create');
    expect(created).toHaveLength(1);
    // il titolo resta quello per-workflow (contratto di --resolve), intestato al primo per nome
    expect(titleOf(created[0])).toBe('CI Failure: Crawler Group 01 logic');
    const flat = JSON.stringify(created[0]);
    expect(flat).toContain('25 workflow in startup failure');
    expect(flat).toContain('Crawler Group 25 logic');
  });

  it('commit diversi non si fondono', async () => {
    installGh({ runs: [
      startupRun(1, { head_branch: 'main' }),
      startupRun(2, { head_branch: 'main', head_sha: 'f'.repeat(40) }),
    ] });
    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    expect(callsFor('create')).toHaveLength(2);
  });
});

describe('decideOffMainReport e workflowDeclaresEvent — puri', () => {
  it('stati del ramo', async () => {
    const { decideOffMainReport } = await import('../scripts/ci/scan-job-timeouts.mjs');
    expect(decideOffMainReport({ headBranch: 'main' }).report).toBe(true);
    expect(decideOffMainReport({ headBranch: 'x', pulls: null }).report).toBe(true);
    expect(decideOffMainReport({ headBranch: 'x', pulls: [{ number: 1, state: 'closed' }] })).toMatchObject({ report: false, state: 'closed' });
    expect(decideOffMainReport({ headBranch: 'x', pulls: [{ number: 1, state: 'closed' }, { number: 2, state: 'open' }] })).toMatchObject({ report: false, state: 'open' });
    expect(decideOffMainReport({ headBranch: 'x', pulls: [], refs: null }).report).toBe(true);
    expect(decideOffMainReport({ headBranch: 'x', pulls: [], refs: [] })).toMatchObject({ report: false, state: 'gone' });
    expect(decideOffMainReport({ headBranch: 'x', pulls: [], refs: [{ ref: 'refs/heads/x' }] }).report).toBe(true);
  });

  it('legge `on:` nelle forme canoniche, null nel dubbio', async () => {
    const { workflowDeclaresEvent: d } = await import('../scripts/ci/scan-job-timeouts.mjs');
    expect(d('name: x\non: workflow_call\njobs: {}\n', 'push')).toBe(false);
    expect(d('name: x\non:\n  workflow_call:\n    inputs:\n      a:\n        type: string\njobs: {}\n', 'push')).toBe(false);
    expect(d('on:\n  push:\n    branches: [main]\n  workflow_call:\n', 'push')).toBe(true);
    expect(d('on: [push, pull_request]\n', 'push')).toBe(true);
    expect(d('on:\n  - workflow_call\n', 'push')).toBe(false);
    expect(d('"on":\n  workflow_call: # solo riuso\n', 'push')).toBe(false);
    expect(d('on: { push: {} }\n', 'push')).toBeNull();
    expect(d('name: senza trigger\n', 'push')).toBeNull();
  });
});

describe('(C) decideScopedTimeoutResolution — workflow senza l\'evento su main', () => {
  const TITLE = 'CI Failure (push): Crawler Group 01 logic';
  const settle = (over: Record<string, unknown> = {}) => () => ({
    declaresEvent: false,
    originRuns: [
      { databaseId: 1, url: 'https://github.com/o/r/actions/runs/1', headBranch: 'fix/issue-1', settled: 'closed' },
      { databaseId: 2, url: 'https://github.com/o/r/actions/runs/2', headBranch: 'fix/issue-1', settled: 'gone' },
    ],
    ...over,
  });
  const base = { title: TITLE, issueCreatedAt: '2026-11-27T00:00:00Z', runs: [], classify: () => ({ verdict: 'clean' }) };

  it('zero run dopo l\'apertura, PR chiusa, evento non dichiarato → close', async () => {
    const { decideScopedTimeoutResolution, resolveEvidenceComment } = await import('../scripts/ci/scan-job-timeouts.mjs');
    const d = decideScopedTimeoutResolution({ ...base, readSettlement: settle() });
    expect(d.action).toBe('close');
    expect(d.kind).toBe('branch-settled');
    const comment = resolveEvidenceComment({ event: 'push', workflow: 'Crawler Group 01 logic', decision: d });
    expect(comment).toContain('scan-job-timeouts:resolve');
    expect(comment).toContain('actions/runs/1');
    expect(comment).toContain('ramo eliminato');
  });

  it('senza readSettlement il comportamento resta quello di prima (keep)', async () => {
    const { decideScopedTimeoutResolution } = await import('../scripts/ci/scan-job-timeouts.mjs');
    expect(decideScopedTimeoutResolution(base).action).toBe('keep');
  });

  it.each([
    ['PR ancora aperta', settle({ originRuns: [{ databaseId: 1, headBranch: 'x', settled: null }] })],
    ['evento dichiarato su main', settle({ declaresEvent: true })],
    ['file illeggibile', settle({ declaresEvent: null })],
    ['nessuna run d\'origine', settle({ originRuns: [] })],
    ['lettura che lancia', () => { throw new Error('boom'); }],
  ])('%s → keep', async (_n, readSettlement) => {
    const { decideScopedTimeoutResolution } = await import('../scripts/ci/scan-job-timeouts.mjs');
    expect(decideScopedTimeoutResolution({ ...base, readSettlement }).action).toBe('keep');
  });

  it('una run morta dopo l\'apertura tiene aperta anche con rami chiusi', async () => {
    const { decideScopedTimeoutResolution } = await import('../scripts/ci/scan-job-timeouts.mjs');
    const d = decideScopedTimeoutResolution({
      ...base,
      runs: [{ databaseId: 5, conclusion: 'cancelled', status: 'completed', createdAt: '2026-11-27T05:00:00Z', headBranch: 'y', event: 'push' }],
      classify: () => ({ verdict: 'timeout', detail: 'job' }),
      readSettlement: settle(),
    });
    expect(d.action).toBe('keep');
  });
});

describe('(C) resolveScopedTimeoutIssues — cablaggio con gh', () => {
  const BODY = [
    '## Workflow failure prima della creazione dei job',
    '**Run:** https://github.com/o/r/actions/runs/9001',
    'Rilevato da `scripts/ci/scan-job-timeouts.mjs` (scan periodico esterno ai job).',
  ].join('\n');

  function install(workflowText: string, pr: 'closed' | 'open') {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([{ number: 20294, title: 'CI Failure (push): Crawler Group 01 logic', labels: [], createdAt: '2026-11-27T00:00:00Z' }]);
      }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ body: BODY, comments: [] });
      if (args[0] === 'run' && args[1] === 'list') return '[]';
      if (args[0] === 'api') {
        const path = String(args[args.length - 1]);
        if (path.endsWith('actions/runs/9001')) {
          return JSON.stringify({
            id: 9001, event: 'push', head_branch: 'fix/issue-1', html_url: 'https://github.com/o/r/actions/runs/9001',
            path: '.github/workflows/crawler-group-01-logic.yml',
          });
        }
        if (path.includes('/pulls?head=')) return JSON.stringify([{ number: 77, state: pr }]);
        if (path.includes('/contents/.github/workflows/crawler-group-01-logic.yml?ref=main')) return workflowText;
      }
      throw new Error(`gh non instradato: ${args.join(' ')}`);
    });
  }

  it('workflow_call-only + PR chiusa → commento di evidenza e chiusura del numero', async () => {
    install('name: Crawler Group 01 logic\non:\n  workflow_call:\njobs: {}\n', 'closed');
    commentOnGithubIssue.mockReturnValue(true);
    resolveGithubIssueByNumber.mockReturnValue({ number: 20294, persisted: true });
    const { resolveScopedTimeoutIssues } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await resolveScopedTimeoutIssues({ dryRun: false });
    expect(commentOnGithubIssue).toHaveBeenCalledTimes(1);
    expect(commentOnGithubIssue.mock.calls[0][1]).toContain('actions/runs/9001');
    expect(resolveGithubIssueByNumber).toHaveBeenCalledWith(20294, expect.objectContaining({
      expectedTitle: 'CI Failure (push): Crawler Group 01 logic',
      runUrl: 'https://github.com/o/r/actions/runs/9001',
    }));
  });

  it('PR aperta → resta aperta', async () => {
    install('on: workflow_call\n', 'open');
    const { resolveScopedTimeoutIssues } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await resolveScopedTimeoutIssues({ dryRun: false });
    expect(resolveGithubIssueByNumber).not.toHaveBeenCalled();
  });

  it('il workflow dichiara push su main → resta aperta', async () => {
    install('on:\n  push:\n  workflow_call:\n', 'closed');
    const { resolveScopedTimeoutIssues } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await resolveScopedTimeoutIssues({ dryRun: false });
    expect(resolveGithubIssueByNumber).not.toHaveBeenCalled();
  });
});
