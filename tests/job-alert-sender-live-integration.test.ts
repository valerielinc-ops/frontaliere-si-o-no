/**
 * Il sender, intero, in modalita LIVE su un Firestore in memoria (perf-plan PR 4a, 4b, 6, 8).
 *
 * Il cascade e' un doppione che si comporta come quello vero verso il sender:
 * chiama `beforeProviderAttempt` PRIMA di ogni invio e `onSent` DOPO. Cosi' si
 * esercita il percorso che spende davvero: intent in WriteBatch, finalize con
 * l'update fuso dell'alert e il record di consegna nello stesso commit, passo
 * post-batch ridotto, scritture per collection. Poi un RILANCIO dello stesso
 * giorno sullo stesso stato: non deve spedire nulla.
 *
 * Nessuna email reale (`@example.test`), nessuna rete (fetch e' un tranello che
 * lancia), dataset temporaneo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const TOMORROW = new Date(NOW + DAY).toISOString().slice(0, 10);
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

// ── Firestore in memoria: batch con precondizione, transazioni, sentinelle ──
class Stamp {
  constructor(public micros: number) {}
  isEqual(o: any) { return o instanceof Stamp && o.micros === this.micros; }
  toMillis() { return Math.floor(this.micros / 1000); }
}
type Doc = { data: any; updateTime: Stamp };
const store = new Map<string, Doc>();
let clock = 1_700_000_000_000_000;
const tick = () => new Stamp((clock += 1000));
const stats = { batches: 0, batchOps: 0, txRuns: 0, txReads: 0, batchWritesByCollection: {} as Record<string, number> };
const collectionOf = (docPath: string) => docPath.split('/').slice(-2, -1)[0];

function setPath(target: any, dotted: string, value: unknown) {
  const parts = dotted.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}
function resolveSentinel(value: any, previous: any) {
  const method = value?.methodName;
  if (method === 'FieldValue.serverTimestamp') return new Date();
  if (method === 'FieldValue.increment') return (Number(previous) || 0) + Number(value.operand ?? value._operand ?? 0);
  return value;
}
function applyWrite(docPath: string, data: any, kind: 'update' | 'set', merge: boolean, at: Stamp) {
  const existing = store.get(docPath);
  const next = kind === 'set' && !merge ? {} : (existing ? { ...existing.data } : {});
  for (const [key, raw] of Object.entries(data)) {
    // Un campo gia presente con una Date non sopravvive a JSON: si copia a mano.
    const previous = key.split('.').reduce((node: any, part) => (node == null ? undefined : node[part]), next);
    setPath(next, key, resolveSentinel(raw, previous));
  }
  store.set(docPath, { data: next, updateTime: at });
  stats.batchWritesByCollection[collectionOf(docPath)] = (stats.batchWritesByCollection[collectionOf(docPath)] || 0) + 1;
}

function refOf(docPath: string): any {
  const segments = docPath.split('/');
  return {
    path: docPath,
    id: segments[segments.length - 1],
    parent: { id: segments[segments.length - 2], get parent() { return segments.length > 2 ? refOf(segments.slice(0, -2).join('/')) : null; } },
    collection: (name: string) => ({ doc: (id: string) => refOf(`${docPath}/${name}/${id}`) }),
    get: async () => snapshotOf(docPath),
    set: async (data: any, options?: any) => { applyWrite(docPath, data, 'set', Boolean(options?.merge), tick()); },
    update: async (data: any) => { applyWrite(docPath, data, 'update', false, tick()); },
    delete: async () => { store.delete(docPath); },
  };
}
function snapshotOf(docPath: string): any {
  const found = store.get(docPath);
  return {
    exists: Boolean(found), id: docPath.split('/').pop(), ref: refOf(docPath), updateTime: found?.updateTime,
    data: () => (found ? { ...found.data } : undefined),
  };
}
const emptyQuery = { docs: [], empty: true, size: 0 };
const db: any = {
  collection: (name: string) => ({
    doc: (id: string) => refOf(`${name}/${id}`),
    where: () => ({ limit: () => ({ get: async () => emptyQuery }), get: async () => emptyQuery }),
    // La coda retry si legge per intero (vuota in questo scenario).
    get: async () => emptyQuery,
  }),
  collectionGroup: (name: string) => ({
    where: () => ({
      get: async () => {
        const docs = [...store.keys()].filter((p) => collectionOf(p) === name && p.startsWith('job_alert_subscribers/')).map((p) => snapshotOf(p));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    }),
  }),
  getAll: async (...refs: any[]) => refs.map((ref) => snapshotOf(ref.path)),
  batch: () => {
    const ops: Array<{ path: string; data: any; kind: 'update' | 'set' | 'delete'; merge: boolean; precondition?: any }> = [];
    return {
      update(ref: any, data: any, precondition?: any) { ops.push({ path: ref.path, data, kind: 'update', merge: false, precondition }); return this; },
      set(ref: any, data: any, options?: any) { ops.push({ path: ref.path, data, kind: 'set', merge: Boolean(options?.merge) }); return this; },
      delete(ref: any) { ops.push({ path: ref.path, data: null, kind: 'delete', merge: false }); return this; },
      async commit() {
        stats.batches += 1;
        stats.batchOps += ops.length;
        for (const op of ops) {
          const found = store.get(op.path);
          if (op.kind === 'update' && !found) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
          if (op.precondition?.lastUpdateTime && (!found || !found.updateTime.isEqual(op.precondition.lastUpdateTime))) {
            throw Object.assign(new Error('FAILED_PRECONDITION'), { code: 9 });
          }
        }
        const at = tick();
        for (const op of ops) {
          if (op.kind === 'delete') store.delete(op.path); else applyWrite(op.path, op.data, op.kind, op.merge, at);
        }
        return ops.map(() => ({ writeTime: at }));
      },
    };
  },
  runTransaction: async (callback: (tx: any) => Promise<any>) => {
    stats.txRuns += 1;
    const writes: Array<{ path: string; data: any }> = [];
    const tx = {
      get: async (ref: any) => { stats.txReads += 1; return snapshotOf(ref.path); },
      update: (ref: any, data: any) => { writes.push({ path: ref.path, data }); },
      set: (ref: any, data: any, options?: any) => { writes.push({ path: ref.path, data }); void options; },
    };
    const result = await callback(tx);
    const at = tick();
    for (const write of writes) applyWrite(write.path, write.data, 'update', false, at);
    return result;
  },
};

// ── popolazione: 8 destinatari in programma, 2 non in programma ─────────────
const jobs = Array.from({ length: 24 }, (_, i) => ({
  id: `live-job-${i}`,
  slug: `infermiere-${i}-eoc-lugano`,
  slugByLocale: { it: `infermiere-${i}-eoc-lugano`, en: `nurse-${i}`, de: `pflege-${i}`, fr: `infirmier-${i}` },
  title: 'Infermiere diplomato', titleByLocale: {}, description: `Cerchiamo infermiere. ${'Testo. '.repeat(20)}`,
  company: 'EOC', category: 'sanità', sector: 'healthcare', location: 'Lugano', canton: 'TI', contract: 'full-time',
  firstSeenAt: iso(-2 * DAY), crawledAt: iso(-0.2 * DAY),
}));
const dueEmails = Array.from({ length: 8 }, (_, i) => `live${i}@example.test`);
const idleEmails = Array.from({ length: 2 }, (_, i) => `idle${i}@example.test`);
const alertPath = (email: string) => `job_alert_subscribers/${email}/alerts/a1`;

const sentMessages: Array<{ to: string; messageId: string; subject: string }> = [];
let output: string[] = [];
let firstRunStats: any;
let secondRunSent = -1;
let sender: any;

beforeAll(async () => {
  for (const email of dueEmails) {
    store.set(`job_alert_subscribers/${email}`, { data: {}, updateTime: tick() });
    store.set(`newsletter_subscribers/${email}`, { data: { status: 'active' }, updateTime: tick() });
    store.set(alertPath(email), { data: { active: true, email, locale: 'it', keywords: ['infermiere'], createdAt: iso(-60 * DAY), deliveryLedger: {}, sentJobIds: {}, matchCount: 0 }, updateTime: tick() });
  }
  for (const email of idleEmails) {
    store.set(`job_alert_subscribers/${email}`, { data: { ja_cadence_last_sent_at: iso(-0.1 * DAY) }, updateTime: tick() });
    store.set(`newsletter_subscribers/${email}`, { data: { status: 'active' }, updateTime: tick() });
    store.set(alertPath(email), { data: { active: true, email, locale: 'it', keywords: ['infermiere'], createdAt: iso(-60 * DAY), lastMatchedAt: new Date(NOW - 0.1 * DAY) }, updateTime: tick() });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-alert-live-'));
  const jobsPath = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsPath, JSON.stringify(jobs));
  Object.assign(process.env, {
    JOB_ALERTS_JOBS_PATH: jobsPath, ENABLE_JOB_ALERTS: 'true', TODAY_ISO: TODAY,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    JOB_ALERT_LIVE_LINK_MANIFEST: 'off', JOB_ALERT_CANDIDATE_INDEX_MODE: 'on', JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE: '0.5',
    NEWSLETTER_SECRET: 'test-secret-for-hmac-links-0123456789', SKIP_NEWSLETTER_COOLDOWN: '',
  });
  delete process.env.TARGET_EMAIL;
  vi.resetModules();
  vi.doMock('../scripts/lib/email-cascade.mjs', () => ({
    getAvailableCascadeQuota: async () => 500,
    getProviderStats: () => [{ id: 'maileroo', configured: true, sent: sentMessages.length, benched: 0, remaining: 500, dailyLimit: 1000 }],
    BULK_PROVIDER_MIN_INTERVAL_MS: {},
    // Si comporta come il cascade vero verso il sender: intent prima, onSent dopo.
    sendEmailCascade: async (emails: any[], opts: any) => {
      const sent: any[] = [];
      const failed: any[] = [];
      for (const item of emails) {
        const allowed = await opts.beforeProviderAttempt?.(item, 'maileroo');
        if (allowed === false) { failed.push({ ...item, error: 'blocked-before-provider' }); continue; }
        const result = { provider: 'maileroo', messageId: `live-msg-${sentMessages.length + 1}`, ack: 'identified', scheduledFor: null };
        sentMessages.push({ to: item.recipient.email, messageId: result.messageId, subject: item.payload.subject });
        await opts.onSent(item, result);
        sent.push({ ...item, ...result });
      }
      return { sent, accepted: sent, ambiguous: [], failed, providerBreakdown: { maileroo: { identified: sent.length, ambiguous: 0, persistFailed: 0 } } };
    },
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { throw new Error(`unexpected network call: ${url}`); }));
  const log = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => { output.push(args.join(' ')); });
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: any[]) => { output.push(args.join(' ')); });
  try {
    sender = await import('../scripts/send-job-alerts.mjs');
    sender.__setFirestoreAdminForTest(db);
    await sender.runJobAlertsMain();
    firstRunStats = { ...stats, sent: sentMessages.length, batchWritesByCollection: { ...stats.batchWritesByCollection } };
    // Rilancio dello stesso giorno sullo stesso stato.
    const before = sentMessages.length;
    output = [];
    await sender.runJobAlertsMain();
    secondRunSent = sentMessages.length - before;
  } finally {
    log.mockRestore(); warn.mockRestore();
  }
}, 180_000);

afterAll(() => { vi.unstubAllGlobals(); });

describe('sender in LIVE, intero, su Firestore in memoria', () => {
  it('invia una email a ognuno degli 8 in programma e a nessuno dei 2 che non lo sono', () => {
    expect(firstRunStats.sent).toBe(8);
    expect(sentMessages.map((m) => m.to).sort()).toEqual([...dueEmails].sort());
    expect(new Set(sentMessages.map((m) => m.messageId)).size).toBe(8);
  });

  it('PR 4b: intent e finalize passano dal batch, senza una sola lettura transazionale nel caso normale', () => {
    expect(firstRunStats.txReads).toBe(0);
    expect(firstRunStats.txRuns).toBe(0);
    expect(firstRunStats.batches).toBeGreaterThan(0);
  });

  it('PR 4a: un solo update per alert, con i campi del finalize e quelli fusi dal passo post-batch', () => {
    for (const email of dueEmails) {
      const alert = store.get(alertPath(email))!.data;
      // finalize accepted
      expect(alert.deliveryLedger).toEqual({});
      expect(alert.deliveryLastOutcome).toBe('accepted');
      expect(Object.keys(alert.sentJobIds).length).toBeGreaterThan(0);
      // campi fusi dal vecchio passo post-batch
      expect(alert.lastMatchedAt).toBeInstanceOf(Date);
      expect(alert.matchCount).toBeGreaterThan(0);
      expect(alert).toHaveProperty('cadence_scheduled_for');
      // PR 8 (shadow): limite del prossimo giorno eleggibile, nello stesso update.
      expect(alert.cadence_next_eligible_on).toBe(TOMORROW);
    }
    // Una scrittura per alert nel batch dell'intent + una nel finalize: 16 sugli alert, mai una terza.
    expect(firstRunStats.batchWritesByCollection.alerts).toBe(16);
  });

  it('PR 4b: il record di consegna viaggia nel commit del finalize (una scrittura per email)', () => {
    expect(firstRunStats.batchWritesByCollection.campaign_deliveries).toBe(8);
    for (const email of dueEmails) {
      const deliveries = [...store.keys()].filter((p) => p.startsWith(`job_alert_subscribers/${email}/campaign_deliveries/`));
      expect(deliveries).toHaveLength(1);
      expect(store.get(deliveries[0])!.data).toMatchObject({ email, campaign_id: 'a1', provider: 'maileroo', recommendation_mode: 'targeted' });
    }
  });

  it('il passo post-batch scrive solo il documento del destinatario, non un secondo update dell alert', () => {
    for (const email of dueEmails) {
      expect(store.get(`job_alert_subscribers/${email}`)!.data.last_sent_at).toBeInstanceOf(Date);
    }
    expect(firstRunStats.batchWritesByCollection.job_alert_subscribers).toBe(8);
  });

  it('PR 4a: le impression di ranking restano in modalita manifest (nessun braccio non-control)', () => {
    expect(output.join('\n') + '').toBeDefined();
    const impressionCollections = Object.keys(firstRunStats.batchWritesByCollection).filter((c) => c.startsWith('job_email_ranking'));
    expect(impressionCollections).toEqual(['job_email_ranking_deliveries']);
    expect(firstRunStats.batchWritesByCollection.job_email_ranking_deliveries).toBe(8);
  });

  it('RILANCIO dello stesso giorno sullo stato prodotto dal primo giro: nessuna email, nessun intent', () => {
    expect(secondRunSent).toBe(0);
    for (const email of dueEmails) {
      expect(store.get(alertPath(email))!.data.deliveryLedger).toEqual({});
    }
  });
});
