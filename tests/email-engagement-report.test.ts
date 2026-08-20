import { describe, it, expect } from 'vitest';
import {
  classifyEmailType,
  looksLikeMessageId,
  campaignFromMetadata,
  aggregateMessages,
  detectRegressions,
  REGRESSION_RULES,
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
    byType: {}, byProvider: {},
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

  it('compares providers too, not only types', () => {
    const prev = snap({ byProvider: { maileroo: { sent: 20000, opened: 6400, clicked: 900 } } });
    const cur = snap({ byProvider: { maileroo: { sent: 20000, opened: 2000, clicked: 880 } } });
    expect(detectRegressions(cur, prev).map((x: any) => x.metric)).toContain('provider:maileroo:open');
  });

  it('says nothing about a cell that did not exist last week', () => {
    const prev = snap({ byType: {} });
    const cur = snap({ byType: { daily_brief: { sent: 5000, opened: 10, clicked: 1 } } });
    expect(detectRegressions(cur, prev)).toEqual([]);
  });
});
