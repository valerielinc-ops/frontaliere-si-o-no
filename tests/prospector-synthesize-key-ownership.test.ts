import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '',
  prospectorDir: '',
  productionKeys: new Set<string>(),
  store: { version: 1, candidates: {}, rejectedTombstones: {} } as any,
}));

vi.mock('../scripts/lib/prospector/config.mjs', () => ({
  get ROOT() { return state.root; },
  get PROSPECTOR_DIR() { return state.prospectorDir; },
}));

vi.mock('../scripts/lib/prospector/coverage.mjs', () => ({
  loadCoverage: () => ({ keys: state.productionKeys }),
}));

vi.mock('../scripts/lib/prospector/candidate-store.mjs', () => ({
  loadCandidates: () => state.store,
  saveCandidates: vi.fn(),
  setStatus: vi.fn((store, key, status, patch = {}) => {
    Object.assign(store.candidates[key], patch, { status });
    return store.candidates[key];
  }),
  byStatus: (store, status) => Object.values(store.candidates).filter((candidate: any) => candidate.status === status),
  isSynthesisRetryDue: () => true,
  scheduleSynthesisRetry: () => null,
  statusCounts: () => ({}),
  resolveCandidateKey: (_store, key) => key,
  startLedgerPhase: vi.fn(),
  finishLedgerPhase: vi.fn(),
  recordCandidateAttempt: vi.fn(),
  requeueLegacyNoVacancyCandidates: () => [],
  requeueMiskeyedCandidate: (store, key) => {
    const candidate = store.candidates[key];
    if (!candidate) return null;
    candidate.status = 'traced';
    delete candidate.crawlerKey;
    return candidate;
  },
}));

vi.mock('../scripts/lib/prospector/synthesize.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/prospector/synthesize.mjs')>(),
  synthesizeSpec: vi.fn(async () => ({ spec: null, reason: 'fixture', vacancies: [] })),
}));

describe('prospect-synthesize crawler-key ownership', () => {
  const originalArgv = process.argv;
  const originalLog = console.log;

  beforeEach(() => {
    vi.resetModules();
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-key-ownership-root-'));
    state.prospectorDir = path.join(state.root, 'data', 'prospector');
    state.productionKeys = new Set();
    fs.mkdirSync(path.join(state.prospectorDir, 'crawlers'), { recursive: true });
    fs.writeFileSync(
      path.join(state.prospectorDir, 'crawlers', 'my.json'),
      JSON.stringify({ companyName: 'unselected employer' }),
    );
    state.store = {
      version: 1,
      candidates: {
        deferred: {
          key: 'deferred',
          status: 'traced',
          crawlerKey: 'my',
          tenantHost: 'my.jobalino.ch',
          name: 'Deferred Employer',
          domain: 'deferred.ch',
        },
        selected: {
          key: 'selected',
          status: 'promoted',
          crawlerKey: 'my',
          tenantHost: 'my.jobalino.ch',
          name: 'Selected Employer',
          domain: 'selected.ch',
        },
      },
      rejectedTombstones: {},
    };
    process.argv = ['node', 'scripts/prospect-synthesize.mjs', '--limit=1'];
    console.log = vi.fn();
  });

  afterEach(() => {
    process.argv = originalArgv;
    console.log = originalLog;
    vi.resetModules();
    fs.rmSync(state.root, { recursive: true, force: true });
  });

  it('keeps the old spec for an unselected live candidate at --limit=1', async () => {
    await import('../scripts/prospect-synthesize.mjs');

    expect(fs.existsSync(path.join(state.prospectorDir, 'crawlers', 'my.json'))).toBe(true);
    expect(state.store.candidates.deferred.crawlerKey).toBe('my');
    expect(state.store.candidates.selected.crawlerKey).toBeUndefined();
  });

  it('does not rekey a live candidate when its production spec is malformed', async () => {
    state.productionKeys = new Set(['my']);
    fs.writeFileSync(path.join(state.prospectorDir, 'crawlers', 'my.json'), '{');

    await import('../scripts/prospect-synthesize.mjs');

    expect(state.store.candidates.deferred.crawlerKey).toBe('my');
    expect(state.store.candidates.selected.crawlerKey).toBe('my');
    expect(fs.readFileSync(path.join(state.prospectorDir, 'crawlers', 'my.json'), 'utf8')).toBe('{');
  });
});
