import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { applyAutomationEvent } = await import('../functions/src/assistedApplicationAutomation.js');
const { loadAutomationForAdmin } = await import('../functions/src/assistedApplicationAutomationAdmin.js');
const { ambiguousSendOpen } = await import('../functions/src/lib/applicationExistsReconciliation.js');

const ORDER = 'order_ambiguous_event_gate';
const ROOT = `assisted_applications/${ORDER}`;
const T0 = Date.UTC(2026, 9, 30, 19, 57);
const runEffect = async () => ({ ok: true });

type Seed = { events?: Array<Record<string, unknown>>; audit?: Array<Record<string, unknown>>; hold?: string };
async function seed({ events = [], audit = [], hold = 'portal:account' }: Seed = {}) {
  // The order of the incident: a later attempt overwrote the record, nothing on the flow remembers the click.
  const store = createMemoryFirestore({
    [ROOT]: { paymentStatus: 'paid', submissionStatus: 'in_progress' },
    [`${ROOT}/automation/flow`]: { state: 'owner_takeover', round: 1, heldBy: [hold], dispatch: { mode: 'submit', round: 1, attempts: 1 }, answers: {} },
    [`${ROOT}/ai_drafts/current`]: { round: 1, status: 'ready', questions: [] },
    [`${ROOT}/automation/submission`]: { r1: { state: 'failed', channel: 'portal', clickedAt: null, priorClickedAt: null, confirmedNotSent: true } },
  });
  for (const event of events) await store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').add(event);
  for (const record of audit) await store.db.collection('assisted_applications').doc(ORDER).collection('events').add(record);
  return store;
}
const ambiguous = (over: Record<string, unknown> = {}) => ({ type: 'submit_failed', error: 'portal_ambiguous', round: 1, createdAt: T0, ...over });
const retry = (store: any, event: Record<string, unknown> = {}) => applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'owner_retry_submit', ...event }, actor: 'owner:test', runEffect, nowMs: T0 + 60_000 });

describe('ambiguous runner events of the round gate the retry', () => {
  it('refuses the retry and raises the panel flag although the record says «not sent»', async () => {
    const store = await seed({ events: [ambiguous()] });
    expect(await retry(store)).toMatchObject({ ok: false, ignored: 'send_outcome_unconfirmed' });
    expect(store.read(`${ROOT}/automation/flow`)).toMatchObject({ state: 'owner_takeover' });
    const view: any = await loadAutomationForAdmin(store.db, ORDER, {});
    expect(view.flow.sendOutcomeUnconfirmed).toBe(true);
  });

  it('the owner\'s explicit confirmation unblocks it, and leaves the proof that keeps later retries free', async () => {
    const store = await seed({ events: [ambiguous()] });
    expect(await retry(store, { confirmedNotSent: true })).toMatchObject({ ok: true, flow: { state: 'submitting' } });
    const audit = [...store.docs.entries()].filter(([path]) => path.startsWith(`${ROOT}/events/`)).map(([, data]) => data as any);
    expect(audit.some((record) => record.eventType === 'owner_retry_submit' && record.confirmedNotSent === true && record.round === 1)).toBe(true);
  });

  it('does not block on an ambiguous event of another round, nor on a non-ambiguous failure', async () => {
    const other = await seed({ events: [ambiguous({ round: 2 })] });
    expect(await retry(other)).toMatchObject({ ok: true, flow: { state: 'submitting' } });
    expect(((await loadAutomationForAdmin(other.db, ORDER, {})) as any).flow.sendOutcomeUnconfirmed).toBe(false);
    const validation = await seed({ events: [ambiguous({ error: 'portal_validation' })] });
    expect(await retry(validation)).toMatchObject({ ok: true });
  });

  it('does not block when a proof of not-sent is recorded for that event, and still blocks on a bare release', async () => {
    const proven = await seed({ events: [ambiguous()], audit: [{ eventType: 'portal_final_review_ambiguous_reconciled', round: 1, createdAt: T0 + 1000 }] });
    expect(await retry(proven)).toMatchObject({ ok: true, flow: { state: 'submitting' } });
    // The proof is for the events before it: a later ambiguous event is open again.
    const later = await seed({ events: [ambiguous(), ambiguous({ createdAt: T0 + 5000 })], audit: [{ eventType: 'portal_final_review_ambiguous_reconciled', round: 1, createdAt: T0 + 1000 }] });
    expect(await retry(later)).toMatchObject({ ok: false, ignored: 'send_outcome_unconfirmed' });
    // A retry without the explicit confirmation, or the record's own confirmedNotSent, is no proof.
    const bare = await seed({ events: [ambiguous()], audit: [{ eventType: 'owner_retry_submit', round: 1, createdAt: T0 + 1000 }] });
    expect(await retry(bare)).toMatchObject({ ok: false, ignored: 'send_outcome_unconfirmed' });
  });

  it('the clock\'s retry is held by the same evidence', async () => {
    const store = await seed({ events: [ambiguous()], hold: 'portal:portal_needs_candidate' });
    store.docs.set(`${ROOT}/automation/flow`, { ...store.read(`${ROOT}/automation/flow`), portalAutoRetryAt: T0, portalAutoRetryCount: 0 });
    const result = await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'portal_auto_retry' }, actor: 'clock', runEffect, nowMs: T0 + 60_000 });
    expect(result).toMatchObject({ ok: false, ignored: 'send_outcome_unconfirmed' });
  });
});

describe('ambiguousSendOpen (pure)', () => {
  const event = { error: 'email_ambiguous', round: 1, createdAt: 100 };
  it.each([
    ['no events', { runnerEvents: [] }, false],
    ['an ambiguous event', { runnerEvents: [event] }, true],
    ['another round', { runnerEvents: [{ ...event, round: 2 }] }, false],
    ['proof after the event', { runnerEvents: [event], proofs: [{ eventType: 'portal_final_review_ambiguous_reconciled', round: 1, createdAt: 200 }] }, false],
    ['proof before the event', { runnerEvents: [event], proofs: [{ eventType: 'portal_final_review_ambiguous_reconciled', round: 1, createdAt: 50 }] }, true],
    ['proof of another round', { runnerEvents: [event], proofs: [{ eventType: 'portal_final_review_ambiguous_reconciled', round: 2, createdAt: 200 }] }, true],
    ['owner retry without the confirmation', { runnerEvents: [event], proofs: [{ eventType: 'owner_retry_submit', round: 1, createdAt: 200 }] }, true],
    ['owner retry with the confirmation', { runnerEvents: [event], proofs: [{ eventType: 'owner_retry_submit', round: 1, confirmedNotSent: true, createdAt: 200 }] }, false],
    ['an event with an unreadable time stays open whatever the proof', { runnerEvents: [{ ...event, createdAt: null }], proofs: [{ eventType: 'portal_final_review_ambiguous_reconciled', round: 1, createdAt: 1000 }] }, true],
    ['an event with no time stays open even after the owner confirmation', { runnerEvents: [{ error: 'portal_ambiguous', round: 1 }], proofs: [{ eventType: 'owner_retry_submit', round: 1, confirmedNotSent: true, createdAt: 1000 }] }, true],
    ['proof with an unreadable time', { runnerEvents: [event], proofs: [{ eventType: 'portal_final_review_ambiguous_reconciled', round: 1 }] }, true],
  ] as Array<[string, any, boolean]>)('%s -> open=%s', (_name, input, open) => {
    expect(ambiguousSendOpen({ round: 1, ...input })).toBe(open);
  });
});
