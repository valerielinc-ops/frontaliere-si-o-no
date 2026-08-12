/**
 * Dedup rules of the daily-brief email list (scripts/send-daily-brief.mjs).
 *
 * The whole point of the union is the measured 99,9% overlap between
 * job_alert_subscribers and newsletter_subscribers: summing them overstates
 * by ~45% (≈15k instead of ≈8.3k). These tests pin the rules that produce the
 * honest number: confirmed-only on the newsletter side, exclusion semantics
 * on the job-alert side, and the opt-out-wins override across channels.
 *
 * And, since #5677, the rule that outranks all three: NOTHING enters without
 * the recorded proof of the double-opt-in click. This file used to contain a
 * test named "a pending newsletter member still enters through an eligible job
 * alert", which pinned the defect as if it were the specification — 1.096
 * never-confirmed addresses were reachable that way. It is inverted below.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs module without type declarations
import { dedupeRecipients, hasConfirmationProof } from '../scripts/send-daily-brief.mjs';

const STAMP = '2026-01-15T10:00:00.000Z';

/** A newsletter row. `confirmed` rows carry the stamp, as the invariant requires. */
const nl = (email: string, status: string, locale = 'it') => ({
  email,
  status,
  locale,
  name: null,
  doc: status === 'confirmed' ? { status, confirmed_at: STAMP } : { status },
});
/** A row whose `status` claims something the document cannot back with a stamp. */
const nlNoStamp = (email: string, status: string, locale = 'it') => ({
  email, status, locale, name: null, doc: { status },
});
/** A row that carries the stamp whatever its status says (the re-probe shape). */
const nlStamped = (email: string, status: string, locale = 'it') => ({
  email, status, locale, name: null, doc: { status, confirmed_at: STAMP },
});
const ja = (email: string, status?: string) => ({ email, status, doc: { status } });

describe('dedupeRecipients', () => {
  it('unions by lowercased email instead of summing the two lists', () => {
    const { recipients, stats } = dedupeRecipients(
      [nl('a@example.com', 'confirmed'), nl('B@example.com', 'confirmed')],
      [ja('A@EXAMPLE.COM'), ja('b@example.com'), ja('c@example.com')],
    );
    expect(stats.union).toBe(3); // not 5
    expect(stats.overlap).toBe(2);
    expect(recipients.map((r) => r.email).sort()).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
  });

  it('newsletter side: confirmed in, pending out, excluded out', () => {
    const { recipients } = dedupeRecipients(
      [nl('conf@example.com', 'confirmed'), nl('pend@example.com', 'pending'), nl('unsub@example.com', 'unsubscribed')],
      [],
    );
    expect(recipients.map((r) => r.email)).toEqual(['conf@example.com']);
  });

  it('an explicit broadcast opt-out wins over job-alert membership', () => {
    const { recipients, stats } = dedupeRecipients(
      [nl('out@example.com', 'unsubscribed'), nl('bounced@example.com', 'bounced')],
      [ja('out@example.com', 'active'), ja('bounced@example.com', 'active')],
    );
    expect(recipients).toHaveLength(0);
    expect(stats.optOutWins).toBe(2);
  });

  it('job-alert exclusion statuses are respected on the job-alert side', () => {
    const { recipients } = dedupeRecipients(
      [],
      [ja('ok@example.com', 'active'), ja('gone@example.com', 'inactive'), ja('none@example.com', undefined)],
    );
    // undefined status = plain membership (root docs often carry no status)
    expect(recipients.map((r) => r.email).sort()).toEqual(['none@example.com', 'ok@example.com']);
  });

  it('order is deterministic: newsletter-confirmed first, then job-alert-only, alphabetical', () => {
    const { recipients } = dedupeRecipients(
      [nl('z@example.com', 'confirmed'), nl('a@example.com', 'confirmed')],
      [ja('m@example.com'), ja('b@example.com')],
    );
    expect(recipients.map((r) => r.email)).toEqual([
      'a@example.com', 'z@example.com', 'b@example.com', 'm@example.com',
    ]);
  });

  it('locale prefers the newsletter doc, falls back to job-alert, then it', () => {
    const { recipients } = dedupeRecipients(
      [nl('de@example.com', 'confirmed', 'de')],
      [{ email: 'fr@example.com', status: 'active', locale: 'fr', doc: {} }, ja('plain@example.com')],
    );
    const byEmail = Object.fromEntries(recipients.map((r) => [r.email, r.locale]));
    expect(byEmail['de@example.com']).toBe('de');
    expect(byEmail['fr@example.com']).toBe('fr');
    expect(byEmail['plain@example.com']).toBe('it');
  });
});

/**
 * #5677 — the double opt-in is binding.
 *
 * Production, 2026-08-12 (8.617 docs): 1.487 `pending`, of which 1.096 also sat
 * in job_alert_subscribers and therefore received the brief. The split that
 * decided the shape of the gate: 535 of those 1.096 carry `confirmed_at` (496
 * of them still carry the `confirm` event too) and were flipped to `pending`
 * by scripts/mailtrap-suppression-retry.mjs as a deliverability re-probe;
 * 561 carry no stamp and ZERO carry a `confirm` event — never confirmed.
 */
describe('the double opt-in is binding (#5677)', () => {
  it('a pending member with no confirmation stamp is blocked even by an eligible job alert', () => {
    const { recipients, stats } = dedupeRecipients(
      [nl('pend@example.com', 'pending')],
      [ja('pend@example.com', 'active')],
    );
    expect(recipients).toHaveLength(0);
    expect(stats.jobAlertBlockedUnconfirmed).toBe(1);
  });

  it('status "confirmed" without the stamp does not enter — from either side', () => {
    // The 392: marked confirmed by a recovery procedure that inferred consent.
    const { recipients, stats } = dedupeRecipients(
      [nlNoStamp('claimed@example.com', 'confirmed')],
      [ja('claimed@example.com', 'active')],
    );
    expect(recipients).toHaveLength(0);
    expect(stats.newsletterConfirmed).toBe(0);
    expect(stats.unconfirmedClaimedConfirmed).toBe(1);
  });

  it('a pending doc that DOES carry the stamp is not blocked: a re-probe is not a missing consent', () => {
    // The 535. They clicked; mailtrap-suppression-retry.mjs flipped the word.
    const { recipients } = dedupeRecipients(
      [nlStamped('reprobed@example.com', 'pending')],
      [ja('reprobed@example.com', 'active')],
    );
    expect(recipients.map((r) => r.email)).toEqual(['reprobed@example.com']);
    expect(recipients[0].source).toBe('job-alert');
  });

  it('no unconfirmed status reaches the union through any path', () => {
    for (const status of ['pending', 'confirmed', 'subscribed', '', 'active']) {
      const { recipients } = dedupeRecipients(
        [nlNoStamp('x@example.com', status)],
        [ja('x@example.com', 'active')],
      );
      expect(recipients, `status ${status || '(empty)'} leaked into the union`).toHaveLength(0);
    }
  });

  it('an address with NO newsletter doc still enters on job-alert membership alone', () => {
    // The gate must not over-block: job alerts have no double opt-in, the doc
    // exists because the user created the alert. Only an EXISTING newsletter
    // doc without a stamp blocks.
    const { recipients } = dedupeRecipients([], [ja('jaonly@example.com', 'active')]);
    expect(recipients.map((r) => r.email)).toEqual(['jaonly@example.com']);
  });

  it('hasConfirmationProof reads both field spellings, on the row or on the doc', () => {
    expect(hasConfirmationProof({ doc: { confirmed_at: STAMP } })).toBe(true);
    expect(hasConfirmationProof({ doc: { confirmedAt: STAMP } })).toBe(true);
    expect(hasConfirmationProof({ confirmed_at: STAMP })).toBe(true);
    expect(hasConfirmationProof({ doc: { status: 'confirmed' } })).toBe(false);
    expect(hasConfirmationProof({})).toBe(false);
    expect(hasConfirmationProof(null)).toBe(false);
  });

  it('a null/absent stamp is not proof — an empty string cannot pass as a timestamp', () => {
    expect(hasConfirmationProof({ doc: { confirmed_at: null } })).toBe(false);
    expect(hasConfirmationProof({ doc: { confirmed_at: '' } })).toBe(false);
  });
});
