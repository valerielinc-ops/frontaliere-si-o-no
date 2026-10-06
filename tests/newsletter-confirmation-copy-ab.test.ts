import { describe, expect, it, vi } from 'vitest';

const { confirmationCopyConfigRead, cascade } = vi.hoisted(() => ({
  confirmationCopyConfigRead: vi.fn(async () => {
    throw new Error('Remote Config unavailable');
  }),
  cascade: { sent: [] as any[] },
}));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__server_ts__',
  },
}));

vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: () => { throw new Error('injected database required'); },
}));

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  bridgeEmailCascadeCredentialsToEnv: async () => {},
  getNewsletterTokenPolicyConfig: async () => ({}),
  getNewsletterConfirmationCopyConfig: (...args: unknown[]) => confirmationCopyConfigRead(...args),
}));

vi.mock('../functions/src/emailCascade.js', () => ({
  sendEmailCascade: async (items: any[]) => {
    cascade.sent.push(...items);
    return { sent: items.map((item, index) => ({ ...item, messageId: `copy-ab-${index}` })), failed: [] };
  },
  PROVIDERS: [{ id: 'fake' }],
  isProviderConfigured: () => true,
}));

import {
  assignConfirmationCopyVariant,
  buildConfirmationCopyCampaignId,
  CONFIRMATION_COPY_DEFAULTS,
  isConfirmationCopyExperimentActive,
  parseConfirmationCopyCampaignId,
  pseudonymousConfirmationSubscriberId,
  readConfirmationCopyConfig,
} from '../functions/src/lib/confirmationCopyExperiment.js';
import {
  buildConfirmationRequestEmail,
} from '../functions/src/lib/confirmationEmailContent.js';
import {
  confirmationJobContextForSend,
} from '../functions/src/lib/confirmationJobContext.js';
import {
  buildConfirmationCopyReport,
  findIdentifierLeaks,
} from '../scripts/report-confirmation-copy-experiment.mjs';
import { campaignIdFromTags, makeMailerooRefOnSent } from '../functions/src/lib/mailerooRef.js';
import { sendNewsletterConfirmationEmail } from '../functions/src/newsletterConfirmationEmail.js';

const JOB = {
  source: 'job_gate:Acme SA:Developer',
  source_cta: 'job_gate_email_unlock',
  job_company: 'Acme SA',
  job_location: 'Lugano, Switzerland',
  created_at: '2026-10-06T10:00:00.000Z',
  confirmation_cycle_started_at: '2026-10-06T10:00:00.000Z',
};

describe('confirmation copy assignment', () => {
  it('defaults safely to contextual and keeps non-eligible surfaces out', () => {
    const config = readConfirmationCopyConfig({});
    expect(config).toEqual(CONFIRMATION_COPY_DEFAULTS);
    expect(isConfirmationCopyExperimentActive(config)).toBe(false);
    expect(assignConfirmationCopyVariant({ email: 'person@example.com', eligible: true, config }))
      .toBe('contextual');
    expect(assignConfirmationCopyVariant({ email: 'person@example.com', eligible: false, config }))
      .toBeNull();
  });

  it('is stable per subscriber and approximately balanced at a 50% rollout', () => {
    const config = readConfirmationCopyConfig({ NEWSLETTER_CONFIRMATION_COPY_ROLLOUT: '0.5' });
    const emails = Array.from({ length: 1000 }, (_, index) => `subscriber-${index}@example.com`);
    const variants = emails.map((email) => assignConfirmationCopyVariant({ email, eligible: true, config }));
    const generic = variants.filter((variant) => variant === 'generic').length;
    expect(variants).toEqual(emails.map((email) => assignConfirmationCopyVariant({ email, eligible: true, config })));
    expect(generic).toBeGreaterThan(300);
    expect(generic).toBeLessThan(700);
    expect(pseudonymousConfirmationSubscriberId(' Person@Example.com ')).toBe(
      pseudonymousConfirmationSubscriberId('person@example.com'),
    );
    expect(pseudonymousConfirmationSubscriberId('person@example.com')).not.toContain('@');
  });

  it('keeps contextual copy and still sends when Remote Config cannot be read', async () => {
    cascade.sent.length = 0;
    confirmationCopyConfigRead.mockClear();
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const data = {
      ...JOB,
      email: 'rc-failure@example.com',
      status: 'pending',
      isActive: false,
      created_at: recent,
      confirmation_cycle_started_at: recent,
    };
    const subscriberRef: any = {
      get: async () => ({ exists: true, data: () => data }),
      collection: () => ({ doc: () => ({}) }),
    };
    const db: any = {
      collection: () => ({ doc: () => subscriberRef }),
      runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
        get: async () => ({ exists: true, data: () => data }),
        update: () => {},
        set: () => {},
      }),
    };

    const result = await sendNewsletterConfirmationEmail({
      email: data.email,
      locale: 'it',
      sourcePath: '/it/offerte/',
      secret: 'test-secret',
      db,
      purpose: 'confirm',
    });

    expect(confirmationCopyConfigRead).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, messageId: 'copy-ab-0' });
    expect(result).not.toHaveProperty('error');
    expect(cascade.sent).toHaveLength(1);
    const { payload } = cascade.sent[0];
    expect(payload.subject).toContain('Developer');
    expect(payload.html).toContain('Acme SA');
    expect(payload.tags).toContainEqual({ name: 'campaign_id', value: 'confirmation' });
    expect(payload.tags).not.toContainEqual(expect.objectContaining({ name: 'copy_variant' }));
  });
});

describe('confirmation campaign labels and frozen follow-ups', () => {
  it('separates both copies in provider tags without the recipient address', () => {
    const generic = buildConfirmationRequestEmail({
      locale: 'it',
      confirmUrl: 'https://frontaliereticino.ch/?action=confirm_newsletter',
      copyVariant: 'generic',
      sourceCta: JOB.source_cta,
    });
    const campaign = generic.tags.find((tag) => tag.name === 'campaign_id')?.value;
    expect(campaign).toBe('confirmation_copy_ab_generic_job_gate_email_unlock_it');
    expect(campaign).not.toContain('person@example.com');
    expect(campaignIdFromTags(generic.tags)).toBe(campaign);
    expect(campaign?.startsWith('confirm')).toBe(true);
    expect(parseConfirmationCopyCampaignId(campaign)).toEqual({
      variant: 'generic', source_cta: 'job_gate_email_unlock', locale: 'it',
    });
  });

  it('freezes the assigned generic arm in the protected snapshot and on reminder', () => {
    const first = confirmationJobContextForSend(JOB, {
      attemptsBefore: 0,
      returnPath: '/it/offerte/',
      now: Date.parse('2026-10-06T10:30:00.000Z'),
      copyVariant: 'generic',
    });
    expect(first.jobContext).toBeNull();
    expect(first.copyVariant).toBe('generic');
    expect(first.snapshot).toMatchObject({
      copy_variant: 'generic', source_cta: 'job_gate_email_unlock',
    });

    const reminder = confirmationJobContextForSend({
      ...JOB,
      confirmation_attempts: 1,
      confirmation_job_context: first.snapshot,
      source: 'job_gate:Other SA:Other job',
      job_company: 'Other SA',
      job_location: 'Bellinzona',
    }, { attemptsBefore: 1, returnPath: '/other/' });
    expect(reminder.copyVariant).toBe('generic');
    expect(reminder.sourceCta).toBe('job_gate_email_unlock');
    expect(reminder.returnPath).toBe('/it/offerte/');
    expect(reminder.jobContext).toBeNull();
  });

  it('keeps the arm in the Maileroo ref used by engagement webhooks', async () => {
    const writes: any[] = [];
    const db = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({ set: async (data: any) => { writes.push(data); } }),
          }),
        }),
      }),
    };
    const onSent = makeMailerooRefOnSent(async () => db, {});
    const email = buildConfirmationRequestEmail({
      locale: 'it',
      confirmUrl: 'https://frontaliereticino.ch/?action=confirm_newsletter',
      copyVariant: 'contextual',
      sourceCta: JOB.source_cta,
    });
    await onSent(
      { recipient: { email: 'fixture@example.com' }, payload: { tags: email.tags } },
      { provider: 'maileroo', messageId: 'fixture-message' },
    );
    expect(writes[0]).toMatchObject({ campaign_id: 'confirmation_copy_ab_contextual_job_gate_email_unlock_it' });
  });
});

function campaign(variant: 'generic' | 'contextual', locale = 'it') {
  return buildConfirmationCopyCampaignId({
    variant,
    sourceCta: 'job_gate_email_unlock',
    locale,
  })!;
}

function event(event_type: 'send' | 'open' | 'click', message_id: string, campaign_id: string, provider = 'maileroo', email = `${message_id}@example.com`) {
  return { event_type, message_id, campaign_id, provider, email };
}

describe('confirmation copy report', () => {
  it('deduplicates engagement, stratifies dimensions and warns below the minimum', () => {
    const report = buildConfirmationCopyReport({
      fromMs: Date.parse('2026-10-01T00:00:00.000Z'),
      toMs: Date.parse('2026-10-10T00:00:00.000Z'),
      activationMs: Date.parse('2026-10-01T00:00:00.000Z'),
      events: [
        event('send', 'g1', campaign('generic')),
        event('open', 'g1', campaign('generic')),
        event('click', 'g1', campaign('generic')),
        event('click', 'g1', campaign('generic')),
        event('send', 'g2', campaign('generic')),
        event('open', 'g2', campaign('generic')),
        event('send', 'g1-followup', campaign('generic'), 'maileroo', 'g1@example.com'),
        event('click', 'g1-followup', campaign('generic'), 'maileroo', 'g1@example.com'),
        event('send', 'c1', campaign('contextual'), 'mailjet'),
        event('click', 'c1', campaign('contextual'), 'mailjet'),
        event('send', 'ignored', 'confirmation'),
      ],
    });
    expect(report.by_variant.generic).toMatchObject({ sends: 2, opened: 2, clicked: 1 });
    expect(report.message_by_variant.generic).toMatchObject({ sends: 3, clicked: 2 });
    expect(report.counters.followup_messages_collapsed).toBe(1);
    expect(report.by_variant.contextual).toMatchObject({ sends: 1, opened: 0, clicked: 1 });
    expect(report.by_variant.generic.click_ci95_pct).toBeTruthy();
    expect(report.by_source_cta.job_gate_email_unlock.generic.sends).toBe(2);
    expect(report.by_provider.mailjet.contextual.clicked).toBe(1);
    expect(report.decision.ready).toBe(false);
    expect(report.decision.warnings.length).toBeGreaterThan(0);
    expect(findIdentifierLeaks(report)).toEqual([]);
  });

  it('keeps identity-less messages out of the per-subscriber aggregates', () => {
    // Acceptance from the PR review: two sends with distinct message ids, the
    // same valid experiment campaign and no email are not two subscribers.
    const noIdentity = (type: 'send' | 'open' | 'click', id: string) => ({
      event_type: type, message_id: id, campaign_id: campaign('generic'), provider: 'maileroo',
    });
    const report = buildConfirmationCopyReport({
      fromMs: Date.parse('2026-10-01T00:00:00.000Z'),
      toMs: Date.parse('2026-10-20T00:00:00.000Z'),
      activationMs: Date.parse('2026-10-01T00:00:00.000Z'),
      events: [noIdentity('send', 'anon-1'), noIdentity('send', 'anon-2'), noIdentity('click', 'anon-2')],
    });
    expect(report.counters.eligible_subscribers).toBe(0);
    expect(report.counters.missing_subscriber_identity).toBe(2);
    expect(report.counters.followup_messages_collapsed).toBe(0);
    expect(report.by_variant.generic.sends).toBe(0);
    // The messages are still visible in the auxiliary per-message table.
    expect(report.message_by_variant.generic).toMatchObject({ sends: 2, clicked: 1 });
    expect(report.decision.ready).toBe(false);
    expect(report.decision.warnings.join(' | ')).toContain('2 invii senza identità');
    expect(findIdentifierLeaks(report)).toEqual([]);
  });

  it('cannot reach the readiness floor with identity-less sends', () => {
    // 400 identified subscribers on one arm, 400 identity-less sends on the
    // other: before the fix both arms looked ready after 14 days.
    const events: Array<Record<string, string>> = [];
    for (let index = 0; index < 400; index += 1) {
      events.push(event('send', `c-${index}`, campaign('contextual')));
      events.push({ event_type: 'send', message_id: `anon-${index}`, campaign_id: campaign('generic'), provider: 'maileroo' });
    }
    const report = buildConfirmationCopyReport({
      fromMs: Date.parse('2026-10-01T00:00:00.000Z'),
      toMs: Date.parse('2026-10-20T00:00:00.000Z'),
      activationMs: Date.parse('2026-10-01T00:00:00.000Z'),
      events,
    });
    expect(report.by_variant.contextual.sends).toBe(400);
    expect(report.by_variant.generic.sends).toBe(0);
    expect(report.counters.missing_subscriber_identity).toBe(400);
    expect(report.decision.ready).toBe(false);
    expect(report.decision.decision).toBe('tie_or_not_ready_keep_contextual');
  });

  it('only recommends generic after the fixed horizon, arm minimum and principal strata agree', () => {
    const events: Array<Record<string, string>> = [];
    for (let index = 0; index < 400; index += 1) {
      const genericId = `g-${index}`;
      events.push(event('send', genericId, campaign('generic')));
      if (index < 280) events.push(event('click', genericId, campaign('generic')));
      const contextualId = `c-${index}`;
      events.push(event('send', contextualId, campaign('contextual')));
      if (index < 120) events.push(event('click', contextualId, campaign('contextual')));
    }
    const report = buildConfirmationCopyReport({
      fromMs: Date.parse('2026-10-01T00:00:00.000Z'),
      toMs: Date.parse('2026-10-16T00:00:00.000Z'),
      activationMs: Date.parse('2026-10-01T00:00:00.000Z'),
      events,
    });
    expect(report.decision.ready).toBe(true);
    expect(report.decision.principal_strata_consistent).toBe(true);
    expect(report.decision.decision).toBe('promote_generic');
    expect(findIdentifierLeaks(report)).toEqual([]);
  });
});
