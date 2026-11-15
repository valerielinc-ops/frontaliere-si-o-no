/**
 * Saved-jobs digest (perf-plan email senders, D2, D3, D4): una sola cascade con il
 * claim durevole in micro-batch, indice di identita' equivalente alla scansione
 * lineare, telemetria. Nessuna rete e nessun invio.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BULK_SEND_THROTTLE, bulkCascadeOptions } from '../scripts/lib/bulk-send-throttle.mjs';
import { createSavedJobsDigestClaimer } from '../scripts/lib/saved-jobs-digest-claim.mjs';
import {
  SAVED_JOBS_DIGEST_PHASES,
  claimSavedJobsDigestDelivery,
  emitSavedJobsMetrics,
  resolveApplicationIntentJob,
  resolveApplicationIntentJobLinear,
  invalidateApplicationIntentIdentityIndex,
  savedJobsMetrics,
  sendDigestBatch,
} from '../scripts/send-saved-jobs-digest.mjs';
import { buildDeliveryDocId } from '../functions/src/lib/deliveryDocId.js';

const ROOT = path.resolve(__dirname, '..');
const CAMPAIGN = 'saved-jobs-digest-2026-11-16';

// ── D3: indice di identita' ───────────────────────────────────────────────────
function makeInventory(size: number) {
  const jobs: any[] = [];
  for (let i = 0; i < size; i += 1) {
    jobs.push({
      id: `job-${i}`,
      slug: `slug-${i % 40}`, // slug condivisi: il primo nell'ordine d'inserimento deve vincere
      slugByLocale: { it: `it-${i % 55}`, en: `en-${i}`, de: i % 7 === 0 ? ` de-${i} ` : `de-${i}` },
      companyKey: i % 5 === 0 ? '' : `company-${i % 9}`,
      url: i % 3 === 0 ? `https://jobs.example.test/${i % 30}` : `https://jobs.example.test/unique-${i}`,
      applyUrl: i % 4 === 0 ? `https://apply.example.test/${i % 20}` : '',
    });
  }
  // Un annuncio senza id e uno con id numerico.
  jobs.push({ id: 'no-id-job', slug: 'no-id-slug', companyKey: 'c', url: 'https://jobs.example.test/no-id' });
  jobs.push({ id: 12345, slug: 'numeric-id', companyKey: 'c' });
  return new Map(jobs.map((job) => [job.id, job]));
}

describe('D3: resolveApplicationIntentJob con indice == scansione lineare', () => {
  const jobsById = makeInventory(300);
  const intents: Array<[any, string]> = [];
  for (let i = 0; i < 300; i += 7) {
    intents.push([{ jobId: `job-${i}` }, `doc-${i}`]);
    intents.push([{ job_id: `  job-${i}  ` }, `doc-${i}`]);
    intents.push([{ jobSlug: `slug-${i % 40}` }, `x`]);
    intents.push([{ slug: `en-${i}` }, `x`]);
    intents.push([{ jobKey: `company-${i % 9}:it-${i % 55}` }, `x`]);
    intents.push([{ jobKey: `company-${i % 9}:id:job-${i}` }, `x`]);
    intents.push([{ jobKey: `unknown-company:id:job-${i}` }, `x`]);
    intents.push([{ jobUrl: `https://jobs.example.test/${i % 30}` }, `x`]);
    intents.push([{ url: `https://apply.example.test/${i % 20}` }, `x`]);
    intents.push([{ job: { id: `de-${i}` } }, `x`]);
    intents.push([{ job: { slug: `slug-${i % 40}` }, listing: { id: 'nope' } }, `job-${i}`]);
    intents.push([{ listing: { jobKey: `company-${i % 9}:it-${i % 55}` } }, `x`]);
  }
  intents.push([{}, 'job-3'], [{}, ''], [{}, '   '], [{ jobId: 'missing' }, 'missing-too'], [{ id: 12345 }, 'x'], [{ jobSlug: 'numeric-id' }, 'x'], [{ jobSlug: 'no-id-slug' }, 'x'], [{ url: 'https://jobs.example.test/no-id' }, 'x']);

  it('restituisce lo stesso annuncio (stessa identita) per ogni intent del fixture', () => {
    let matched = 0;
    for (const [data, docId] of intents) {
      const linear = resolveApplicationIntentJobLinear(data, docId, jobsById);
      const indexed = resolveApplicationIntentJob(data, docId, jobsById);
      expect(indexed, JSON.stringify([data, docId])).toBe(linear);
      if (linear) matched += 1;
    }
    expect(matched).toBeGreaterThan(intents.length / 2);
  });

  it('con identita condivise vince il primo annuncio in ordine di inserimento', () => {
    const first = jobsById.get('job-0');
    const sameSlug = jobsById.get('job-40');
    expect(sameSlug.slug).toBe(first.slug);
    expect(resolveApplicationIntentJob({ jobSlug: first.slug }, 'x', jobsById)).toBe(first);
    expect(resolveApplicationIntentJobLinear({ jobSlug: first.slug }, 'x', jobsById)).toBe(first);
  });

  it('l indice si ricostruisce se l inventario cambia (stesso Map, nuova dimensione)', () => {
    const small = new Map([['a', { id: 'a', slug: 'alpha' }]]);
    expect(resolveApplicationIntentJob({ jobSlug: 'beta' }, 'x', small)).toBeNull();
    small.set('b', { id: 'b', slug: 'beta' });
    expect(resolveApplicationIntentJob({ jobSlug: 'beta' }, 'x', small)).toBe(small.get('b'));
  });

  it('la cache e per identita del Map: due Map distinti non si contaminano; una sostituzione in place richiede l invalidazione', () => {
    const one = new Map([['a', { id: 'a', slug: 'alpha' }]]);
    const two = new Map([['a', { id: 'a', slug: 'beta' }]]);
    expect(resolveApplicationIntentJob({ jobSlug: 'alpha' }, 'x', one)).toBe(one.get('a'));
    expect(resolveApplicationIntentJob({ jobSlug: 'alpha' }, 'x', two)).toBeNull();
    // Same Map, same size, entry replaced in place: the contract says the Map is not
    // mutated after loading; the explicit invalidation is the documented way to do it.
    one.set('a', { id: 'a', slug: 'gamma' });
    invalidateApplicationIntentIdentityIndex(one);
    expect(resolveApplicationIntentJob({ jobSlug: 'gamma' }, 'x', one)).toBe(one.get('a'));
    expect(resolveApplicationIntentJob({ jobSlug: 'alpha' }, 'x', one)).toBeNull();
    expect(resolveApplicationIntentJobLinear({ jobSlug: 'gamma' }, 'x', one)).toBe(one.get('a'));
  });

  it('non scansiona piu l inventario per candidato: il costo non cresce con inventario x intent', () => {
    const big = makeInventory(20_000);
    const start = performance.now();
    for (let i = 0; i < 2_000; i += 1) resolveApplicationIntentJob({ jobSlug: 'missing', url: `https://x.test/${i}` }, 'nope', big);
    const indexedMs = performance.now() - start;
    // La scansione lineare farebbe 2.000 x ~12 candidati x 20.000 annunci = ~480M confronti.
    expect(indexedMs).toBeLessThan(1_500);
  });
});

// ── D2: claim in micro-batch ─────────────────────────────────────────────────
function claimDb({ failBatch = null as null | 'already' | 'other' } = {}) {
  const docs = new Map<string, any>();
  const events: string[] = [];
  const db: any = {
    docs, events,
    collection: (name: string) => ({
      doc: (uid: string) => ({
        collection: () => ({
          doc: (id: string) => {
            const refPath = `${name}/${uid}/campaign_deliveries/${id}`;
            return {
              path: refPath,
              set: async (data: any) => { docs.set(refPath, { ...(docs.get(refPath) || {}), ...data }); },
            };
          },
        }),
      }),
    }),
    batch: () => {
      const creates: Array<{ ref: any; data: any }> = [];
      return {
        create: (ref: any, data: any) => { creates.push({ ref, data }); },
        commit: async () => {
          if (failBatch === 'other') { events.push('commit-error'); throw Object.assign(new Error('UNAVAILABLE'), { code: 14 }); }
          if (failBatch === 'already' || creates.some((c) => docs.has(c.ref.path))) {
            events.push('commit-already-exists');
            throw Object.assign(new Error('6 ALREADY_EXISTS: Document already exists'), { code: 6 });
          }
          for (const c of creates) docs.set(c.ref.path, c.data);
          events.push(`commit:${creates.length}`);
          return creates.map(() => ({ writeTime: 1 }));
        },
      };
    },
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      events.push('tx');
      return fn({
        get: async (ref: any) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        create: (ref: any, data: any) => { docs.set(ref.path, data); },
        delete: (ref: any) => { docs.delete(ref.path); },
      });
    },
  };
  return db;
}
const target = (n: number) => ({ uid: `uid-${n}`, email: `user${n}@example.test` });
const pathOf = (n: number) => `users/uid-${n}/campaign_deliveries/${buildDeliveryDocId(CAMPAIGN, `user${n}@example.test`)}`;

function claimer(db: any, extra: Record<string, unknown> = {}) {
  const counts: Record<string, number> = {};
  const c = createSavedJobsDigestClaimer({
    getDb: async () => db, campaignId: CAMPAIGN,
    claimTransaction: (t: any) => claimSavedJobsDigestDelivery(db, t),
    metrics: { count: (n: string, k = 1) => { counts[n] = (counts[n] || 0) + k; } },
    maxItems: 4, windowMs: 5, ...extra,
  });
  return { c, counts };
}

describe('D2: claim durevole in micro-batch', () => {
  it('le richieste concorrenti finiscono in un solo commit e il claim ha lo stato sending', async () => {
    const db = claimDb();
    const { c, counts } = claimer(db);
    const results = await Promise.all([1, 2, 3, 4].map((n) => c.claim(target(n))));
    expect(results).toEqual([true, true, true, true]);
    expect(db.events).toEqual(['commit:4']);
    expect(db.docs.get(pathOf(1))).toMatchObject({ status: 'sending', campaign_id: CAMPAIGN, email: 'user1@example.test' });
    expect(counts.claimBatches).toBe(1);
    expect([1, 2, 3, 4].every((n) => c.owns(target(n)))).toBe(true);
  });

  it('ALREADY_EXISTS su un claim singolo: gia reclamato, si salta senza transazione', async () => {
    const db = claimDb();
    db.docs.set(pathOf(1), { status: 'sending' });
    const { c, counts } = claimer(db);
    await expect(c.claim(target(1))).resolves.toBe(false);
    expect(db.events).toEqual(['commit-already-exists']);
    expect(c.owns(target(1))).toBe(false);
    expect(counts.claimAlreadyExists).toBe(1);
  });

  it('un gruppo con un claim gia presente ripiega sulla transazione per email: solo quello e rifiutato', async () => {
    const db = claimDb();
    db.docs.set(pathOf(2), { status: 'sending' });
    const { c, counts } = claimer(db);
    const results = await Promise.all([1, 2, 3].map((n) => c.claim(target(n))));
    expect(results).toEqual([true, false, true]);
    expect(db.events.filter((e: string) => e === 'tx')).toHaveLength(3);
    expect(counts.claimTxFallback).toBe(3);
    expect(db.docs.get(pathOf(1))).toMatchObject({ status: 'sending' });
    expect(db.docs.get(pathOf(3))).toMatchObject({ status: 'sending' });
  });

  it('un errore del batch ripiega sulla transazione di oggi (mai un invio senza claim)', async () => {
    const db = claimDb({ failBatch: 'other' });
    const warn = vi.fn();
    const { c } = claimer(db, { warn });
    await expect(c.claim(target(1))).resolves.toBe(true);
    expect(db.events).toEqual(['commit-error', 'tx']);
    expect(warn).toHaveBeenCalled();
  });

  it('se anche la transazione di ripiego lancia, l errore risale: il provider non si chiama', async () => {
    const db = claimDb({ failBatch: 'other' });
    db.runTransaction = async () => { throw new Error('tx unavailable'); };
    const { c } = claimer(db);
    await expect(c.claim(target(1))).rejects.toThrow('tx unavailable');
  });

  it('un secondo provider della stessa cascade non riscrive il claim', async () => {
    const db = claimDb();
    const { c } = claimer(db);
    await c.claim(target(1));
    await c.claim(target(1));
    expect(db.events).toEqual(['commit:1']);
  });

  it('un getDb che lancia prima del commit ripiega sulla transazione', async () => {
    const db = claimDb();
    let calls = 0;
    const counts: Record<string, number> = {};
    const c = createSavedJobsDigestClaimer({
      getDb: async () => { calls += 1; if (calls === 1) throw new Error('no handle'); return db; },
      campaignId: CAMPAIGN,
      claimTransaction: (t: any) => claimSavedJobsDigestDelivery(db, t),
      metrics: { count: (n: string) => { counts[n] = (counts[n] || 0) + 1; } },
      maxItems: 1, windowMs: 1, warn: () => {},
    });
    await expect(c.claim(target(1))).resolves.toBe(true);
    expect(counts.claimBatchError).toBe(1);
  });
});

describe('D2: una sola cascade con claim prima del provider', () => {
  const mkItem = (n: number) => ({
    payload: { to: [`user${n}@example.test`], subject: 's', html: '<p>x</p>', text: 'x', tags: [], headers: {} },
    recipient: { email: `user${n}@example.test` },
    meta: { type: 'saved-jobs-digest', uid: `uid-${n}`, campaignId: CAMPAIGN },
  });

  /** Cascade finta: per ogni item chiede il claim, poi «chiama il provider» e registra l'ordine. */
  function fakeCascade(db: any, behaviour: (n: number) => 'ok' | 'fail' | 'ambiguous' = () => 'ok') {
    const calls: Array<{ items: number; opts: any }> = [];
    const providerCalls: Array<{ n: number; claimExisted: boolean }> = [];
    const fn = vi.fn(async (items: any[], opts: any) => {
      calls.push({ items: items.length, opts });
      const sent: any[] = []; const failed: any[] = [];
      for (const item of items) {
        const n = Number(item.meta.uid.split('-')[1]);
        const maySend = await opts.beforeProviderAttempt(item, 'maileroo');
        if (maySend === false) continue;
        providerCalls.push({ n, claimExisted: db.docs.has(pathOf(n)) });
        const outcome = behaviour(n);
        if (outcome === 'ok') { sent.push({ ...item, provider: 'maileroo', messageId: `m-${n}` }); await opts.onSent(item, { provider: 'maileroo', messageId: `m-${n}` }); }
        else failed.push({ ...item, error: 'boom', ambiguousDelivery: outcome === 'ambiguous' });
      }
      return { sent, failed };
    });
    return { fn, calls, providerCalls };
  }

  it('una sola chiamata alla cascade con throttle e concorrenza della jobalert; claim durevole prima del provider', async () => {
    const db = claimDb();
    const { fn, calls, providerCalls } = fakeCascade(db);
    const metrics = savedJobsMetrics;
    const out = await sendDigestBatch(db, [1, 2, 3, 4, 5, 6].map(mkItem), { campaignId: CAMPAIGN, metrics, sendEmailCascade: fn });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].items).toBe(6);
    expect(calls[0].opts).toMatchObject({ concurrency: 4, delayMs: 100, adaptiveThrottle: { stepMs: 100, maxDelayMs: 1000 } });
    expect(calls[0].opts.providerMinIntervalMs).toBeTruthy();
    expect(providerCalls.every((call) => call.claimExisted)).toBe(true);
    expect(out).toMatchObject({ sent: 6, skipped: 0 });
    // onSent scrive la consegna con lo stato sent.
    expect(db.docs.size).toBe(6);
  });

  it('un destinatario gia reclamato non raggiunge il provider e conta come saltato', async () => {
    const db = claimDb();
    db.docs.set(pathOf(2), { status: 'sending' });
    const { fn, providerCalls } = fakeCascade(db);
    const out = await sendDigestBatch(db, [1, 2, 3].map(mkItem), { campaignId: CAMPAIGN, metrics: savedJobsMetrics, sendEmailCascade: fn });
    expect(providerCalls.map((call) => call.n).sort()).toEqual([1, 3]);
    expect(out).toMatchObject({ sent: 2, skipped: 1 });
  });

  it('rilascia il claim solo su fallimento definito di un claim proprio; un esito ambiguo lo lascia', async () => {
    const db = claimDb();
    const { fn } = fakeCascade(db, (n) => (n === 1 ? 'fail' : n === 2 ? 'ambiguous' : 'ok'));
    const out = await sendDigestBatch(db, [1, 2, 3].map(mkItem), { campaignId: CAMPAIGN, metrics: savedJobsMetrics, sendEmailCascade: fn });
    expect(db.docs.has(pathOf(1))).toBe(false); // definito: rilasciato, rinviabile
    expect(db.docs.get(pathOf(2))).toMatchObject({ status: 'sending' }); // ambiguo: resta
    expect(db.docs.get(pathOf(3))).toMatchObject({ status: 'sent' });
    expect(out).toMatchObject({ sent: 1, skipped: 2, failed: 2 });
  });

  it('un claim che la run non ha fatto non viene rilasciato', async () => {
    const db = claimDb();
    db.docs.set(pathOf(1), { status: 'sending' });
    // Fallimento di un item il cui claim e di un altro processo (la cascade lo ha comunque saltato).
    const fn = vi.fn(async (items: any[], opts: any) => {
      await opts.beforeProviderAttempt(items[0], 'maileroo');
      return { sent: [], failed: [{ ...items[0], error: 'late failure', ambiguousDelivery: false }] };
    });
    await sendDigestBatch(db, [mkItem(1)], { campaignId: CAMPAIGN, metrics: savedJobsMetrics, sendEmailCascade: fn });
    expect(db.docs.get(pathOf(1))).toMatchObject({ status: 'sending' });
  });

  it('se la cascade lancia, i claim restano (nessun rilascio ottimistico)', async () => {
    const db = claimDb();
    const fn = vi.fn(async (items: any[], opts: any) => {
      await opts.beforeProviderAttempt(items[0], 'maileroo');
      throw new Error('cascade aborted');
    });
    await expect(sendDigestBatch(db, [mkItem(1)], { campaignId: CAMPAIGN, metrics: savedJobsMetrics, sendEmailCascade: fn })).rejects.toThrow('cascade aborted');
    expect(db.docs.get(pathOf(1))).toMatchObject({ status: 'sending' });
  });

  it('nessun item: nessuna cascade', async () => {
    const fn = vi.fn();
    await expect(sendDigestBatch(claimDb(), [], { campaignId: CAMPAIGN, sendEmailCascade: fn })).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('throttle condiviso e telemetria', () => {
  it('BULK_SEND_THROTTLE coincide con JOB_ALERT_SEND_THROTTLE della jobalert', () => {
    const jobAlerts = readFileSync(path.join(ROOT, 'scripts/send-job-alerts.mjs'), 'utf8');
    const block = jobAlerts.match(/const JOB_ALERT_SEND_THROTTLE = Object\.freeze\(\{([\s\S]*?)\}\)\);?\n/)?.[1] ?? '';
    expect(block).toContain(`concurrency: ${BULK_SEND_THROTTLE.concurrency}`);
    expect(block).toContain(`delayMs: ${BULK_SEND_THROTTLE.delayMs}`);
    expect(block).toContain(`stepMs: ${BULK_SEND_THROTTLE.adaptiveThrottle.stepMs}`);
    expect(block).toContain(`maxDelayMs: ${BULK_SEND_THROTTLE.adaptiveThrottle.maxDelayMs}`);
  });

  it('bulkCascadeOptions aggiunge i pavimenti per provider e lascia passare gli extra', async () => {
    const options = await bulkCascadeOptions({ onSent: 'x' });
    expect(options).toMatchObject({ concurrency: 4, delayMs: 100, onSent: 'x' });
    expect(Object.keys(options.providerMinIntervalMs)).toEqual(expect.arrayContaining(['cloudflare', 'resend', 'maileroo']));
  });

  it('SAVEDJOBS_METRICS dichiara le fasi e si emette senza lanciare', () => {
    expect([...SAVED_JOBS_DIGEST_PHASES]).toEqual(['load', 'users', 'send', 'persist']);
    const lines: string[] = [];
    savedJobsMetrics.enter('send');
    expect(emitSavedJobsMetrics({ log: (l: string) => lines.push(l) })).not.toBeNull();
    expect(lines[0]).toMatch(/^📊 SAVEDJOBS_METRICS \{/);
  });

  it('il sender non ha piu una cascade per utente ne il claim nel ciclo', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/send-saved-jobs-digest.mjs'), 'utf8');
    expect(source).not.toMatch(/concurrency: 1,\s*\n\s*onSent/);
    expect(source).toContain('pendingDigests.push(built.item)');
    expect(source.match(/await sendDigestBatch\(/g)).toHaveLength(1);
    expect(source).not.toContain('!await claimSavedJobsDigestDelivery(db, { uid, email, campaignId })');
  });
});
