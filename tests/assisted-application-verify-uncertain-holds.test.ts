import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { requestPortalVerification, executePortalVerification } = await import('../scripts/assisted-application/verify-portal.mjs');
const { applicationExistsProbeEntry, applicationExistsProbeNavigation } = await import('../functions/src/lib/applicationExistsReconciliation.js');
const { runAutomationEffect } = await import('../functions/src/assistedApplicationAutomationEffects.js');

const now = Date.now();
const version = 'b'.repeat(64);
const orderId = 'test_uncertain_order';
const base = `assisted_applications/${orderId}`;
const HOST = 'recruitingapp-0000.umantis.com';
const ALIAS = 'maria.rossi.abcd@candidature.frontaliereticino.ch';
const applyUrl = `https://${HOST}/Vacancies/6604/Description/1`;
const hostKey = HOST.replace(/[^a-z0-9-]/g, '_');
const bucket = { file: () => ({ save: async () => {}, delete: async () => {}, download: async () => { throw new Error('no_source'); } }) } as any;

type Over = { hold?: string; claim?: Record<string, unknown> | null; events?: Array<Record<string, unknown>>; marker?: unknown; accountEmail?: string; apply?: string };
function fixture(over: Over = {}) {
  const docs: Record<string, unknown> = {
    [base]: { paymentStatus: 'paid', submissionStatus: 'in_progress', consentVersion: 'assisted-application-v2', consentedAt: now - 20000, cvUploadedAt: now - 10000, candidateAlias: { address: ALIAS, active: true } },
    [`${base}/automation/flow`]: { state: 'owner_takeover', round: 1, heldBy: [over.hold ?? 'portal:account_application_history_uncertain'], dispatch: { mode: 'submit', round: 1, requestedAt: now - 5000 }, ...(over.marker ? { ambiguousSubmit: over.marker } : {}) },
    [`${base}/ai_drafts/current`]: { status: 'ready', round: 1, channel: { type: 'umantis', applyUrl: over.apply ?? applyUrl }, job: { title: 'Ruolo di prova' } },
    [`${base}/automation/submission`]: { r1: over.claim === undefined ? { state: 'failed', channel: 'portal', startedAt: now - 2000, clickedAt: null, confirmedNotSent: true } : over.claim },
    [`${base}/automation/accounts`]: { [hostKey]: { email: over.accountEmail ?? ALIAS, status: 'verified' } },
  };
  const store = createMemoryFirestore(docs as any);
  return { store, seedEvents: async () => { for (const event of over.events || []) await store.db.collection('assisted_applications').doc(orderId).collection('automation_events').add(event); } };
}
const ambiguousEvent = { type: 'submit_failed', error: 'portal_ambiguous', round: 1 };

async function request(over: Over) {
  const { store, seedEvents } = fixture(over);
  await seedEvents();
  const result = await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce: 'test-uncertain-nonce', nowMs: now });
  return { store, result };
}

describe('verification of an uncertain hold whose claim a later run released', () => {
  it.each([
    ['history_uncertain hold + ambiguous runner event', { events: [ambiguousEvent] }, true],
    ['already_applied hold + surviving priorClickedAt', { hold: 'portal:account_application_already_applied', claim: { state: 'failed', channel: 'portal', priorClickedAt: now - 9000, confirmedNotSent: true }, events: [] }, true],
    ['history_uncertain hold + flow marker', { marker: { round: 1, at: now - 9000, error: 'portal_ambiguous' }, events: [] }, true],
    ['portal_ambiguous hold + released claim + event', { hold: 'portal_ambiguous', events: [ambiguousEvent] }, true],
    ['no evidence of a send of ours', { events: [] }, false],
    ['an event of another round only', { events: [{ ...ambiguousEvent, round: 2 }] }, false],
    ['an event that is not an ambiguous send', { events: [{ type: 'submit_failed', error: 'portal_validation', round: 1 }] }, false],
    ['a hold that says nothing about a send', { hold: 'portal:account', events: [ambiguousEvent] }, false],
    ['already sent', { claim: { state: 'sent', channel: 'portal', priorClickedAt: now - 9000 }, events: [ambiguousEvent] }, false],
    ['email claim', { claim: { state: 'failed', channel: 'email', priorClickedAt: now - 9000 }, events: [ambiguousEvent] }, false],
  ] as Array<[string, Over, boolean]>)('%s -> eligible=%s', async (_name, over, eligible) => {
    expect((await request(over)).result.requested).toBe(eligible);
  });

  it('allows at most three inspections of the same state, one at a time', async () => {
    const { store, seedEvents } = fixture({ events: [ambiguousEvent] });
    await seedEvents();
    const ask = (nonce: string, t: number) => requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: t });
    expect(await ask('nonce-aaaaaaaaaaaaaaaa', now)).toMatchObject({ requested: true });
    expect(await ask('nonce-bbbbbbbbbbbbbbbb', now + 1)).toMatchObject({ requested: false, reason: 'already_requested' });
    for (const [index, t] of [now + 40 * 60_000, now + 80 * 60_000].entries()) {
      expect(await ask(`nonce-cccccccccccccc${index}`, t)).toMatchObject({ requested: true });
    }
    expect(await ask('nonce-dddddddddddddddd', now + 120 * 60_000)).toMatchObject({ requested: false, reason: 'inspection_limit' });
  });
});

describe('inspection that ends in the portal\'s «application exists» page', () => {
  async function run(over: Over, live: { vacancyId: string } | null) {
    const { store, seedEvents } = fixture({ events: [ambiguousEvent], ...over });
    await seedEvents();
    await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce: 'test-uncertain-nonce', nowMs: now });
    const inspectExists = vi.fn(async () => ({ conclusion: 'unknown', pages: [], applicationExists: live
      ? { routeKind: 'umantis_application_exists', host: HOST, vacancyId: live.vacancyId, pagePath: `/Vacancies/${live.vacancyId}/FurtherApplication/ApplicationExists/9` } : null }));
    const effects: string[] = [];
    const runEffect = async (context: any) => { effects.push(context.effect.type); return context.effect.type === 'mark_submitted' ? runAutomationEffect(context) : { ok: true }; };
    const result = await executePortalVerification({ db: store.db, bucket, orderId, round: 1, nonce: 'test-uncertain-nonce', version, key: Buffer.alloc(32, 7), nowMs: now + 10, inspectExists, runEffect });
    return { store, result, inspectExists, effects };
  }

  it('settles the order as sent when the vacancy, the alias account and our send agree', async () => {
    const { store, result, inspectExists } = await run({}, { vacancyId: '6604' });
    expect(inspectExists).toHaveBeenCalledWith(expect.objectContaining({ targetUrl: `https://${HOST}/Vacancies/6604/Application/New/1`, probe: expect.objectContaining({ vacancyId: '6604' }), allowRecovery: true, aliasEmail: ALIAS }));
    expect(result).toMatchObject({ inspected: true, recorded: true, conclusion: 'application_exists' });
    expect(store.read(`${base}/automation/flow`)).toMatchObject({ state: 'submitted' });
    expect(store.read(`${base}/automation/submission`).r1).toMatchObject({ state: 'sent', receipt: { proofKind: 'portal_application_exists' } });
    expect(store.read(`${base}/automation/portal_verification`)).toMatchObject({ state: 'completed', conclusion: 'application_exists' });
  });

  it('stays unknown and unchanged when the page belongs to another vacancy', async () => {
    const { store, result } = await run({}, { vacancyId: '9999' });
    expect(result).toMatchObject({ inspected: true, conclusion: 'unknown' });
    expect(store.read(`${base}/automation/flow`)).toMatchObject({ state: 'owner_takeover' });
    expect(store.read(`${base}/automation/submission`).r1).toMatchObject({ state: 'failed' });
  });

  it('stays unknown when the portal does not answer with the page, or the account is not the order alias', async () => {
    expect((await run({}, null)).result).toMatchObject({ conclusion: 'unknown' });
    const other = await run({ accountEmail: 'someone.else@example.test' }, { vacancyId: '6604' });
    expect(other.result).toMatchObject({ conclusion: 'unknown' });
    expect(other.store.read(`${base}/automation/flow`)).toMatchObject({ state: 'owner_takeover' });
  });

  it('never inspects a portal without an application-exists route', async () => {
    const { result, inspectExists } = await run({ apply: 'https://careers.example/job?id=1' }, { vacancyId: '6604' });
    expect(inspectExists).not.toHaveBeenCalled();
    expect(result).toMatchObject({ conclusion: 'unknown' });
  });
});

describe('the read-only fence of the inspection', () => {
  const probe = applicationExistsProbeEntry(applyUrl)!;
  it('derives the entry from the order\'s own vacancy only', () => {
    expect(probe).toMatchObject({ vacancyId: '6604', entryUrl: `https://${HOST}/Vacancies/6604/Application/New/1` });
    expect(applicationExistsProbeEntry('http://' + HOST + '/Vacancies/6604/Description/1')).toBeNull();
    expect(applicationExistsProbeEntry('https://example.test/Vacancies/6604/Description/1')).toBeNull();
  });
  it.each([
    [`https://${HOST}/Vacancies/6604/Application/New/1`, true],
    [`https://${HOST}/Vacancies/6604/Application/Login/1`, true],
    [`https://${HOST}/Vacancies/6604/FurtherApplication/ApplicationExists/9`, true],
    [`https://${HOST}/Vacancies/1234/Application/New/1`, false],
    [`https://${HOST}/Vacancies/6604/Application/Submit/1`, false],
    [`https://${HOST}/Vacancies/6604/Application/Finish/1`, false],
    [`https://other.umantis.com/Vacancies/6604/Application/New/1`, false],
    [`https://${HOST}/Vacancies/6604/Application/New/1#x`, false],
  ])('navigation %s -> %s', (url, allowed) => {
    expect(applicationExistsProbeNavigation(url, probe)).toBe(allowed);
  });
});

describe('an inspection that throws is recorded with where and what, never with its message', () => {
  it('stores the stage and the error class as identifiers, and stays unknown', async () => {
    const { decryptJson } = await import('../scripts/assisted-application/lib/secure-run.mjs');
    const key = Buffer.alloc(32, 7);
    const saved: string[] = [];
    const capturing = { file: () => ({ save: async (data: string) => { saved.push(data); }, delete: async () => {}, download: async () => { throw new Error('no_source'); } }) } as any;
    const { store, seedEvents } = fixture({ events: [ambiguousEvent] });
    await seedEvents();
    await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce: 'test-uncertain-nonce', nowMs: now });
    const inspectExists = vi.fn(async () => { throw new TypeError("Cannot read properties of undefined (reading 'secret-field') for candidate@example.test"); });
    const result = await executePortalVerification({ db: store.db, bucket: capturing, orderId, round: 1, nonce: 'test-uncertain-nonce', version, key, nowMs: now + 10, inspectExists });
    expect(result).toMatchObject({ inspected: true, conclusion: 'unknown' });
    const payload: any = decryptJson(JSON.parse(saved[0]), key);
    expect(payload.proof).toEqual({ conclusion: 'unknown', reason: 'inspection_unavailable', error: { stage: 'inspect', name: 'TypeError', message: 'read_of_undefined' } });
    expect(JSON.stringify(payload)).not.toContain('candidate@example.test');
    expect(store.read(`${base}/automation/flow`)).toMatchObject({ state: 'owner_takeover' });
  });
});
