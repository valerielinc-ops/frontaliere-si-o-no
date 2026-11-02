import { describe, expect, it } from 'vitest';
import { claimDiscoveryDelivery, finalizeDiscoveryDelivery, discoveryCanAttempt, confirmedDiscoveryOutcome, DISCOVERY_RETRY_MS } from '../scripts/lib/job-alert-discovery-delivery.mjs';

function database(initial: Record<string, unknown> = {}) {
  let value = structuredClone(initial); let serial = Promise.resolve();
  const ref = {};
  const db = {
    collection: () => ({ doc: () => ref }),
    runTransaction: (work: (tx: unknown) => Promise<unknown>) => {
      const run = serial.then(() => work({ get: async () => ({ exists: true, data: () => structuredClone(value) }),
        set: (_ref: unknown, patch: Record<string, unknown>) => { value = { ...value, ...patch }; } }));
      serial = run.then(() => undefined, () => undefined); return run;
    },
  };
  return { db, read: () => value };
}
const email = 'reader@example.test';

describe('durable discovery delivery claim', () => {
  it('allows only one of two concurrent claims, across different alerts/runs', async () => {
    const store = database();
    const claims = await Promise.all([claimDiscoveryDelivery(store.db, email), claimDiscoveryDelivery(store.db, email)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(discoveryCanAttempt(store.read(), Date.now() + 100 * 86400000)).toBe(false);
  });

  it('keeps an unidentified acknowledgement unknown and never automatically retries it', async () => {
    const store = database(); const claim = await claimDiscoveryDelivery(store.db, email);
    await finalizeDiscoveryDelivery(store.db, email, claim, { provider: 'maileroo' });
    expect(store.read()).toMatchObject({ discovery_email: { state: 'unknown' } });
    expect(await claimDiscoveryDelivery(store.db, email, Date.now() + 100 * 86400000)).toBeNull();
  });

  it('does not call a timeout or ambiguous provider response sent', async () => {
    const store = database(); const claim = await claimDiscoveryDelivery(store.db, email);
    await finalizeDiscoveryDelivery(store.db, email, claim, { ambiguousDelivery: true }, true);
    expect(store.read()).toMatchObject({ discovery_email: { state: 'unknown' } });
    expect(confirmedDiscoveryOutcome({ provider: 'maileroo', messageId: 'ref', ambiguousDelivery: true })).toBe(false);
  });

  it('records identified acceptance and blocks any later discovery', async () => {
    const store = database(); const claim = await claimDiscoveryDelivery(store.db, email);
    await finalizeDiscoveryDelivery(store.db, email, claim, { provider: 'maileroo', messageId: 'ref' });
    expect(store.read()).toMatchObject({ discovery_email: { state: 'accepted', messageId: 'ref' } });
    expect(await claimDiscoveryDelivery(store.db, email)).toBeNull();
  });

  it('retries only definitive failures after backoff, with a stable delivery identity and at most three attempts', async () => {
    const store = database(); let now = Date.now(); let firstId;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claim = await claimDiscoveryDelivery(store.db, email, now);
      firstId ??= claim.deliveryId; expect(claim.deliveryId).toBe(firstId); expect(claim.attempts).toBe(attempt);
      await finalizeDiscoveryDelivery(store.db, email, claim, { error: 'explicit rejection' }, true, now);
      expect(await claimDiscoveryDelivery(store.db, email, now + 1)).toBeNull();
      now += DISCOVERY_RETRY_MS;
    }
    expect(await claimDiscoveryDelivery(store.db, email, now)).toBeNull();
  });

  it('ignores a stale outcome for an earlier attempt', async () => {
    const store = database(); const now = Date.now(); const first = await claimDiscoveryDelivery(store.db, email, now);
    await finalizeDiscoveryDelivery(store.db, email, first, {}, true, now);
    const second = await claimDiscoveryDelivery(store.db, email, now + DISCOVERY_RETRY_MS);
    await finalizeDiscoveryDelivery(store.db, email, first, { provider: 'maileroo', messageId: 'old' });
    expect(store.read()).toMatchObject({ discovery_email: { state: 'pending', attemptId: second.attemptId } });
  });
});
