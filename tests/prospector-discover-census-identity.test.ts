import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  registry: { version: 1, updatedAt: null, platforms: {} as Record<string, any> },
  store: { version: 1, updatedAt: null, candidates: {}, rejectedTombstones: {} },
  census: null as null | Record<string, any>,
}));

vi.mock('../scripts/lib/prospector/coverage.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/prospector/coverage.mjs')>(),
  loadCoverage: () => ({ crawlerCount: 0, names: new Set(), domains: new Set() }),
  isCovered: () => ({ covered: false }),
}));

vi.mock('../scripts/lib/prospector/candidate-store.mjs', () => ({
  loadCandidates: () => state.store,
  saveCandidates: vi.fn(),
  upsertCandidate: vi.fn(),
  candidateKey: vi.fn(() => 'unused'),
  reconcileCandidateDuplicates: vi.fn(() => ({ merged: 0, groupsChecked: 0 })),
  reviveRetryableDeadCandidate: vi.fn(),
  statusCounts: vi.fn(() => ({})),
  pruneTerminal: vi.fn(() => 0),
  startLedgerPhase: vi.fn(),
  finishLedgerPhase: vi.fn(),
}));

vi.mock('../scripts/lib/prospector/platform-registry.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/prospector/platform-registry.mjs')>();
  return {
    ...actual,
    loadRegistry: () => state.registry,
    saveRegistry: vi.fn(),
  };
});

vi.mock('../scripts/lib/prospector/sources/known-crawlers.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/prospector/sources/known-crawlers.mjs')>();
  return {
    ...actual,
    censusFromOwnCrawls: (options?: Record<string, unknown>) => {
      state.census = actual.censusFromOwnCrawls(options);
      return state.census;
    },
    listingPathsFromAdapters: () => ({}),
  };
});

describe('prospect-discover own-crawl census identity', () => {
  const originalArgv = process.argv;
  const originalDataRoot = process.env.PROSPECTOR_DATA_ROOT;
  const originalLog = console.log;
  let dataRoot = '';

  beforeEach(() => {
    vi.resetModules();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-discover-own-census-'));
    process.env.PROSPECTOR_DATA_ROOT = dataRoot;
    fs.writeFileSync(path.join(dataRoot, 'jobs.json'), JSON.stringify([
      { url: 'https://api.easytemp.ch/jobs/1', company: 'owner-shaped.example' },
      { url: 'https://api.easytemp.ch/jobs/2', company: 'Beta AG', companyDomain: 'beta.ch' },
    ]));
    state.registry = { version: 1, updatedAt: null, platforms: {} };
    state.store = { version: 1, updatedAt: null, candidates: {}, rejectedTombstones: {} };
    state.census = null;
    process.argv = ['node', 'scripts/prospect-discover.mjs', '--sources=own', '--dry-run'];
    console.log = vi.fn();
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalDataRoot === undefined) delete process.env.PROSPECTOR_DATA_ROOT;
    else process.env.PROSPECTOR_DATA_ROOT = originalDataRoot;
    console.log = originalLog;
    vi.resetModules();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('passes a domain-shaped company without companyDomain as an unknown owner', async () => {
    await import('../scripts/prospect-discover.mjs');

    const platformCensus = state.census?.platforms.find((entry: any) => entry.domain === 'easytemp.ch');
    expect(platformCensus?.employerHosts).toEqual([
      ['owner-shaped.example', 'api.easytemp.ch', '/jobs/1', undefined],
      ['Beta AG', 'api.easytemp.ch', '/jobs/2', 'beta.ch'],
    ]);
    expect(state.registry.platforms['easytemp.ch'].hostEmployerUnknown['api.easytemp.ch']).toBe(true);
    expect(state.registry.platforms['easytemp.ch'].hostEmployers['api.easytemp.ch']).toEqual(['beta.ch']);
    expect(state.registry.platforms['easytemp.ch'].hostEmployers['api.easytemp.ch'])
      .not.toContain('owner-shaped.example');
  });
});
