import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { reportRunnerFailure } from '../scripts/assisted-application/report-runner-failure.mjs';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';

const now = Date.now();
const orderId = 'order_boot_test';
const base = `assisted_applications/${orderId}`;
function fixture() {
  return createMemoryFirestore({
    [base]: { paymentStatus: 'paid', submissionStatus: 'in_progress' },
    [`${base}/automation/flow`]: { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1, requestedAt: now - 1000, attempts: 1 } },
  });
}
const context = { orderId, mode: 'submit', round: 1, runId: '1234567', startedAt: now, nowMs: now + 1000 };
const eventPath = `${base}/automation_events/runner-1234567-failure`;

describe('failed executor reconciliation', () => {
  it('reports a startup failure once and lets the normal FSM retry instead of waiting for the watchdog', async () => {
    const store = fixture();
    expect(await reportRunnerFailure({ db: store.db, ...context })).toMatchObject({ reported: true });
    expect(await reportRunnerFailure({ db: store.db, ...context })).toMatchObject({ reported: false, reason: 'already_reported' });
    const event = store.read(eventPath);
    expect(event.error).toBe('runner_infrastructure_unavailable');
    expect(JSON.stringify(event)).not.toContain(orderId);
    const result = transition(store.read(`${base}/automation/flow`), event, { nowMs: now + 1000 });
    expect(result.flow.state).toBe('submitting');
    expect(result.effects).toEqual([expect.objectContaining({ type: 'dispatch', mode: 'submit' })]);
  });

  it.each([
    { kind: 'email', record: { state: 'sending', channel: 'email', startedAt: now }, expected: 'email_ambiguous' },
    { kind: 'portal', record: { state: 'sending', channel: 'portal', clickedAt: now }, expected: 'portal_ambiguous' },
    { kind: 'portal sending before click', record: { state: 'sending', channel: 'portal', startedAt: now, clickedAt: null }, expected: 'runner_infrastructure_unavailable' },
    { kind: 'failed after click', record: { state: 'failed', channel: 'portal', clickedAt: now, releasedAt: now + 1 }, expected: 'portal_ambiguous' },
    { kind: 'confirmed refusal after click', record: { state: 'failed', channel: 'portal', reason: 'portal_refused', clickedAt: now, confirmedNotSent: true, releasedAt: now + 1 }, expected: 'runner_infrastructure_unavailable' },
    { kind: 'failed before click', record: { state: 'failed', channel: 'portal', clickedAt: null, releasedAt: now + 1 }, expected: 'runner_infrastructure_unavailable' },
  ])('respects the durable $kind outcome', async ({ kind, record, expected }) => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, { r1: record });
    await reportRunnerFailure({ db: store.db, ...context });
    const event = store.read(eventPath);
    expect(event.type).toBe('submit_failed');
    expect(event.error).toBe(expected);
    const result = transition(store.read(`${base}/automation/flow`), event, { nowMs: now + 1000 });
    expect(result.flow.state).toBe(expected === 'runner_infrastructure_unavailable' ? 'submitting' : 'owner_takeover');
    expect(result.effects.some(effect => effect.type === 'dispatch')).toBe(expected === 'runner_infrastructure_unavailable');
    if (kind === 'portal sending before click') {
      expect(store.read(`${base}/automation/submission`)?.r1).toMatchObject({
        state: 'failed', reason: 'runner_infrastructure_unavailable', releasedAt: now + 1000,
        clickedAt: null, confirmedNotSent: true,
      });
    }
  });

  it('treats a durable sent record as success instead of retrying', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, { r1: { state: 'sent', channel: 'portal', sentAt: now, clickedAt: now - 1 } });

    await reportRunnerFailure({ db: store.db, ...context });

    expect(store.read(eventPath)).toMatchObject({ type: 'submit_succeeded', channel: 'portal' });
  });

  it('does not let a runner reclaim a failed portal attempt after its click', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, { r1: { state: 'failed', channel: 'portal', clickedAt: now, releasedAt: now + 1 } });

    const result = await submissionGuard(store.db, orderId, 1).claim('portal', now + 2, { resumable: true });

    expect(result).toMatchObject({ status: 'in_flight', record: { state: 'failed', clickedAt: now } });
    expect(store.read(`${base}/automation/submission`)?.r1).toMatchObject({ state: 'failed', clickedAt: now });
  });

  it('reclaims a click only after release recorded a confirmed no-send outcome', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, { r1: {
      state: 'failed', channel: 'portal', clickedAt: now, confirmedNotSent: true, releasedAt: now + 1,
    } });

    const result = await submissionGuard(store.db, orderId, 1).claim('portal', now + 2);

    expect(result).toMatchObject({ status: 'claimed' });
    expect(store.read(`${base}/automation/submission`)?.r1).toMatchObject({
      state: 'sending', clickedAt: null, confirmedNotSent: false,
    });
  });

  it('does not let a second automated portal run reuse an unreconciled pre-click claim', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, { r1: { state: 'sending', channel: 'portal', startedAt: now, clickedAt: null } });

    const result = await submissionGuard(store.db, orderId, 1).claim('portal', now + 2);

    expect(result).toMatchObject({ status: 'in_flight', record: { state: 'sending', clickedAt: null } });
  });

  it.each(['dry_run', 'withdrawn', 'purged', 'unpaid', 'submitted', 'new_dispatch', 'new_round', 'already_stopped'])('does not move %s', async kind => {
    const store = fixture();
    if (kind === 'withdrawn') store.docs.set(base, { ...store.read(base), withdrawnAt: now });
    if (kind === 'purged') store.docs.set(base, { ...store.read(base), retentionPurgedAt: now });
    if (kind === 'unpaid') store.docs.set(base, { paymentStatus: 'pending' });
    if (kind === 'submitted') store.docs.set(base, { ...store.read(base), submissionStatus: 'submitted' });
    if (kind === 'new_dispatch') store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), dispatch: { requestedAt: now + 1 } });
    if (kind === 'new_round') store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), round: 2 });
    if (kind === 'already_stopped') store.docs.set(`${base}/automation/flow`, { state: 'owner_takeover', round: 1 });
    expect(await reportRunnerFailure({ db: store.db, ...context, ...(kind === 'dry_run' ? { mode: 'dry_run' } : {}) })).toMatchObject({ reported: false });
    expect(store.read(eventPath)).toBeUndefined();
  });
});
