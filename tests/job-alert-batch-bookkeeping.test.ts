/**
 * Intent e finalize in WriteBatch con precondizione (perf-plan PR 4b).
 *
 * L'invariante che questo file difende: per ogni email l'intent «provider-attempt-
 * intent» e' durevole PRIMA della chiamata al provider, e un crash fra provider e
 * finalize lascia uno stato ambiguo che blocca il retry. Nessun doppio invio,
 * ne' nella stessa run ne' in un rilancio dello stesso giorno. Si prova su un
 * Firestore in memoria che applica DAVVERO le precondizioni `lastUpdateTime`,
 * con iniezione di guasti: precondizione fallita, errore incerto (il commit e'
 * riuscito ma l'errore arriva), crash dopo l'intent, crash dopo il provider.
 *
 * Le funzioni sotto test sono quelle VERE del sender (persistJobAlertProviderAttempt,
 * finalizeJobAlertDeliveryAttempt), collegate al fake con __setFirestoreAdminForTest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setFirestoreAdminForTest,
  finalizeJobAlertDeliveryAttempt,
  isAlertUpdateFused,
  persistJobAlertProviderAttempt,
  resolveBatchBookkeepingEnabled,
  jobAlertMetrics,
} from '../scripts/send-job-alerts.mjs';
import {
  createBatchBookkeeper,
  createMicroBatcher,
  isFailedPrecondition,
} from '../scripts/lib/job-alert-batch-bookkeeping.mjs';
import {
  DELIVERY_STATES,
  filterUnsentJobs,
  jobDedupKey,
  normalizeDeliveryLedger,
  normalizeSentMap,
} from '../scripts/lib/alert-sent-jobs.mjs';

class FakeTimestamp {
  constructor(public micros: number) {}
  isEqual(other: any) { return other instanceof FakeTimestamp && other.micros === this.micros; }
  toMillis() { return Math.floor(this.micros / 1000); }
}

type DocState = { data: any; updateTime: FakeTimestamp };

function setPath(target: any, dotted: string, value: unknown) {
  const parts = dotted.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

function createFakeFirestore() {
  const docs = new Map<string, DocState>();
  let clock = 1_000_000_000;
  const stats = { txReads: 0, txRuns: 0, txWrites: 0, batches: 0, batchOps: 0, directReads: 0 };
  const faults: { nextBatch: null | 'precondition' | 'unavailable' | 'ambiguous-commit' } = { nextBatch: null };
  // Un altro scrittore (utente, altra run) tocca il documento prima del commit del batch.
  const beforeBatchCommit: Array<() => void> = [];

  const apply = (path: string, data: any, mode: 'update' | 'set', merge: boolean, at: FakeTimestamp) => {
    const existing = docs.get(path);
    const next = mode === 'set' && !merge ? {} : JSON.parse(JSON.stringify(existing?.data ?? {}));
    for (const [key, value] of Object.entries(data)) setPath(next, key, value);
    docs.set(path, { data: next, updateTime: at });
  };
  const nextTime = () => new FakeTimestamp((clock += 1000));

  const refOf = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    parent: { id: path.split('/').slice(-2, -1)[0] },
    set: async (data: any, options?: any) => { apply(path, data, 'set', Boolean(options?.merge), nextTime()); },
    get: async () => { stats.directReads += 1; return snapshotOf(path); },
    collection: (name: string) => ({ doc: (id: string) => refOf(`${path}/${name}/${id}`) }),
  });
  const snapshotOf = (path: string): any => {
    const found = docs.get(path);
    return { exists: Boolean(found), ref: refOf(path), data: () => (found ? JSON.parse(JSON.stringify(found.data)) : undefined), updateTime: found?.updateTime };
  };

  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => refOf(`${name}/${id}`) }),
    batch: () => {
      const ops: Array<{ path: string; data: any; kind: 'update' | 'set'; merge: boolean; precondition?: any }> = [];
      return {
        update(ref: any, data: any, precondition?: any) { ops.push({ path: ref.path, data, kind: 'update', merge: false, precondition }); return this; },
        set(ref: any, data: any, options?: any) { ops.push({ path: ref.path, data, kind: 'set', merge: Boolean(options?.merge) }); return this; },
        async commit() {
          stats.batches += 1;
          stats.batchOps += ops.length;
          while (beforeBatchCommit.length) beforeBatchCommit.shift()!();
          const fault = faults.nextBatch;
          faults.nextBatch = null;
          if (fault === 'unavailable') throw Object.assign(new Error('UNAVAILABLE: backend'), { code: 14 });
          // Valida TUTTE le precondizioni prima di scrivere: il batch e' atomico.
          for (const op of ops) {
            const found = docs.get(op.path);
            if (op.kind === 'update' && !found) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
            if (op.precondition?.lastUpdateTime && (!found || !found.updateTime.isEqual(op.precondition.lastUpdateTime))) {
              throw Object.assign(new Error('FAILED_PRECONDITION: the document was modified'), { code: 9 });
            }
          }
          if (fault === 'precondition') throw Object.assign(new Error('FAILED_PRECONDITION: injected'), { code: 9 });
          const at = nextTime();
          for (const op of ops) apply(op.path, op.data, op.kind, op.merge, at);
          if (fault === 'ambiguous-commit') throw Object.assign(new Error('DEADLINE_EXCEEDED after commit'), { code: 4 });
          return ops.map(() => ({ writeTime: at }));
        },
      };
    },
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      stats.txRuns += 1;
      const writes: Array<{ path: string; data: any }> = [];
      const tx = {
        get: async (ref: any) => { stats.txReads += 1; return snapshotOf(ref.path); },
        update: (ref: any, data: any) => {
          if (!docs.has(ref.path)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
          stats.txWrites += 1;
          writes.push({ path: ref.path, data });
        },
      };
      const result = await callback(tx);
      const at = nextTime();
      for (const write of writes) apply(write.path, write.data, 'update', false, at);
      return result;
    },
  };
  return {
    db,
    docs,
    stats,
    faults,
    beforeBatchCommit,
    seed: (path: string, data: any) => { docs.set(path, { data, updateTime: nextTime() }); return docs.get(path)!.updateTime; },
    read: (path: string) => docs.get(path)?.data,
    updateTimeOf: (path: string) => docs.get(path)?.updateTime,
  };
}

const ALERT_PATH = 'job_alert_subscribers/a@example.test/alerts/alert-1';
const JOBS = [{ id: 'job-1', title: 'Infermiere' }, { id: 'job-2', title: 'Cuoco' }];

function makeItem(fake: ReturnType<typeof createFakeFirestore>, overrides: { snapshot?: 'loaded' | 'none'; attempt?: string; jobs?: any[]; operator?: boolean } = {}) {
  const loaded = fake.docs.get(ALERT_PATH)!;
  const snapshot = overrides.snapshot === 'none' ? null : {
    data: { deliveryLedger: loaded.data.deliveryLedger, sentJobIds: loaded.data.sentJobIds },
    updateTime: loaded.updateTime,
  };
  return {
    to: 'a@example.test',
    recipient: { email: 'a@example.test' },
    deliveryRef: fake.db.collection('job_alert_subscribers').doc('a@example.test').collection('alerts').doc('alert-1'),
    meta: {
      alertId: 'alert-1',
      deliveryAttemptId: overrides.attempt ?? 'attempt-A',
      rankingJobs: overrides.jobs ?? JOBS,
      isOperatorVerification: overrides.operator === true,
      alertSnapshot: snapshot,
    },
  } as any;
}

let fake: ReturnType<typeof createFakeFirestore>;
beforeEach(() => {
  fake = createFakeFirestore();
  fake.seed(ALERT_PATH, { active: true, paused: false, deliveryLedger: {}, sentJobIds: {} });
  __setFirestoreAdminForTest(fake.db);
});
afterEach(() => { __setFirestoreAdminForTest(null); });

const ledgerOf = () => normalizeDeliveryLedger(fake.read(ALERT_PATH).deliveryLedger);

describe('intent in WriteBatch con precondizione', () => {
  it('scrive l intent con UN commit e ZERO letture, prima del provider', async () => {
    const item = makeItem(fake);
    const allowed = await persistJobAlertProviderAttempt(item, 'maileroo');
    expect(allowed).toBe(true);
    expect(fake.stats.txReads).toBe(0);
    expect(fake.stats.directReads).toBe(0);
    expect(fake.stats.txRuns).toBe(0);
    expect(fake.stats.batches).toBe(1);
    // Durevole GIA' ora: e' quello che il cascade ha alle spalle quando chiama il provider.
    const ledger = ledgerOf();
    for (const job of JOBS) {
      expect(ledger[jobDedupKey(job)]).toMatchObject({ state: DELIVERY_STATES.AMBIGUOUS, claimId: 'attempt-A', reason: 'provider-attempt-intent' });
    }
    expect(fake.read(ALERT_PATH)).toMatchObject({ deliveryLastOutcome: 'ambiguous', deliveryLastOutcomeReason: 'provider-attempt-intent' });
    // Lo snapshot locale e' quello di Firestore, e l'updateTime e' quello del commit.
    expect(item.meta.alertSnapshot.committedIntent).toBe(true);
    expect(item.meta.alertSnapshot.updateTime.isEqual(fake.updateTimeOf(ALERT_PATH))).toBe(true);
  });

  it('il provider reale che la cascade sta per chiamare e\' registrato nell intent (non un segnaposto)', async () => {
    const item = makeItem(fake);
    await persistJobAlertProviderAttempt(item, 'maileroo');
    for (const job of JOBS) expect(ledgerOf()[jobDedupKey(job)].provider).toBe('maileroo');
  });

  it('lo stesso provider chiamato due volte non riscrive nulla; un secondo provider riscrive l intent col provider reale (stesso claimId)', async () => {
    const item = makeItem(fake);
    await persistJobAlertProviderAttempt(item, 'maileroo');
    const writes = fake.stats.batches;
    expect(await persistJobAlertProviderAttempt(item, 'maileroo')).toBe(true);
    expect(fake.stats.batches).toBe(writes);
    expect(await persistJobAlertProviderAttempt(item, 'resend')).toBe(true);
    expect(fake.stats.batches).toBe(writes + 1);
    expect(fake.stats.txRuns).toBe(0);
    for (const job of JOBS) {
      expect(ledgerOf()[jobDedupKey(job)]).toMatchObject({ provider: 'resend', claimId: 'attempt-A', state: DELIVERY_STATES.AMBIGUOUS });
    }
    // Lo snapshot segue: il finalize successivo usa l'updateTime dell'ultimo intent.
    expect(item.meta.alertSnapshot.intentProvider).toBe('resend');
    expect(item.meta.alertSnapshot.updateTime.isEqual(fake.updateTimeOf(ALERT_PATH))).toBe(true);
  });

  it('le richieste simultanee del cascade (concorrenza 4) si raccolgono in un solo commit', async () => {
    const paths = [1, 2, 3, 4].map((n) => `job_alert_subscribers/u${n}@example.test/alerts/alert-${n}`);
    paths.forEach((path) => fake.seed(path, { active: true, deliveryLedger: {}, sentJobIds: {} }));
    const items = paths.map((path, index) => {
      const loaded = fake.docs.get(path)!;
      return {
        deliveryRef: fake.db.collection('job_alert_subscribers').doc(`u${index + 1}@example.test`).collection('alerts').doc(`alert-${index + 1}`),
        recipient: { email: `u${index + 1}@example.test` },
        meta: { alertId: `alert-${index + 1}`, deliveryAttemptId: `att-${index + 1}`, rankingJobs: [{ id: `solo-${index}` }], alertSnapshot: { data: { deliveryLedger: {}, sentJobIds: {} }, updateTime: loaded.updateTime } },
      } as any;
    });
    const results = await Promise.all(items.map((item) => persistJobAlertProviderAttempt(item, 'maileroo')));
    expect(results).toEqual([true, true, true, true]);
    expect(fake.stats.batches).toBe(1);
    expect(fake.stats.batchOps).toBe(4);
  });

  it('PRECONDIZIONE FALLITA (altro scrittore dopo il caricamento): ripiega sulla transazione, e l intent viene scritto comunque', async () => {
    const item = makeItem(fake);
    // L'utente mette in pausa l'alert dopo il caricamento dello snapshot.
    fake.beforeBatchCommit.push(() => { fake.docs.get(ALERT_PATH)!.data.paused = true; fake.docs.get(ALERT_PATH)!.updateTime = new FakeTimestamp(9_999_999_999); });
    expect(await persistJobAlertProviderAttempt(item, 'maileroo')).toBe(true);
    expect(fake.stats.batches).toBe(1);   // il tentativo fallito
    expect(fake.stats.txRuns).toBe(1);    // il ripiego
    expect(fake.stats.txReads).toBe(1);
    const ledger = ledgerOf();
    expect(ledger[jobDedupKey(JOBS[0])]).toMatchObject({ state: DELIVERY_STATES.AMBIGUOUS, claimId: 'attempt-A' });
    // Il ripiego ha letto lo stato FRESCO: la pausa dell'utente non e' stata sovrascritta.
    expect(fake.read(ALERT_PATH).paused).toBe(true);
    expect(item.meta.alertSnapshot.committedIntent).not.toBe(true);
  });

  it('precondizione fallita E un altro invio ha gia un intent sugli stessi annunci: NESSUN invio (mai senza intent)', async () => {
    const item = makeItem(fake);
    fake.beforeBatchCommit.push(() => {
      const doc = fake.docs.get(ALERT_PATH)!;
      doc.data.deliveryLedger = { [jobDedupKey(JOBS[0])]: { state: 'ambiguous', at: Date.now(), claimId: 'ALTRA-RUN', reason: 'provider-attempt-intent' } };
      doc.updateTime = new FakeTimestamp(9_999_999_999);
    });
    expect(await persistJobAlertProviderAttempt(item, 'maileroo')).toBe(false);
    // L'intent altrui e' intatto: non e' stato sovrascritto.
    expect(ledgerOf()[jobDedupKey(JOBS[0])].claimId).toBe('ALTRA-RUN');
  });

  it('errore incerto: il commit e RIUSCITO ma l errore arriva. Il ripiego riconosce il proprio intent: un solo marcatore, via libera', async () => {
    const item = makeItem(fake);
    fake.faults.nextBatch = 'ambiguous-commit';
    expect(await persistJobAlertProviderAttempt(item, 'maileroo')).toBe(true);
    const ledger = ledgerOf();
    expect(Object.keys(ledger).sort()).toEqual(JOBS.map((job) => jobDedupKey(job)).sort());
    expect(ledger[jobDedupKey(JOBS[0])].claimId).toBe('attempt-A');
  });

  it('errore di rete prima del commit: ripiega sulla transazione', async () => {
    const item = makeItem(fake);
    fake.faults.nextBatch = 'unavailable';
    expect(await persistJobAlertProviderAttempt(item, 'maileroo')).toBe(true);
    expect(fake.stats.txRuns).toBe(1);
    expect(ledgerOf()[jobDedupKey(JOBS[0])].state).toBe('ambiguous');
  });

  it('bloccato dallo snapshot (un marcatore altrui gia presente): false senza scrivere niente', async () => {
    fake.seed(ALERT_PATH, { active: true, deliveryLedger: { [jobDedupKey(JOBS[1])]: { state: 'ambiguous', at: Date.now(), claimId: 'altro' } }, sentJobIds: {} });
    const item = makeItem(fake);
    expect(await persistJobAlertProviderAttempt(item, 'maileroo')).toBe(false);
    expect(fake.stats.batches).toBe(0);
    expect(fake.stats.txRuns).toBe(0);
  });

  it('annuncio gia inviato nella finestra di dedup: false (rilancio dello stesso giorno)', async () => {
    fake.seed(ALERT_PATH, { active: true, deliveryLedger: {}, sentJobIds: { [jobDedupKey(JOBS[0])]: Date.now() - 3_600_000 } });
    expect(await persistJobAlertProviderAttempt(makeItem(fake, { attempt: 'attempt-B' }), 'maileroo')).toBe(false);
    expect(fake.stats.batches + fake.stats.txRuns).toBe(0);
  });

  it('senza updateTime dello snapshot (ignoto) si usa la transazione; la verifica operatore non scrive nulla', async () => {
    expect(await persistJobAlertProviderAttempt(makeItem(fake, { snapshot: 'none' }), 'maileroo')).toBe(true);
    expect(fake.stats.txRuns).toBe(1);
    const before = { ...fake.stats };
    expect(await persistJobAlertProviderAttempt(makeItem(fake, { operator: true, attempt: 'op' }), 'maileroo')).toBe(true);
    expect(fake.stats).toEqual(before);
  });
});

describe('finalize in WriteBatch con precondizione', () => {
  const deliveryWrite = (path = 'job_alert_subscribers/a@example.test/campaign_deliveries/d-1') => ({
    ref: fake.db.collection('job_alert_subscribers').doc('a@example.test').collection('campaign_deliveries').doc(path.split('/').pop()),
    data: { email: 'a@example.test', campaign_id: 'alert-1', message_id: 'm-1' },
    options: { merge: true },
  });

  it('accepted: UN commit con l update fuso dell alert E il record di consegna, nessuna lettura', async () => {
    const item = makeItem(fake);
    item.meta.buildAcceptedAlertFields = () => ({ matchCount: 7, 'ranking.job-1.sent': 1, cadence_scheduled_for: null });
    await persistJobAlertProviderAttempt(item, 'maileroo');
    const before = { ...fake.stats };
    expect(await finalizeJobAlertDeliveryAttempt(item, 'accepted', { provider: 'maileroo', messageId: 'm-1' }, { extraWrites: [deliveryWrite()] })).toBe(true);
    expect(fake.stats.batches - before.batches).toBe(1);
    expect(fake.stats.batchOps - before.batchOps).toBe(2);
    expect(fake.stats.txReads).toBe(0);
    const alert = fake.read(ALERT_PATH);
    expect(alert.deliveryLedger).toEqual({});
    expect(Object.keys(normalizeSentMap(alert.sentJobIds)).sort()).toEqual(JOBS.map((job) => jobDedupKey(job)).sort());
    expect(alert).toMatchObject({ deliveryLastOutcome: 'accepted', deliveryLastOutcomeReason: 'provider-acknowledged', matchCount: 7 });
    expect(alert.ranking['job-1'].sent).toBe(1);
    expect(fake.read('job_alert_subscribers/a@example.test/campaign_deliveries/d-1')).toMatchObject({ message_id: 'm-1' });
  });

  it('PRECONDIZIONE FALLITA nel finalize (l alert e cambiato dopo l intent): ripiego, record di consegna scritto comunque, esito corretto', async () => {
    const item = makeItem(fake);
    await persistJobAlertProviderAttempt(item, 'maileroo');
    fake.beforeBatchCommit.push(() => { fake.docs.get(ALERT_PATH)!.data.paused = true; fake.docs.get(ALERT_PATH)!.updateTime = new FakeTimestamp(9_999_999_999); });
    expect(await finalizeJobAlertDeliveryAttempt(item, 'accepted', { provider: 'maileroo', messageId: 'm-1' }, { extraWrites: [deliveryWrite()] })).toBe(true);
    expect(fake.stats.txRuns).toBe(1);
    const alert = fake.read(ALERT_PATH);
    expect(alert.paused).toBe(true);
    expect(alert.deliveryLedger).toEqual({});
    expect(Object.keys(normalizeSentMap(alert.sentJobIds))).toHaveLength(JOBS.length);
    expect(fake.read('job_alert_subscribers/a@example.test/campaign_deliveries/d-1')).toBeTruthy();
  });

  it('failed: toglie il marcatore per un retry sicuro; ambiguous: lo tiene bloccante', async () => {
    const failed = makeItem(fake, { attempt: 'att-f' });
    await persistJobAlertProviderAttempt(failed, 'maileroo');
    expect(await finalizeJobAlertDeliveryAttempt(failed, 'failed', { error: 'quota' })).toBe(true);
    expect(fake.read(ALERT_PATH)).toMatchObject({ deliveryLastOutcome: 'failed', deliveryLastOutcomeReason: 'provider-rejected' });
    expect(ledgerOf()).toEqual({});

    const ambiguous = makeItem(fake, { attempt: 'att-a' });
    await persistJobAlertProviderAttempt(ambiguous, 'maileroo');
    expect(await finalizeJobAlertDeliveryAttempt(ambiguous, 'ambiguous', { provider: 'maileroo', ack: 'unidentifiable' })).toBe(true);
    expect(ledgerOf()[jobDedupKey(JOBS[0])]).toMatchObject({ state: 'ambiguous', reason: 'provider-outcome-ambiguous', claimId: 'att-a' });
  });

  it('un finalize senza intent scritto dal batch (nessun marcatore) usa la transazione', async () => {
    const item = makeItem(fake, { snapshot: 'none' });
    await expect(finalizeJobAlertDeliveryAttempt(item, 'accepted', { provider: 'maileroo', messageId: 'x' })).rejects.toThrow(/no longer owns/);
    expect(fake.stats.txRuns).toBe(1);
  });

  it('un tentativo che non possiede piu i marcatori non finalizza e lo dice (come prima)', async () => {
    const item = makeItem(fake);
    await persistJobAlertProviderAttempt(item, 'maileroo');
    // Un'altra run si e' presa i marcatori (stesso documento, altro claimId).
    const doc = fake.docs.get(ALERT_PATH)!;
    for (const entry of Object.values<any>(doc.data.deliveryLedger)) entry.claimId = 'ALTRA-RUN';
    doc.updateTime = new FakeTimestamp(9_999_999_999);
    await expect(finalizeJobAlertDeliveryAttempt(item, 'accepted', { provider: 'maileroo', messageId: 'm-1' })).rejects.toThrow(/no longer owns/);
    expect(ledgerOf()[jobDedupKey(JOBS[0])].claimId).toBe('ALTRA-RUN');
  });
});

describe('crash e rilanci: nessun doppio invio', () => {
  /** Quello che una run successiva (stesso giorno o dopo) vede: l'alert RILETTO da Firestore. */
  const nextRunSees = () => {
    const stored = fake.read(ALERT_PATH);
    const ledger = normalizeDeliveryLedger(stored.deliveryLedger);
    const sentMap = normalizeSentMap(stored.sentJobIds);
    const candidates = filterUnsentJobs(JOBS, sentMap, Date.now(), 30 * 24 * 3_600_000, ledger, true);
    return { stored, candidates };
  };

  it('crash DOPO l intent e PRIMA del provider: il rilancio non rimanda quegli annunci', async () => {
    const item = makeItem(fake);
    expect(await persistJobAlertProviderAttempt(item, 'maileroo')).toBe(true);
    // — il processo muore qui —
    const { candidates } = nextRunSees();
    expect(candidates).toEqual([]);
    // E anche se una run provasse a rifare l intent con un nuovo claimId, e bloccata.
    const retry = makeItem(fake, { attempt: 'attempt-NEW' });
    expect(await persistJobAlertProviderAttempt(retry, 'maileroo')).toBe(false);
  });

  it('crash DOPO il provider e PRIMA del finalize: stato ambiguo, il rilancio non rimanda', async () => {
    const item = makeItem(fake);
    await persistJobAlertProviderAttempt(item, 'maileroo');
    // Il provider ha accettato; il finalize non arriva mai (crash).
    const { stored, candidates } = nextRunSees();
    expect(candidates).toEqual([]);
    expect(normalizeSentMap(stored.sentJobIds)).toEqual({});               // non risulta inviato...
    expect(ledgerOf()[jobDedupKey(JOBS[0])].state).toBe('ambiguous');       // ...ma e bloccato
  });

  it('rilancio dello STESSO giorno dopo un invio completo: nessun annuncio candidato e nessun intent', async () => {
    const item = makeItem(fake);
    await persistJobAlertProviderAttempt(item, 'maileroo');
    await finalizeJobAlertDeliveryAttempt(item, 'accepted', { provider: 'maileroo', messageId: 'm-1' });
    const { candidates } = nextRunSees();
    expect(candidates).toEqual([]);
    const rerun = makeItem(fake, { attempt: 'attempt-RERUN' });
    expect(await persistJobAlertProviderAttempt(rerun, 'maileroo')).toBe(false);
    expect(ledgerOf()).toEqual({});
  });

  it('due run sullo stesso alert, stesso snapshot caricato: una sola ottiene l intent (la seconda ha una precondizione stantia)', async () => {
    const runA = makeItem(fake, { attempt: 'run-A' });
    const runB = makeItem(fake, { attempt: 'run-B' }); // stesso snapshot, caricato prima che A scrivesse
    expect(await persistJobAlertProviderAttempt(runA, 'maileroo')).toBe(true);
    expect(await persistJobAlertProviderAttempt(runB, 'maileroo')).toBe(false);
    expect(ledgerOf()[jobDedupKey(JOBS[0])].claimId).toBe('run-A');
    // B ha provato col batch (precondizione stantia) e poi con la transazione, che ha letto lo stato fresco.
    expect(fake.stats.txRuns).toBe(1);
  });

  it('due richieste sullo STESSO documento nello stesso gruppo: la seconda non entra nel batch, passa dalla transazione e viene bloccata', async () => {
    const first = makeItem(fake, { attempt: 'same-doc-1' });
    const second = makeItem(fake, { attempt: 'same-doc-2' });
    const [a, b] = await Promise.all([
      persistJobAlertProviderAttempt(first, 'maileroo'),
      persistJobAlertProviderAttempt(second, 'maileroo'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(fake.stats.batchOps).toBe(1);
  });

  it('percorso della coda retry: intent e finalize con lo snapshot appena letto, poi un rilancio e bloccato', async () => {
    const snap = await fake.db.collection('job_alert_subscribers').doc('a@example.test').collection('alerts').doc('alert-1').get();
    const retryItem: any = {
      recipient: { email: 'a@example.test' },
      deliveryRef: snap.ref,
      meta: {
        type: 'job-alert-retry', alertId: 'alert-1', deliveryAttemptId: 'job-alert-retry:1', rankingJobs: JOBS,
        alertSnapshot: { data: { deliveryLedger: snap.data().deliveryLedger, sentJobIds: snap.data().sentJobIds }, updateTime: snap.updateTime },
      },
    };
    const readsBefore = fake.stats.txReads;
    expect(await persistJobAlertProviderAttempt(retryItem, 'maileroo')).toBe(true);
    expect(await finalizeJobAlertDeliveryAttempt(retryItem, 'accepted', { provider: 'maileroo', messageId: 'r-1' })).toBe(true);
    expect(fake.stats.txReads).toBe(readsBefore);
    expect(Object.keys(normalizeSentMap(fake.read(ALERT_PATH).sentJobIds))).toHaveLength(JOBS.length);
    expect(await persistJobAlertProviderAttempt(makeItem(fake, { attempt: 'again' }), 'maileroo')).toBe(false);
  });
});

describe('micro-batcher, flag e metriche', () => {
  it('flush per dimensione e per finestra; un errore del flush rifiuta le richieste del gruppo', async () => {
    const seen: number[][] = [];
    const batcher = createMicroBatcher(async (requests: number[]) => { seen.push(requests); return requests.map((r) => r * 2); }, { maxItems: 3, windowMs: 5 });
    expect(await Promise.all([1, 2, 3].map((n) => batcher.submit(n)))).toEqual([2, 4, 6]);
    expect(await batcher.submit(9)).toBe(18);
    expect(seen).toEqual([[1, 2, 3], [9]]);
    const failing = createMicroBatcher(async () => { throw new Error('boom'); }, { maxItems: 2, windowMs: 1 });
    await expect(Promise.all([failing.submit(1), failing.submit(2)])).rejects.toThrow('boom');
  });

  it('isFailedPrecondition riconosce il codice gRPC 9 e il messaggio', () => {
    expect(isFailedPrecondition({ code: 9 })).toBe(true);
    expect(isFailedPrecondition(new Error('9 FAILED_PRECONDITION: the document was modified'))).toBe(true);
    expect(isFailedPrecondition({ code: 14, message: 'UNAVAILABLE' })).toBe(false);
  });

  it('JOB_ALERT_BATCH_BOOKKEEPING=off e il kill switch, on di default', () => {
    expect(resolveBatchBookkeepingEnabled({})).toBe(true);
    expect(resolveBatchBookkeepingEnabled({ JOB_ALERT_BATCH_BOOKKEEPING: 'on' })).toBe(true);
    expect(resolveBatchBookkeepingEnabled({ JOB_ALERT_BATCH_BOOKKEEPING: ' OFF ' })).toBe(false);
  });

  it('il bookkeeper conta i ripieghi e segnala l update fuso scritto dal batch', async () => {
    const counts: Record<string, number> = {};
    const applied: any[] = [];
    const bookkeeper = createBatchBookkeeper({
      getDb: async () => fake.db,
      persistIntentTx: async () => true,
      finalizeTx: async () => true,
      onAcceptedFieldsApplied: (item: any) => applied.push(item),
      metrics: { count: (name: string, n = 1) => { counts[name] = (counts[name] || 0) + n; } },
      warn: () => {},
    });
    const item = makeItem(fake);
    item.meta.buildAcceptedAlertFields = () => ({ matchCount: 1 });
    await bookkeeper.requestIntent(item, 'maileroo');
    await bookkeeper.requestFinalize(item, 'accepted', { provider: 'maileroo' });
    expect(counts).toMatchObject({ bookkeepingIntentBatches: 1, bookkeepingFinalizeBatches: 1 });
    expect(applied).toEqual([item]);
    expect(jobAlertMetrics).toBeTruthy();
  });
});


describe('finalize con commit di esito incerto: nessuna doppia applicazione dei campi fusi', () => {
  const deliveryWrite = () => ({
    ref: fake.db.collection('job_alert_subscribers').doc('a@example.test').collection('campaign_deliveries').doc('d-1'),
    data: { email: 'a@example.test', campaign_id: 'alert-1', message_id: 'm-1' },
    options: { merge: true },
  });

  it('il batch di finalize `accepted` e\' scritto sul server ma il client vede un errore: il ripiego riconosce l esito gia applicato, non riscrive nulla e segna l update fuso', async () => {
    const item = makeItem(fake);
    let builds = 0;
    item.meta.buildAcceptedAlertFields = () => { builds += 1; return { matchCount: 7, 'ranking_stats.sent': 1 }; };
    await persistJobAlertProviderAttempt(item, 'maileroo');
    expect(item.meta.deliveryIntentAt).toBeGreaterThan(0);
    fake.faults.nextBatch = 'ambiguous-commit';
    const metricsBefore = jobAlertMetrics.snapshot().counters.bookkeepingFinalizeAlreadyApplied || 0;
    expect(await finalizeJobAlertDeliveryAttempt(item, 'accepted', { provider: 'maileroo', messageId: 'm-1' }, { extraWrites: [deliveryWrite()] })).toBe(true);
    // Il commit e' riuscito sul server: l'alert e' scritto UNA volta, dal batch.
    expect(fake.stats.txRuns).toBe(1);        // il ripiego ha letto
    expect(fake.stats.txWrites).toBe(0);      // e NON ha riscritto (niente seconda applicazione)
    const alert = fake.read(ALERT_PATH);
    expect(alert).toMatchObject({ matchCount: 7, deliveryLastOutcome: 'accepted' });
    expect(alert.deliveryLedger).toEqual({});
    // Il passo post-batch non deve riapplicare increment e decay: l'update risulta fuso.
    expect(isAlertUpdateFused(item)).toBe(true);
    expect(jobAlertMetrics.snapshot().counters.bookkeepingFinalizeAlreadyApplied).toBe(metricsBefore + 1);
    // Il record di consegna c'e' (scrittura idempotente del ripiego).
    expect(fake.read('job_alert_subscribers/a@example.test/campaign_deliveries/d-1')).toMatchObject({ message_id: 'm-1' });
  });

  it('senza la prova completa l errore resta: sentJobIds piu vecchio dell intent, o un marcatore altrui, non sono un finalize gia applicato', async () => {
    // Annunci propri di questo test: l'insieme degli update fusi vive per tutta la run.
    const jobs = [{ id: 'neg-1', title: 'A' }, { id: 'neg-2', title: 'B' }];
    const item = makeItem(fake, { jobs });
    item.meta.buildAcceptedAlertFields = () => ({ matchCount: 1 });
    await persistJobAlertProviderAttempt(item, 'maileroo');
    // Il marcatore e' sparito ma sentJobIds e' VECCHIO (un altro invio, non questo).
    const doc = fake.docs.get(ALERT_PATH)!;
    doc.data.deliveryLedger = {};
    doc.data.sentJobIds = Object.fromEntries(jobs.map((job) => [jobDedupKey(job), item.meta.deliveryIntentAt - 60_000]));
    doc.updateTime = new FakeTimestamp(9_999_999_999);
    await expect(finalizeJobAlertDeliveryAttempt(item, 'accepted', { provider: 'maileroo', messageId: 'm-1' })).rejects.toThrow(/no longer owns/);
    expect(isAlertUpdateFused(item)).toBe(false);
    expect(fake.stats.txWrites).toBe(0);
  });

  it('un solo annuncio dell item senza prova (gli altri si) basta a mantenere l errore', async () => {
    const jobs = [{ id: 'part-1', title: 'A' }, { id: 'part-2', title: 'B' }];
    const item = makeItem(fake, { jobs });
    await persistJobAlertProviderAttempt(item, 'maileroo');
    const doc = fake.docs.get(ALERT_PATH)!;
    doc.data.deliveryLedger = {};
    doc.data.sentJobIds = { [jobDedupKey(jobs[0])]: item.meta.deliveryIntentAt + 1000 };
    doc.updateTime = new FakeTimestamp(9_999_999_999);
    await expect(finalizeJobAlertDeliveryAttempt(item, 'accepted', { provider: 'maileroo', messageId: 'm-1' })).rejects.toThrow(/no longer owns/);
  });
});

describe('micro-batch rifiutato prima del commit: ripiego, mai un invio senza intent ne un finalize perso', () => {
  const item = (extra: Record<string, unknown> = {}) => ({
    to: 'a@example.test',
    deliveryRef: { path: 'job_alert_subscribers/a@example.test/alerts/alert-1' },
    meta: {
      alertId: 'alert-1',
      deliveryAttemptId: 'att-1',
      rankingJobs: JOBS,
      alertSnapshot: { data: { deliveryLedger: {}, sentJobIds: {} }, updateTime: { token: 't0' }, ...extra },
    },
  } as any);
  const rejecting = async () => { throw new Error('getDb exploded'); };

  it('intent: se `getDb` lancia il gruppo e\' rifiutato prima del try del flush, ma la richiesta ripiega sulla transazione', async () => {
    const calls: string[] = [];
    const keeper = createBatchBookkeeper({
      getDb: rejecting,
      persistIntentTx: async (_item: any, provider: string) => { calls.push(`tx:${provider}`); return true; },
      finalizeTx: async () => true,
      windowMs: 0,
    });
    expect(await keeper.requestIntent(item(), 'maileroo')).toBe(true);
    expect(calls).toEqual(['tx:maileroo']);
  });

  it('intent: se anche la transazione di ripiego fallisce l errore risale (la cascade non chiama il provider)', async () => {
    let providerCalled = false;
    const keeper = createBatchBookkeeper({
      getDb: rejecting,
      persistIntentTx: async () => { throw new Error('tx unavailable'); },
      finalizeTx: async () => true,
      windowMs: 0,
    });
    // Come la cascade: il provider parte solo se l'hook risolve a `true`.
    const hook = async () => { const allowed = await keeper.requestIntent(item(), 'maileroo'); if (allowed) providerCalled = true; };
    await expect(hook()).rejects.toThrow(/tx unavailable/);
    expect(providerCalled).toBe(false);
  });

  it('finalize: se `getDb` lancia, il finalize passa dalla transazione e il record di consegna e\' scritto comunque', async () => {
    const calls: string[] = [];
    const written: any[] = [];
    const keeper = createBatchBookkeeper({
      getDb: rejecting,
      persistIntentTx: async () => true,
      finalizeTx: async (_item: any, outcome: string) => { calls.push(`tx:${outcome}`); return true; },
      windowMs: 0,
    });
    const it1 = item({ committedIntent: true });
    const write = { ref: { set: async (data: any) => { written.push(data); } }, data: { id: 'delivery-1' } };
    expect(await keeper.requestFinalize(it1, 'accepted', { provider: 'maileroo' }, { extraWrites: [write] })).toBe(true);
    expect(calls).toEqual(['tx:accepted']);
    expect(written).toEqual([{ id: 'delivery-1' }]);
  });
});

describe('deliveryFinalizeAlreadyApplied (funzione pura)', () => {
  const keys = [jobDedupKey(JOBS[0]), jobDedupKey(JOBS[1])];
  it('vero solo con registro vuoto per ogni annuncio e sentJobIds non anteriore all intent', async () => {
    const { deliveryFinalizeAlreadyApplied } = await import('../scripts/lib/job-alert-delivery-ledger.mjs');
    const at = 1_000_000;
    const sent = (offset: number) => Object.fromEntries(keys.map((key) => [key, at + offset]));
    expect(deliveryFinalizeAlreadyApplied({ deliveryLedger: {}, sentJobIds: sent(0) }, { keys, intentAtMs: at })).toBe(true);
    expect(deliveryFinalizeAlreadyApplied({ deliveryLedger: {}, sentJobIds: sent(-1) }, { keys, intentAtMs: at })).toBe(false);
    expect(deliveryFinalizeAlreadyApplied({ deliveryLedger: {}, sentJobIds: {} }, { keys, intentAtMs: at })).toBe(false);
    expect(deliveryFinalizeAlreadyApplied({ deliveryLedger: { [keys[0]]: { state: 'ambiguous', at: Date.now(), claimId: 'altro' } }, sentJobIds: sent(5) }, { keys, intentAtMs: at })).toBe(false);
    expect(deliveryFinalizeAlreadyApplied({ deliveryLedger: {}, sentJobIds: sent(5) }, { keys, intentAtMs: undefined as any })).toBe(false);
    expect(deliveryFinalizeAlreadyApplied({ deliveryLedger: {}, sentJobIds: sent(5) }, { keys: [], intentAtMs: at })).toBe(false);
  });
});
