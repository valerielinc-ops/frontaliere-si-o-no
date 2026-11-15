/**
 * Claim, ricevuta e documento dell'iscritto della newsletter in WriteBatch
 * (perf-plan email senders, punto 3).
 *
 * L'invariante che questo file difende: per ogni email l'intent `in_flight` e'
 * durevole PRIMA della chiamata al provider, e un crash fra provider e finalize
 * lascia uno stato che blocca il retry. Nessun doppio invio, ne' nella stessa run
 * ne' in un rilancio. Si prova su un Firestore in memoria che applica DAVVERO
 * `create` (ALREADY_EXISTS), le precondizioni `lastUpdateTime` e l'atomicita' del
 * batch, con iniezione di guasti: precondizione fallita, batch di intent fallito,
 * esito incerto (il commit e' riuscito ma l'errore arriva), crash dopo l'intent e
 * crash dopo il provider.
 *
 * Le funzioni sotto test sono quelle VERE del sender (`persistDelivery`, il
 * bookkeeper costruito da `buildNewsletterBookkeeper`, `claimNewsletterDeliveryIntent`
 * come ripiego), collegate al fake con i seam `__set...ForTest`.
 *
 * Nessuna email reale (`@example.test`), nessuna rete.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setNewsletterBookkeeperForTest,
  __setNewsletterDbForTest,
  __setNewsletterFieldValueForTest,
  __setSubscriberSnapshotsForTest,
  buildNewsletterBookkeeper,
  claimNewsletterDeliveryIntent,
  newsletterMetrics,
  persistDelivery,
} from '../scripts/send-newsletter.mjs';
import { resolveBatchBookkeepingMode } from '../scripts/lib/newsletter-batch-bookkeeping.mjs';
import { buildDeliveryDocId } from '../functions/src/lib/deliveryDocId.js';

const ROOT = path.resolve(__dirname, '..');
const CAMPAIGN = 'weekly_2026-11-09';

class Stamp {
  constructor(public micros: number) {}
  isEqual(other: any) { return other instanceof Stamp && other.micros === this.micros; }
  toMillis() { return Math.floor(this.micros / 1000); }
}
type Doc = { data: any; updateTime: Stamp };

const FieldValueFake = {
  increment: (amount: number) => ({ __increment: amount }),
  serverTimestamp: () => ({ __serverTimestamp: true }),
};

function resolveValue(value: any, previous: any) {
  if (value && typeof value === 'object' && '__increment' in value) return (Number(previous) || 0) + value.__increment;
  if (value && typeof value === 'object' && '__serverTimestamp' in value) return new Date(0);
  return value;
}

function createFakeFirestore() {
  const docs = new Map<string, Doc>();
  let clock = 1_000_000_000;
  const stats = { txRuns: 0, txReads: 0, txWrites: 0, batches: 0, batchOps: 0, creates: 0, updates: 0 };
  const faults: { nextBatch: null | 'unavailable' | 'ambiguous-commit' | 'precondition' } = { nextBatch: null };
  const beforeBatchCommit: Array<() => void> = [];
  const nextTime = () => new Stamp((clock += 1000));

  const merge = (path: string, data: any, at: Stamp, replace = false) => {
    const existing = docs.get(path);
    const next = replace ? {} : { ...(existing?.data ?? {}) };
    for (const [key, raw] of Object.entries(data)) next[key] = resolveValue(raw, next[key]);
    docs.set(path, { data: next, updateTime: at });
  };

  const refOf = (docPath: string): any => ({
    path: docPath,
    id: docPath.split('/').pop(),
    set: async (data: any, options?: any) => { merge(docPath, data, nextTime(), !options?.merge); },
    collection: (name: string) => ({ doc: (id: string) => refOf(`${docPath}/${name}/${id}`) }),
  });
  const snapshotOf = (docPath: string) => {
    const found = docs.get(docPath);
    return { exists: Boolean(found), data: () => (found ? { ...found.data } : undefined), updateTime: found?.updateTime };
  };

  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => refOf(`${name}/${id}`) }),
    batch: () => {
      const ops: Array<{ kind: 'create' | 'update' | 'set'; path: string; data: any; precondition?: any; merge?: boolean }> = [];
      return {
        create(ref: any, data: any) { ops.push({ kind: 'create', path: ref.path, data }); return this; },
        update(ref: any, data: any, precondition?: any) { ops.push({ kind: 'update', path: ref.path, data, precondition }); return this; },
        set(ref: any, data: any, options?: any) { ops.push({ kind: 'set', path: ref.path, data, merge: Boolean(options?.merge) }); return this; },
        async commit() {
          stats.batches += 1;
          stats.batchOps += ops.length;
          while (beforeBatchCommit.length) beforeBatchCommit.shift()!();
          const fault = faults.nextBatch;
          faults.nextBatch = null;
          if (fault === 'unavailable') throw Object.assign(new Error('UNAVAILABLE: backend'), { code: 14 });
          // Il batch e' atomico: si validano TUTTE le condizioni prima di scrivere.
          const created = new Set<string>();
          for (const op of ops) {
            const found = docs.get(op.path);
            if (op.kind === 'create' && (found || created.has(op.path))) {
              throw Object.assign(new Error('6 ALREADY_EXISTS: Document already exists'), { code: 6 });
            }
            if (op.kind === 'create') created.add(op.path);
            if (op.kind === 'update' && !found) throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 });
            if (op.precondition?.lastUpdateTime && (!found || !found.updateTime.isEqual(op.precondition.lastUpdateTime))) {
              throw Object.assign(new Error('9 FAILED_PRECONDITION: the document was modified'), { code: 9 });
            }
          }
          if (fault === 'precondition') throw Object.assign(new Error('9 FAILED_PRECONDITION: injected'), { code: 9 });
          const at = nextTime();
          for (const op of ops) {
            if (op.kind === 'create') { stats.creates += 1; merge(op.path, op.data, at, true); }
            else if (op.kind === 'update') { stats.updates += 1; merge(op.path, op.data, at); }
            else merge(op.path, op.data, at, !op.merge);
          }
          if (fault === 'ambiguous-commit') throw Object.assign(new Error('4 DEADLINE_EXCEEDED after commit'), { code: 4 });
          return ops.map(() => ({ writeTime: at }));
        },
      };
    },
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      stats.txRuns += 1;
      const writes: Array<{ path: string; data: any; merge: boolean }> = [];
      const tx = {
        get: async (ref: any) => { stats.txReads += 1; return snapshotOf(ref.path); },
        set: (ref: any, data: any, options?: any) => { stats.txWrites += 1; writes.push({ path: ref.path, data, merge: Boolean(options?.merge) }); },
      };
      const result = await callback(tx);
      const at = nextTime();
      for (const write of writes) merge(write.path, write.data, at, !write.merge);
      return result;
    },
  };
  return {
    db, docs, stats, faults, beforeBatchCommit,
    seed: (docPath: string, data: any) => { docs.set(docPath, { data, updateTime: nextTime() }); return docs.get(docPath)!.updateTime; },
    touch: (docPath: string, data: any) => merge(docPath, data, nextTime()),
    read: (docPath: string) => docs.get(docPath)?.data,
    updateTimeOf: (docPath: string) => docs.get(docPath)?.updateTime,
  };
}

const emailOf = (n: number) => `user${n}@example.test`;
const receiptPath = (email: string) => `newsletter_subscribers/${email}/campaign_deliveries/${buildDeliveryDocId(CAMPAIGN, email)}`;
const subscriberPath = (email: string) => `newsletter_subscribers/${email}`;

function makeItem(n: number) {
  return {
    recipient: { email: emailOf(n), locale: 'it', sourceChannel: 'web' },
    meta: { campaignId: CAMPAIGN, discoveryArticleId: 'article-1', isOperatorVerification: false },
  };
}

type Env = ReturnType<typeof createFakeFirestore>;

/** Una «cascade» minima: intent prima del provider, provider, poi la ricevuta. */
async function runCascade(
  env: Env,
  items: any[],
  attemptId: string,
  options: {
    bookkeeper?: any;
    provider?: (item: any) => void;
    crashAfterIntent?: (item: any) => boolean;
    crashAfterProvider?: (item: any) => boolean;
    providerName?: string;
  } = {},
) {
  const bookkeeper = options.bookkeeper ?? null;
  // Come main(): il bookkeeper che prende gli intent e' lo stesso che scrive le ricevute.
  __setNewsletterBookkeeperForTest(bookkeeper);
  const calls: string[] = [];
  const providerSawIntent: boolean[] = [];
  const skipped: string[] = [];
  const crashed: string[] = [];
  await Promise.all(items.map(async (item) => {
    const email = item.recipient.email;
    const granted = bookkeeper
      ? await bookkeeper.requestIntent(item, options.providerName ?? 'maileroo', attemptId)
      : await claimNewsletterDeliveryIntent(item, options.providerName ?? 'maileroo', attemptId);
    if (!granted) { skipped.push(email); return; }
    if (options.crashAfterIntent?.(item)) { crashed.push(email); return; }
    // La chiamata al provider: l'intent deve gia' esistere nel documento.
    providerSawIntent.push(env.read(receiptPath(email))?.delivery_status === 'in_flight');
    calls.push(email);
    options.provider?.(item);
    if (options.crashAfterProvider?.(item)) { crashed.push(email); return; }
    await persistDelivery(item.recipient, `msg-${email}`, {
      ...item.meta, provider: options.providerName ?? 'maileroo', deliveryAttemptId: attemptId, variant: 'A', subject: 'Oggetto',
    }, bookkeeper ? item : null);
  }));
  return { calls, providerSawIntent, skipped, crashed };
}

function seedSubscribers(env: Env, count: number, extra: Record<string, unknown> = {}) {
  const entries: Array<[string, { data: any; updateTime: Stamp }]> = [];
  for (let n = 1; n <= count; n += 1) {
    const data = { email: emailOf(n), status: 'confirmed', send_count: 4, open_count: 1, engagement_score: 20, engagement_level: 'cold', ...extra };
    const updateTime = env.seed(subscriberPath(emailOf(n)), data);
    entries.push([emailOf(n), { data, updateTime }]);
  }
  __setSubscriberSnapshotsForTest(entries);
}

const counters = () => newsletterMetrics.snapshot().counters as Record<string, number | string>;
const stripVolatile = (doc: any) => {
  const copy = { ...doc };
  for (const key of ['accepted_at', 'sent_at', 'attempted_at', 'updated_at', 'last_sent_at', 'engagement_updated_at']) delete copy[key];
  return copy;
};

let env: Env;
beforeEach(() => {
  env = createFakeFirestore();
  __setNewsletterDbForTest(env.db);
  __setNewsletterFieldValueForTest(FieldValueFake);
  __setNewsletterBookkeeperForTest(null);
  __setSubscriberSnapshotsForTest([]);
});
afterEach(() => {
  __setNewsletterDbForTest(undefined);
  __setNewsletterFieldValueForTest(undefined);
  __setNewsletterBookkeeperForTest(null);
  __setSubscriberSnapshotsForTest([]);
});

describe('configurazione', () => {
  it('NEWSLETTER_BATCH_BOOKKEEPING: `on` di default, `off` solo se esplicito (kill switch)', () => {
    expect(resolveBatchBookkeepingMode(undefined)).toBe('on');
    expect(resolveBatchBookkeepingMode('')).toBe('on');
    expect(resolveBatchBookkeepingMode('garbage')).toBe('on');
    expect(resolveBatchBookkeepingMode('ON')).toBe('on');
    expect(resolveBatchBookkeepingMode(' off ')).toBe('off');
  });
});

describe('percorso normale: letture tolte, scritture identiche', () => {
  it('N email: zero letture di transazione, intent e ricevuta in batch, provider chiamato una volta ciascuna', async () => {
    seedSubscribers(env, 10);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    __setNewsletterBookkeeperForTest(bookkeeper);
    const before = { ...counters() };
    const items = Array.from({ length: 10 }, (_, i) => makeItem(i + 1));
    const result = await runCascade(env, items, 'attempt-1', { bookkeeper });
    expect(result.calls.sort()).toEqual(items.map((i) => i.recipient.email).sort());
    expect(result.providerSawIntent.every(Boolean)).toBe(true);
    // Nessuna transazione: tutte le letture del percorso per email sono sparite.
    expect(env.stats.txRuns).toBe(0);
    expect(env.stats.txReads).toBe(0);
    expect(env.stats.creates).toBe(10);
    // Ricevuta + iscritto: 20 update in batch.
    expect(env.stats.updates).toBe(20);
    for (const item of items) {
      expect(env.read(receiptPath(item.recipient.email))).toMatchObject({
        delivery_status: 'accepted', message_id: `msg-${item.recipient.email}`, delivery_attempt_id: 'attempt-1', provider: 'maileroo',
      });
      expect(env.read(subscriberPath(item.recipient.email))).toMatchObject({ send_count: 5 });
    }
    const after = counters();
    expect(Number(after.bookkeepingIntentBatches) - Number(before.bookkeepingIntentBatches || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(after.bookkeepingFinalizeBatches) - Number(before.bookkeepingFinalizeBatches || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(after.bookkeepingSubscriberBatches) - Number(before.bookkeepingSubscriberBatches || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(after.bookkeepingIntentTxFallback || 0) - Number(before.bookkeepingIntentTxFallback || 0)).toBe(0);
  });

  it('con il bookkeeper spento le scritture sono quelle di oggi: 3 transazioni per email, stessi documenti', async () => {
    seedSubscribers(env, 6);
    const items = Array.from({ length: 6 }, (_, i) => makeItem(i + 1));
    const off = await runCascade(env, items, 'attempt-1', { bookkeeper: null });
    expect(off.calls).toHaveLength(6);
    expect(env.stats.batches).toBe(0);
    expect(env.stats.txRuns).toBe(18); // claim + ricevuta + iscritto, per email
    expect(env.stats.txReads).toBe(18);
    const offDocs = items.map((item) => ({
      receipt: stripVolatile(env.read(receiptPath(item.recipient.email))),
      subscriber: stripVolatile(env.read(subscriberPath(item.recipient.email))),
    }));

    // Stessa scenario col bookkeeper acceso: i documenti finali sono identici.
    const second = createFakeFirestore();
    __setNewsletterDbForTest(second.db);
    seedSubscribers(second, 6);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    __setNewsletterBookkeeperForTest(bookkeeper);
    await runCascade(second, items.map((i) => makeItem(Number(i.recipient.email.match(/\d+/)![0]))), 'attempt-1', { bookkeeper });
    const onDocs = items.map((item) => ({
      receipt: stripVolatile(second.read(receiptPath(item.recipient.email))),
      subscriber: stripVolatile(second.read(subscriberPath(item.recipient.email))),
    }));
    expect(onDocs).toEqual(offDocs);
  });
});

describe('crash e rilanci: nessun doppio invio', () => {
  it('crash DOPO l\'intent e PRIMA del provider: l\'intent resta e il rilancio non invia', async () => {
    seedSubscribers(env, 4);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    const items = Array.from({ length: 4 }, (_, i) => makeItem(i + 1));
    const first = await runCascade(env, items, 'attempt-1', { bookkeeper, crashAfterIntent: () => true });
    expect(first.crashed).toHaveLength(4);
    expect(first.calls).toEqual([]);
    for (const item of items) expect(env.read(receiptPath(item.recipient.email))).toMatchObject({ delivery_status: 'in_flight', delivery_attempt_id: 'attempt-1' });

    // Rilancio nello stesso giorno (nuovo attemptId, nuova run): l'intent in_flight blocca.
    const rerunBookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    const second = await runCascade(env, items.map((i) => makeItem(Number(i.recipient.email.match(/\d+/)![0]))), 'attempt-2', { bookkeeper: rerunBookkeeper });
    expect(second.calls).toEqual([]);
    expect(second.skipped).toHaveLength(4);
  });

  it('crash DOPO il provider e PRIMA del finalize: stato ambiguo, nessun reinvio al rilancio', async () => {
    seedSubscribers(env, 4);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    const items = Array.from({ length: 4 }, (_, i) => makeItem(i + 1));
    const first = await runCascade(env, items, 'attempt-1', { bookkeeper, crashAfterProvider: () => true });
    expect(first.calls).toHaveLength(4);
    // Il provider ha accettato, la ricevuta no: l'intent in_flight e' tutto cio' che resta.
    for (const item of items) expect(env.read(receiptPath(item.recipient.email))?.delivery_status).toBe('in_flight');
    const second = await runCascade(env, items.map((i) => makeItem(Number(i.recipient.email.match(/\d+/)![0]))), 'attempt-2', {
      bookkeeper: buildNewsletterBookkeeper({ warn: () => {} }),
    });
    expect(second.calls).toEqual([]);
    expect(second.skipped).toHaveLength(4);
  });

  it('rilancio dello stesso giorno su una run completa: nessun invio', async () => {
    seedSubscribers(env, 6);
    const items = () => Array.from({ length: 6 }, (_, i) => makeItem(i + 1));
    const first = await runCascade(env, items(), 'attempt-1', { bookkeeper: buildNewsletterBookkeeper({ warn: () => {} }) });
    expect(first.calls).toHaveLength(6);
    const second = await runCascade(env, items(), 'attempt-2', { bookkeeper: buildNewsletterBookkeeper({ warn: () => {} }) });
    expect(second.calls).toEqual([]);
    expect(second.skipped).toHaveLength(6);
    // E nemmeno col bookkeeper spento (kill switch dopo un lancio con batch): il claim legge la ricevuta.
    const third = await runCascade(env, items(), 'attempt-3', { bookkeeper: null });
    expect(third.calls).toEqual([]);
  });

  it('la ricevuta `retryable_failed` puo ripassare, anche se la richiesta e\' sola nel suo gruppo', async () => {
    const email = emailOf(1);
    env.seed(receiptPath(email), { delivery_status: 'retryable_failed', delivery_attempt_id: 'old', email, campaign_id: CAMPAIGN });
    seedSubscribers(env, 1);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    const result = await runCascade(env, [makeItem(1)], 'attempt-2', { bookkeeper });
    // ALREADY_EXISTS non vuol dire «gia' reclamato»: decide la transazione, che la lascia passare.
    expect(result.calls).toEqual([email]);
    expect(env.read(receiptPath(email))).toMatchObject({ delivery_status: 'accepted', delivery_attempt_id: 'attempt-2' });
    expect(Number(counters().bookkeepingIntentPreconditionFailed)).toBeGreaterThanOrEqual(1);
  });

  it('un gruppo con una ricevuta gia\' accettata e altre nuove: atomico, tutte ripiegano e nessuna invia senza claim', async () => {
    const taken = emailOf(3);
    env.seed(receiptPath(taken), { delivery_status: 'accepted', message_id: 'old-msg', delivery_attempt_id: 'old', email: taken, campaign_id: CAMPAIGN });
    seedSubscribers(env, 5);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    const items = Array.from({ length: 5 }, (_, i) => makeItem(i + 1));
    const result = await runCascade(env, items, 'attempt-2', { bookkeeper });
    expect(result.skipped).toEqual([taken]);
    expect(result.calls).toHaveLength(4);
    expect(result.providerSawIntent.every(Boolean)).toBe(true);
    // La ricevuta gia' accettata e' intatta.
    expect(env.read(receiptPath(taken))).toMatchObject({ delivery_status: 'accepted', message_id: 'old-msg', delivery_attempt_id: 'old' });
  });
});

describe('guasti del batch: ripiego sulla transazione di oggi', () => {
  it('batch di intent fallito: tutti i claim del gruppo ripiegano e nessuno invia senza claim', async () => {
    seedSubscribers(env, 5);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    env.faults.nextBatch = 'unavailable';
    const items = Array.from({ length: 5 }, (_, i) => makeItem(i + 1));
    const result = await runCascade(env, items, 'attempt-1', { bookkeeper });
    expect(result.calls).toHaveLength(5);
    // Al momento della chiamata al provider ogni intent era gia' scritto.
    expect(result.providerSawIntent.every(Boolean)).toBe(true);
    expect(Number(counters().bookkeepingIntentBatchError)).toBeGreaterThanOrEqual(1);
    expect(Number(counters().bookkeepingIntentTxFallback)).toBeGreaterThanOrEqual(5);
    for (const item of items) expect(env.read(receiptPath(item.recipient.email))?.delivery_status).toBe('accepted');
  });

  it('esito incerto (il create e\' riuscito ma l\'errore arriva): la transazione riconosce l\'intent nostro, un solo invio', async () => {
    seedSubscribers(env, 3);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    env.faults.nextBatch = 'ambiguous-commit';
    const items = Array.from({ length: 3 }, (_, i) => makeItem(i + 1));
    const result = await runCascade(env, items, 'attempt-1', { bookkeeper });
    expect(result.calls).toHaveLength(3);
    expect(new Set(result.calls).size).toBe(3);
    for (const item of items) expect(env.read(receiptPath(item.recipient.email))?.delivery_status).toBe('accepted');
  });

  it('precondizione fallita sul finalize (un webhook ha toccato la ricevuta): ripiega, conserva `delivered` e il message id del webhook', async () => {
    seedSubscribers(env, 2);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    const items = [makeItem(1), makeItem(2)];
    const result = await runCascade(env, items, 'attempt-1', {
      bookkeeper,
      // Il webhook del provider scrive sul documento fra la chiamata e la ricevuta.
      provider: (item) => env.touch(receiptPath(item.recipient.email), { delivery_status: 'delivered', message_id: `hook-${item.recipient.email}` }),
    });
    expect(result.calls).toHaveLength(2);
    expect(Number(counters().bookkeepingFinalizePreconditionFailed)).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(env.read(receiptPath(item.recipient.email))).toMatchObject({
        delivery_status: 'delivered', // la transazione lo conserva, come oggi
        message_id: `msg-${item.recipient.email}`,
        delivery_attempt_id: 'attempt-1',
      });
    }
  });

  it('batch della ricevuta fallito: ogni ricevuta ripiega sulla transazione e il documento e\' lo stesso', async () => {
    seedSubscribers(env, 3);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    const items = [makeItem(1), makeItem(2), makeItem(3)];
    let injected = false;
    const result = await runCascade(env, items, 'attempt-1', {
      bookkeeper,
      provider: () => { if (!injected) { injected = true; env.faults.nextBatch = 'unavailable'; } },
    });
    expect(result.calls).toHaveLength(3);
    for (const item of items) expect(env.read(receiptPath(item.recipient.email))).toMatchObject({ delivery_status: 'accepted', message_id: `msg-${item.recipient.email}` });
    expect(Number(counters().bookkeepingFinalizeTxFallback)).toBeGreaterThanOrEqual(1);
  });

  it('un secondo provider per la stessa email riscrive l\'intent con la transazione e il finalize non usa lo snapshot del batch', async () => {
    seedSubscribers(env, 1);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    const item = makeItem(1);
    expect(await bookkeeper.requestIntent(item, 'maileroo', 'attempt-1')).toBe(true);
    expect(env.read(receiptPath(emailOf(1)))).toMatchObject({ provider: 'maileroo', delivery_status: 'in_flight' });
    // Stesso provider: nessuna scrittura in piu'.
    const writesBefore = env.stats.creates + env.stats.txWrites;
    expect(await bookkeeper.requestIntent(item, 'maileroo', 'attempt-1')).toBe(true);
    expect(env.stats.creates + env.stats.txWrites).toBe(writesBefore);
    // Fallback di cascade su un altro provider.
    expect(await bookkeeper.requestIntent(item, 'mailgun', 'attempt-1')).toBe(true);
    expect(env.read(receiptPath(emailOf(1)))).toMatchObject({ provider: 'mailgun', attempted_provider: 'mailgun', delivery_status: 'in_flight' });
    __setNewsletterBookkeeperForTest(bookkeeper);
    await persistDelivery(item.recipient, 'msg-1', { ...item.meta, provider: 'mailgun', deliveryAttemptId: 'attempt-1' }, item);
    expect(env.read(receiptPath(emailOf(1)))).toMatchObject({ delivery_status: 'accepted', provider: 'mailgun' });
  });
});

describe('documento dell\'iscritto', () => {
  it('snapshot ancora valido: contatore e punteggio scritti in batch, uguali a quelli della transazione', async () => {
    seedSubscribers(env, 1);
    __setNewsletterBookkeeperForTest(buildNewsletterBookkeeper({ warn: () => {} }));
    const item = makeItem(1);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    __setNewsletterBookkeeperForTest(bookkeeper);
    await runCascade(env, [item], 'attempt-1', { bookkeeper });
    const viaBatch = stripVolatile(env.read(subscriberPath(emailOf(1))));

    const twin = createFakeFirestore();
    __setNewsletterDbForTest(twin.db);
    seedSubscribers(twin, 1);
    __setNewsletterBookkeeperForTest(null);
    await runCascade(twin, [makeItem(1)], 'attempt-1', { bookkeeper: null });
    expect(viaBatch).toEqual(stripVolatile(twin.read(subscriberPath(emailOf(1)))));
  });

  it('il documento e\' cambiato dopo lo snapshot (un webhook di apertura): ripiega sulla transazione e non perde l\'evento', async () => {
    seedSubscribers(env, 1);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    __setNewsletterBookkeeperForTest(bookkeeper);
    env.touch(subscriberPath(emailOf(1)), { open_count: 7 });
    const item = makeItem(1);
    await runCascade(env, [item], 'attempt-1', { bookkeeper });
    // Il contatore di aperture arrivato dopo lo snapshot c'e' ancora: nessuna scrittura da snapshot stantio.
    expect(env.read(subscriberPath(emailOf(1)))).toMatchObject({ open_count: 7, send_count: 5 });
    expect(Number(counters().bookkeepingSubscriberPreconditionFailed)).toBeGreaterThanOrEqual(1);
    expect(Number(counters().bookkeepingSubscriberTxFallback)).toBeGreaterThanOrEqual(1);
  });

  it('senza snapshot (scansione non fatta in questa run) si usa la transazione', async () => {
    seedSubscribers(env, 1);
    __setSubscriberSnapshotsForTest([]);
    const bookkeeper = buildNewsletterBookkeeper({ warn: () => {} });
    __setNewsletterBookkeeperForTest(bookkeeper);
    const txRunsBefore = env.stats.txRuns;
    await runCascade(env, [makeItem(1)], 'attempt-1', { bookkeeper });
    expect(env.stats.txRuns - txRunsBefore).toBe(1); // solo quella dell'iscritto
    expect(env.read(subscriberPath(emailOf(1)))).toMatchObject({ send_count: 5 });
  });
});

describe('la ripresa (campaign_sends) e il perimetro del sorgente', () => {
  const senderSource = readFileSync(path.join(ROOT, 'scripts/send-newsletter.mjs'), 'utf8');
  const bookkeepingSource = readFileSync(path.join(ROOT, 'scripts/lib/newsletter-batch-bookkeeping.mjs'), 'utf8');

  it('il log di ripresa si scrive ancora dopo la ricevuta, per invio confermato', () => {
    const start = senderSource.indexOf('const persistSent = async');
    const end = senderSource.indexOf('// Single provider mode', start);
    const block = senderSource.slice(start, end);
    expect(block.indexOf('await persistDelivery(')).toBeGreaterThan(-1);
    expect(block.indexOf('await onDelivered(')).toBeGreaterThan(block.indexOf('await persistDelivery('));
  });

  it('il bookkeeper non tocca il log di ripresa ne la scansione delle ricevute', () => {
    expect(bookkeepingSource).not.toMatch(/campaignResumeLog|campaign_sends|loadResumeReceipts/);
  });

  it('il flag NEWSLETTER_BATCH_BOOKKEEPING e letto una sola volta, dal sender, con default `on`', () => {
    expect(senderSource).toContain("resolveBatchBookkeepingMode(process.env.NEWSLETTER_BATCH_BOOKKEEPING)");
  });

  it('senza db o fuori dalla modalita send il bookkeeper non e installato', () => {
    expect(senderSource).toMatch(/activeBookkeeper = mode === 'send' && db && bookkeepingMode === 'on'/);
  });
});
