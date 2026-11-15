/**
 * Inventario snello in memoria (perf-plan PR 3).
 *
 * La proiezione scarta campi grandi dei crawler e sposta `descriptionByLocale`
 * (il 70% di una riga) fuori dall'heap. Cio' e' lecito solo se il percorso del
 * sender non legge mai i campi scartati e se tutto il resto si comporta come
 * prima. Questo file lo dimostra:
 *
 *   - PARITA' con la vecchia `loadJobs()` (copiata qui alla lettera): stesso
 *     inventario, stesso indice geografico, stessi conteggi;
 *   - TRACCIA: un Proxy registra ogni campo che il sender, il matching, il
 *     ranking, il live-link, il manifest e l'email leggono davvero, e nessun
 *     campo scartato compare fra le letture;
 *   - PIANO IDENTICO: `planAlertMatch` su righe intere e su righe snelle, con
 *     ricerche che leggono `descriptionByLocale` dal getter fuori heap.
 */
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_DROPPED_FIELDS,
  buildAlertInventory,
  projectJobForAlerts,
} from '../scripts/lib/job-alert-inventory.mjs';
import {
  DEFAULT_JOB_ALERT_PLAN_BATCH_SIZE,
  STATIC_CITY_CANTON_FLOOR,
  buildAlertEmail,
  createJobLivenessPrefetcher,
  jobPageUrl,
  planAlertMatch,
  rankLiveJobsForEmail,
  resolveJobAlertPlanBatchSize,
  runJobAlertMatcherHealth,
} from '../scripts/send-job-alerts.mjs';
import { createJobFeatureCache, createJobFeatureStore } from '../services/jobAlertMatching.mjs';
import { createJobAlertCandidateSelector, jobInventoryTimestampMs } from '../scripts/lib/job-alert-newness.mjs';
import { buildRankingJobsManifest } from '../functions/src/lib/jobEmailRankingStore.js';
import { rankEmailJobs, stableJobId } from '../functions/src/lib/jobEmailRanking.js';
import { jobDedupKey } from '../scripts/lib/alert-sent-jobs.mjs';
import { comparePlanOutcomes, createJobAlertCandidateIndex } from '../scripts/lib/job-alert-candidate-index.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-10T05:00:00Z');
const MATCH_WINDOW_MS = DAY;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function row(i: number, overrides: Record<string, unknown> = {}) {
  const long = (lang: string) => `Descrizione ${lang} ${i}. Cerchiamo infermiere e cuoco. ${'Testo lungo. '.repeat(40)}`;
  return {
    id: `inv-${i}`,
    slug: `ruolo-${i}`,
    slugByLocale: { it: `ruolo-${i}`, de: `rolle-${i}`, fr: `role-${i}`, en: `role-en-${i}` },
    title: i % 2 ? 'Infermiere diplomato' : 'Software Engineer',
    titleByLocale: { de: i % 2 ? 'Pflegefachperson' : 'Softwareentwickler', en: i % 2 ? 'Nurse' : 'Software Engineer' },
    description: long('it'),
    descriptionByLocale: { it: long('it'), de: `${long('de')} speziellerbegriff${i}`, fr: long('fr'), en: `${long('en')} specialtoken${i}` },
    company: i % 3 ? 'EOC' : 'Coop Ticino',
    companyKey: i % 3 ? 'eoc' : 'coop-ticino',
    category: i % 2 ? 'sanità' : 'informatica',
    sector: i % 2 ? 'healthcare' : 'it',
    location: i % 4 ? 'Lugano' : 'Zürich',
    canton: i % 4 ? 'TI' : 'ZH',
    addressLocality: 'Lugano',
    addressRegion: 'Ticino',
    contract: 'full-time',
    url: `https://example.test/jobs/${i}`,
    firstSeenAt: iso(-2 * DAY),
    crawledAt: iso(-0.4 * DAY),
    // Campi dei crawler che il sender non deve leggere.
    previousSlugs: ['old-a', 'old-b'],
    previousSlugsByLocale: { it: ['old-a'], de: ['old-b'] },
    requirements: ['Diploma', 'Esperienza'],
    requirementsByLocale: { it: ['Diploma'], de: ['Diplom'] },
    applyUrl: `https://example.test/apply/${i}`,
    _migrosBenefits: 'x'.repeat(200),
    _migrosResponsibilities: 'y'.repeat(200),
    baseSalary: { value: { minValue: 80000, maxValue: 95000, unitText: 'YEAR' } },
    salaryMin: 80000,
    salaryMax: 95000,
    ...overrides,
  };
}

const ROWS = [
  ...Array.from({ length: 60 }, (_, i) => row(i)),
  row(900, { crawledAt: iso(-30 * DAY), firstSeenAt: iso(-60 * DAY) }), // vecchia: nell'inventario, fuori dalla finestra del log
  row(901, { crawledAt: undefined, postedDate: undefined, firstSeenAt: undefined }), // senza timestamp: quarantena
  row(902, { crawledAt: iso(+3 * DAY) }), // futura: quarantena
];

// ── la vecchia loadJobs(), alla lettera (prima della PR 3) ────────────────
function legacyLoadJobs(jobs: any[], now: number, windowMs: number) {
  const cutoff = now - windowMs;
  const inventory: any[] = [];
  const locationIndex = new Map();
  const cityToCanton = new Map(Object.entries(STATIC_CITY_CANTON_FLOOR));
  for (const j of jobs) {
    const geo = [j.location || j.addressLocality || '', j.canton || ''].filter(Boolean);
    const company = j.company || '';
    if (geo.length > 0 || company) {
      const meta = { geo, company };
      for (const key of [j.slug, ...Object.values(j.slugByLocale || {}), j.id]) {
        if (key) locationIndex.set(String(key).toLowerCase(), meta);
      }
    }
    const canton = String(j.canton || '').toLowerCase();
    if (canton) {
      for (const city of [j.location, j.addressLocality]) {
        const c = String(city || '').toLowerCase().trim();
        if (c && !cityToCanton.has(c)) cityToCanton.set(c, canton);
      }
    }
    const inventoryAt = jobInventoryTimestampMs(j);
    if (inventoryAt > 0 && inventoryAt <= now) inventory.push(j);
  }
  const recent = inventory.filter((job) => jobInventoryTimestampMs(job) >= cutoff);
  return { inventory, recent, locationIndex, cityToCanton };
}

describe('proiezione di una riga', () => {
  it('scarta solo i campi elencati e tiene tutto il resto, invariato', () => {
    const original = row(1);
    const projected: any = projectJobForAlerts(original);
    for (const field of INVENTORY_DROPPED_FIELDS) expect(Object.keys(projected)).not.toContain(field);
    for (const [key, value] of Object.entries(original)) {
      if ((INVENTORY_DROPPED_FIELDS as readonly string[]).includes(key) || key === 'descriptionByLocale') continue;
      expect(projected[key], key).toEqual(value);
    }
    // Un campo nuovo del dataset non viene perso in silenzio.
    expect(projectJobForAlerts({ ...original, brandNewField: 'keep me' } as any)).toHaveProperty('brandNewField', 'keep me');
    // L'originale non e' toccato.
    expect(original.previousSlugs).toEqual(['old-a', 'old-b']);
  });

  it('descriptionByLocale esce dall heap ma si legge uguale, solo su richiesta e non si copia con lo spread', () => {
    const original = row(2);
    const projected: any = projectJobForAlerts(original);
    expect(Object.keys(projected)).not.toContain('descriptionByLocale');
    expect(projected.descriptionByLocale).toEqual(original.descriptionByLocale);
    expect(projected.descriptionByLocale?.de).toBe(original.descriptionByLocale.de);
    expect({ ...projected }).not.toHaveProperty('descriptionByLocale');
    // Righe senza la mappa restano senza.
    expect((projectJobForAlerts(row(3, { descriptionByLocale: undefined })) as any).descriptionByLocale).toBeUndefined();
    expect((projectJobForAlerts(row(4, { descriptionByLocale: {} })) as any).descriptionByLocale).toBeUndefined();
  });

  it('con offHeapLocaleDescriptions spento tiene la mappa dov era', () => {
    const projected: any = projectJobForAlerts(row(5), { offHeapLocaleDescriptions: false });
    expect(Object.keys(projected)).toContain('descriptionByLocale');
  });
});

describe('inventario snello contro la vecchia loadJobs()', () => {
  const legacy = legacyLoadJobs(ROWS, NOW, MATCH_WINDOW_MS);
  const lean = buildAlertInventory(ROWS, {
    nowMs: NOW,
    windowMs: MATCH_WINDOW_MS,
    cityCantonFloor: STATIC_CITY_CANTON_FLOOR,
    isFresh: (job: any) => String(job.firstSeenAt || '') >= iso(-2 * DAY),
  });

  it('stesse righe, nello stesso ordine, stessa quarantena', () => {
    expect(lean.inventory.map((job: any) => job.id)).toEqual(legacy.inventory.map((job: any) => job.id));
    expect(lean.inventory.map((job: any) => job.id)).not.toContain('inv-901');
    expect(lean.inventory.map((job: any) => job.id)).not.toContain('inv-902');
  });

  it('stesso conteggio delle righe recenti, che ora e un numero e non un secondo array', () => {
    expect(lean.recentCount).toBe(legacy.recent.length);
    expect(lean).not.toHaveProperty('recent');
    expect(lean.freshCount).toBeGreaterThan(0);
  });

  it('stesso indice geografico e stesso cityToCanton', () => {
    expect([...lean.locationIndex.entries()]).toEqual([...legacy.locationIndex.entries()]);
    expect([...lean.cityToCanton.entries()]).toEqual([...legacy.cityToCanton.entries()]);
    expect(lean.cityToCanton.get('lugano')).toBe('ti');
    // L'indice tiene {geo, company}, mai la riga intera.
    for (const meta of lean.locationIndex.values()) expect(Object.keys(meta).sort()).toEqual(['company', 'geo']);
  });

  it('con lean=false restituisce le righe originali', () => {
    const full = buildAlertInventory(ROWS, { nowMs: NOW, windowMs: MATCH_WINDOW_MS, cityCantonFloor: STATIC_CITY_CANTON_FLOOR, lean: false });
    expect(full.inventory[0]).toBe(ROWS[0]);
  });

  it('con un input che non e un array restituisce un inventario vuoto', () => {
    expect(buildAlertInventory(null as any, { nowMs: NOW, windowMs: MATCH_WINDOW_MS }).inventory).toEqual([]);
  });
});

describe('piano di matching identico su righe intere e snelle', () => {
  const leanInventory = buildAlertInventory(ROWS, { nowMs: NOW, windowMs: MATCH_WINDOW_MS, cityCantonFloor: STATIC_CITY_CANTON_FLOOR }).inventory;
  const fullInventory = buildAlertInventory(ROWS, { nowMs: NOW, windowMs: MATCH_WINDOW_MS, cityCantonFloor: STATIC_CITY_CANTON_FLOOR, lean: false }).inventory;
  const alerts: any[] = [
    { id: 'kw', email: 'a@example.test', locale: 'it', keywords: ['infermiere'] },
    { id: 'kw-de', email: 'b@example.test', locale: 'de', keywords: ['pflegefachperson'], cantonFilter: ['TI'] },
    // La ricerca legge descriptionByLocale[locale]: il token esiste solo nella descrizione tedesca/inglese.
    { id: 'search-de', email: 'c@example.test', locale: 'de', backfilled_from: 'newsletter_subscribers:x', keywords: ['speziellerbegriff7'] },
    { id: 'search-en', email: 'd@example.test', locale: 'en', backfilled_from: 'newsletter_subscribers:x', keywords: ['specialtoken11'] },
    { id: 'geo', email: 'e@example.test', locale: 'fr', locations: ['Lugano'] },
    { id: 'soft', email: 'f@example.test', locale: 'it', sourceJobTitle: 'Software Engineer' },
  ];
  const subscribers = new Map([
    ['c@example.test', { job_search_query: 'speziellerbegriff7' }],
    ['d@example.test', { job_search_query: 'specialtoken11' }],
  ]);

  it('stesso esito per ogni alert, con la finestra legacy e con l indice', () => {
    const cursorMs = NOW - 2 * DAY;
    const selector = (inventory: any[]) => createJobAlertCandidateSelector(inventory, { nowMs: NOW })({
      recipientLastSentAt: new Date(cursorMs), alertCreatedAt: 0, initialLookbackMs: DAY,
    }).jobs;
    const run = (inventory: any[], useIndex: boolean) => alerts.map((alert) => {
      const context: any = {
        behaviorProfiles: new Map(), lastClickedUrlByEmail: new Map(), locationIndex: new Map(), cityToCanton: new Map(),
        subscriberProfiles: subscribers, now: NOW, featureCache: createJobFeatureCache(createJobFeatureStore()), compactMatches: true, allowDiscovery: false,
      };
      return useIndex
        ? planAlertMatch(alert, { ...context, candidateIndex: createJobAlertCandidateIndex(inventory, { nowMs: NOW }), candidateCursorMs: cursorMs })
        : planAlertMatch(alert, { ...context, recentJobs: selector(inventory) });
    });
    const reference = run(fullInventory, false);
    for (const plans of [run(leanInventory, false), run(leanInventory, true), run(fullInventory, true)]) {
      plans.forEach((plan: any, i: number) => {
        expect(comparePlanOutcomes(reference[i], plan), alerts[i].id).toEqual({ equal: true });
      });
    }
    // Le ricerche trovano davvero qualcosa leggendo la mappa per locale: il confronto non e vuoto.
    expect(reference[2].matched.length).toBeGreaterThan(0);
    expect(reference[3].matched.length).toBeGreaterThan(0);
    expect(reference[2].matched.map((job: any) => job.id)).toEqual(['inv-7']);
  });
});

describe('nessun campo scartato e letto dal percorso del sender', () => {
  it('traccia le letture di matching, ranking, live-link, manifest, email e health', async () => {
    const reads = new Set<string>();
    // Un `{...riga}` (la copia che fa il percorso non compatto) legge OGNI campo,
    // ma non e' una lettura di significato: la copia non li usa. Per la
    // specifica, lo spread fa [[GetOwnProperty]] e poi [[Get]] sulla stessa chiave;
    // una lettura vera e' un [[Get]] senza il [[GetOwnProperty]] davanti.
    const traced = ROWS.slice(0, 60).map((job: any) => {
      let spreadKey: string | symbol | null = null;
      return new Proxy(job, {
        getOwnPropertyDescriptor(target, key) {
          spreadKey = key;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
          if (spreadKey === key) spreadKey = null;
          else if (typeof key === 'string') reads.add(key);
          return Reflect.get(target, key, receiver);
        },
        has(target, key) {
          if (typeof key === 'string') reads.add(key);
          return Reflect.has(target, key);
        },
      });
    });
    const store = createJobFeatureStore();
    const alerts: any[] = [
      { id: 'a1', email: 'a@example.test', locale: 'it', keywords: ['infermiere'], locations: ['Lugano'] },
      { id: 'a2', email: 'b@example.test', locale: 'de', keywords: ['pflegefachperson'] },
      { id: 'a3', email: 'c@example.test', locale: 'en', backfilled_from: 'newsletter_subscribers:x', keywords: ['specialtoken11'] },
      { id: 'a4', email: 'd@example.test', locale: 'fr', sourceJobTitle: 'Software Engineer', sectors: ['it'] },
      { id: 'a5', email: 'e@example.test', locale: 'it', specificCompanyKey: 'eoc' },
    ];
    const subscribers = new Map([['c@example.test', { job_search_query: 'specialtoken11' }]]);
    const liveCache = new Map();
    for (const alert of alerts) {
      for (const compactMatches of [true, false]) {
        const plan = planAlertMatch(alert, {
          behaviorProfiles: new Map(), lastClickedUrlByEmail: new Map(), locationIndex: new Map(), cityToCanton: new Map(),
          subscriberProfiles: subscribers, now: NOW, featureCache: createJobFeatureCache(store), compactMatches,
          recentJobs: traced, allowDiscovery: false,
        } as any);
        const rankingOptions = { variant: 'control', config: { enabled: false }, rankingMetadata: (plan as any).rankingMetadata };
        const ranked = await rankLiveJobsForEmail(plan.matched, alert.locale, liveCache, rankingOptions as any, {
          check: async () => true,
        } as any);
        const top = ranked.length ? ranked : rankEmailJobs(plan.matched, rankingOptions as any);
        if (top.length === 0) continue;
        buildAlertEmail(alert, top, true, { deliveryId: 'jer_x', variant: 'control' }, { variant: 'control', inExperiment: false }, {});
        buildAlertEmail(alert, top, true, null, null, { discoveryMode: true });
        buildRankingJobsManifest(top);
        top.forEach((job: any) => { stableJobId(job); jobDedupKey(job); jobPageUrl(job, alert.locale); });
        const prefetcher = createJobLivenessPrefetcher(new Map(), { check: async () => true } as any);
        prefetcher.enqueue(top, alert.locale);
        await prefetcher.drain();
      }
    }
    runJobAlertMatcherHealth(traced, { now: NOW, planMatch: planAlertMatch } as any);

    const touched = [...INVENTORY_DROPPED_FIELDS].filter((field) => reads.has(field));
    expect(touched, `campi scartati ma letti dal sender: ${touched.join(', ')}`).toEqual([]);
    // La traccia e' significativa: ha letto i campi che servono davvero.
    for (const field of ['title', 'company', 'slugByLocale', 'canton', 'location', 'description', 'firstSeenAt']) {
      expect(reads.has(field), `la traccia non ha toccato ${field}`).toBe(true);
    }
    expect(reads.has('descriptionByLocale')).toBe(true);
  }, 60_000);
});

describe('dimensione del gruppo di pianificazione', () => {
  it('resta 8 senza Remote Config; un valore valido (1-256) la cambia; uno non valido no', () => {
    expect(DEFAULT_JOB_ALERT_PLAN_BATCH_SIZE).toBe(8);
    expect(resolveJobAlertPlanBatchSize({})).toBe(8);
    expect(resolveJobAlertPlanBatchSize({ JOB_ALERT_PLAN_BATCH_SIZE: '32' })).toBe(32);
    expect(resolveJobAlertPlanBatchSize({ JOB_ALERT_PLAN_BATCH_SIZE: ' 64 ' })).toBe(64);
    for (const bad of ['0', '-4', '1000', 'abc', '', '3.5x']) {
      expect(resolveJobAlertPlanBatchSize({ JOB_ALERT_PLAN_BATCH_SIZE: bad }), bad).toBe(8);
    }
  });
});
