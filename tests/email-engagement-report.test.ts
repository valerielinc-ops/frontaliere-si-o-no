import { describe, it, expect } from 'vitest';
import {
  classifyEmailType,
  looksLikeMessageId,
  campaignFromMetadata,
  aggregateMessages,
  detectRegressions,
  REGRESSION_RULES,
  WRITER_FIX_LANDED_AT,
} from '../scripts/report-email-engagement.mjs';

describe('classifyEmailType', () => {
  it('reads job alerts off the parent collection, which is the only always-present signal', () => {
    // The four non-Resend job-alert webhooks write neither campaign_id nor
    // alert_id, so the parent collection is what makes this classifiable.
    expect(classifyEmailType('job_alert_subscribers', '')).toBe('job_alert');
    expect(classifyEmailType('job_alert_subscribers', 'anything')).toBe('job_alert');
  });

  it('maps the campaign id prefixes the senders actually emit', () => {
    expect(classifyEmailType('newsletter_subscribers', 'weekly_2026-08-17')).toBe('newsletter_weekly');
    expect(classifyEmailType('newsletter_subscribers', 'daily-brief-2026-08-20')).toBe('daily_brief');
    expect(classifyEmailType('newsletter_subscribers', 'saved-jobs-digest-2026-08-20')).toBe('saved_jobs_digest');
    expect(classifyEmailType('newsletter_subscribers', 'welcome_job')).toBe('welcome');
    expect(classifyEmailType('newsletter_subscribers', 'onboarding_drip_step_2')).toBe('onboarding_drip');
    expect(classifyEmailType('newsletter_subscribers', 'confirmation')).toBe('confirmation');
    expect(classifyEmailType('newsletter_subscribers', 'lamal_ssn_tool')).toBe('transactional_tool');
  });

  it('files a raw provider message id as `unattributed`, not as a campaign of its own', () => {
    expect(classifyEmailType('newsletter_subscribers', '20260801005003.f05193ac37d486fd@frontaliereticino.ch'))
      .toBe('unattributed');
    expect(classifyEmailType('newsletter_subscribers', '98ca09796281326a83e0b256')).toBe('unattributed');
    expect(classifyEmailType('newsletter_subscribers', 'unknown:abc')).toBe('unattributed');
  });
});

describe('looksLikeMessageId', () => {
  it('recognises the three shapes seen in production', () => {
    expect(looksLikeMessageId('unknown:xyz')).toBe(true);
    expect(looksLikeMessageId('a@b.ch')).toBe(true);
    expect(looksLikeMessageId('98ca09796281326a83e0b256')).toBe(true);
    expect(looksLikeMessageId('')).toBe(true);
  });
  it('leaves real campaign ids alone', () => {
    expect(looksLikeMessageId('weekly_2026-08-17')).toBe(false);
    expect(looksLikeMessageId('onboarding_drip_step_1')).toBe(false);
  });
});

describe('campaignFromMetadata', () => {
  it('recovers the campaign from the array tag shape Maileroo echoes back', () => {
    expect(campaignFromMetadata({ tags: [{ name: 'campaign_id', value: 'onboarding_drip_step_1' }] }))
      .toBe('onboarding_drip_step_1');
  });
  it('recovers it from the flattened object shape too', () => {
    expect(campaignFromMetadata({ tags: { campaign_id: 'welcome_job' } })).toBe('welcome_job');
  });
  it('falls back to a bare string tag that is neither noise nor a locale', () => {
    expect(campaignFromMetadata({ tags: ['welcome_job', 'lifecycle', 'en'] })).toBe('welcome_job');
  });
  it('returns empty when there is nothing to recover', () => {
    expect(campaignFromMetadata({ tags: ['lifecycle', 'it'] })).toBe('');
    expect(campaignFromMetadata(null)).toBe('');
  });
});

describe('aggregateMessages', () => {
  const msg = (o: any) => ({ provider: 'maileroo', emailType: 'job_alert', sent: 1, delivered: 1, open: 0, click: 0, bounce: 0, ...o });

  it('counts messages, not events — a reader who opens five times counts once', () => {
    const agg = aggregateMessages([msg({ open: 5, click: 3 })]);
    expect(agg.totals).toMatchObject({ sent: 1, opened: 1, clicked: 1 });
  });

  it('excludes engagement with no send in the window instead of inflating the numerator', () => {
    const agg = aggregateMessages([msg({ sent: 0, delivered: 0, open: 1 })]);
    expect(agg.totals.sent).toBe(0);
    expect(agg.totals.opened).toBe(0);
    expect(agg.orphanEngagement).toBe(1);
  });

  it('counts a Maileroo lifecycle message as unmeasurable, a job alert as measurable', () => {
    const agg = aggregateMessages([
      msg({ emailType: 'onboarding_drip' }),
      msg({ emailType: 'welcome' }),
      msg({ emailType: 'job_alert' }),
      msg({ emailType: 'newsletter_weekly' }),
    ]);
    expect(agg.unmeasurable).toBe(2);
  });

  it('does not call a Mailgun lifecycle message unmeasurable — that webhook carries the recipient', () => {
    const agg = aggregateMessages([msg({ provider: 'mailgun', emailType: 'welcome' })]);
    expect(agg.unmeasurable).toBe(0);
  });

  it('does not call a Maileroo lifecycle message unmeasurable once seen after the writer fix — #6317', () => {
    // Before #6317 this counted onboarding_drip/welcome/etc. as unmeasurable by
    // type alone forever, even once the shared ref writer (#6195) covered every
    // sender: a message seen well after the fix landed, with a real open on
    // record, is proof the ref resolved — the exact opposite of unmeasurable.
    const after = new Date(WRITER_FIX_LANDED_AT.getTime() + 24 * 60 * 60 * 1000);
    const agg = aggregateMessages([
      msg({ emailType: 'onboarding_drip', open: 1, firstSeenAt: after }),
      msg({ emailType: 'welcome', firstSeenAt: after }),
    ]);
    expect(agg.unmeasurable).toBe(0);
  });

  it('still calls a Maileroo lifecycle message unmeasurable when seen before the writer fix', () => {
    const before = new Date(WRITER_FIX_LANDED_AT.getTime() - 24 * 60 * 60 * 1000);
    const agg = aggregateMessages([msg({ emailType: 'onboarding_drip', firstSeenAt: before })]);
    expect(agg.unmeasurable).toBe(1);
  });

  it('splits by provider and by type from the same pass', () => {
    const agg = aggregateMessages([
      msg({ provider: 'mailgun', emailType: 'job_alert', open: 1 }),
      msg({ provider: 'maileroo', emailType: 'job_alert' }),
    ]);
    expect(agg.byProvider.mailgun).toMatchObject({ sent: 1, opened: 1 });
    expect(agg.byProvider.maileroo).toMatchObject({ sent: 1, opened: 0 });
    expect(agg.byType.job_alert).toMatchObject({ sent: 2, opened: 1 });
  });
});

describe('detectRegressions', () => {
  const snap = (over: any = {}) => ({
    byType: {}, byProvider: {}, byPair: {},
    integrity: { scanned: 10000, providerMissing: 0, unmeasurable: 0, unattributed: 0 },
    ...over,
  });

  it('is silent on a clean week with no previous snapshot', () => {
    expect(detectRegressions(snap(), null)).toEqual([]);
  });

  it('fires on the defect this instrument exists to guard: engagement being discarded', () => {
    const r = detectRegressions(snap({ integrity: { scanned: 10000, providerMissing: 0, unmeasurable: 2908, unattributed: 0 } }), null);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'integrity', metric: 'unmeasurable' });
    // The message must name the cause, not just the number.
    expect(r[0].detail).toMatch(/maileroo_refs/);
  });

  it('fires when campaign attribution is lost again', () => {
    const r = detectRegressions(snap({ integrity: { scanned: 10000, providerMissing: 0, unmeasurable: 0, unattributed: 721 } }), null);
    expect(r.map((x: any) => x.metric)).toContain('unattributed');
  });

  it('fires when events start arriving without a provider field', () => {
    const r = detectRegressions(snap({ integrity: { scanned: 10000, providerMissing: 500, unmeasurable: 0, unattributed: 0 } }), null);
    expect(r.map((x: any) => x.metric)).toContain('provider_missing');
  });

  it('flags a real open-rate collapse against last week', () => {
    const prev = snap({ byType: { job_alert: { sent: 10000, opened: 4600, clicked: 700 } } });
    const cur = snap({ byType: { job_alert: { sent: 10000, opened: 2000, clicked: 690 } } });
    const r = detectRegressions(cur, prev);
    expect(r.map((x: any) => x.metric)).toContain('type:job_alert:open');
  });

  it('ignores a small wobble — the rule is a relative drop, not any drop', () => {
    const prev = snap({ byType: { job_alert: { sent: 10000, opened: 4600, clicked: 700 } } });
    const cur = snap({ byType: { job_alert: { sent: 10000, opened: 4400, clicked: 690 } } });
    expect(detectRegressions(cur, prev)).toEqual([]);
  });

  it('ignores low-volume cells, where a rate swing is noise', () => {
    const prev = snap({ byType: { company_alert: { sent: 30, opened: 24, clicked: 6 } } });
    const cur = snap({ byType: { company_alert: { sent: 29, opened: 3, clicked: 0 } } });
    expect(detectRegressions(cur, prev)).toEqual([]);
    expect(REGRESSION_RULES.MIN_SENDS).toBeGreaterThan(30);
  });

  it('compares providers too, not only types — off non-cascade-ordered volume', () => {
    const prev = snap({ byPair: { 'maileroo|newsletter_weekly': { sent: 20000, opened: 6400, clicked: 900 } } });
    const cur = snap({ byPair: { 'maileroo|newsletter_weekly': { sent: 20000, opened: 2000, clicked: 880 } } });
    expect(detectRegressions(cur, prev).map((x: any) => x.metric)).toContain('provider:maileroo:open');
  });

  it('says nothing about a cell that did not exist last week', () => {
    const prev = snap({ byType: {} });
    const cur = snap({ byType: { daily_brief: { sent: 5000, opened: 10, clicked: 1 } } });
    expect(detectRegressions(cur, prev)).toEqual([]);
  });

  it('ignores a provider-level open-rate swing driven only by job_alert tier-cascade composition', () => {
    // Same mechanism the report already documents for cross-provider comparison
    // (fixed daily quota + engagement-tier ordering), but along the time axis:
    // mailgun's job_alert lane swings hard week to week while its other, non-cascade
    // types (newsletter_weekly here) stay flat. The provider-level check must not fire.
    const prev = snap({
      byPair: {
        'mailgun|job_alert': { sent: 398, opened: 345, clicked: 56 },
        'mailgun|newsletter_weekly': { sent: 400, opened: 300, clicked: 40 },
      },
    });
    const cur = snap({
      byPair: {
        'mailgun|job_alert': { sent: 98, opened: 44, clicked: 6 },
        'mailgun|newsletter_weekly': { sent: 400, opened: 295, clicked: 39 },
      },
    });
    const metrics = detectRegressions(cur, prev).map((x: any) => x.metric);
    expect(metrics).not.toContain('provider:mailgun:open');
  });

  it('still flags a real per-type-per-provider drop at pair granularity', () => {
    const prev = snap({ byPair: { 'mailgun|job_alert': { sent: 400, opened: 340, clicked: 56 } } });
    const cur = snap({ byPair: { 'mailgun|job_alert': { sent: 400, opened: 120, clicked: 50 } } });
    const metrics = detectRegressions(cur, prev).map((x: any) => x.metric);
    expect(metrics).toContain('pair:mailgun|job_alert:open');
  });
});
