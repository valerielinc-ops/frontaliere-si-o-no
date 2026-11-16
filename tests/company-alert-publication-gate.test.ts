/**
 * CompanyAlert a deploy avvenuto (perf-plan email senders, punto 1).
 *
 * Quattro cose da provare:
 *  1. il CONTRATTO del workflow: niente `push` o `workflow_run` morto, dispatch
 *     esplicito dal post-publish, cron di sicurezza, `gate` leggero senza
 *     checkout, `concurrency` sul job vero, checkout allo SHA pubblicato;
 *  2. il FILTRO: un annuncio la cui pagina non e' nel manifest si RIMANDA, non si
 *     marca come inviato, e a manifest aggiornato parte una volta sola;
 *  3. la FINESTRA di novita' allargata non rimanda mai un annuncio gia' inviato e
 *     non apre annunci chiusi o scaduti;
 *  4. CONSENSO e SOPPRESSIONE restano quelli di prima, e il kill switch riporta
 *     al comportamento precedente.
 *
 * Nessuna email reale (`@example.test`), nessuna rete (fetch e' un doppione).
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  buildRecipientSections,
  claimRecipientSections,
  classifyRecipientConsent,
  collectGateCandidatePool,
  finalizeRecipientDelivery,
  markRecipientDeliveryAttempted,
  resolveSendableRecipients,
  selectNewlyPublishedJobs,
} from '../scripts/send-company-alerts.mjs';
import { createSenderMetrics } from '../scripts/lib/sender-metrics.mjs';
import {
  DEFAULT_IMMEDIATE_WINDOW_HOURS,
  MAX_IMMEDIATE_WINDOW_HOURS,
  createCompanyAlertPublicationGate,
  resolveCompanyAlertTrigger,
  resolveImmediateWindowHours,
  resolveLiveFilterMode,
} from '../scripts/lib/company-alert-publication-gate.mjs';
import { createJobPageUrlResolver } from '../scripts/lib/job-page-url.mjs';
import { BASE_URL } from '../scripts/lib/job-alert-unsub-urls.mjs';
import { jobPageUrl as jobAlertPageUrl } from '../scripts/send-job-alerts.mjs';
import { localePathPrefix } from '../scripts/lib/articleContent.mjs';
import { buildJobPagesManifest, normalizeJobPagePath } from '../build-plugins/shared/jobPagesManifest.mjs';
import { DEDUP_WINDOW_MS, DELIVERY_STATES } from '../scripts/lib/alert-sent-jobs.mjs';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';

const ROOT = path.resolve(__dirname, '..');
const WF_DIR = path.join(ROOT, '.github/workflows');
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const HOUR = 3_600_000;
const iso = (ageHours: number) => new Date(NOW - ageHours * HOUR).toISOString();

const cantonSlugFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/canton-url-slugs.json'), 'utf8'));
const municipalitiesFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/canton-municipalities.json'), 'utf8'));
const pageUrl = createJobPageUrlResolver({
  cantonSlugFile,
  municipalitiesFile,
  baseUrl: BASE_URL,
  localePathPrefix: (locale: string) => (locale === 'it' ? '' : `/${locale}`),
});

// ── fixture sintetiche ─────────────────────────────────────────────────────
function job(id: string, company = 'Acme', extra: Record<string, unknown> = {}): any {
  return {
    id,
    title: `Fixture opening ${id}`,
    company,
    companyKey: canonicalCompanyProfileSlug(company, company),
    location: 'Lugano',
    canton: 'TI',
    slug: `fixture-opening-${id}-lugano`,
    description: 'Controlled fixture.',
    firstSeenAt: iso(2),
    url: `https://jobs.fixture.invalid/${id}`,
    ...extra,
  };
}
function alert(id: string, companyKey: string, extra: Record<string, unknown> = {}): any {
  return {
    id,
    ref: { path: `job_alert_subscribers/${id}/alerts/${id}`, id },
    email: `${id}@example.test`,
    locale: 'it',
    frequency: 'immediate',
    specificCompanyKey: companyKey,
    active: true,
    paused: false,
    ...extra,
  };
}
function manifestFor(jobs: any[], generatedAtMs = NOW) {
  return buildJobPagesManifest({
    paths: jobs.map((item) => normalizeJobPagePath(pageUrl(item, 'it'))),
    generatedAt: new Date(generatedAtMs).toISOString(),
  });
}
const manifestFetch = (manifest: unknown) => vi.fn(async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(manifest),
}));
const gateConfig = { mode: 'auto', url: 'https://manifest.test/job-pages-manifest.json', maxAgeHours: 36, minCoverage: 0.5 };
/** Inventario che il manifest copre, cosi' la coerenza (>= 50%) e' soddisfatta. */
const standing = () => Array.from({ length: 6 }, (_, i) => job(`standing-${i}`, 'Altro', { firstSeenAt: iso(300) }));

function serializedDb(initial: Record<string, Record<string, unknown>>) {
  const docs = new Map(Object.entries(initial));
  let tail: Promise<unknown> = Promise.resolve();
  return {
    docs,
    runTransaction(fn: (tx: any) => Promise<unknown>) {
      const run = tail.then(async () => {
        const updates: Array<{ ref: { path: string }; data: Record<string, unknown> }> = [];
        const tx = {
          get: async (documentRef: { path: string }) => {
            const data = docs.get(documentRef.path);
            return { exists: Boolean(data), data: () => data };
          },
          update: (documentRef: { path: string }, data: Record<string, unknown>) => { updates.push({ ref: documentRef, data }); },
        };
        const result = await fn(tx);
        for (const update of updates) docs.set(update.ref.path, { ...(docs.get(update.ref.path) || {}), ...update.data });
        return result;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

// ── 1. contratto del workflow ──────────────────────────────────────────────
describe('workflow send-company-alerts.yml: a deploy avvenuto', () => {
  const text = fs.readFileSync(path.join(WF_DIR, 'send-company-alerts.yml'), 'utf8');
  const doc: any = YAML.parse(text, { logLevel: 'silent' });

  it('non parte piu\' su push: niente push, niente filtro su data/jobs/by-crawler', () => {
    expect(Object.keys(doc.on)).not.toContain('push');
    // Il blocco originale compare solo nel commento di revert, mai come chiave `on:`.
    const withoutComments = text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(withoutComments).not.toMatch(/by-crawler\/\*\*/);
  });

  it('usa il dispatch esplicito post-publish e non il workflow_run morto', () => {
    expect(doc.on.workflow_run).toBeUndefined();
    expect(doc.on.workflow_dispatch.inputs.source_sha.type).toBe('string');
    expect(doc.on.workflow_dispatch.inputs.source_run_id.type).toBe('string');
  });

  it('il cron orario di sicurezza e il dispatch manuale restano', () => {
    expect(doc.on.schedule).toEqual([{ cron: '41 * * * *' }]);
    expect(doc.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
  });

  it('il gate dispatch procede senza checkout ne Node', () => {
    const gate = doc.jobs.gate;
    expect(gate.if).toBeUndefined();
    const uses = (gate.steps as any[]).map((step) => String(step.uses ?? ''));
    expect(uses.some((u) => u.startsWith('actions/checkout'))).toBe(false);
    expect(uses.some((u) => u.includes('setup-node') || u.includes('npm-ci-cached'))).toBe(false);
    expect(gate['timeout-minutes']).toBeLessThanOrEqual(10);
  });

  it('la concurrency sta sul job vero (non sul workflow ne sul gate) e non cancella', () => {
    expect(doc.concurrency).toBeUndefined();
    expect(doc.jobs.gate.concurrency).toBeUndefined();
    expect(doc.jobs['send-company-alerts'].concurrency).toEqual({ group: 'company-alerts', 'cancel-in-progress': false });
    expect(doc.jobs['send-company-alerts'].needs).toBe('gate');
    expect(doc.jobs['send-company-alerts'].if).toContain("needs.gate.outputs.proceed == 'true'");
  });

  it('il checkout usa lo SHA pubblicato, con ripiego sul ref di default', () => {
    const checkout = (doc.jobs['send-company-alerts'].steps as any[]).find((s) => String(s.uses ?? '').startsWith('actions/checkout'));
    expect(checkout.with.ref).toBe('${{ inputs.source_sha || github.sha }}');
  });

  it('il workflow non dispatcha ne modifica i workflow di deploy', () => {
    const code = text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/gh workflow run|createWorkflowDispatch|workflows\/[^\s]*\/dispatches/i);
    expect(code).not.toMatch(/deploy\.yml|deploy-publish\.yml/);
  });

  it('le due nuove chiavi Remote Config sono in RC_TO_ENV e nel --only-env', () => {
    const load = (doc.jobs['send-company-alerts'].steps as any[]).find((s) => String(s.run ?? '').includes('load-rc-env.mjs'));
    const listed = String(load.run).match(/--only-env=(\S+)/)![1].split(',');
    const mapped = new Set(Object.values(RC_TO_ENV as Record<string, string[]>).flat());
    for (const key of ['COMPANY_ALERT_LIVE_LINK_FILTER', 'COMPANY_ALERT_IMMEDIATE_WINDOW_HOURS']) {
      expect(mapped.has(key), key).toBe(true);
      expect(listed, key).toContain(key);
    }
  });
});

// ── parita' con la jobalert ────────────────────────────────────────────────
describe('URL della pagina annuncio: stessa risposta del sender della jobalert', () => {
  const cases = [
    job('a'),
    job('b', 'Acme', { canton: 'GR', location: 'Poschiavo' }),
    job('c', 'Acme', { slugByLocale: { it: 'it-slug', en: 'en-slug' } }),
    job('d', 'Acme', { canton: 'ZH', location: 'Zurigo' }),
    job('e', 'Acme', { slug: '', slugByLocale: {} }),
  ];
  for (const locale of ['it', 'en', 'de', 'fr']) {
    it(`locale ${locale}`, () => {
      for (const item of cases) expect(pageUrl(item, locale)).toBe(jobAlertPageUrl(item, locale));
    });
  }
  it('il prefisso di locale inlined coincide con quello canonico', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(locale === 'it' ? '' : `/${locale}`).toBe(localePathPrefix(locale));
    }
  });
});

// ── configurazione ─────────────────────────────────────────────────────────
describe('configurazione da Remote Config', () => {
  it('filtro: `on` di default, `off` solo se esplicito (kill switch)', () => {
    expect(resolveLiveFilterMode({})).toBe('on');
    expect(resolveLiveFilterMode({ COMPANY_ALERT_LIVE_LINK_FILTER: '' })).toBe('on');
    expect(resolveLiveFilterMode({ COMPANY_ALERT_LIVE_LINK_FILTER: 'garbage' })).toBe('on');
    expect(resolveLiveFilterMode({ COMPANY_ALERT_LIVE_LINK_FILTER: 'ON' })).toBe('on');
    expect(resolveLiveFilterMode({ COMPANY_ALERT_LIVE_LINK_FILTER: ' off ' })).toBe('off');
  });

  it('finestra: 48 h di default, parametro RC, alias legacy, valori inutilizzabili e tetto', () => {
    expect(DEFAULT_IMMEDIATE_WINDOW_HOURS).toBe(48);
    expect(resolveImmediateWindowHours({})).toBe(48);
    expect(resolveImmediateWindowHours({ COMPANY_ALERT_IMMEDIATE_WINDOW_HOURS: '36' })).toBe(36);
    expect(resolveImmediateWindowHours({ COMPANY_ALERT_WINDOW_HOURS: '6' })).toBe(6);
    expect(resolveImmediateWindowHours({ COMPANY_ALERT_IMMEDIATE_WINDOW_HOURS: '12', COMPANY_ALERT_WINDOW_HOURS: '6' })).toBe(12);
    for (const bad of ['', 'abc', '0', '-5', 'NaN']) {
      expect(resolveImmediateWindowHours({ COMPANY_ALERT_IMMEDIATE_WINDOW_HOURS: bad })).toBe(48);
    }
    expect(resolveImmediateWindowHours({ COMPANY_ALERT_IMMEDIATE_WINDOW_HOURS: '100000' })).toBe(MAX_IMMEDIATE_WINDOW_HOURS);
  });

  it('trigger: workflow_run, schedule, dispatch; il push non e\' piu\' un trigger', () => {
    expect(resolveCompanyAlertTrigger({ GITHUB_EVENT_NAME: 'workflow_run' })).toBe('workflow_run');
    expect(resolveCompanyAlertTrigger({ GITHUB_EVENT_NAME: 'schedule' })).toBe('schedule');
    expect(resolveCompanyAlertTrigger({ GITHUB_EVENT_NAME: 'workflow_dispatch' })).toBe('dispatch');
    expect(resolveCompanyAlertTrigger({ COMPANY_ALERT_TRIGGER: 'dispatch', GITHUB_EVENT_NAME: 'schedule' })).toBe('dispatch');
    expect(resolveCompanyAlertTrigger({ GITHUB_EVENT_NAME: 'push' })).toBe('legacy-push');
    expect(resolveCompanyAlertTrigger({})).toBe('other');
  });
});

// ── 2. il filtro ───────────────────────────────────────────────────────────
describe('il gate di pubblicazione', () => {
  it('manifest fresco: una pagina presente e viva, una assente e rimandata (metriche comprese)', async () => {
    const published = job('published');
    const missing = job('missing');
    const metrics = createSenderMetrics({ tag: 'COMPANYALERT', phases: ['x'] });
    const gate = await createCompanyAlertPublicationGate({
      trigger: 'workflow_run',
      inventory: [...standing(), published],
      datasetAtMs: NOW,
      jobPageUrl: pageUrl,
      config: gateConfig,
      fetchImpl: manifestFetch(manifestFor([...standing(), published])) as any,
      metrics,
    });
    expect(gate.source).toBe('manifest');
    expect(gate.isLive(published)).toBe(true);
    expect(gate.isLive(missing)).toBe(false);
    expect(gate.isLive(missing)).toBe(false); // memoizzata: il conteggio e' per annuncio distinto
    expect(gate.deferredCount).toBe(1);
    expect(metrics.snapshot().counters).toMatchObject({
      liveFilterMode: 'on',
      liveFilterSource: 'manifest',
      liveFilterDeferred: 1,
    });
  });

  it('un annuncio senza slug non ha pagina da verificare: non si filtra (come la jobalert)', async () => {
    const noSlug = job('no-slug', 'Acme', { slug: '', slugByLocale: {} });
    const gate = await createCompanyAlertPublicationGate({
      trigger: 'schedule', inventory: standing(), datasetAtMs: NOW, jobPageUrl: pageUrl, config: gateConfig,
      fetchImpl: manifestFetch(manifestFor(standing())) as any,
    });
    expect(gate.isLive(noSlug)).toBe(true);
  });

  it('workflow_run con manifest inutilizzabile (404, stantio, malformato): rimanda TUTTO', async () => {
    const some = job('some');
    for (const fetchImpl of [
      vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
      manifestFetch(manifestFor([some], NOW - 100 * HOUR)),
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '{not json' })),
      vi.fn(async () => { throw new Error('offline'); }),
    ]) {
      const warn = vi.fn();
      const gate = await createCompanyAlertPublicationGate({
        trigger: 'workflow_run', inventory: [some], datasetAtMs: NOW, jobPageUrl: pageUrl, config: gateConfig,
        fetchImpl: fetchImpl as any, warn,
      });
      expect(gate.deferAll).toBe(true);
      expect(gate.isLive(some)).toBe(false);
      expect(gate.isLive(job('other'))).toBe(false);
      expect(warn).toHaveBeenCalled();
    }
  });

  it('manifest con copertura troppo bassa non e\' affidabile: workflow_run rimanda, cron ripiega su HTTP', async () => {
    const fresh = job('fresh');
    const manifest = manifestFor([job('unrelated')]); // non copre l'inventario
    const base = { inventory: [...standing(), fresh], datasetAtMs: NOW, jobPageUrl: pageUrl, config: gateConfig, fetchImpl: manifestFetch(manifest) as any, warn: vi.fn() };
    const viaRun = await createCompanyAlertPublicationGate({ ...base, trigger: 'workflow_run' });
    expect(viaRun.deferAll).toBe(true);
    const viaCron = await createCompanyAlertPublicationGate({ ...base, trigger: 'schedule', httpCheck: async () => true });
    expect(viaCron.deferAll).toBe(false);
    expect(viaCron.source).toBe('http');
    expect(viaCron.reason).toBe('low-coverage');
  });

  it('cron/manuale con manifest assente: controllo HTTP per pagina, nessun fail-open', async () => {
    const live = job('live');
    const dead = job('dead');
    const calls: string[] = [];
    const httpCheck = async (url: string) => { calls.push(url); return url === pageUrl(live, 'it'); };
    const gate = await createCompanyAlertPublicationGate({
      trigger: 'schedule', inventory: [live, dead], datasetAtMs: NOW, jobPageUrl: pageUrl, config: gateConfig,
      fetchImpl: vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })) as any,
      httpCheck, warn: vi.fn(),
    });
    expect(gate.source).toBe('http');
    await gate.prepare([live, dead]);
    expect(calls.sort()).toEqual([pageUrl(dead, 'it'), pageUrl(live, 'it')].sort());
    expect(gate.isLive(live)).toBe(true);
    expect(gate.isLive(dead)).toBe(false);
    // Niente fail-open: se TUTTE le pagine fresche risultano non vive (e' il caso normale
    // prima del deploy) si rimanda tutto, non si spedisce non verificato.
    const allDead = await createCompanyAlertPublicationGate({
      trigger: 'dispatch', inventory: [], datasetAtMs: NOW, jobPageUrl: pageUrl, config: gateConfig,
      fetchImpl: vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })) as any,
      httpCheck: async () => false, warn: vi.fn(),
    });
    const fresh = Array.from({ length: 8 }, (_, i) => job(`pre-deploy-${i}`));
    await allDead.prepare(fresh);
    expect(fresh.every((item) => allDead.isLive(item) === false)).toBe(true);
  });

  it('HTTP: un errore del controllo e un URL non verificato rimandano, backlog incluso', async () => {
    const checked = job('checked');
    const backlog = job('backlog');
    const gate = await createCompanyAlertPublicationGate({
      trigger: 'schedule', inventory: [], datasetAtMs: NOW, jobPageUrl: pageUrl, config: { ...gateConfig, mode: 'off' },
      httpCheck: async () => { throw new Error('boom'); },
    });
    await gate.prepare([checked]);
    expect(gate.isLive(checked)).toBe(false);
    expect(gate.isLive(backlog)).toBe(false);
  });

  it('HTTP: il pool include il backlog da allJobs e solo una GET positiva consente la sezione prima del claim', async () => {
    const deferredJob = job('old-deferred', 'Acme', { firstSeenAt: iso(200) });
    const target = alert('follower-http-backlog', 'acme', {
      deliveryLedger: { 'old-deferred': { state: DELIVERY_STATES.DEFERRED, at: NOW - HOUR, attempts: 1 } },
    });
    const allJobs = [deferredJob];
    const pool = collectGateCandidatePool({ alerts: [target], newJobs: [], now: NOW, allJobs });
    expect(pool).toEqual(new Set([deferredJob]));

    const makeGate = (live: boolean) => createCompanyAlertPublicationGate({
      trigger: 'schedule', inventory: [], datasetAtMs: NOW, jobPageUrl: pageUrl,
      config: { ...gateConfig, mode: 'off' }, httpCheck: async () => live,
    });
    const offlineGate = await makeGate(false);
    expect(offlineGate.source).toBe('http');
    await offlineGate.prepare([...pool]);
    const offlineSections = buildRecipientSections([target], [], NOW, DEDUP_WINDOW_MS, allJobs, {
      publicationGate: offlineGate,
    });
    expect(offlineSections).toEqual([]);
    const db = { runTransaction: vi.fn() };
    expect(await claimRecipientSections(db, offlineSections, NOW, 'claim-http-backlog')).toEqual([]);
    expect(db.runTransaction).not.toHaveBeenCalled();

    const liveGate = await makeGate(true);
    await liveGate.prepare([...pool]);
    const liveSections = buildRecipientSections([target], [], NOW, DEDUP_WINDOW_MS, allJobs, {
      publicationGate: liveGate,
    });
    expect(liveSections).toHaveLength(1);
  });

  it('HTTP: oltre il tetto di richieste per run gli annunci in eccesso si rimandano', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => job(`cap-${i}`));
    const httpCheck = vi.fn(async () => true);
    const gate = await createCompanyAlertPublicationGate({
      trigger: 'schedule', inventory: [], datasetAtMs: NOW, jobPageUrl: pageUrl, config: { ...gateConfig, mode: 'off' },
      httpCheck, maxHttpChecks: 2,
    });
    await gate.prepare(jobs);
    expect(httpCheck).toHaveBeenCalledTimes(2);
    expect(jobs.slice(0, 2).every((item) => gate.isLive(item))).toBe(true);
    expect(jobs.slice(2).every((item) => gate.isLive(item) === false)).toBe(true);
  });

  it('kill switch: con COMPANY_ALERT_LIVE_LINK_FILTER=off nessun filtro, nessuna richiesta', async () => {
    const fetchImpl = vi.fn();
    const gate = await createCompanyAlertPublicationGate({
      trigger: 'workflow_run', mode: 'off', inventory: [], datasetAtMs: NOW, jobPageUrl: pageUrl, config: gateConfig, fetchImpl: fetchImpl as any,
    });
    expect(gate.isLive(job('anything'))).toBe(true);
    expect(gate.deferAll).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── il filtro dentro il sender: rimandato, non marcato, poi inviato una volta sola ──
describe('un annuncio non ancora pubblicato si rimanda e poi parte una sola volta', () => {
  it('manifest senza l\'annuncio: nessuna sezione, nessuna scrittura; manifest aggiornato: un invio, poi nessun reinvio', async () => {
    const target = alert('follower-1', 'acme');
    const fresh = job('fresh-1', 'Acme', { firstSeenAt: iso(1) });
    const others = standing();
    const db = serializedDb({ [target.ref.path]: { ...target, ref: undefined } });

    // Run 1 — il deploy non ha ancora pubblicato la pagina.
    const gate1 = await createCompanyAlertPublicationGate({
      trigger: 'schedule', inventory: [...others, fresh], datasetAtMs: NOW, jobPageUrl: pageUrl, config: gateConfig,
      fetchImpl: manifestFetch(manifestFor(others)) as any,
    });
    expect(gate1.source).toBe('manifest');
    const sections1 = buildRecipientSections([target], [fresh], NOW, DEDUP_WINDOW_MS, [fresh], { publicationGate: gate1 });
    expect(sections1).toEqual([]);
    expect(gate1.deferredCount).toBe(1);
    // Nessuna traccia: il dedup (`sentJobIds`) e il ledger non hanno visto l'annuncio.
    const afterRun1 = db.docs.get(target.ref.path) as any;
    expect(afterRun1.sentJobIds).toBeUndefined();
    expect(afterRun1.deliveryLedger).toBeUndefined();
    // E ancora selezionabile dalla finestra di novita' della run successiva.
    expect(selectNewlyPublishedJobs([fresh], NOW + 3 * HOUR, 48 * HOUR)).toHaveLength(1);

    // Run 2 — il deploy ha pubblicato: il manifest ora contiene la pagina.
    const gate2 = await createCompanyAlertPublicationGate({
      trigger: 'workflow_run', inventory: [...others, fresh], datasetAtMs: NOW, jobPageUrl: pageUrl, config: gateConfig,
      fetchImpl: manifestFetch(manifestFor([...others, fresh])) as any,
    });
    const sections2 = buildRecipientSections([target], [fresh], NOW + HOUR, DEDUP_WINDOW_MS, [fresh], { publicationGate: gate2 });
    expect(sections2).toHaveLength(1);
    expect(sections2[0].jobs.map((item: any) => item.id)).toEqual(['fresh-1']);
    const [claimed] = await claimRecipientSections(db, sections2, NOW + HOUR, 'claim-run-2');
    expect(claimed.jobs.map((item: any) => item.id)).toEqual(['fresh-1']);
    await markRecipientDeliveryAttempted(db, [{ ref: target.ref, sentJobs: claimed.jobs }], NOW + HOUR, 'claim-run-2');
    await finalizeRecipientDelivery(db, [{ ref: target.ref, sentJobs: claimed.jobs }], 'accepted', NOW + HOUR);
    const afterRun2 = db.docs.get(target.ref.path) as any;
    expect(Object.keys(afterRun2.sentJobIds)).toEqual(['fresh-1']);

    // Run 3 — ancora nella finestra e ancora nel manifest: NON si reinvia.
    const persisted = { ...target, ...afterRun2, ref: target.ref };
    const sections3 = buildRecipientSections([persisted], [fresh], NOW + 2 * HOUR, DEDUP_WINDOW_MS, [fresh], { publicationGate: gate2 });
    expect(sections3).toEqual([]);
    // Neanche se il filtro e' spento (kill switch) o il manifest sparisce: la dedup resta.
    expect(buildRecipientSections([persisted], [fresh], NOW + 2 * HOUR, DEDUP_WINDOW_MS, [fresh])).toEqual([]);
  });

  it('il filtro tocca anche il backlog differito e il recupero del consenso (allJobs), non solo le novita\'', () => {
    const target = alert('follower-2', 'acme', {
      deliveryLedger: { 'old-deferred': { state: DELIVERY_STATES.DEFERRED, at: NOW - HOUR, attempts: 1 } },
    });
    const deferredJob = job('old-deferred', 'Acme', { firstSeenAt: iso(200) });
    const gate = { isLive: (item: any) => item.id !== 'old-deferred' };
    expect(buildRecipientSections([target], [], NOW, DEDUP_WINDOW_MS, [deferredJob], { publicationGate: gate })).toEqual([]);
    expect(buildRecipientSections([target], [], NOW, DEDUP_WINDOW_MS, [deferredJob], { publicationGate: { isLive: () => true } })).toHaveLength(1);
  });

  it('senza gate installato il comportamento e\' quello di prima (nessun filtro)', () => {
    const target = alert('follower-3', 'acme');
    const unpublished = job('unpublished', 'Acme', { firstSeenAt: iso(1) });
    expect(buildRecipientSections([target], [unpublished], NOW)).toHaveLength(1);
  });
});

// ── 3. la finestra allargata ───────────────────────────────────────────────
describe('finestra di novita\' allargata (48 h)', () => {
  const windowMs = 48 * HOUR;

  it('un annuncio visto 20 ore prima del deploy e ancora nella finestra; uno di 3 giorni fa no', () => {
    const jobs = [job('twenty', 'Acme', { firstSeenAt: iso(20) }), job('three-days', 'Acme', { firstSeenAt: iso(72) })];
    expect(selectNewlyPublishedJobs(jobs, NOW, windowMs).map((item: any) => item.id)).toEqual(['twenty']);
    // Con la finestra di prima (6 h) l'annuncio di 20 ore sarebbe uscito senza mai partire.
    expect(selectNewlyPublishedJobs(jobs, NOW, 6 * HOUR)).toEqual([]);
  });

  it('un annuncio gia inviato, anche se dentro la finestra allargata, non rientra (dedup per alert)', () => {
    const target = alert('follower-sent', 'acme', { sentJobIds: { 'sent-job': NOW - 5 * HOUR } });
    const sent = job('sent-job', 'Acme', { firstSeenAt: iso(30) });
    const unsent = job('unsent-job', 'Acme', { firstSeenAt: iso(30) });
    const window = selectNewlyPublishedJobs([sent, unsent], NOW, windowMs);
    expect(window).toHaveLength(2);
    const sections = buildRecipientSections([target], window, NOW);
    expect(sections).toHaveLength(1);
    expect(sections[0].jobs.map((item: any) => item.id)).toEqual(['unsent-job']);
  });

  it('un annuncio nel ledger (in volo, ambiguo, fallito) non rientra neanche nella finestra allargata', () => {
    for (const state of [DELIVERY_STATES.CLAIMED, DELIVERY_STATES.AMBIGUOUS]) {
      const target = alert(`follower-${state}`, 'acme', { deliveryLedger: { 'ledger-job': { state, at: NOW - HOUR, attempts: 1 } } });
      const inLedger = job('ledger-job', 'Acme', { firstSeenAt: iso(30) });
      expect(buildRecipientSections([target], selectNewlyPublishedJobs([inLedger], NOW, windowMs), NOW)).toEqual([]);
    }
  });

  it('gli annunci chiusi o scaduti non si inviano, per quanto larga sia la finestra', () => {
    const closed = [
      job('c-status', 'Acme', { status: 'closed', firstSeenAt: iso(10) }),
      job('c-active', 'Acme', { active: false, firstSeenAt: iso(10) }),
      job('c-expired', 'Acme', { expiredAt: iso(1), firstSeenAt: iso(10) }),
      job('c-valid-through', 'Acme', { validThrough: iso(2), firstSeenAt: iso(10) }),
    ];
    expect(selectNewlyPublishedJobs(closed, NOW, windowMs)).toEqual([]);
    expect(buildRecipientSections([alert('follower-closed', 'acme')], closed, NOW)).toEqual([]);
  });
});

// ── 4. consenso e soppressione invariati ───────────────────────────────────
describe('consenso e soppressione: invariati, prima del claim', () => {
  const fixtureAlert = alert('consent-follower', 'acme');
  const fresh = job('consent-job', 'Acme', { firstSeenAt: iso(1) });

  function consentDb(newsletter: Record<string, unknown> | null) {
    const snap = (data: Record<string, unknown> | null) => ({ exists: Boolean(data), data: () => data ?? undefined });
    return {
      collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}`, id }) }),
      getAll: vi.fn(async (...refs: Array<{ path: string }>) => refs.map((ref) => (
        ref.path.startsWith('newsletter_subscribers/') ? snap(newsletter) : snap({ status: 'active', active: true })
      ))),
    } as any;
  }

  it('un indirizzo soppresso resta soppresso anche con il gate che lascia passare l\'annuncio', async () => {
    const db = consentDb({ status: 'unsubscribed', all_email_opted_out: true });
    const result = await resolveSendableRecipients(db, [fixtureAlert], { newJobs: [fresh], allJobs: [fresh], now: NOW });
    expect(result.recipients).toEqual([]);
    expect(result.suppressionCounts.suppress + result.suppressionCounts.defer).toBeGreaterThan(0);
  });

  it('il consenso si verifica per i soli destinatari con almeno una sezione: l\'annuncio rimandato non costa letture', async () => {
    const unpublished = job('consent-unpublished', 'Acme', { firstSeenAt: iso(1) });
    const gate = await createCompanyAlertPublicationGate({
      trigger: 'schedule', inventory: standing(), datasetAtMs: NOW, jobPageUrl: pageUrl, config: gateConfig,
      fetchImpl: manifestFetch(manifestFor(standing())) as any,
    });
    const db = consentDb({ status: 'confirmed', isActive: true, confirmed_at: '2026-09-01T00:00:00.000Z' });
    // Il gate si installa nel modulo come fa main(): stessa strada per planning e deferral.
    const sender = await import('../scripts/send-company-alerts.mjs');
    sender.__setPublicationGateForTest(gate);
    try {
      const result = await resolveSendableRecipients(db, [fixtureAlert], { newJobs: [unpublished], allJobs: [unpublished], now: NOW });
      expect(result.recipients).toEqual([]);
      expect(db.getAll).not.toHaveBeenCalled();
    } finally {
      sender.__setPublicationGateForTest(null);
    }
  });

  it('classifyRecipientConsent: un iscritto confermato e attivo e inviabile, uno cancellato no', () => {
    const jobAlertDoc = { exists: true, data: { status: 'active', active: true } };
    const ok = classifyRecipientConsent(
      { exists: true, data: { status: 'confirmed', isActive: true, confirmed_at: '2026-09-01T00:00:00.000Z', consent_act: 'typed_email_submit' } },
      jobAlertDoc,
    );
    expect(ok).toEqual({ action: 'send', reason: 'subscription-known-ok' });
    const stopped = classifyRecipientConsent({ exists: true, data: { status: 'unsubscribed', all_email_opted_out: true } }, jobAlertDoc);
    expect(stopped).toEqual({ action: 'suppress', reason: 'newsletter-cross-channel-stop' });
  });
});
