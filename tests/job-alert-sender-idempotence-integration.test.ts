/**
 * Il sender, intero, in LIVE su un Firestore in memoria: due scenari di idempotenza
 * emersi dalla review (secondo giro, perf-plan PR 4b e 6).
 *
 *  A2. Un alert RIATTIVATO in questa run: fra il caricamento (t0) e la riattivazione
 *      (t2) un altro processo scrive un intent AMBIGUOUS sugli stessi annunci (t1).
 *      L'intent di questa run NON deve valutare il ledger di t0 con una precondizione
 *      su t2 (sovrascriverebbe il marcatore altrui e invierebbe due volte): il primo
 *      intent ripiega sulla transazione, rilegge, vede il marcatore e non invia.
 *
 *  R5. Una riga della coda retry SENZA `deliveryState` (storica): va messa in
 *      quarantena col marcatore che blocca il reinvio, e non produce nessun invio.
 *
 * Nessuna email reale (`@example.test`), nessuna rete, dataset temporaneo.
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
const commitHooks: Array<(ops: any[]) => void> = [];
const db: any = {
  collection: (name: string) => ({
    doc: (id: string) => refOf(`${name}/${id}`),
    where: () => ({ limit: () => ({ get: async () => emptyQuery }), get: async () => emptyQuery }),
    // Lettura intera di una collection di primo livello (la coda retry).
    get: async () => {
      const docs = [...store.keys()].filter((p) => p.startsWith(`${name}/`) && p.split('/').length === 2).map((p) => snapshotOf(p));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
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
        // Un altro scrittore interviene PRIMA che questo commit si applichi.
        for (const hook of commitHooks) hook(ops);
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


// ── popolazione ─────────────────────────────────────────────────────────────
const jobs = Array.from({ length: 12 }, (_, i) => ({
  id: `idem-job-${i}`,
  slug: `infermiere-${i}-eoc-lugano`,
  slugByLocale: { it: `infermiere-${i}-eoc-lugano`, en: `nurse-${i}`, de: `pflege-${i}`, fr: `infirmier-${i}` },
  title: 'Infermiere diplomato', titleByLocale: {}, description: `Cerchiamo infermiere. ${'Testo. '.repeat(20)}`,
  company: 'EOC', category: 'sanità', sector: 'healthcare', location: 'Lugano', canton: 'TI', contract: 'full-time',
  firstSeenAt: iso(-2 * DAY), crawledAt: iso(-0.2 * DAY),
}));
const UID = 'firebase-uid-idempotence';
const READER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const REACT = 'react0@example.test';
const LEGACY = 'legacy0@example.test';
const alertPath = (email: string) => `job_alert_subscribers/${email}/alerts/a1`;
const FOREIGN_CLAIM = 'altra-run:foreign-claim';

const sentMessages: Array<{ to: string }> = [];
let reactivationBatchSeen = false;
let sender: any;
let jobDedupKey: (job: any) => string;
let mergeDeliveryLedger: any;
let ledgerAfterReactivation: any = null;

beforeAll(async () => {
  // Alert decaduto il cui destinatario e' tornato sul sito: sara' riattivato in questa run.
  store.set(`job_alert_subscribers/${REACT}`, { data: {
    userId: UID, status: 'active', ja_cadence_tier: 7, ja_cadence_weekly_sends: 4,
    ja_cadence_last_sent_at: iso(-10 * DAY),
    last_site_visit_at: iso(-1 * DAY), last_site_visit_uid: UID, last_site_visit_ua: READER_UA,
    last_site_visit_entry: 'https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-1',
    last_site_visit_visible: true, last_site_visit_prerender: false,
  }, updateTime: tick() });
  store.set(`newsletter_subscribers/${REACT}`, { data: { status: 'active' }, updateTime: tick() });
  store.set(alertPath(REACT), { data: {
    id: 'a1', email: REACT, active: true, frequency: 'daily', frequencyOverride: false, userId: UID, locale: 'it',
    keywords: ['infermiere'], locations: [], backfilled_from: 'newsletter_subscribers:job_gate', createdAt: iso(-60 * DAY),
    lastMatchedAt: iso(-10 * DAY), cadence_state: 'decayed', cadence_decayed_at: iso(-10 * DAY),
    cadence_decay_reason: 'no human signal in 4 weekly sends', cadence_sends_at_decay: 4,
    deliveryLedger: {}, sentJobIds: {}, matchCount: 0,
  }, updateTime: tick() });

  // Riga storica della coda retry, senza `deliveryState`, per un alert non in programma.
  store.set(`job_alert_subscribers/${LEGACY}`, { data: { ja_cadence_last_sent_at: iso(-0.1 * DAY) }, updateTime: tick() });
  store.set(`newsletter_subscribers/${LEGACY}`, { data: { status: 'active' }, updateTime: tick() });
  store.set(alertPath(LEGACY), { data: { active: true, email: LEGACY, locale: 'it', keywords: ['infermiere'], createdAt: iso(-60 * DAY), lastMatchedAt: new Date(NOW - 0.1 * DAY), deliveryLedger: {}, sentJobIds: {} }, updateTime: tick() });
  store.set('job_alert_retry_queue/legacy-row-1', { data: {
    email: LEGACY, alertId: 'a1', rankingJobs: [jobs[0]], retryCount: 0, error: 'timeout', createdAt: new Date(NOW - 3 * 3600_000),
  }, updateTime: tick() });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-alert-idem-'));
  const jobsPath = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsPath, JSON.stringify(jobs));
  Object.assign(process.env, {
    JOB_ALERTS_JOBS_PATH: jobsPath, ENABLE_JOB_ALERTS: 'true', TODAY_ISO: TODAY,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    JOB_ALERT_LIVE_LINK_MANIFEST: 'off', JOB_ALERT_CANDIDATE_INDEX_MODE: 'on', JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE: '0',
    NEWSLETTER_SECRET: 'test-secret-for-hmac-links-0123456789', SKIP_NEWSLETTER_COOLDOWN: '',
  });
  delete process.env.TARGET_EMAIL;
  vi.resetModules();
  vi.doMock('../scripts/lib/email-cascade.mjs', () => ({
    getAvailableCascadeQuota: async () => 500,
    getProviderStats: () => [{ id: 'maileroo', configured: true, sent: sentMessages.length, benched: 0, remaining: 500, dailyLimit: 1000 }],
    BULK_PROVIDER_MIN_INTERVAL_MS: {},
    sendEmailCascade: async (emails: any[], opts: any) => {
      const sent: any[] = [];
      const failed: any[] = [];
      for (const item of emails) {
        const allowed = await opts.beforeProviderAttempt?.(item, 'maileroo');
        // Come il cascade vero: un intent rifiutato salta l'item (ne' inviato ne' fallito).
        if (allowed === false) continue;
        const result = { provider: 'maileroo', messageId: `idem-msg-${sentMessages.length + 1}`, ack: 'identified', scheduledFor: null };
        sentMessages.push({ to: item.recipient.email });
        await opts.onSent(item, result);
        sent.push({ ...item, ...result });
      }
      return { sent, accepted: sent, ambiguous: [], failed, providerBreakdown: { maileroo: { identified: sent.length, ambiguous: 0, persistFailed: 0 } } };
    },
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { throw new Error(`unexpected network call: ${url}`); }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ledgerModule: any = await import('../scripts/lib/alert-sent-jobs.mjs');
    jobDedupKey = ledgerModule.jobDedupKey;
    mergeDeliveryLedger = ledgerModule.mergeDeliveryLedger;
    // A t1 un altro processo scrive un intent AMBIGUOUS su TUTTI gli annunci, PRIMA
    // che la riattivazione (t2, senza precondizione) si applichi: il ledger in memoria
    // del sender e' quello di t0 e, con la precondizione su t2, sarebbe valutato come valido.
    commitHooks.push((ops) => {
      if (!ops.some((op) => op.path === alertPath(REACT) && op.data?.cadence_reactivated_at)) return;
      reactivationBatchSeen = true;
      const doc = store.get(alertPath(REACT))!;
      doc.data.deliveryLedger = mergeDeliveryLedger({}, jobs, Date.now(), 'ambiguous', {
        claimId: FOREIGN_CLAIM, provider: 'maileroo', reason: 'provider-attempt-intent',
      });
      doc.updateTime = tick();
      ledgerAfterReactivation = JSON.parse(JSON.stringify(doc.data.deliveryLedger));
    });
    sender = await import('../scripts/send-job-alerts.mjs');
    sender.__setFirestoreAdminForTest(db);
    await sender.runJobAlertsMain();
  } finally {
    log.mockRestore(); warn.mockRestore();
  }
}, 180_000);

afterAll(() => { vi.unstubAllGlobals(); });

describe('A2 — alert riattivato in questa run, intent concorrente fra caricamento e riattivazione', () => {
  it('lo scenario e\' reale: l alert decaduto e\' stato riattivato dal sender', () => {
    expect(reactivationBatchSeen).toBe(true);
    expect(store.get(alertPath(REACT))!.data.cadence_reactivated_at).toBeTruthy();
  });

  it('il primo intent ripiega sulla transazione (rilegge) e vede il marcatore altrui: NESSUN invio', () => {
    expect(sentMessages.map((m) => m.to)).not.toContain(REACT);
    expect(stats.txRuns).toBeGreaterThan(0);
  });

  it('il marcatore dell altro processo e\' intatto: non e\' stato sovrascritto dall intent di questa run', () => {
    const ledger = store.get(alertPath(REACT))!.data.deliveryLedger;
    for (const job of jobs) {
      expect(ledger[jobDedupKey(job)]).toMatchObject({ state: 'ambiguous', claimId: FOREIGN_CLAIM });
    }
    expect(ledger).toEqual(ledgerAfterReactivation);
    expect(store.get(alertPath(REACT))!.data.sentJobIds).toEqual({});
  });
});

describe('R5 — riga storica della coda retry senza deliveryState', () => {
  it('e\' messa in quarantena (non ignorata)', () => {
    const row = store.get('job_alert_retry_queue/legacy-row-1')!.data;
    expect(row.deliveryState).toBe('quarantined');
    expect(row.quarantineReason).toBe('legacy-retry-outcome-not-proven-definite');
  });

  it('lascia nel ledger dell alert il marcatore che blocca il reinvio, e non produce nessun invio', () => {
    const ledger = store.get(alertPath(LEGACY))!.data.deliveryLedger;
    expect(ledger[jobDedupKey(jobs[0])]).toMatchObject({ state: 'ambiguous', claimId: 'legacy-retry:legacy-row-1', reason: 'legacy-retry-outcome-not-proven-definite' });
    expect(sentMessages.map((m) => m.to)).not.toContain(LEGACY);
  });
});
