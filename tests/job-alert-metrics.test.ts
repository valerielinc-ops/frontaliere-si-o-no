/**
 * Telemetria per fase del sender dei job alert (perf-plan PR 1).
 *
 * Il contatore si aggancia alle CLASSI del client Firestore, e ogni operazione
 * deve contarsi UNA volta anche se il client la fa passare da più metodi
 * (DocumentReference.get → Firestore.getAll; Transaction.set → WriteBatch.set).
 * I test usano classi finte con la stessa catena di chiamate del client 7.x e,
 * per le scritture, le classi VERE di firebase-admin (nessuna rete: una batch
 * non si committa).
 */
import { describe, expect, it } from 'vitest';
import {
  JOB_ALERT_PHASES,
  createJobAlertMetrics,
  formatJobAlertMetricsLine,
  formatJobAlertMetricsMarkdown,
} from '../scripts/lib/job-alert-metrics.mjs';
import {
  installFirestoreOpCounter,
  installFirestoreOpCounterOnAdminSdk,
} from '../scripts/lib/firestore-op-counter.mjs';

function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const ref = (collection: string, id: string) => ({ id, parent: { id: collection } });
const snap = (collection: string, id: string, exists = true) => ({ ref: ref(collection, id), exists });

/** Classi finte con la stessa catena di chiamate del client: ogni percorso conta una volta. */
function fakeClient() {
  class WriteBatch {
    ops: string[] = [];
    set(r: any) { this.ops.push(`set:${r.parent.id}`); return this; }
    create(r: any) { this.ops.push(`create:${r.parent.id}`); return this; }
    update(r: any) { this.ops.push(`update:${r.parent.id}`); return this; }
    delete(r: any) { this.ops.push(`delete:${r.parent.id}`); return this; }
  }
  class Firestore {
    batch() { return new WriteBatch(); }
    async getAll(...refs: any[]) { return refs.filter((r) => r.parent).map((r) => ({ ref: r, exists: r.id !== 'missing' })); }
  }
  class Query {
    docs: any[];
    constructor(docs: any[]) { this.docs = docs; }
    async get() { return { docs: this.docs, size: this.docs.length, query: { _queryOptions: { collectionId: 'alerts' } } }; }
  }
  class Transaction {
    writeBatch: WriteBatch;
    constructor(public firestore: Firestore) { this.writeBatch = firestore.batch(); }
    async get(target: any) {
      if (target instanceof Query) return target._get();
      return { ref: target, exists: true };
    }
    async getAll(...refs: any[]) { return refs.map((r) => ({ ref: r, exists: true })); }
    set(r: any, d: any) { this.writeBatch.set(r, d); return this; }
    update(r: any, d: any) { this.writeBatch.update(r, d); return this; }
  }
  (Query.prototype as any)._get = async function _get() { return { docs: this.docs, size: this.docs.length, query: { _queryOptions: { collectionId: 'alerts' } } }; };
  // Come nel client 7.x: DocumentReference.get() passa da Firestore.getAll().
  class DocumentReference {
    constructor(public firestore: Firestore, public id: string, public parent: any) {}
    async get() { const [s] = await this.firestore.getAll(this); return s; }
    async set(d: any) { const b = this.firestore.batch(); b.set(this, d); return b; }
  }
  return { Firestore, WriteBatch, Query, Transaction, DocumentReference };
}

describe('metriche per fase', () => {
  it('addebita il tempo alla fase corrente e somma le fasi alternate', () => {
    const clock = fakeClock();
    const metrics = createJobAlertMetrics({ now: clock.now, memory: () => ({ heapUsed: 10, rss: 20 }) });
    metrics.enter('planning'); clock.advance(100);
    metrics.enter('send'); clock.advance(40);
    metrics.enter('persist'); clock.advance(10);
    metrics.enter('planning'); clock.advance(50);
    const snapshot = metrics.snapshot({ date: '2026-11-14', mode: 'DRY RUN', indexMode: 'on' });
    expect(snapshot.phases.planning.ms).toBe(150);
    expect(snapshot.phases.send.ms).toBe(40);
    expect(snapshot.phases.persist.ms).toBe(10);
    expect(snapshot.totals.ms).toBe(200);
    expect(Object.keys(snapshot.phases).every((name) => JOB_ALERT_PHASES.includes(name) || name === 'other')).toBe(true);
  });

  it('attribuisce letture e scritture alla fase corrente, per collection', () => {
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    metrics.enter('profiles');
    metrics.recordRead('newsletter_subscribers', 200);
    metrics.recordRead('job_alert_subscribers', 200);
    metrics.enter('persist');
    metrics.recordWrite('alerts', 3);
    metrics.recordWrite('alerts', 2);
    metrics.recordWrite('campaign_deliveries', 5);
    const snapshot = metrics.snapshot();
    expect(snapshot.phases.profiles.reads).toBe(400);
    expect(snapshot.phases.profiles.writes).toBe(0);
    expect(snapshot.phases.persist.writesByCollection).toEqual({ alerts: 5, campaign_deliveries: 5 });
    expect(snapshot.totals).toMatchObject({ reads: 400, writes: 10 });
  });

  it('traccia il picco dell heap e non lo abbassa', () => {
    let heap = 100;
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: heap, rss: heap * 2 }) });
    metrics.enter('planning'); heap = 900; metrics.sampleMemory(); heap = 50; metrics.enter('send');
    const snapshot = metrics.snapshot();
    expect(snapshot.heapPeakBytes).toBe(900);
    expect(snapshot.rssPeakBytes).toBe(1800);
  });

  it('la riga di log è una sola, parsabile, e il Job Summary non contiene email', () => {
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 1, rss: 1 }) });
    metrics.enter('planning');
    metrics.count('windowRows', 124_487_115);
    metrics.count('scoredRows', 1000);
    metrics.count('indexMismatch', 0);
    const snapshot = metrics.snapshot({ date: '2026-11-14', mode: 'LIVE', indexMode: 'on' });
    const line = formatJobAlertMetricsLine(snapshot);
    expect(line.startsWith('📊 JOBALERT_METRICS {')).toBe(true);
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line.replace('📊 JOBALERT_METRICS ', ''));
    expect(parsed.counters).toMatchObject({ windowRows: 124_487_115, scoredRows: 1000 });
    const markdown = formatJobAlertMetricsMarkdown(snapshot);
    expect(markdown).toContain('indexMismatch');
    expect(markdown).not.toMatch(/@/);
  });

  it('il Job Summary riporta il tempo per strategia e la costruzione una tantum di indice e vocabolari', () => {
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 1, rss: 1 }) });
    metrics.enter('planning');
    metrics.count('planMs.hard-search', 1000); metrics.count('planAlerts.hard-search', 4);
    metrics.count('planMs.hard-keyword', 300); metrics.count('planAlerts.hard-keyword', 3);
    metrics.set('indexBuildMs', 120);
    metrics.set('vocabularyBuildMs.it', 22_000); metrics.set('vocabularyWords.it', 65_000); metrics.set('vocabularyBytes.it', 21 * 1024 * 1024);
    const markdown = formatJobAlertMetricsMarkdown(metrics.snapshot());
    expect(markdown).toMatch(/\| hard-search \| 4 \| 1\.?000 \| 250 \|/);
    expect(markdown.indexOf('hard-search')).toBeLessThan(markdown.indexOf('hard-keyword'));
    expect(markdown).toMatch(/indice dei candidati \| 120 ms/);
    expect(markdown).toMatch(/vocabolario ricerca \[it\] \| 22\.000 ms, 65\.000 parole, 21 MiB/);
  });
});

describe('contatore delle operazioni Firestore', () => {
  it('conta le letture di getAll (documento mancante compreso) e DocumentReference.get una volta sola', async () => {
    const { Firestore, DocumentReference, ...classes } = fakeClient();
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    const uninstall = installFirestoreOpCounter(metrics, { Firestore, ...classes } as any);
    try {
      metrics.enter('profiles');
      const db = new Firestore();
      await db.getAll(ref('newsletter_subscribers', 'a'), ref('job_alert_subscribers', 'a'), ref('newsletter_subscribers', 'missing'));
      await new DocumentReference(db, 'x', { id: 'newsletter_subscribers' }).get();
      const snapshot = metrics.snapshot();
      expect(snapshot.phases.profiles.readsByCollection).toEqual({ newsletter_subscribers: 3, job_alert_subscribers: 1 });
    } finally { uninstall(); }
  });

  it('conta una query come i documenti restituiti (minimo 1 se vuota)', async () => {
    const { Query, ...classes } = fakeClient();
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    const uninstall = installFirestoreOpCounter(metrics, { Query, ...classes } as any);
    try {
      metrics.enter('load_alerts');
      await new Query([snap('alerts', '1'), snap('alerts', '2'), snap('alerts', '3')]).get();
      await new Query([]).get();
      expect(metrics.snapshot().phases.load_alerts.readsByCollection).toEqual({ alerts: 4 });
    } finally { uninstall(); }
  });

  it('una transazione con lettura e scrittura conta 1 lettura e 1 scrittura, non di più', async () => {
    const { Firestore, Transaction, WriteBatch, Query } = fakeClient();
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    const uninstall = installFirestoreOpCounter(metrics, { Firestore, Transaction, WriteBatch, Query } as any);
    try {
      metrics.enter('send');
      const db = new Firestore();
      const tx = new Transaction(db);
      const alert = ref('alerts', 'a1');
      await tx.get(alert);
      tx.update(alert, { deliveryLedger: {} });
      await tx.getAll(ref('alerts', 'a2'), ref('alerts', 'a3'));
      const snapshot = metrics.snapshot();
      expect(snapshot.phases.send.readsByCollection).toEqual({ alerts: 3 });
      expect(snapshot.phases.send.writesByCollection).toEqual({ alerts: 1 });
    } finally { uninstall(); }
  });

  it('conta set/update/delete/create di batch e di riferimento singolo (stesso percorso WriteBatch)', async () => {
    const { Firestore, WriteBatch, DocumentReference } = fakeClient();
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    const uninstall = installFirestoreOpCounter(metrics, { Firestore, WriteBatch } as any);
    try {
      metrics.enter('persist');
      const db = new Firestore();
      const batch = db.batch();
      batch.set(ref('campaign_deliveries', '1'), {}).update(ref('alerts', '1'), {}).delete(ref('alerts', '2')).create(ref('maileroo_refs', '3'), {});
      await new DocumentReference(db, 'x', { id: 'alerts' }).set({});
      expect(metrics.snapshot().phases.persist.writesByCollection).toEqual({
        campaign_deliveries: 1, alerts: 3, maileroo_refs: 1,
      });
    } finally { uninstall(); }
  });

  it('è idempotente (una seconda install non raddoppia) e uninstall ripristina i metodi', () => {
    const { Firestore, WriteBatch } = fakeClient();
    const original = WriteBatch.prototype.set;
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    const uninstall = installFirestoreOpCounter(metrics, { Firestore, WriteBatch } as any);
    const again = installFirestoreOpCounter(metrics, { Firestore, WriteBatch } as any);
    metrics.enter('persist');
    new Firestore().batch().set(ref('alerts', '1'), {});
    expect(metrics.snapshot().phases.persist.writes).toBe(1);
    again();
    uninstall();
    expect(WriteBatch.prototype.set).toBe(original);
  });

  it('un errore del client si propaga e la telemetria non lo cambia', async () => {
    const { Firestore, WriteBatch } = fakeClient();
    (Firestore.prototype as any).getAll = async () => { throw new Error('unavailable'); };
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    const uninstall = installFirestoreOpCounter(metrics, { Firestore, WriteBatch } as any);
    try {
      await expect(new Firestore().getAll(ref('alerts', '1'))).rejects.toThrow('unavailable');
      expect(metrics.snapshot().totals.reads).toBe(0);
    } finally { uninstall(); }
  });

  it('sulle classi VERE di firebase-admin una batch conta per collection senza rete', async () => {
    const metrics = createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });
    const uninstall = await installFirestoreOpCounterOnAdminSdk(metrics);
    try {
      const { Firestore } = await import('firebase-admin/firestore');
      const db = new Firestore({ projectId: 'demo-job-alert-metrics' });
      metrics.enter('persist');
      const owner = db.collection('job_alert_subscribers').doc('x@example.test');
      const batch = db.batch();
      batch.update(owner.collection('alerts').doc('a1'), { a: 1 });
      batch.set(owner.collection('campaign_deliveries').doc('d1'), { a: 1 }, { merge: true });
      batch.set(owner, { last_sent_at: new Date() }, { merge: true });
      const snapshot = metrics.snapshot();
      expect(snapshot.phases.persist.writesByCollection).toEqual({
        alerts: 1, campaign_deliveries: 1, job_alert_subscribers: 1,
      });
      expect(JSON.stringify(snapshot)).not.toContain('example.test');
    } finally { uninstall(); }
  });
});
