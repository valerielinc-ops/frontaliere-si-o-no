import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Una run fallita PRIMA della chiusura di una issue non la riapre (issue #9761).
 *
 * ## Il caso reale, rigiocato qui sotto con i suoi timestamp
 *
 * #9654 «CI Failure: Persist Job Stats History»:
 *   - run 35995267599 (schedule, main) iniziata 2026-09-24T11:49:18Z, fallita
 *     alle 12:15:15Z nello step `Commit and push stats history`;
 *   - la fix (PR #9699) ha chiuso la issue alle 17:59:52Z;
 *   - nessuna run del workflow dopo il merge;
 *   - alle 20:48:08Z `scan-unreported-failures.mjs` ha riaperto #9654 con
 *     «🔁 Reopened — ricorrenza» citando la STESSA run delle 11:49.
 *
 * La finestra di 24 h dello scanner rilegge a ogni passata anche le run di
 * stamattina; il ramo di riapertura di `createGithubIssue` non sapeva quando
 * fosse iniziato il guasto e trattava la storia già coperta dalla chiusura come
 * una ricorrenza. Il test che replica lo scanner end-to-end è ROSSO senza la
 * fix: prima di `occurredAt` la chiamata `gh issue reopen 9654` partiva.
 */

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

// Il modulo dello scanner legge GH_REPO una volta, all'import.
process.env.GH_REPO = 'o/r';
const { createGithubIssue, occurrencePredatesClose } = await import('../scripts/lib/github-issue-creator.mjs');
const { scanFailures, newestRunStart } = await import('../scripts/ci/scan-unreported-failures.mjs');

const WF_ID = '4242';
const WF_NAME = 'Persist Job Stats History';
const WF_PATH = '.github/workflows/persist-job-stats-history.yml';
const TITLE = `CI Failure: ${WF_NAME}`;

const CLOSED_AT = '2026-09-24T17:59:52Z';
const SCAN_AT = '2026-09-24T20:48:08Z';

const HISTORICAL_RUN = {
  id: '35995267599',
  event: 'schedule',
  head_branch: 'main',
  created_at: '2026-09-24T11:49:18Z',
  updated_at: '2026-09-24T12:15:15Z',
  html_url: 'https://github.com/o/r/actions/runs/35995267599',
};

const CLOSED_TWIN = {
  number: 9654,
  title: TITLE,
  url: 'https://github.com/o/r/issues/9654',
  closedAt: CLOSED_AT,
  state: 'CLOSED',
  stateReason: 'COMPLETED',
  labels: [{ name: 'automation' }, { name: 'ci-failure' }],
};

const JOBS = {
  total_count: 1,
  jobs: [{
    name: 'persist-stats',
    conclusion: 'failure',
    html_url: 'https://github.com/o/r/actions/runs/35995267599/job/107618568590',
    steps: [{ name: 'Commit and push stats history', conclusion: 'failure' }],
  }],
};

type Run = typeof HISTORICAL_RUN;

const tsv = (rows: string[][]) => rows.map((r) => r.join('\t')).join('\n');

function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((c) => c[0] === 'gh')
    .map((c) => c[1] as string[]);
}

const callsTo = (sub: string) => ghCalls().filter((a) => a[0] === 'issue' && a[1] === sub);

/** Instrada le letture di scanner e creator; le scritture rispondono ok. */
function mockGithub({ runs, closedTwins = [CLOSED_TWIN] }: { runs: Run[]; closedTwins?: unknown[] }) {
  execFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'list') {
      return args[3] === 'closed' ? JSON.stringify(closedTwins) : '[]';
    }
    if (args[0] === 'api') {
      const p = String(args[1]);
      if (p.includes('/actions/workflows?')) {
        return tsv([[WF_ID, WF_NAME, WF_PATH, 'active', '2026-01-01T00:00:00Z']]);
      }
      if (p.includes('/actions/runs?created=')) {
        return tsv(runs.map((r) => [
          r.id, WF_ID, r.event, r.head_branch, 'failure', r.created_at, r.updated_at, r.html_url, WF_PATH,
        ]));
      }
      if (p.includes(`/actions/workflows/${WF_ID}/runs`)) {
        // Solo le run rosse: nessuna run del workflow dopo il merge della fix.
        return tsv(runs.map((r) => [r.id, 'completed', 'failure', r.created_at, r.event, r.head_branch]));
      }
      if (/\/actions\/runs\/\d+\/jobs/.test(p)) return JSON.stringify(JOBS);
      return '';
    }
    if (args[0] === 'issue' && ['reopen', 'comment', 'create', 'edit'].includes(args[1])) {
      return 'https://github.com/o/r/issues/9654';
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

describe('occurrencePredatesClose — il predicato', () => {
  it('la run delle 11:49 precede la chiusura delle 17:59', () => {
    expect(occurrencePredatesClose(HISTORICAL_RUN.created_at, CLOSED_AT)).toBe(true);
  });

  it('una run iniziata dopo la chiusura è una ricorrenza', () => {
    expect(occurrencePredatesClose('2026-09-24T18:30:00Z', CLOSED_AT)).toBe(false);
  });

  it('lo stesso istante non è «prima»: in dubbio si riapre', () => {
    expect(occurrencePredatesClose(CLOSED_AT, CLOSED_AT)).toBe(false);
  });

  it('fail-closed: un timestamp assente o illeggibile non prova niente', () => {
    for (const bad of [null, undefined, '', 'not-a-date']) {
      expect(occurrencePredatesClose(bad, CLOSED_AT)).toBe(false);
      expect(occurrencePredatesClose(HISTORICAL_RUN.created_at, bad)).toBe(false);
    }
  });
});

describe('createGithubIssue — ramo di riapertura con occurredAt', () => {
  it('occorrenza anteriore alla chiusura: niente reopen, niente commento, niente issue nuova', async () => {
    mockGithub({ runs: [HISTORICAL_RUN] });

    const res = await createGithubIssue({
      title: TITLE,
      description: 'misura',
      priority: 2,
      occurredAt: HISTORICAL_RUN.created_at,
    } as any);

    expect(callsTo('reopen')).toHaveLength(0);
    expect(callsTo('comment')).toHaveLength(0);
    expect(callsTo('create')).toHaveLength(0);
    expect(res).toMatchObject({ number: 9654, state: 'CLOSED', predatesClose: true, persisted: true });
  });

  it('occorrenza posteriore alla chiusura: riapre come prima', async () => {
    mockGithub({ runs: [HISTORICAL_RUN] });

    const res = await createGithubIssue({
      title: TITLE,
      description: 'misura',
      priority: 2,
      occurredAt: '2026-09-24T19:10:00Z',
    } as any);

    expect(callsTo('reopen').map((a) => a[2])).toEqual(['9654']);
    expect((res as any)?.reopened).toBe(true);
  });

  it('senza occurredAt, o con uno illeggibile, il comportamento resta quello di prima', async () => {
    for (const occurredAt of [undefined, 'not-a-date']) {
      execFileSync.mockReset();
      mockGithub({ runs: [HISTORICAL_RUN] });
      await createGithubIssue({ title: TITLE, description: 'misura', priority: 2, occurredAt } as any);
      expect(callsTo('reopen').map((a) => a[2])).toEqual(['9654']);
    }
  });
});

describe('scan-unreported-failures — replay di #9654 (20:48Z del 2026-09-24)', () => {
  it('la run storica delle 11:49 non riapre la issue chiusa alle 17:59', async () => {
    mockGithub({ runs: [HISTORICAL_RUN] });

    const code = await scanFailures();

    expect(callsTo('reopen')).toHaveLength(0);
    expect(callsTo('comment')).toHaveLength(0);
    expect(callsTo('create')).toHaveLength(0);
    // Un salto corretto non è una consegna fallita: la passata resta verde.
    expect(code).toBe(0);
  });

  it('una run rossa iniziata DOPO la chiusura riapre, come oggi', async () => {
    const recurrence = {
      ...HISTORICAL_RUN,
      id: '36000000001',
      created_at: '2026-09-24T19:49:18Z',
      updated_at: '2026-09-24T20:15:15Z',
      html_url: 'https://github.com/o/r/actions/runs/36000000001',
    };
    mockGithub({ runs: [HISTORICAL_RUN, recurrence] });

    const code = await scanFailures();

    expect(callsTo('reopen').map((a) => a[2])).toEqual(['9654']);
    expect(code).toBe(0);
  });

  it('una run lunga iniziata prima della chiusura non nasconde una ricorrenza finita prima di lei', async () => {
    // La run scelta per il corpo è quella AGGIORNATA per ultima; decide invece
    // l'inizio più recente della finestra.
    const longRun = {
      ...HISTORICAL_RUN,
      id: '36000000002',
      created_at: '2026-09-24T17:30:00Z',
      updated_at: '2026-09-24T20:30:00Z',
      html_url: 'https://github.com/o/r/actions/runs/36000000002',
    };
    const shortRecurrence = {
      ...HISTORICAL_RUN,
      id: '36000000003',
      created_at: '2026-09-24T19:00:00Z',
      updated_at: '2026-09-24T19:10:00Z',
      html_url: 'https://github.com/o/r/actions/runs/36000000003',
    };
    mockGithub({ runs: [longRun, shortRecurrence] });

    await scanFailures();

    expect(callsTo('reopen').map((a) => a[2])).toEqual(['9654']);
  });
});

describe('newestRunStart — quale inizio decide', () => {
  it('prende l\'inizio più recente, non l\'ordine del listing', () => {
    expect(newestRunStart([
      { created_at: '2026-09-24T19:00:00Z' },
      { created_at: '2026-09-24T11:49:18Z' },
    ])).toBe('2026-09-24T19:00:00Z');
  });

  it('fail-closed: un solo inizio illeggibile rende null (il creator riapre come prima)', () => {
    expect(newestRunStart([{ created_at: '2026-09-24T11:49:18Z' }, { created_at: null }])).toBeNull();
    expect(newestRunStart([])).toBeNull();
    expect(newestRunStart(undefined)).toBeNull();
  });
});
