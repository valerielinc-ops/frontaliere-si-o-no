/**
 * tests/company-follow-server-intent.test.ts
 *
 * THE INVARIANT: an anonymous "Segui azienda" becomes ONE CompanyAlert at the
 * moment the mailbox owner clicks the confirmation (or access) link, from any
 * device — and never for an address that opted out, bounced or later
 * unfollowed that employer.
 *
 * Measured on production 2026-10-05 before this change: 35 subscribers still
 * carrying `company_follow_followup_pending`, 32 of them with no company alert,
 * because the intent lived only in the browser that clicked "Segui".
 *
 * Every address here is on example.com (the repo is public).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPANY_FOLLOW_INTENT_TTL_MS,
  companyFollowAlertIdempotencyKey,
  companyFollowBlockReason,
  fulfillCompanyFollowIntents,
} from '../functions/src/companyFollowIntents.js';
import { companyFollowGroupKey, handleSubscriptionManagement, normalizeCompanyAlertKey } from '../functions/src/newsletterSubscriptionManagement.js';
import {
  companyKeyFromFollowPage,
  pageLocale,
  planSubscriberBackfill,
} from '../scripts/backfill-company-follow-intents.mjs';
import { createHmac } from 'node:crypto';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const EMAIL = 'follower@example.com';
const UID = 'uid-follower';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const minutesAgo = (m: number) => ({ toMillis: () => NOW - m * 60_000 });

type Docs = Record<string, Record<string, any>>;

/**
 * Minimal Admin-SDK-shaped fake: top-level docs, one level of subcollections,
 * `where('status','==',…)` + `limit` on subcollections, `add`, merge `set`.
 */
function createDb(seed: { subscribers?: Docs; alerts?: Record<string, any>; intents?: Record<string, any>; jobAlertParent?: Record<string, any> } = {}) {
  const top: Record<string, Docs> = {
    newsletter_subscribers: { ...(seed.subscribers || {}) },
    job_alert_subscribers: seed.jobAlertParent ? { [EMAIL]: seed.jobAlertParent } : {},
  };
  const sub: Record<string, Record<string, any>> = {
    [`job_alert_subscribers/${EMAIL}/alerts`]: { ...(seed.alerts || {}) },
    [`newsletter_subscribers/${EMAIL}/company_follow_intents`]: { ...(seed.intents || {}) },
    [`newsletter_subscribers/${EMAIL}/events`]: {},
  };
  let auto = 0;
  const docRef = (bucket: Record<string, any>, id: string, onSet?: (id: string, data: any) => void): any => ({
    id,
    get: async () => ({ exists: id in bucket, data: () => bucket[id] }),
    set: async (data: any, options?: { merge?: boolean }) => {
      bucket[id] = options?.merge ? { ...(bucket[id] || {}), ...data } : { ...data };
      onSet?.(id, data);
    },
  });
  const subcollection = (key: string): any => {
    sub[key] ||= {};
    const bucket = sub[key];
    const query = (filter?: { field: string; value: unknown }, max = Infinity): any => ({
      where: (field: string, _op: string, value: unknown) => query({ field, value }, max),
      limit: (n: number) => query(filter, n),
      get: async () => {
        const entries = Object.entries(bucket)
          .filter(([, data]) => !filter || data[filter.field] === filter.value)
          .slice(0, max);
        return { forEach: (cb: any) => entries.forEach(([id, data]) => cb({ id, data: () => data, ref: docRef(bucket, id) })) };
      },
    });
    return {
      ...query(),
      doc: (id: string) => docRef(bucket, id),
      add: async (data: any) => {
        auto += 1;
        const id = `auto-${auto}`;
        bucket[id] = { ...data };
        return { id };
      },
    };
  };
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => {
        top[name] ||= {};
        const ref = docRef(top[name], id);
        return { ...ref, collection: (child: string) => subcollection(`${name}/${id}/${child}`) };
      },
    }),
    top,
    sub,
  };
  return db;
}

const intent = (overrides: Record<string, unknown> = {}) => ({
  company_key: 'acme-sa',
  company: 'Acme SA',
  locale: 'it',
  source_job_slug: 'impiegato-acme-sa-lugano',
  source_job_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/impiegato-acme-sa-lugano/',
  source_job_title: 'Impiegato',
  source_page: '/cerca-lavoro-ticino/impiegato-acme-sa-lugano/',
  status: 'pending',
  created_at: minutesAgo(10),
  ...overrides,
});

const confirmed = { status: 'confirmed', isActive: true, active: true, confirmed_at: minutesAgo(1) };

const run = (db: ReturnType<typeof createDb>, extra: Record<string, unknown> = {}) => fulfillCompanyFollowIntents({
  db,
  email: EMAIL,
  uid: UID,
  normalizeKey: normalizeCompanyAlertKey,
  via: 'confirmation_link',
  nowMs: NOW,
  ...extra,
});

describe('one alert, identical to the browser one', () => {
  it('creates the CompanyAlert with the subscribeCompanyAlert shape at the deterministic id', async () => {
    const db = createDb({ subscribers: { [EMAIL]: { ...confirmed, company_follow_followup_pending: true } }, intents: { i1: intent() } });
    const outcome = await run(db);

    expect(outcome).toMatchObject({ created: 1, existing: 0, skipped: 0, pending: 0 });
    const key = companyFollowAlertIdempotencyKey({ userId: UID, email: EMAIL, locale: 'it', companyKey: 'acme-sa' });
    const alert = db.sub[`job_alert_subscribers/${EMAIL}/alerts`][`intent_${key}`];
    expect(alert).toMatchObject({
      email: EMAIL,
      userId: UID,
      specificCompanyKey: 'acme-sa',
      frequency: 'immediate',
      frequencyOverride: true,
      active: true,
      keywords: [],
      locations: [],
      sectors: [],
      contractTypes: [],
      cantonFilter: null,
      specificJobId: null,
      consent_purpose: 'companyFollow',
      consent_act: 'company_follow_activation',
      sourceJobSlug: 'impiegato-acme-sa-lugano',
      idempotency_key: key,
      locale: 'it',
    });
    expect(db.top.job_alert_subscribers[EMAIL]).toMatchObject({ userId: UID, status: 'active', active: true });
    expect(db.sub[`newsletter_subscribers/${EMAIL}/company_follow_intents`].i1).toMatchObject({ status: 'fulfilled', fulfilled_via: 'confirmation_link' });
    expect(db.top.newsletter_subscribers[EMAIL].company_follow_followup_pending).toBe(false);
  });

  it('uses the SAME idempotency key as the browser createAlert, so the local replay finds it', async () => {
    const { stableAlertIdempotencyKey } = await import('@/services/jobAlertService');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const browser = stableAlertIdempotencyKey(UID, EMAIL, {
        keywords: [],
        locations: [],
        contractTypes: [],
        sectors: [],
        cantonFilter: null,
        frequency: 'immediate',
        frequencyOverride: true,
        locale,
        specificJobId: null,
        specificCompanyKey: 'acme-sa',
        consentPurpose: 'companyFollow',
        consentAct: 'company_follow_activation',
        sourceJobSlug: 'whatever',
        sourceJobUrl: null,
        sourceJobTitle: null,
      } as never, 'acme-sa');
      expect(companyFollowAlertIdempotencyKey({ userId: UID, email: EMAIL, locale, companyKey: 'acme-sa' })).toBe(browser);
    }
  });

  it('collapses repeated clicks on the same employer into one alert', async () => {
    const db = createDb({
      subscribers: { [EMAIL]: confirmed },
      intents: { i1: intent({ created_at: minutesAgo(30) }), i2: intent({ created_at: minutesAgo(5), locale: 'de' }) },
    });
    const outcome = await run(db);
    expect(outcome.created).toBe(1);
    const alerts = Object.values(db.sub[`job_alert_subscribers/${EMAIL}/alerts`]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ locale: 'de' });
    const intents = db.sub[`newsletter_subscribers/${EMAIL}/company_follow_intents`];
    expect(intents.i1.status).toBe('fulfilled');
    expect(intents.i2.status).toBe('fulfilled');
  });

  it('does not write when an active alert for the company already exists (any writer)', async () => {
    const db = createDb({
      subscribers: { [EMAIL]: confirmed },
      alerts: { existing: { specificCompanyKey: 'acme-sa', active: true, userId: UID } },
      intents: { i1: intent() },
    });
    const outcome = await run(db);
    expect(outcome).toMatchObject({ created: 0, existing: 1 });
    expect(Object.keys(db.sub[`job_alert_subscribers/${EMAIL}/alerts`])).toEqual(['existing']);
    expect(db.sub[`newsletter_subscribers/${EMAIL}/company_follow_intents`].i1).toMatchObject({ status: 'fulfilled', alert_id: 'existing' });
  });

  it('treats a follow group as ONE follow (coop ≡ coop-genossenschaft, #11709)', async () => {
    const db = createDb({
      subscribers: { [EMAIL]: confirmed },
      alerts: { genossenschaft: { specificCompanyKey: 'coop-genossenschaft', active: true, userId: UID } },
      intents: { i1: intent({ company_key: 'coop', company: 'Coop' }) },
    });
    const outcome = await run(db, { groupKey: companyFollowGroupKey });
    expect(outcome).toMatchObject({ created: 0, existing: 1 });
    expect(Object.keys(db.sub[`job_alert_subscribers/${EMAIL}/alerts`])).toEqual(['genossenschaft']);

    const twoMembers = createDb({
      subscribers: { [EMAIL]: confirmed },
      intents: {
        a: intent({ company_key: 'coop', created_at: minutesAgo(20) }),
        b: intent({ company_key: 'coop-genossenschaft', created_at: minutesAgo(5) }),
      },
    });
    expect((await run(twoMembers, { groupKey: companyFollowGroupKey })).created).toBe(1);
    expect(Object.values(twoMembers.sub[`job_alert_subscribers/${EMAIL}/alerts`])).toHaveLength(1);
  });

  it('is idempotent: a second click reads no pending intent and writes nothing', async () => {
    const db = createDb({ subscribers: { [EMAIL]: confirmed }, intents: { i1: intent() } });
    await run(db);
    const second = await run(db);
    expect(second).toMatchObject({ total: 0, created: 0 });
    expect(Object.keys(db.sub[`job_alert_subscribers/${EMAIL}/alerts`])).toHaveLength(1);
  });
});

describe('consent and stops win over an intent', () => {
  it.each([
    ['unsubscribed', { status: 'unsubscribed', unsubscribed_at: minutesAgo(2) }, 'opted_out'],
    ['stop-all', { ...confirmed, all_email_opted_out: true }, 'opted_out'],
    ['hard bounce', { status: 'bounced', bounce_severity: 'hard' }, 'address_suppressed'],
    ['complaint', { status: 'complained' }, 'address_suppressed'],
  ])('skips a %s subscriber', async (_label, subscriber, reason) => {
    const db = createDb({ subscribers: { [EMAIL]: subscriber }, intents: { i1: intent() } });
    const outcome = await run(db);
    expect(outcome.created).toBe(0);
    expect(outcome.reasons[reason as string]).toBe(1);
    expect(Object.keys(db.sub[`job_alert_subscribers/${EMAIL}/alerts`])).toHaveLength(0);
    expect(db.sub[`newsletter_subscribers/${EMAIL}/company_follow_intents`].i1).toMatchObject({ status: 'skipped', skip_reason: reason });
  });

  it('releases the legacy company-only hold (status suppressed by design, no bounce)', () => {
    expect(companyFollowBlockReason({ status: 'suppressed', company_follow_only: true })).toBeNull();
    expect(companyFollowBlockReason({ status: 'suppressed', company_follow_only: true, bounce_severity: 'hard' })).toBe('address_suppressed');
    expect(companyFollowBlockReason({ status: 'suppressed' })).toBe('address_suppressed');
  });

  it('expires an intent older than the browser TTL instead of acting on a stale click', async () => {
    const db = createDb({
      subscribers: { [EMAIL]: confirmed },
      intents: { old: intent({ created_at: { toMillis: () => NOW - COMPANY_FOLLOW_INTENT_TTL_MS - 1 } }) },
    });
    const outcome = await run(db);
    expect(outcome).toMatchObject({ created: 0, expired: 1 });
    expect(db.sub[`newsletter_subscribers/${EMAIL}/company_follow_intents`].old.status).toBe('expired');
  });

  it('keeps an unfollow made AFTER the click binding, but honours a re-follow after an old unfollow', async () => {
    const after = createDb({
      subscribers: { [EMAIL]: confirmed },
      alerts: { off: { specificCompanyKey: 'acme-sa', active: false, unsubscribed_at: minutesAgo(2) } },
      intents: { i1: intent({ created_at: minutesAgo(10) }) },
    });
    expect((await run(after)).reasons.unfollowed).toBe(1);

    const before = createDb({
      subscribers: { [EMAIL]: confirmed },
      alerts: { off: { specificCompanyKey: 'acme-sa', active: false, unsubscribed_at: minutesAgo(600) } },
      intents: { i1: intent({ created_at: minutesAgo(10) }) },
    });
    expect((await run(before)).created).toBe(1);

    const backfill = createDb({
      subscribers: { [EMAIL]: confirmed },
      alerts: { off: { specificCompanyKey: 'acme-sa', active: false, unsubscribed_at: minutesAgo(600) } },
      intents: { i1: intent({ created_at: minutesAgo(10) }) },
    });
    expect((await run(backfill, { skipIfAnyAlertForKey: true })).created).toBe(0);
  });

  it('respects the per-user company follow cap', async () => {
    const alerts: Record<string, any> = {};
    for (let i = 0; i < 20; i += 1) alerts[`a${i}`] = { specificCompanyKey: `company-${i}`, active: true };
    const db = createDb({ subscribers: { [EMAIL]: confirmed }, alerts, intents: { i1: intent() } });
    const outcome = await run(db);
    expect(outcome.reasons.alert_limit_reached).toBe(1);
    expect(Object.keys(db.sub[`job_alert_subscribers/${EMAIL}/alerts`])).toHaveLength(20);
  });
});

describe('the link click is where it happens (newsletterManageSubscription)', () => {
  const SECRET = 'test-newsletter-secret-key-2026';
  const TOKEN = createHmac('sha256', SECRET).update(EMAIL).digest('hex');
  const mintAuthSession = vi.fn(async () => ({ uid: UID, authToken: 'custom-token' }));

  it('creates the alert on the DOI confirmation and drops the "return to the company" action', async () => {
    const db = createDb({
      subscribers: {
        [EMAIL]: { status: 'pending', source_channel: 'company_follow_unified', source_page: '/aziende/acme-sa/', company_follow_followup_pending: true },
      },
      intents: { i1: intent({ created_at: { toMillis: () => Date.now() - 60_000 } }) },
    });
    const result: any = await handleSubscriptionManagement({
      action: 'confirm', email: EMAIL, token: TOKEN, locale: 'it', secret: SECRET, db: db as any, mintAuthSession,
    } as any);
    expect(result.status).toBe(200);
    expect(result.authToken).toBe('custom-token');
    expect(result.companyFollowFulfilled).toEqual({ created: 1, existing: 0, pending: 0, newsletterActive: true });
    expect(result.companyFollowFollowup).toBeUndefined();
    const alerts = Object.values(db.sub[`job_alert_subscribers/${EMAIL}/alerts`]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ specificCompanyKey: 'acme-sa', userId: UID });
  });

  it('keeps the follow-up action when no server intent exists (older client)', async () => {
    const db = createDb({
      subscribers: {
        [EMAIL]: { status: 'pending', source_channel: 'company_follow_unified', source_page: '/aziende/acme-sa/', company_follow_followup_pending: true },
      },
    });
    const result: any = await handleSubscriptionManagement({
      action: 'confirm', email: EMAIL, token: TOKEN, locale: 'it', secret: SECRET, db: db as any, mintAuthSession,
    } as any);
    expect(result.companyFollowFulfilled).toBeUndefined();
    expect(result.companyFollowFollowup).toMatchObject({ required: true, sourcePath: '/aziende/acme-sa/' });
  });

  it('also completes the follow from a login link (address already confirmed)', async () => {
    const db = createDb({
      subscribers: { [EMAIL]: { ...confirmed, company_follow_followup_pending: true } },
      intents: { i1: intent({ created_at: { toMillis: () => Date.now() - 60_000 } }) },
    });
    const result: any = await handleSubscriptionManagement({
      action: 'confirm', mode: 'login', email: EMAIL, token: TOKEN, locale: 'it', secret: SECRET, db: db as any, mintAuthSession,
    } as any);
    expect(result.loginOnly).toBe(true);
    expect(result.companyFollowFulfilled).toMatchObject({ created: 1 });
    expect(db.sub[`newsletter_subscribers/${EMAIL}/company_follow_intents`].i1.fulfilled_via).toBe('login_link');
  });

  it('forwards the summary in the JSON body the SPA reads', () => {
    expect(read('functions/index.js')).toContain('jsonBody.companyFollowFulfilled = result.companyFollowFulfilled');
  });
});

describe('firestore.rules: clients may only append a fixed-shape pending intent', () => {
  const rules = read('firestore.rules');
  const block = rules.slice(rules.indexOf('match /company_follow_intents/{intentId}'), rules.indexOf('match /events/{eventId}'));

  it('denies read, update and delete', () => {
    expect(block).toContain('allow read, update, delete: if false;');
  });

  it('pins the keys, the pending status and the server timestamp on create', () => {
    expect(block).toMatch(/keys\(\)\.hasOnly\(\[[\s\S]*'company_key'[\s\S]*'created_at'[\s\S]*\]\)/);
    expect(block).toContain("request.resource.data.status == 'pending'");
    expect(block).toContain('request.resource.data.created_at == request.time');
    expect(block).toContain("request.resource.data.locale in ['it', 'en', 'de', 'fr']");
  });

  it('writes exactly the keys the rule allows from the browser', () => {
    const service = read('services/companyFollowIntent.ts');
    const writer = service.slice(service.indexOf('export async function recordServerCompanyFollowIntent'));
    const written = [...writer.slice(0, writer.indexOf('return true;')).matchAll(/^\s{6}([a-z_]+):/gm)].map((m) => m[1]);
    const allowed = [...block.slice(block.indexOf('hasOnly(['), block.indexOf('])')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(written.sort()).toEqual(allowed.sort());
  });
});

describe('backfill: the employer is reconstructed only from a page that names it', () => {
  it.each([
    ['/aziende/eoc-ente-ospedaliero-cantonale/', null, 'eoc-ente-ospedaliero-cantonale', 'employer_profile'],
    ['/fr/aziende/tl-transports-publics-de-la-region-lausannoise/', null, 'tl-transports-publics-de-la-region-lausannoise', 'employer_profile'],
    ['/aziende-che-assumono/stabio/vf-international/settimana-corrente/', null, 'vf-international', 'employer_weekly'],
    ['/cerca-lavoro-ticino/azienda-mcdonald-s-switzerland/', null, 'mcdonald-s-switzerland', 'company_hub'],
    ['/en/find-jobs-ticino/company-fachkraft-ch-gmbh/', null, 'fachkraft-ch-gmbh', 'company_hub'],
    ['/aziende/migros-ticino/', null, 'migros', 'employer_profile'],
    ['/de/jobs-im-tessin/produktionsbetreiber-nestle-avenches-ch/', 'Nestlé', 'nestle', 'job_page_company_match'],
  ])('%s → %s', (sourcePage, jobCompany, key, basis) => {
    expect(companyKeyFromFollowPage({ sourcePage, jobCompany })).toMatchObject({ key, basis });
  });

  it('matches whole slug tokens only, never a substring of another word', () => {
    expect(companyKeyFromFollowPage({ sourcePage: '/jobs/laboratory-job/', jobCompany: 'AB' })).toBeNull();
    expect(companyKeyFromFollowPage({ sourcePage: '/cerca-lavoro-ticino/impiegato-ab-lugano/', jobCompany: 'AB' }))
      .toMatchObject({ key: 'ab', basis: 'job_page_company_match' });
  });

  it.each([
    ['/cerca-lavoro-ticino/operatori-socioassistenziali-infanza/', 'Città di Lugano'],
    ['/en/find-jobs-ticino/', 'Spital Limmattal'],
    ['/', 'Coop'],
    ['/cerca-lavoro-ticino/impiegato-coop-castione/', null],
    ['/jobs/laboratory-job/', 'AB'],
  ])('%s with job_company %s stays unresolved', (sourcePage, jobCompany) => {
    expect(companyKeyFromFollowPage({ sourcePage, jobCompany })).toBeNull();
  });

  it('reads the site locale from the page prefix', () => {
    expect(pageLocale('/fr/aziende/x/')).toBe('fr');
    expect(pageLocale('/aziende/x/')).toBe('it');
  });

  const followEvent = (page: string) => ({ event_type: 'subscribe_completed', source_cta: 'company_follow_button', source_page: page, timestamp: minutesAgo(60) });
  const proof = { status: 'confirmed', confirmed_at: minutesAgo(30), confirmed_via: 'confirmation_link' };

  it('plans only confirmed, reachable subscribers without an alert for that employer', () => {
    const base = { events: [followEvent('/aziende/acme-sa/')], alerts: [], hasAuthUser: true };
    expect(planSubscriberBackfill({ ...base, subscriber: proof })).toMatchObject({ eligible: true, wouldCreate: ['acme-sa'] });
    expect(planSubscriberBackfill({ ...base, subscriber: { status: 'pending' } }).reason).toBe('not_confirmed');
    expect(planSubscriberBackfill({ ...base, subscriber: { status: 'expired' } }).reason).toBe('not_confirmed');
    expect(planSubscriberBackfill({ ...base, subscriber: { ...proof, status: 'unsubscribed' } }).reason).toBe('not_confirmed');
    expect(planSubscriberBackfill({ ...base, subscriber: { ...proof, all_email_opted_out: true } }).reason).toBe('opted_out');
    expect(planSubscriberBackfill({ ...base, subscriber: proof, hasAuthUser: false }).reason).toBe('no_auth_user');
    expect(planSubscriberBackfill({ ...base, subscriber: proof, alerts: [{ specificCompanyKey: 'acme-sa', active: false }] }).reason).toBe('already_has_alert');
    expect(planSubscriberBackfill({ ...base, subscriber: proof, events: [followEvent('/cerca-lavoro-ticino/')] }).reason).toBe('unresolved_company');
    // Follow group (#11709): an alert on another member already covers the follow.
    expect(planSubscriberBackfill({
      ...base,
      subscriber: proof,
      events: [followEvent('/aziende/coop/')],
      alerts: [{ specificCompanyKey: 'coop-genossenschaft', active: true }],
    }).reason).toBe('already_has_alert');
  });
});
