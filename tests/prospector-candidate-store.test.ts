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
  pruneTerminal,
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

    expect(store.rejectedTombstones[key]).toEqual({ rejectedAt: OLD });
    expect(upsertCandidate(store, { key, name: 'Rediscovered name' }, 'osm')).toEqual({ key, created: false });
    expect(store.candidates[key].status).toBe('rejected');
    expect(store.candidates[key].name).toBe('Wrong source');
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
