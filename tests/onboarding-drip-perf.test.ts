/**
 * Onboarding drip (perf-plan email senders, E1-E3): stato di ogni invio scritto in
 * onSent a micro-batch, con ripiego sulla scrittura singola. Nessuna rete, nessun invio.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBatchedStateWriter } from '../scripts/lib/batched-state-writes.mjs';
import {
  DRIP_PHASES,
  __setDripFirestoreForTest,
  dripMetrics,
  emitDripMetrics,
  persistSentNow,
} from '../scripts/send-onboarding-drip.mjs';
import { DRIP_STEP_COUNT, computeNextStep } from '../services/newsletter/onboardingDrip.mjs';

const ROOT = path.resolve(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;

const sdk = {
  firestore: {
    FieldValue: { serverTimestamp: () => ({ sentinel: 'serverTimestamp' }) },
    Timestamp: { fromDate: (d: Date) => ({ ts: d.getTime() }) },
  },
};

/** Firestore finto con batch e scritture singole distinguibili. */
function fakeStore({ failBatch = false, failSingleAfter = Infinity } = {}) {
  const docs = new Map<string, any>();
  const log: string[] = [];
  let singles = 0;
  let autoId = 0;
  const makeRef = (refPath: string): any => ({
    path: refPath,
    set: async (data: any, options: any = {}) => {
      singles += 1;
      if (singles > failSingleAfter) throw new Error('single write refused');
      log.push(`single:${refPath}`);
      docs.set(refPath, options.merge ? { ...(docs.get(refPath) || {}), ...data } : data);
    },
    collection: (name: string) => ({ doc: () => makeRef(`${refPath}/${name}/auto-${autoId++}`) }),
  });
  const db: any = {
    docs, log,
    batch: () => {
      const sets: Array<{ ref: any; data: any; options: any }> = [];
      return {
        set: (ref: any, data: any, options: any = {}) => { sets.push({ ref, data, options }); },
        commit: async () => {
          if (failBatch) { log.push('batch-error'); throw new Error('batch unavailable'); }
          log.push(`batch:${sets.length}`);
          for (const { ref, data, options } of sets) docs.set(ref.path, options.merge ? { ...(docs.get(ref.path) || {}), ...data } : data);
        },
      };
    },
    sub: (email: string) => makeRef(`newsletter_subscribers/${email}`),
  };
  return db;
}

const makeItem = (db: any, n: number, over: Record<string, unknown> = {}) => ({
  docRef: db.sub(`user${n}@example.test`),
  email: `user${n}@example.test`,
  step: 0,
  cardId: 'welcome',
  segment: 'jobs',
  newlyEnrolled: false,
  startedAt: new Date('2026-11-01T00:00:00Z'),
  ...over,
});

describe('E2: stato salvato a ogni invio, a micro-batch', () => {
  it('quattro invii confermati insieme finiscono in un solo commit (patch + evento ciascuno)', async () => {
    const db = fakeStore();
    __setDripFirestoreForTest(db, sdk);
    const writer = createBatchedStateWriter({ getDb: async () => db, maxItems: 4, windowMs: 5 });
    const items = [1, 2, 3, 4].map((n) => makeItem(db, n));
    await Promise.all(items.map((item) => persistSentNow(item, writer)));
    expect(db.log).toEqual(['batch:8']);
    for (const item of items) {
      expect(db.docs.get(item.docRef.path)).toMatchObject({ drip_last_step: 0, drip_segment: 'jobs' });
      const events = [...db.docs.entries()].filter(([key, value]) => key.startsWith(`${item.docRef.path}/events/`) && value.event_type === 'onboarding_drip_sent');
      expect(events).toHaveLength(1);
      expect(events[0][1]).toMatchObject({ email: item.email, source_channel: 'onboarding_drip', meta: { step: 0, card: 'welcome', segment: 'jobs' } });
    }
  });

  it('le scritture per email sono quelle di sempre: iscrizione fresca porta drip_started_at, l ultimo step chiude', async () => {
    const db = fakeStore();
    __setDripFirestoreForTest(db, sdk);
    const writer = createBatchedStateWriter({ getDb: async () => db, maxItems: 1, windowMs: 1 });
    const fresh = makeItem(db, 1, { newlyEnrolled: true });
    const last = makeItem(db, 2, { step: DRIP_STEP_COUNT - 1 });
    await persistSentNow(fresh, writer);
    await persistSentNow(last, writer);
    expect(db.docs.get(fresh.docRef.path)).toMatchObject({ drip_started_at: { ts: new Date('2026-11-01T00:00:00Z').getTime() } });
    expect(db.docs.get(fresh.docRef.path).drip_completed).toBeUndefined();
    expect(db.docs.get(last.docRef.path)).toMatchObject({ drip_last_step: DRIP_STEP_COUNT - 1, drip_completed: true });
    expect(db.docs.get(fresh.docRef.path).drip_last_sent_at).toEqual({ sentinel: 'serverTimestamp' });
  });

  it('crash dopo N invii: quegli N hanno lo stato salvato e al rilancio non risultano dovuti', async () => {
    const db = fakeStore();
    __setDripFirestoreForTest(db, sdk);
    const writer = createBatchedStateWriter({ getDb: async () => db, maxItems: 2, windowMs: 1 });
    const items = [1, 2, 3, 4, 5, 6].map((n) => makeItem(db, n));
    // La cascade invia e salva lo stato di ogni invio; poi il processo muore al 4o.
    const confirmed: any[] = [];
    const fakeCascade = async () => {
      for (const item of items) {
        if (confirmed.length === 4) throw new Error('runner lost');
        await persistSentNow(item, writer);
        confirmed.push(item);
      }
    };
    await expect(fakeCascade()).rejects.toThrow('runner lost');
    expect(confirmed).toHaveLength(4);
    const nowMs = Date.now();
    for (const item of items) {
      const stored = db.docs.get(item.docRef.path);
      if (confirmed.includes(item)) {
        expect(stored.drip_last_step).toBe(0);
        // Rilancio il giorno dopo: lo step 1 non e dovuto prima dei giorni di intervallo.
        expect(computeNextStep({ startedAtMs: nowMs - DAY, lastStep: stored.drip_last_step, nowMs, lastSentAtMs: nowMs - 1000 })).toBeNull();
      } else {
        expect(stored).toBeUndefined();
      }
    }
  });

  it('errore del batch: ripiego sulle scritture singole, senza duplicare l evento', async () => {
    const db = fakeStore({ failBatch: true });
    __setDripFirestoreForTest(db, sdk);
    const counts: Record<string, number> = {};
    const writer = createBatchedStateWriter({
      getDb: async () => db, maxItems: 2, windowMs: 1, warn: () => {},
      metrics: { count: (n: string, k = 1) => { counts[n] = (counts[n] || 0) + k; } },
    });
    const items = [1, 2].map((n) => makeItem(db, n));
    await Promise.all(items.map((item) => persistSentNow(item, writer)));
    expect(db.log[0]).toBe('batch-error');
    expect(db.log.filter((line: string) => line.startsWith('single:'))).toHaveLength(4);
    expect(counts.stateBatchError).toBe(1);
    expect(counts.stateSingleFallback).toBe(2);
    for (const item of items) {
      expect(db.docs.get(item.docRef.path)).toMatchObject({ drip_last_step: 0 });
      const events = [...db.docs.keys()].filter((key) => key.startsWith(`${item.docRef.path}/events/`));
      expect(events).toHaveLength(1);
    }
  });

  it('se anche il ripiego fallisce l errore risale a onSent (la cascade lo registra senza fallire l invio)', async () => {
    const db = fakeStore({ failBatch: true, failSingleAfter: 0 });
    __setDripFirestoreForTest(db, sdk);
    const writer = createBatchedStateWriter({ getDb: async () => db, maxItems: 1, windowMs: 1, warn: () => {} });
    await expect(persistSentNow(makeItem(db, 1), writer)).rejects.toThrow('single write refused');
  });

  it('un getDb che lancia prima del commit ripiega sulle scritture singole', async () => {
    const db = fakeStore();
    __setDripFirestoreForTest(db, sdk);
    const writer = createBatchedStateWriter({ getDb: async () => { throw new Error('no handle'); }, maxItems: 1, windowMs: 1, warn: () => {} });
    await expect(persistSentNow(makeItem(db, 1), writer)).resolves.toEqual({ mode: 'single' });
    expect(db.docs.get('newsletter_subscribers/user1@example.test')).toMatchObject({ drip_last_step: 0 });
  });
});

describe('E1/E3: cascade con throttle, metriche, workflow', () => {
  const source = readFileSync(path.join(ROOT, 'scripts/send-onboarding-drip.mjs'), 'utf8');

  it('l invio usa bulkCascadeOptions con onSent e non ha piu il ciclo di persistenza dopo l invio', () => {
    expect(source).toContain('await bulkCascadeOptions({');
    expect(source).toMatch(/onSent: async \(item\) => \{\s*await persistSentNow\(item, writer\);/);
    expect(source).not.toContain('for (const s of sent) {');
    expect(source).not.toContain('await persistSent(item)');
    // Il vecchio invio a opzioni di default non c'e piu.
    expect(source).not.toMatch(/await sendEmailCascade\(capped\)/);
  });

  it('le letture dello scan non sono piu scartate e DRIP_METRICS ha le fasi', () => {
    expect(source).toContain('const { docs, reads, queryCount } = await loadOnboardingDripCandidates');
    expect(source).toContain("dripMetrics.set('candidateReads'");
    expect([...DRIP_PHASES]).toEqual(['load', 'queue', 'send']);
    const lines: string[] = [];
    dripMetrics.enter('queue');
    dripMetrics.set('candidateReads', 17);
    emitDripMetrics({ log: (l: string) => lines.push(l) });
    expect(lines[0]).toMatch(/^📊 DRIP_METRICS \{/);
    expect(JSON.parse(lines[0].replace('📊 DRIP_METRICS ', '')).counters.candidateReads).toBe(17);
  });
});
