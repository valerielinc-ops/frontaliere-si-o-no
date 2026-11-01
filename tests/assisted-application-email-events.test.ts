import { describe, expect, it } from 'vitest';
import {
  assistedCampaignId,
  assistedEmailTracking,
  conciergeCampaignId,
  conciergeEmailTracking,
  conciergePaidEmailViews,
  parseAssistedCampaign,
  recordAssistedEmailEvent,
} from '../functions/src/assistedApplicationEmailEvents.js';
import { applyResendWebhookEvent } from '../functions/src/newsletterResendWebhookCore.js';
import { persistMailgunEvent } from '../functions/src/newsletterMailgunWebhookCore.js';
import { persistMailjetEvent } from '../functions/src/newsletterMailjetWebhookCore.js';
import { persistMailerooEvent } from '../functions/src/newsletterMailerooWebhookCore.js';

const ORDER_ID = 'trial-20260930-01';
const ORDER = `assisted_applications/${ORDER_ID}`;
const CAMPAIGN = assistedCampaignId(ORDER_ID, 'auto_candidate_review_r1');
const EMAIL = 'luigi@example.com';
const REVIEW_LINK = `https://frontaliereticino.ch/candidatura/?t=signed-token-${ORDER_ID}`;

/** A Firestore double with create/update semantics that records every write path. */
function memoryDb(seed: Record<string, Record<string, any>> = {}) {
  const docs = new Map(Object.entries(seed).map(([path, data]) => [path, structuredClone(data)]));
  const writes: string[] = [];
  const read = (data: any, field: string) => field.split('.').reduce((value, part) => value?.[part], data);
  const doc = (path: string): any => ({
    id: path.split('/').pop(),
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path), get: (field: string) => read(docs.get(path), field) }),
    create: async (data: any) => {
      if (docs.has(path)) throw Object.assign(new Error('6 ALREADY_EXISTS: Document already exists'), { code: 6 });
      writes.push(path);
      docs.set(path, data);
    },
    update: async (fields: Record<string, any>) => {
      if (!docs.has(path)) throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 });
      writes.push(path);
      const data = docs.get(path)!;
      for (const [field, value] of Object.entries(fields)) {
        const parts = field.split('.');
        const parent = parts.slice(0, -1).reduce((node: any, part) => (node[part] ??= {}), data);
        const last = parts[parts.length - 1];
        parent[last] = value?.constructor?.name === 'NumericIncrementTransform' ? (parent[last] || 0) + value.operand : value;
      }
    },
    set: async () => { writes.push(path); },
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string): any => ({ doc: (id: string) => doc(`${path}/${id}`), add: async () => { writes.push(`${path}/+`); } });
  return { db: { collection } as any, docs, writes };
}

const seeded = () => memoryDb({ [ORDER]: { jobTitle: 'Infermiere/a' } });

describe('assisted e-mail events', () => {
  it('names the order and the e-mail in a campaign id every provider can carry', () => {
    expect(CAMPAIGN).toBe('aa--trial-20260930-01--auto_candidate_review_r1');
    expect(CAMPAIGN).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(CAMPAIGN.length).toBeLessThanOrEqual(64);
    expect(parseAssistedCampaign(CAMPAIGN)).toEqual({ orderId: ORDER_ID, key: 'auto_candidate_review_r1' });
    for (const other of ['weekly_2026_39', 'job-alert', 'aa--x', '', undefined]) expect(parseAssistedCampaign(other)).toBeNull();
    expect(assistedEmailTracking(ORDER_ID, 'interview_prep')).toEqual({
      tags: [{ name: 'type', value: 'assisted-application' }, { name: 'campaign_id', value: 'aa--trial-20260930-01--interview_prep' }],
      tracking: true,
    });
    expect(assistedEmailTracking(ORDER_ID, 'employer_message_forward', { clicks: false }).tracking).toBe(false);
    const conciergeCampaign = conciergeCampaignId('bundle-example', 'concierge_paid_customer');
    expect(conciergeCampaign).toBe('ac--bundle-example--concierge_paid_customer');
    expect(parseAssistedCampaign(conciergeCampaign)).toEqual({ serviceId: 'bundle-example', key: 'concierge_paid_customer' });
    expect(conciergeEmailTracking('bundle-example', 'concierge_paid_customer')).toEqual({
      tags: [{ name: 'type', value: 'application-concierge' }, { name: 'campaign_id', value: conciergeCampaign }],
      tracking: true,
    });
  });

  it('counts each provider event once, and keeps the signed token out of the clicked link', async () => {
    const { db, docs } = seeded();
    const first = { campaign: CAMPAIGN, type: 'open', provider: 'resend', messageId: 'm1', occurredAt: '2026-09-30T18:40:00Z' };
    expect(await recordAssistedEmailEvent(db, first)).toEqual({ assisted: true, recorded: true });
    // Redelivered by the provider: not counted twice.
    expect(await recordAssistedEmailEvent(db, first)).toMatchObject({ recorded: false, reason: 'duplicate' });
    await recordAssistedEmailEvent(db, { ...first, occurredAt: '2026-09-30T19:10:00Z' });
    await recordAssistedEmailEvent(db, { campaign: CAMPAIGN, type: 'click', provider: 'resend', messageId: 'm1', occurredAt: '2026-09-30T19:11:00Z', url: REVIEW_LINK });

    const engagement = docs.get(ORDER)!.emailEngagement.auto_candidate_review_r1;
    expect(engagement).toMatchObject({ opens: 2, clicks: 1, lastClickUrl: 'https://frontaliereticino.ch/candidatura/' });
    expect(engagement.firstOpenAt.toISOString()).toBe('2026-09-30T18:40:00.000Z');
    expect(engagement.lastOpenAt.toISOString()).toBe('2026-09-30T19:10:00.000Z');
    expect(JSON.stringify([...docs.values()])).not.toContain('signed-token');

    expect(await recordAssistedEmailEvent(db, { ...first, type: 'send' })).toMatchObject({ recorded: false, reason: 'untracked_type:send' });
    expect(await recordAssistedEmailEvent(seeded().db, { ...first, campaign: assistedCampaignId('gone', 'x') })).toMatchObject({ recorded: false, reason: 'order_not_found' });
  });

  it('keeps concierge acceptance separate from delivery and preserves the strongest delivery evidence', async () => {
    const serviceId = 'bundle-example';
    const servicePath = `application_concierge_services/${serviceId}`;
    const key = 'concierge_paid_customer';
    const campaign = conciergeCampaignId(serviceId, key);
    const { db, docs } = memoryDb({
      [servicePath]: { notifications: { [key]: { status: 'sent', provider: 'maileroo', messageId: 'receipt-1' } } },
    });
    const event = { campaign, provider: 'maileroo', messageId: 'receipt-1' };

    expect(await recordAssistedEmailEvent(db, { ...event, type: 'send', occurredAt: '2026-10-01T10:00:00Z' })).toEqual({ assisted: true, recorded: true });
    expect(await recordAssistedEmailEvent(db, { ...event, type: 'send', occurredAt: '2026-10-01T10:00:00Z' })).toMatchObject({ recorded: false, reason: 'duplicate' });
    expect(conciergePaidEmailViews(docs.get(servicePath))).toEqual(expect.arrayContaining([
      expect.objectContaining({ audience: 'customer', providerStatus: 'accepted', deliveryStatus: 'unknown', providerAccepted: 1, delivered: 0 }),
    ]));

    expect(await recordAssistedEmailEvent(db, { ...event, type: 'delivered', occurredAt: '2026-10-01T10:01:00Z' })).toEqual({ assisted: true, recorded: true });
    expect(await recordAssistedEmailEvent(db, { ...event, type: 'bounce', occurredAt: '2026-10-01T10:02:00Z' })).toEqual({ assisted: true, recorded: true });
    expect(await recordAssistedEmailEvent(db, { ...event, type: 'delivered', occurredAt: '2026-10-01T10:03:00Z' })).toEqual({ assisted: true, recorded: true });
    expect(conciergePaidEmailViews(docs.get(servicePath))).toEqual(expect.arrayContaining([
      expect.objectContaining({ audience: 'customer', providerStatus: 'accepted', deliveryStatus: 'bounced', providerAccepted: 1, delivered: 2, bounces: 1 }),
    ]));

    expect(await recordAssistedEmailEvent(db, { ...event, type: 'complaint', occurredAt: '2026-10-01T10:04:00Z' })).toEqual({ assisted: true, recorded: true });
    expect(await recordAssistedEmailEvent(db, { ...event, type: 'bounce', occurredAt: '2026-10-01T10:05:00Z' })).toEqual({ assisted: true, recorded: true });
    expect(conciergePaidEmailViews(docs.get(servicePath))).toEqual(expect.arrayContaining([
      expect.objectContaining({ audience: 'customer', providerStatus: 'accepted', deliveryStatus: 'complained', bounces: 2, complaints: 1 }),
    ]));
  });

  it('routes payment-recovery engagement to the digest ledger and keeps the tag bounded', async () => {
    const digestId = `digest-${'a'.repeat(24)}`;
    const campaign = assistedCampaignId(digestId, 'customer_payment_recovery');
    const { db, docs } = memoryDb({ [`assisted_application_payment_recovery/${digestId}`]: {} });
    expect(campaign.length).toBeLessThanOrEqual(64);
    expect(await recordAssistedEmailEvent(db, {
      campaign,
      type: 'open',
      provider: 'resend',
      messageId: 'recovery-1',
      occurredAt: '2026-10-01T10:00:00Z',
    })).toEqual({ assisted: true, recorded: true });
    expect(docs.get(`assisted_application_payment_recovery/${digestId}`)!.emailEngagement.customer_payment_recovery)
      .toMatchObject({ opens: 1 });
    expect(docs.has(`assisted_applications/${digestId}`)).toBe(false);
  });

  it('lands the four providers on the order, never on the newsletter or the job ranking', async () => {
    const providers: Array<[string, (db: any) => Promise<any>]> = [
      ['resend', (db) => applyResendWebhookEvent({
        type: 'email.clicked',
        data: { email: EMAIL, email_id: 're-1', created_at: '2026-09-30T18:41:00Z', click: { link: REVIEW_LINK }, tags: { type: 'assisted-application', campaign_id: CAMPAIGN } },
      }, { db })],
      ['mailgun', (db) => persistMailgunEvent(db, {
        event: 'clicked', recipient: EMAIL, timestamp: 1790793660, url: REVIEW_LINK, id: 'mg-1',
        tags: ['assisted-application', CAMPAIGN], 'user-variables': { campaign_id: CAMPAIGN }, message: { headers: { 'message-id': 'mg-1' } },
      })],
      ['mailjet', (db) => persistMailjetEvent(db, { event: 'click', email: EMAIL, time: 1790793660, url: REVIEW_LINK, CustomID: CAMPAIGN, MessageID: 11 })],
      ['maileroo', (db) => persistMailerooEvent(db, {
        event_type: 'clicked', message_reference_id: 'ml-1', event_time: 1790793660, event_data: { url: REVIEW_LINK },
      })],
    ];
    for (const [provider, send] of providers) {
      const { db, docs, writes } = memoryDb({
        [ORDER]: { jobTitle: 'Infermiere/a' },
        // Maileroo reports opens and clicks only through the reference written at send.
        'newsletter_subscribers/_meta_/maileroo_refs/ml-1': { email: EMAIL, campaign_id: CAMPAIGN, is_job_alert: false },
      });
      await send(db);
      expect(docs.get(ORDER)!.emailEngagement?.auto_candidate_review_r1, provider).toMatchObject({ clicks: 1 });
      expect(writes.every((path) => path.startsWith(`${ORDER}`)), `${provider}: ${writes.join(', ')}`).toBe(true);
    }
  });
});
