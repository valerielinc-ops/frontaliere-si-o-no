/**
 * Leve della newsletter (perf-plan email senders, C1, C2, C5, C6, C8).
 * Nessuna rete e nessun invio: Firestore e' un doppio, il sender si importa senza
 * eseguire main().
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeMailerooRefOnSent, MAILEROO_REF_COLLECTION } from '../functions/src/lib/mailerooRef.js';
import { recordJobEmailImpressions, resolveRankingImpressionsMode } from '../functions/src/lib/jobEmailRankingStore.js';
import {
  NON_TERMINAL_DELIVERY_STATUSES,
  loadResumeReceipts,
  resolveResumeReceiptScan,
} from '../scripts/lib/newsletter-resume-receipts.mjs';
import {
  JOB_EMAIL_RANKING_IMPRESSIONS_MODE,
  NEWSLETTER_PHASES,
  __setNewsletterDbForTest,
  claimNewsletterDeliveryIntent,
  emitNewsletterMetrics,
  newsletterMetrics,
  shouldPersistGlobalPreferredHour,
  shouldPersistRotation,
} from '../scripts/send-newsletter.mjs';
import { buildDeliveryDocId } from '../functions/src/lib/deliveryDocId.js';

const ROOT = path.resolve(__dirname, '..');
const senderSource = readFileSync(path.join(ROOT, 'scripts/send-newsletter.mjs'), 'utf8');

describe('C1: un solo maileroo_refs per email inviata', () => {
  it('il sender non scrive piu il riferimento: lo scrive la cascade, una volta', () => {
    expect(senderSource).not.toMatch(/recordMailerooRef\s*\(/);
    expect(senderSource).not.toMatch(/import[^;]*mailerooRef\.js/);
  });

  it('lo shim della cascade scrive lo stesso documento con i campi che il sender scriveva', async () => {
    const writes: Array<{ path: string; data: any; options: any }> = [];
    const db = {
      collection: (c1: string) => ({
        doc: (d1: string) => ({
          collection: (c2: string) => ({
            doc: (d2: string) => ({
              set: async (data: any, options: any) => { writes.push({ path: `${c1}/${d1}/${c2}/${d2}`, data, options }); },
            }),
          }),
        }),
      }),
    };
    const next = vi.fn();
    const onSent = makeMailerooRefOnSent(async () => db, { defaultCampaignId: 'newsletter-weekly', isJobAlert: false, next });
    const item = {
      recipient: { email: 'User1@Example.Test' },
      payload: { to: ['user1@example.test'], tags: [{ name: 'campaign_id', value: 'weekly_2026-11-09' }] },
    };
    await onSent(item, { provider: 'maileroo', messageId: 'msg-1' });
    await onSent(item, { provider: 'mailgun', messageId: 'msg-2' });

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`newsletter_subscribers/_meta_/${MAILEROO_REF_COLLECTION}/msg-1`);
    expect(writes[0].data).toMatchObject({ email: 'user1@example.test', campaign_id: 'weekly_2026-11-09', is_job_alert: false });
    expect(writes[0].options).toEqual({ merge: true });
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('C2: impression di ranking in modalita manifest', () => {
  const record = {
    deliveryId: 'd1', surface: 'newsletter', surfaceId: 'newsletter_weekly', newsletterId: 'weekly_2026-11-09',
    email: 'user1@example.test', variant: 'control', jobs: [{ slug: 'a', title: 'A', company: 'X' }, { slug: 'b', title: 'B', company: 'Y' }],
    sentAt: new Date('2026-11-10T04:00:00Z'),
  };
  function writeRecorder() {
    const writes: Array<{ collection: string; id: string }> = [];
    const db = {
      collection: (name: string) => ({ doc: (id: string) => ({ __name: name, id }) }),
      batch: () => ({
        set: (ref: any) => { writes.push({ collection: ref.__name, id: ref.id }); },
        commit: async () => [],
      }),
    };
    return { db, writes };
  }

  it('manifest: solo job_email_ranking_deliveries; full: anche stats ed eventi', async () => {
    const manifest = writeRecorder();
    await recordJobEmailImpressions(manifest.db, [record], { mode: 'manifest' });
    expect(new Set(manifest.writes.map((w) => w.collection))).toEqual(new Set(['job_email_ranking_deliveries']));

    const full = writeRecorder();
    await recordJobEmailImpressions(full.db, [record], { mode: 'full' });
    const collections = new Set(full.writes.map((w) => w.collection));
    expect(collections.has('job_email_ranking_deliveries')).toBe(true);
    expect(collections.size).toBeGreaterThan(1);
  });

  it('il sender passa la modalita risolta e la risolve come la jobalert', () => {
    expect(senderSource).toContain('recordJobEmailImpressions(db, rankingRecords, { mode: JOB_EMAIL_RANKING_IMPRESSIONS_MODE })');
    expect(['full', 'manifest']).toContain(JOB_EMAIL_RANKING_IMPRESSIONS_MODE);
    // Senza braccio di ranking attivo `auto` sceglie manifest; un valore ignoto ripiega su full.
    expect(resolveRankingImpressionsMode({ requested: 'manifest', config: {} })).toBe('manifest');
    expect(resolveRankingImpressionsMode({ requested: 'nonsense', config: {} })).toBe('full');
  });
});

describe('C5: scritture di _meta_ solo quando servono', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 10, 11, 4, 0, 0);

  it('l ora preferita non cambia: nessuna scrittura; cambia o manca: scrittura', () => {
    const stored = { global_preferred_send_hour_utc: 9, global_preferred_send_updated_at: new Date(NOW - 2 * DAY) };
    expect(shouldPersistGlobalPreferredHour(stored, { hourUtc: 9, sampleUsers: 3000 }, NOW)).toBe(false);
    expect(shouldPersistGlobalPreferredHour(stored, { hourUtc: 10, sampleUsers: 3000 }, NOW)).toBe(true);
    expect(shouldPersistGlobalPreferredHour({}, { hourUtc: 9, sampleUsers: 3000 }, NOW)).toBe(true);
    expect(shouldPersistGlobalPreferredHour(null, { hourUtc: 9, sampleUsers: 3000 }, NOW)).toBe(true);
    // null (nessun dato) e un valore: se e gia null non si riscrive.
    expect(shouldPersistGlobalPreferredHour(
      { global_preferred_send_hour_utc: null, global_preferred_send_updated_at: new Date(NOW - DAY) },
      { hourUtc: null, sampleUsers: 0 }, NOW,
    )).toBe(false);
  });

  it('il record informativo si rinfresca al piu una volta a settimana', () => {
    const old = { global_preferred_send_hour_utc: 9, global_preferred_send_updated_at: { toMillis: () => NOW - 8 * DAY } };
    expect(shouldPersistGlobalPreferredHour(old, { hourUtc: 9, sampleUsers: 1 }, NOW)).toBe(true);
    const noStamp = { global_preferred_send_hour_utc: 9 };
    expect(shouldPersistGlobalPreferredHour(noStamp, { hourUtc: 9, sampleUsers: 1 }, NOW)).toBe(true);
  });

  it('la rotazione delle finestre scorre solo alla prima run, mai in ripresa', () => {
    expect(shouldPersistRotation({ mode: 'send', confirmedSent: 120, isResume: false })).toBe(true);
    expect(shouldPersistRotation({ mode: 'send', confirmedSent: 120, isResume: true })).toBe(false);
    expect(shouldPersistRotation({ mode: 'send', confirmedSent: 0, isResume: false })).toBe(false);
    expect(shouldPersistRotation({ mode: 'test', confirmedSent: 1, isResume: false })).toBe(false);
    expect(shouldPersistRotation({ mode: 'dry-run', confirmedSent: 1, isResume: false })).toBe(false);
  });

  it('entrambe le rotazioni passano dalla stessa condizione', () => {
    const calls = senderSource.match(/shouldPersistRotation\(\{ mode, confirmedSent: confirmedSent\.length, isResume \}\)/g) || [];
    expect(calls).toHaveLength(2);
    expect(senderSource).toContain('shouldPersistGlobalPreferredHour(metaNow, globalPreferredHour, Date.now())');
  });
});

describe('C6: ricevute in ripresa', () => {
  function receiptDb({ terminal = [] as any[], all = [] as any[], failTargeted = false } = {}) {
    const calls: Array<{ filters: Array<[string, string, unknown]>; kind: string }> = [];
    const db = {
      calls,
      collectionGroup: (name: string) => {
        // Come Firestore, una query e immutabile: `where` ne restituisce una nuova.
        const make = (filters: Array<[string, string, unknown]>): any => ({
          where(field: string, op: string, value: unknown) { return make([...filters, [field, op, value]]); },
          async get() {
            const targeted = filters.some(([f]) => f === 'delivery_status');
            calls.push({ filters: [...filters], kind: targeted ? 'targeted' : 'full' });
            expect(name).toBe('campaign_deliveries');
            if (targeted && failTargeted) {
              const error: any = new Error('9 FAILED_PRECONDITION: The query requires an index');
              error.code = 9;
              throw error;
            }
            return { docs: targeted ? terminal : all };
          },
        });
        return make([]);
      },
    };
    return db as any;
  }

  it('la ripresa legge solo le ricevute non terminali della campagna (query ristretta)', async () => {
    const db = receiptDb({ terminal: [{ id: 'a' }], all: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const counts: Record<string, number> = {};
    const out = await loadResumeReceipts(db, 'weekly_2026-11-09', { metrics: { count: (n: string) => { counts[n] = (counts[n] || 0) + 1; } } });
    expect(out.strategy).toBe('targeted');
    expect(out.docs).toHaveLength(1);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].filters).toEqual([
      ['campaign_id', '==', 'weekly_2026-11-09'],
      ['delivery_status', 'in', [...NON_TERMINAL_DELIVERY_STATUSES]],
    ]);
    expect([...NON_TERMINAL_DELIVERY_STATUSES]).toEqual(['in_flight', 'pending', 'unknown']);
    expect(counts.resumeReceiptScanTargeted).toBe(1);
  });

  it('FAILED_PRECONDITION (indice in costruzione): ripiega sulla scansione di prima', async () => {
    const db = receiptDb({ terminal: [], all: [{ id: 'a' }, { id: 'b' }], failTargeted: true });
    const warn = vi.fn();
    const out = await loadResumeReceipts(db, 'weekly_2026-11-09', { warn });
    expect(out.strategy).toBe('fallback-full');
    expect(out.docs).toHaveLength(2);
    expect(db.calls.map((c: any) => c.kind)).toEqual(['targeted', 'full']);
    expect(warn).toHaveBeenCalled();
  });

  it('un errore diverso da FAILED_PRECONDITION risale (la ripresa non parte senza stato)', async () => {
    const db: any = {
      collectionGroup: () => {
        const query: any = { where: () => query, get: async () => { throw new Error('UNAVAILABLE'); } };
        return query;
      },
    };
    await expect(loadResumeReceipts(db, 'weekly_2026-11-09')).rejects.toThrow('UNAVAILABLE');
  });

  it('il kill switch full ripristina la scansione di tutte le ricevute', async () => {
    expect(resolveResumeReceiptScan(undefined)).toBe('targeted');
    expect(resolveResumeReceiptScan('full')).toBe('full');
    expect(resolveResumeReceiptScan(' FULL ')).toBe('full');
    expect(resolveResumeReceiptScan('whatever')).toBe('targeted');
    const db = receiptDb({ terminal: [{ id: 'a' }], all: [{ id: 'a' }, { id: 'b' }] });
    const out = await loadResumeReceipts(db, 'weekly_2026-11-09', { mode: 'full' });
    expect(out.strategy).toBe('full');
    expect(out.docs).toHaveLength(2);
  });

  it('il sender usa il caricamento ristretto e non ha piu la collectionGroup nuda', () => {
    expect(senderSource).toContain('loadResumeReceipts(db, campaignId');
    expect(senderSource).not.toMatch(/collectionGroup\('campaign_deliveries'\)\s*\.where\('campaign_id', '==', campaignId\)\s*\.get\(\)/);
  });

  it('una ricevuta accepted assente dal log non produce un secondo invio: il claim la rifiuta', async () => {
    const campaignId = 'weekly_2026-11-09';
    const email = 'user1@example.test';
    const deliveryId = buildDeliveryDocId(campaignId, email);
    const store = new Map<string, any>([
      [`${email}/${deliveryId}`, { delivery_status: 'accepted', message_id: 'm-1', accepted_at: new Date() }],
    ]);
    const sets: any[] = [];
    const fakeDb = {
      collection: () => ({
        doc: (docEmail: string) => ({
          collection: () => ({ doc: (id: string) => ({ key: `${docEmail}/${id}` }) }),
        }),
      }),
      runTransaction: async (fn: (tx: any) => Promise<boolean>) => fn({
        get: async (ref: any) => ({ exists: store.has(ref.key), data: () => store.get(ref.key) }),
        set: (ref: any, data: any) => { sets.push({ ref, data }); store.set(ref.key, data); },
      }),
    };
    __setNewsletterDbForTest(fakeDb);
    try {
      const item = { recipient: { email, locale: 'it' }, meta: { campaignId } };
      // Accepted (nel log o no): il provider non si chiama.
      await expect(claimNewsletterDeliveryIntent(item, 'maileroo', 'attempt-2')).resolves.toBe(false);
      expect(sets).toEqual([]);
      // Un destinatario senza ricevuta, invece, ottiene l'intent durevole prima del provider.
      const fresh = { recipient: { email: 'user2@example.test', locale: 'it' }, meta: { campaignId } };
      await expect(claimNewsletterDeliveryIntent(fresh, 'maileroo', 'attempt-2')).resolves.toBe(true);
      expect(sets).toHaveLength(1);
      expect(sets[0].data).toMatchObject({ delivery_status: 'in_flight', campaign_id: campaignId });
      // `retryable_failed` puo ripassare; `unknown` e `in_flight` di un altro tentativo no.
      for (const status of ['unknown', 'in_flight', 'pending', 'delivered', 'bounced']) {
        store.set(`${email}/${deliveryId}`, { delivery_status: status, delivery_attempt_id: 'other' });
        await expect(claimNewsletterDeliveryIntent(item, 'maileroo', 'attempt-2')).resolves.toBe(false);
      }
      store.set(`${email}/${deliveryId}`, { delivery_status: 'retryable_failed' });
      await expect(claimNewsletterDeliveryIntent(item, 'maileroo', 'attempt-2')).resolves.toBe(true);
    } finally {
      __setNewsletterDbForTest(undefined);
    }
  });
});

describe('C8: telemetria della newsletter', () => {
  it('dichiara le fasi del piano e le riporta in NEWSLETTER_METRICS', () => {
    for (const phase of ['resume', 'audience', 'alerts', 'matching', 'ai', 'send', 'post']) {
      expect([...NEWSLETTER_PHASES]).toContain(phase);
    }
    const lines: string[] = [];
    newsletterMetrics.enter('ai');
    newsletterMetrics.count('aiContentFrozenReused', 4);
    const snapshot = emitNewsletterMetrics({ mode: 'send', log: (line: string) => lines.push(line) });
    expect(snapshot?.phases.ai).toBeDefined();
    expect(lines[0]).toMatch(/^📊 NEWSLETTER_METRICS \{/);
    expect(JSON.parse(lines[0].replace('📊 NEWSLETTER_METRICS ', '')).counters.aiContentFrozenReused).toBe(4);
  });
});

describe('fatti settimanali condivisi tra sender e sonda (review round 1)', () => {
  it('il sender e la sonda importano le stesse funzioni da newsletter-weekly-facts.mjs', () => {
    const probe = readFileSync(path.join(ROOT, 'scripts/newsletter-content-probe.mjs'), 'utf8');
    expect(senderSource).toContain("from './lib/newsletter-weekly-facts.mjs'");
    for (const fn of ['getWeeklyFact', 'loadExchangeFacts']) {
      expect(senderSource).toContain(fn);
      expect(probe).toContain(fn);
    }
    expect(senderSource).not.toMatch(/^function getWeeklyFact|^function computeExchangeInsight|^async function fetchExchangeHistory/m);
  });

  it('loadExchangeFacts senza HTTP e senza storico risponde null (la sonda chiede un LLM)', async () => {
    const { loadExchangeFacts, getWeeklyFact } = await import('../scripts/lib/newsletter-weekly-facts.mjs');
    const db: any = {
      collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }),
    };
    await expect(loadExchangeFacts(db, { allowHttp: false })).resolves.toBeNull();
    // Deterministic in the clock: same week -> same fact.
    const monday = Date.UTC(2026, 10, 9, 3, 0, 0);
    expect(getWeeklyFact('it', monday)).toEqual(getWeeklyFact('it', monday + 3 * 24 * 3600 * 1000));
  });
});
