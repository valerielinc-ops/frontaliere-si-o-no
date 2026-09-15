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
              const next = { ...(docs[`${name}/${id}`] || {}) };
              for (const [key, value] of Object.entries(data)) {
                // Firestore removes deleteField() transforms instead of
                // returning the transform sentinel on the next read.
                if (value === '__delete_field__' || value?.constructor?.name === 'DeleteTransform') {
                  delete next[key];
                } else {
                  next[key] = value;
                }
              }
              docs[`${name}/${id}`] = next;
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

  it('follow then newsletter capture stays active without a second confirmation or welcome dispatch', async () => {
    const email = 'follow-then-newsletter@example.com';

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'company_follow_button',
      sourceChannel: 'company_follow_button',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula follow',
      consentGiven: true,
      consentTextDisplayed: true,
      consentAct: 'email_checkbox_submit',
      consentMethod: 'email_checkbox',
    });

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'web_app',
      sourceChannel: 'newsletter_page',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula newsletter',
      consentGiven: true,
      consentTextDisplayed: true,
      consentAct: 'typed_email_submit',
      consentMethod: 'email_submit',
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
    expect(mocks.welcome).not.toHaveBeenCalled();
  });

  it('newsletter capture after a confirmed follow keeps the same unified confirmation', async () => {
    const email = 'confirmed-follow-then-newsletter@example.com';

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'company_follow_button',
      sourceChannel: 'company_follow_button',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula follow',
      consentGiven: true,
      consentTextDisplayed: true,
      consentAct: 'email_checkbox_submit',
      consentMethod: 'email_checkbox',
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

    expect(newsletterConfirmation.result.alreadyConfirmed).toBe(true);
    expect(confirmed.company_follow_only).toBe(false);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.isActive).toBe(true);
    expect(confirmed.active).toBe(true);
    expect(newsletterConfirmation.result.companyFollowFollowup).toEqual({
      required: true,
      sourcePath: null,
      newsletterActive: true,
    });
    expect(mocks.welcome).not.toHaveBeenCalled();
  });

  it('company follow alone confirms the base relationship and parks the extra company alert', async () => {
    const email = 'company-follow-only@example.com';

    await captureNewsletterSubscriber({} as any, {
      email,
      source: 'company_follow_button',
      sourceChannel: 'company_follow_button',
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true },
      consentText: 'formula follow',
      consentGiven: true,
      consentTextDisplayed: true,
      consentAct: 'email_checkbox_submit',
      consentMethod: 'email_checkbox',
    });

    const { db } = await confirm(email, subscriber as Subscriber);
    const confirmed = db.docs[`newsletter_subscribers/${email}`];

    expect(confirmed.company_follow_only).toBe(false);
    expect(confirmed.preferences).toMatchObject({
      exchangeRate: true,
      traffic: true,
      taxUpdates: true,
      tips: false,
      jobs: true,
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.isActive).toBe(true);
    expect(confirmed.active).toBe(true);
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
      jobs: true,
    });
    expect(subscriber?.status).toBe('confirmed');
    expect(subscriber?.isActive).toBe(true);
    expect(subscriber?.active).toBe(true);
  });

  it('an ordinary registration ends the legacy company-follow-only purpose', async () => {
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

    expect(subscriber?.company_follow_only).toBe(false);
    // A typed ordinary registration stays pending for DOI/audit purposes;
    // ordinary senders no longer use that proof state as a delivery gate.
    expect(subscriber?.status).toBe('pending');
    expect(subscriber?.isActive).toBe(false);
    expect(subscriber?.preferences).toMatchObject({ jobs: true });
  });
});
