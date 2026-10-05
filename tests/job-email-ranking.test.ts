import { describe, expect, it } from 'vitest';
import {
  JOB_EMAIL_AFFINITY_ASSIGNMENT_SEED,
  JOB_EMAIL_RANKING_DEFAULTS,
  affinityReorders,
  assignJobRankingVariant,
  buildEmbeddedRankingUpdate,
  hashUnitInterval,
  jobRankingAttributes,
  pseudonymousUserId,
  rankEmailJobs,
  rankingStatsKey,
  readJobEmailRankingConfig,
} from '../functions/src/lib/jobEmailRanking.js';
import {
  affinityRankingContext,
  applyAffinityClick,
  createAffinityScorer,
  emptyAffinityProfile,
  scoreJobAffinity,
} from '../functions/src/lib/jobEmailAffinity.js';
import { appendJobRankingParams, parseJobRankingClick } from '../functions/src/lib/jobEmailRankingLinks.js';

const CONFIG = { enabled: true, rollout: 1, affinityWeight: 0.5 };
const DAY = 24 * 60 * 60 * 1000;
// Relative to now: the profile expires 180 days after its last click.
const NOW = new Date(Date.now());
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

/** A valid profile (two clicks) on one category, canton and company. */
function profileFor(attrs: { category?: string; canton?: string; company_key?: string; sector?: string }) {
  let profile: any = emptyAffinityProfile('pid');
  profile = applyAffinityClick(profile, attrs, daysAgo(3));
  profile = applyAffinityClick(profile, attrs, daysAgo(2));
  return profile;
}

// Matcher order: decreasing relevance, the clicked kind of listing last.
const POOL = [
  { slug: 'edilizia-zh', company: 'Beta AG', companyKey: 'beta-ag', category: 'Edilizia', canton: 'ZH', sector: 'construction', relevanceScore: 10 },
  { slug: 'vendita-ge', company: 'Gamma SA', companyKey: 'gamma-sa', category: 'Vendita', canton: 'GE', sector: 'retail', relevanceScore: 9.5 },
  { slug: 'logistica-be', company: 'Delta AG', companyKey: 'delta-ag', category: 'Logistica', canton: 'BE', sector: 'logistics', relevanceScore: 9 },
  { slug: 'informatica-ti', company: 'Acme SA', companyKey: 'acme-sa', category: 'Informatica', canton: 'TI', sector: 'tech', relevanceScore: 8 },
];
const CLICKED = { category: 'Informatica', canton: 'TI', company_key: 'acme-sa', sector: 'tech' };

describe('job email ranking — assignment', () => {
  const emails = Array.from({ length: 2000 }, (_, index) => `persona${index}@example.com`);

  it('is stable per person: same variant on every surface, every day, any casing', () => {
    for (const email of emails.slice(0, 200)) {
      const reference = assignJobRankingVariant({ subjectId: email, config: { ...CONFIG, rollout: 0.5 } });
      // Old call shapes passed surface and campaign: they no longer matter.
      for (const extra of [
        { surface: 'job_alert', campaignId: '2026-10-05' },
        { surface: 'job_alert', campaignId: '2026-10-06' },
        { surface: 'newsletter', campaignId: 'weekly_2026-10-05' },
      ]) {
        expect(assignJobRankingVariant({ subjectId: ` ${email.toUpperCase()} `, config: { ...CONFIG, rollout: 0.5 }, ...extra } as any))
          .toBe(reference);
      }
    }
  });

  it('uses the documented seed: affinity exactly when the bucket is below the rollout', () => {
    for (const email of emails.slice(0, 200)) {
      const bucket = hashUnitInterval(`${JOB_EMAIL_AFFINITY_ASSIGNMENT_SEED}:${email}`);
      expect(assignJobRankingVariant({ subjectId: email, config: { ...CONFIG, rollout: 0.5 } }))
        .toBe(bucket < 0.5 ? 'affinity' : 'control');
    }
  });

  it('puts a share close to the rollout in affinity and never emits treatment', () => {
    for (const rollout of [0.15, 0.5, 1]) {
      const variants = emails.map((email) => assignJobRankingVariant({ subjectId: email, config: { ...CONFIG, rollout } }));
      expect(new Set(variants).has('treatment')).toBe(false);
      expect([...new Set(variants)].every((variant) => variant === 'affinity' || variant === 'control')).toBe(true);
      const share = variants.filter((variant) => variant === 'affinity').length / variants.length;
      expect(Math.abs(share - rollout)).toBeLessThan(0.04);
    }
  });

  it('defaults to half of the people in affinity', () => {
    expect(JOB_EMAIL_RANKING_DEFAULTS.rollout).toBe(0.5);
    expect(JOB_EMAIL_RANKING_DEFAULTS.affinityWeight).toBe(0.5);
    const share = emails.filter((email) => assignJobRankingVariant({ subjectId: email }) === 'affinity').length / emails.length;
    expect(Math.abs(share - 0.5)).toBeLessThan(0.04);
  });

  it('the kill switch, a zero rollout and a missing address put everybody in control', () => {
    for (const email of emails.slice(0, 200)) {
      expect(assignJobRankingVariant({ subjectId: email, config: { ...CONFIG, enabled: false } })).toBe('control');
      expect(assignJobRankingVariant({ subjectId: email, config: { ...CONFIG, rollout: 0 } })).toBe('control');
    }
    expect(assignJobRankingVariant({ subjectId: '', config: CONFIG })).toBe('control');
  });
});

describe('job email ranking — order', () => {
  it('control preserves the matcher order and applies the limit', () => {
    const control = rankEmailJobs(POOL, { variant: 'control', limit: 2, config: CONFIG });
    expect(control.map((job) => job.slug)).toEqual(['edilizia-zh', 'vendita-ge']);
    expect(control.every((job) => job.ranking.variant === 'control')).toBe(true);
    expect(control.map((job) => job.ranking.position)).toEqual([1, 2]);
  });

  it('mixes companies inside equal control ranks without overtaking a higher rank', () => {
    const ranked = rankEmailJobs([
      { slug: 'best-vf', company: 'VF', relevanceScore: 11 },
      { slug: 'vf-tied-1', company: 'VF', relevanceScore: 10 },
      { slug: 'guess-tied', company: 'Guess', relevanceScore: 10 },
      { slug: 'reboot-tied', company: 'Reboot', relevanceScore: 10 },
      { slug: 'vf-tied-2', company: 'VF', relevanceScore: 10 },
    ], { variant: 'control', limit: 5, config: CONFIG });

    expect(ranked.map((job) => job.slug)).toEqual([
      'best-vf',
      'vf-tied-1',
      'guess-tied',
      'reboot-tied',
      'vf-tied-2',
    ]);
  });

  it('with a profile, the listing of the clicked category, canton and company rises', () => {
    const { affinityProfile, affinityScorer } = affinityRankingContext(profileFor(CLICKED), NOW);
    expect(affinityProfile).toBe(true);
    const ranked = rankEmailJobs(POOL, { variant: 'affinity', affinityScorer, limit: 4, config: CONFIG });
    expect(ranked[0].slug).toBe('informatica-ti');
    expect(ranked[0].ranking).toMatchObject({ variant: 'affinity', position: 1, relevanceScore: 8 });
    expect(ranked[0].ranking.affinityScore).toBeCloseTo(1, 6);
    // relevance * (1 - w + w * affinity)
    expect(ranked[0].ranking.rankingScore).toBeCloseTo(8, 6);
    expect(ranked[1].ranking.rankingScore).toBeCloseTo(10 * 0.5, 6);
    // The rest keeps the matcher order (no affinity: same factor for all).
    expect(ranked.slice(1).map((job) => job.slug)).toEqual(['edilizia-zh', 'vendita-ge', 'logistica-be']);
  });

  it('each dimension alone moves a listing up: category, canton, company', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ category: 'Logistica' }, 'logistica-be'],
      [{ canton: 'GE' }, 'vendita-ge'],
      [{ company_key: 'delta-ag' }, 'logistica-be'],
    ];
    for (const [attrs, expected] of cases) {
      const { affinityScorer } = affinityRankingContext(profileFor(attrs), NOW);
      const ranked = rankEmailJobs(POOL, { variant: 'affinity', affinityScorer, limit: 4, config: CONFIG });
      const control = rankEmailJobs(POOL, { variant: 'control', limit: 4, config: CONFIG });
      const position = (list: any[]) => list.findIndex((job) => job.slug === expected);
      expect(position(ranked)).toBeLessThan(position(control));
    }
  });

  it('scores the same attributes the delivery manifest records', () => {
    const profile = profileFor(CLICKED);
    const job = POOL[3];
    const { affinityScorer } = affinityRankingContext(profile, NOW);
    const [ranked] = rankEmailJobs([job], { variant: 'affinity', affinityScorer, config: CONFIG });
    expect(ranked.ranking.affinityScore).toBeCloseTo(scoreJobAffinity(profile, jobRankingAttributes(job), NOW), 10);
    // A newsletter card keeps its own sector in rawSector.
    expect(jobRankingAttributes({ sector: 'Informatica', rawSector: 'tech' }).sector).toBe('tech');
  });

  it('without a valid profile, or with opposition, affinity orders exactly like control', () => {
    const control = rankEmailJobs(POOL, { variant: 'control', limit: 3, config: CONFIG });
    const oneClick = applyAffinityClick(emptyAffinityProfile('pid'), CLICKED, daysAgo(1));
    const expired = profileFor(CLICKED);
    const later = new Date(NOW.getTime() + 200 * DAY);
    for (const [profile, at] of [[null, NOW], [oneClick, NOW], [expired, later]] as const) {
      const context = affinityRankingContext(profile, at);
      expect(context).toEqual({ affinityProfile: false, affinityScorer: null });
      const ranked = rankEmailJobs(POOL, { variant: 'affinity', affinityScorer: context.affinityScorer, limit: 3, config: CONFIG });
      expect(ranked.map((job) => job.slug)).toEqual(control.map((job) => job.slug));
      expect(ranked.every((job) => job.ranking.affinityScore === null)).toBe(true);
    }
  });

  it('weight 0 and the kill switch are the control order', () => {
    const { affinityScorer } = affinityRankingContext(profileFor(CLICKED), NOW);
    const control = rankEmailJobs(POOL, { variant: 'control', limit: 4, config: CONFIG });
    for (const config of [{ ...CONFIG, affinityWeight: 0 }, { ...CONFIG, enabled: false }]) {
      const ranked = rankEmailJobs(POOL, { variant: 'affinity', affinityScorer, limit: 4, config });
      expect(ranked.map((job) => job.slug)).toEqual(control.map((job) => job.slug));
      expect(ranked.map((job) => job.ranking.rankingScore)).toEqual(control.map((job) => job.ranking.rankingScore));
    }
  });

  it('control records the affinity score of the jobs it returns, without using it', () => {
    const { affinityScorer } = affinityRankingContext(profileFor(CLICKED), NOW);
    const ranked = rankEmailJobs(POOL, { variant: 'control', affinityScorer, limit: 4, config: CONFIG });
    expect(ranked.map((job) => job.slug)).toEqual(POOL.map((job) => job.slug));
    expect(ranked[3].ranking.affinityScore).toBeCloseTo(1, 6);
    expect(ranked[0].ranking.affinityScore).toBe(0);
    expect(ranked.every((job) => job.ranking.rankingScore === job.ranking.relevanceScore)).toBe(true);
  });

  it('keeps company diversity on equal affinity scores, before the limit', () => {
    const { affinityScorer } = affinityRankingContext(profileFor({ canton: 'TI' }), NOW);
    const ranked = rankEmailJobs([
      { slug: 'vf-1', company: 'VF', canton: 'TI', relevanceScore: 10 },
      { slug: 'vf-2', company: 'VF', canton: 'TI', relevanceScore: 10 },
      { slug: 'guess', company: 'Guess', canton: 'TI', relevanceScore: 10 },
      { slug: 'reboot', company: 'Reboot', canton: 'TI', relevanceScore: 10 },
    ], { variant: 'affinity', affinityScorer, limit: 3, config: CONFIG });
    expect(ranked.map((job) => job.company)).toEqual(['VF', 'Guess', 'Reboot']);
  });

  it('never adds or drops a job: the affinity output is a reordering of the pool', () => {
    const { affinityScorer } = affinityRankingContext(profileFor(CLICKED), NOW);
    const ranked = rankEmailJobs(POOL, { variant: 'affinity', affinityScorer, config: CONFIG });
    expect(ranked.map((job) => job.slug).sort()).toEqual(POOL.map((job) => job.slug).sort());
    expect(ranked.every((job) => !('ctrShrink' in job.ranking) && !('randomBoost' in job.ranking))).toBe(true);
  });

  it('the precomputed scorer gives the same score as scoreJobAffinity', () => {
    const profile = applyAffinityClick(profileFor(CLICKED), { category: 'Edilizia', canton: 'ZH' }, daysAgo(1));
    const scorer = createAffinityScorer(profile, NOW)!;
    for (const job of POOL) {
      const attrs = jobRankingAttributes(job);
      expect(scorer(attrs)).toBeCloseTo(scoreJobAffinity(profile, attrs, NOW), 12);
    }
    expect(createAffinityScorer(null, NOW)).toBeNull();
  });
});

describe('job email ranking — when affinity reorders', () => {
  it('only for the affinity variant, enabled, with a scorer and a positive weight', () => {
    const scorer = () => 1;
    const config = { ...JOB_EMAIL_RANKING_DEFAULTS, enabled: true, affinityWeight: 0.5 };
    expect(affinityReorders({ variant: 'affinity', affinityScorer: scorer, config })).toBe(true);
    expect(affinityReorders({ variant: 'control', affinityScorer: scorer, config })).toBe(false);
    expect(affinityReorders({ variant: 'treatment', affinityScorer: scorer, config })).toBe(false);
    expect(affinityReorders({ variant: 'affinity', affinityScorer: null, config })).toBe(false);
    expect(affinityReorders({ variant: 'affinity', affinityScorer: scorer, config: { ...config, affinityWeight: 0 } })).toBe(false);
    expect(affinityReorders({ variant: 'affinity', affinityScorer: scorer, config: { ...config, enabled: false } })).toBe(false);
  });
});

describe('job email ranking — configuration', () => {
  it('reads the three parameters from the environment', () => {
    expect(readJobEmailRankingConfig({
      JOB_EMAIL_RANKING_ENABLED: 'true',
      JOB_EMAIL_RANKING_ROLLOUT: '0.3',
      JOB_EMAIL_RANKING_AFFINITY_WEIGHT: '0.8',
    })).toEqual({ enabled: true, rollout: 0.3, affinityWeight: 0.8 });
  });

  it('falls back to the code defaults when absent or malformed, and clamps to [0, 1]', () => {
    expect(readJobEmailRankingConfig({})).toEqual({ enabled: true, rollout: 0.5, affinityWeight: 0.5 });
    expect(readJobEmailRankingConfig({
      JOB_EMAIL_RANKING_ENABLED: 'off',
      JOB_EMAIL_RANKING_ROLLOUT: 'not-a-number',
      JOB_EMAIL_RANKING_AFFINITY_WEIGHT: '4',
    })).toEqual({ enabled: false, rollout: 0.5, affinityWeight: 1 });
    expect(readJobEmailRankingConfig({ JOB_EMAIL_RANKING_AFFINITY_WEIGHT: '-1' }).affinityWeight).toBe(0);
    expect(readJobEmailRankingConfig({ JOB_EMAIL_RANKING_AFFINITY_WEIGHT: '' }).affinityWeight).toBe(0.5);
  });

  it('no longer exposes the CTR tuning knobs', () => {
    const config = readJobEmailRankingConfig({ JOB_EMAIL_RANKING_ALPHA: '1', JOB_EMAIL_RANKING_EPSILON: '0.2' });
    expect(Object.keys(config).sort()).toEqual(['affinityWeight', 'enabled', 'rollout']);
  });
});

describe('job email ranking — links and stored data', () => {
  it('parses tracked clicks without exposing recipient identity', () => {
    const url = appendJobRankingParams('/cerca-lavoro-ticino/job-one/?utm_source=newsletter', {
      jobId: 'job-one',
      surface: 'newsletter',
      surfaceId: 'newsletter_weekly',
      deliveryId: 'jer_newsletter_123',
      position: 2,
      variant: 'affinity',
      newsletterId: 'weekly_2026-09-07',
      rankingScore: 0.82,
      relevanceScore: 8,
    });
    const click = parseJobRankingClick(url);
    expect(click).toMatchObject({
      jobId: 'job-one',
      surface: 'newsletter',
      surfaceId: 'newsletter_weekly',
      deliveryId: 'jer_newsletter_123',
      position: 2,
      variant: 'affinity',
      ctrShrink: null,
      randomBoost: null,
    });
    expect(url).not.toContain('person@example.com');
    expect(parseJobRankingClick('https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/')).toBeNull();
  });

  it('still parses the CTR fields of links sent during the old experiment', () => {
    const url = appendJobRankingParams('/cerca-lavoro-ticino/job-one/', {
      jobId: 'job-one',
      surface: 'job_alert',
      surfaceId: 'alert-1',
      deliveryId: 'jer_job_alert_1',
      position: 1,
      variant: 'treatment',
      ctrShrink: 0.12,
      randomBoost: 0.4,
    });
    expect(parseJobRankingClick(url)).toMatchObject({ variant: 'treatment', ctrShrink: 0.12, randomBoost: 0.4 });
  });

  it('uses a pseudonymous user id and safe nested Firestore paths', () => {
    const userId = pseudonymousUserId('Person@Example.com', 'ranking-secret');
    expect(userId).toHaveLength(32);
    expect(userId).not.toContain('@');
    const FieldValue = { increment: (amount: number) => ({ increment: amount }) };
    const update = buildEmbeddedRankingUpdate({
      jobId: 'job.with.dots',
      day: '2026-09-08',
      position: 3,
      variant: 'affinity',
      FieldValue,
    });
    expect(Object.keys(update).some((key) => key.includes('job.with.dots'))).toBe(false);
    expect(update).toMatchObject({
      [`ranking_stats.${rankingStatsKey('job.with.dots')}.days.2026-09-08.impressions`]: { increment: 1 },
    });
  });
});
