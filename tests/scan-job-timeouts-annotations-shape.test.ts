import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// L'OSSERVATORE del gemello portato dal corpus (issue #6369, `corpus-ahead`).
//
// `findTimeoutAnnotation` leggeva le annotazioni del check-run con
// `ghJson(...) || []`. Quel `|| []` copre solo i due casi in cui `ghJson` torna
// `null` (gh fallito, JSON malformato) — NON il caso in cui l'endpoint risponde
// 200 con un OGGETTO (`{ message: 'Not Found' }`), su cui `.find` non esiste.
// Il risultato non era una singola annotazione persa: era un TypeError che
// uccideva la passata in mezzo al lavoro, quindi ogni altro job realmente in
// timeout dello stesso giro non veniva mai riportato.
//
// `gh` è mockato e instradato per sotto-comando, stesso approccio di
// scan-job-timeouts-dedup.test.ts.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((c) => c[0] === 'gh')
    .map((c) => c[1] as string[]);
}

const callsFor = (sub: string) => ghCalls().filter((a) => a[0] === 'issue' && a[1] === sub);

beforeEach(() => {
  execFileSync.mockReset();
  vi.resetModules();
  process.env.GH_REPO = 'o/r';
  delete process.env.ENABLE_FAILURE_REPORT;
});

afterEach(() => {
  delete process.env.GH_REPO;
});

describe('scan-job-timeouts — annotazioni non-array', () => {
  const RUN = {
    id: 31171006342,
    name: 'Lighthouse CI',
    html_url: 'https://github.com/o/r/actions/runs/31171006342',
    event: 'push',
    head_branch: 'main',
    created_at: new Date().toISOString(),
  };
  const JOBS = [
    { name: 'lighthouse-probe', conclusion: 'cancelled', check_run_url: 'https://api.github.com/repos/o/r/check-runs/1' },
    { name: 'lighthouse', conclusion: 'cancelled', check_run_url: 'https://api.github.com/repos/o/r/check-runs/2' },
  ];
  const ANNOTATIONS = [
    { message: 'The job running on runner ubuntu-latest has exceeded the maximum execution time of 45 minutes.' },
  ];

  const mockGh = () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const path = args[1];
        if (path.includes('actions/runs?status=cancelled')) return JSON.stringify({ workflow_runs: [RUN] });
        if (path.includes(`actions/runs/${RUN.id}/jobs`)) return JSON.stringify({ jobs: JOBS });
        // Il primo check-run risponde con l'oggetto d'errore, non con la lista.
        if (path === 'https://api.github.com/repos/o/r/check-runs/1/annotations') {
          return JSON.stringify({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
        }
        if (path.endsWith('/annotations')) return JSON.stringify(ANNOTATIONS);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/6369';
      return '';
    });
  };

  it('non fa morire la passata: il job leggibile viene comunque riportato', async () => {
    mockGh();

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    // Il bug: qui usciva un TypeError (`annotations.find is not a function`).
    await expect(main()).resolves.not.toThrow();

    expect(callsFor('create')).toHaveLength(1);
    const created = callsFor('create')[0];
    const body = created[created.indexOf('--body') + 1];
    expect(body).toContain('lighthouse');
    expect(body).toContain('exceeded the maximum execution time');
  });

  it('una lettura non-array vale come «nessuna prova», non come timeout', async () => {
    mockGh();

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    const body = callsFor('create')[0][callsFor('create')[0].indexOf('--body') + 1];
    // `lighthouse-probe` è il job la cui lettura non è array: senza prova non
    // viene dichiarato in timeout. `lighthouse` sì, ed è un prefisso di
    // `lighthouse-probe`, quindi il controllo va fatto sul nome intero.
    expect(body).not.toContain('lighthouse-probe');
  });
});
