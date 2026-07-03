import { describe, expect, it } from 'vitest';
import {
  classifyBounceSeverity,
  bounceUpdateFields,
  softBounceRecoveryFields,
  maybeEscalateSoftBounce,
  SOFT_ESCALATION_THRESHOLD,
} from '../functions/src/lib/bounceClassification.js';

/**
 * Fake Firestore document + `.firestore.runTransaction` double that mirrors
 * real Firestore's optimistic-concurrency contract: reads are snapshotted at
 * transaction start, and if ANY writer (including another concurrent
 * transaction, or a plain `.set()`) touches the document before this
 * transaction commits, Firestore transparently retries the transaction body
 * against a fresh read. This lets tests simulate the two-webhook race
 * described in #3206 item 3 without a real Firestore emulator.
 */
function fakeSubscriberRef(initial: Record<string, unknown> = {}) {
  let data = { ...initial };
  let version = 0;
  const writes: Array<Record<string, unknown>> = [];
  let armedConcurrentWrite: (() => void) | null = null;
  let armedFired = false;

  const ref: any = {
    get: async () => ({ exists: true, data: () => ({ ...data }) }),
    set: async (update: Record<string, unknown>, opts?: { merge?: boolean }) => {
      data = opts?.merge ? { ...data, ...update } : { ...update };
      version += 1;
      writes.push(update);
    },
    __writes: writes,
    __data: () => data,
    // Arms a one-shot side effect that fires the first time a transaction
    // calls `tx.get()` — simulating a genuinely concurrent write (e.g. a
    // delivery/open recovery reset from another webhook delivery) landing
    // between this transaction's read and its commit.
    __armConcurrentWrite: (fn: () => void) => {
      armedConcurrentWrite = fn;
      armedFired = false;
    },
  };

  ref.firestore = {
    runTransaction: async (updateFunction: (tx: any) => Promise<unknown>) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const versionAtStart = version;
        const snapshotData = { ...data };
        let pendingWrite: Record<string, unknown> | null = null;
        const tx = {
          get: async () => {
            if (armedConcurrentWrite && !armedFired) {
              armedFired = true;
              armedConcurrentWrite();
            }
            return { exists: true, data: () => ({ ...snapshotData }) };
          },
          set: (_ref: unknown, update: Record<string, unknown>, opts?: { merge?: boolean }) => {
            pendingWrite = opts?.merge ? { ...snapshotData, ...update } : { ...update };
          },
        };
        const result = await updateFunction(tx);
        if (version !== versionAtStart) continue; // conflicting write mid-transaction — retry
        if (pendingWrite) {
          data = pendingWrite;
          version += 1;
          writes.push(pendingWrite);
        }
        return result;
      }
      throw new Error('fakeSubscriberRef: too many transaction retries');
    },
  };

  return ref;
}

describe('bounceClassification', () => {
  describe('classifyBounceSeverity', () => {
    it('mailjet: blocked is always soft', () => {
      expect(classifyBounceSeverity({ provider: 'mailjet', rawEvent: 'blocked', eventData: {} })).toBe('soft');
    });

    it('mailjet: bounce with hard_bounce flag is hard', () => {
      expect(classifyBounceSeverity({ provider: 'mailjet', rawEvent: 'bounce', eventData: { hard_bounce: true } })).toBe('hard');
    });

    it('mailjet: bounce without hard_bounce flag is soft', () => {
      expect(classifyBounceSeverity({ provider: 'mailjet', rawEvent: 'bounce', eventData: {} })).toBe('soft');
    });

    it('maileroo: rejected is soft, failed is hard', () => {
      expect(classifyBounceSeverity({ provider: 'maileroo', rawEvent: 'rejected', eventData: {} })).toBe('soft');
      expect(classifyBounceSeverity({ provider: 'maileroo', rawEvent: 'failed', eventData: {} })).toBe('hard');
    });

    it('mailtrap: soft_bounce and reject are soft, bounce is hard', () => {
      expect(classifyBounceSeverity({ provider: 'mailtrap', rawEvent: 'soft_bounce', eventData: {} })).toBe('soft');
      expect(classifyBounceSeverity({ provider: 'mailtrap', rawEvent: 'reject', eventData: {} })).toBe('soft');
      expect(classifyBounceSeverity({ provider: 'mailtrap', rawEvent: 'bounce', eventData: {} })).toBe('hard');
    });

    it('mailgun: severity=temporary is soft, permanent is hard', () => {
      expect(classifyBounceSeverity({ provider: 'mailgun', rawEvent: 'failed', eventData: { severity: 'temporary' } })).toBe('soft');
      expect(classifyBounceSeverity({ provider: 'mailgun', rawEvent: 'failed', eventData: { severity: 'permanent' } })).toBe('hard');
      expect(classifyBounceSeverity({ provider: 'mailgun', rawEvent: 'rejected', eventData: {} })).toBe('soft');
    });

    it('resend: transient/undetermined bounce.type is soft, otherwise hard', () => {
      expect(classifyBounceSeverity({ provider: 'resend', rawEvent: 'email.bounced', eventData: { bounce: { type: 'Transient' } } })).toBe('soft');
      expect(classifyBounceSeverity({ provider: 'resend', rawEvent: 'email.bounced', eventData: { bounce: { type: 'Undetermined' } } })).toBe('soft');
      expect(classifyBounceSeverity({ provider: 'resend', rawEvent: 'email.bounced', eventData: {} })).toBe('hard');
    });
  });

  describe('bounceUpdateFields', () => {
    it('hard: sets permanent bounced status and resets the soft counter', () => {
      const fields = bounceUpdateFields({ severity: 'hard', reason: 'user unknown' });
      expect(fields.status).toBe('bounced');
      expect(fields.bounce_severity).toBe('hard');
      expect(fields.bounce_reason).toBe('user unknown');
      expect(fields.soft_bounce_count).toBe(0);
    });

    it('soft: never sets status, only tracks the counter', () => {
      const fields = bounceUpdateFields({ severity: 'soft', reason: 'greylisted' });
      expect(fields.status).toBeUndefined();
      expect(fields.bounce_severity).toBe('soft');
      expect(fields.bounce_reason).toBe('greylisted');
      expect(fields.soft_bounce_count).toBeDefined();
    });
  });

  it('softBounceRecoveryFields resets the counter to zero', () => {
    expect(softBounceRecoveryFields()).toEqual({ soft_bounce_count: 0 });
  });

  describe('maybeEscalateSoftBounce', () => {
    it('does not escalate below the threshold', async () => {
      const ref = fakeSubscriberRef({ soft_bounce_count: SOFT_ESCALATION_THRESHOLD - 1, status: 'confirmed' });
      const escalated = await maybeEscalateSoftBounce(ref as any, 'greylisted');
      expect(escalated).toBe(false);
      expect(ref.__data().status).toBe('confirmed');
    });

    it('escalates to a permanent bounced status once the threshold is reached', async () => {
      const ref = fakeSubscriberRef({ soft_bounce_count: SOFT_ESCALATION_THRESHOLD, status: 'confirmed' });
      const escalated = await maybeEscalateSoftBounce(ref as any, 'greylisted');
      expect(escalated).toBe(true);
      expect(ref.__data().status).toBe('bounced');
      expect(ref.__data().bounce_severity).toBe('hard');
      expect(String(ref.__data().bounce_reason)).toContain('escalated after');
    });

    it('is a no-op if already bounced', async () => {
      const ref = fakeSubscriberRef({ soft_bounce_count: SOFT_ESCALATION_THRESHOLD + 5, status: 'bounced' });
      const escalated = await maybeEscalateSoftBounce(ref as any, 'greylisted');
      expect(escalated).toBe(false);
    });

    // Race-condition regression coverage for #3206 item 3: maybeEscalateSoftBounce
    // used to .get() then .set() with no transaction, so a write landing between
    // the read and the write could be silently clobbered or read stale.
    it('re-evaluates against a concurrent recovery reset instead of escalating on stale data', async () => {
      // At the threshold, a plain read-then-write would escalate on the stale
      // pre-reset count. A recovery (delivered/open) event lands for the SAME
      // subscriber between this transaction's read and its commit — Firestore
      // transactions retry on that kind of conflicting write, so the decision
      // must be re-made against the fresh, reset count.
      const ref = fakeSubscriberRef({ soft_bounce_count: SOFT_ESCALATION_THRESHOLD, status: 'confirmed' });
      ref.__armConcurrentWrite(() => {
        ref.set(softBounceRecoveryFields(), { merge: true });
      });

      const escalated = await maybeEscalateSoftBounce(ref as any, 'greylisted');

      expect(escalated).toBe(false);
      expect(ref.__data().status).toBe('confirmed');
      expect(ref.__data().soft_bounce_count).toBe(0);
    });

    it('two concurrent calls at the threshold both settle on the same consistent escalated state', async () => {
      // Two ESP webhook retries for the same subscriber calling this function
      // at (or above) the threshold at the same time must not race to
      // inconsistent final state — exactly one net escalation, both calls
      // agree on the outcome.
      const ref = fakeSubscriberRef({ soft_bounce_count: SOFT_ESCALATION_THRESHOLD, status: 'confirmed' });

      const [first, second] = await Promise.all([
        maybeEscalateSoftBounce(ref as any, 'greylisted'),
        maybeEscalateSoftBounce(ref as any, 'greylisted'),
      ]);

      // Exactly one of the two calls performed the escalation; the other is a
      // no-op once it observes the already-bounced status via its (retried)
      // fresh read.
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(ref.__data().status).toBe('bounced');
      expect(ref.__data().bounce_severity).toBe('hard');
    });
  });
});
