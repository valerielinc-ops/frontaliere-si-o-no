import { describe, expect, it, vi } from 'vitest';
import {
  createFirestoreReadCounter,
  DEFAULT_LOCAL_REPORT_READ_CAP,
  FirestoreReadBudgetExceededError,
  instrumentFirestore,
  resolveFirestoreReadCap,
} from '../scripts/lib/firestore-admin.mjs';

class FixtureQuery {
  constructor(rows, limit = Infinity, calls = { limits: [] }) {
    this.rows = rows;
    this.maxRows = limit;
    this.calls = calls;
  }

  where() { return new FixtureQuery(this.rows, this.maxRows, this.calls); }
  orderBy() { return new FixtureQuery(this.rows, this.maxRows, this.calls); }
  startAfter() { return new FixtureQuery(this.rows, this.maxRows, this.calls); }

  limit(value) {
    this.calls.limits.push(value);
    return new FixtureQuery(this.rows, value, this.calls);
  }

  async get() {
    const docs = this.rows.slice(0, this.maxRows).map((row, index) => ({
      id: String(index),
      data: () => row,
    }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

function fixtureDb(rows) {
  const calls = { limits: [], getAll: vi.fn(async (...refs) => refs.map(() => ({ exists: false }))) };
  return {
    calls,
    db: {
      collection: () => new FixtureQuery(rows, Infinity, calls),
      getAll: calls.getAll,
    },
  };
}

describe('Firestore local report read budget', () => {
  it('applies the remaining budget as a query limit and fails closed at the boundary', async () => {
    const { db, calls } = fixtureDb(Array.from({ length: 20 }, (_, id) => ({ id })));
    const counter = createFirestoreReadCounter({ caller: 'test-report', maxReads: 3 });
    const firestore = instrumentFirestore(db, counter);

    await expect(firestore.collection('events').where('kind', '==', 'click').get())
      .rejects.toBeInstanceOf(FirestoreReadBudgetExceededError);

    expect(calls.limits).toEqual([3]);
    expect(counter.reads).toBe(3);
  });

  it('does not widen an explicit query limit below the remaining budget', async () => {
    const { db, calls } = fixtureDb(Array.from({ length: 20 }, (_, id) => ({ id })));
    const counter = createFirestoreReadCounter({ caller: 'test-report', maxReads: 5 });
    const firestore = instrumentFirestore(db, counter);

    const page = await firestore.collection('events').limit(2).get();

    expect(page.size).toBe(2);
    expect(counter.reads).toBe(2);
    expect(calls.limits).toEqual([2]);
  });

  it('fails closed when an explicit page exactly consumes the remaining budget', async () => {
    const { db, calls } = fixtureDb(Array.from({ length: 20 }, (_, id) => ({ id })));
    const counter = createFirestoreReadCounter({ caller: 'test-report', maxReads: 3 });
    const firestore = instrumentFirestore(db, counter);

    await expect(firestore.collection('events').limit(3).get())
      .rejects.toBeInstanceOf(FirestoreReadBudgetExceededError);

    expect(calls.limits).toEqual([3]);
    expect(counter.reads).toBe(3);
  });

  it('rejects an oversized getAll before calling Firestore', async () => {
    const { db, calls } = fixtureDb([]);
    const counter = createFirestoreReadCounter({ caller: 'test-report', maxReads: 2 });
    const firestore = instrumentFirestore(db, counter);

    await expect(firestore.getAll('a', 'b', 'c'))
      .rejects.toBeInstanceOf(FirestoreReadBudgetExceededError);

    expect(calls.getAll).not.toHaveBeenCalled();
    expect(counter.reads).toBe(0);
  });

  it('uses a safe local default for named reports and allows an explicit override', () => {
    expect(resolveFirestoreReadCap({}, '/tmp/report-job-email-ranking-experiment.mjs'))
      .toBe(DEFAULT_LOCAL_REPORT_READ_CAP);
    expect(resolveFirestoreReadCap({ GITHUB_ACTIONS: 'true' }, '/tmp/report-job-email-ranking-experiment.mjs'))
      .toBeNull();
    expect(resolveFirestoreReadCap({ GITHUB_ACTIONS: 'true' }, '/tmp/report-daily-brief-cadence.mjs'))
      .toBe(150_000);
    expect(resolveFirestoreReadCap({ GITHUB_ACTIONS: 'true' }, '/tmp/report-email-engagement.mjs'))
      .toBe(150_000);
    expect(resolveFirestoreReadCap({ FIRESTORE_READ_CAP: '12000' }, '/tmp/report-job-email-ranking-experiment.mjs'))
      .toBe(12000);
    expect(() => resolveFirestoreReadCap({ FIRESTORE_READ_CAP: '0' }, '/tmp/report-job-email-ranking-experiment.mjs'))
      .toThrow('FIRESTORE_READ_CAP deve essere un intero positivo');
  });
});
