import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { reportRunnerFailure } from '../scripts/assisted-application/report-runner-failure.mjs';
import { transition } from '../functions/src/assistedApplicationFlow.js';

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

  it.each(['email', 'portal', 'sent'])('respects the durable %s outcome', async kind => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, { r1: { state: kind === 'sent' ? 'sent' : 'sending', channel: kind === 'email' ? 'email' : 'portal', clickedAt: kind === 'portal' ? now : null } });
    await reportRunnerFailure({ db: store.db, ...context });
    const event = store.read(eventPath);
    expect(event.type).toBe(kind === 'sent' ? 'submit_succeeded' : 'submit_failed');
    if (kind !== 'sent') expect(event.error).toBe(`${kind}_ambiguous`);
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
