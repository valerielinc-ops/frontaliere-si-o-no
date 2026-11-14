/**
 * Live-link via manifest delle pagine pubblicate (perf-plan PR 5).
 *
 * Oggi ogni annuncio di un job alert costa un GET dell'HTML intero cercando il
 * marcatore `__EXPIRED_JOB_DATA__=` (6.040 richieste, 564 s, 1.583 avvisi di
 * fail-open a run). Il build emette un manifest con le pagine annuncio ATTIVE;
 * il sender lo scarica una volta. Qui: la codifica, la validazione, il
 * fallback al controllo HTTP, il fail-open spento, il rinvio degli annunci non
 * ancora pubblicati e la parita' di risposta con `checkPageBodyLive`.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JOB_PAGES_MANIFEST_FILE,
  buildJobPagesManifest,
  createJobPagesManifestLookup,
  decodeSortedSlugs,
  encodeSortedSlugs,
  normalizeJobPagePath,
} from '../build-plugins/shared/jobPagesManifest.mjs';
import {
  loadJobPagesManifest,
  manifestCoverage,
  resolveLiveLinkManifestConfig,
} from '../scripts/lib/job-pages-manifest-client.mjs';
import {
  createLiveLinkChecker,
  inspectLiveJobs,
  jobAlertMetrics,
  jobPageUrl,
  planAlertMatch,
  rankLiveJobsForEmail,
} from '../scripts/send-job-alerts.mjs';
import { createJobAlertMetrics } from '../scripts/lib/job-alert-metrics.mjs';
import { checkPageBodyLive, EXPIRED_JOB_MARKER } from '../scripts/lib/live-link-check.mjs';
import { createJobFeatureCache, createJobFeatureStore } from '../services/jobAlertMatching.mjs';
import { createJobAlertCandidateSelector, resolveJobAlertCursor } from '../scripts/lib/job-alert-newness.mjs';

const NOW = Date.parse('2026-11-14T05:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const metricsOf = () => createJobAlertMetrics({ now: () => 0, memory: () => ({ heapUsed: 0, rss: 0 }) });

function job(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `mf-${i}`,
    slug: `infermiere-${i}-eoc-lugano`,
    slugByLocale: { it: `infermiere-${i}-eoc-lugano`, en: `nurse-${i}-eoc-lugano`, de: `pflegefachperson-${i}-eoc-lugano`, fr: `infirmier-${i}-eoc-lugano` },
    title: 'Infermiere diplomato',
    titleByLocale: {},
    description: 'Cerchiamo infermiere.',
    company: 'EOC',
    category: 'sanità',
    sector: 'healthcare',
    location: 'Lugano',
    canton: 'TI',
    contract: 'full-time',
    firstSeenAt: new Date(NOW - 3 * DAY).toISOString(),
    crawledAt: new Date(NOW - 0.3 * DAY).toISOString(),
    ...overrides,
  };
}

const JOBS = Array.from({ length: 12 }, (_, i) => job(i));
const livePathsOf = (jobs: any[], locales = ['it', 'en', 'de', 'fr']) => jobs.flatMap((j) => locales.map((l) => jobPageUrl(j, l) as string));

describe('codifica del manifest', () => {
  it('normalizeJobPagePath: solo percorso, niente query/hash/slash finale, stesso criterio ovunque', () => {
    expect(normalizeJobPagePath('https://frontaliereticino.ch/it/lavoro/x-y/?utm=1#a')).toBe('/it/lavoro/x-y');
    expect(normalizeJobPagePath('/en/jobs/x/')).toBe('/en/jobs/x');
    expect(normalizeJobPagePath('en/jobs/x')).toBe('/en/jobs/x');
    expect(normalizeJobPagePath('')).toBe('');
  });

  it('front coding: andata e ritorno esatti su elenchi ordinati, anche con prefissi lunghi o nulli', () => {
    const cases = [
      [],
      ['solo'],
      ['aaa', 'aab', 'aab-b', 'b', 'bcd', 'bcdefghijklmnopqrstuvwxyz0123456789', 'bcdefghijklmnopqrstuvwxyz0123456789-x', 'z'],
    ];
    for (const slugs of cases) expect(decodeSortedSlugs(encodeSortedSlugs(slugs))).toEqual(slugs);
    let state = 7;
    const rand = () => { state = (state * 1103515245 + 12345) >>> 0; return state / 4294967296; };
    const random = Array.from({ length: 800 }, () => Array.from({ length: 1 + Math.floor(rand() * 40) }, () => 'abcdefgh0123-'[Math.floor(rand() * 13)]).join(''));
    const sortedRandom = [...new Set(random)].sort();
    expect(decodeSortedSlugs(encodeSortedSlugs(sortedRandom))).toEqual(sortedRandom);
    // Slug veri hanno prefissi comuni lunghi (ruolo, azienda, localita'): li comprime davvero.
    const realistic = Array.from({ length: 2000 }, (_, i) => `infermiere-diplomato-${String(i).padStart(5, '0')}-eoc-ente-ospedaliero-cantonale-lugano`).sort();
    expect(decodeSortedSlugs(encodeSortedSlugs(realistic))).toEqual(realistic);
    expect(JSON.stringify(encodeSortedSlugs(realistic)).length).toBeLessThan(JSON.stringify(realistic).length * 0.8);
  });

  it('il manifest e deterministico e indipendente dall ordine; ignora slug con | e doppioni', () => {
    const paths = ['/it/cerca-lavoro-ticino/b-2/', '/it/cerca-lavoro-ticino/a-1/', '/en/jobs-in-ticino/a-1', '/it/cerca-lavoro-ticino/a-1/', '/it/x/bad|slug/'];
    const first = buildJobPagesManifest({ paths, generatedAt: '2026-11-14T00:00:00.000Z', buildCommit: 'abc' });
    const second = buildJobPagesManifest({ paths: [...paths].reverse(), generatedAt: '2026-11-14T00:00:00.000Z', buildCommit: 'abc' });
    expect(second).toEqual(first);
    expect(first.counts).toEqual({ pages: 3, sections: 2 });
    expect(first.buildCommit).toBe('abc');
    expect(first.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(first.pages)).toEqual(['/en/jobs-in-ticino', '/it/cerca-lavoro-ticino']);
  });
});

describe('lettura e validazione', () => {
  const manifestFor = (paths: string[], generatedAt = new Date(NOW - 2 * HOUR).toISOString()) =>
    buildJobPagesManifest({ paths, generatedAt, buildCommit: 'sha' });

  it('membership: viva, scaduta (assente) e mancante, per URL con o senza slash e con query', () => {
    const live = jobPageUrl(JOBS[0], 'it') as string;
    const lookup = createJobPagesManifestLookup(manifestFor([live])) as any;
    expect(lookup.has(live)).toBe(true);
    expect(lookup.has(`${live}/`)).toBe(true);
    expect(lookup.has(`${live}?utm_source=email`)).toBe(true);
    expect(lookup.has(jobPageUrl(JOBS[1], 'it'))).toBe(false); // scaduta o non pubblicata
    expect(lookup.has('https://frontaliereticino.ch/')).toBe(false);
    expect(lookup.has('')).toBe(false);
    // Stesso slug in un'altra sezione: non e' la stessa pagina.
    expect(lookup.has(live.replace('cerca-lavoro-ticino', 'cerca-lavoro-zurigo'))).toBe(false);
  });

  it('rifiuta un manifest malformato o incoerente: versione, conteggi, data, vuoto', () => {
    const good = manifestFor(['/it/s/a-1']);
    expect(createJobPagesManifestLookup(good)).not.toBeNull();
    expect(createJobPagesManifestLookup({ ...good, version: 2 })).toBeNull();
    expect(createJobPagesManifestLookup({ ...good, counts: { pages: 99, sections: 1 } })).toBeNull();
    expect(createJobPagesManifestLookup({ ...good, generatedAt: 'ieri' })).toBeNull();
    expect(createJobPagesManifestLookup({ ...good, pages: { '/it/s': 'non-un-array' } })).toBeNull();
    expect(createJobPagesManifestLookup({ ...good, pages: {}, counts: { pages: 0, sections: 0 } })).toBeNull();
    expect(createJobPagesManifestLookup(null)).toBeNull();
  });

  const fakeFetch = (responses: Array<() => any>) => {
    let call = 0;
    const fn = vi.fn(async () => {
      const make = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return make();
    });
    return fn;
  };
  const ok = (manifest: unknown) => () => ({ ok: true, status: 200, text: async () => JSON.stringify(manifest) });

  it('scarica una volta, e conta le richieste HTTP effettive', async () => {
    const requests = vi.fn();
    const result: any = await loadJobPagesManifest({ fetchImpl: fakeFetch([ok(manifestFor(['/it/s/a-1']))]) as any, datasetAtMs: NOW, onRequest: requests });
    expect(result.usable).toBe(true);
    expect(result.ageHours).toBeCloseTo(2, 5);
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it('un 404 (non ancora pubblicato) e definitivo: nessun secondo tentativo', async () => {
    const fetchImpl = fakeFetch([() => ({ ok: false, status: 404, text: async () => '' })]);
    const result: any = await loadJobPagesManifest({ fetchImpl: fetchImpl as any, datasetAtMs: NOW });
    expect(result).toMatchObject({ usable: false, reason: 'http-404' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('un 503 si riprova una volta; un errore di rete e un JSON rotto non sono usabili', async () => {
    const retried = fakeFetch([() => ({ ok: false, status: 503, text: async () => '' }), ok(manifestFor(['/it/s/a-1']))]);
    expect(((await loadJobPagesManifest({ fetchImpl: retried as any, datasetAtMs: NOW })) as any).usable).toBe(true);
    expect(retried).toHaveBeenCalledTimes(2);
    const network: any = await loadJobPagesManifest({ fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as any, datasetAtMs: NOW, attempts: 1 });
    expect(network).toMatchObject({ usable: false, reason: 'fetch-failed' });
    const broken: any = await loadJobPagesManifest({ fetchImpl: fakeFetch([() => ({ ok: true, status: 200, text: async () => '{non json' })]) as any, datasetAtMs: NOW, attempts: 1 });
    expect(broken).toMatchObject({ usable: false, reason: 'malformed' });
    const shape: any = await loadJobPagesManifest({ fetchImpl: fakeFetch([ok({ version: 1 })]) as any, datasetAtMs: NOW, attempts: 1 });
    expect(shape).toMatchObject({ usable: false, reason: 'malformed' });
  });

  it('un manifest piu vecchio dei dati di N ore (default 36) e stantio; uno piu recente non lo e', async () => {
    const old = manifestFor(['/it/s/a-1'], new Date(NOW - 40 * HOUR).toISOString());
    expect(await loadJobPagesManifest({ fetchImpl: fakeFetch([ok(old)]) as any, datasetAtMs: NOW })).toMatchObject({ usable: false, reason: 'stale' });
    expect(((await loadJobPagesManifest({ fetchImpl: fakeFetch([ok(old)]) as any, datasetAtMs: NOW, maxAgeHours: 48 })) as any).usable).toBe(true);
    const future = manifestFor(['/it/s/a-1'], new Date(NOW + 3 * HOUR).toISOString());
    expect(((await loadJobPagesManifest({ fetchImpl: fakeFetch([ok(future)]) as any, datasetAtMs: NOW })) as any).usable).toBe(true);
  });

  it('configurazione: auto di default, off, eta e copertura con valori di ripiego', () => {
    expect(resolveLiveLinkManifestConfig({})).toMatchObject({ mode: 'auto', maxAgeHours: 36, minCoverage: 0.5 });
    expect(resolveLiveLinkManifestConfig({ JOB_ALERT_LIVE_LINK_MANIFEST: ' OFF ' }).mode).toBe('off');
    expect(resolveLiveLinkManifestConfig({ JOB_ALERT_LIVE_LINK_MANIFEST: 'boh' }).mode).toBe('auto');
    expect(resolveLiveLinkManifestConfig({ JOB_ALERT_LIVE_LINK_MANIFEST_MAX_AGE_HOURS: '12' }).maxAgeHours).toBe(12);
    expect(resolveLiveLinkManifestConfig({ JOB_ALERT_LIVE_LINK_MANIFEST_MAX_AGE_HOURS: '-3' }).maxAgeHours).toBe(36);
    expect(resolveLiveLinkManifestConfig({ JOB_PAGES_MANIFEST_URL: 'https://x.test/m.json' }).url).toBe('https://x.test/m.json');
  });

  it('copertura: frazione delle righe campionate con la pagina nel manifest', () => {
    const lookup = createJobPagesManifestLookup(manifestFor(livePathsOf(JOBS.slice(0, 9), ['it']))) as any;
    const coverage = manifestCoverage(lookup, JOBS, (j) => jobPageUrl(j, 'it'));
    expect(coverage).toEqual({ checked: 12, present: 9, ratio: 0.75 });
    expect(manifestCoverage(lookup, [], (j) => jobPageUrl(j, 'it')).ratio).toBe(0);
  });
});

describe('createLiveLinkChecker', () => {
  const baseConfig = { mode: 'auto', url: 'https://example.test/job-pages-manifest.json', maxAgeHours: 36, minCoverage: 0.5 };
  const manifestResponse = (jobs: any[], generatedAt = new Date(NOW - HOUR).toISOString()) => {
    const manifest = buildJobPagesManifest({ paths: livePathsOf(jobs), generatedAt, buildCommit: 'sha' });
    return (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(manifest) })) as any;
  };
  const quiet = { log: () => {}, warn: vi.fn() };

  it('con un manifest usabile: una sola richiesta HTTP, nessun fail-open, risposte locali', async () => {
    const metrics = metricsOf();
    const liveJobs = JOBS.slice(0, 8);
    const checker = await createLiveLinkChecker({ config: baseConfig as any, inventory: JOBS, datasetAtMs: NOW, fetchImpl: manifestResponse(liveJobs), metrics, ...quiet });
    expect(checker.source).toBe('manifest');
    expect(checker.failOpen).toBe(false);
    expect(await checker.check(jobPageUrl(JOBS[0], 'de') as string)).toEqual({ known: true, live: true });
    expect(await checker.check(jobPageUrl(JOBS[10], 'de') as string)).toEqual({ known: true, live: false });
    const counters = metrics.snapshot().counters;
    expect(counters.liveLinkHttpRequests).toBe(1);
    expect(counters.liveLinkManifestResolved).toBe(2);
    expect(counters.liveLinkSource).toBe('manifest');
  });

  it('senza manifest (404), stantio, malformato o con copertura bassa ripiega sul controllo HTTP con il suo fail-open', async () => {
    const cases: Array<[string, any]> = [
      ['http-404', (async () => ({ ok: false, status: 404, text: async () => '' })) as any],
      ['stale', manifestResponse(JOBS, new Date(NOW - 80 * HOUR).toISOString())],
      ['malformed', (async () => ({ ok: true, status: 200, text: async () => 'xx' })) as any],
      // 12 annunci aperti, il manifest ne copre 2 (17%): il percorso calcolato non regge.
      ['low-coverage', manifestResponse(JOBS.slice(0, 2))],
    ];
    for (const [reason, fetchImpl] of cases) {
      const warn = vi.fn();
      const metrics = metricsOf();
      const checker = await createLiveLinkChecker({ config: baseConfig as any, inventory: JOBS, datasetAtMs: NOW, fetchImpl, metrics, log: () => {}, warn });
      expect(checker.source, reason).toBe('http');
      expect(checker.failOpen, reason).toBe(true);
      expect(checker.reason, reason).toBe(reason);
      expect(warn, reason).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain('falling back to the per-page HTTP');
    }
  });

  it('con la modalita off non scarica nemmeno il manifest', async () => {
    const fetchImpl = vi.fn();
    const checker = await createLiveLinkChecker({ config: { ...baseConfig, mode: 'off' } as any, inventory: JOBS, fetchImpl: fetchImpl as any, metrics: metricsOf(), ...quiet });
    expect(checker).toMatchObject({ source: 'http', reason: 'disabled', failOpen: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('annunci non ancora pubblicati: rimandati, non spediti', () => {
  const alert = { id: 'defer-1', email: 'defer@example.test', locale: 'it', keywords: ['infermiere'] };
  const context = (store = createJobFeatureStore()): any => ({
    behaviorProfiles: new Map(), lastClickedUrlByEmail: new Map(), locationIndex: new Map(), cityToCanton: new Map(),
    subscriberProfiles: new Map(), now: NOW, featureCache: createJobFeatureCache(store), compactMatches: true, allowDiscovery: false,
  });
  const rankingOptionsFor = (plan: any) => ({ variant: 'control', config: { enabled: false }, rankingMetadata: plan.rankingMetadata });

  it('un annuncio fuori dal manifest non entra nell email, anche se TUTTI lo sono (nessun fail-open), e resta nella finestra del giorno dopo', async () => {
    const lastSentAt = new Date(NOW - 1.5 * DAY);
    const selector = createJobAlertCandidateSelector(JOBS, { nowMs: NOW });
    const window = () => selector({ recipientLastSentAt: lastSentAt, alertCreatedAt: 0, initialLookbackMs: DAY }).jobs;
    const plan = planAlertMatch(alert, { ...context(), recentJobs: window() });
    expect(plan.matched.length).toBe(JOBS.length);

    // Giorno 1: il manifest ne ha pubblicati solo 3.
    const published = JOBS.slice(0, 3);
    const checker = await createLiveLinkChecker({
      config: { mode: 'auto', url: 'https://example.test/m.json', maxAgeHours: 36, minCoverage: 0 } as any,
      inventory: JOBS,
      datasetAtMs: NOW,
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(buildJobPagesManifest({ paths: livePathsOf(published), generatedAt: new Date(NOW - HOUR).toISOString() })) })) as any,
      metrics: metricsOf(), ...quiet(),
    });
    const ranked = await rankLiveJobsForEmail(plan.matched, 'it', new Map(), rankingOptionsFor(plan) as any, { check: checker.check, failOpen: checker.failOpen } as any);
    expect(ranked.map((j: any) => j.id).sort()).toEqual(published.map((j) => j.id).sort());
    // Solo cio che e stato MOSTRATO entra in sentJobs (il sender fa rankedForEmail.slice(0, MAX_JOB_CARDS)).
    const sentJobs = ranked.slice(0, 10);
    const sentMap = Object.fromEntries(sentJobs.map((j: any) => [j.id, NOW]));
    for (const unpublished of JOBS.slice(3)) expect(sentMap[unpublished.id]).toBeUndefined();

    // Tutti assenti: l'alert non parte (deadLinks) invece di spedire link non verificati.
    const none = await createLiveLinkChecker({
      config: { mode: 'auto', url: 'https://example.test/m.json', maxAgeHours: 36, minCoverage: 0 } as any,
      inventory: JOBS, datasetAtMs: NOW,
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(buildJobPagesManifest({ paths: ['/it/altra-sezione/altro-1'], generatedAt: new Date(NOW - HOUR).toISOString() })) })) as any,
      metrics: metricsOf(), ...quiet(),
    });
    expect(await rankLiveJobsForEmail(plan.matched, 'it', new Map(), rankingOptionsFor(plan) as any, { check: none.check, failOpen: none.failOpen } as any)).toEqual([]);

    // Giorno 2: il cursore del destinatario non si e mosso (nessun invio) e l annuncio rimandato e ancora nella finestra.
    const cursor = resolveJobAlertCursor({ recipientLastSentAt: lastSentAt, alertCreatedAt: 0, nowMs: NOW + DAY });
    expect(cursor.cursorMs).toBe(lastSentAt.getTime());
    const nextDayWindow = createJobAlertCandidateSelector(JOBS, { nowMs: NOW + DAY })({ recipientLastSentAt: lastSentAt, alertCreatedAt: 0, initialLookbackMs: DAY }).jobs;
    expect(nextDayWindow.some((j: any) => j.id === JOBS[11].id)).toBe(true);
    // ...e con il manifest aggiornato esce dal rinvio.
    const next = await createLiveLinkChecker({
      config: { mode: 'auto', url: 'https://example.test/m.json', maxAgeHours: 36, minCoverage: 0 } as any,
      inventory: JOBS, datasetAtMs: NOW + DAY,
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(buildJobPagesManifest({ paths: livePathsOf(JOBS), generatedAt: new Date(NOW + DAY - HOUR).toISOString() })) })) as any,
      metrics: metricsOf(), ...quiet(),
    });
    const rankedLater = await rankLiveJobsForEmail(plan.matched, 'it', new Map(), rankingOptionsFor(plan) as any, { check: next.check, failOpen: next.failOpen, limit: 12 } as any);
    expect(rankedLater.some((j: any) => j.id === JOBS[11].id)).toBe(true);
  });

  function quiet() { return { log: () => {}, warn: () => {} }; }
});

describe('parita con checkPageBodyLive su un campione di 50 URL', () => {
  let server: http.Server | null = null;
  afterEach(async () => { await new Promise((resolve) => (server ? server.close(resolve) : resolve(null))); server = null; });

  it('le due risposte coincidono per ogni URL: pagina viva, soft-landing scaduta, pagina non servita', async () => {
    const live = new Set<string>();
    const expired = new Set<string>();
    const missing = new Set<string>();
    const urls: string[] = [];
    for (let i = 0; i < 50; i++) {
      const p = `/it/cerca-lavoro-ticino/ruolo-${i}-eoc-lugano`;
      urls.push(p);
      if (i % 5 === 0) expired.add(p); // soft-landing: HTTP 200 con il marcatore
      else if (i % 7 === 0) missing.add(p); // non ancora pubblicata: 404
      else live.add(p);
    }
    server = http.createServer((req, res) => {
      const pathname = String(req.url).split('?')[0].replace(/\/$/, '');
      if (live.has(pathname)) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><h1>Infermiere</h1></html>'); return; }
      if (expired.has(pathname)) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<script>window.${EXPIRED_JOB_MARKER}{"slug":"x"};</script>`); return; }
      res.writeHead(404); res.end('nope');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server!.address() as any;
    // Il build emette il manifest dalle sole pagine ATTIVE (le scadute escono come soft-landing).
    const lookup = createJobPagesManifestLookup(buildJobPagesManifest({ paths: [...live], generatedAt: new Date(NOW).toISOString() })) as any;
    let mismatches = 0;
    for (const p of urls) {
      const http200 = await checkPageBodyLive(`http://127.0.0.1:${port}${p}`);
      if (http200 !== lookup.has(p)) mismatches += 1;
    }
    expect(mismatches).toBe(0);
    expect(live.size).toBeGreaterThan(30);
  });
});

describe('emissione nel build delle pagine annuncio', () => {
  const plugin = fs.readFileSync(path.resolve(__dirname, '../build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');

  it('ogni pagina annuncio attiva registrata come emessa entra nel manifest, per tutti i locali (prima del filtro BUILD_LOCALE)', () => {
    const add = plugin.indexOf('activeJobPagePathsForManifest.add(relPath)');
    const emitted = plugin.indexOf('emittedActiveJobPaths.add(__activeJobKey)');
    const localeSkip = plugin.indexOf('if (!shouldEmitLocale(locale)) {', emitted);
    expect(add).toBeGreaterThan(emitted);
    expect(add).toBeLessThan(localeSkip);
  });

  // #18658 ha compattato i registri di rivendicazione (`claimedJobPaths`, titoli): quel registro
  // contiene ANCHE le soft-landing scadute e puo' dare falsi positivi per costruzione. Il manifest
  // non lo legge: ha un suo insieme, alimentato in UN solo punto, l'emissione di un annuncio ATTIVO.
  // Un annuncio scaduto e compattato non puo' quindi risultare vivo.
  it('il manifest e alimentato in un solo punto (annuncio attivo) e mai dal registro compatto condiviso con le scadute', () => {
    expect(plugin.split('activeJobPagePathsForManifest.add(').length - 1).toBe(1);
    const add = plugin.indexOf('activeJobPagePathsForManifest.add(relPath)');
    const expiredClaim = plugin.indexOf('claimedJobPaths.claim(__slPathKey)');
    expect(expiredClaim).toBeGreaterThan(add);
    expect(plugin).toContain('claimedJobPaths.claim(localePathClaimKey(relPath))');
    // Nessuna lettura del registro compatto dentro la costruzione del manifest.
    const write = plugin.indexOf('buildJobPagesManifest({');
    expect(plugin.slice(write, write + 400)).not.toContain('claimedJobPaths');
  });

  it('il manifest si scrive in dist/ prima di svuotare i Set, solo dalla build che possiede il locale it, e non ferma mai il build', () => {
    const write = plugin.indexOf('buildJobPagesManifest({');
    const clear = plugin.indexOf('emittedActiveJobPaths.clear()');
    expect(write).toBeGreaterThan(0);
    expect(write).toBeLessThan(clear);
    const block = plugin.slice(plugin.lastIndexOf("if (shouldEmitLocale('it')", write), clear);
    expect(block).toContain('JOB_PAGES_MANIFEST_FILE');
    expect(block).toMatch(/try \{[\s\S]*catch \(error\)/);
    expect(JOB_PAGES_MANIFEST_FILE).toBe('job-pages-manifest.json');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review automatica 5907068125: il checker del manifest e la cache devono condividere
// il contratto `{ known, live }`. I checker HTTP che restituiscono booleani vengono
// normalizzati al confine della cache, così liveness nota e risposta non disponibile
// restano distinguibili anche nel percorso `failOpen: false`.
// Qui il criterio di accettazione, con un checker vero alimentato da un manifest usabile.
describe('manifest + inspectLiveJobs: il contratto { known, live } dà known/live', () => {
  const config = { mode: 'auto', url: 'https://example.test/m.json', maxAgeHours: 36, minCoverage: 0 } as any;
  const manifestOf = (published: any[]) => (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(buildJobPagesManifest({ paths: livePathsOf(published), generatedAt: new Date(NOW - HOUR).toISOString() })),
  })) as any;
  const checkerFor = (published: any[]) => createLiveLinkChecker({
    config, inventory: JOBS, datasetAtMs: NOW, fetchImpl: manifestOf(published), metrics: metricsOf(), log: () => {}, warn: () => {},
  });
  const failOpenCount = () => jobAlertMetrics.snapshot().counters.liveLinkFailOpen || 0;
  const idsOf = (jobs: any[]) => jobs.map((j) => j.id).sort();

  it('(a) un URL pubblicato nel manifest resta in knownLiveJobs e nei job restituiti', async () => {
    const published = JOBS.slice(0, 3);
    const checker = await checkerFor(published);
    expect(checker.source).toBe('manifest');
    expect(await checker.check(jobPageUrl(published[0], 'it') as string)).toEqual({ known: true, live: true });
    const cache = new Map<string, { known: boolean; live: boolean }>();
    const result = await inspectLiveJobs(published, 'it', cache, { check: checker.check, failOpen: checker.failOpen });
    expect(idsOf(result.knownLiveJobs)).toEqual(idsOf(published));
    expect(idsOf(result.jobs)).toEqual(idsOf(published));
    expect(result.unknownJobs).toEqual([]);
    expect(result.failOpen).toBe(false);
    // La cache contiene il risultato condiviso: da lì nascono known e live.
    for (const j of published) {
      expect(cache.get(jobPageUrl(j, 'it') as string)).toEqual({ known: true, live: true });
    }
  });

  it('(b) un URL assente e\' filtrato SENZA fail-open, anche se la quota di pagine vive e\' bassa (liveLinkFailOpen non incrementato)', async () => {
    const published = JOBS.slice(0, 3);
    const checker = await checkerFor(published);
    const before = failOpenCount();
    const cache = new Map<string, { known: boolean; live: boolean }>();
    // 3 pubblicati su 12: con il ramo HTTP questo rapporto (25%) farebbe scattare il fail-open.
    const result = await inspectLiveJobs(JOBS, 'it', cache, { check: checker.check, failOpen: checker.failOpen });
    expect(idsOf(result.knownLiveJobs)).toEqual(idsOf(published));
    expect(idsOf(result.jobs)).toEqual(idsOf(published));
    for (const absent of JOBS.slice(3)) {
      expect(result.jobs.some((j: any) => j.id === absent.id)).toBe(false);
      expect(cache.get(jobPageUrl(absent, 'it') as string)).toEqual({ known: true, live: false });
    }
    expect(result.failOpen).toBe(false);
    expect(failOpenCount()).toBe(before);
    // Contro-prova: lo stesso rapporto con failOpen attivo (percorso HTTP) scatterebbe il fail-open.
    const httpLike = await inspectLiveJobs(JOBS, 'it', new Map(), { check: checker.check, failOpen: true });
    expect(httpLike.failOpen).toBe(true);
    expect(failOpenCount()).toBe(before + 1);
  });

  it('(c) un alert con almeno un annuncio pubblicato resta inviabile; con tutti non pubblicati la lista e\' vuota (= «link pagina non più vivi»)', async () => {
    const alert = { id: 'accept-1', email: 'accept@example.test', locale: 'it', keywords: ['infermiere'] };
    const store = createJobFeatureStore();
    const context: any = {
      behaviorProfiles: new Map(), lastClickedUrlByEmail: new Map(), locationIndex: new Map(), cityToCanton: new Map(),
      subscriberProfiles: new Map(), now: NOW, featureCache: createJobFeatureCache(store), compactMatches: true, allowDiscovery: false,
    };
    const plan = planAlertMatch(alert, { ...context, recentJobs: JOBS });
    expect(plan.matched.length).toBe(JOBS.length);
    const rankingOptions: any = { variant: 'control', config: { enabled: false }, rankingMetadata: plan.rankingMetadata };

    const one = await checkerFor(JOBS.slice(5, 6));
    const sendable = await rankLiveJobsForEmail(plan.matched, 'it', new Map(), rankingOptions, { check: one.check, failOpen: one.failOpen } as any);
    expect(sendable.map((j: any) => j.id)).toEqual([JOBS[5].id]);
    expect(sendable.length).toBeGreaterThan(0);

    const none = await checkerFor([]).catch(() => null);
    // Un manifest senza nessuna pagina e' malformato (`total === 0`): ripiega sul HTTP, non e' il caso.
    expect(none?.source).toBe('http');
    const other = await createLiveLinkChecker({
      config, inventory: JOBS, datasetAtMs: NOW,
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(buildJobPagesManifest({ paths: ['/it/altra-sezione/altro-1'], generatedAt: new Date(NOW - HOUR).toISOString() })) })) as any,
      metrics: metricsOf(), log: () => {}, warn: () => {},
    });
    expect(other.source).toBe('manifest');
    const before = failOpenCount();
    const dead = await rankLiveJobsForEmail(plan.matched, 'it', new Map(), rankingOptions, { check: other.check, failOpen: other.failOpen } as any);
    expect(dead).toEqual([]);
    expect(failOpenCount()).toBe(before);
  });

  it('nel sender una lista vuota diventa la voce di funnel «link pagina non più vivi» (deadLinks), mai un invio', () => {
    const sender = fs.readFileSync(path.resolve(__dirname, '../scripts/send-job-alerts.mjs'), 'utf8');
    expect(sender).toMatch(/if \(rankedForEmail\.length === 0\) \{\s*funnelIn\.deadLinks \+= 1;/);
    const funnel = fs.readFileSync(path.resolve(__dirname, '../scripts/lib/job-alert-funnel.mjs'), 'utf8');
    expect(funnel).toContain("key: 'deadLinks', label: 'link pagina non più vivi'");
  });
});
