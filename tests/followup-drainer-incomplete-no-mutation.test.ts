import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const REPO = 'o/r';
let invalidTimestampFixture = false;
const queuedIssue = (number: number) => ({
  number,
  title: `queued ${number}`,
  body: 'body',
  labels: [{ name: 'agent:fix-queued' }],
  created_at: '2026-09-01T00:00:00Z',
  updated_at: invalidTimestampFixture ? 'garbage-date' : '2026-09-01T00:00:00Z',
});

beforeEach(() => {
  vi.resetModules();
  invalidTimestampFixture = false;
  process.env.GITHUB_REPOSITORY = REPO;
  delete process.env.FOLLOWUP_DECOMPOSE_ENABLED;
  execFileSync.mockReset();
  execFileSync.mockImplementation((_command: string, args: string[]) => {
    const argv = args || [];
    if (argv[0] === 'run' && argv[1] === 'list') return '[]';
    if (argv[0] === 'api' && typeof argv[1] === 'string') {
      const endpoint = argv[1];
      if (endpoint.includes('/issues?state=open')
        && endpoint.includes('labels=agent%3Afix-queued')) {
        const page = /[?&]page=(\d+)/.exec(endpoint)?.[1];
        if (page === '1') return JSON.stringify(Array.from({ length: 100 }, (_, i) => queuedIssue(i + 1)));
        throw new Error('second queue page unavailable');
      }
      if (endpoint.includes('/issues?state=open')) return '[]';
    }
    if (argv[0] === 'issue' && argv[1] === 'view') return JSON.stringify({ comments: [] });
    return '[]';
  });
});

afterEach(() => {
  delete process.env.GITHUB_REPOSITORY;
  vi.restoreAllMocks();
});

describe('snapshot incompleta: nessuna mutazione dello stage dipendente', () => {
  it('non promuove né modifica label quando la coda supera la prima pagina ma la seconda fallisce', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    try {
      const drainer = await import('../scripts/ci/followup-drainer.mjs');
      drainer.runDrain();
    } finally {
      log.mockRestore();
    }

    const calls = execFileSync.mock.calls.map(([, args]) => args as string[]);
    expect(lines.some((line) => line.includes('quota-scan incompleta'))).toBe(true);
    expect(calls.some((args) => args[0] === 'issue' && ['edit', 'comment', 'close'].includes(args[1]))).toBe(false);
    expect(calls.some((args) => args[0] === 'api' && args.includes('--method')
      && ['POST', 'PATCH', 'DELETE'].includes(args[args.indexOf('--method') + 1]))).toBe(false);
  });

  it('non muta quando una issue ha timestamp aggiornato illeggibile', async () => {
    invalidTimestampFixture = true;
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    try {
      const drainer = await import('../scripts/ci/followup-drainer.mjs');
      drainer.runDrain();
    } finally {
      log.mockRestore();
    }

    const calls = execFileSync.mock.calls.map(([, args]) => args as string[]);
    expect(lines.some((line) => line.includes('snapshot incompleta (malformed'))).toBe(true);
    expect(calls.some((args) => args[0] === 'issue' && ['edit', 'comment', 'close'].includes(args[1]))).toBe(false);
  });
});
