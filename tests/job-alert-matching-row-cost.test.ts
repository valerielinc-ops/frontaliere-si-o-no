/**
 * #9314 — the job-alert matching loop must not pay alert-independent work once
 * per alert.
 *
 * Since #9471 every alert is planned against the recipient's whole catch-up
 * window: run 36097910375 planned 5.160 alerts over 96.137.735 candidate rows
 * (733 s from `Capacity check` to `Total`, target < 180 s), and #9695 then
 * expanded every profession keyword into its 8-27 cross-locale aliases. A CPU
 * profile of the loop on the live inventory put the time in three places, all
 * of them answers that depend on the job and never on the alert:
 *
 *   1. the hard-keyword scan `fullText.includes(kw)` over a ~2.4 KB
 *      description, repeated for every alert sharing the keyword;
 *   2. the location normalization inside `locTokenHit` (NFD + two regexes)
 *      of the job side, repeated per alert and per location needle;
 *   3. the candidate window: every row's inventory timestamp parsed again for
 *      every alert.
 *
 * Observers (they fail on the pre-#9314 code, where each count grows with the
 * number of alerts):
 *   - description-sized `includes` calls <= distinct keywords x jobs;
 *   - `String.prototype.normalize` calls <= jobs x locales + needles;
 *   - inventory timestamp conversions == rows, whatever the number of alerts.
 *
 * Oracles (the answer must not move):
 *   - the pre-#9314 `scoreJobForAlert`, verbatim, over a grid of jobs x
 *     profiles x locales, with and without one shared cache;
 *   - `selectJobAlertCandidates` for the precomputed selector;
 *   - the pre-#9314 eligibility filters for `planAlertMatch`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAlertProfile,
  createAlertScorer,
  createJobFeatureCache,
  jobMatchFeatures,
  partitionByGeoPreference,
  scoreJobForAlert,
} from '../services/jobAlertMatching.mjs';
import { locTokenHit } from '../services/locToken.mjs';
import {
  canonicalCompanyProfileSlug,
  companyDisplayIdentityKeys,
} from '../build-plugins/shared/companyProfileSlug.mjs';
import {
  createJobAlertCandidateSelector,
  selectJobAlertCandidates,
} from '../scripts/lib/job-alert-newness.mjs';
import {
  createJobLivenessPrefetcher,
  planAlertMatch,
  rankLiveJobsForEmail,
} from '../scripts/send-job-alerts.mjs';
import {
  JOB_EMAIL_RANKING_DEFAULTS,
  rankEmailJobs,
} from '../functions/src/lib/jobEmailRanking.js';
import { nlNormLocale } from '../services/newsletter-template.mjs';
import { OWNER_EMAIL, isOwnerEmail } from '../scripts/lib/canaryAd.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-25T05:00:00Z');
const LOCALES = ['it', 'de', 'fr', 'en'];
// Long enough that a scan of `fullText` is told apart from any title-sized
// string the scorer touches.
const DESCRIPTION_MIN = 1500;
const FILLER = 'Ambiente di lavoro dinamico, formazione continua e buone prospettive. '.repeat(24);

const TITLES = [
  'Infermiere diplomato 80-100%',
  'Senior Software Engineer (Java)',
  'Contabile / Accountant',
  'Magazziniere carrellista',
  'Elektriker EFZ',
  'Ingénieur logiciel',
  'Sales Manager',
  'Assistente di cura',
];
const PLACES = [
  ['Lugano', 'TI'],
  ['Bellinzona', 'TI'],
  ['Zürich', 'ZH'],
  ['Genève', 'GE'],
  ['St. Gallen', 'SG'],
  ['', 'TI'],
  ['Lugano-Paradiso', ''],
];
const COMPANIES = ['EOC', 'Coop Ticino', 'Banca Stato SA', 'ABB Svizzera', 'Migros', ''];

function fixtureJobs(count = 84) {
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const [location, canton] = PLACES[i % PLACES.length];
    const title = TITLES[i % TITLES.length];
    // i % 32 === 6: an English title ending in "Manager" and a description
    // starting with "Lugano": in the `en` fullText the keyword "manager lugano"
    // exists only ACROSS the title/description join.
    const crossJoin = i % 32 === 6;
    const lead = crossJoin ? 'Lugano, sede centrale.' : `Cerchiamo ${title}.`;
    let titleByLocale: Record<string, string> = {};
    if (crossJoin) titleByLocale = { en: 'Sales Manager' };
    else if (i % 2 === 0) titleByLocale = { de: `${title} (DE)`, en: `${title} EN`, fr: `${title} FR` };
    jobs.push({
      id: `job-${i}`,
      slug: `job-${i}`,
      title,
      titleByLocale,
      description: i % 13 === 0 ? '' : `${lead} ${FILLER} ${i % 5 === 0 ? 'Richiesta esperienza come infermiere.' : ''}`,
      company: COMPANIES[i % COMPANIES.length],
      category: i % 4 === 0 ? 'sanità' : 'informatica',
      sector: i % 5 === 0 ? 'healthcare' : 'it',
      location,
      canton,
      contract: i % 2 ? 'full-time' : 'part-time',
      firstSeenAt: new Date(NOW - (i % 5) * DAY).toISOString(),
      crawledAt: new Date(NOW - (i % 3) * DAY / 2).toISOString(),
      ...(i % 17 === 3 ? { canary: true } : {}),
      ...(i % 11 === 2 ? { needsRetranslation: true, sourceLang: i % 2 ? 'de' : undefined } : {}),
    });
  }
  return jobs;
}

const ALERTS = [
  { id: 'kw', email: 'a@example.test', locale: 'it', keywords: ['infermiere'] },
  { id: 'kw-geo', email: 'b@example.test', locale: 'de', keywords: ['engineer', 'elektriker'], locations: ['Zurich'] },
  { id: 'kw-canton', email: 'c@example.test', locale: 'fr', keywords: ['contabile'], cantonFilter: ['TI'] },
  { id: 'cross-join', email: 'd@example.test', locale: 'en', keywords: ['manager lugano'] },
  { id: 'canton-only', email: 'e@example.test', locale: 'it', cantonFilter: ['TI'] },
  { id: 'blank-location', email: 'f@example.test', locale: 'it', keywords: ['cura'], locations: ['  ', '--'] },
  { id: 'one-tap', email: 'g@example.test', locale: 'en', sourceJobTitle: 'Sales Manager', sourceJobSlug: 'sales-manager' },
  { id: 'soft-geo', email: 'h@example.test', locale: 'it' },
  { id: 'sector-contract', email: 'i@example.test', locale: 'de', sectors: ['sanità'], contractTypes: ['full-time'] },
  { id: 'empty', email: 'j@example.test', locale: 'it' },
  { id: 'pinned-job', email: 'k@example.test', locale: 'it', specificJobId: 'job-7' },
  { id: 'pinned-company', email: 'l@example.test', locale: 'it', specificCompanyKey: 'eoc' },
  { id: 'no-locale', email: 'm@example.test', keywords: ['magazziniere'], locations: ['Lugano'] },
];

const SUBSCRIBERS: Record<string, any> = {
  'g@example.test': { job_company: 'Coop Ticino', geo_city: 'bellinzona' },
  'h@example.test': { location_interest: 'lugano', sector_interest: 'healthcare' },
  'e@example.test': { geo_city: 'Zürich' },
};

// ── Oracle: scoreJobForAlert as it was before #9314, verbatim ────────────────
function oracleCompanyToken(value: unknown) {
  const t = canonicalCompanyProfileSlug(value, value).replace(/-/g, '');
  return t.length >= 3 ? t : '';
}
function oraclePinnedKeys(job: any) {
  return companyDisplayIdentityKeys(job?.company).map(oracleCompanyToken);
}
function oracleScore(job: any, profile: any, locale?: string) {
  if (!job || !profile) return 0;
  const pinnedJobs = profile.specificJobIds || [];
  const pinnedCompany = profile.specificCompanyKey || '';
  if (pinnedJobs.length > 0 || pinnedCompany) {
    const jobCompanyKeys = oraclePinnedKeys(job);
    const idHit = pinnedJobs.includes(String(job.id || ''))
      || pinnedJobs.includes(String(job.publisherJobId || ''));
    const companyHit = Boolean(pinnedCompany && jobCompanyKeys.includes(pinnedCompany));
    return (idHit || companyHit) ? 10 : 0;
  }
  const {
    titleText, fullText, jobTokens, jobCompany, jobLoc, jobCanton, jobSector, jobContract,
  } = jobMatchFeatures(job, locale);
  let score = 0;
  const { hardKeywords } = profile;
  if (hardKeywords.size > 0) {
    let hit = false;
    for (const kw of hardKeywords) {
      if (fullText.includes(kw)) { hit = true; break; }
    }
    if (!hit) return 0;
    score += 3;
    let overlap = 0;
    for (const kw of hardKeywords) if (jobTokens.has(kw)) overlap++;
    score += Math.min(3, overlap);
  }
  const companyMatch = Boolean(profile.company && jobCompany && jobCompany === profile.company);
  if (companyMatch) score += 4;
  let softOverlap = 0;
  for (const t of profile.softTokens) if (jobTokens.has(t)) softOverlap++;
  if (softOverlap > 0) score += Math.min(5, softOverlap * 2);
  const hasGeoScope = profile.alertLocations.length > 0 || profile.cantons.length > 0;
  if (hasGeoScope) {
    const geoHit =
      profile.alertLocations.some((l: string) => locTokenHit(jobLoc, l)) ||
      (profile.cantons.length > 0 && jobCanton && profile.cantons.includes(jobCanton));
    if (!geoHit) return 0;
  }
  const locationMatch = profile.locations.some((l: string) => locTokenHit(jobLoc, l));
  if (locationMatch) score += 2;
  const cantonMatch = profile.cantons.length > 0 && profile.cantons.includes(jobCanton);
  if (cantonMatch) score += 1;
  const sectorMatch = profile.sectors.some((s: string) => jobSector.includes(s) || titleText.includes(s));
  if (sectorMatch) score += 2;
  const contractMatch = profile.contractTypes.some((c: string) => jobContract.includes(c));
  if (contractMatch) score += 1;
  if (hardKeywords.size === 0) {
    const hasIntentProfile = profile.softTokens.size > 0 || Boolean(profile.company);
    if (hasIntentProfile) {
      if (softOverlap === 0 && !companyMatch && !sectorMatch && !locationMatch) return 0;
    } else if (score === 0) {
      return 0;
    }
  }
  return Math.max(score, 1);
}

// ── Oracle: partitionByGeoPreference as it was before #9314, verbatim ──────
function oraclePartition(jobs: any[], profile: any, minLocal = 5) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!profile) return list;
  if ((profile.alertLocations?.length || 0) > 0 || (profile.cantons?.length || 0) > 0) return list;
  const prefLoc = profile.preferredLocations || [];
  const prefCanton = profile.preferredCantons || [];
  if (prefLoc.length === 0 && prefCanton.length === 0) return list;
  const inArea: any[] = [];
  const rest: any[] = [];
  for (const job of list) {
    const jobCanton = String(job?.canton || '').toLowerCase();
    const jobLoc = `${job?.location || ''} ${job?.addressLocality || ''} ${job?.addressRegion || ''} ${job?.canton || ''}`.toLowerCase();
    const hit = (prefCanton.length > 0 && jobCanton && prefCanton.includes(jobCanton))
      || prefLoc.some((l: string) => locTokenHit(jobLoc, l));
    (hit ? inArea : rest).push(job);
  }
  return inArea.length >= minLocal ? inArea : inArea.concat(rest);
}

function profileOf(alert: any) {
  return buildAlertProfile(alert, SUBSCRIBERS[alert.email] || null, {
    cityToCanton: new Map([['lugano', 'ti'], ['bellinzona', 'ti'], ['zürich', 'zh']]),
  });
}

function planContext(recentJobs: unknown[], featureCache: unknown) {
  return {
    behaviorProfiles: new Map(),
    lastClickedUrlByEmail: new Map(),
    locationIndex: new Map(),
    cityToCanton: new Map([['lugano', 'ti'], ['bellinzona', 'ti']]),
    subscriberProfiles: new Map(Object.entries(SUBSCRIBERS)),
    recentJobs,
    now: NOW,
    featureCache,
  };
}

// ── Instrumentation of the builtins the expensive paths go through ───────────
const originalIncludes = String.prototype.includes;
const originalNormalize = String.prototype.normalize;
afterEach(() => {
  String.prototype.includes = originalIncludes;
  String.prototype.normalize = originalNormalize;
});

function countDuring<T>(fn: () => T) {
  const counts = { descriptionScans: 0, normalizations: 0 };
  String.prototype.includes = function (this: string, ...args: [string, number?]) {
    if (this.length >= DESCRIPTION_MIN) counts.descriptionScans++;
    return originalIncludes.apply(this, args);
  };
  String.prototype.normalize = function (this: string, ...args: [string?]) {
    counts.normalizations++;
    return originalNormalize.apply(this, args as [string]);
  };
  try {
    return { result: fn(), counts };
  } finally {
    String.prototype.includes = originalIncludes;
    String.prototype.normalize = originalNormalize;
  }
}

describe('scorer oracle (#9314): same score as the pre-#9314 scoreJobForAlert', () => {
  it('matches the verbatim oracle over jobs x profiles x locales, uncached, compiled and with one shared cache', () => {
    const jobs = fixtureJobs();
    // One cache across every alert and locale, as in production: a memo keyed
    // too coarsely (locale, keyword, job) would leak an answer here.
    const cache = createJobFeatureCache();
    let compared = 0;
    let positive = 0;
    for (const alert of ALERTS) {
      const profile = profileOf(alert);
      for (const locale of [...LOCALES, undefined]) {
        const compiledCached = createAlertScorer(profile, locale, cache);
        const compiledUncached = createAlertScorer(profile, locale, null);
        for (const job of jobs) {
          const expected = oracleScore(job, profile, locale);
          expect(scoreJobForAlert(job, profile, locale)).toBe(expected);
          expect(scoreJobForAlert(job, profile, locale, cache)).toBe(expected);
          expect(compiledUncached(job)).toBe(expected);
          expect(compiledCached(job)).toBe(expected);
          compared++;
          if (expected > 0) positive++;
        }
      }
    }
    expect(compared).toBe(ALERTS.length * 5 * 84);
    // The grid must exercise both outcomes, or the equality proves nothing.
    expect(positive).toBeGreaterThan(300);
    expect(compared - positive).toBeGreaterThan(300);
  });

  it('finds a hard keyword that exists only across the title/description join', () => {
    const job = fixtureJobs().find((j) => j.id === 'job-6')!;
    const profile = profileOf(ALERTS.find((a) => a.id === 'cross-join'));
    const { fullText, titleText } = jobMatchFeatures(job, 'en');
    // Guard the fixture: the only occurrence straddles the joining space.
    expect(titleText.includes('manager lugano')).toBe(false);
    expect(fullText.slice(titleText.length + 1).includes('manager lugano')).toBe(false);
    expect(fullText.includes('manager lugano')).toBe(true);
    const cache = createJobFeatureCache();
    expect(oracleScore(job, profile, 'en')).toBeGreaterThan(0);
    // Twice: the second answer comes from the memo.
    expect(scoreJobForAlert(job, profile, 'en', cache)).toBe(oracleScore(job, profile, 'en'));
    expect(scoreJobForAlert(job, profile, 'en', cache)).toBe(oracleScore(job, profile, 'en'));
  });
});

describe('partitionByGeoPreference (#9314): needles normalized once, same split', () => {
  it('matches the verbatim oracle for profile and hand-made preferences', () => {
    const jobs = fixtureJobs();
    const preferences = [
      { preferredLocations: ['zurich'], preferredCantons: [] },
      { preferredLocations: ['lugano-paradiso', '--'], preferredCantons: ['ge'] },
      { preferredLocations: ['  '], preferredCantons: [] },
      { preferredLocations: ['st gallen', 'genève'], preferredCantons: ['ti'] },
    ];
    let compared = 0;
    for (const alert of ALERTS) {
      const profile = profileOf(alert);
      const variants = [profile, ...preferences.map((p) => ({ ...profile, alertLocations: [], cantons: [], ...p }))];
      for (const variant of variants) {
        for (const minLocal of [1, 5, 40]) {
          const slice = jobs.slice(compared % 7);
          expect(partitionByGeoPreference(slice, variant, { minLocal }).map((j: any) => j.id))
            .toEqual(oraclePartition(slice, variant, minLocal).map((j: any) => j.id));
          compared++;
        }
      }
    }
    expect(compared).toBe(ALERTS.length * 5 * 3);
  });
});

describe('matching cost per alert (#9314)', () => {
  it('scans each description at most once per keyword, however many alerts share it', () => {
    const jobs = fixtureJobs();
    const cache = createJobFeatureCache();
    // 24 recipients of the same profession alert, across the four locales.
    const alerts = Array.from({ length: 24 }, (_, i) => ({
      id: `nurse-${i}`,
      email: `n${i}@example.test`,
      locale: LOCALES[i % LOCALES.length],
      keywords: ['infermiere'],
    }));
    const keywordCount = profileOf(alerts[0]).hardKeywords.size;
    // #9695 expands the profession into its aliases: the cost the memo removes.
    expect(keywordCount).toBeGreaterThanOrEqual(8);
    const { result: plans, counts } = countDuring(() => (
      alerts.map((alert) => planAlertMatch(alert, planContext(jobs, cache)))
    ));
    expect(plans.some((p) => p.matched.length > 0)).toBe(true);
    // Pre-#9314: every alert re-scanned every description for every alias
    // until the first hit (> 24 x 84 scans here).
    expect(counts.descriptionScans).toBeLessThanOrEqual(keywordCount * jobs.length);
  });

  it('normalizes the job side once per (job, locale), however many alerts score it', () => {
    const jobs = fixtureJobs();
    const geoAlerts = (count: number) => Array.from({ length: count }, (_, i) => ({
      id: `geo-${i}`,
      email: `g${i}@example.test`,
      locale: LOCALES[i % LOCALES.length],
      keywords: ['engineer'],
      locations: ['Lugano', 'Zürich', 'Bellinzona'],
    }));
    // Job-side normalizations = the run over the pool minus the same alerts
    // over an empty pool (profile building and alert-side needles).
    const jobSide = (alerts: any[]) => {
      const withPool = countDuring(() => {
        const cache = createJobFeatureCache();
        for (const alert of alerts) planAlertMatch(alert, planContext(jobs, cache));
      }).counts.normalizations;
      const alertSideOnly = countDuring(() => {
        const cache = createJobFeatureCache();
        for (const alert of alerts) planAlertMatch(alert, planContext([], cache));
      }).counts.normalizations;
      return withPool - alertSideOnly;
    };
    const once = jobSide(geoAlerts(LOCALES.length));
    expect(once).toBeGreaterThan(0);
    // Pre-#9314 the scorer normalized the job location per job, per location
    // needle and per alert: six times the alerts, six times the count.
    expect(jobSide(geoAlerts(6 * LOCALES.length))).toBe(once);
  });

  it('parses each inventory timestamp once for the run, not once per alert', () => {
    let conversions = 0;
    const rows = fixtureJobs().map((j, i) => ({
      ...j,
      crawledAt: {
        toMillis() {
          conversions++;
          return NOW - (i % 6) * DAY / 3;
        },
      },
    }));
    const select = createJobAlertCandidateSelector(rows, { nowMs: NOW });
    for (let i = 0; i < 30; i++) {
      select({ recipientLastSentAt: new Date(NOW - (i % 4) * DAY / 2).toISOString(), initialLookbackMs: DAY });
    }
    expect(conversions).toBe(rows.length);
  });
});

describe('createJobAlertCandidateSelector (#9314): same windows as selectJobAlertCandidates', () => {
  it('returns the same rows, cursor, reason and exclusions for every recipient cursor', () => {
    const rows: any[] = fixtureJobs(40).map((j, i) => {
      if (i % 10 === 1) return { ...j, crawledAt: undefined, postedDate: undefined, firstSeenAt: undefined };
      if (i % 10 === 2) return { ...j, crawledAt: new Date(NOW + DAY).toISOString() };
      if (i % 10 === 3) return { ...j, validThrough: new Date(NOW - DAY).toISOString().slice(0, 10) };
      if (i % 10 === 4) return { ...j, validThrough: 'not-a-date' };
      if (i % 10 === 5) return { ...j, status: 'closed' };
      if (i % 10 === 6) return { ...j, crawledAt: undefined, postedDate: new Date(NOW - 3 * DAY).toISOString() };
      return j;
    });
    rows.push(null);
    const select = createJobAlertCandidateSelector(rows, { nowMs: NOW });
    const cursors = [
      {},
      { recipientLastSentAt: new Date(NOW - DAY).toISOString() },
      { recipientLastSentAt: new Date(NOW - 5 * DAY).toISOString(), alertCreatedAt: new Date(NOW - DAY / 4).toISOString() },
      { recipientLastSentAt: new Date(NOW + DAY).toISOString() },
      { alertCreatedAt: new Date(NOW - DAY / 3).toISOString(), initialLookbackMs: DAY },
      { recipientLastSentAt: 'garbage', initialLookbackMs: 3 * DAY },
    ];
    for (const options of cursors) {
      const expected = selectJobAlertCandidates(rows, { ...options, nowMs: NOW });
      const actual = select(options);
      expect(actual).toEqual(expected);
      expect(actual.jobs.map((j: any) => j.id)).toEqual(expected.jobs.map((j: any) => j.id));
    }
  });
});

describe('planAlertMatch eligibility (#9314): one pass, same rows as the two pre-#9314 filters', () => {
  it('keeps the canary and needsRetranslation gates and the eligible candidate count', () => {
    const jobs = fixtureJobs();
    const cache = createJobFeatureCache();
    const owner = { id: 'owner', email: OWNER_EMAIL, locale: 'de', cantonFilter: ['TI'] };
    for (const alert of [...ALERTS, owner]) {
      const plan = planAlertMatch(alert, planContext(jobs, cache));
      const profile = profileOf(alert);
      const locale = nlNormLocale(alert.locale);
      const isOwner = isOwnerEmail(alert.email);
      const eligible = (isOwner ? jobs : jobs.filter((j: any) => j.canary !== true))
        .filter((j: any) => !(j.needsRetranslation === true && locale !== (j.sourceLang || 'it')));
      expect(plan.candidateCount).toBe(eligible.length);
      const scored = new Set(eligible.filter((j) => oracleScore(j, profile, locale) > 0).map((j) => j.id));
      for (const job of plan.matched) {
        expect(scored.has(job.id)).toBe(true);
        expect(job.relevanceScore).toBe(oracleScore(jobs.find((j) => j.id === job.id), profile, locale));
      }
    }
  });
});

describe('live-link prefetch stats (#9314 matching split log)', () => {
  it('reports queued and still-pending URLs, and nothing pending after the drain', async () => {
    const jobs = fixtureJobs(12).filter((j) => j.location);
    const cache = new Map();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prefetcher = createJobLivenessPrefetcher(cache, {
      concurrency: 2,
      check: async () => {
        await gate;
        return true;
      },
    });
    prefetcher.enqueue(jobs, 'it');
    const queued = prefetcher.stats().queued;
    expect(queued).toBeGreaterThan(2);
    expect(prefetcher.stats().pending).toBe(queued);
    release();
    await prefetcher.drain();
    expect(prefetcher.stats()).toEqual({ queued, pending: 0 });
  });
});

describe('bounded live-link shortlist (#9314)', () => {
  const rankingOptions = {
    statsByJob: new Map(),
    variant: 'control',
    surface: 'job_alert',
    surfaceId: 'bounded-live-check',
    campaignId: '2026-09-26',
    randomSeed: 'bounded@example.test',
    config: { enabled: false },
    nowMs: NOW,
  };

  function rankedJobs(count = 30) {
    return Array.from({ length: count }, (_, index) => ({
      id: `bounded-${index}`,
      slug: `bounded-${index}`,
      location: 'Lugano',
      canton: 'TI',
      company: `Company ${index}`,
      relevanceScore: count - index,
    }));
  }

  it('checks only the ranked card shortlist when every page is live', async () => {
    const checked = [];
    const live = await rankLiveJobsForEmail(
      rankedJobs(),
      'it',
      new Map(),
      rankingOptions,
      { limit: 3, check: async (url) => { checked.push(url); return true; } },
    );

    expect(live.map((job) => job.id)).toEqual(['bounded-0', 'bounded-1', 'bounded-2']);
    expect(checked).toHaveLength(3);
  });

  it('re-ranks only when a dead shortlist page needs a replacement', async () => {
    const checked = [];
    const live = await rankLiveJobsForEmail(
      rankedJobs(),
      'it',
      new Map(),
      rankingOptions,
      {
        limit: 3,
        check: async (url) => {
          checked.push(url);
          return !url.endsWith('/bounded-0');
        },
      },
    );

    expect(live.map((job) => job.id)).toEqual(['bounded-1', 'bounded-2', 'bounded-3']);
    expect(checked).toHaveLength(4);
  });

  it('checks the full pool before failing open on an entirely dead shortlist', async () => {
    const checked = [];
    const live = await rankLiveJobsForEmail(
      rankedJobs(100),
      'it',
      new Map(),
      rankingOptions,
      {
        limit: 10,
        check: async (url) => {
          checked.push(url);
          const index = Number(url.match(/bounded-(\d+)$/)?.[1]);
          return index >= 10;
        },
      },
    );

    expect(live.map((job) => job.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `bounded-${index + 10}`),
    );
    expect(checked).toHaveLength(100);
  });

  it('keeps ranked order when the full-pool fail-open guard trips', async () => {
    const matched = rankedJobs(20).reverse();
    const treatmentRankingOptions = {
      ...rankingOptions,
      variant: 'treatment',
      config: { ...JOB_EMAIL_RANKING_DEFAULTS, rollout: 1, epsilon: 0 },
    };
    const expected = rankEmailJobs(matched, { ...treatmentRankingOptions, limit: 10 });
    const checked = [];
    const live = await rankLiveJobsForEmail(
      matched,
      'it',
      new Map(),
      treatmentRankingOptions,
      {
        limit: 10,
        check: async (url) => {
          checked.push(url);
          return false;
        },
      },
    );

    expect(live.map((job) => job.id)).toEqual(expected.map((job) => job.id));
    expect(checked).toHaveLength(20);
  });
});
