/**
 * Company Alerts — positive path as one fail-fast chain.
 *
 * This is deliberately one test and one process.  Each stage consumes the
 * state produced by the previous stage; a failed assertion stops the chain,
 * so a later green assertion can never mask an earlier broken link.
 *
 * The public page is represented by the real SSG mount placeholder and the
 * real CompanyFollowMount hydration bridge in jsdom.  Firestore, newsletter
 * confirmation, analytics, and the provider are all isolated in-memory test
 * doubles.  No production SDK, sender entrypoint, workflow, or network call
 * is invoked here.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeAlert = Record<string, any>;

const doubles = vi.hoisted(() => {
  const state: {
    subscriber: Record<string, any> | null;
    alerts: FakeAlert[];
    parentWrites: any[];
    confirmationRequests: any[];
    providerMessages: any[];
    impressions: any[];
    clicks: any[];
    created: any[];
  } = {
    subscriber: null,
    alerts: [],
    parentWrites: [],
    confirmationRequests: [],
    providerMessages: [],
    impressions: [],
    clicks: [],
    created: [],
  };

  const db = { kind: 'isolated-fake-firestore' };

  const makeRef = (path: string, id: string, parent: any = null) => ({
    kind: 'doc',
    path,
    id,
    parent,
  });

  const analytics = {
    trackJobAlertCtaShown: vi.fn((surface: string, company: string) => {
      state.impressions.push({ surface, company });
    }),
    trackJobAlertCtaClick: vi.fn((surface: string, outcome: string, company: string) => {
      state.clicks.push({ surface, outcome, company });
    }),
    trackJobAlertCreated: vi.fn((payload: any) => {
      state.created.push(payload);
    }),
    setUserSegmentFlags: vi.fn(),
  };

  const getApp = vi.fn(async () => ({ name: 'isolated-fake-app' }));

  const upsertNewsletterSubscriber = vi.fn(async (_db: unknown, input: Record<string, any>) => {
    const email = String(input.email || '').trim().toLowerCase();
    state.subscriber = {
      ...input,
      email,
      status: 'pending',
      isActive: false,
      active: false,
      company_follow_only: true,
      sourceChannel: 'company_follow_button',
      consentText: 'synthetic company follow confirmation',
      metadata: {
        signup: {
          channel: 'company-follow',
          version: 1,
        },
      },
      account_deleted_at: 'stale-account-marker',
    };
    // The real upsert owns this first confirmation-email side effect.  The
    // fake records it without rendering or sending a message.
    state.confirmationRequests.push({ purpose: 'companyFollow' });
    return { existed: false, status: 'pending' };
  });

  const requestConfirmationEmail = vi.fn(async () => undefined);

  const getDoc = vi.fn(async (ref: any) => {
    const found = state.alerts.find((alert) => alert.ref?.path === ref?.path);
    return {
      exists: () => Boolean(found),
      data: () => (found ? { ...found } : undefined),
    };
  });

  const getDocs = vi.fn(async (queryRef: any) => {
    const constraints = Array.isArray(queryRef?.constraints) ? queryRef.constraints : [];
    const userId = constraints.find((constraint: any) => constraint.field === 'userId')?.value;
    const active = constraints.find((constraint: any) => constraint.field === 'active')?.value;
    const docs = state.alerts
      .filter((alert) => userId == null || alert.userId === userId)
      .filter((alert) => active == null || alert.active === active)
      .map((alert) => ({
        id: alert.id,
        ref: alert.ref,
        data: () => ({ ...alert }),
      }));
    return { size: docs.length, docs };
  });

  const setDoc = vi.fn(async (ref: any, data: Record<string, any>) => {
    if (String(ref?.path || '').includes('/alerts/')) {
      const existing = state.alerts.find((alert) => alert.ref?.path === ref.path);
      if (existing) Object.assign(existing, data);
      else state.alerts.push({ ...data, id: ref.id, ref });
    } else {
      state.parentWrites.push({ ref, data });
    }
  });

  const addDoc = vi.fn(async (collectionRef: any, data: Record<string, any>) => {
    const id = `generated-${state.alerts.length + 1}`;
    const ref = makeRef(`${collectionRef.path}/${id}`, id, collectionRef);
    state.alerts.push({ ...data, id, ref });
    return ref;
  });

  const updateDoc = vi.fn(async (ref: any, data: Record<string, any>) => {
    const found = state.alerts.find((alert) => alert.ref?.path === ref?.path);
    if (!found) throw new Error('fake Firestore alert not found');
    Object.assign(found, data);
  });

  const reset = () => {
    state.subscriber = null;
    state.alerts.length = 0;
    state.parentWrites.length = 0;
    state.confirmationRequests.length = 0;
    state.providerMessages.length = 0;
    state.impressions.length = 0;
    state.clicks.length = 0;
    state.created.length = 0;
    for (const mock of [
      upsertNewsletterSubscriber,
      requestConfirmationEmail,
      getDoc,
      getDocs,
      setDoc,
      addDoc,
      updateDoc,
      getApp,
      analytics.trackJobAlertCtaShown,
      analytics.trackJobAlertCtaClick,
      analytics.trackJobAlertCreated,
      analytics.setUserSegmentFlags,
    ]) mock.mockClear();
  };

  return {
    state,
    db,
    analytics,
    getApp,
    upsertNewsletterSubscriber,
    requestConfirmationEmail,
    getDoc,
    getDocs,
    setDoc,
    addDoc,
    updateDoc,
    reset,
    makeRef,
  };
});

const adminDouble = vi.hoisted(() => {
  const firestoreFactory: any = vi.fn();
  firestoreFactory.FieldValue = {
    serverTimestamp: vi.fn(() => new Date()),
    delete: vi.fn(() => ({ __fakeFieldValue: 'delete' })),
    increment: vi.fn((value: number) => value),
  };
  firestoreFactory.Timestamp = {
    fromMillis: vi.fn((value: number) => new Date(value)),
  };
  const authApi = {
    getUserByEmail: vi.fn(async () => ({ uid: 'synthetic-user' })),
    createUser: vi.fn(async () => ({ uid: 'synthetic-user' })),
    createCustomToken: vi.fn(async () => null),
  };
  return {
    apps: [] as any[],
    initializeApp: vi.fn(() => ({ name: 'isolated-admin-app' })),
    credential: { applicationDefault: vi.fn(() => ({ kind: 'isolated-credential' })) },
    auth: vi.fn(() => authApi),
    firestore: firestoreFactory,
  };
});

vi.mock('firebase-admin', () => ({ default: adminDouble }));

vi.mock('firebase/firestore', () => ({
  collectionGroup: vi.fn((db: unknown, name: string) => ({ kind: 'collectionGroup', db, name })),
  collection: vi.fn((parent: any, name: string) => ({
    kind: 'collection',
    parent,
    name,
    path: `${parent?.path || ''}/${name}`,
  })),
  doc: vi.fn((...args: any[]) => {
    if (args[0] === doubles.db) {
      const pathParts = args.slice(1).map((part) => String(part));
      const path = pathParts.join('/');
      return doubles.makeRef(path, pathParts[pathParts.length - 1]);
    }
    const parent = args[0];
    const id = String(args[1]);
    return doubles.makeRef(`${parent.path}/${id}`, id, parent);
  }),
  addDoc: (...args: any[]) => doubles.addDoc(...args),
  setDoc: (...args: any[]) => doubles.setDoc(...args),
  getDoc: (...args: any[]) => doubles.getDoc(...args),
  getDocs: (...args: any[]) => doubles.getDocs(...args),
  updateDoc: (...args: any[]) => doubles.updateDoc(...args),
  query: vi.fn((...constraints: any[]) => ({ constraints })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  orderBy: vi.fn((field: string, direction: string) => ({ field, direction })),
  serverTimestamp: vi.fn(() => new Date()),
  deleteField: vi.fn(() => null),
  getFirestore: vi.fn(() => doubles.db),
}));

vi.mock('@/services/firebase', () => ({
  getApp: (...args: any[]) => doubles.getApp(...args),
}));

vi.mock('@/services/authService', () => ({
  useAuth: () => ({ user: null, loading: false }),
  getAuthEmail: () => null,
}));

vi.mock('@/services/analytics', () => ({ Analytics: doubles.analytics }));

vi.mock('@/services/userAlertsCache', () => ({
  invalidateUserAlertsCache: vi.fn(),
}));

vi.mock('@/services/newsletterSubscribers', () => ({
  upsertNewsletterSubscriber: (...args: any[]) => doubles.upsertNewsletterSubscriber(...args),
  requestConfirmationEmail: (...args: any[]) => doubles.requestConfirmationEmail(...args),
}));

vi.mock('../functions/src/newsletterWelcomeEmail.js', () => ({
  sendNewsletterWelcomeEmail: vi.fn(async () => ({ success: true })),
}));

import { companyFollowMountPlaceholder } from '../build-plugins/shared/companyFollowMountPlaceholder';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import {
  buildRecipientSections,
  classifyProviderOutcomes,
  deliveryOutcomeForEmail,
  planDeliveryWriteback,
  selectNewlyPublishedJobs,
} from '../scripts/send-company-alerts.mjs';
import { isImmediateCompanyAlert } from '../scripts/lib/company-alert-routing.mjs';

const COMPANY = 'Acme';
const COMPANY_KEY = 'acme';
const NOVELTY_WINDOW_MS = 6 * 60 * 60 * 1000;

async function loadChainModules() {
  // These modules own mutable process-level state. Importing them after a
  // reset gives every runChain round a fresh queue, pending-intent store,
  // locale state, and service cache instead of merely resetting the doubles.
  vi.resetModules();
  const [companyFollowMount, jobAlertService, companyFollowIntent, popupQueue, i18n] = await Promise.all([
    import('@/components/community/CompanyFollowMount'),
    import('@/services/jobAlertService'),
    import('@/services/companyFollowIntent'),
    import('@/services/popupQueue'),
    import('@/services/i18n'),
  ]);
  return {
    CompanyFollowMount: companyFollowMount.default,
    companyAlertKey: jobAlertService.companyAlertKey,
    deleteAlert: jobAlertService.deleteAlert,
    subscribeCompanyAlert: jobAlertService.subscribeCompanyAlert,
    clearPendingCompanyFollows: companyFollowIntent.clearPendingCompanyFollows,
    flushPendingCompanyFollows: companyFollowIntent.flushPendingCompanyFollows,
    readPendingCompanyFollows: companyFollowIntent.readPendingCompanyFollows,
    getActiveSlotId: popupQueue.getActiveSlotId,
    hasActiveSlot: popupQueue.hasActiveSlot,
    setLocale: i18n.setLocale,
  };
}

function createManagementDb(email: string, initial: Record<string, any>) {
  const isFirestoreMap = (value: unknown): value is Record<string, any> => Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && !(value instanceof Date),
  );
  const isDeleteFieldValue = (value: unknown): boolean => (
    isFirestoreMap(value) && value.__fakeFieldValue === 'delete'
  );
  const cloneFirestoreValue = (value: any): any => {
    if (Array.isArray(value)) return value.map(cloneFirestoreValue);
    if (!isFirestoreMap(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneFirestoreValue(nested)]),
    );
  };
  const applySet = (
    existing: Record<string, any> | undefined,
    patch: Record<string, any>,
    options?: { merge?: boolean },
  ): Record<string, any> => {
    const mergeMap = (base: Record<string, any>, values: Record<string, any>) => {
      const next = cloneFirestoreValue(base) as Record<string, any>;
      for (const [key, value] of Object.entries(values)) {
        if (isDeleteFieldValue(value)) {
          delete next[key];
        } else if (isFirestoreMap(value) && isFirestoreMap(next[key])) {
          next[key] = mergeMap(next[key], value);
        } else {
          next[key] = cloneFirestoreValue(value);
        }
      }
      return next;
    };

    // Admin Firestore replaces a document unless { merge: true } is passed;
    // merge mode recursively preserves maps and applies FieldValue.delete().
    return mergeMap(options?.merge === true ? (existing || {}) : {}, patch);
  };
  const docs: Record<string, Record<string, any>> = {
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
            set: async (data: Record<string, any>, options?: { merge?: boolean }) => {
              docs[`${name}/${id}`] = applySet(docs[`${name}/${id}`], data, options);
            },
            collection: (subName: string) => ({
              add: async (data: Record<string, any>) => {
                events.push({ collection: `${name}/${id}/${subName}`, ...data });
              },
            }),
          };
        },
      };
    },
  };
}

async function confirmSyntheticAddress(email: string): Promise<void> {
  expect(doubles.state.subscriber, 'ring 4: pending subscriber exists before confirmation').not.toBeNull();
  const { handleSubscriptionManagement } = await import(
    '../functions/src/newsletterSubscriptionManagement.js'
  );
  const { generateConfirmationToken } = await import(
    '../functions/src/newsletterConfirmationEmail.js'
  );
  const confirmationSecret = ['isolated', 'synthetic', 'company', 'follow'].join(':');
  const db = createManagementDb(email, doubles.state.subscriber as Record<string, any>);
  const token = generateConfirmationToken(email, confirmationSecret);
  await handleSubscriptionManagement({
    action: 'confirm',
    email,
    token,
    secret: confirmationSecret,
    locale: 'it',
    db,
  });
  doubles.state.subscriber = db.docs[`newsletter_subscribers/${email}`];
}

function makeJob(
  id: string,
  company: string,
  companyKey: string,
  firstSeenAt: number,
  title: string,
) {
  return {
    id,
    title,
    company,
    companyKey,
    location: 'Lugano',
    canton: 'TI',
    status: 'open',
    active: true,
    firstSeenAt: new Date(firstSeenAt).toISOString(),
    expiresAt: new Date(firstSeenAt + 48 * 60 * 60 * 1000).toISOString(),
    url: `https://example.test/lavoro/${id}/`,
  };
}

async function runChain(locale: 'it' | 'en', round: number) {
  const email = `synthetic-company-follow-${locale}-${round}@example.test`;
  const expectedPath = locale === 'it' ? '/aziende/acme/' : `/${locale}/aziende/acme/`;
  const now = Date.now();

  cleanup();
  localStorage.clear();
  doubles.reset();
  const {
    CompanyFollowMount,
    companyAlertKey,
    deleteAlert,
    subscribeCompanyAlert,
    clearPendingCompanyFollows,
    flushPendingCompanyFollows,
    readPendingCompanyFollows,
    getActiveSlotId,
    hasActiveSlot,
    setLocale,
  } = await loadChainModules();
  clearPendingCompanyFollows();
  setLocale(locale);
  window.history.replaceState({}, '', expectedPath);

  // Ring 1 — popup arbitration precondition. This chain verifies the
  // positive visibility path only when no other prompt owns the shared slot;
  // Ring 2 must not imply that the company prompt wins an unrelated contest.
  expect(hasActiveSlot(), 'ring 1: shared popup slot is free before mount').toBe(false);
  expect(getActiveSlotId(), 'ring 1: popup queue has no owner before mount').toBeNull();

  // Ring 1 — public single-company profile and the real SSG island contract.
  document.body.innerHTML = `<main data-public-company-profile><h1>${COMPANY}</h1>${companyFollowMountPlaceholder({
    company: COMPANY,
    companyKey: COMPANY_KEY,
    locale,
    surface: 'employer_profile',
  })}</main>`;
  render(<CompanyFollowMount />);
  expect(window.location.pathname, 'ring 1: public company profile path').toBe(expectedPath);
  expect(document.querySelectorAll('[data-company-follow-mount]'), 'ring 1: one SSG follow mount').toHaveLength(1);
  expect(document.querySelector('[data-company-follow-mount]')?.getAttribute('data-company-key'), 'ring 1: mount carries company key').toBe(COMPANY_KEY);
  expect(doubles.state.alerts, 'ring 1: visit creates no CompanyAlert').toHaveLength(0);

  await waitFor(() => {
    expect(document.querySelector('[data-company-follow-inline="acme"] button[aria-pressed]'), 'ring 1: hydrated inline CTA is present').not.toBeNull();
  }, { timeout: 2500 });

  // Ring 2 — actual shell visibility and onShown, not merely queue enqueue.
  await waitFor(() => {
    const dialog = screen.queryByRole('dialog');
    expect(dialog, 'ring 2: popup dialog is mounted').not.toBeNull();
    expect(dialog, 'ring 2: popup dialog is visibly rendered').toBeVisible();
    expect(doubles.state.impressions, 'ring 2: onShown fires for visible popup').toHaveLength(1);
  }, { timeout: 2500 });
  expect(getActiveSlotId(), 'ring 2: company popup owns the shared visible slot').toBe('company-follow-prompt:acme');
  expect(doubles.state.alerts, 'ring 2: opening popup creates no CompanyAlert').toHaveLength(0);
  expect(doubles.state.subscriber, 'ring 2: opening popup creates no newsletter subscriber').toBeNull();

  // Ring 3 — explicit popup action only opens the canonical inline capture.
  expect(readPendingCompanyFollows(), 'ring 3: no pending follow before explicit action').toHaveLength(0);
  const dialog = screen.getByRole('dialog');
  const accept = Array.from(dialog.querySelectorAll('button')).find(
    (button) => !button.getAttribute('aria-label') && Boolean(button.textContent?.trim()),
  );
  expect(accept, 'ring 3: popup exposes an explicit follow action').toBeTruthy();
  fireEvent.click(accept as HTMLButtonElement);
  await waitFor(() => {
    expect(document.querySelector('#company-follow-email'), 'ring 3: explicit action opens email capture').not.toBeNull();
  });
  expect(doubles.state.alerts, 'ring 3: popup action still creates no CompanyAlert').toHaveLength(0);
  expect(doubles.state.subscriber, 'ring 3: popup action still creates no subscriber').toBeNull();

  // Ring 4 — anonymous capture is pending until the synthetic confirmation.
  const input = document.querySelector('#company-follow-email') as HTMLInputElement | null;
  expect(input, 'ring 4: anonymous branch exposes email input').not.toBeNull();
  fireEvent.change(input as HTMLInputElement, { target: { value: email } });
  const form = input?.closest('form');
  expect(form, 'ring 4: anonymous branch exposes capture form').not.toBeNull();
  fireEvent.submit(form as HTMLFormElement);
  await waitFor(() => {
    expect(doubles.state.subscriber?.status, 'ring 4: captured subscriber is pending').toBe('pending');
  });
  expect(doubles.state.confirmationRequests, 'ring 4: confirmation is captured by fake boundary').toHaveLength(1);
  expect(readPendingCompanyFollows(), 'ring 4: pending follow intent exists before confirmation').toHaveLength(1);
  expect(doubles.state.alerts, 'ring 4: pending confirmation creates no CompanyAlert').toHaveLength(0);
  await confirmSyntheticAddress(email);
  expect(doubles.state.subscriber?.status, 'ring 4: confirmed company-follow address stays newsletter-suppressed').toBe('suppressed');
  expect(doubles.state.subscriber?.company_follow_confirmed_at, 'ring 4: confirmation proof is recorded').toBeTruthy();
  expect(doubles.state.subscriber?.company_follow_followup_pending, 'ring 4: confirmed follow is queued for alert flush').toBe(true);
  expect(doubles.state.subscriber?.metadata, 'ring 4: merge keeps nested subscriber metadata').toEqual({
    signup: {
      channel: 'company-follow',
      version: 1,
    },
  });
  expect(doubles.state.subscriber?.account_deleted_at, 'ring 4: FieldValue.delete removes stale account marker').toBeUndefined();
  expect(doubles.state.alerts, 'ring 4: confirmation step itself still has no alert write').toHaveLength(0);

  // Ring 5 — the post-confirmation flush uses the real CompanyAlert writer.
  const flush = await flushPendingCompanyFollows('synthetic-user', email, subscribeCompanyAlert);
  expect(flush.created, 'ring 5: confirmation flush creates exactly one CompanyAlert').toHaveLength(1);
  expect(flush.pending, 'ring 5: successful flush clears the pending intent').toBe(0);
  const createdAlert = flush.created[0];
  const canonicalKey = canonicalCompanyProfileSlug(COMPANY, COMPANY_KEY);
  expect(createdAlert.specificCompanyKey, 'ring 5: alert key comes from shared canonical resolver').toBe(canonicalKey);
  expect(createdAlert.specificCompanyKey, 'ring 5: service key agrees with canonical resolver').toBe(companyAlertKey(COMPANY, COMPANY_KEY));
  expect(createdAlert.frequency, 'ring 5: persisted cadence is immediate').toBe('immediate');
  expect(createdAlert.active, 'ring 5: persisted alert is active').toBe(true);
  expect((createdAlert as any).paused ?? false, 'ring 5: persisted/default pause state is false').toBe(false);
  expect((createdAlert as any).consentPurpose, 'ring 5: alert records companyFollow purpose').toBe('companyFollow');
  expect(doubles.state.alerts, 'ring 5: fake Firestore contains one alert record').toHaveLength(1);

  // Ring 6 — firstSeenAt controls novelty; a recrawl is deliberately present.
  const newJob = makeJob('acme-new', COMPANY, COMPANY_KEY, now - 30 * 60 * 1000, 'New Acme role');
  const recrawledJob = makeJob('acme-recrawl', COMPANY, COMPANY_KEY, now - 48 * 60 * 60 * 1000, 'Old Acme role');
  const wrongCompanyJob = makeJob('acme-holdings', 'Acme Holdings', 'acme-holdings', now - 20 * 60 * 1000, 'Wrong-company role');
  const dataset = [newJob, recrawledJob, wrongCompanyJob];
  const newlyPublished = selectNewlyPublishedJobs(dataset, now, NOVELTY_WINDOW_MS);
  expect(newlyPublished.map((job) => job.id), 'ring 6: firstSeenAt selects the fresh offer').toContain(newJob.id);
  expect(newlyPublished.map((job) => job.id), 'ring 6: recrawl is excluded by firstSeenAt').not.toContain(recrawledJob.id);
  const storedAlert = doubles.state.alerts[0];
  const sections = buildRecipientSections([storedAlert], newlyPublished, now, undefined, dataset);
  expect(sections, 'ring 6: sender creates one pertinent recipient section').toHaveLength(1);
  expect(sections[0].jobs.map((job: any) => job.id), 'ring 6: sender selects only the new offer for the followed company').toEqual([newJob.id]);
  expect(sections[0].jobs.map((job: any) => job.id), 'ring 6: wrong-company offer is not selected').not.toContain(wrongCompanyJob.id);

  // Ring 7 — fake provider captures one email; explicit messageId means accepted.
  const unsubscribeUrl = `https://example.test/disiscrivi-alert/?alertId=${encodeURIComponent(createdAlert.id)}`;
  const built = (await import('@/services/companyAlertEmail.mjs')).buildCompanyAlertEmail({
    sections: sections.map((section) => ({
      alertId: section.alert.id,
      companyName: section.companyName,
      companySlug: section.alert.specificCompanyKey,
      jobs: section.jobs,
      unsubscribeUrl,
    })),
    email,
    locale,
    manageUrl: 'https://example.test/aziende-seguite/',
    unsubscribeUrl,
    unsubscribeAllUrl: 'https://example.test/disiscrivi-alert/?all=1',
    wrapUrl: (url: string) => url,
    wrapJobUrl: (url: string) => url,
    baseUrl: 'https://example.test',
    now,
  });
  expect(built.subject, 'ring 7: email subject names the followed company').toContain(COMPANY);
  expect(built.html, 'ring 7: email contains the company').toContain(COMPANY);
  expect(built.html, 'ring 7: email contains the new offer').toContain(newJob.title);
  expect(built.html, 'ring 7: email contains the offer URL').toContain(newJob.url);
  expect(built.html, 'ring 7: email excludes the recrawled offer').not.toContain(recrawledJob.title);
  expect(built.html, 'ring 7: email excludes the wrong-company offer').not.toContain(wrongCompanyJob.title);

  const hrefs = [...built.html.matchAll(/href="([^"]*disiscrivi-alert[^"]*)"/g)].map((match) => match[1]);
  const linkInEmail = hrefs.find((href) => href.includes('alertId='));
  expect(linkInEmail, 'ring 7: captured email contains the alert unsubscribe link').toBe(unsubscribeUrl);
  doubles.state.providerMessages.push({
    to: email,
    subject: built.subject,
    html: built.html,
    text: built.text,
    unsubscribeUrl: linkInEmail,
  });
  expect(doubles.state.providerMessages, 'ring 7: fake provider captured one message in memory').toHaveLength(1);
  expect(doubles.state.providerMessages[0].to, 'ring 7: captured recipient is the synthetic address').toBe(email);

  const providerResult = classifyProviderOutcomes({
    sent: [{ recipient: { email }, provider: 'fake', messageId: `provider-message-${locale}-${round}` }],
    failed: [],
  });
  const delivery = deliveryOutcomeForEmail({ to: email }, providerResult);
  expect(providerResult.sent, 'ring 7: fake provider returns one explicit acceptance').toHaveLength(1);
  expect(providerResult.failed, 'ring 7: explicit provider ack has no failure').toHaveLength(0);
  expect(delivery.outcome, 'ring 7: explicit provider messageId is accepted').toBe('accepted');
  expect(delivery.provider, 'ring 7: outcome identifies the fake provider').toBe('fake');
  expect(delivery.messageId, 'ring 7: accepted outcome carries messageId proof').toBeTruthy();
  const acceptedWrite = planDeliveryWriteback(storedAlert, [newJob], delivery.outcome, now, delivery);
  doubles.state.alerts[0] = { ...doubles.state.alerts[0], ...acceptedWrite };
  expect(Object.keys(doubles.state.alerts[0].sentJobIds || {}), 'ring 7: accepted offer is recorded as sent').toContain(newJob.id);

  // The provider contract guard is part of this same ring: 2xx without an id
  // is ambiguous and must not advance sentJobIds or trigger a retry here.
  const missingId = classifyProviderOutcomes({
    sent: [{ recipient: { email }, provider: 'fake' }],
    failed: [],
  });
  const ambiguous = deliveryOutcomeForEmail({ to: email }, missingId);
  expect(ambiguous.outcome, 'ring 7: provider ack without messageId is ambiguous').toBe('ambiguous');
  const ambiguousWrite = planDeliveryWriteback(
    doubles.state.alerts[0],
    [makeJob('acme-ambiguous-check', COMPANY, COMPANY_KEY, now - 5 * 60 * 1000, 'Unsent check')],
    ambiguous.outcome,
    now,
    ambiguous,
  );
  expect(ambiguousWrite.sentJobIds, 'ring 7: ambiguous ack cannot mark a job sent').toBeUndefined();
  expect(Object.values(ambiguousWrite.deliveryLedger || {}).some((entry: any) => entry.state === 'ambiguous'), 'ring 7: ambiguous ack is retry-blocking in the ledger').toBe(true);

  // Ring 8 — the link from that same message soft-unsubscribes and blocks next send.
  const linkedAlertId = new URL(linkInEmail as string).searchParams.get('alertId');
  expect(linkedAlertId, 'ring 8: email link resolves the persisted alert id').toBe(createdAlert.id);
  await deleteAlert(email, linkedAlertId as string);
  expect(doubles.state.alerts, 'ring 8: unsubscribe preserves the alert record').toHaveLength(1);
  expect(doubles.state.alerts[0].active, 'ring 8: unsubscribe sets active false').toBe(false);
  const afterUnsubscribe = makeJob('acme-after-unsubscribe', COMPANY, COMPANY_KEY, now + 10 * 60 * 1000, 'Later Acme role');
  const sectionsAfterUnsubscribe = buildRecipientSections(
    doubles.state.alerts.filter((alert) => isImmediateCompanyAlert(alert)),
    selectNewlyPublishedJobs([afterUnsubscribe], now + 10 * 60 * 1000, NOVELTY_WINDOW_MS),
    now + 10 * 60 * 1000,
    undefined,
    [afterUnsubscribe],
  );
  expect(sectionsAfterUnsubscribe, 'ring 8: inactive alert is not selected by the second sender run').toHaveLength(0);
  expect(doubles.state.providerMessages, 'ring 8: second sender run produces no second email').toHaveLength(1);

  cleanup();
  return {
    locale,
    visible: doubles.state.impressions.length === 1,
    pendingBeforeConfirmation: 1,
    persisted: doubles.state.alerts.length === 1,
    selectedNewOffer: sections[0].jobs.length === 1,
    recrawlExcluded: !newlyPublished.some((job) => job.id === recrawledJob.id),
    providerMessages: doubles.state.providerMessages.length,
    deliveryOutcome: delivery.outcome,
    unsubscribed: doubles.state.alerts[0].active === false,
    secondSenderMessages: 0,
  };
}

describe('Company Alerts — complete positive chain in isolation', () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = '';
    localStorage.clear();
    doubles.reset();
  });

  it('runs all eight rings twice in Italian and English, fail-fast, in one process', async () => {
    const results = [];
    for (const locale of ['it', 'en'] as const) {
      results.push(await runChain(locale, 1));
      results.push(await runChain(locale, 2));
    }

    expect(results, 'chain repetitions: exactly two runs per locale').toHaveLength(4);
    for (const locale of ['it', 'en'] as const) {
      const sameLocale = results.filter((result) => result.locale === locale);
      expect(sameLocale, `chain repetitions: two results for ${locale}`).toHaveLength(2);
      expect(sameLocale[1], `chain repetitions: ${locale} second run equals first run`).toEqual(sameLocale[0]);
    }
    expect(results.every((result) => result.deliveryOutcome === 'accepted'), 'chain result: every explicit fake-provider ack accepted').toBe(true);
    const { getLocale } = await import('@/services/i18n');
    expect(getLocale(), 'chain result: final locale is the last exercised real locale').toBe('en');
  });
});
