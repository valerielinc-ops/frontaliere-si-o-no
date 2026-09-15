/**
 * Dedup rules of the daily-brief email list (scripts/send-daily-brief.mjs).
 *
 * The whole point of the union is the measured 99,9% overlap between
 * job_alert_subscribers and newsletter_subscribers: summing them overstates
 * by ~45% (≈15k instead of ≈8.3k). These tests pin the rules that produce the
 * honest number: all non-excluded subscriber rows on the newsletter side,
 * exclusion semantics on the job-alert side, and the opt-out-wins override
 * across channels.
 *
 * A missing double-opt-in proof does not block an ordinary brief. The proof is
 * retained for the confirmation-request and audit paths; delivery here is
 * controlled by channel membership and suppression only.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs module without type declarations
import { dedupeRecipients } from '../scripts/send-daily-brief.mjs';

const STAMP = '2026-01-15T10:00:00.000Z';

/** A newsletter row. `confirmed` rows carry the stamp, as the invariant requires. */
const nl = (email: string, status: string, locale = 'it') => ({
  email,
  status,
  locale,
  name: null,
  doc: status === 'confirmed'
    ? { status, confirmed_at: STAMP, registration_terms_accepted: true }
    : { status, registration_terms_accepted: true },
});
/** A row whose `status` claims something the document cannot back with a stamp. */
const nlNoStamp = (email: string, status: string, locale = 'it') => ({
  email, status, locale, name: null, doc: { status, registration_terms_accepted: true },
});
/** A row that carries the stamp whatever its status says (the re-probe shape). */
const nlStamped = (email: string, status: string, locale = 'it') => ({
  email, status, locale, name: null, doc: { status, confirmed_at: STAMP, registration_terms_accepted: true },
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

  it('newsletter side: confirmed and pending in, excluded out', () => {
    const { recipients } = dedupeRecipients(
      [nl('conf@example.com', 'confirmed'), nl('pend@example.com', 'pending'), nl('unsub@example.com', 'unsubscribed')],
      [],
    );
    expect(recipients.map((r) => r.email)).toEqual(['conf@example.com', 'pend@example.com']);
  });

  it('a newsletter-only opt-out stays scoped, while a global stop wins over job-alert membership', () => {
    const scoped = dedupeRecipients(
      [
        { ...nl('out@example.com', 'unsubscribed'), doc: { status: 'unsubscribed', confirmed_at: STAMP } },
        nl('bounced@example.com', 'bounced'),
      ],
      [ja('out@example.com', 'active'), ja('bounced@example.com', 'active')],
    );
    expect(scoped.recipients.map((r) => r.email)).toEqual(['out@example.com']);
    // The newsletter-only unsubscribe is scoped to that channel; the one
    // counted win below is the separate hard suppression on bounced@.
    expect(scoped.stats.optOutWins).toBe(1);

    const global = dedupeRecipients(
      [
        {
          ...nl('out@example.com', 'unsubscribed'),
          doc: { status: 'unsubscribed', confirmed_at: STAMP, all_email_opted_out: true },
        },
      ],
      [ja('out@example.com', 'active')],
    );
    expect(global.recipients).toHaveLength(0);
    expect(global.stats.optOutWins).toBe(1);
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

describe('the confirmation proof is not a delivery gate', () => {
  it('a pending member with no confirmation stamp still enters through an eligible job alert', () => {
    const { recipients, stats } = dedupeRecipients(
      [nl('pend@example.com', 'pending')],
      [ja('pend@example.com', 'active')],
    );
    expect(recipients.map((r) => r.email)).toEqual(['pend@example.com']);
    expect(stats.overlap).toBe(1);
  });

  it('status "confirmed" without the stamp enters — from either side', () => {
    const { recipients, stats } = dedupeRecipients(
      [nlNoStamp('claimed@example.com', 'confirmed')],
      [ja('claimed@example.com', 'active')],
    );
    expect(recipients.map((r) => r.email)).toEqual(['claimed@example.com']);
    expect(stats.newsletterRegistered).toBe(1);
    expect(stats.overlap).toBe(1);
  });

  it('a pending doc that carries the stamp also enters', () => {
    const { recipients } = dedupeRecipients(
      [nlStamped('reprobed@example.com', 'pending')],
      [ja('reprobed@example.com', 'active')],
    );
    expect(recipients.map((r) => r.email)).toEqual(['reprobed@example.com']);
    expect(recipients[0].source).toBe('newsletter');
  });

  it('every non-excluded status reaches the union through either path', () => {
    for (const status of ['pending', 'confirmed', 'subscribed', '', 'active']) {
      const { recipients } = dedupeRecipients(
        [nlNoStamp('x@example.com', status)],
        [ja('x@example.com', 'active')],
      );
      expect(recipients, `status ${status || '(empty)'} was unexpectedly excluded`).toHaveLength(1);
    }
  });

  it('an address with NO newsletter doc still enters on job-alert membership alone', () => {
    // Job-alert membership is enough when there is no central newsletter row.
    const { recipients } = dedupeRecipients([], [ja('jaonly@example.com', 'active')]);
    expect(recipients.map((r) => r.email)).toEqual(['jaonly@example.com']);
  });
});
