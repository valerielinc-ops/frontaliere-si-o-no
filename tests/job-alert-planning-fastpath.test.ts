/**
 * Fast path del planning dei job alert (perf-plan, PR concatenata della #18753).
 *
 * Principio: OUTPUT IDENTICO. Ogni passo si dimostra contro il percorso legacy,
 * che resta indipendente dall'indice:
 *
 *  - P2  colonne per riga dell'indice = le espressioni inline di prima;
 *  - P5  ranking su array tipizzati = ciclo a oggetti (casi avversari: NaN,
 *        parità, tie-break dell'application intent, meno di 5 righe in zona);
 *  - V   il piano legacy di verifica non riceve MAI risposte, predicati,
 *        colonne né l'indice; campione live 0,5%;
 *  - W   vocabolario a passata unica e su worker identico a `buildSearchVocabulary`;
 *  - kill switch `JOB_ALERT_PLANNING_FASTPATH` / `JOB_ALERT_VOCABULARY_WORKERS`.
 *
 * Nessuna email reale: indirizzi `@example.test`, aziende e testi sintetici.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/jobAlertMatching.mjs', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, createAlertScorer: vi.fn(actual.createAlertScorer) };
});

import {
  buildAlertProfile,
  createAlertScorer,
  createJobFeatureCache,
  createJobFeatureStore,
  defaultPartitionCanton,
  defaultPartitionPaddedLoc,
  freshnessBoost,
  jobFirstSeenMs,
  mergeAlertSubscriberSignals,
  paddedLocHaystack,
  partitionByGeoPreference,
  searchHaystack,
  searchHaystackInputs,
  jobMatchFeatures,
} from '../services/jobAlertMatching.mjs';
import { diversifyJobEmployers, employerDiversityKey } from '../scripts/lib/job-alert-discovery.mjs';
import {
  buildSearchVocabularies,
  buildSearchVocabulariesInWorkers,
  buildSearchVocabulary,
  createJobAlertCandidateIndex,
  DEFAULT_SHADOW_SAMPLE_DRY_RUN,
  DEFAULT_SHADOW_SAMPLE_LIVE,
  resolveCandidateIndexConfig,
} from '../scripts/lib/job-alert-candidate-index.mjs';
import { VOCABULARY_INPUT_FIELDS } from '../scripts/lib/job-alert-vocabulary.mjs';
import { createJobAlertCandidateSelector, resolveJobAlertCursor } from '../scripts/lib/job-alert-newness.mjs';
import { projectJobForAlerts } from '../scripts/lib/job-alert-inventory.mjs';
import { createJobAlertMetrics } from '../scripts/lib/job-alert-metrics.mjs';
import { planAlertForRun, planAlertMatch } from '../scripts/send-job-alerts.mjs';
import { buildApplicationIntentJobKey, recordApplicationIntentSignal } from '../services/applicationIntentRanking.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-14T05:00:00Z');
const LOCALES = ['it', 'de', 'fr', 'en'];

function row(i: number, patch: Record<string, unknown> = {}) {
  return {
    id: `fp-${i}`,
    slug: `fp-${i}`,
    title: 'Infermiere diplomato',
    description: 'Cerchiamo personale curante per reparto di cure, turni e formazione continua.',
    company: 'Azienda Esempio SA',
    category: 'sanità',
    sector: 'healthcare',
    location: 'Lugano',
    canton: 'TI',
    contract: 'full-time',
    firstSeenAt: new Date(NOW - 10 * DAY).toISOString(),
    crawledAt: new Date(NOW - DAY / 2).toISOString(),
    ...patch,
  };
}

const context = (extra: Record<string, unknown> = {}, subscribers: Array<[string, any]> = []): any => ({
  behaviorProfiles: new Map(),
  lastClickedUrlByEmail: new Map(),
  locationIndex: new Map(),
  cityToCanton: new Map([['lugano', 'ti'], ['zurich', 'zh']]),
  subscriberProfiles: new Map(subscribers),
  now: NOW,
  compactMatches: true,
  allowDiscovery: false,
  ...extra,
});

// ── P2 ──────────────────────────────────────────────────────────────────────

describe('P2 — colonne per riga dell\'indice: stessa espressione di prima su ogni riga', () => {
  // Righe avverse: firstSeenAt malformato, futuro, assente, numero, Date, vuoto;
  // azienda vuota, maiuscole diverse, caratteri speciali; località vuote.
  const ROWS = [
    row(0, { firstSeenAt: 'not-a-date' }),
    row(1, { firstSeenAt: new Date(NOW + 3 * DAY).toISOString() }),
    row(2, { firstSeenAt: undefined }),
    row(3, { firstSeenAt: '' }),
    row(4, { firstSeenAt: NOW - 3 * 60 * 60 * 1000 }),
    row(5, { firstSeenAt: new Date(NOW - 30 * 60 * 60 * 1000) }),
    row(6, { firstSeenAt: new Date(NOW - 20 * 60 * 60 * 1000).toISOString() }),
    row(7, { firstSeenAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString() }),
    row(8, { firstSeenAt: new Date(NOW - 48 * 60 * 60 * 1000).toISOString() }),
    row(9, { firstSeenAt: '2026-13-45T99:99:99Z' }),
    row(10, { company: '' }),
    row(11, { company: undefined }),
    row(12, { company: 'ÉOC Sàrl' }),
    row(13, { company: 'éoc sàrl' }),
    row(14, { company: '∅' }),
    row(15, { location: '', canton: '', addressLocality: 'Zürich', addressRegion: 'Zürich' }),
    row(16, { location: undefined, canton: undefined }),
    row(17, { location: 'St. Gallen', canton: 'SG', addressLocality: 'St.Gallen' }),
  ];
  const index = createJobAlertCandidateIndex(ROWS, { nowMs: NOW });
  const columns = (index.select(
    { ...buildAlertProfile({ id: 'a', email: 'p2@example.test', keywords: ['infermiere'] }, null) },
    { locale: 'it', ownerAlert: true, cursorMs: 0, fastpath: true },
  ) as any).columns;

  it('firstSeenMs: l\'espressione inline, NaN compreso', () => {
    for (let i = 0; i < index.rowCount; i++) {
      const job = index.rowAt(i);
      const inline = job.firstSeenAt ? new Date(job.firstSeenAt).getTime() : 0;
      expect(Object.is(columns.firstSeenMs[i], inline), `riga ${i}`).toBe(true);
      expect(Object.is(jobFirstSeenMs(job), inline)).toBe(true);
    }
    expect(Number.isNaN(columns.firstSeenMs[0])).toBe(true);
  });

  it('freshness: freshnessBoost col now della run', () => {
    for (let i = 0; i < index.rowCount; i++) {
      expect(columns.freshness[i], `riga ${i}`).toBe(freshnessBoost(index.rowAt(i), NOW));
    }
    expect(columns.nowMs).toBe(NOW);
    expect([...columns.freshness]).toContain(2);
    expect([...columns.freshness]).toContain(1);
    expect([...columns.freshness]).toContain(0);
  });

  it('companyId: id uguali se e solo se le chiavi di diversificazione sono uguali', () => {
    for (let a = 0; a < index.rowCount; a++) {
      for (let b = 0; b < index.rowCount; b++) {
        const sameKey = String(index.rowAt(a).company || '∅').toLowerCase() === String(index.rowAt(b).company || '∅').toLowerCase();
        expect(columns.companyId[a] === columns.companyId[b], `${a}/${b}`).toBe(sameKey);
        expect(employerDiversityKey(index.rowAt(a)) === employerDiversityKey(index.rowAt(b))).toBe(sameKey);
      }
    }
  });

  it('canton e località della partizione: le espressioni inline di prima', () => {
    for (let i = 0; i < index.rowCount; i++) {
      const job = index.rowAt(i);
      expect(columns.canton[i]).toBe(String(job?.canton || '').toLowerCase());
      expect(columns.paddedLoc[i]).toBe(paddedLocHaystack(`${job?.location || ''} ${job?.addressLocality || ''} ${job?.addressRegion || ''} ${job?.canton || ''}`));
      expect(columns.canton[i]).toBe(defaultPartitionCanton(job));
      expect(columns.paddedLoc[i]).toBe(defaultPartitionPaddedLoc(job));
    }
  });

  it('diversifyJobEmployers e partitionByGeoPreference con accessori danno lo stesso risultato dei default', () => {
    const jobs = ROWS.filter((job) => job.firstSeenAt !== undefined);
    const keyed = diversifyJobEmployers(jobs.map((_, k) => k), (k: number) => employerDiversityKey(jobs[k])).map((k: number) => jobs[k]);
    expect(keyed).toEqual(diversifyJobEmployers(jobs));
    const profile: any = { alertLocations: [], cantons: [], preferredLocations: ['lugano', 'st gallen'], preferredCantons: ['ti'] };
    for (const minLocal of [1, 5]) {
      const viaAccessors = partitionByGeoPreference(jobs.map((_, k) => k), profile, {
        minLocal,
        jobCanton: (k: number) => defaultPartitionCanton(jobs[k]),
        jobPaddedLoc: (k: number) => defaultPartitionPaddedLoc(jobs[k]),
      }).map((k: number) => jobs[k]);
      expect(viaAccessors).toEqual(partitionByGeoPreference(jobs, profile, { minLocal }));
    }
  });
});

// ── P5 ──────────────────────────────────────────────────────────────────────

describe('P5 — ranking su array tipizzati: stessa permutazione del ciclo a oggetti', () => {
  const ALERT = { id: 'p5', email: 'p5@example.test', locale: 'it', keywords: ['infermiere'] };

  const planBoth = (rows: any[], { alert = ALERT, subscriber = {}, extra = {}, cursorMs = 0, compactMatches = true }: any = {}) => {
    const index = createJobAlertCandidateIndex(rows, { nowMs: NOW });
    const ctx = context({ compactMatches, ...extra }, [[alert.email, subscriber]]);
    const legacy = planAlertMatch(alert, { ...ctx, featureCache: createJobFeatureCache(createJobFeatureStore()), recentJobs: createJobAlertCandidateSelector(rows, { nowMs: NOW })({ recipientLastSentAt: new Date(cursorMs || 1), alertCreatedAt: 0, initialLookbackMs: NOW }).jobs });
    const fast = planAlertMatch(alert, { ...ctx, featureCache: createJobFeatureCache(createJobFeatureStore()), candidateIndex: index, candidateCursorMs: cursorMs || 1 });
    return { legacy, fast };
  };
  const view = (plan: any) => ({
    ids: plan.matched.map((job: any) => job.id),
    ranked: plan.rankedCount,
    meta: plan.matched.map((job: any) => plan.rankingMetadata?.get(job)),
  });

  it('firstSeenAt malformato, futuro, assente, numerico e uguale: stesso ordine (NaN fa da pareggio)', () => {
    const rows = [
      row(0, { firstSeenAt: 'garbage' }),
      row(1, { firstSeenAt: new Date(NOW - 5 * DAY).toISOString() }),
      row(2, { firstSeenAt: undefined }),
      row(3, { firstSeenAt: 'garbage-2' }),
      row(4, { firstSeenAt: new Date(NOW - 5 * DAY).toISOString() }),
      row(5, { firstSeenAt: new Date(NOW + DAY).toISOString() }),
      row(6, { firstSeenAt: NOW - 2 * DAY }),
      row(7, { firstSeenAt: new Date(NOW - 3 * DAY).toISOString() }),
      row(8, { firstSeenAt: 'garbage' }),
      row(9, { firstSeenAt: new Date(NOW - 1 * DAY).toISOString() }),
      row(10, { firstSeenAt: new Date(NOW - 6 * DAY).toISOString() }),
      row(11, { firstSeenAt: '' }),
    ].map((job, i) => ({ ...job, company: `Azienda ${i}` }));
    const { legacy, fast } = planBoth(rows);
    expect(legacy.matched.length).toBe(rows.length);
    expect(view(fast)).toEqual(view(legacy));
  });

  it('score uguali e freshness che cambia la graduatoria: stesso ordine e stessi metadata', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i, {
      company: `Azienda ${i % 9}`,
      firstSeenAt: new Date(NOW - ((i * 7) % 5) * 12 * 60 * 60 * 1000).toISOString(),
      title: i % 3 === 0 ? 'Infermiere diplomato' : i % 3 === 1 ? 'Infermiere' : 'Infermiere responsabile infermiere',
    }));
    for (const compactMatches of [true, false]) {
      const { legacy, fast } = planBoth(rows, { compactMatches });
      expect(view(fast)).toEqual(view(legacy));
      if (!compactMatches) {
        // Le copie hanno gli stessi campi (la riga con i metadata sopra).
        expect(fast.matched).toEqual(legacy.matched);
      }
    }
  });

  it('tie-break dell\'application intent: stesso ordine, stessi segnali e stesso boost', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i, {
      slug: `slug-${(i * 7) % 30}`,
      companyKey: `azienda-${i % 4}`,
      company: `Azienda ${i % 4}`,
      firstSeenAt: new Date(NOW - 5 * DAY).toISOString(),
      relevanceSignals: i % 5 === 0 ? ['gia_visto', 42, 'x'.repeat(80)] : undefined,
    }));
    let intent: any = null;
    for (const i of [2, 5, 11, 12, 20, 29]) intent = recordApplicationIntentSignal(intent, buildApplicationIntentJobKey(rows[i]), NOW - 60_000).applicationIntent;
    const email = ALERT.email;
    const extra = {
      applicationIntentRankingEnabled: true,
      behaviorProfiles: new Map([[email, { applicationIntentAuthUid: 'u1', applicationIntent: intent }]]),
      applicationIntentAccountProfiles: new Map([[email, { uid: 'u1', optedOut: false }]]),
    };
    for (const compactMatches of [true, false]) {
      const { legacy, fast } = planBoth(rows, { extra, compactMatches });
      expect(fast.matched.length).toBe(rows.length);
      expect(view(fast)).toEqual(view(legacy));
      if (compactMatches) {
        const boosted = fast.matched.filter((job: any) => fast.rankingMetadata.get(job).applicationIntentBoost !== undefined);
        expect(boosted.length).toBe(6);
        expect(fast.rankingMetadata.get(boosted[0]).relevanceSignals).toContain('application_intent');
      }
    }
  });

  it('meno di 5 righe in zona: la partizione ripiega sul resto e conserva l\'ordine', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row(i, { company: `Locale ${i}`, location: 'Lugano', canton: 'TI' })),
      ...Array.from({ length: 9 }, (_, i) => row(100 + i, { company: `Fuori ${i}`, location: 'Zürich', canton: 'ZH', firstSeenAt: new Date(NOW - (i + 1) * DAY).toISOString() })),
    ];
    const subscriber = { location_interest: 'lugano' };
    const { legacy, fast } = planBoth(rows, { subscriber });
    expect(view(fast)).toEqual(view(legacy));
    // Con 5 o piu' righe in zona le altre spariscono: stesso comportamento.
    const many = [
      ...Array.from({ length: 6 }, (_, i) => row(i, { company: `Locale ${i}`, location: 'Lugano', canton: 'TI' })),
      ...rows.slice(3),
    ];
    const second = planBoth(many, { subscriber });
    expect(second.legacy.matched.length).toBe(6);
    expect(view(second.fast)).toEqual(view(second.legacy));
  });

  it('piu\' di due righe per azienda, azienda vuota e maiuscole diverse: stessa diversificazione', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i, {
      company: ['EOC', 'eoc', 'Eoc', '', undefined, 'ÉOC', 'Altra'][i % 7],
      firstSeenAt: new Date(NOW - (i % 6) * DAY).toISOString(),
    }));
    const { legacy, fast } = planBoth(rows);
    expect(view(fast)).toEqual(view(legacy));
  });

  it('nessuna riga con score > 0: stesso piano vuoto, nessun rankingMetadata', () => {
    const rows = [row(0, { title: 'Contabile', description: 'Bilancio' })];
    const { legacy, fast } = planBoth(rows);
    expect(legacy.matched).toEqual([]);
    expect(fast.matched).toEqual([]);
    expect(fast.rankedCount).toBe(0);
    expect(fast.zeroCause).toBe(legacy.zeroCause);
    expect(fast.rankingMetadata).toBe(legacy.rankingMetadata);
  });

  it('una riga gia\' inviata (dedup) non entra in matched ne\' nei metadata', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(i, { company: `Azienda ${i}` }));
    const alert = { ...ALERT, sentJobIds: { 'fp-1': NOW - DAY, 'fp-5': NOW - DAY } };
    const { legacy, fast } = planBoth(rows, { alert });
    expect(fast.matched.map((job: any) => job.id)).not.toContain('fp-1');
    expect(view(fast)).toEqual(view(legacy));
    expect(fast.rankedCount).toBe(legacy.rankedCount);
    expect(fast.rankedCount).toBe(8);
    expect(fast.matched.length).toBe(6);
  });
});

// ── V + kill switch ─────────────────────────────────────────────────────────

const scorerMock = createAlertScorer as unknown as ReturnType<typeof vi.fn>;

describe('V — la verifica legacy resta indipendente dall\'indice; campione live 0,5%', () => {
  const ROWS = Array.from({ length: 60 }, (_, i) => row(i, {
    title: ['Infermiere diplomato', 'Cuoco di partita', 'Software Engineer'][i % 3],
    company: `Azienda ${i % 7}`,
    location: ['Lugano', 'Zürich', 'Chur'][i % 3],
    canton: ['TI', 'ZH', 'GR'][i % 3],
  }));
  const index = createJobAlertCandidateIndex(ROWS, { nowMs: NOW });
  const selector = createJobAlertCandidateSelector(ROWS, { nowMs: NOW });
  const windowOptions = { recipientLastSentAt: new Date(NOW - 2 * DAY), alertCreatedAt: 0, initialLookbackMs: DAY };
  const cursor = resolveJobAlertCursor({ ...windowOptions, nowMs: NOW });
  const alerts = {
    'hard-search': { id: 'v-search', email: 'v1@example.test', locale: 'it', backfilled_from: 'newsletter_subscribers:x', keywords: ['infermiere lugano'] },
    'soft-legacy': { id: 'v-soft', email: 'v2@example.test', locale: 'it' },
    'hard-keyword': { id: 'v-kw', email: 'v3@example.test', locale: 'it', keywords: ['cuoco'] },
  } as Record<string, any>;
  const subscribers: Array<[string, any]> = [
    ['v1@example.test', { job_search_query: 'infermiere lugano' }],
    ['v2@example.test', { job_search_query: 'infermiere lugano', location_interest: 'lugano', job_category: 'sanità' }],
    ['v3@example.test', {}],
  ];

  beforeEach(() => scorerMock.mockClear());

  const plan = (alert: any, options: any = {}, ctx: any = {}) => {
    const metrics = createJobAlertMetrics();
    const result = planAlertForRun(alert, context({ featureCache: createJobFeatureCache(createJobFeatureStore()), ...ctx }, subscribers), {
      cursor,
      selectLegacyWindow: () => selector(windowOptions).jobs,
      candidateIndex: index,
      metrics,
      warn: () => {},
      ...options,
    });
    return { ...result, counters: metrics.snapshot().counters };
  };
  const receivedByCall = () => scorerMock.mock.calls.map((call) => ({
    answers: call[3]?.searchAnswers !== undefined,
    predicates: call[3]?.predicates != null,
  }));

  it('con campione pieno il piano indicizzato riceve risposte/predicati e il piano legacy mai', () => {
    for (const [name, alert] of Object.entries(alerts)) {
      scorerMock.mockClear();
      const selectSpy = vi.spyOn(index, 'select');
      const result = plan(alert, { indexMode: 'on', sampleRate: 1 });
      const calls = receivedByCall();
      // Due piani: prima l'indicizzato, poi la verifica legacy.
      expect(calls.length, name).toBe(2);
      if (name !== 'hard-keyword') expect(calls[0].answers || calls[0].predicates, name).toBe(true);
      expect(calls[1], `${name}: il piano legacy di verifica non riceve nulla dall'indice`).toEqual({ answers: false, predicates: false });
      // L'indice e' stato interrogato una volta sola (dal piano indicizzato).
      expect(selectSpy).toHaveBeenCalledTimes(1);
      selectSpy.mockRestore();
      expect(result.sampled).toBe(true);
      expect(result.counters.indexMismatch).toBeUndefined();
    }
  });

  it('anche con un candidateIndex nel contesto del chiamante il piano legacy non lo usa', () => {
    const selectSpy = vi.spyOn(index, 'select');
    const sneaky = context({ featureCache: createJobFeatureCache(createJobFeatureStore()), candidateIndex: index, candidateCursorMs: cursor.cursorMs, planningFastpath: true }, subscribers);
    const result = planAlertForRun(alerts['hard-search'], sneaky, {
      cursor,
      selectLegacyWindow: () => selector(windowOptions).jobs,
      candidateIndex: null,
      indexMode: 'off',
      metrics: createJobAlertMetrics(),
      warn: () => {},
    });
    expect(result.usedIndex).toBe(false);
    expect(selectSpy).not.toHaveBeenCalled();
    expect(receivedByCall()).toEqual([{ answers: false, predicates: false }]);
    selectSpy.mockRestore();
  });

  it('planAlertMatch senza indice (percorso legacy) non passa mai risposte, predicati ne\' colonne allo scorer', () => {
    for (const alert of Object.values(alerts)) {
      scorerMock.mockClear();
      planAlertMatch(alert, { ...context({ featureCache: createJobFeatureCache(createJobFeatureStore()), recentJobs: selector(windowOptions).jobs, planningFastpath: true }, subscribers) });
      expect(receivedByCall()).toEqual([{ answers: false, predicates: false }]);
    }
  });

  it('shadow: decide il legacy e confronta l\'indicizzato; nessuna divergenza con la fast path', () => {
    for (const alert of Object.values(alerts)) {
      const shadow = plan(alert, { indexMode: 'shadow', sampleRate: 1 });
      expect(shadow.usedIndex).toBe(false);
      expect(shadow.counters.indexSampled).toBe(1);
      expect(shadow.counters.indexMismatch).toBeUndefined();
    }
  });

  it('il campione LIVE di default e\' lo 0,5%, il dry-run resta al 10%', () => {
    expect(DEFAULT_SHADOW_SAMPLE_LIVE).toBe(0.005);
    expect(DEFAULT_SHADOW_SAMPLE_DRY_RUN).toBe(0.1);
    expect(resolveCandidateIndexConfig({}, { dryRun: false }).sampleRate).toBe(0.005);
    expect(resolveCandidateIndexConfig({}, { dryRun: true }).sampleRate).toBe(0.1);
    // Remote Config puo' alzarlo.
    expect(resolveCandidateIndexConfig({ JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE: '0.05' }, { dryRun: false }).sampleRate).toBe(0.05);
  });
});

describe('kill switch JOB_ALERT_PLANNING_FASTPATH e JOB_ALERT_VOCABULARY_WORKERS', () => {
  it('on di default; off spegne; un valore ignoto vale off e viene segnalato', () => {
    expect(resolveCandidateIndexConfig({})).toMatchObject({ planningFastpath: true, vocabularyWorkers: true, invalidSwitches: [] });
    expect(resolveCandidateIndexConfig({ JOB_ALERT_PLANNING_FASTPATH: ' ON ' }).planningFastpath).toBe(true);
    expect(resolveCandidateIndexConfig({ JOB_ALERT_PLANNING_FASTPATH: 'off' }).planningFastpath).toBe(false);
    expect(resolveCandidateIndexConfig({ JOB_ALERT_VOCABULARY_WORKERS: 'OFF' }).vocabularyWorkers).toBe(false);
    const odd = resolveCandidateIndexConfig({ JOB_ALERT_PLANNING_FASTPATH: 'maybe', JOB_ALERT_VOCABULARY_WORKERS: 'yes' });
    expect(odd).toMatchObject({ planningFastpath: false, vocabularyWorkers: false });
    expect(odd.invalidSwitches).toEqual(['JOB_ALERT_PLANNING_FASTPATH', 'JOB_ALERT_VOCABULARY_WORKERS']);
    // Il kill switch dell'intero indice resta indipendente.
    expect(resolveCandidateIndexConfig({ JOB_ALERT_CANDIDATE_INDEX_MODE: 'off' }).mode).toBe('off');
  });

  it('planningFastpath:false torna allo scorer di prima (nessuna risposta ne\' predicato) e dà lo stesso piano', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i, { title: i % 2 ? 'Cuoco' : 'Infermiere', company: `Azienda ${i % 5}` }));
    const index = createJobAlertCandidateIndex(rows, { nowMs: NOW });
    const alert = { id: 'ks', email: 'ks@example.test', locale: 'it' };
    const subscribers: Array<[string, any]> = [['ks@example.test', { job_search_query: 'infermiere', location_interest: 'lugano' }]];
    const planWith = (planningFastpath: boolean) => {
      scorerMock.mockClear();
      const plan = planAlertMatch(alert, {
        ...context({ featureCache: createJobFeatureCache(createJobFeatureStore()), candidateIndex: index, candidateCursorMs: 1, planningFastpath }, subscribers),
      });
      const options = scorerMock.mock.calls[0][3];
      return { plan, options };
    };
    const off = planWith(false);
    const on = planWith(true);
    expect(off.options.searchAnswers).toBeUndefined();
    expect(off.options.predicates).toBeUndefined();
    expect(on.options.searchAnswers || on.options.predicates).toBeTruthy();
    expect(off.plan.matched.map((job: any) => job.id)).toEqual(on.plan.matched.map((job: any) => job.id));
    expect(off.plan.rankedCount).toBe(on.plan.rankedCount);
  });
});

// ── W ───────────────────────────────────────────────────────────────────────

describe('W — vocabolario a passata unica e su worker identico a buildSearchVocabulary', () => {
  // Righe con descriptionByLocale (come l'inventario del sender: getter fuori heap),
  // titoli per locale, alfabeti non latini, accenti, campi mancanti.
  const raw = [
    row(0, { title: 'Infermiere diplomato', titleByLocale: { de: 'Pflegefachfrau HF', en: 'Nurse', fr: 'Infirmier' }, descriptionByLocale: { it: 'Cerchiamo infermieri e infermiera.', de: 'Wir suchen Pflegefachpersonen in Zürich.', fr: 'Nous cherchons des infirmiers.', en: 'We are hiring nurses.' }, department: 'Cure' }),
    row(1, { title: 'Ingénieur logiciel', location: 'Genève', canton: 'GE', descriptionByLocale: { it: 'Sviluppatore Java.', en: 'Java developer in Genève.' } }),
    row(2, { title: 'Магазинер склад', description: 'Работа на складе. Москва', location: 'Москва', canton: '' }),
    row(3, { title: '看護師', description: '看護師を募集しています。東京', company: undefined }),
    row(4, { title: 'Cuoco', description: '', descriptionByLocale: undefined, contract: undefined, category: undefined, sector: undefined }),
    row(5, { title: 'Chef de projet', description: 'Chef chef chef de projet informatique', category: 'informatica', sector: 'it', descriptionByLocale: { fr: 'Chef de projet IT.' } }),
    row(6, { title: undefined, description: 'Titolo mancante', titleByLocale: { en: 'Missing title' } }),
    row(7, { title: 'Receptionist', location: '', canton: '', description: 'Reception' }),
  ];
  const rowsFor = (lean: boolean) => raw.map((job) => (lean ? projectJobForAlerts(job as any) : job));

  const same = (a: any, b: any) => {
    expect(b.words).toEqual(a.words);
    expect(Array.from(b.offsets)).toEqual(Array.from(a.offsets));
    expect(Array.from(b.postings)).toEqual(Array.from(a.postings));
    expect(b.bytes).toEqual(a.bytes);
  };

  for (const lean of [false, true]) {
    it(`passata unica sui 4 locali = buildSearchVocabulary per locale (parole, offset, righe per parola) — righe ${lean ? 'proiettate (getter)' : 'piene'}`, () => {
      const rows = rowsFor(lean);
      const built = buildSearchVocabularies(rows, LOCALES);
      for (const locale of LOCALES) same(buildSearchVocabulary(rows, locale), built.get(locale));
    });

    it(`worker thread (un locale per worker) = buildSearchVocabulary, con blocchi piccoli — righe ${lean ? 'proiettate (getter)' : 'piene'}`, async () => {
      const rows = rowsFor(lean);
      const built = await buildSearchVocabulariesInWorkers(rows, LOCALES, { chunkRows: 3 });
      expect([...built.keys()]).toEqual(LOCALES);
      for (const locale of LOCALES) {
        same(buildSearchVocabulary(rows, locale), built.get(locale));
        expect(built.get(locale).buildMs).toBeGreaterThanOrEqual(0);
      }
    }, 60_000);
  }

  it('un sottoinsieme di locali e un singolo locale funzionano e restano identici', async () => {
    const rows = rowsFor(true);
    same(buildSearchVocabulary(rows, 'de'), buildSearchVocabularies(rows, ['de']).get('de'));
    const two = await buildSearchVocabulariesInWorkers(rows, ['fr', 'en'], { chunkRows: 5 });
    for (const locale of ['fr', 'en']) same(buildSearchVocabulary(rows, locale), two.get(locale));
  }, 60_000);

  it('il worker riceve esattamente i campi che searchHaystackInputs produce', () => {
    const job = row(0);
    const inputs = searchHaystackInputs(job, jobMatchFeatures(job, 'it'), 'it');
    expect([...VOCABULARY_INPUT_FIELDS].sort()).toEqual(Object.keys(inputs).sort());
    expect(searchHaystack(job, jobMatchFeatures(job, 'it'), 'it')).toBe(searchHaystack(job, jobMatchFeatures(job, 'it'), 'it'));
  });

  it('prepareSearchVocabularies: i vocabolari preparati (workers o passata unica) danno le stesse selezioni della costruzione pigra', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => row(i, {
      title: ['Infermiere', 'Cuoco di partita', 'Software Engineer', 'Pflegefachfrau'][i % 4],
      titleByLocale: { de: ['Krankenpfleger', 'Koch', 'Entwickler', 'Pflegefachfrau'][i % 4] },
      descriptionByLocale: { it: `Annuncio numero ${i} per ${['cura', 'cucina', 'software', 'ospedale'][i % 4]}`, de: `Stelle ${i}` },
      company: `Azienda ${i % 6}`,
    }));
    const profileOf = (query: string) => buildAlertProfile(
      { id: 'q', email: 'q@example.test', backfilled_from: 'newsletter_subscribers:x', keywords: [query] },
      mergeAlertSubscriberSignals({ job_search_query: query }, null),
    );
    const lazy = createJobAlertCandidateIndex(rows, { nowMs: NOW });
    for (const mode of ['workers', 'single-pass'] as const) {
      const prepared = createJobAlertCandidateIndex(rows, { nowMs: NOW });
      const report = await prepared.prepareSearchVocabularies({ locales: ['it', 'de', 'it', 'fr'], workers: mode === 'workers', workerMinRows: 1 });
      expect(report.mode).toBe(mode);
      expect(report.locales).toEqual(['it', 'de', 'fr']);
      // Idempotente: niente da rifare.
      expect((await prepared.prepareSearchVocabularies({ locales: ['it'], workers: true, workerMinRows: 1 })).mode).toBe('none');
      expect(Object.keys(prepared.stats().searchVocabulary).sort()).toEqual(['de', 'fr', 'it']);
      for (const locale of ['it', 'de', 'fr']) {
        for (const query of ['infermiere', 'cuoco partita', 'software engineer', 'krankenpfleger', 'stelle', 'annuncio cura', 'zzzz']) {
          const a: any = prepared.select(profileOf(query), { locale, cursorMs: 0, fastpath: true });
          const b: any = lazy.select(profileOf(query), { locale, cursorMs: 0 });
          expect(a.rows.map((r: any) => r.id), `${mode} ${locale} ${query}`).toEqual(b.rows.map((r: any) => r.id));
        }
      }
    }
  }, 60_000);

  it('sotto la soglia di righe i worker non partono: passata unica', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i));
    const index = createJobAlertCandidateIndex(rows, { nowMs: NOW });
    const report = await index.prepareSearchVocabularies({ locales: ['it', 'de'], workers: true });
    expect(report.mode).toBe('single-pass');
  });

  it('con i worker spenti la preparazione e\' sulla passata unica', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    const index = createJobAlertCandidateIndex(rows, { nowMs: NOW });
    const report = await index.prepareSearchVocabularies({ locales: ['it', 'de'], workers: false, workerMinRows: 1 });
    expect(report.mode).toBe('single-pass');
  });
});
