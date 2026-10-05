// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  affinityExclusionReason,
  main,
  parseArgs,
  redact,
  runAffinityBuild,
  storedJobAttributes,
} from '../scripts/build-job-email-affinity.mjs';
import { affinityDocId } from '../functions/src/lib/jobEmailAffinity.js';
import { rankingDeliveryDocumentId } from '../functions/src/lib/jobEmailRankingStore.js';
import { buildDeliveryDocId } from '../functions/src/lib/deliveryDocId.js';

const SECRET = 'test-affinity-secret';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.now() - 2 * DAY);
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
const SINCE = new Date(NOW.getTime() - 3 * DAY).toISOString();

type Row = Record<string, any>;

/** Firestore finto: percorsi pieni, collectionGroup con where/orderBy/startAfter, getAll, batch. */
function createFakeFirestore(seed: Record<string, Row> = {}) {
  const docs = new Map<string, Row>(Object.entries(seed));
  const writes: Array<{ type: string; path: string }> = [];
  let reads = 0;

  function collectionRef(path: string): any {
    const segments = path.split('/');
    return {
      id: segments[segments.length - 1],
      path,
      get parent() {
        return segments.length > 1 ? docRef(segments.slice(0, -1).join('/')) : null;
      },
      doc: (id: string) => docRef(`${path}/${id}`),
    };
  }
  function snapshot(path: string) {
    const data = docs.get(path);
    return { id: path.split('/').pop(), ref: docRef(path), exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
  }
  function docRef(path: string): any {
    const segments = path.split('/');
    return {
      id: segments[segments.length - 1],
      path,
      get parent() {
        return collectionRef(segments.slice(0, -1).join('/'));
      },
      collection: (name: string) => collectionRef(`${path}/${name}`),
      async get() {
        reads += 1;
        return snapshot(path);
      },
      async set(data: Row) {
        writes.push({ type: 'set', path });
        docs.set(path, structuredClone(data));
      },
      async delete() {
        writes.push({ type: 'delete', path });
        docs.delete(path);
      },
    };
  }
  const time = (value: any) => (value instanceof Date ? value.getTime() : value);
  function groupQuery(group: string, filters: Array<[string, string, any]>, order: string | null, max: number, after: any): any {
    return {
      where: (field: string, op: string, value: any) => groupQuery(group, [...filters, [field, op, value]], order, max, after),
      orderBy: (field: string, direction: string) => groupQuery(group, filters, `${field}:${direction}`, max, after),
      limit: (value: number) => groupQuery(group, filters, order, value, after),
      startAfter: (snap: any) => groupQuery(group, filters, order, max, snap),
      async get() {
        let matches = [...docs.keys()].filter((path) => {
          const segments = path.split('/');
          if (segments[segments.length - 2] !== group) return false;
          const data = docs.get(path)!;
          return filters.every(([field, op, value]) => {
            const left = time(data[field]);
            const right = time(value);
            if (op === '==') return left === right;
            if (op === '>=') return left >= right;
            if (op === '<') return left < right;
            throw new Error(`operatore non supportato ${op}`);
          });
        });
        expect(order).toBe('timestamp:desc');
        matches.sort((a, b) => time(docs.get(b)!.timestamp) - time(docs.get(a)!.timestamp) || (a < b ? -1 : 1));
        if (after) matches = matches.slice(matches.indexOf(after.ref.path) + 1);
        const page = matches.slice(0, max).map(snapshot);
        reads += Math.max(1, page.length);
        return { docs: page, size: page.length, empty: page.length === 0 };
      },
    };
  }
  const db = {
    collection: (name: string) => collectionRef(name),
    doc: (path: string) => docRef(path),
    collectionGroup: (group: string) => groupQuery(group, [], null, Infinity, null),
    async getAll(...refs: any[]) {
      reads += refs.length;
      return refs.map((ref) => snapshot(ref.path));
    },
    batch() {
      const ops: Array<() => void> = [];
      return {
        set: (ref: any, data: Row) => ops.push(() => { writes.push({ type: 'set', path: ref.path }); docs.set(ref.path, structuredClone(data)); }),
        delete: (ref: any) => ops.push(() => { writes.push({ type: 'delete', path: ref.path }); docs.delete(ref.path); }),
        async commit() { ops.forEach((op) => op()); },
      };
    },
  };
  return { db: db as any, docs, writes, reads: () => reads };
}

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const profilePath = (email: string) => `job_email_affinity/${affinityDocId(email, SECRET)}`;

function jobUrl({ jobId, surface, deliveryId, extra = '' }: { jobId: string; surface: string; deliveryId: string; extra?: string }) {
  const surfaceParams = surface === 'job_alert' ? 'surface_id=al1&job_alert_id=al1' : 'surface_id=newsletter_weekly&newsletter_id=nl-1';
  return `https://frontaliereticino.ch/cerca-lavoro-ticino/${jobId.toLowerCase()}/?je=1&job_id=${jobId}&surface=${surface}&${surfaceParams}&delivery_id=${deliveryId}${extra}`;
}

let eventSeq = 0;
function clickEvent(collection: string, email: string, when: Date, url: string, messageId = `msg-${++eventSeq}`) {
  return {
    [`${collection}/${email}/events/ev-${++eventSeq}`]: {
      email,
      event_type: 'click',
      provider: 'maileroo',
      message_id: messageId,
      timestamp: when,
      occurred_at: when.toISOString(),
      metadata: { original_url: url },
    },
  };
}

function baseSeed(): Record<string, Row> {
  return {
    [`newsletter_subscribers/${ALICE}`]: { status: 'confirmed' },
    [`job_alert_subscribers/${ALICE}`]: { status: 'active' },
    [`newsletter_subscribers/${BOB}`]: { status: 'confirmed' },
    [`job_alert_subscribers/${BOB}`]: { status: 'active' },
    // Consegna col manifest gia' arricchito (dopo la PR degli attributi).
    [`job_email_ranking_deliveries/${rankingDeliveryDocumentId('d1')}`]: {
      surface: 'job_alert',
      jobs: [{ job_id: 'A', position: 1, category: 'Informatica', canton: 'TI', company_key: 'acme', sector: 'tech' }],
    },
    // Newsletter storica: manifest senza attributi, scheda completa in campaign_deliveries.
    [`job_email_ranking_deliveries/${rankingDeliveryDocumentId('d2')}`]: {
      surface: 'newsletter',
      newsletter_id: 'nl-1',
      jobs: [{ job_id: 'B', position: 1 }],
    },
    [`newsletter_subscribers/${ALICE}/campaign_deliveries/${buildDeliveryDocId('nl-1', ALICE)}`]: {
      is_operator_verification: false,
      ranking_jobs: [{ jobId: 'B', title: 'Tecnico', companyKey: 'beta', sector: 'energy', location: 'Lugano' }],
    },
    // Job alert storico: nessun manifest, annuncio completo in campaign_deliveries.
    [`job_alert_subscribers/${ALICE}/campaign_deliveries/${buildDeliveryDocId('d3', ALICE)}`]: {
      is_operator_verification: false,
      ranking_jobs: [{ jobId: 'C', title: 'Capocantiere', category: 'cantiere', canton: 'ti', companyKey: 'gamma', sector: 'Edilizia' }],
    },
  };
}

function seedWithAliceClicks(): Record<string, Row> {
  return {
    ...baseSeed(),
    ...clickEvent('job_alert_subscribers', ALICE, hoursAgo(30), jobUrl({ jobId: 'A', surface: 'job_alert', deliveryId: 'd1' })),
    ...clickEvent('newsletter_subscribers', ALICE, hoursAgo(20), jobUrl({ jobId: 'B', surface: 'newsletter', deliveryId: 'd2' })),
    ...clickEvent('job_alert_subscribers', ALICE, hoursAgo(10), jobUrl({ jobId: 'C', surface: 'job_alert', deliveryId: 'd3' })),
    // Un link che non e' un annuncio non conta.
    ...clickEvent('newsletter_subscribers', ALICE, hoursAgo(9), 'https://frontaliereticino.ch/blog/ristorni/'),
  };
}

const resolveCanton = async (card: Row) => (String(card.location || '').includes('Lugano') ? 'TI' : null);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAffinityBuild', () => {
  it('costruisce il profilo da manifest e campaign_deliveries e salva il cursore', async () => {
    const fake = createFakeFirestore(seedWithAliceClicks());
    const counts = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, resolveCanton });

    expect(counts).toMatchObject({
      job_clicks_human: 3,
      job_clicks_usable: 3,
      skipped_not_job_link: 1,
      attributes_from_delivery_manifest: 1,
      attributes_from_campaign_delivery: 2,
      profiles_created: 1,
      profiles_valid_after_write: 1,
    });
    const profile = fake.docs.get(profilePath(ALICE))!;
    expect(profile.user_id).toBe(affinityDocId(ALICE, SECRET));
    expect(profile.clicks).toBe(3);
    expect(profile.dimensions.canton.map((entry: Row) => entry.key)).toEqual(['TI']);
    expect(profile.dimensions.company_key.map((entry: Row) => entry.key).sort()).toEqual(['acme', 'beta', 'gamma']);
    expect(profile.dimensions.sector.map((entry: Row) => entry.key).sort()).toEqual(['edilizia', 'energy', 'tech']);
    expect(JSON.stringify(profile)).not.toContain('@');
    expect(fake.docs.get('job_email_affinity_meta/cursor')!.processed_until.getTime()).toBe(NOW.getTime() - 15 * 60 * 1000);
  });

  it('e idempotente: un giro ripetuto dal cursore o dallo stesso bootstrap non riconta i clic', async () => {
    const fake = createFakeFirestore(seedWithAliceClicks());
    await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, resolveCanton });
    const first = structuredClone(fake.docs.get(profilePath(ALICE)));

    const fromCursor = await runAffinityBuild({ db: fake.db, secret: SECRET, now: new Date(NOW.getTime() + 60 * 60 * 1000), resolveCanton });
    expect(fromCursor.job_clicks_human || 0).toBe(0);
    expect(fromCursor.profiles_written).toBe(0);

    const replay = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, resolveCanton });
    expect(replay.clicks_already_applied).toBe(3);
    expect(replay.profiles_written).toBe(0);
    expect(fake.docs.get(profilePath(ALICE))).toEqual(first);
  });

  it('senza cursore e senza --bootstrap-since si ferma con codice 2', async () => {
    const fake = createFakeFirestore(seedWithAliceClicks());
    await expect(runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW })).rejects.toMatchObject({ exitCode: 2 });
    expect(fake.writes).toEqual([]);
  });

  it('senza NEWSLETTER_SECRET non legge e non scrive', async () => {
    const fake = createFakeFirestore(seedWithAliceClicks());
    await expect(runAffinityBuild({ db: fake.db, secret: '', now: NOW, bootstrapSince: SINCE })).rejects.toThrow(/NEWSLETTER_SECRET/);
    expect(fake.reads()).toBe(0);
  });

  it('in dry-run conta senza scrivere nulla', async () => {
    const fake = createFakeFirestore(seedWithAliceClicks());
    const counts = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, dryRun: true, resolveCanton });
    expect(counts.profiles_written).toBe(1);
    expect(counts.writes).toBe(0);
    expect(fake.writes).toEqual([]);
  });

  it('scarta la raffica di 5 link dallo stesso messaggio in 3 secondi', async () => {
    const burst: Record<string, Row> = {};
    for (let index = 0; index < 5; index += 1) {
      Object.assign(burst, clickEvent(
        'job_alert_subscribers',
        BOB,
        new Date(hoursAgo(5).getTime() + index * 500),
        jobUrl({ jobId: `Z${index}`, surface: 'job_alert', deliveryId: 'd1' }),
        'scanner-msg',
      ));
    }
    const fake = createFakeFirestore({ ...baseSeed(), ...burst });
    const counts = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, resolveCanton });
    expect(counts.skipped_synthetic_scan_burst).toBe(5);
    expect(counts.job_clicks_human).toBe(0);
    expect(fake.docs.has(profilePath(BOB))).toBe(false);
  });

  it('un secondo clic sulla stessa consegna e annuncio, in un giro successivo, non conta', async () => {
    const url = jobUrl({ jobId: 'A', surface: 'job_alert', deliveryId: 'd1' });
    const fake = createFakeFirestore({
      ...baseSeed(),
      ...clickEvent('job_alert_subscribers', BOB, hoursAgo(30), url),
    });
    const first = await runAffinityBuild({ db: fake.db, secret: SECRET, now: hoursAgo(10), bootstrapSince: SINCE, resolveCanton });
    expect(first.clicks_applied).toBe(1);
    // Lo stesso annuncio della stessa consegna, cliccato di nuovo dopo la fine del primo giro.
    for (const [docPath, data] of Object.entries(clickEvent('job_alert_subscribers', BOB, hoursAgo(5), url))) fake.docs.set(docPath, data);
    const second = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, resolveCanton });
    expect(second.job_clicks_human).toBe(1);
    expect(second.clicks_applied || 0).toBe(0);
    expect(second.clicks_already_applied).toBe(1);
    const profile = fake.docs.get(profilePath(BOB))!;
    expect(profile.clicks).toBe(1);
    expect(profile.applied_clicks).toHaveLength(1);
    expect(JSON.stringify(profile.applied_clicks)).not.toContain(BOB);
  });

  it('un clic di contesto prima della finestra non nasconde lo stesso annuncio cliccato dentro la finestra', async () => {
    const url = jobUrl({ jobId: 'A', surface: 'job_alert', deliveryId: 'd1' });
    const fake = createFakeFirestore({
      ...baseSeed(),
      ...clickEvent('job_alert_subscribers', BOB, new Date(Date.parse(SINCE) - 10 * 1000), url),
      ...clickEvent('job_alert_subscribers', BOB, new Date(Date.parse(SINCE) + 60 * 60 * 1000), url),
    });
    const counts = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, resolveCanton });
    expect(counts.job_clicks_human).toBe(1);
    expect(counts.skipped_duplicate || 0).toBe(0);
    expect(counts.clicks_applied).toBe(1);
    expect(fake.docs.get(profilePath(BOB))!.clicks).toBe(1);
  });

  it('clic senza message_id: nessuna raffica fra invii diversi', async () => {
    const clicks: Record<string, Row> = {};
    for (let index = 0; index < 5; index += 1) {
      Object.assign(clicks, clickEvent(
        'job_alert_subscribers',
        BOB,
        new Date(hoursAgo(5).getTime() + index * 500),
        jobUrl({ jobId: `Z${index}`, surface: 'job_alert', deliveryId: `dz${index}` }),
        null as unknown as string,
      ));
    }
    const fake = createFakeFirestore({ ...baseSeed(), ...clicks });
    const counts = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, resolveCanton });
    expect(counts.skipped_synthetic_scan_burst || 0).toBe(0);
    expect(counts.job_clicks_human).toBe(5);
  });

  it('conta un solo clic per consegna e annuncio', async () => {
    const url = jobUrl({ jobId: 'A', surface: 'job_alert', deliveryId: 'd1' });
    const fake = createFakeFirestore({
      ...baseSeed(),
      ...clickEvent('job_alert_subscribers', BOB, hoursAgo(5), url),
      ...clickEvent('job_alert_subscribers', BOB, hoursAgo(4), url),
    });
    const counts = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, resolveCanton });
    expect(counts.skipped_duplicate).toBe(1);
    expect(fake.docs.get(profilePath(BOB))!.clicks).toBe(1);
  });

  it('salta e conta i clic senza caratteristiche e gli invii di QA', async () => {
    const fake = createFakeFirestore({
      ...baseSeed(),
      [`job_alert_subscribers/${BOB}/campaign_deliveries/${buildDeliveryDocId('qa-1', BOB)}`]: {
        is_operator_verification: true,
        ranking_jobs: [{ jobId: 'Q', category: 'qa', canton: 'TI' }],
      },
      ...clickEvent('job_alert_subscribers', BOB, hoursAgo(6), jobUrl({ jobId: 'Q', surface: 'job_alert', deliveryId: 'qa-1' })),
      ...clickEvent('job_alert_subscribers', BOB, hoursAgo(5), jobUrl({ jobId: 'X', surface: 'job_alert', deliveryId: 'missing' })),
    });
    const counts = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, resolveCanton });
    expect(counts.skipped_operator_send).toBe(1);
    expect(counts.skipped_no_attributes).toBe(1);
    expect(fake.docs.has(profilePath(BOB))).toBe(false);
  });

  it.each([
    ['opposizione registrata', { status: 'confirmed', ranking_personalization_opt_out: true }, 'opt_out'],
    ['disiscritto da tutto', { status: 'unsubscribed' }, 'unsubscribed_all'],
    ['account cancellato', { status: 'unsubscribed', account_deleted_at: '2026-10-01T00:00:00Z' }, 'account_deleted'],
  ])('%s: nessun profilo nuovo e quello esistente viene cancellato', async (_label, newsletter, reason) => {
    const fake = createFakeFirestore({
      ...seedWithAliceClicks(),
      [`newsletter_subscribers/${ALICE}`]: newsletter,
      [profilePath(ALICE)]: { user_id: affinityDocId(ALICE, SECRET), clicks: 4, version: 1, dimensions: {} },
    });
    const counts = await runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, resolveCanton });
    expect(counts[`persons_excluded_${reason}`]).toBe(1);
    expect(counts.profiles_deleted).toBe(1);
    expect(counts.profiles_written).toBe(0);
    expect(fake.docs.has(profilePath(ALICE))).toBe(false);
  });

  it('si ferma prima di scrivere se supera il tetto di letture', async () => {
    const fake = createFakeFirestore(seedWithAliceClicks());
    await expect(runAffinityBuild({ db: fake.db, secret: SECRET, now: NOW, bootstrapSince: SINCE, maxReads: 3, resolveCanton }))
      .rejects.toThrow(/tetto di letture/);
    expect(fake.writes).toEqual([]);
  });
});

describe('storedJobAttributes', () => {
  it('normalizza il vecchio annuncio con la stessa jobManifestEntry e ricava il cantone della scheda newsletter', async () => {
    expect(await storedJobAttributes({ jobId: 'C', category: 'Cantiere', canton: 'ti', companyKey: 'gamma', sector: 'Edilizia' }, 'job_alert', resolveCanton))
      .toEqual({ category: 'cantiere', canton: 'TI', company_key: 'gamma', sector: 'edilizia' });
    expect(await storedJobAttributes({ jobId: 'B', companyKey: 'beta', sector: 'energy', location: 'Lugano' }, 'newsletter', resolveCanton))
      .toEqual({ category: null, canton: 'TI', company_key: 'beta', sector: 'energy' });
    expect(await storedJobAttributes({ job_id: 'B', company_key: 'beta', category: null, canton: null, sector: 'x' }, 'newsletter', resolveCanton))
      .toEqual({ category: null, canton: null, company_key: 'beta', sector: 'x' });
  });
});

describe('affinityExclusionReason', () => {
  it('lascia il profilo a chi si e disiscritto solo in parte', () => {
    expect(affinityExclusionReason({ newsletter: { status: 'confirmed', daily_brief_frequency_override: 'off' }, jobAlert: { status: 'active' } })).toBeNull();
    expect(affinityExclusionReason({ newsletter: { status: 'inactive' }, jobAlert: { status: 'active' } })).toBeNull();
    expect(affinityExclusionReason({})).toBe('no_subscriber');
  });
});

describe('CLI', () => {
  it('il log contiene solo conteggi: niente email, pseudonimi o URL', async () => {
    const fake = createFakeFirestore(seedWithAliceClicks());
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...args) => { lines.push(args.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.join(' ')); });
    const previous = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = SECRET;
    try {
      await main(['node', 'build', '--bootstrap-since', SINCE, '--lag-minutes', '0'], { getDb: async () => fake.db });
      await main(['node', 'build', '--forget-email', ALICE, '--dry-run'], { getDb: async () => fake.db });
    } finally {
      if (previous === undefined) delete process.env.NEWSLETTER_SECRET;
      else process.env.NEWSLETTER_SECRET = previous;
    }
    const output = lines.join('\n');
    expect(output).toContain('profiles_written');
    expect(output).toContain('profile_found');
    expect(output).not.toMatch(/@/);
    expect(output).not.toMatch(/https?:/);
    expect(output).not.toContain(affinityDocId(ALICE, SECRET)!);
  });

  it('--forget-email cancella il profilo', async () => {
    const fake = createFakeFirestore({ [profilePath(ALICE)]: { clicks: 3, version: 1 } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = SECRET;
    try {
      await main(['node', 'build', '--forget-email', ALICE], { getDb: async () => fake.db });
    } finally {
      if (previous === undefined) delete process.env.NEWSLETTER_SECRET;
      else process.env.NEWSLETTER_SECRET = previous;
    }
    expect(fake.docs.has(profilePath(ALICE))).toBe(false);
  });

  it('parseArgs e redact', () => {
    expect(parseArgs(['node', 'x', '--dry-run', '--bootstrap-since', '2026-09-08T00:00:00Z'])).toMatchObject({ dryRun: true, bootstrapSince: '2026-09-08T00:00:00Z' });
    expect(() => parseArgs(['node', 'x', '--bootstrap-since', 'ieri'])).toThrow();
    expect(() => parseArgs(['node', 'x', '--boh'])).toThrow();
    expect(redact(`fallito su job_email_affinity/${'a'.repeat(32)} per ${ALICE}`)).toBe('fallito su job_email_affinity/<pseudonimo> per <email>');
  });
});
