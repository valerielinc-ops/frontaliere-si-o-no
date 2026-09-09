import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  addDoc: vi.fn(async () => ({ id: 'event-1' })),
  welcome: vi.fn(async () => ({ success: true })),
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((db: unknown, name: string) => ({ db, name })),
  doc: vi.fn((...args: unknown[]) => ({ args })),
  getDoc: (...args: unknown[]) => mocks.getDoc(...args),
  setDoc: (...args: unknown[]) => mocks.setDoc(...args),
  addDoc: (...args: unknown[]) => mocks.addDoc(...args),
  increment: vi.fn((value: number) => ({ __increment: value })),
  serverTimestamp: vi.fn(() => '__server_timestamp__'),
  deleteField: vi.fn(() => '__delete_field__'),
}));

vi.mock('../functions/src/newsletterWelcomeEmail.js', () => ({
  sendNewsletterWelcomeEmail: (...args: unknown[]) => mocks.welcome(...args),
}));

import { captureNewsletterSubscriber } from '../services/newsletterSubscribers';

type Subscriber = Record<string, any>;

let subscriber: Subscriber | undefined;

function createManagementDb(email: string, initial: Subscriber) {
  const docs: Record<string, Subscriber> = {
    [`newsletter_subscribers/${email}`]: { ...initial },
  };
  const events: any[] = [];

  return {
    docs,
    events,
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            get: async () => ({
              exists: Boolean(docs[`${name}/${id}`]),
              data: () => docs[`${name}/${id}`],
            }),
            set: async (data: Subscriber) => {
              docs[`${name}/${id}`] = { ...(docs[`${name}/${id}`] || {}), ...data };
            },
            collection: (subName: string) => ({
              add: async (data: Subscriber) => {
                events.push({ collection: `${name}/${id}/${subName}`, ...data });
              },
            }),
          };
        },
      };
    },
  };
}

async function confirm(email: string, initial: Subscriber) {
  const { handleSubscriptionManagement } = await import(
    '../functions/src/newsletterSubscriptionManagement.js'
  );
  const { generateConfirmationToken } = await import(
    '../functions/src/newsletterConfirmationEmail.js'
  );
  const secret = 'test-secret-company-follow-boundary';
  const db = createManagementDb(email, initial);
  const result = await handleSubscriptionManagement({
    action: 'confirm',
    email,
    token: generateConfirmationToken(email, secret),
    secret,
    locale: 'it',
    db,
  });
  return { db, result };
}

describe('company-follow/newsletter purpose boundary', () => {
  beforeEach(() => {
    subscriber = undefined;
    mocks.getDoc.mockReset();
    mocks.setDoc.mockReset();
    mocks.addDoc.mockClear();
    mocks.welcome.mockReset();
    mocks.welcome.mockResolvedValue({ success: true });
    mocks.getDoc.mockImplementation(async () => ({
      exists: () => Boolean(subscriber),
      data: () => subscriber,
    }));
    mocks.setDoc.mockImplementation(async (_ref: unknown, data: Subscriber) => {
      subscriber = { ...(subscriber || {}), ...data };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('follow then explicit newsletter opt-in confirms active and sends welcome', async () => {
    const email = 'follow-then-newsletter@example.com';

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'company_follow_button',
      sourceChannel: 'company_follow_button',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula follow',
      consentGiven: false,
    });

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'web_app',
      sourceChannel: 'newsletter_page',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula newsletter',
      consentGiven: false,
      consentPurpose: 'communications',
      status: 'pending',
      isActive: false,
    });

    const { db } = await confirm(email, subscriber as Subscriber);
    const confirmed = db.docs[`newsletter_subscribers/${email}`];

    expect(confirmed.company_follow_only).toBe(false);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.isActive).toBe(true);
    expect(confirmed.active).toBe(true);
    expect(mocks.welcome).toHaveBeenCalledWith(expect.objectContaining({
      email,
      trigger: 'confirm',
    }));
  });

  it('newsletter opt-in after a confirmed follow starts a new newsletter confirmation', async () => {
    const email = 'confirmed-follow-then-newsletter@example.com';

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'company_follow_button',
      sourceChannel: 'company_follow_button',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula follow',
      consentGiven: false,
    });

    const followConfirmation = await confirm(email, subscriber as Subscriber);
    subscriber = followConfirmation.db.docs[`newsletter_subscribers/${email}`];

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'web_app',
      sourceChannel: 'newsletter_page',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula newsletter',
      consentGiven: true,
      consentPurpose: 'communications',
      status: 'pending',
      isActive: false,
    });

    const newsletterConfirmation = await confirm(email, subscriber as Subscriber);
    const confirmed = newsletterConfirmation.db.docs[`newsletter_subscribers/${email}`];

    expect(newsletterConfirmation.result.alreadyConfirmed).toBe(false);
    expect(confirmed.company_follow_only).toBe(false);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.isActive).toBe(true);
    expect(confirmed.active).toBe(true);
    expect(newsletterConfirmation.result.companyFollowFollowup).toEqual({
      required: true,
      sourcePath: null,
      newsletterActive: true,
    });
    expect(mocks.welcome).toHaveBeenCalledTimes(1);
  });

  it('company follow alone confirms suppressed and keeps every newsletter preference false', async () => {
    const email = 'company-follow-only@example.com';

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'company_follow_button',
      sourceChannel: 'company_follow_button',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula follow',
      consentGiven: false,
    });

    const { db } = await confirm(email, subscriber as Subscriber);
    const confirmed = db.docs[`newsletter_subscribers/${email}`];

    expect(confirmed.company_follow_only).toBe(true);
    expect(confirmed.preferences).toMatchObject({
      exchangeRate: false,
      traffic: false,
      taxUpdates: false,
      tips: false,
    });
    expect(confirmed.status).toBe('suppressed');
    expect(confirmed.isActive).toBe(false);
    expect(confirmed.active).toBe(false);
    expect(mocks.welcome).not.toHaveBeenCalled();
  });

  it('an existing newsletter subscriber keeps preferences when following a company', async () => {
    const email = 'newsletter-then-follow@example.com';
    subscriber = {
      email,
      status: 'confirmed',
      isActive: true,
      active: true,
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: true },
      consent_text: 'formula newsletter',
      consent_purpose: 'communications',
    };

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'company_follow_button',
      sourceChannel: 'company_follow_button',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula follow',
      consentGiven: false,
    });

    expect(subscriber?.company_follow_only).toBe(false);
    expect(subscriber?.preferences).toEqual({
      exchangeRate: true,
      traffic: true,
      taxUpdates: true,
      tips: true,
    });
    expect(subscriber?.status).toBe('confirmed');
    expect(subscriber?.isActive).toBe(true);
    expect(subscriber?.active).toBe(true);
  });

  it('does not end the company-follow purpose for a non-newsletter metadata write', async () => {
    subscriber = {
      email: 'company-follow-metadata@example.com',
      status: 'pending',
      isActive: false,
      company_follow_only: true,
      preferences: { exchangeRate: false, traffic: false, taxUpdates: false, tips: false },
      consent_text: 'formula follow',
      consent_purpose: 'companyFollow',
    };

    await captureNewsletterSubscriber({} as any, {
      email: 'company-follow-metadata@example.com',
      source: 'newsletter_page',
      sourceChannel: 'newsletter_page',
      preferences: { exchangeRate: false, traffic: false, taxUpdates: false, tips: false },
      consentText: 'formula follow',
      consentGiven: false,
    });

    expect(subscriber?.company_follow_only).toBe(true);
  });
});
