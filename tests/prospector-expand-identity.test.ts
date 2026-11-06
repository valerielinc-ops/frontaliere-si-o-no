import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: { version: 1, updatedAt: null, candidates: {} as Record<string, any>, rejectedTombstones: {} },
  statusUpdates: [] as unknown[][],
  finishes: [] as unknown[][],
}));

vi.mock('../scripts/lib/prospector/platform-registry.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/prospector/platform-registry.mjs')>();
  return {
    ...actual,
    loadRegistry: () => ({
      version: 1,
      updatedAt: null,
      platforms: {
        'smartrecruiters.com': {
          domain: 'smartrecruiters.com',
          status: 'supported',
          tenantShape: 'shared',
          hostHits: { 'jobs.smartrecruiters.com': 2 },
          hostEmployers: { 'jobs.smartrecruiters.com': ['alpha.ch'] },
          hostEmployerUnknown: { 'jobs.smartrecruiters.com': true },
          pathHits: {},
          tenantCount: 0,
        },
      },
    }),
    saveRegistry: vi.fn(),
  };
});

vi.mock('../scripts/lib/prospector/candidate-store.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/prospector/candidate-store.mjs')>();
  return {
    ...actual,
    loadCandidates: () => state.store,
    saveCandidates: vi.fn(),
    setStatus: (...args: unknown[]) => {
      state.statusUpdates.push(args);
      return actual.setStatus(...args as Parameters<typeof actual.setStatus>);
    },
    finishLedgerPhase: (...args: unknown[]) => {
      state.finishes.push(args);
      return actual.finishLedgerPhase(...args as Parameters<typeof actual.finishLedgerPhase>);
    },
  };
});

vi.mock('../scripts/lib/prospector/tenant-enum.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/prospector/tenant-enum.mjs')>(),
  enumerateTenants: vi.fn(async () => ({
    discovered: [{ host: 'jobs.smartrecruiters.com' }],
    live: [{
      host: 'jobs.smartrecruiters.com',
      company: 'Jobs',
      url: 'https://jobs.smartrecruiters.com',
      vacancyCount: 2,
      signals: ['two live vacancies'],
    }],
    byMethod: {},
    outcome: 'complete',
    sourceOutcomes: {},
  })),
}));

vi.mock('../scripts/lib/prospector/coverage.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/prospector/coverage.mjs')>(),
  loadCoverage: () => ({}),
  isCovered: () => ({ covered: false }),
}));

describe('prospect-expand tenant identity', () => {
  const originalArgv = process.argv;
  const originalLog = console.log;

  beforeEach(() => {
    vi.resetModules();
    state.store = { version: 1, updatedAt: null, candidates: {}, rejectedTombstones: {} };
    state.statusUpdates = [];
    state.finishes = [];
    process.argv = ['node', 'scripts/prospect-expand.mjs', '--platform=smartrecruiters.com', '--dry-run'];
    console.log = vi.fn();
  });

  afterEach(() => {
    process.argv = originalArgv;
    console.log = originalLog;
  });

  it('skips status updates and filed counts for repeated tenants with no reliable identity', async () => {
    await import('../scripts/prospect-expand.mjs');
    vi.resetModules();
    await import('../scripts/prospect-expand.mjs');

    expect(Object.keys(state.store.candidates)).toHaveLength(0);
    expect(state.statusUpdates).toHaveLength(0);
    expect(state.finishes).toEqual([
      ['dry_run', { inputCount: 1, successCount: 0, retryCount: 0 }],
      ['dry_run', { inputCount: 1, successCount: 0, retryCount: 0 }],
    ]);
  });
});
