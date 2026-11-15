/**
 * Indice dei candidati per l'intera run (perf-plan PR 2).
 *
 * L'indice scarta righe, non decide punteggi: è corretto se e solo se
 *
 *     scorer(riga) > 0  ⇒  riga ∈ candidati(profilo)
 *
 * per OGNI profilo e OGNI riga eleggibile. Qui lo si dimostra in tre modi:
 *
 *   (a) PROPRIETÀ: > 1.000 profili sintetici (seme fisso) che coprono ogni ramo
 *       di `createAlertScorer` — pinned (job e azienda), keyword dure con e senza
 *       alias, categoria/tassonomia, ricerca dura, solo geo, solo soft, azienda,
 *       contratto, settore, ricerca soft, `neverMatches`, discovery, canary,
 *       needsRetranslation, proprietario — su un inventario sintetico, in tutti
 *       i locali. Ogni riga con score > 0 deve stare fra i candidati.
 *   (b) GOLDEN: `planAlertMatch` con indice e `planAlertMatch` legacy hanno lo
 *       stesso output (id, ordine, score, candidateCount, zeroCause, matched).
 *   (c) ROLLOUT: `planAlertForRun` in off/shadow/on, divergenza simulata,
 *       eccezione dell'indice, campionamento deterministico.
 *
 * Nessuna email reale: indirizzi `@example.test`.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAlertProfile,
  createAlertScorer,
  createJobFeatureCache,
  createJobFeatureStore,
  mergeAlertSubscriberSignals,
} from '../services/jobAlertMatching.mjs';
import {
  alertDiagnosticId,
  alertSampleFraction,
  alertSampleKey,
  comparePlanOutcomes,
  createJobAlertCandidateIndex,
  isAlertSampledForIndexCheck,
  resolveCandidateIndexConfig,
} from '../scripts/lib/job-alert-candidate-index.mjs';
import {
  createJobAlertCandidateSelector,
  jobInventoryTimestampMs,
  resolveJobAlertCursor,
} from '../scripts/lib/job-alert-newness.mjs';
import { createJobAlertMetrics } from '../scripts/lib/job-alert-metrics.mjs';
import { planAlertForRun, planAlertMatch } from '../scripts/send-job-alerts.mjs';
import { isCanaryJob, isOwnerEmail, OWNER_EMAIL } from '../scripts/lib/canaryAd.mjs';
import { buildApplicationIntentJobKey, recordApplicationIntentSignal } from '../services/applicationIntentRanking.mjs';
import { nlNormLocale } from '../services/newsletter-template.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-10T05:00:00Z');
const LOCALES = ['it', 'de', 'fr', 'en'];

// PRNG deterministico (mulberry32): lo stesso seme dà gli stessi 1.200 profili.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = [
  'Infermiere diplomato 80-100%', 'Senior Software Engineer (Java)', 'Contabile / Accountant',
  'Magazziniere carrellista', 'Elektriker EFZ', 'Ingénieur logiciel', 'Sales Manager',
  'Assistente di cura', 'Cuoco di partita', 'Chef de partie', 'Pflegefachfrau HF',
  'Project Manager IT', 'Autista patente C', 'Receptionist', 'Data Analyst',
];
const PLACES: Array<[string, string]> = [
  ['Lugano', 'TI'], ['Bellinzona', 'TI'], ['Zürich', 'ZH'], ['Genève', 'GE'],
  ['St. Gallen', 'SG'], ['', 'TI'], ['Lugano-Paradiso', ''], ['Chur', 'GR'], ['Basel', 'BS'],
  ['Mendrisio', 'TI'], ['Coira', 'GR'],
];
const COMPANIES = ['EOC', 'Coop Ticino', 'Banca Stato SA', 'ABB Svizzera', 'Migros', '', 'Galaxus', 'Ospedale Regionale'];
const CATEGORIES = ['sanità', 'informatica', 'finanza', 'ristorazione', 'engineering', 'vendite marketing', ''];
const SECTORS = ['healthcare', 'it', 'finance', 'hospitality', 'manufacturing', ''];
const CONTRACTS = ['full-time', 'part-time', 'temporary', 'apprenticeship', ''];
const FILLER = 'Ambiente dinamico, formazione continua e buone prospettive di crescita. '.repeat(6);

function fixtureInventory(count = 260) {
  const rand = prng(20261114);
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const jobs: any[] = [];
  for (let i = 0; i < count; i++) {
    const [location, canton] = pick(PLACES);
    const title = pick(TITLES);
    const crossJoin = i % 29 === 6;
    const lead = crossJoin ? 'Lugano, sede centrale.' : `Cerchiamo ${title}.`;
    let titleByLocale: Record<string, string> = {};
    if (crossJoin) titleByLocale = { en: 'Sales Manager' };
    else if (i % 2 === 0) titleByLocale = { de: `${title} (DE)`, en: `${title} EN`, fr: `${title} FR` };
    const ageDays = Math.floor(rand() * 9);
    jobs.push({
      id: `job-${i}`,
      ...(i % 7 === 0 ? { publisherJobId: `pub-${i}` } : {}),
      slug: `job-${i}`,
      title,
      titleByLocale,
      description: i % 13 === 0 ? '' : `${lead} ${FILLER} ${i % 5 === 0 ? 'Richiesta esperienza come infermiere o cuoco.' : ''}`,
      company: pick(COMPANIES),
      category: pick(CATEGORIES),
      sector: pick(SECTORS),
      location,
      canton,
      contract: pick(CONTRACTS),
      firstSeenAt: new Date(NOW - ageDays * DAY).toISOString(),
      crawledAt: new Date(NOW - Math.floor(rand() * 6) * DAY - Math.floor(rand() * DAY)).toISOString(),
      ...(i % 17 === 3 ? { canary: true } : {}),
      ...(i % 11 === 2 ? { needsRetranslation: true, sourceLang: i % 2 ? 'de' : undefined } : {}),
      // Righe che il selettore esclude: mai nell'indice.
      ...(i % 41 === 0 ? { status: 'expired' } : {}),
      ...(i % 53 === 1 ? { crawledAt: new Date(NOW + 5 * DAY).toISOString() } : {}),
    });
  }
  return jobs;
}

interface SyntheticCase {
  label: string;
  alert: any;
  subscriber: any;
  channel: any;
  extras: any;
}

const KEYWORDS = ['infermiere', 'cuoco', 'engineer', 'elektriker', 'contabile', 'manager lugano', 'chef', 'java', 'cura',
  'zzzz-no-match', 'tecnologia', 'sanità', 'healthcare', 'it', 'receptionist', 'autista'];
const LOCS = ['Lugano', 'Zurich', 'Bellinzona', 'Coira', 'Basel', 'Genève', 'Chur', 'Mendrisio', '  ', 'nowhere'];
const CANTONS = ['TI', 'ZH', 'GR', 'ge', 'BS', 'VD'];

/** Profili sintetici: ogni famiglia esercita un ramo di createAlertScorer. */
function syntheticCases(total = 1200): SyntheticCase[] {
  const rand = prng(7777);
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const some = <T,>(list: T[], max = 3) => {
    const n = Math.floor(rand() * (max + 1));
    return Array.from({ length: n }, () => pick(list));
  };
  const cases: SyntheticCase[] = [];
  const families = [
    'pinned-job', 'pinned-company', 'pinned-both', 'keyword', 'keyword-geo', 'keyword-canton',
    'category-label', 'taxonomy', 'hard-search', 'geo-only', 'canton-only', 'soft-source-job',
    'company-profile', 'contract-only', 'sector-only', 'soft-search', 'empty', 'mixed', 'owner-canary',
  ];
  for (let i = 0; i < total; i++) {
    const family = families[i % families.length];
    const alert: any = { id: `syn-${i}`, email: `user${i}@example.test`, locale: pick([...LOCALES, undefined as any]) };
    const subscriber: any = {};
    const channel: any = {};
    switch (family) {
      case 'pinned-job': alert.specificJobId = pick(['job-7', 'job-14', 'pub-21', 'job-999']); break;
      case 'pinned-company': alert.specificCompanyKey = pick(['eoc', 'coop-ticino', 'migros', 'galaxus', 'abb-svizzera']); break;
      case 'pinned-both': alert.specificJobIds = ['job-3', 'pub-7']; alert.specificCompanyKey = 'eoc'; break;
      case 'keyword': alert.keywords = some(KEYWORDS, 3); if (alert.keywords.length === 0) alert.keywords = ['infermiere']; break;
      case 'keyword-geo': alert.keywords = [pick(KEYWORDS)]; alert.locations = some(LOCS, 2); break;
      case 'keyword-canton': alert.keywords = [pick(KEYWORDS)]; alert.cantonFilter = some(CANTONS, 2); break;
      case 'category-label': alert.keywords = [pick(['tecnologia', 'sanita', 'ristorazione', 'finanza', 'engineering', 'vendite marketing', 'altro'])]; break;
      case 'taxonomy': alert.keywords = [pick(['healthcare', 'it', 'finance', 'hospitality', 'manufacturing', 'sanità', 'informatica'])]; break;
      case 'hard-search':
        alert.backfilled_from = 'newsletter_subscribers:x';
        subscriber.job_search_query = pick(['infermiere lugano', 'cuoco', 'software engineer', 'contabile zurigo', 'zzz qqq']);
        alert.keywords = [subscriber.job_search_query];
        if (rand() < 0.5) alert.locations = some(LOCS, 1);
        break;
      case 'geo-only': alert.locations = some(LOCS, 3); if (rand() < 0.3) alert.cantonFilter = some(CANTONS, 1); break;
      case 'canton-only': alert.cantonFilter = some(CANTONS, 3); break;
      case 'soft-source-job': alert.sourceJobTitle = pick(TITLES); alert.sourceJobSlug = pick(['sales-manager', 'infermiere-lugano', 'data-analyst', '']); break;
      case 'company-profile': subscriber.job_company = pick(['Coop Ticino', 'EOC', 'Migros', 'Galaxus', 'Azienda Inesistente SA', 'Banca Stato']); break;
      case 'contract-only': alert.contractTypes = some(['full-time', 'part-time', 'temporary', 'zzz'], 2); break;
      case 'sector-only': alert.sectors = some(['healthcare', 'it', 'finance', 'sanità', 'cuoco'], 2); break;
      case 'soft-search':
        // Query corta: nessun token da `extractKeywords` (>=3), ma con intento di ricerca.
        subscriber.job_search_query = pick(['it ab', 'xy zz', 'ab cd', 'it hr']);
        if (rand() < 0.4) alert.cantonFilter = some(CANTONS, 1);
        break;
      case 'empty': break;
      case 'mixed':
        if (rand() < 0.5) alert.keywords = some(KEYWORDS, 2);
        if (rand() < 0.5) alert.locations = some(LOCS, 2);
        if (rand() < 0.3) alert.cantonFilter = some(CANTONS, 2);
        if (rand() < 0.3) alert.sectors = some(['healthcare', 'it'], 1);
        if (rand() < 0.3) alert.contractTypes = some(['full-time', 'part-time'], 1);
        if (rand() < 0.4) subscriber.job_company = pick(COMPANIES.filter(Boolean));
        if (rand() < 0.4) subscriber.job_search_query = pick(['infermiere', 'manager', 'it ab']);
        if (rand() < 0.3) subscriber.location_interest = pick(['lugano', 'zurich']);
        if (rand() < 0.2) subscriber.sector_interest = pick(['healthcare', 'it']);
        if (rand() < 0.2) subscriber.preferences = { lugano: true };
        break;
      case 'owner-canary':
        alert.email = OWNER_EMAIL;
        alert.keywords = rand() < 0.5 ? [pick(KEYWORDS)] : undefined;
        break;
      default: break;
    }
    cases.push({
      label: `${family}#${i}`,
      alert,
      subscriber,
      channel,
      extras: {},
    });
  }
  return cases;
}

// Profili scritti a mano per i rami che `buildAlertProfile` non produce da solo.
function handBuiltProfiles() {
  const base = () => ({
    hardKeywords: new Set<string>(), hardCategoryKeys: new Set<string>(), hardTaxonomyValues: new Set<string>(),
    hardSearchQueries: [] as string[], softTokens: new Set<string>(), softSearchQueries: [] as string[],
    company: '', companyKeys: undefined as string[] | undefined, locations: [] as string[], alertLocations: [] as string[],
    cantons: [] as string[], sectors: [] as string[], contractTypes: [] as string[],
    specificJobIds: [] as string[], specificCompanyKey: '', preferredLocations: [] as string[], preferredCantons: [] as string[],
  });
  const profiles: Array<{ label: string; profile: any }> = [];
  const add = (label: string, patch: any) => profiles.push({ label, profile: { ...base(), ...patch } });
  add('company-with-empty-keys', { company: 'eoc', companyKeys: [] });
  add('company-no-keys-field', { company: 'coopticino' });
  add('empty-sector-string', { sectors: [''] });
  add('empty-canton-string', { cantons: [''], alertLocations: [] });
  add('hard-with-search-and-kw', { hardKeywords: new Set(['infermiere', 'cuoco']), hardSearchQueries: ['infermiere lugano'] });
  add('hard-category-and-taxonomy', { hardKeywords: new Set(['tecnologia']), hardCategoryKeys: new Set(['tech']), hardTaxonomyValues: new Set(['tecnologia']) });
  add('search-queries-without-hard', { hardSearchQueries: ['cuoco'], softSearchQueries: ['cuoco'], cantons: ['ti'] });
  add('geo-scope-no-needles', { alertLocations: ['--'], cantons: [] });
  add('location-only', { locations: ['lugano'] });
  add('contract-and-canton', { contractTypes: ['full-time'], cantons: ['ti'] });
  add('soft-tokens-only', { softTokens: new Set(['manager', 'software']) });
  add('everything', {
    hardKeywords: new Set(['manager']), softTokens: new Set(['sales']), company: 'migros', companyKeys: ['migros'],
    locations: ['zurich'], alertLocations: ['zurich'], cantons: ['zh'], sectors: ['it'], contractTypes: ['full-time'],
  });
  return profiles;
}

const INVENTORY = fixtureInventory();

function buildProfile(c: SyntheticCase) {
  return buildAlertProfile(c.alert, mergeAlertSubscriberSignals(c.subscriber, c.channel), c.extras);
}

describe('indice candidati — selezione delle righe', () => {
  it('le righe indicizzate sono quelle ROW_OPEN del selettore legacy, nello stesso ordine', () => {
    const index = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });
    const legacy = createJobAlertCandidateSelector(INVENTORY, { nowMs: NOW })({ recipientLastSentAt: 0, alertCreatedAt: 0, initialLookbackMs: NOW });
    // cursorMs = 0 → tutte le righe aperte con timestamp valido.
    const selection = index.select(null, { locale: 'it', ownerAlert: true, cursorMs: 0, forceWindow: true });
    expect(selection.rows).toEqual(legacy.jobs.filter((job: any) => job.needsRetranslation !== true || (job.sourceLang || 'it') === 'it'));
    expect(index.rowCount).toBe(legacy.jobs.length);
  });

  it('windowRowCount e candidateCount coincidono con la finestra legacy per ogni cursore', () => {
    const index = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });
    const selector = createJobAlertCandidateSelector(INVENTORY, { nowMs: NOW });
    for (const days of [0, 0.3, 1, 2.5, 4, 8, 30]) {
      const cursorMs = NOW - days * DAY;
      const window = selector({ recipientLastSentAt: new Date(cursorMs), alertCreatedAt: 0, initialLookbackMs: DAY }).jobs;
      expect(index.windowRowCount(cursorMs)).toBe(window.length);
      for (const locale of LOCALES) {
        for (const owner of [false, true]) {
          const eligible = window.filter((job: any) => (owner || !isCanaryJob(job))
            && !(job.needsRetranslation === true && locale !== (job.sourceLang || 'it')));
          const selection = index.select(null, { locale, ownerAlert: owner, cursorMs, forceWindow: true });
          expect(selection.candidateCount).toBe(eligible.length);
          expect(selection.rows).toEqual(eligible);
        }
      }
    }
  });
});

describe('indice candidati — proprietà scorer(riga) > 0 ⇒ riga ∈ candidati', () => {
  const index = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });
  const cases = syntheticCases(1200);
  const strategies = new Set<string>();
  let scoredPositive = 0;

  const checkProfile = (label: string, profile: any, locale: string | undefined, owner: boolean) => {
    const loc = locale ? nlNormLocale(locale) : nlNormLocale(undefined);
    const store = createJobFeatureStore();
    const scorer = createAlertScorer(profile, loc, createJobFeatureCache(store));
    const selection = index.select(profile, { locale: loc, ownerAlert: owner, cursorMs: 0 });
    strategies.add(selection.strategy);
    const candidates = new Set(selection.rows);
    const all = index.select(null, { locale: loc, ownerAlert: owner, cursorMs: 0, forceWindow: true }).rows;
    for (const job of all) {
      const score = scorer(job);
      if (score > 0) {
        scoredPositive += 1;
        if (!candidates.has(job)) {
          throw new Error(`${label} locale=${loc} owner=${owner}: la riga ${job.id} ha score ${score} ma non è fra i candidati (strategia ${selection.strategy})`);
        }
      }
    }
  };

  it('vale per 1.200 profili sintetici su tutti i locali', () => {
    for (const c of cases) {
      const profile = buildProfile(c);
      const locale = c.alert.locale;
      checkProfile(c.label, profile, locale, isOwnerEmail(c.alert.email));
    }
    expect(scoredPositive).toBeGreaterThan(5000);
  }, 120_000);

  it('vale per i profili scritti a mano (rami non prodotti da buildAlertProfile) in ogni locale, con e senza proprietario', () => {
    for (const { label, profile } of handBuiltProfiles()) {
      for (const locale of LOCALES) {
        for (const owner of [false, true]) checkProfile(label, profile, locale, owner);
      }
    }
  }, 120_000);

  it('vale con il profilo nullo e con tutte le righe candidate senza indice', () => {
    expect(index.select(null, { locale: 'it', cursorMs: 0 }).rows).toEqual([]);
  });

  it('i profili sintetici attraversano ogni strategia di composizione', () => {
    for (const expected of ['pinned', 'never', 'hard-keyword', 'hard-search', 'soft-legacy', 'soft-signals']) {
      expect(strategies.has(expected), `strategia ${expected} mai esercitata`).toBe(true);
    }
  });

  it('la cache dei bitset con budget minimo (evizione continua) non cambia nessuna risposta', () => {
    const tiny = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW, budgetBytes: 1 });
    const roomy = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });
    for (const c of cases.slice(0, 240)) {
      const profile = buildProfile(c);
      const loc = nlNormLocale(c.alert.locale);
      const owner = isOwnerEmail(c.alert.email);
      const a = tiny.select(profile, { locale: loc, ownerAlert: owner, cursorMs: NOW - 3 * DAY });
      const b = roomy.select(profile, { locale: loc, ownerAlert: owner, cursorMs: NOW - 3 * DAY });
      expect(a.rows).toEqual(b.rows);
      expect(a.candidateCount).toBe(b.candidateCount);
    }
    expect(tiny.stats().bitsetEvictions).toBeGreaterThan(0);
  }, 60_000);

  it('riduce davvero le righe valutate: i candidati sono una frazione della finestra per le keyword dure', () => {
    let window = 0;
    let candidates = 0;
    for (const c of cases.filter((x) => x.label.startsWith('keyword#') || x.label.startsWith('keyword-canton'))) {
      const profile = buildProfile(c);
      const loc = nlNormLocale(c.alert.locale);
      const sel = index.select(profile, { locale: loc, ownerAlert: false, cursorMs: 0 });
      window += sel.candidateCount;
      candidates += sel.rows.length;
    }
    expect(candidates).toBeLessThan(window * 0.6);
  });
});

function normalizePlan(plan: any) {
  const relevance = (job: any) => plan.rankingMetadata?.get(job)?.relevanceScore ?? job.relevanceScore;
  return {
    candidateCount: plan.candidateCount,
    rankedCount: plan.rankedCount,
    zeroCause: plan.zeroCause,
    discoveryMode: Boolean(plan.discoveryMode),
    matched: plan.matched.map((job: any) => [job.id, relevance(job)]),
    sentMap: plan.sentMap,
  };
}

describe('indice candidati — golden planAlertMatch legacy contro indice', () => {
  const index = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });
  const selector = createJobAlertCandidateSelector(INVENTORY, { nowMs: NOW });
  const cases = syntheticCases(400);

  for (const compactMatches of [true, false]) {
    it(`output identico (id, ordine, score, candidateCount, zeroCause) — compactMatches=${compactMatches}`, () => {
      const store = createJobFeatureStore();
      let equal = 0;
      for (const [position, c] of cases.entries()) {
        const subscriberProfiles = new Map([[c.alert.email.toLowerCase(), c.subscriber]]);
        const days = [0.5, 1, 2, 5][position % 4];
        const cursorMs = NOW - days * DAY;
        const window = selector({ recipientLastSentAt: new Date(cursorMs), alertCreatedAt: 0, initialLookbackMs: DAY }).jobs;
        const context: any = {
          behaviorProfiles: new Map(),
          lastClickedUrlByEmail: new Map(),
          locationIndex: new Map(),
          cityToCanton: new Map([['lugano', 'ti']]),
          subscriberProfiles,
          now: NOW,
          featureCache: createJobFeatureCache(store),
          compactMatches,
          allowDiscovery: false,
        };
        const legacy = planAlertMatch({ ...c.alert, sentJobIds: position % 5 === 0 ? { 'job-1': NOW - DAY } : undefined }, { ...context, recentJobs: window });
        const indexed = planAlertMatch({ ...c.alert, sentJobIds: position % 5 === 0 ? { 'job-1': NOW - DAY } : undefined }, { ...context, candidateIndex: index, candidateCursorMs: cursorMs });
        expect(normalizePlan(indexed), c.label).toEqual(normalizePlan(legacy));
        expect(indexed.scoredRows).toBeLessThanOrEqual(legacy.scoredRows);
        expect(comparePlanOutcomes(legacy, indexed)).toEqual({ equal: true });
        equal += 1;
      }
      expect(equal).toBe(cases.length);
    }, 120_000);
  }

  it('la discovery (profilo vuoto) vede la finestra intera e dà lo stesso piano', () => {
    const ranker = (candidates: any[]) => candidates.slice(0, 5);
    const alert = { id: 'disc', email: 'disc@example.test', locale: 'it' };
    const cursorMs = NOW - 2 * DAY;
    const window = selector({ recipientLastSentAt: new Date(cursorMs), alertCreatedAt: 0, initialLookbackMs: DAY }).jobs;
    const context: any = {
      behaviorProfiles: new Map(), lastClickedUrlByEmail: new Map(), locationIndex: new Map(), cityToCanton: new Map(),
      subscriberProfiles: new Map(), now: NOW, featureCache: createJobFeatureCache(), compactMatches: true,
      discoveryRanker: ranker, discoveryGeographies: new Map(), allowDiscovery: true,
    };
    const legacy = planAlertMatch(alert, { ...context, recentJobs: window });
    const indexed = planAlertMatch(alert, { ...context, candidateIndex: index, candidateCursorMs: cursorMs });
    expect(legacy.discoveryMode).toBe(true);
    expect(normalizePlan(indexed)).toEqual(normalizePlan(legacy));
  });
});

describe('rollout — planAlertForRun', () => {
  const index = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });
  const selector = createJobAlertCandidateSelector(INVENTORY, { nowMs: NOW });
  const alert = { id: 'rollout-1', email: 'r@example.test', locale: 'it', keywords: ['infermiere'] };
  const windowOptions = { recipientLastSentAt: new Date(NOW - 2 * DAY), alertCreatedAt: 0, initialLookbackMs: DAY };
  const cursor = resolveJobAlertCursor({ ...windowOptions, nowMs: NOW });
  const context: any = {
    behaviorProfiles: new Map(), lastClickedUrlByEmail: new Map(), locationIndex: new Map(), cityToCanton: new Map(),
    subscriberProfiles: new Map(), now: NOW, featureCache: createJobFeatureCache(), compactMatches: true, allowDiscovery: false,
  };
  const run = (options: any) => {
    const metrics = createJobAlertMetrics();
    const warnings: string[] = [];
    const result = planAlertForRun(alert, context, {
      cursor,
      selectLegacyWindow: () => selector(windowOptions).jobs,
      candidateIndex: index,
      metrics,
      warn: (line: string) => warnings.push(line),
      ...options,
    });
    return { ...result, counters: metrics.snapshot().counters, warnings };
  };

  it('off: solo legacy, nessun conteggio dell indice', () => {
    const { usedIndex, counters, plan } = run({ indexMode: 'off', sampleRate: 1 });
    expect(usedIndex).toBe(false);
    expect(counters.indexSampled).toBeUndefined();
    expect(plan.scoredRows).toBeGreaterThan(0);
  });

  it('on senza campione: decide l indice e valuta molte meno righe', () => {
    const off = run({ indexMode: 'off' });
    const on = run({ indexMode: 'on', sampleRate: 0 });
    expect(on.usedIndex).toBe(true);
    expect(normalizePlan(on.plan)).toEqual(normalizePlan(off.plan));
    expect(on.plan.scoredRows).toBeLessThan(off.plan.scoredRows);
    expect(on.windowRows).toBe(off.windowRows);
    expect(on.counters.indexedAlerts).toBe(1);
  });

  it('on con campione pieno: confronta col legacy e, se uguali, usa l indice', () => {
    const on = run({ indexMode: 'on', sampleRate: 1 });
    expect(on.usedIndex).toBe(true);
    expect(on.counters.indexSampled).toBe(1);
    expect(on.counters.indexMismatch).toBeUndefined();
  });

  it('on: una divergenza dell indice usa il piano LEGACY e conta indexMismatch (solo l id dell alert nel log)', () => {
    const broken = {
      ...index,
      select: (...args: any[]) => {
        const real = (index.select as any)(...args);
        return { ...real, rows: real.rows.slice(1) };
      },
    };
    const result = run({ indexMode: 'on', sampleRate: 1, candidateIndex: broken });
    const legacy = run({ indexMode: 'off' });
    expect(result.usedIndex).toBe(false);
    expect(normalizePlan(result.plan)).toEqual(normalizePlan(legacy.plan));
    expect(result.counters.indexMismatch).toBe(1);
    expect(result.warnings.join('\n')).toContain('rollout-1');
    expect(result.warnings.join('\n')).toMatch(/\[[0-9a-f]{12}\]/);
    expect(result.warnings.join('\n')).not.toContain('@');
  });

  it('on: un eccezione dell indice ripiega sul legacy senza fermare il run', () => {
    const throwing = { ...index, select: () => { throw new Error('boom'); } };
    const result = run({ indexMode: 'on', sampleRate: 0, candidateIndex: throwing });
    const legacy = run({ indexMode: 'off' });
    expect(result.usedIndex).toBe(false);
    expect(normalizePlan(result.plan)).toEqual(normalizePlan(legacy.plan));
    expect(result.counters.indexErrors).toBe(1);
  });

  it('shadow: decide il legacy anche su una divergenza, che si conta', () => {
    const broken = {
      ...index,
      select: (...args: any[]) => {
        const real = (index.select as any)(...args);
        return { ...real, candidateCount: real.candidateCount + 1 };
      },
    };
    const result = run({ indexMode: 'shadow', sampleRate: 1, candidateIndex: broken });
    expect(result.usedIndex).toBe(false);
    expect(result.counters.indexMismatch).toBe(1);
    const clean = run({ indexMode: 'shadow', sampleRate: 1 });
    expect(clean.counters.indexMismatch).toBeUndefined();
    expect(clean.counters.indexSampled).toBe(1);
  });
});

describe('rollout — configurazione e campionamento', () => {
  it('default locale on; 0,005 in LIVE e 0,10 in dry-run', () => {
    expect(resolveCandidateIndexConfig({}, { dryRun: false })).toMatchObject({ mode: 'on', sampleRate: 0.005 });
    expect(resolveCandidateIndexConfig({}, { dryRun: true })).toMatchObject({ mode: 'on', sampleRate: 0.1 });
  });

  it('accetta off|shadow|on, la frazione del campione e un budget; un valore ignoto ripiega su shadow', () => {
    expect(resolveCandidateIndexConfig({ JOB_ALERT_CANDIDATE_INDEX_MODE: ' OFF ' }).mode).toBe('off');
    expect(resolveCandidateIndexConfig({ JOB_ALERT_CANDIDATE_INDEX_MODE: 'shadow' }).mode).toBe('shadow');
    expect(resolveCandidateIndexConfig({ JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE: '0.5' }).sampleRate).toBe(0.5);
    expect(resolveCandidateIndexConfig({ JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE: '7' }).sampleRate).toBe(1);
    expect(resolveCandidateIndexConfig({ JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE: 'x' }).sampleRate).toBe(0.005);
    expect(resolveCandidateIndexConfig({ JOB_ALERT_CANDIDATE_INDEX_BUDGET_MB: '8' }).budgetBytes).toBe(8 * 1024 * 1024);
    const odd = resolveCandidateIndexConfig({ JOB_ALERT_CANDIDATE_INDEX_MODE: 'turbo' });
    expect(odd).toMatchObject({ mode: 'shadow', invalidMode: true });
  });

  it('il campione è deterministico per id e vicino alla frazione richiesta', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `alert-${i}`);
    const first = ids.filter((id) => isAlertSampledForIndexCheck(id, 0.1));
    const second = ids.filter((id) => isAlertSampledForIndexCheck(id, 0.1));
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(300);
    expect(first.length).toBeLessThan(500);
    expect(isAlertSampledForIndexCheck('x', 0)).toBe(false);
    expect(isAlertSampledForIndexCheck('x', 1)).toBe(true);
    expect(alertSampleFraction('x')).toBe(alertSampleFraction('x'));
  });

  // Dry-run di produzione: gli alert del backfill hanno TUTTI l'id `backfill-newsletter`
  // (in sottocollezioni di email diverse). Campionare sul solo id rendeva il campione
  // «tutti o nessuno»: 14 alert verificati su ~117 attesi.
  describe('campionamento sul percorso completo del documento', () => {
    const backfillAlerts = Array.from({ length: 1000 }, (_, i) => ({
      id: 'backfill-newsletter',
      email: `person${i}@example.test`,
      ref: { path: `job_alert_subscribers/person${i}@example.test/alerts/backfill-newsletter` },
    }));

    it('1.000 alert con lo stesso id e percorsi diversi: la frazione campionata e\' quella richiesta (±3 punti)', () => {
      for (const rate of [0.02, 0.1, 0.5]) {
        const sampled = backfillAlerts.filter((alert) => isAlertSampledForIndexCheck(alertSampleKey(alert), rate)).length;
        expect(Math.abs(sampled / backfillAlerts.length - rate)).toBeLessThanOrEqual(0.03);
      }
    });

    it('il campione sul solo id era degenere: tutti o nessuno (la regressione che il test difende)', () => {
      const byId = backfillAlerts.filter((alert) => isAlertSampledForIndexCheck(alert.id, 0.1)).length;
      expect([0, backfillAlerts.length]).toContain(byId);
    });

    it('senza riferimento la chiave e\' email minuscola + id, e distingue due email con lo stesso id', () => {
      const a = { id: 'backfill-newsletter', email: 'Persona@Example.test' };
      const b = { id: 'backfill-newsletter', email: 'altra@example.test' };
      expect(alertSampleKey(a)).toBe('persona@example.test\u0000backfill-newsletter');
      expect(alertSampleKey(a)).not.toBe(alertSampleKey(b));
    });

    it('l identificatore diagnostico e\' di 12 esadecimali, univoco per percorso e senza traccia dell email', () => {
      const ids = new Set(backfillAlerts.map((alert) => alertDiagnosticId(alert)));
      expect(ids.size).toBe(backfillAlerts.length);
      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-f]{12}$/);
        expect(id).not.toContain('person');
      }
    });

    it('planAlertForRun in `on` con alert dallo stesso id: verifica la frazione richiesta e il log di divergenza porta id + identificatore, mai l email', () => {
      const logs: string[] = [];
      const metrics = createJobAlertMetrics();
      const rows = INVENTORY.slice(0, 30);
      const index = createJobAlertCandidateIndex(rows, { nowMs: NOW });
      const context = (_alert: any) => ({
        behaviorProfiles: new Map(), lastClickedUrlByEmail: new Map(), locationIndex: new Map(), cityToCanton: new Map(),
        subscriberProfiles: new Map(), now: NOW, featureCache: createJobFeatureCache(), compactMatches: true, allowDiscovery: false,
      });
      const cursor = { cursorMs: 0 };
      const sample = backfillAlerts.slice(0, 300).map((alert) => ({ ...alert, active: true, keywords: ['infermiere'] }));
      for (const alert of sample) {
        planAlertForRun(alert, context(alert), {
          cursor,
          selectLegacyWindow: () => rows,
          candidateIndex: index,
          indexMode: 'on',
          sampleRate: 0.1,
          metrics,
          warn: (line: string) => logs.push(line),
        });
      }
      const counters = metrics.snapshot().counters;
      expect(counters.indexSampled / sample.length).toBeGreaterThan(0.05);
      expect(counters.indexSampled / sample.length).toBeLessThan(0.15);
      expect(logs.join('\n')).not.toMatch(/@example\.test/);
    });
  });
});

describe('selettore — parità sul timestamp dell inventario', () => {
  it('le righe indicizzate hanno tutte un timestamp valido e non futuro', () => {
    const index = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });
    const rows = index.select(null, { locale: 'it', ownerAlert: true, cursorMs: 0, forceWindow: true }).rows;
    for (const job of rows) {
      const at = jobInventoryTimestampMs(job);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThanOrEqual(NOW);
      expect(job.status).not.toBe('expired');
    }
  });
});


// ── Fast path del planning (P1 risposte di ricerca, P4 predicati per riga) ──

/**
 * Profili soft-legacy scritti a mano: ogni fatto che i predicati dell'indice
 * sostituiscono (azienda, località, cantone, settore, contratto, overlap dei
 * token soft, scope geo duro) con i casi limite che `buildAlertProfile` non
 * produce da solo: stringhe vuote in `cantons`/`sectors`, `companyKeys` vuoto,
 * needle di località che si normalizzano a nulla.
 */
function softLegacyHandProfiles() {
  const base = () => ({
    hardKeywords: new Set<string>(), hardCategoryKeys: new Set<string>(), hardTaxonomyValues: new Set<string>(),
    hardSearchQueries: [] as string[], softTokens: new Set<string>(['manager', 'software', 'infermiere']), softSearchQueries: [] as string[],
    company: '', companyKeys: undefined as string[] | undefined, locations: [] as string[], alertLocations: [] as string[],
    cantons: [] as string[], sectors: [] as string[], contractTypes: [] as string[],
    specificJobIds: [] as string[], specificCompanyKey: '', preferredLocations: [] as string[], preferredCantons: [] as string[],
  });
  const out: Array<{ label: string; profile: any }> = [];
  const add = (label: string, patch: any) => out.push({ label, profile: { ...base(), ...patch } });
  add('tokens-only', {});
  add('tokens-and-search', { softSearchQueries: ['cuoco lugano', 'zzz'] });
  add('search-only-fallback', { softTokens: new Set(['zzzzzzzz']), softSearchQueries: ['infermiere', 'cuoco', 'manager'] });
  add('company', { company: 'eoc', companyKeys: ['eoc'] });
  add('company-no-keys', { company: 'eoc', companyKeys: [] });
  add('company-and-location', { company: 'migros', companyKeys: ['migros'], locations: ['lugano', 'zurich'] });
  add('canton-empty-string', { cantons: ['', 'ti'], softSearchQueries: ['cuoco'] });
  add('canton-only-empty', { cantons: [''] });
  add('sector-empty-string', { sectors: ['', 'healthcare'] });
  add('sector-title', { sectors: ['manager', 'it'] });
  add('contract', { contractTypes: ['full-time', 'zzz'] });
  add('geo-scope-location', { alertLocations: ['lugano', 'bellinzona'], locations: ['lugano'] });
  add('geo-scope-canton', { cantons: ['zh', 'ge'], sectors: ['it'] });
  add('geo-scope-both', { alertLocations: ['chur'], cantons: ['ti'], company: 'eoc', companyKeys: ['eoc'], softSearchQueries: ['infermiere'] });
  add('geo-scope-no-needles', { alertLocations: ['--'], cantons: [] });
  add('geo-scope-empty-canton', { cantons: [''] , alertLocations: ['lugano'] });
  add('location-no-needles', { locations: ['--'] });
  add('all-signals', {
    company: 'coopticino', companyKeys: ['coopticino'], locations: ['lugano', 'coira'], cantons: ['ti'], sectors: ['healthcare', 'cuoco'],
    contractTypes: ['full-time'], softSearchQueries: ['infermiere lugano'],
  });
  return out;
}

describe('fast path — P1 risposte di ricerca e P4 predicati: lo scorer dà lo stesso risultato su ogni riga', () => {
  const index = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });

  /**
   * Per ogni riga eleggibile (non solo i candidati): scorer di prima contro
   * scorer con risposte e predicati dell'indice. Le risposte e i predicati sono
   * validi su TUTTE le righe, quindi anche le non candidate devono dare lo
   * stesso punteggio (0 incluso).
   */
  const compareScorers = (label: string, profile: any, locale: string, owner: boolean, tally: Record<string, number>) => {
    const selection: any = index.select(profile, { locale, ownerAlert: owner, cursorMs: 0, fastpath: true });
    const universe: any = index.select(null, { locale, ownerAlert: owner, cursorMs: 0, forceWindow: true });
    const plain = createAlertScorer(profile, locale, createJobFeatureCache(createJobFeatureStore()));
    const fast = createAlertScorer(profile, locale, createJobFeatureCache(createJobFeatureStore()), {
      searchAnswers: selection.searchAnswers,
      predicates: selection.predicates,
    });
    tally.answers += selection.searchAnswers.byQuery.size;
    if (selection.predicates) tally.predicates += 1;
    universe.rows.forEach((row: any, k: number) => {
      const expected = plain(row);
      const actual = fast(row, universe.rowIndices[k]);
      if (actual !== expected) {
        throw new Error(`${label} locale=${locale} owner=${owner}: riga ${row.id} atteso ${expected} ottenuto ${actual} (strategia ${selection.strategy})`);
      }
    });
    // Senza l'indice di riga le risposte non si usano: stessa risposta di prima.
    for (const row of universe.rows.slice(0, 20)) expect(fast(row)).toBe(plain(row));
  };

  it('1.200 profili sintetici × locali: con e senza risposte/predicati, stesso score su ogni riga', () => {
    const tally = { answers: 0, predicates: 0 };
    for (const c of syntheticCases(1200)) {
      const profile = buildProfile(c);
      compareScorers(c.label, profile, nlNormLocale(c.alert.locale), isOwnerEmail(c.alert.email), tally);
    }
    // Il confronto non è banale: risposte e predicati sono stati davvero usati.
    expect(tally.answers).toBeGreaterThan(100);
    expect(tally.predicates).toBeGreaterThan(50);
  }, 240_000);

  it('profili soft-legacy a mano (casi limite dei predicati) in ogni locale, con e senza proprietario', () => {
    const tally = { answers: 0, predicates: 0 };
    for (const { label, profile } of softLegacyHandProfiles()) {
      for (const locale of LOCALES) {
        for (const owner of [false, true]) compareScorers(label, profile, locale, owner, tally);
      }
    }
    expect(tally.predicates).toBeGreaterThan(20);
    expect(tally.answers).toBeGreaterThan(10);
  }, 120_000);

  it('i profili a mano di prima (hard, pinned, ricerca) restano uguali con le risposte', () => {
    const tally = { answers: 0, predicates: 0 };
    for (const { label, profile } of handBuiltProfiles()) {
      for (const locale of LOCALES) compareScorers(label, profile, locale, false, tally);
    }
  }, 120_000);

  it('un profilo diverso o un locale diverso da quello della selezione ignora i predicati e le risposte', () => {
    const profile = { ...softLegacyHandProfiles()[1].profile };
    const other = { ...profile, sectors: ['healthcare'] };
    const selection: any = index.select(profile, { locale: 'it', cursorMs: 0, fastpath: true });
    const universe: any = index.select(null, { locale: 'it', cursorMs: 0, forceWindow: true });
    // Predicati costruiti per `profile`, passati con `other`: non si usano (la guardia e' l'identita').
    const mismatched = createAlertScorer(other, 'it', createJobFeatureCache(createJobFeatureStore()), { predicates: selection.predicates });
    const plain = createAlertScorer(other, 'it', createJobFeatureCache(createJobFeatureStore()));
    universe.rows.forEach((row: any, k: number) => expect(mismatched(row, universe.rowIndices[k])).toBe(plain(row)));
    // Risposte di un locale passate con un altro locale: ignorate.
    const wrongLocale = createAlertScorer(profile, 'de', createJobFeatureCache(createJobFeatureStore()), { searchAnswers: selection.searchAnswers });
    const plainDe = createAlertScorer(profile, 'de', createJobFeatureCache(createJobFeatureStore()));
    const deUniverse: any = index.select(null, { locale: 'de', cursorMs: 0, forceWindow: true });
    deUniverse.rows.forEach((row: any, k: number) => expect(wrongLocale(row, deUniverse.rowIndices[k])).toBe(plainDe(row)));
  });

  it('select() restituisce indici di riga allineati alle righe, risposte solo del vocabolario e predicati solo su soft-legacy', () => {
    const search = buildProfile(syntheticCases(1200).find((c) => c.label.startsWith('hard-search'))!);
    const selection: any = index.select(search, { locale: 'it', cursorMs: 0, fastpath: true });
    expect(selection.strategy).toBe('hard-search');
    expect(selection.rowIndices).toBeInstanceOf(Int32Array);
    expect(selection.rowIndices.length).toBe(selection.rows.length);
    selection.rowIndices.forEach((rowIndex: number, k: number) => expect(index.rowAt(rowIndex)).toBe(selection.rows[k]));
    expect(selection.searchAnswers.locale).toBe('it');
    expect(selection.searchAnswers.byQuery.size).toBeGreaterThan(0);
    expect(selection.predicates ?? null).toBeNull();
    // Senza fastpath non si preparano predicati, risposte e colonne.
    const plainSelection: any = index.select(search, { locale: 'it', cursorMs: 0 });
    expect(plainSelection.searchAnswers).toBeUndefined();
    expect(plainSelection.columns).toBeUndefined();
    expect(plainSelection.rows).toEqual(selection.rows);
    // Il percorso per-riga (token non standard) non produce risposte: valgono solo su `need`.
    const odd = { ...softLegacyHandProfiles()[0].profile, softSearchQueries: [], hardKeywords: new Set(['x']), hardSearchQueries: ['!!!'] };
    const oddSelection: any = index.select(odd, { locale: 'it', cursorMs: 0, fastpath: true });
    expect(oddSelection.searchAnswers.byQuery.size).toBe(0);
    const soft = index.select({ ...softLegacyHandProfiles()[1].profile }, { locale: 'it', cursorMs: 0, fastpath: true }) as any;
    expect(soft.strategy).toBe('soft-legacy');
    expect(soft.predicates).not.toBeNull();
  });
});

describe('fast path — golden planAlertMatch: matched, metadata e ordine identici al legacy', () => {
  const index = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });
  const selector = createJobAlertCandidateSelector(INVENTORY, { nowMs: NOW });

  /** `matched` con identità, metadata di ranking e (non compatto) campi, tutto a confronto profondo. */
  const deepPlan = (plan: any) => ({
    candidateCount: plan.candidateCount,
    rankedCount: plan.rankedCount,
    zeroCause: plan.zeroCause,
    sentMap: plan.sentMap,
    matched: plan.matched.map((job: any) => ({
      id: job.id,
      metadata: plan.rankingMetadata ? plan.rankingMetadata.get(job) : undefined,
      ...(plan.rankingMetadata ? {} : { relevanceScore: job.relevanceScore, relevanceSignals: job.relevanceSignals, newnessAt: job.newnessAt, applicationIntentBoost: job.applicationIntentBoost }),
    })),
  });

  const intentFor = (jobs: any[], pick: number[]) => {
    let intent: any = null;
    for (const i of pick) intent = recordApplicationIntentSignal(intent, buildApplicationIntentJobKey(jobs[i]), NOW - 60_000).applicationIntent;
    return intent;
  };

  for (const compactMatches of [true, false]) {
    for (const applicationIntentRankingEnabled of [false, true]) {
      it(`400 alert: piano identico con fast path e senza — compact=${compactMatches} applicationIntent=${applicationIntentRankingEnabled}`, () => {
        const cases = syntheticCases(400);
        const store = createJobFeatureStore();
        const open = index.select(null, { locale: 'it', ownerAlert: true, cursorMs: 0, forceWindow: true }).rows as any[];
        let withMatches = 0;
        let boosted = 0;
        for (const [position, c] of cases.entries()) {
          const email = c.alert.email.toLowerCase();
          const behaviorProfiles = new Map();
          const applicationIntentAccountProfiles = new Map();
          if (applicationIntentRankingEnabled && position % 2 === 0) {
            behaviorProfiles.set(email, { applicationIntentAuthUid: 'u1', applicationIntent: intentFor(open, [1, 4, 9, 17, 25, 33, 41, 60, 77]) });
            applicationIntentAccountProfiles.set(email, { uid: 'u1', optedOut: false });
          }
          const cursorMs = NOW - [0.5, 1, 2, 5][position % 4] * DAY;
          const window = selector({ recipientLastSentAt: new Date(cursorMs), alertCreatedAt: 0, initialLookbackMs: DAY }).jobs;
          const alert = { ...c.alert, sentJobIds: position % 5 === 0 ? { 'job-1': NOW - DAY, 'job-4': NOW - DAY } : undefined };
          const context: any = {
            behaviorProfiles,
            lastClickedUrlByEmail: new Map(),
            locationIndex: new Map(),
            cityToCanton: new Map([['lugano', 'ti'], ['zurich', 'zh']]),
            subscriberProfiles: new Map([[email, c.subscriber]]),
            applicationIntentAccountProfiles,
            now: NOW,
            compactMatches,
            allowDiscovery: false,
            applicationIntentRankingEnabled,
          };
          const legacy = planAlertMatch(alert, { ...context, featureCache: createJobFeatureCache(store), recentJobs: window });
          const off = planAlertMatch(alert, { ...context, featureCache: createJobFeatureCache(createJobFeatureStore()), candidateIndex: index, candidateCursorMs: cursorMs, planningFastpath: false });
          const fast = planAlertMatch(alert, { ...context, featureCache: createJobFeatureCache(createJobFeatureStore()), candidateIndex: index, candidateCursorMs: cursorMs, planningFastpath: true });
          expect(deepPlan(fast), `${c.label} fast`).toEqual(deepPlan(legacy));
          expect(deepPlan(off), `${c.label} off`).toEqual(deepPlan(legacy));
          expect(fast.scoredRows).toBe(off.scoredRows);
          expect(fast.indexStrategy).toBe(off.indexStrategy);
          if (legacy.matched.length > 0) withMatches += 1;
          if (compactMatches) {
            for (const job of fast.matched) if (fast.rankingMetadata.get(job)?.applicationIntentBoost !== undefined) boosted += 1;
          }
          // Con compactMatches `matched` e' fatto degli stessi oggetti riga del legacy.
          if (compactMatches) expect(fast.matched.every((job: any, i: number) => job === legacy.matched[i])).toBe(true);
        }
        expect(withMatches).toBeGreaterThan(100);
        // Con l'application intent acceso il confronto copre davvero job con boost.
        if (compactMatches && applicationIntentRankingEnabled) expect(boosted).toBeGreaterThan(0);
      }, 240_000);
    }
  }
});
