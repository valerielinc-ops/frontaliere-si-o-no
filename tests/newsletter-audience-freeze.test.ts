/**
 * Pubblico congelato per campagna + delta (perf-plan email senders, punto 2).
 *
 * L'invariante che questo file difende: il pubblico che una ripresa decide di
 * raggiungere e' lo STESSO insieme che la scansione piena produrrebbe (meno chi ha gia'
 * un invio o una ricevuta), e consenso e soppressione si rifanno a ogni run su cio' che
 * si rilegge. Se i due insiemi divergono, `shadow` lo conta e `full` decide.
 *
 * Si prova su un Firestore in memoria con `get()` della collection, `getAll`, query
 * `where` per tipo (Timestamp e stringa non si confrontano fra loro, come in Firestore),
 * `batch` e `create`, con la funzione VERA del sender (`resolveSendAudience`) e il
 * predicato VERO di idoneita' (fetchSubscribers). Nessuna email reale (`@example.test`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setNewsletterDbForTest, resolveSendAudience } from '../scripts/send-newsletter.mjs';
import { createSenderMetrics } from '../scripts/lib/sender-metrics.mjs';
import {
  AUDIENCE_COLLECTION,
  AUDIENCE_PAGE_SIZE,
  DEFAULT_AUDIENCE_SCAN_MODE,
  compareAudiences,
  hashAudienceIds,
  loadFrozenAudience,
  resolveAudienceScanMode,
  saveFrozenAudience,
  shortIdHash,
} from '../scripts/lib/newsletter-audience-freeze.mjs';

const ROOT = path.resolve(__dirname, '..');
const CAMPAIGN = 'weekly_2026-11-09';
const DAY = 24 * 60 * 60 * 1000;
const emailOf = (n: number) => `user${String(n).padStart(5, '0')}@example.test`;

// ── Firestore in memoria ───────────────────────────────────────────────────
type Row = Record<string, any>;
function createFakeFirestore() {
  const collections = new Map<string, Map<string, Row>>();
  const stats = {
    fullScans: 0, getAllRefs: 0, getAllCalls: 0, queries: 0, queryDocs: 0, batches: 0,
    writesTo: new Map<string, number>(), scanDocs: 0,
  };
  const faults = { rejectQueries: false, failBatch: false };
  let tick = 0;
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const snap = (name: string, id: string) => {
    const row = col(name).get(id);
    return { id, exists: row !== undefined, data: () => (row ? { ...row } : undefined), updateTime: row ? { id: `${name}/${id}@${++tick}` } : undefined };
  };
  const noteWrite = (name: string) => stats.writesTo.set(name, (stats.writesTo.get(name) ?? 0) + 1);
  const compare = (value: any, bound: any) => {
    if (value instanceof Date && bound instanceof Date) return value.getTime() >= bound.getTime();
    if (typeof value === 'string' && typeof bound === 'string') return value >= bound;
    return false; // tipi diversi non si confrontano, come in Firestore
  };
  const db: any = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        path: `${name}/${id}`, id, collectionName: name,
        get: async () => snap(name, id),
        create: async (data: Row) => {
          if (col(name).has(id)) throw Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 });
          col(name).set(id, data); noteWrite(name);
        },
        set: async (data: Row) => { col(name).set(id, data); noteWrite(name); },
      }),
      get: async () => {
        stats.fullScans += 1;
        const docs = [...col(name).keys()].sort().map((id) => snap(name, id));
        stats.scanDocs += docs.length;
        return { docs };
      },
      where: (field: string, op: string, bound: any) => ({
        get: async () => {
          stats.queries += 1;
          if (faults.rejectQueries) throw Object.assign(new Error('9 FAILED_PRECONDITION: index'), { code: 9 });
          if (op !== '>=') throw new Error(`unsupported op ${op}`);
          const docs = [...col(name).entries()].filter(([, row]) => compare(row[field], bound)).map(([id]) => snap(name, id));
          stats.queryDocs += docs.length;
          return { docs };
        },
      }),
    }),
    getAll: async (...refs: any[]) => {
      stats.getAllCalls += 1;
      stats.getAllRefs += refs.length;
      return refs.map((ref) => snap(ref.collectionName, ref.id));
    },
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set(ref: any, data: Row) { ops.push(() => { col(ref.collectionName).set(ref.id, data); noteWrite(ref.collectionName); }); return this; },
        async commit() {
          stats.batches += 1;
          if (faults.failBatch) throw new Error('UNAVAILABLE');
          ops.forEach((op) => op());
        },
      };
    },
  };
  return {
    db, stats, faults,
    put: (id: string, row: Row) => { col('newsletter_subscribers').set(id, row); },
    remove: (id: string) => { col('newsletter_subscribers').delete(id); },
    raw: (name: string, id: string) => col(name).get(id),
    names: (name: string) => [...col(name).keys()],
  };
}

type Env = ReturnType<typeof createFakeFirestore>;
const PAST = new Date(Date.now() - 20 * DAY);
const FUTURE = () => new Date(Date.now() + 5 * 60 * 1000);

const eligibleRow = (n: number, extra: Row = {}): Row => ({
  email: emailOf(n), status: 'confirmed', locale: 'it', consent_act: 'typed_email_submit',
  confirmed_at: PAST, created_at: PAST, send_count: 4, engagement_score: 20, engagement_level: 'cold', ...extra,
});

function metricsAndLogs() {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    metrics: createSenderMetrics({ tag: 'NEWSLETTER', phases: ['audience'] }),
    log: (line: string) => logs.push(line),
    warn: (line: string) => warns.push(line),
    logs, warns,
  };
}
const emailsOf = (audience: any[]) => audience.map((s) => s.email).sort();
const counters = (m: any) => m.snapshot().counters as Record<string, any>;

let env: Env;
beforeEach(() => { env = createFakeFirestore(); __setNewsletterDbForTest(env.db); });
afterEach(() => { __setNewsletterDbForTest(undefined); });

function seedAudience(count: number, extra: (n: number) => Row = () => ({})) {
  for (let n = 1; n <= count; n += 1) env.put(emailOf(n), eligibleRow(n, extra(n)));
}
const run = (mode: 'full' | 'shadow' | 'frozen', attempted: Iterable<string> = []) => {
  const io = metricsAndLogs();
  return resolveSendAudience(CAMPAIGN, new Set(attempted), { mode, metrics: io.metrics, log: io.log, warn: io.warn })
    .then((audience: any) => ({ audience, ...io }));
};

// ── configurazione ─────────────────────────────────────────────────────────
describe('NEWSLETTER_AUDIENCE_SCAN_MODE', () => {
  it('`shadow` di default e per ogni valore sconosciuto; `full` e `frozen` solo se espliciti', () => {
    expect(DEFAULT_AUDIENCE_SCAN_MODE).toBe('shadow');
    expect(resolveAudienceScanMode(undefined)).toBe('shadow');
    expect(resolveAudienceScanMode('')).toBe('shadow');
    expect(resolveAudienceScanMode('garbage')).toBe('shadow');
    expect(resolveAudienceScanMode(' FULL ')).toBe('full');
    expect(resolveAudienceScanMode('Frozen')).toBe('frozen');
    expect(resolveAudienceScanMode('shadow')).toBe('shadow');
  });
});

// ── full = oggi ────────────────────────────────────────────────────────────
describe('full: la scansione di oggi, senza toccare nient\'altro', () => {
  it('legge tutta la collection e non legge ne scrive il pubblico congelato', async () => {
    seedAudience(12);
    const { audience, metrics } = await run('full');
    expect(emailsOf(audience)).toEqual(Array.from({ length: 12 }, (_, i) => emailOf(i + 1)));
    expect(env.stats.fullScans).toBe(1);
    expect(env.stats.getAllCalls).toBe(0);
    expect(env.stats.queries).toBe(0);
    expect(env.stats.writesTo.size).toBe(0);
    expect(counters(metrics).audienceScanMode).toBe('full');
  });
});

// ── prima run: scansione piena + congelamento ──────────────────────────────
describe('prima run della campagna', () => {
  for (const mode of ['shadow', 'frozen'] as const) {
    it(`${mode}: la scansione piena decide e il pubblico si congela in pagine, solo in newsletter_campaign_audience`, async () => {
      seedAudience(10);
      env.put(emailOf(11), eligibleRow(11, { status: 'unsubscribed' }));
      const { audience, metrics, logs } = await run(mode);
      expect(emailsOf(audience)).toEqual(Array.from({ length: 10 }, (_, i) => emailOf(i + 1)));
      expect(env.stats.fullScans).toBe(1);
      // Scritture: solo il pubblico congelato. Mai in newsletter_subscribers.
      expect([...env.stats.writesTo.keys()]).toEqual([AUDIENCE_COLLECTION]);
      expect(env.stats.writesTo.has('newsletter_subscribers')).toBe(false);
      const header = env.raw(AUDIENCE_COLLECTION, CAMPAIGN)!;
      expect(header).toMatchObject({ kind: 'header', campaign_id: CAMPAIGN, total: 10, page_count: 1 });
      expect(header.expires_at.getTime()).toBeGreaterThan(Date.now() + 14 * DAY);
      expect(header.snapshot_at).toBeInstanceOf(Date);
      expect(counters(metrics)).toMatchObject({ audienceSource: 'full-first-run', audienceFrozenSaved: 1, audienceFrozenSize: 10 });
      expect(logs.join('\n')).not.toContain('@');
    });
  }

  it('il pubblico congelato contiene solo gli idonei: gli esclusi non ci sono', async () => {
    seedAudience(5);
    env.put(emailOf(6), eligibleRow(6, { status: 'bounced' }));
    env.put(emailOf(7), eligibleRow(7, { all_email_opted_out: true }));
    await run('shadow');
    const loaded = await loadFrozenAudience(env.db, CAMPAIGN);
    expect(loaded!.docIds).toEqual(Array.from({ length: 5 }, (_, i) => emailOf(i + 1)));
  });

  it('un secondo congelamento non sovrascrive il primo (l\'intestazione si crea, non si riscrive)', async () => {
    seedAudience(4);
    await run('shadow');
    const before = env.raw(AUDIENCE_COLLECTION, CAMPAIGN)!;
    env.put(emailOf(5), eligibleRow(5));
    const again = await saveFrozenAudience(env.db, CAMPAIGN, { docIds: [emailOf(1), emailOf(2)], snapshotAt: new Date() });
    expect(again.saved).toBe(false);
    expect(env.raw(AUDIENCE_COLLECTION, CAMPAIGN)).toBe(before);
  });

  it('piu\' pagine: oltre AUDIENCE_PAGE_SIZE si spezza in sotto-documenti e si ricarica identico', async () => {
    const ids = Array.from({ length: AUDIENCE_PAGE_SIZE * 2 + 17 }, (_, i) => emailOf(i + 1));
    const saved = await saveFrozenAudience(env.db, CAMPAIGN, { docIds: ids, snapshotAt: new Date(), globalPreferredHour: { hourUtc: 7, sampleUsers: 123 } });
    expect(saved).toMatchObject({ saved: true, pages: 3, total: ids.length });
    const loaded = await loadFrozenAudience(env.db, CAMPAIGN);
    expect(loaded!.docIds).toEqual(ids);
    expect(loaded!.globalPreferredHour).toEqual({ hourUtc: 7, sampleUsers: 123 });
    // Ogni pagina resta molto sotto 1 MiB.
    for (const name of env.names(AUDIENCE_COLLECTION)) {
      expect(JSON.stringify(env.raw(AUDIENCE_COLLECTION, name)).length).toBeLessThan(400_000);
    }
  });

  it('un salvataggio interrotto (le pagine ci sono, l\'intestazione no) e invisibile', async () => {
    seedAudience(6);
    env.faults.failBatch = true;
    const { audience, metrics } = await run('frozen');
    expect(audience).toHaveLength(6);
    expect(counters(metrics).audienceFrozenSaveError).toBe(1);
    expect(await loadFrozenAudience(env.db, CAMPAIGN)).toBeNull();
    // E la ripresa dopo uno scarto cosi' rifa la scansione piena.
    env.faults.failBatch = false;
    const next = await run('frozen');
    expect(next.audience).toHaveLength(6);
    expect(counters(next.metrics).audienceSource).toBe('full-first-run');
  });
});

// ── riprese: frozen ────────────────────────────────────────────────────────
describe('ripresa con `frozen`: residui + delta, consenso rifatto', () => {
  it('legge solo i residui e il delta: zero scansioni complete della collection', async () => {
    seedAudience(200);
    await run('frozen');
    env.stats.fullScans = 0; env.stats.scanDocs = 0; env.stats.getAllRefs = 0; env.stats.getAllCalls = 0;
    // 197 gia' raggiunti (log di ripresa / ricevute): restano 3 residui.
    const attempted = Array.from({ length: 197 }, (_, i) => emailOf(i + 1));
    const { audience, metrics } = await run('frozen', attempted);
    expect(emailsOf(audience)).toEqual([emailOf(198), emailOf(199), emailOf(200)]);
    expect(env.stats.fullScans).toBe(0);
    expect(env.stats.scanDocs).toBe(0);
    // Letture = residui (3) + pagine/intestazione del pubblico congelato (1 header + 1 pagina) + delta (16 query).
    expect(env.stats.getAllRefs).toBe(1 + 3);
    expect(counters(metrics)).toMatchObject({ audienceSource: 'frozen', audienceResidualReads: 3, audienceDeltaDocs: 0 });
  });

  it('un iscritto arrivato DOPO lo snapshot rientra nel delta e viene raggiunto', async () => {
    seedAudience(10);
    await run('frozen');
    env.put(emailOf(50), eligibleRow(50, { created_at: FUTURE(), confirmed_at: FUTURE(), subscribed_at: FUTURE() }));
    const { audience, metrics } = await run('frozen', [emailOf(1)]);
    expect(emailsOf(audience)).toContain(emailOf(50));
    expect(counters(metrics).audienceDeltaDocs).toBeGreaterThanOrEqual(1);
  });

  it('un delta con campi salvati come stringa ISO (e non Timestamp) rientra lo stesso', async () => {
    seedAudience(5);
    await run('frozen');
    env.put(emailOf(60), eligibleRow(60, { created_at: undefined, confirmed_at: FUTURE().toISOString() }));
    const { audience } = await run('frozen');
    expect(emailsOf(audience)).toContain(emailOf(60));
  });

  it('un iscritto DISISCRITTO dopo lo snapshot non riceve l\'invio (consenso rifatto sui residui)', async () => {
    seedAudience(10);
    await run('frozen');
    env.put(emailOf(4), eligibleRow(4, { status: 'unsubscribed', unsubscribed_at: new Date() }));
    const { audience } = await run('frozen');
    expect(emailsOf(audience)).not.toContain(emailOf(4));
    expect(audience).toHaveLength(9);
  });

  it('un iscritto SOPPRESSO o rimbalzato dopo lo snapshot non riceve l\'invio', async () => {
    seedAudience(10);
    await run('frozen');
    env.put(emailOf(2), eligibleRow(2, { status: 'bounced' }));
    env.put(emailOf(3), eligibleRow(3, { status: 'complained' }));
    env.put(emailOf(5), eligibleRow(5, { all_email_opted_out: true }));
    const { audience } = await run('frozen');
    expect(emailsOf(audience)).toEqual([1, 4, 6, 7, 8, 9, 10].map(emailOf));
  });

  it('un documento cancellato dopo lo snapshot sparisce', async () => {
    seedAudience(6);
    await run('frozen');
    env.remove(emailOf(3));
    const { audience } = await run('frozen');
    expect(emailsOf(audience)).not.toContain(emailOf(3));
  });

  it('nessun destinatario con ricevuta terminale viene reinviato: ne dai residui ne dal delta', async () => {
    seedAudience(8);
    await run('frozen');
    env.put(emailOf(20), eligibleRow(20, { created_at: FUTURE() }));
    const attempted = [emailOf(1), emailOf(2), emailOf(20)];
    const { audience } = await run('frozen', attempted);
    for (const done of attempted) expect(emailsOf(audience)).not.toContain(done);
    expect(audience).toHaveLength(6);
  });

  it('chi si e\' riattivato dopo lo snapshot (resubscribed_at) rientra; chi era escluso e non e cambiato no', async () => {
    seedAudience(4);
    env.put(emailOf(30), eligibleRow(30, { status: 'unsubscribed', unsubscribed_at: PAST }));
    env.put(emailOf(31), eligibleRow(31, { status: 'unsubscribed', unsubscribed_at: PAST }));
    await run('frozen');
    env.put(emailOf(30), eligibleRow(30, { status: 'confirmed', unsubscribed_at: PAST, resubscribed_at: FUTURE() }));
    const { audience } = await run('frozen');
    expect(emailsOf(audience)).toContain(emailOf(30));
    expect(emailsOf(audience)).not.toContain(emailOf(31));
  });

  it('l\'ora preferita globale arriva dall\'intestazione e la ripresa non la riscrive', async () => {
    seedAudience(6, () => ({ preferred_send_hour_utc: 7, preferred_send_sample_count: 9 }));
    const first = await run('frozen');
    const hour = first.audience.globalPreferredHour;
    const { audience } = await run('frozen');
    expect(audience.globalPreferredHour).toEqual(hour);
    expect(audience.audienceSource).toBe('frozen');
    expect(readFileSync(path.join(ROOT, 'scripts/send-newsletter.mjs'), 'utf8')).toContain("subscribers.audienceSource !== 'frozen'");
  });

  it('pubblico illeggibile o incoerente: ripiego sulla scansione piena', async () => {
    seedAudience(6);
    await run('frozen');
    // Pagina mancante.
    env.names(AUDIENCE_COLLECTION).filter((name) => name.includes('__p')).forEach((name) => env.raw(AUDIENCE_COLLECTION, name) && env.db.collection(AUDIENCE_COLLECTION).doc(name).set({ kind: 'page', ids: [emailOf(1)] }));
    const { audience, warns } = await run('frozen');
    expect(audience).toHaveLength(6); // la scansione piena
    expect(warns.join('\n')).toMatch(/does not match its header/);
  });

  it('query del delta rifiutata: mai un delta incompleto, si ripiega sulla scansione piena', async () => {
    seedAudience(8);
    await run('frozen');
    env.faults.rejectQueries = true;
    env.put(emailOf(70), eligibleRow(70, { created_at: FUTURE() }));
    const { audience, metrics } = await run('frozen', [emailOf(1)]);
    expect(counters(metrics).audienceFrozenFallback).toBe(1);
    expect(emailsOf(audience)).toContain(emailOf(70)); // la scansione piena lo vede
  });
});

// ── shadow ─────────────────────────────────────────────────────────────────
describe('shadow: decide la scansione piena, il confronto e solo una misura', () => {
  it('stesso pubblico: audienceShadowMismatch = 0 e il risultato e quello della scansione piena', async () => {
    seedAudience(30);
    await run('shadow');
    env.put(emailOf(99), eligibleRow(99, { created_at: FUTURE() }));
    env.put(emailOf(3), eligibleRow(3, { status: 'unsubscribed' }));
    env.stats.fullScans = 0;
    const attempted = [emailOf(1), emailOf(2)];
    const { audience, metrics, logs, warns } = await run('shadow', attempted);
    expect(env.stats.fullScans).toBe(1); // letture >= di oggi: scansione piena + residui + delta
    expect(counters(metrics).audienceShadowMismatch).toBe(0);
    expect(counters(metrics).audienceSource).toBe('full-shadow');
    // Decide la scansione piena: contiene anche chi e' gia stato raggiunto (lo toglie il pre-filtro dopo).
    expect(emailsOf(audience)).toContain(emailOf(1));
    expect(emailsOf(audience)).toContain(emailOf(99));
    expect(emailsOf(audience)).not.toContain(emailOf(3));
    expect(`${logs.join('\n')}${warns.join('\n')}`).not.toContain('@');
  });

  it('un pubblico diverso e contato e loggato solo con conteggi e hash, e non cambia il risultato', async () => {
    seedAudience(20);
    await run('shadow');
    // Una modifica che il delta non puo vedere: uno stato corretto a mano, senza timestamp di iscrizione.
    env.put(emailOf(21), eligibleRow(21, { status: 'inactive' }));
    await run('shadow'); // (nessun effetto: l'id 21 non era congelato)
    env.put(emailOf(21), eligibleRow(21, { status: 'confirmed', created_at: PAST, confirmed_at: PAST }));
    const { audience, metrics, logs, warns } = await run('shadow');
    expect(emailsOf(audience)).toContain(emailOf(21)); // decide la scansione piena
    expect(counters(metrics).audienceShadowMismatch).toBe(1);
    expect(counters(metrics)).toMatchObject({ audienceShadowOnlyFull: 1, audienceShadowOnlyFrozen: 0 });
    const text = `${logs.join('\n')}\n${warns.join('\n')}`;
    expect(text).toContain(shortIdHash(emailOf(21)));
    expect(text).not.toContain('@');
    expect(text).not.toContain('example.test');
  });

  it('un errore del confronto non cambia il risultato: decide la scansione piena', async () => {
    seedAudience(10);
    await run('shadow');
    env.faults.rejectQueries = true;
    const { audience, metrics } = await run('shadow');
    expect(audience).toHaveLength(10);
    expect(counters(metrics).audienceShadowError).toBe(1);
  });

  it('in shadow lo snapshot dell\'iscritto resta quello della scansione che decide', async () => {
    seedAudience(5);
    await run('shadow');
    const { audience } = await run('shadow');
    expect(audience).toHaveLength(5);
  });
});

// ── proprieta': frozen = full su audience sintetiche casuali ───────────────
describe('proprieta\': l\'insieme `frozen` coincide con l\'insieme `full`', () => {
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const CASES = 520;
  it(`su ${CASES} audience casuali, con arrivi, disiscrizioni, soppressioni, riattivazioni e ricevute`, async () => {
    let totalChecked = 0;
    for (let seed = 1; seed <= CASES; seed += 1) {
      const rand = mulberry32(seed);
      const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)];
      const e = createFakeFirestore();
      __setNewsletterDbForTest(e.db);
      const size = 8 + Math.floor(rand() * 40);
      const initialStatuses = ['confirmed', 'confirmed', 'confirmed', 'pending', 'subscribed', 'unsubscribed', 'bounced', 'inactive'];
      for (let n = 1; n <= size; n += 1) {
        const status = pick(initialStatuses);
        e.put(emailOf(n), eligibleRow(n, {
          status,
          ...(status === 'unsubscribed' ? { unsubscribed_at: PAST } : {}),
          ...(rand() < 0.1 ? { all_email_opted_out: true } : {}),
          // Alcuni percorsi di scrittura salvano la data come stringa ISO.
          ...(rand() < 0.3 ? { confirmed_at: PAST.toISOString(), created_at: PAST.toISOString() } : {}),
        }));
      }
      // Prima run: congela.
      const first = metricsAndLogs();
      await resolveSendAudience(CAMPAIGN, new Set(), { mode: 'frozen', metrics: first.metrics, log: first.log, warn: first.warn });

      // Fra lo snapshot e la ripresa succede di tutto cio che il codice che scrive gli iscritti
      // marca con un timestamp di iscrizione/conferma/riattivazione, piu le uscite.
      const ops = Math.floor(rand() * 14);
      let next = size + 1;
      for (let i = 0; i < ops; i += 1) {
        const kind = pick(['arrive', 'arrive', 'unsubscribe', 'suppress', 'optout', 'reactivate', 'confirm', 'delete']);
        const target = emailOf(1 + Math.floor(rand() * size));
        const current = e.raw('newsletter_subscribers', target);
        const stamp = rand() < 0.3 ? FUTURE().toISOString() : FUTURE();
        if (kind === 'arrive') { e.put(emailOf(next), eligibleRow(next, { created_at: stamp, confirmed_at: stamp, subscribed_at: stamp, status: pick(['confirmed', 'pending']) })); next += 1; }
        else if (!current) continue;
        else if (kind === 'unsubscribe') e.put(target, { ...current, status: 'unsubscribed', unsubscribed_at: new Date() });
        else if (kind === 'suppress') e.put(target, { ...current, status: pick(['bounced', 'complained']) });
        else if (kind === 'optout') e.put(target, { ...current, all_email_opted_out: true });
        else if (kind === 'reactivate') e.put(target, { ...current, status: 'confirmed', resubscribed_at: stamp, unsubscribed_at: PAST });
        else if (kind === 'confirm') e.put(target, { ...current, status: 'confirmed', confirmed_at: stamp });
        else if (kind === 'delete') e.remove(target);
      }
      // Ricevute terminali: gia' raggiunti (anche fra gli arrivi).
      const attempted = new Set<string>();
      for (let n = 1; n < next; n += 1) if (rand() < 0.25) attempted.add(emailOf(n));

      const fullRun = metricsAndLogs();
      const full = await resolveSendAudience(CAMPAIGN, attempted, { mode: 'full', metrics: fullRun.metrics, log: fullRun.log, warn: fullRun.warn });
      const fullSet = emailsOf(full).filter((email) => !attempted.has(email));
      const frozenRun = metricsAndLogs();
      const frozen = await resolveSendAudience(CAMPAIGN, attempted, { mode: 'frozen', metrics: frozenRun.metrics, log: frozenRun.log, warn: frozenRun.warn });
      expect(counters(frozenRun.metrics).audienceSource, `seed ${seed}`).toBe('frozen');
      expect(emailsOf(frozen), `seed ${seed}`).toEqual(fullSet);
      // E mai un destinatario con ricevuta terminale.
      for (const email of emailsOf(frozen)) expect(attempted.has(email), `seed ${seed}`).toBe(false);
      totalChecked += fullSet.length;
    }
    expect(totalChecked).toBeGreaterThan(1000);
    __setNewsletterDbForTest(undefined);
  }, 120_000);
});

// ── confronto, perimetro ───────────────────────────────────────────────────
describe('compareAudiences e perimetro', () => {
  it('conta le differenze e riporta solo hash', () => {
    const result = compareAudiences(['a@example.test', 'b@example.test'], ['b@example.test', 'c@example.test']);
    expect(result).toMatchObject({ mismatch: 2, onlyFull: 1, onlyFrozen: 1, fullSize: 2, frozenSize: 2 });
    expect(JSON.stringify(result)).not.toContain('@');
    expect(hashAudienceIds(['b', 'a'])).toBe(hashAudienceIds(['a', 'b']));
    expect(compareAudiences(['x'], ['x']).mismatch).toBe(0);
  });

  it('la collection del pubblico congelato non ha trigger Cloud Functions e non coincide con newsletter_subscribers', () => {
    const functionsIndex = readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
    expect(functionsIndex).not.toContain(AUDIENCE_COLLECTION);
    // Nessun trigger documentale con la collection come variabile: ogni `document:` nomina una collection.
    expect(functionsIndex).not.toMatch(/document:\s*['"`]\{[a-zA-Z]+\}\//);
    expect(AUDIENCE_COLLECTION).not.toBe('newsletter_subscribers');
  });

  it('i documenti congelati scadono (TTL) e l\'array di id non e indicizzato', () => {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
    const overrides = config.fieldOverrides.filter((o: any) => o.collectionGroup === AUDIENCE_COLLECTION);
    expect(overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: 'expires_at', ttl: true, indexes: [] }),
      expect.objectContaining({ fieldPath: 'ids', indexes: [] }),
    ]));
  });

  it('il modulo non scrive mai in newsletter_subscribers: scrive solo attraverso la collection del pubblico congelato', () => {
    const lib = readFileSync(path.join(ROOT, 'scripts/lib/newsletter-audience-freeze.mjs'), 'utf8');
    const code = lib.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/\.delete\(|batch\.update\(|\.doc\([^)]*\)\.update\(/);
    // Ogni scrittura (set/create) parte da `collection`, cioe' db.collection(AUDIENCE_COLLECTION).
    expect(code).toContain('const collection = db.collection(AUDIENCE_COLLECTION);');
    const writes = [...code.matchAll(/(\w+(?:\.\w+)*)\.(?:set|create)\(/g)].map((m) => m[1]);
    // `found` e `byId` sono Map in memoria, non documenti.
    for (const target of writes) expect(['batch', 'collection.doc', 'found', 'byId']).toContain(target.replace(/\(.*$/, ''));
  });
});
