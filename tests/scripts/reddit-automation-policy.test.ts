// @vitest-environment node
/**
 * Reddit automation targeting policy (issue #5008).
 *
 * WHAT THIS PROTECTS. Automated Reddit submission used to be gated by exactly
 * one thing: the boolean `subreddits[<name>].allowsAutomation` in
 * `data/reddit-subreddits.json`. Flipping one character in that file — in a
 * commit that reads as data, not as code — pointed the daily cron at
 * r/Ticino, r/italiansinswitzerland and r/Svizzera, none of which have
 * approved posting automation.
 *
 * The cost of that mistake is asymmetric and irreversible: a community ban,
 * brand damage, and potentially spam signals attached to the whole domain —
 * the opposite of the organic traffic the automation exists to earn. You
 * cannot un-post to a few thousand subscribers.
 *
 * So the test that matters here is the third one: a JSON-only edit must not be
 * able to grant automation. Enabling a third-party subreddit has to be a code
 * change to `AUTOMATION_APPROVED_SUBREDDITS`, with the moderator approval
 * recorded beside the entry, which a reviewer reads as the policy decision it
 * is.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  AUTOMATION_APPROVED_SUBREDDITS,
  automationEligibleSubs,
  isAutomationApproved,
  policyBlockedSubreddits,
} from '../../scripts/lib/redditAutomationPolicy.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG = JSON.parse(readFileSync(path.join(ROOT, 'data', 'reddit-subreddits.json'), 'utf-8'));

/** Every subreddit named in the committed config. */
const ALL_SUBS: string[] = Object.keys(CONFIG.subreddits);
/** The ones we do NOT moderate — third parties. */
const THIRD_PARTY = ALL_SUBS.filter((n) => !isAutomationApproved(n));

const silent = { warn: () => {} };

describe('the committed config only automates communities we moderate', () => {
  it('has third-party subreddits to protect (guards against a vacuous suite)', () => {
    expect(THIRD_PARTY.length).toBeGreaterThan(0);
  });

  it('no third-party subreddit has allowsAutomation:true', () => {
    const offenders = THIRD_PARTY.filter((n) => CONFIG.subreddits[n].allowsAutomation === true);
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `data/reddit-subreddits.json enables automation on subreddit(s) this project does not ` +
          `moderate: ${offenders.join(', ')}. Posting automation into a community that has not ` +
          `approved it is spam. If a moderator HAS approved it, add the name to ` +
          `AUTOMATION_APPROVED_SUBREDDITS in scripts/lib/redditAutomationPolicy.mjs with the ` +
          `approval recorded next to it — do not flip the JSON alone.`,
    ).toEqual([]);
  });

  it('the policy list refuses nothing the config currently asks for', () => {
    expect(policyBlockedSubreddits(CONFIG)).toEqual([]);
  });

  it('resolves to our own community only, for every routed topic', () => {
    for (const topic of Object.keys(CONFIG.routing)) {
      const names = automationEligibleSubs(CONFIG, topic, silent).map((s: { name: string }) => s.name);
      for (const n of names) expect(isAutomationApproved(n)).toBe(true);
      expect(names).toEqual(['frontaliere']);
    }
  });
});

describe('a JSON-only edit cannot grant automation', () => {
  it('flipping a third-party subreddit to allowsAutomation:true does NOT enable it', () => {
    // The exact one-character change the guard exists to neutralise.
    const tampered = structuredClone(CONFIG);
    for (const n of THIRD_PARTY) tampered.subreddits[n].allowsAutomation = true;

    for (const topic of Object.keys(tampered.routing)) {
      const names = automationEligibleSubs(tampered, topic, silent).map((s: { name: string }) => s.name);
      for (const n of THIRD_PARTY) expect(names).not.toContain(n);
    }
  });

  it('surfaces the refusal loudly instead of dropping it silently', () => {
    const tampered = structuredClone(CONFIG);
    tampered.subreddits.Ticino.allowsAutomation = true;

    const warnings: string[] = [];
    automationEligibleSubs(tampered, 'jobs', { warn: (m: string) => warnings.push(m) });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ticino');
    expect(warnings[0]).toContain('redditAutomationPolicy.mjs');
    expect(policyBlockedSubreddits(tampered)).toEqual(['Ticino']);
  });

  it('an approved subreddit still honours allowsAutomation:false as an off switch', () => {
    // Policy authorises; the data file is the operator switch. Both must agree.
    expect(isAutomationApproved('FrontaliereTicino')).toBe(true);
    expect(CONFIG.subreddits.FrontaliereTicino.allowsAutomation).toBe(false);

    const names = automationEligibleSubs(CONFIG, 'articles', silent).map((s: { name: string }) => s.name);
    expect(names).not.toContain('FrontaliereTicino');
  });
});

describe('both entry points share one gate', () => {
  it('the scheduler and the post-deploy poster agree on the target set', async () => {
    const scheduler = await import('../../scripts/schedule-reddit-jobs-daily.mjs');
    const poster = await import('../../scripts/post-to-reddit.mjs');

    const fromScheduler = scheduler.eligibleSubsForTopic(CONFIG, 'articles', silent).map((s: { name: string }) => s.name);
    const fromPoster = poster.automationSubsForTopic(CONFIG, 'articles', silent);

    expect(fromScheduler).toEqual(fromPoster);
    expect(fromPoster).toEqual(['frontaliere']);
  });

  it('neither entry point can be talked into a third-party sub by config alone', async () => {
    const scheduler = await import('../../scripts/schedule-reddit-jobs-daily.mjs');
    const poster = await import('../../scripts/post-to-reddit.mjs');

    const tampered = structuredClone(CONFIG);
    for (const n of THIRD_PARTY) tampered.subreddits[n].allowsAutomation = true;

    expect(scheduler.eligibleSubsForTopic(tampered, 'jobs', silent).map((s: { name: string }) => s.name)).toEqual([
      'frontaliere',
    ]);
    expect(poster.automationSubsForTopic(tampered, 'articles', silent)).toEqual(['frontaliere']);
  });
});

describe('the approval list documents WHY each entry is there', () => {
  it('every approved subreddit carries a non-empty justification', () => {
    for (const [name, reason] of Object.entries(AUTOMATION_APPROVED_SUBREDDITS)) {
      expect(typeof reason, name).toBe('string');
      expect((reason as string).trim().length, name).toBeGreaterThan(10);
    }
  });
});
