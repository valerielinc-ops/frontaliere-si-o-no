import { describe, expect, it } from 'vitest';
import {
  classifyBounceSeverity,
  bounceUpdateFields,
  softBounceRecoveryFields,
  maybeEscalateSoftBounce,
  SOFT_ESCALATION_THRESHOLD,
} from '../functions/src/lib/bounceClassification.js';

function fakeSubscriberRef(initial: Record<string, unknown> = {}) {
  let data = { ...initial };
  const writes: Array<Record<string, unknown>> = [];
  return {
    get: async () => ({ exists: true, data: () => data }),
    set: async (update: Record<string, unknown>) => {
      data = { ...data, ...update };
      writes.push(update);
    },
    __writes: writes,
    __data: () => data,
  };
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
  });
});
