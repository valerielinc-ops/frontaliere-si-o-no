// @ts-nocheck
/**
 * Owner decision 2026-10-04 (issue 9060): the job-alert monitor measures the
 * HEALTH of the matcher on the active inventory, not the yield of a run.
 *
 * The old trigger was the share of real alerts with zero matches in their
 * recipient window ("available since my last email"): it fired in quiet
 * periods and on the second run of a day, and it could not see a matcher
 * broken on one path only. These tests pin the new contract with the REAL
 * matcher (`planAlertMatch`):
 *
 *   - healthy matcher + an inventory with nothing new for the recipient →
 *     yield zero, monitor resolves (no alarm);
 *   - broken matcher (a criterion that no longer matches, or one canton's geo
 *     path broken) → monitor reports;
 *   - every synthetic alert derived from the inventory matches ≥1 job.
 */
import { describe, expect, it } from 'vitest';
import {
  MATCHER_HEALTH_PROBE_EMAIL,
  MATCHER_HEALTH_PROBE_KINDS,
  buildMatcherHealthProbes,
  evaluateMatcherHealth,
  getMatcherHealthMonitorAction,
  titleProfessionToken,
} from '../scripts/lib/job-alert-matcher-health.mjs';
import { selectJobAlertCandidates } from '../scripts/lib/job-alert-newness.mjs';
import { planAlertMatch, runJobAlertMatcherHealth } from '../scripts/send-job-alerts.mjs';

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

function job(id: string, fields: Record<string, unknown>) {
  return {
    id,
    slug: id,
    company: `Company ${id}`,
    description: 'Descrizione del posto di lavoro.',
    crawledAt: hoursAgo(6),
    firstSeenAt: hoursAgo(72),
    ...fields,
  };
}

const INVENTORY = [
  job('ti-health-1', { title: 'Infermiere diplomato 80-100%', category: 'Sanità', canton: 'TI', location: 'Lugano' }),
  job('ti-health-2', { title: 'Infermiera di cure intense', category: 'Sanità', canton: 'TI', location: 'Bellinzona' }),
  job('ti-finance-1', { title: 'Contabile senior', category: 'Finanza', canton: 'TI', location: 'Mendrisio' }),
  job('ti-none-1', { title: 'Magazziniere carrellista', canton: 'TI', location: 'Chiasso' }),
  job('zh-tech-1', { title: 'Senior Software Engineer (Java)', category: 'Technology', canton: 'ZH', location: 'Zürich' }),
  job('be-eng-1', { title: 'Elektriker EFZ Servicemonteur', sector: 'Engineering', canton: 'BE', location: 'Bern' }),
  // Never a probe seed: owner-only canary, pending retranslation, no canton,
  // closed listing.
  job('ge-canary', { title: 'Canary listing do not send', category: 'Other', canton: 'GE', canary: true }),
  job('vd-retranslate', { title: 'Comptable fiduciaire', category: 'Finance', canton: 'VD', needsRetranslation: true, sourceLang: 'fr' }),
  job('nocanton', { title: 'Consulente commerciale', category: 'Sales' }),
  job('ti-closed', { title: 'Cuoco di linea stagionale', category: 'Ristorazione', canton: 'TI', status: 'expired' }),
];
// What main() hands the probe builder: the open listings only.
const ACTIVE = INVENTORY.filter((j) => j.status !== 'expired');

describe('titleProfessionToken', () => {
  it('takes the longest letter-only word of the title, lowercased', () => {
    expect(titleProfessionToken('Infermiere diplomato 80-100%')).toBe('infermiere');
    expect(titleProfessionToken('Elektriker EFZ Servicemonteur')).toBe('servicemonteur');
  });

  it('returns an empty token when no word is long enough', () => {
    expect(titleProfessionToken('IT / HR 100%')).toBe('');
    expect(titleProfessionToken(undefined)).toBe('');
  });
});

describe('buildMatcherHealthProbes', () => {
  it('derives one title-keyword probe per canton×profession group, plus a category probe when the seed has one', () => {
    const { probes, groupCount, sampledGroupCount } = buildMatcherHealthProbes(ACTIVE);
    const titleProbes = probes.filter((p) => p.kind === MATCHER_HEALTH_PROBE_KINDS.TITLE_KEYWORD);
    const categoryProbes = probes.filter((p) => p.kind === MATCHER_HEALTH_PROBE_KINDS.CATEGORY);

    const groups = new Set(titleProbes.map((p) => `${p.canton}/${p.profession}`));
    expect(groups).toEqual(new Set(['be/engineering', 'ti/', 'ti/finanza', 'ti/sanita', 'zh/technology']));
    expect(groupCount).toBe(groups.size);
    expect(sampledGroupCount).toBe(groupCount);
    // The uncategorized TI group has no category probe; every other group has one.
    expect(categoryProbes.map((p) => `${p.canton}/${p.profession}`).sort())
      .toEqual([...groups].filter((g) => g !== 'ti/').sort());

    for (const probe of probes) {
      expect(probe.alert.email).toBe(MATCHER_HEALTH_PROBE_EMAIL);
      expect(probe.alert.cantonFilter).toEqual([probe.canton]);
      expect(probe.alert.keywords).toEqual([probe.keyword]);
    }
  });

  it('never seeds a probe from a canary, a listing pending retranslation or a listing without canton', () => {
    const { probes } = buildMatcherHealthProbes(ACTIVE);
    const seeds = new Set(probes.map((p) => p.sourceJobId));
    expect(seeds.has('ge-canary')).toBe(false);
    expect(seeds.has('vd-retranslate')).toBe(false);
    expect(seeds.has('nocanton')).toBe(false);
  });

  it('picks the same seed on a rerun, whatever the inventory order', () => {
    const forward = buildMatcherHealthProbes(ACTIVE).probes.map((p) => p.alert.id + p.sourceJobId);
    const reversed = buildMatcherHealthProbes([...ACTIVE].reverse()).probes.map((p) => p.alert.id + p.sourceJobId);
    expect(reversed.sort()).toEqual(forward.sort());
  });

  it('samples round-robin across cantons when the cap is below the group count', () => {
    const cantons = new Set(buildMatcherHealthProbes(ACTIVE).probes.map((p) => p.canton));
    const capped = buildMatcherHealthProbes(ACTIVE, { maxProbes: cantons.size });
    expect(capped.probes).toHaveLength(cantons.size);
    expect(new Set(capped.probes.map((p) => p.canton))).toEqual(cantons);
    expect(capped.sampledGroupCount).toBeLessThan(capped.groupCount);
  });
});

describe('runJobAlertMatcherHealth (real matcher, active inventory)', () => {
  it('every synthetic alert derived from the inventory matches at least one job', () => {
    const health = runJobAlertMatcherHealth(INVENTORY, { now: NOW });
    expect(health.probeCount).toBeGreaterThan(0);
    expect(health.failures).toEqual([]);
    expect(health.passedCount).toBe(health.probeCount);
    // The closed listing is not part of the active inventory.
    expect(health.activeInventoryCount).toBe(ACTIVE.length);
  });

  it('healthy matcher + nothing new since the last send → zero yield, but no alarm', () => {
    // A real subscriber alert that WOULD match the inventory, whose recipient
    // was emailed after the last crawl: the yield window is empty.
    const alert = { id: 'real', email: 'subscriber@example.test', locale: 'it', keywords: ['infermiere'], cantonFilter: ['ti'] };
    const window = selectJobAlertCandidates(INVENTORY, { recipientLastSentAt: hoursAgo(1), nowMs: NOW });
    expect(window.jobs).toEqual([]);
    const context = {
      behaviorProfiles: new Map(),
      lastClickedUrlByEmail: new Map(),
      locationIndex: new Map(),
      cityToCanton: new Map(),
      subscriberProfiles: new Map(),
      recentJobs: window.jobs,
      now: NOW,
    };
    expect(planAlertMatch(alert, context).rankedCount).toBe(0);

    const health = runJobAlertMatcherHealth(INVENTORY, { now: NOW });
    expect(getMatcherHealthMonitorAction({
      probeCount: health.probeCount,
      failureCount: health.failureCount,
    })).toBe('resolve');
  });

  it('a criterion that no longer matches (broken keyword path) → alarm', () => {
    const broken = (alert, context) => planAlertMatch(
      // Reversed, not suffixed: a suffixed word could still fuzzy-match the
      // profession taxonomy and bring the original aliases back.
      { ...alert, keywords: alert.keywords.map((k) => [...k].reverse().join('')) },
      context,
    );
    const health = runJobAlertMatcherHealth(INVENTORY, { now: NOW, planMatch: broken });
    expect(health.failureCount).toBe(health.probeCount);
    expect(getMatcherHealthMonitorAction({
      probeCount: health.probeCount,
      failureCount: health.failureCount,
    })).toBe('report');
  });

  it('a matcher broken for one canton only → alarm naming that canton', () => {
    const brokenTicino = (alert, context) => planAlertMatch(
      { ...alert, cantonFilter: alert.cantonFilter.map((c) => (c === 'ti' ? 'ticino' : c)) },
      context,
    );
    const health = runJobAlertMatcherHealth(INVENTORY, { now: NOW, planMatch: brokenTicino });
    expect(health.failureCount).toBeGreaterThan(0);
    expect(health.passedCount).toBeGreaterThan(0);
    expect(new Set(health.failures.map((f) => f.canton))).toEqual(new Set(['ti']));
    expect(getMatcherHealthMonitorAction({
      probeCount: health.probeCount,
      failureCount: health.failureCount,
    })).toBe('report');
  });
});

describe('runJobAlertMatcherHealth never aborts the send', () => {
  it('a matcher that throws yields an error and zero probes, so the monitor skips', () => {
    const throwing = () => { throw new TypeError('description.toLowerCase is not a function'); };
    let health;
    expect(() => {
      health = runJobAlertMatcherHealth(INVENTORY, { now: NOW, planMatch: throwing });
    }).not.toThrow();
    expect(health.error).toContain('toLowerCase');
    expect(health.probeCount).toBe(0);
    expect(Number.isFinite(health.durationMs)).toBe(true);
    expect(getMatcherHealthMonitorAction({
      probeCount: health.probeCount,
      failureCount: health.failureCount,
    })).toBe('skip');
  });

  it('a healthy run reports no error and a measured duration', () => {
    const health = runJobAlertMatcherHealth(INVENTORY, { now: NOW });
    expect(health.error).toBeNull();
    expect(health.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('a canton stored with trailing spaces does not fail a healthy matcher', () => {
    const padded = [job('ti-padded', { title: 'Fisioterapista diplomato', category: 'Sanità', canton: 'TI ', location: 'Locarno' })];
    const health = runJobAlertMatcherHealth(padded, { now: NOW });
    expect(health.probeCount).toBeGreaterThan(0);
    expect(health.failures).toEqual([]);
  });
});

describe('evaluateMatcherHealth', () => {
  it('counts a probe as failed only when the matcher ranks nothing', () => {
    const { probes } = buildMatcherHealthProbes(ACTIVE);
    const failing = probes[0].alert.id;
    const result = evaluateMatcherHealth(probes, (alert) => (
      alert.id === failing
        ? { rankedCount: 0, candidateCount: 9, zeroCause: 'keyword-and-geo-narrow' }
        : { rankedCount: 1, candidateCount: 9 }
    ));
    expect(result.failureCount).toBe(1);
    expect(result.passedCount).toBe(probes.length - 1);
    expect(result.failures[0]).toMatchObject({
      canton: probes[0].canton,
      keyword: probes[0].keyword,
      candidateCount: 9,
      zeroCause: 'keyword-and-geo-narrow',
    });
  });
});

describe('getMatcherHealthMonitorAction', () => {
  it('reports on the first failing probe and resolves when all pass', () => {
    expect(getMatcherHealthMonitorAction({ probeCount: 40, failureCount: 1 })).toBe('report');
    expect(getMatcherHealthMonitorAction({ probeCount: 40, failureCount: 0 })).toBe('resolve');
  });

  it('does not touch the issue from dry-run or targeted operator sends', () => {
    expect(getMatcherHealthMonitorAction({ probeCount: 40, failureCount: 0, dryRun: true })).toBe('skip');
    expect(getMatcherHealthMonitorAction({ probeCount: 40, failureCount: 3, targeted: true })).toBe('skip');
  });

  it('does not infer recovery from an empty or invalid probe set', () => {
    expect(getMatcherHealthMonitorAction({ probeCount: 0, failureCount: 0 })).toBe('skip');
    expect(getMatcherHealthMonitorAction({ probeCount: 40, failureCount: -1 })).toBe('skip');
    expect(getMatcherHealthMonitorAction({ probeCount: Number.NaN, failureCount: 0 })).toBe('skip');
  });
});
