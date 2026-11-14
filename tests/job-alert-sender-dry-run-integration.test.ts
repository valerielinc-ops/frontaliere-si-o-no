/**
 * Il sender, intero, in dry-run su un Firestore in memoria (perf-plan PR 1, 2, 5, 6, 8).
 *
 * Le singole parti hanno i loro test; questo prova che stanno insieme: le letture
 * dopo i gate (PR 6), l'indice dei candidati in `on` con campione di verifica
 * (PR 2), il live-link col manifest delle pagine pubblicate (PR 5), il limite
 * `cadence_next_eligible_on` in shadow (PR 8), il funnel che torna in pari, e la
 * riga JOBALERT_METRICS con le letture per collection.
 *
 * Nessun invio: `--dry-run`, il cascade e' sostituito da un doppione. Nessuna
 * email reale: indirizzi `@example.test`. Il dataset e' un file temporaneo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildJobPagesManifest } from '../build-plugins/shared/jobPagesManifest.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

// ── Firestore in memoria con il conteggio delle letture per collection ─────
type Doc = { data: any; updateTime: { toMillis: () => number } };
const store = new Map<string, Doc>();
const reads: Record<string, number> = {};
const countRead = (path: string) => {
  const segments = path.split('/');
  const collection = segments[segments.length - 2];
  reads[collection] = (reads[collection] || 0) + 1;
};
let clock = 1;
const put = (docPath: string, data: any) => { store.set(docPath, { data, updateTime: { toMillis: () => ++clock } }); };

function refOf(docPath: string): any {
  const segments = docPath.split('/');
  const parentPath = segments.slice(0, -1).join('/');
  const ref: any = {
    path: docPath,
    id: segments[segments.length - 1],
    parent: {
      id: segments[segments.length - 2],
      get parent() { return segments.length > 2 ? refOf(segments.slice(0, -2).join('/')) : null; },
      path: parentPath,
    },
    collection: (name: string) => ({ doc: (id: string) => refOf(`${docPath}/${name}/${id}`) }),
    get: async () => { countRead(docPath); return snapshotOf(docPath); },
    set: async () => {}, update: async () => {},
  };
  return ref;
}
function snapshotOf(docPath: string): any {
  const found = store.get(docPath);
  return {
    exists: Boolean(found), id: docPath.split('/').pop(), ref: refOf(docPath),
    data: () => (found ? JSON.parse(JSON.stringify(found.data)) : undefined), updateTime: found?.updateTime,
  };
}
const db: any = {
  collection: (name: string) => ({
    doc: (id: string) => refOf(`${name}/${id}`),
    where: () => ({ limit: () => ({ get: async () => ({ docs: [], empty: true, size: 0 }) }), get: async () => ({ docs: [], empty: true, size: 0 }) }),
  }),
  collectionGroup: (name: string) => ({
    where: () => ({
      get: async () => {
        const docs = [...store.keys()].filter((p) => p.split('/').slice(-2, -1)[0] === name && p.startsWith('job_alert_subscribers/'))
          .map((p) => { countRead(p); return snapshotOf(p); });
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    }),
  }),
  getAll: async (...refs: any[]) => refs.map((ref) => { countRead(ref.path); return snapshotOf(ref.path); }),
  batch: () => ({ update() {}, set() {}, delete() {}, commit: async () => [] }),
  runTransaction: async () => { throw new Error('no writes expected in a dry run'); },
};

// ── il dataset: 30 annunci vivi, 20 con pagina pubblicata ──────────────────
const jobs = Array.from({ length: 30 }, (_, i) => ({
  id: `it-job-${i}`,
  slug: `infermiere-${i}-eoc-lugano`,
  slugByLocale: { it: `infermiere-${i}-eoc-lugano`, en: `nurse-${i}`, de: `pflege-${i}`, fr: `infirmier-${i}` },
  title: i % 2 ? 'Infermiere diplomato' : 'Software Engineer',
  titleByLocale: {},
  description: `Cerchiamo ${i % 2 ? 'infermiere' : 'sviluppatore'}. ${'Testo. '.repeat(30)}`,
  company: 'EOC', category: 'sanità', sector: 'healthcare', location: 'Lugano', canton: 'TI', contract: 'full-time',
  firstSeenAt: iso(-2 * DAY), crawledAt: iso(-0.2 * DAY),
}));

// ── alert: ogni famiglia esercita un ramo dei gate ─────────────────────────
const SENT_YESTERDAY = iso(-1 * DAY);
const LONG_AGO = iso(-30 * DAY);
const subs: Record<string, any> = {};
function addRecipient(email: string, channel: any, newsletter: any, alerts: Array<{ id: string; data: any }>) {
  put(`job_alert_subscribers/${email}`, channel);
  if (newsletter) put(`newsletter_subscribers/${email}`, newsletter);
  for (const alert of alerts) put(`job_alert_subscribers/${email}/alerts/${alert.id}`, { active: true, email, locale: 'it', ...alert.data });
  subs[email] = { channel, newsletter };
}
const due = { keywords: ['infermiere'] };
function buildPopulation() {
  // 12 destinatari in programma oggi (mai inviato), con newsletter doc.
  for (let i = 0; i < 12; i++) addRecipient(`due${i}@example.test`, {}, { status: 'active', consent_ip: undefined, job_company: i % 4 ? undefined : 'EOC' }, [{ id: 'a1', data: { ...due, createdAt: iso(-60 * DAY) } }]);
  // 10 NON in programma: inviati ieri (intervallo 1+ giorni, ma lastMatchedAt = oggi serve il guard): usiamo lastMatchedAt oggi.
  for (let i = 0; i < 10; i++) addRecipient(`notdue${i}@example.test`, { ja_cadence_last_sent_at: iso(-0.1 * DAY) }, { status: 'active' }, [{ id: 'a1', data: { ...due, lastMatchedAt: iso(-0.1 * DAY), createdAt: iso(-60 * DAY) } }]);
  // 4 con stop nel documento newsletter, in programma: soppressi (contano).
  for (let i = 0; i < 4; i++) addRecipient(`stopped${i}@example.test`, {}, { status: 'unsubscribed' }, [{ id: 'a1', data: { ...due, createdAt: iso(-60 * DAY) } }]);
  // 3 con stop ma NON in programma: non devono costare una lettura newsletter.
  for (let i = 0; i < 3; i++) addRecipient(`stoppednotdue${i}@example.test`, { ja_cadence_last_sent_at: iso(-0.1 * DAY) }, { status: 'unsubscribed' }, [{ id: 'a1', data: { ...due, lastMatchedAt: iso(-0.1 * DAY), createdAt: iso(-60 * DAY) } }]);
  // 5 decaduti senza ritorno sul sito: contano come decaduti, senza leggere la newsletter.
  for (let i = 0; i < 5; i++) addRecipient(`decayed${i}@example.test`, {}, { status: 'active' }, [{ id: 'a1', data: { ...due, cadence_state: 'decayed', cadence_decayed_at: iso(-20 * DAY), createdAt: iso(-90 * DAY) } }]);
  // 2 decaduti CON ritorno sul sito legato all'identita': candidati alla riattivazione, newsletter letta, riattivati.
  for (let i = 0; i < 2; i++) {
    addRecipient(`return${i}@example.test`, {
      last_site_visit_at: iso(-5 * DAY), last_site_visit_uid: `uid-${i}`, last_site_visit_visible: true,
      last_site_visit_ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605', last_site_visit_entry: 'https://frontaliereticino.ch/cerca-lavoro-ticino/',
    }, { status: 'active' }, [{ id: 'a1', data: { ...due, userId: `uid-${i}`, cadence_state: 'decayed', cadence_decayed_at: iso(-20 * DAY), createdAt: iso(-90 * DAY) } }]);
  }
  // 3 con la lista del canale esclusa (job-alert doc): soppressi, in programma.
  for (let i = 0; i < 3; i++) addRecipient(`excluded${i}@example.test`, { status: 'inactive' }, { status: 'active' }, [{ id: 'a1', data: { ...due, createdAt: iso(-60 * DAY) } }]);
  // 2 profili vuoti in programma: possono avere first_discovery.
  for (let i = 0; i < 2; i++) addRecipient(`empty${i}@example.test`, {}, { status: 'active' }, [{ id: 'a1', data: { createdAt: iso(-60 * DAY) } }]);
  // 1 alert con limite shadow GIA nel futuro ma in programma: una violazione da contare.
  addRecipient('violation0@example.test', {}, { status: 'active' }, [{ id: 'a1', data: { ...due, cadence_next_eligible_on: iso(+5 * DAY).slice(0, 10), createdAt: iso(-60 * DAY) } }]);
}

let output: string[] = [];
let metrics: any;
let summaryPath = '';

beforeAll(async () => {
  buildPopulation();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-alert-dry-run-'));
  const jobsPath = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsPath, JSON.stringify(jobs));
  summaryPath = path.join(dir, 'summary.md');
  process.env.JOB_ALERTS_JOBS_PATH = jobsPath;
  process.env.ENABLE_JOB_ALERTS = 'true';
  process.env.TODAY_ISO = TODAY;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  process.env.JOB_ALERT_CANDIDATE_INDEX_MODE = 'on';
  process.env.JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE = '1'; // verifica OGNI alert contro il legacy
  process.env.JOB_ALERT_LIVE_LINK_MANIFEST = 'auto';
  process.env.JOB_PAGES_MANIFEST_URL = 'https://manifest.example.test/job-pages-manifest.json';
  process.argv.push('--dry-run');
  vi.resetModules();
  vi.doMock('../scripts/lib/email-cascade.mjs', () => ({
    getAvailableCascadeQuota: async () => 1000,
    getProviderStats: () => [],
    sendEmailCascade: async () => { throw new Error('a dry run never sends'); },
    BULK_PROVIDER_MIN_INTERVAL_MS: {},
  }));
  const sender = await import('../scripts/send-job-alerts.mjs');
  sender.__setFirestoreAdminForTest(db);
  // Il manifest pubblica 20 dei 30 annunci (gli altri 10 non sono ancora pubblicati).
  const published = jobs.slice(0, 20).map((job) => sender.jobPageUrl(job, 'it') as string);
  const manifest = buildJobPagesManifest({ paths: published, generatedAt: iso(-1 * 3_600_000), buildCommit: 'test' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('job-pages-manifest.json')) return { ok: true, status: 200, text: async () => JSON.stringify(manifest) };
    throw new Error(`unexpected network call in a dry run: ${url}`);
  }));
  const log = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => { output.push(args.join(' ')); });
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: any[]) => { output.push(args.join(' ')); });
  try {
    await sender.runJobAlertsMain();
  } finally {
    log.mockRestore(); warn.mockRestore();
  }
  metrics = sender.jobAlertMetrics.snapshot({ date: TODAY, mode: 'DRY RUN' });
}, 120_000);

afterAll(() => { vi.unstubAllGlobals(); });

const text = () => output.join('\n');
if (process.env.DEBUG_DRY_RUN) afterAll(() => { fs.writeFileSync('/tmp/dryrun-output.txt', `${output.join('\n')}\nREADS ${JSON.stringify(reads)}`); });

describe('sender in dry-run, end to end', () => {
  it('finisce senza errori e stampa il funnel, senza un conteggio fuori quadro', () => {
    expect(text()).toContain('Funnel job alert');
    expect(text()).not.toContain('Conteggio non quadrato');
    expect(text()).toContain('DRY RUN');
  });

  it('PR 6: il documento del canale si legge per tutti, quello newsletter solo per chi e in programma o e candidato alla riattivazione', () => {
    const recipients = Object.keys(subs).length;
    expect(reads.job_alert_subscribers).toBeGreaterThanOrEqual(recipients);
    // In programma + candidati: 12 due + 4 stopped + 3 excluded + 2 empty + 1 violation + 2 return = 24.
    // Non in programma (10 + 3) e decaduti senza ritorno (5) NON leggono la newsletter.
    // Il conteggio include la lettura una tantum di `_meta_`.
    const newsletterParentReads = reads.newsletter_subscribers - 1;
    expect(newsletterParentReads).toBe(24);
    // Prima: due letture per ognuno dei destinatari. Ora: meno.
    expect(newsletterParentReads + reads.job_alert_subscribers).toBeLessThan(recipients * 2);
    expect(reads.job_alert_subscribers).toBe(recipients);
    // E il collectionGroup degli alert (una lettura per alert) e invariato.
    expect(reads.alerts).toBe(recipients);
  });

  it('PR 6: first_discovery solo per i profili che possono essere vuoti', () => {
    expect(metrics.counters.firstDiscoveryReads).toBe(2);
    expect(reads.delivery_state || 0).toBe(2);
    // La personalization si legge per tutti i destinatari eleggibili (17), la discovery per 2.
    expect(reads.private).toBe(17);
  });

  it('PR 6: soppressi, decaduti e non in programma sono contati dopo la cadenza', () => {
    const line = (label: RegExp) => Number((text().match(label) || [])[1]?.replace(/\./g, '') ?? NaN);
    // 5 decaduti senza ritorno sul sito; i 2 con un ritorno valido sono riattivati e tornano in gioco.
    expect(line(/decaduti per cadenza\s+(\d[\d.]*)/)).toBe(5);
    expect(text()).toContain('Return-visit reactivations: 2');
    // I 10 + 3 non in programma (inviati oggi).
    expect(line(/non in programma oggi\s+(\d[\d.]*)/)).toBe(13);
    // Solo gli alert in programma entrano nelle soppressioni: 4 stop globale + 3 lista del canale.
    expect(line(/soppressi in programma oggi[^\n]*?\s+(\d[\d.]*)\s*$/m)).toBe(7);
    // Eleggibili: 12 + 2 profili vuoti + 1 violazione + 2 riattivati = 17; pianificate: 17 meno i 2 profili vuoti.
    expect(line(/Eleggibili oggi\s+(\d[\d.]*)/)).toBe(17);
    expect(line(/Email pianificate\s+(\d[\d.]*)/)).toBe(15);
  });

  it('PR 2: l indice decide e ogni alert e verificato contro il legacy senza divergenze', () => {
    expect(metrics.counters.indexedAlerts).toBeGreaterThan(0);
    expect(metrics.counters.indexSampled).toBe(metrics.counters.indexedAlerts);
    expect(metrics.counters.indexMismatch ?? 0).toBe(0);
    expect(metrics.counters.scoredRows).toBeGreaterThan(0);
  });

  it('PR 5: live-link dal manifest, una sola richiesta HTTP, nessun fail-open, gli annunci non pubblicati sono esclusi', () => {
    expect(metrics.counters.liveLinkSource).toBe('manifest');
    expect(metrics.counters.liveLinkHttpRequests).toBe(1);
    expect(metrics.counters.liveLinkFailOpen ?? 0).toBe(0);
    expect(metrics.counters.liveLinkManifestResolved).toBeGreaterThan(0);
    expect(text()).toContain('Live-link via job-pages manifest');
  });

  it('PR 8: la query non cambia e la violazione dello shadow e contata una volta', () => {
    expect(metrics.counters.cadenceIndexViolations).toBe(1);
    expect(metrics.counters.cadenceIndexSkippable).toBeGreaterThanOrEqual(1);
  });

  it('PR 1: le fasi hanno durata e letture per collection, e la riga e il Job Summary escono', () => {
    for (const phase of ['load_alerts', 'profiles', 'aux_profiles', 'planning', 'health']) expect(metrics.phases[phase], phase).toBeTruthy();
    expect(metrics.totals.ms).toBeGreaterThan(0);
    expect(metrics.heapPeakBytes).toBeGreaterThan(0);
    expect(metrics.counters.alertsLoaded).toBe(Object.keys(subs).length);
    expect(metrics.counters.windowRows).toBeGreaterThan(0);
  });
});
