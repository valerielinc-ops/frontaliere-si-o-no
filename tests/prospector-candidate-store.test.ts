/**
 * Prospector candidate retention — rejected verdicts are durable tombstones,
 * while genuinely transient/dead candidates still age out of the queue.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadCandidates,
  MAX_REJECTED_TOMBSTONES,
  isSynthesisRetryDue,
  isTraceRetryDue,
  pruneTerminal,
  reopenRejectedCandidate,
  requeuePromotedCandidate,
  reviveRetryableDeadCandidate,
  scheduleTraceRetry,
  scheduleSynthesisRetry,
  saveCandidates,
  setStatus,
  upsertCandidate,
} from '../scripts/lib/prospector/candidate-store.mjs';

const DAY_MS = 86_400_000;
const OLD = new Date(Date.now() - 91 * DAY_MS).toISOString();

function storeWith(candidates: Record<string, any>, rejectedTombstones: Record<string, any> = {}) {
  return { version: 1, updatedAt: null, candidates, rejectedTombstones };
}

describe('prospector candidate store — rejected tombstones (#6903)', () => {
  it('bootstraps only when the candidate file is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-candidates-missing-'));
    try {
      expect(loadCandidates(path.join(dir, 'candidates.json'))).toMatchObject({
        candidates: {},
        rejectedTombstones: {},
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['invalid shape', '{"version":2}'],
  ])('refuses to turn %s into an empty store that could overwrite the queue', (_label, contents) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-candidates-invalid-'));
    const file = path.join(dir, 'candidates.json');
    try {
      fs.writeFileSync(file, contents, 'utf8');
      expect(() => loadCandidates(file)).toThrow(/Prospector candidate store/);
      expect(fs.readFileSync(file, 'utf8')).toBe(contents);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates non-missing filesystem errors instead of silently bootstrapping', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-candidates-io-'));
    try {
      expect(() => loadCandidates(dir)).toThrow(/Cannot read Prospector candidate store/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requeues only a promoted candidate after a retryable validation failure', () => {
    const key = 'source-location.example';
    const store = storeWith({
      [key]: { key, status: 'promoted', qualityScore: 0.98 },
    });

    expect(requeuePromotedCandidate(store, key, {
      reason: 'localita source-backed sotto soglia',
      qualityScore: 0.77,
    }, null)).toMatchObject({
      status: 'validated',
      qualityScore: 0.77,
      reason: 'localita source-backed sotto soglia',
    });
    expect(store.candidates[key].status).toBe('validated');
  });

  it('does not rewind a state other than promoted', () => {
    const key = 'production.example';
    const store = storeWith({ [key]: { key, status: 'production' } });
    expect(requeuePromotedCandidate(store, key, { reason: 'retry' }, null)).toBeNull();
    expect(store.candidates[key].status).toBe('production');
  });

  it('keeps transient domain-resolution failures retryable after the permanent-guess threshold', () => {
    const now = Date.now();
    const candidate = {
      key: 'example@lugano',
      traceAttempts: 4,
      reason: 'dominio temporaneamente non verificabile',
      traceRetryAt: new Date(now - 1).toISOString(),
    };

    expect(isTraceRetryDue(candidate, now)).toBe(true);
    expect(scheduleTraceRetry(candidate, candidate.reason, now)).toMatchObject({
      traceAttempts: 5,
      traceRetryable: true,
      traceRetryAt: new Date(now + 30 * DAY_MS).toISOString(),
    });
  });

  it('keeps the SECO legal name as source-backed identity across other source updates', () => {
    const store = storeWith({
      'example.ch': { key: 'example.ch', status: 'new', name: 'Example Careers' },
    });
    upsertCandidate(store, {
      key: 'example.ch', name: 'Example SA', secoEmployerName: 'Example SA', adCount: 2,
    }, 'seco');
    upsertCandidate(store, {
      key: 'example.ch', name: 'Example Group', secoEmployerName: 'Untrusted rewrite',
    }, 'osm');

    expect(store.candidates['example.ch']).toMatchObject({
      name: 'Example Careers',
      secoEmployerName: 'Example SA',
    });
  });

  it('compacts an old rejected record and blocks the same key after rediscovery', () => {
    const key = 'mpi-age.de.umantis.com';
    const store = storeWith({
      [key]: {
        key,
        status: 'rejected',
        country: 'DE',
        reason: 'source esplicitamente esclusa',
        validationHistory: [{ verdict: 'bad', score: 0.1 }],
        firstSeenAt: OLD,
        updatedAt: OLD,
        rejectedAt: OLD,
      },
    });

    expect(pruneTerminal(store, 90)).toBe(1);
    expect(store.candidates[key]).toBeUndefined();
    expect(store.rejectedTombstones[key]).toEqual({ rejectedAt: OLD });

    const rediscovered = upsertCandidate(
      store,
      { key, name: 'MPI AGE', country: 'DE' },
      'seco',
    );
    expect(rediscovered).toEqual({ key, created: false });
    expect(store.candidates[key]).toBeUndefined();
  });

  it('keeps dead retention separate: an old dead candidate may be rediscovered', () => {
    const key = 'temporary.example';
    const store = storeWith({
      [key]: { key, status: 'dead', firstSeenAt: OLD, updatedAt: OLD },
    });

    expect(pruneTerminal(store, 90)).toBe(1);
    expect(store.rejectedTombstones[key]).toBeUndefined();
    expect(upsertCandidate(store, { key, name: 'Temporary' }, 'seco')).toEqual({ key, created: true });
    expect(store.candidates[key].status).toBe('new');
  });

  it('records a tombstone as soon as a rejection is written and remains idempotent', () => {
    const key = 'wrong-source.example';
    const store = storeWith({
      [key]: { key, status: 'promoted', name: 'Wrong source' },
    });

    setStatus(store, key, 'rejected', {
      reason: 'la pagina appartiene a un altro datore',
      rejectedAt: OLD,
    }, null);
    const { updatedAt, rejectedAt } = store.candidates[key];

    expect(store.rejectedTombstones[key]).toEqual({ rejectedAt: OLD });
    expect(upsertCandidate(store, { key, name: 'Rediscovered name' }, 'osm')).toEqual({ key, created: false });
    expect(store.candidates[key].status).toBe('rejected');
    expect(store.candidates[key].name).toBe('Wrong source');
    expect(store.candidates[key].updatedAt).toBe(updatedAt);
    expect(store.candidates[key].rejectedAt).toBe(rejectedAt);
  });

  it('does not reopen a rejected verdict through an ordinary status transition', () => {
    const key = 'terminal.example';
    const store = storeWith({
      [key]: { key, status: 'rejected', rejectedAt: OLD, updatedAt: OLD, reason: 'terminal' },
    });
    const before = structuredClone(store.candidates[key]);

    expect(setStatus(store, key, 'new', { name: 'Recovered' }, null)).toEqual(before);
    expect(store.candidates[key]).toEqual(before);
    expect(store.rejectedTombstones[key]).toEqual({ rejectedAt: OLD });
  });

  it('reopens only after a new source-adapter validation and only once per version', () => {
    const key = 'rh-expert.ch';
    const store = storeWith({
      [key]: {
        key,
        status: 'rejected',
        rejectedAt: OLD,
        updatedAt: OLD,
        validationHistory: [{ verdict: 'bad', sourceAdapterVersion: null }],
      },
    }, { [key]: { rejectedAt: OLD } });

    expect(reopenRejectedCandidate(store, key, 'rh-expert-ch-dedicated-v1', null)).toBeNull();
    expect(store.rejectedTombstones[key]).toEqual({ rejectedAt: OLD });

    store.candidates[key].validationHistory.push({
      verdict: 'good',
      sourceAdapterVersion: 'rh-expert-ch-dedicated-v1',
    });
    expect(reopenRejectedCandidate(store, key, 'rh-expert-ch-dedicated-v1', null))
      .toMatchObject({ status: 'validated', reopenedSourceAdapterVersion: 'rh-expert-ch-dedicated-v1' });
    expect(store.rejectedTombstones[key]).toBeUndefined();
    expect(store.candidates[key].rejectedAt).toBeUndefined();

    setStatus(store, key, 'rejected', { validationHistory: store.candidates[key].validationHistory }, null);
    store.candidates[key].validationHistory.push({
      verdict: 'good',
      sourceAdapterVersion: 'rh-expert-ch-dedicated-v1',
    });
    expect(reopenRejectedCandidate(store, key, 'rh-expert-ch-dedicated-v1', null)).toBeNull();
    expect(store.rejectedTombstones[key]).toBeDefined();

    store.candidates[key].validationHistory.push({
      verdict: 'good',
      sourceAdapterVersion: 'rh-expert-ch-dedicated-v2',
    });
    expect(reopenRejectedCandidate(store, key, 'rh-expert-ch-dedicated-v2', null))
      .toMatchObject({ status: 'validated', reopenedSourceAdapterVersion: 'rh-expert-ch-dedicated-v2' });
  });

  it('persists legacy tombstones without carrying diagnostic payload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-candidate-store-'));
    const file = path.join(dir, 'candidates.json');
    const key = 'legacy.example';
    const store = storeWith({
      [key]: { key, status: 'rejected', firstSeenAt: OLD, updatedAt: OLD, reason: 'old' },
    });

    pruneTerminal(store, 90);
    saveCandidates(store, file);
    const loaded = loadCandidates(file);

    expect(loaded.rejectedTombstones[key]).toEqual({ rejectedAt: OLD });
    expect(JSON.stringify(loaded)).not.toContain('validationHistory');
    expect(upsertCandidate(loaded, { key, name: 'Legacy' }, 'seco')).toEqual({ key, created: false });
  });

  it('bounds the tombstone inventory deterministically by retaining the newest keys', () => {
    const store = storeWith({});
    for (let i = 0; i < MAX_REJECTED_TOMBSTONES + 2; i++) {
      const key = `rejected-${String(i).padStart(5, '0')}.example`;
      store.candidates[key] = { key, status: 'rejected', firstSeenAt: OLD, updatedAt: OLD };
      setStatus(store, key, 'rejected', {
        rejectedAt: new Date(Date.now() - (MAX_REJECTED_TOMBSTONES + 2 - i) * 1000).toISOString(),
      }, null);
    }

    expect(Object.keys(store.rejectedTombstones)).toHaveLength(MAX_REJECTED_TOMBSTONES);
    expect(store.rejectedTombstones['rejected-00000.example']).toBeUndefined();
    expect(store.rejectedTombstones[`rejected-${String(MAX_REJECTED_TOMBSTONES + 1).padStart(5, '0')}.example`]).toBeDefined();
  });
});

describe('prospector candidate source observations', () => {
  it('timestamps new and existing sources while only fresh SECO data replaces SECO signals', () => {
    const key = 'seco-employer.ch';
    const oldObservation = new Date(Date.now() - DAY_MS).toISOString();
    const store = storeWith({
      [key]: {
        key,
        name: 'SECO Employer',
        status: 'new',
        sources: ['seco'],
        sourceSeenAt: { seco: oldObservation },
        adCount: 2,
        sampleTitles: ['Old listing'],
        applyHosts: ['old.jobs-board.example'],
        reason: 'previous trace note',
        traceAttempts: 4,
      },
    });

    upsertCandidate(store, {
      key,
      adCount: 70,
      sampleTitles: ['OSM payload'],
      applyHosts: ['osm.jobs-board.example'],
      reason: 'must not replace trace note',
    }, 'osm');
    expect(store.candidates[key]).toMatchObject({
      status: 'new',
      adCount: 2,
      sampleTitles: ['Old listing'],
      applyHosts: ['old.jobs-board.example'],
      reason: 'previous trace note',
      traceAttempts: 4,
    });
    expect(Date.parse(store.candidates[key].sourceSeenAt.osm)).toBeGreaterThan(Date.parse(oldObservation));

    upsertCandidate(store, {
      key,
      adCount: 80,
      sampleTitles: ['Web payload'],
      applyHosts: ['web.jobs-board.example'],
    }, 'web');
    expect(store.candidates[key]).toMatchObject({
      adCount: 2,
      sampleTitles: ['Old listing'],
      applyHosts: ['old.jobs-board.example'],
    });
    expect(store.candidates[key].sourceSeenAt.web).toBeTruthy();

    upsertCandidate(store, {
      key,
      adCount: 5,
      sampleTitles: ['New listing A', 'New listing B'],
      applyHosts: ['apply.new-board.example'],
    }, 'seco');
    expect(store.candidates[key]).toMatchObject({
      adCount: 5,
      sampleTitles: ['New listing A', 'New listing B'],
      applyHosts: ['apply.new-board.example'],
      status: 'new',
      reason: 'previous trace note',
      traceAttempts: 4,
    });
    expect(Date.parse(store.candidates[key].sourceSeenAt.seco)).toBeGreaterThan(Date.parse(oldObservation));

    const createdKey = 'web-employer.ch';
    expect(upsertCandidate(store, {
      key: createdKey,
      name: 'Web Employer',
      adCount: 9,
      sampleTitles: ['Unverified web listing signal'],
      applyHosts: ['board.example'],
    }, 'web'))
      .toEqual({ key: createdKey, created: true });
    expect(store.candidates[createdKey].sourceSeenAt.web).toBeTruthy();
    expect(store.candidates[createdKey]).not.toHaveProperty('adCount');
    expect(store.candidates[createdKey]).not.toHaveProperty('sampleTitles');
    expect(store.candidates[createdKey]).not.toHaveProperty('applyHosts');
  });
});

describe('prospector candidate store — retryable trace failures', () => {
  it('schedules bounded retry metadata without changing a candidate out of new', () => {
    const candidate = { key: 'temporary.example', status: 'new', traceAttempts: 0 };
    const now = Date.now();
    const patch = scheduleTraceRetry(candidate, 'sito irraggiungibile', now);

    expect(patch).toMatchObject({
      reason: 'sito irraggiungibile',
      traceRetryable: true,
      traceAttempts: 1,
      traceLastAttemptAt: new Date(now).toISOString(),
      traceRetryAt: new Date(now + DAY_MS).toISOString(),
      traceLastEvidenceSnapshot: { domain: '', careersUrl: '', sources: [] },
    });
    expect(isTraceRetryDue({ ...candidate, ...patch }, now)).toBe(false);
    expect(isTraceRetryDue({ ...candidate, ...patch }, Date.parse(patch.traceRetryAt))).toBe(true);
  });

  it('does not unlock repeated identical domain guesses when source timestamps refresh', () => {
    const now = Date.now();
    const lastAttemptAt = new Date(now - DAY_MS).toISOString();
    const retryAt = new Date(now + 30 * DAY_MS).toISOString();
    const key = 'unresolved-employer';
    const store = storeWith({
      [key]: {
        key,
        name: 'Unresolved Employer',
        status: 'new',
        sourceSeenAt: { osm: lastAttemptAt },
        reason: 'dominio non risolto',
        traceRetryable: true,
        traceAttempts: 4,
        traceLastAttemptAt: lastAttemptAt,
        traceRetryAt: retryAt,
      },
    });

    expect(isTraceRetryDue(store.candidates[key], now)).toBe(false);

    upsertCandidate(store, { key, name: 'Internal phase payload' }, 'tenant:vendor.example');
    expect(store.candidates[key].sourceSeenAt['tenant:vendor.example']).toBeTruthy();
    expect(isTraceRetryDue(store.candidates[key], now)).toBe(false);

    upsertCandidate(store, {
      key,
      name: 'Unresolved Employer',
    }, 'osm');
    expect(Date.parse(store.candidates[key].sourceSeenAt.osm)).toBeGreaterThan(Date.parse(lastAttemptAt));
    expect(isTraceRetryDue(store.candidates[key], now)).toBe(false);

    upsertCandidate(store, {
      key,
      name: 'Unresolved Employer',
      careersUrl: 'https://careers.unresolved-employer.example/jobs',
    }, 'osm');
    expect(isTraceRetryDue(store.candidates[key], now)).toBe(true);
  });

  it('refreshes changed retry evidence from the same source and reopens TRACE', () => {
    const key = 'career-url-changed.example';
    const sourceSeenAt = new Date(Date.now() - DAY_MS).toISOString();
    const oldCareersUrl = 'https://old.example/jobs';
    const newCareersUrl = 'https://new.example/jobs';
    const store = storeWith({
      [key]: {
        key,
        name: 'Employer',
        careersUrl: oldCareersUrl,
        status: 'new',
        sources: ['web'],
        sourceSeenAt: { web: sourceSeenAt },
        reason: 'dominio non risolto',
        traceAttempts: 4,
        traceLastEvidenceSnapshot: {
          version: 2,
          name: 'employer',
          domain: '',
          careersUrl: oldCareersUrl,
          city: '',
          zip: '',
          country: '',
          sources: ['web'],
        },
      },
    });

    expect(isTraceRetryDue(store.candidates[key])).toBe(false);
    upsertCandidate(store, { key, careersUrl: newCareersUrl }, 'web');

    expect(store.candidates[key].careersUrl).toBe(newCareersUrl);
    expect(isTraceRetryDue(store.candidates[key])).toBe(true);
  });

  it('fails closed on a malformed retry snapshot and repairs it on discovery', () => {
    const key = 'malformed-retry-snapshot';
    const store = storeWith({
      [key]: {
        key,
        name: 'Employer',
        domain: 'employer.example',
        status: 'new',
        sources: ['osm'],
        sourceSeenAt: { osm: new Date(Date.now() - DAY_MS).toISOString() },
        reason: 'dominio non risolto',
        traceAttempts: 4,
        traceLastEvidenceSnapshot: {
          version: 2,
          name: 'employer',
          domain: 'employer.example',
          careersUrl: '',
          city: '',
          zip: '',
          country: '',
          sources: ['osm', 'bogus'],
        },
      },
    });

    expect(isTraceRetryDue(store.candidates[key])).toBe(false);
    upsertCandidate(store, { key, name: 'Employer', domain: 'employer.example' }, 'osm');

    expect(store.candidates[key].traceLastEvidenceSnapshot.sources).toEqual(['osm']);
    expect(isTraceRetryDue(store.candidates[key])).toBe(false);
  });

  it('preserves employer names when WEB refreshes its host-derived label', () => {
    const key = 'employer-from-seco.example';
    const store = storeWith({
      [key]: {
        key,
        name: 'Employer AG',
        domain: 'employer-from-seco.example',
        careersUrl: 'https://employer-from-seco.example/jobs',
        status: 'new',
        sources: ['seco', 'web'],
        sourceSeenAt: {
          seco: new Date(Date.now() - 2 * DAY_MS).toISOString(),
          web: new Date(Date.now() - DAY_MS).toISOString(),
        },
      },
    });

    upsertCandidate(store, {
      key,
      name: 'employer-from-seco',
      careersUrl: 'https://employer-from-seco.example/Karriere',
    }, 'web');

    expect(store.candidates[key].name).toBe('Employer AG');
    expect(store.candidates[key].careersUrl).toBe('https://employer-from-seco.example/Karriere');
  });

  it('reopens a retry when a careers URL changes only by path case', () => {
    const key = 'case-sensitive-careers-path';
    const oldCareersUrl = 'https://employer.example/Jobs?role=IT';
    const newCareersUrl = 'https://employer.example/jobs?role=IT';
    const store = storeWith({
      [key]: {
        key,
        name: 'Employer',
        careersUrl: oldCareersUrl,
        status: 'new',
        sources: ['web'],
        sourceSeenAt: { web: new Date(Date.now() - DAY_MS).toISOString() },
        reason: 'dominio non risolto',
        traceAttempts: 4,
        traceLastEvidenceSnapshot: {
          version: 2,
          name: 'employer',
          domain: '',
          careersUrl: oldCareersUrl,
          city: '',
          zip: '',
          country: '',
          sources: ['web'],
        },
      },
    });

    expect(isTraceRetryDue(store.candidates[key])).toBe(false);
    upsertCandidate(store, { key, careersUrl: newCareersUrl }, 'web');

    expect(store.candidates[key].careersUrl).toBe(newCareersUrl);
    expect(isTraceRetryDue(store.candidates[key])).toBe(true);
  });

  it('unlocks an exhausted domain guess when another trusted source corroborates it', () => {
    const now = Date.now();
    const lastAttemptAt = now - DAY_MS;
    const key = 'corroborated-employer';
    const candidate = {
      key,
      name: 'Corroborated Employer',
      city: 'Lugano',
      status: 'new',
      sources: ['seco'],
      traceAttempts: 4,
      reason: 'dominio non risolto',
    };
    const store = storeWith({
      [key]: {
        ...candidate,
        ...scheduleTraceRetry(candidate, 'dominio non risolto', lastAttemptAt),
      },
    });

    expect(isTraceRetryDue(store.candidates[key], now)).toBe(false);
    upsertCandidate(store, { key, name: candidate.name, city: candidate.city }, 'osm');
    expect(isTraceRetryDue(store.candidates[key], now)).toBe(true);
  });

  it('reopens an old unreachable verdict when a discovery source sees it again', () => {
    const key = 'mediamarkt.ch';
    const store = storeWith({
      [key]: {
        key,
        status: 'dead',
        name: 'MediaMarkt',
        domain: key,
        reason: 'sito irraggiungibile',
        traceRetryable: true,
        firstSeenAt: OLD,
        updatedAt: OLD,
      },
    });

    const revived = reviveRetryableDeadCandidate(store, key, { sourceHint: 'osm' }, null, 'osm');
    expect(revived).toMatchObject({ status: 'new', reason: 'riscontro dopo una nuova scoperta' });
    expect(store.candidates[key].traceRetryAt).toBeNull();
  });

  it('revives a dead candidate when a same-source upsert changes its careers URL', () => {
    const key = 'dead-careers-url-refresh.example';
    const oldCareersUrl = 'https://dead-careers-url-refresh.example/jobs-old';
    const newCareersUrl = 'https://dead-careers-url-refresh.example/jobs';
    const store = storeWith({
      [key]: {
        key,
        status: 'dead',
        name: 'Employer AG',
        domain: key,
        careersUrl: oldCareersUrl,
        sources: ['web'],
        sourceSeenAt: { web: new Date(Date.now() - DAY_MS).toISOString() },
        reason: 'pagina non trovata',
        firstSeenAt: OLD,
        updatedAt: OLD,
      },
    });
    const incoming = { key, name: 'dead-careers-url-refresh', domain: key, careersUrl: newCareersUrl };

    reviveRetryableDeadCandidate(store, key, incoming, null, 'web');
    upsertCandidate(store, incoming, 'web');

    expect(store.candidates[key].status).toBe('new');
    expect(store.candidates[key].name).toBe('Employer AG');
    expect(store.candidates[key].careersUrl).toBe(newCareersUrl);
    expect(store.candidates[key].traceRetryAt).toBeNull();
  });

  it('does not revive a permanent dead response because its old reason sounds transient', () => {
    const key = 'gone.example';
    const store = storeWith({
      [key]: {
        key,
        status: 'dead',
        domain: key,
        reason: 'sito irraggiungibile',
        traceRetryable: false,
      },
    });

    reviveRetryableDeadCandidate(store, key, { sourceHint: 'osm' }, null, 'osm');
    expect(store.candidates[key].status).toBe('dead');
  });

  it('reopens and refreshes a non-retryable dead verdict from a new WEB careers URL', () => {
    const key = 'employer.ch';
    const newCareersUrl = 'https://careers.employer-group.com/jobs';
    const store = storeWith({
      [key]: {
        key,
        status: 'dead',
        reason: 'nessuna pagina carriere',
        domain: key,
        careersUrl: 'https://employer.ch/jobs-old',
        sources: ['seco'],
      },
    });
    const incoming = { key, careersUrl: newCareersUrl };

    reviveRetryableDeadCandidate(store, key, incoming, null, 'web');
    upsertCandidate(store, incoming, 'web');
    expect(store.candidates[key].status).toBe('new');
    expect(store.candidates[key].careersUrl).toBe(newCareersUrl);
  });

  it('refreshes careers URL from WEB when that source was previously unseen', () => {
    const key = 'unseen-web-source.example';
    const oldCareersUrl = 'https://unseen-web-source.example/jobs-old';
    const newCareersUrl = 'https://unseen-web-source.example/jobs';
    const store = storeWith({
      [key]: {
        key,
        status: 'dead',
        name: 'Employer AG',
        domain: key,
        careersUrl: oldCareersUrl,
        sources: ['seco'],
        sourceSeenAt: { seco: new Date(Date.now() - DAY_MS).toISOString() },
        reason: 'pagina non trovata',
        firstSeenAt: OLD,
        updatedAt: OLD,
      },
    });
    const incoming = {
      key,
      name: 'unseen-web-source',
      domain: key,
      careersUrl: newCareersUrl,
    };

    reviveRetryableDeadCandidate(store, key, incoming, null, 'web');
    upsertCandidate(store, incoming, 'web');

    expect(store.candidates[key].status).toBe('new');
    expect(store.candidates[key].name).toBe('Employer AG');
    expect(store.candidates[key].careersUrl).toBe(newCareersUrl);
    expect(store.candidates[key].sources).toContain('web');
  });
});

describe('prospector candidate store — retryable synthesis failures', () => {
  it('keeps a transient synthesis failure traced until its bounded retry time', () => {
    const key = 'temporary-synthesis.example';
    const candidate = { key, status: 'traced', synthesisAttempts: 0 };
    const store = storeWith({ [key]: candidate });
    const now = Date.parse('2026-10-20T12:00:00.000Z');
    const patch = scheduleSynthesisRetry(candidate, 'sintesi fallita: seed HTTP 503', now);

    setStatus(store, key, 'traced', patch, null);

    expect(store.candidates[key]).toMatchObject({
      status: 'traced',
      reason: 'sintesi fallita: seed HTTP 503',
      synthesisRetryable: true,
      synthesisAttempts: 1,
      synthesisLastAttemptAt: new Date(now).toISOString(),
      synthesisRetryAt: new Date(now + DAY_MS).toISOString(),
    });
    expect(isSynthesisRetryDue(store.candidates[key], now)).toBe(false);
    expect(isSynthesisRetryDue(store.candidates[key], Date.parse(patch.synthesisRetryAt))).toBe(true);

    const nextPatch = scheduleSynthesisRetry(store.candidates[key], 'HTTP 503', now);
    expect(nextPatch.synthesisRetryAt).toBe(new Date(now + 3 * DAY_MS).toISOString());
  });

  it('clears the old synthesis backoff when a fresh observation changes the seed URL', () => {
    const key = 'changed-synthesis-seed.example';
    const store = storeWith({
      [key]: {
        key,
        status: 'traced',
        sources: ['web'],
        careersUrl: 'https://changed-synthesis-seed.example/old-jobs',
        reason: 'sintesi fallita: seed irraggiungibile (503)',
        synthesisRetryable: true,
        synthesisAttempts: 5,
        synthesisLastAttemptAt: '2026-10-19T12:00:00.000Z',
        synthesisRetryAt: '2026-11-18T12:00:00.000Z',
      },
    });

    upsertCandidate(store, {
      key,
      careersUrl: 'https://changed-synthesis-seed.example/current-jobs',
    }, 'web');

    expect(store.candidates[key]).toMatchObject({
      status: 'traced',
      careersUrl: 'https://changed-synthesis-seed.example/current-jobs',
      reason: null,
      synthesisRetryable: false,
      synthesisAttempts: 0,
      synthesisLastAttemptAt: null,
      synthesisRetryAt: null,
    });
    expect(isSynthesisRetryDue(store.candidates[key])).toBe(true);
  });
});
