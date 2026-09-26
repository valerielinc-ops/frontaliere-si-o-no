import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  activeApplicationIntentJobKeys,
  buildApplicationIntentJobKey,
  compareApplicationIntentJobKeys,
} from '../services/applicationIntentRanking.mjs';
import { createPersonalScorer } from '@/services/personalizationScoring';
import type { BehaviorData } from '@/services/behaviorTracker';
import { buildAlertProfile, scoreJobForAlert } from '../services/jobAlertMatching.mjs';
import { planAlertMatch } from '../scripts/send-job-alerts.mjs';
import { PUBLIC_CONFIG_KEYS } from '../functions/src/publicConfigKeys.js';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const FIREBASE_SOURCE = readFileSync(new URL('../services/firebase.ts', import.meta.url), 'utf8');
const JOB_BOARD_SOURCE = readFileSync(new URL('../components/community/JobBoard.tsx', import.meta.url), 'utf8');

function emptyBehavior(): BehaviorData {
  return {
    version: 1,
    lastVisit: null,
    viewedJobs: [],
    searches: [],
    filterUsage: { category: {}, location: {}, contract: {} },
    syncedAt: null,
  };
}

function intentState(jobKey: string, overrides: Record<string, unknown> = {}) {
  return {
    optedOut: false,
    intents: [{
      jobKey,
      application_status: 'redirect_only',
      timestamp: NOW - 1000,
      retentionUntil: NOW - 1000 + RETENTION_MS,
      ...overrides,
    }],
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    slug: 'software-engineer-lugano',
    companyKey: 'acme',
    title: 'Software Engineer',
    titleByLocale: { it: 'Software Engineer' },
    description: 'Software engineer role with the platform team.',
    company: 'Acme SA',
    location: 'Lugano',
    addressLocality: 'Lugano',
    addressRegion: 'TI',
    canton: 'TI',
    contract: 'full-time',
    sector: 'IT',
    category: 'Software',
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('application-intent ranking — bounded control/treatment', () => {
  it('defaults the Firebase flag off and exposes only a Firebase-Analytics experiment arm', () => {
    expect(FIREBASE_SOURCE).toMatch(/APPLICATION_INTENT_RANKING_ENABLED:\s*'false'/);
    expect(PUBLIC_CONFIG_KEYS).toContain('APPLICATION_INTENT_RANKING_ENABLED');
    const event = JOB_BOARD_SOURCE.match(
      /Analytics\.trackExperimentEvent\('application_intent_ranking_exposure',\s*\{([\s\S]*?)\}\);/,
    );
    expect(event?.[1]).toContain("experiment_id: 'application_intent_ranking'");
    expect(event?.[1]).toContain("variant: enableApplicationIntentRanking ? 'treatment' : 'control'");
    expect(event?.[1]).not.toMatch(/email|userId|uid|jobKey|company|posthog/i);
  });

  it('uses the same stable Italian job key as the apply-intent writer', () => {
    expect(buildApplicationIntentJobKey({
      id: 'localized-id',
      companyKey: 'acme',
      slug: 'software-engineer-en',
      slugByLocale: { it: 'ingegnere-software-lugano' },
    })).toBe('acme:ingegnere-software-lugano');
  });

  it('uses a locale-independent stable key tie-break', () => {
    const a = { companyKey: 'a', slug: 'role' };
    const b = { companyKey: 'b', slug: 'role' };
    expect(compareApplicationIntentJobKeys(a, b)).toBe(-1);
    expect(compareApplicationIntentJobKeys(b, a)).toBe(1);
  });

  it('keeps the personal-score baseline unchanged when the Firebase flag is off', () => {
    const target = job();
    const behavior = emptyBehavior();
    behavior.applicationIntent = intentState('acme:software-engineer-lugano') as BehaviorData['applicationIntent'];

    const baseline = createPersonalScorer(behavior, null)(target as never);
    const control = createPersonalScorer(behavior, null, null, {
      applicationIntentRankingEnabled: false,
      now: NOW,
    })(target as never);
    const treatment = createPersonalScorer(behavior, null, null, {
      applicationIntentRankingEnabled: true,
      now: NOW,
    })(target as never);

    expect(control).toEqual(baseline);
    expect(treatment).toEqual({ score: 8, topSignal: 'application_intent' });
  });

  it.each([
    ['expired', { retentionUntil: NOW - 1 }],
    ['not redirect-only', { application_status: 'application_completed' }],
  ])('gives %s signals zero weight', (_label, override) => {
    const keys = activeApplicationIntentJobKeys(
      intentState('acme:software-engineer-lugano', override),
      NOW,
    );
    expect(keys.size).toBe(0);
  });

  it('gives an opted-out profile zero weight in both ranking consumers', () => {
    const optedOut = { ...intentState('acme:software-engineer-lugano'), optedOut: true };
    expect(activeApplicationIntentJobKeys(optedOut, NOW).size).toBe(0);

    const behavior = emptyBehavior();
    behavior.applicationIntent = optedOut as BehaviorData['applicationIntent'];
    expect(createPersonalScorer(behavior, null, null, {
      applicationIntentRankingEnabled: true,
      now: NOW,
    })(job() as never).score).toBe(0);

    const profile = buildAlertProfile({ keywords: ['engineer'] }, null, {
      applicationIntent: optedOut,
      now: NOW,
    });
    expect(scoreJobForAlert(job(), profile, 'it', null, {
      applicationIntentRankingEnabled: true,
    })).toBe(scoreJobForAlert(job(), profile, 'it'));
  });

  it('adds one explainable exact-job alert boost, stronger than the ordinary click-location boost', () => {
    const target = job();
    const profile = buildAlertProfile({ keywords: ['engineer'] }, null, {
      applicationIntent: intentState('acme:software-engineer-lugano'),
      now: NOW,
      behaviorLocations: ['Lugano'], // ordinary clicked-job geography contributes +2
    });
    const control = scoreJobForAlert(target, profile, 'it');
    const treatment = scoreJobForAlert(target, profile, 'it', null, {
      applicationIntentRankingEnabled: true,
    });

    expect(treatment - control).toBe(6);
    expect(treatment - control).toBeGreaterThan(2);
  });

  it('never lets application intent bypass an explicit hard keyword filter', () => {
    const target = job();
    const profile = buildAlertProfile({ keywords: ['nurse'] }, null, {
      applicationIntent: intentState('acme:software-engineer-lugano'),
      now: NOW,
    });
    expect(scoreJobForAlert(target, profile, 'it', null, {
      applicationIntentRankingEnabled: true,
    })).toBe(0);
  });

  it('keeps sender control order and lifts the exact intent job only in treatment', () => {
    const baseline = job({
      id: 'baseline-id', slug: 'baseline', companyKey: 'other', company: 'Other SA',
    });
    const intent = job({ id: 'intent-id', slug: 'software-engineer-lugano' });
    const alert = {
      id: 'alert-1',
      email: 'person@example.ch',
      locale: 'it',
      keywords: ['engineer'],
      locations: [],
      cantonFilter: [],
      sectors: [],
      contractTypes: [],
      sentJobIds: [],
    };
    const context = (enabled: boolean, recentJobs: object[]) => ({
      behaviorProfiles: new Map([['person@example.ch', {
        behaviorLocations: [],
        behaviorTokens: [],
        filterLocations: [],
        applicationIntent: intentState('acme:software-engineer-lugano'),
      }]]),
      lastClickedUrlByEmail: new Map(),
      locationIndex: new Map(),
      cityToCanton: {},
      subscriberProfiles: new Map(),
      recentJobs,
      now: NOW,
      applicationIntentRankingEnabled: enabled,
    });

    const control = planAlertMatch(alert, context(false, [baseline, intent]));
    const treatment = planAlertMatch(alert, context(true, [baseline, intent]));

    expect(control.matched.map((item) => item.id)).toEqual(['baseline-id', 'intent-id']);
    expect(treatment.matched.map((item) => item.id)).toEqual(['intent-id', 'baseline-id']);
    expect(treatment.matched[0].relevanceSignals).toEqual(['application_intent']);
    expect(treatment.matched[0].applicationIntentBoost).toBe(6);

    const tiedA = job({ id: 'tie-a', slug: 'role', companyKey: 'a', company: 'A SA' });
    const tiedB = job({ id: 'tie-b', slug: 'role', companyKey: 'b', company: 'B SA' });
    const tieForward = planAlertMatch(alert, context(true, [tiedB, tiedA]));
    const tieReverse = planAlertMatch(alert, context(true, [tiedA, tiedB]));
    expect(tieForward.matched.map((item) => item.id)).toEqual(['tie-a', 'tie-b']);
    expect(tieReverse.matched.map((item) => item.id)).toEqual(['tie-a', 'tie-b']);
  });
});
