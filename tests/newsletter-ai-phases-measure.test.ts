// Pre/post measurement of the newsletter AI phases on the same input (700
// cohorts, 4 locales) against a simulated serialized Codex broker — see
// scripts/measure-newsletter-ai-phases.mjs for the model and its sources.
import { describe, expect, it } from 'vitest';

import { measureNewsletterAiLanes, measureNewsletterAiPhases } from '@/scripts/measure-newsletter-ai-phases.mjs';

const JOB_TIMEOUT_MINUTES = 360; // send-newsletter.yml timeout-minutes
const results = await measureNewsletterAiPhases({ cohortCount: 700 });
const byId = Object.fromEntries(results.map((r: any) => [r.scenario, r]));

describe('newsletter AI phases — 700 cohorts, 4 locales, one Codex request at a time', () => {
  it.each(results.map((r: any) => [r.scenario, r]))('%s: POST stays within the call and time budget', (_id, r: any) => {
    expect(r.post.phase2Calls - r.post.phase2Retries).toBeLessThanOrEqual(4);
    expect(r.post.phase2Retries).toBeLessThanOrEqual(4);
    expect(r.post.phase3Calls).toBeLessThanOrEqual(4); // one call per locale for both subjects
    expect(r.post.phase2Minutes).toBeLessThanOrEqual(r.budgetMinutes);
    expect(r.post.phase3Minutes).toBeLessThanOrEqual(r.budgetMinutes);
    expect(r.post.subjects).toBe(8);
  });

  it('PRE needed one call per 3 cohorts and outlived the job timeout at the measured pace', () => {
    const r = byId['measured-116s'];
    expect(r.pre.phase2Calls).toBe(236);
    expect(r.pre.phase2Minutes).toBeGreaterThan(JOB_TIMEOUT_MINUTES);
  });

  it('POST writes every locale with one call each at the measured pace', () => {
    const r = byId['measured-116s'];
    expect(r.post.phase2Calls).toBe(4);
    expect(r.post.localesOnAi).toBe(4);
    expect(r.post.cohortsOnFallback).toBe(0);
  });

  it('POST retries a too-short answer once per locale and still covers every locale', () => {
    const r = byId['measured-116s-every-first-answer-too-short'];
    expect(r.post.phase2Retries).toBe(4);
    expect(r.post.localesOnAi).toBe(4);
  });

  it('at the Codex ceiling the deadlines close both phases at 30 minutes and every cohort still has a briefing', () => {
    const r = byId['codex-ceiling-600s-every-first-answer-too-short'];
    expect(r.post.phase2Minutes).toBe(30);
    expect(r.post.phase3Minutes).toBe(30);
    expect(r.post.phase2DroppedAtDeadline).toBeGreaterThan(0);
    expect(r.post.cohortsOnFallback).toBe(700);
  });
});

// Phases 2 and 3 together against broker lanes (codex-auth-broker.mjs
// --max-concurrency), service times of run 36385271711: less wall time, the
// same calls and prompt characters, the same subjects; no gain on one lane.
describe('newsletter AI phases together — broker lanes', () => {
  it.each([1, 3])('%i lane(s): same calls, prompts and subjects as one phase after the other', async (lanes) => {
    for (const r of await measureNewsletterAiLanes({ lanes })) {
      expect(r.together.calls).toBe(r.sequential.calls);
      expect(r.together.promptChars).toBe(r.sequential.promptChars);
      expect(r.together.subjects).toEqual(r.sequential.subjects);
      expect(r.together.seconds).toBeLessThanOrEqual(r.sequential.seconds);
    }
  });

  it('3 lanes: 119 s one after the other, 102 s together', async () => {
    for (const r of await measureNewsletterAiLanes({ lanes: 3 })) {
      expect(r.sequential.seconds).toBe(119);
      expect(r.together.seconds).toBe(102);
      expect(r.sequential.calls).toBe(12);
    }
  });
});
