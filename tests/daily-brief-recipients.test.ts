/**
 * Dedup rules of the daily-brief email list (scripts/send-daily-brief.mjs).
 *
 * The whole point of the union is the measured 99,9% overlap between
 * job_alert_subscribers and newsletter_subscribers: summing them overstates
 * by ~45% (≈15k instead of ≈8.3k). These tests pin the rules that produce the
 * honest number: confirmed-only on the newsletter side, exclusion semantics
 * on the job-alert side, and the opt-out-wins override across channels.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs module without type declarations
import { dedupeRecipients } from '../scripts/send-daily-brief.mjs';

const nl = (email: string, status: string, locale = 'it') => ({ email, status, locale, name: null, doc: { status } });
const ja = (email: string, status?: string) => ({ email, status, doc: { status } });

describe('dedupeRecipients', () => {
  it('unions by lowercased email instead of summing the two lists', () => {
    const { recipients, stats } = dedupeRecipients(
      [nl('a@x.ch', 'confirmed'), nl('B@x.ch', 'confirmed')],
      [ja('A@X.CH'), ja('b@x.ch'), ja('c@x.ch')],
    );
    expect(stats.union).toBe(3); // not 5
    expect(stats.overlap).toBe(2);
    expect(recipients.map((r) => r.email).sort()).toEqual(['a@x.ch', 'b@x.ch', 'c@x.ch']);
  });

  it('newsletter side: confirmed in, pending out (unless job-alert brings them), excluded out', () => {
    const { recipients } = dedupeRecipients(
      [nl('conf@x.ch', 'confirmed'), nl('pend@x.ch', 'pending'), nl('unsub@x.ch', 'unsubscribed')],
      [],
    );
    expect(recipients.map((r) => r.email)).toEqual(['conf@x.ch']);
  });

  it('a pending newsletter member still enters through an eligible job alert', () => {
    const { recipients } = dedupeRecipients(
      [nl('pend@x.ch', 'pending')],
      [ja('pend@x.ch', 'active')],
    );
    expect(recipients.map((r) => r.email)).toEqual(['pend@x.ch']);
    expect(recipients[0].source).toBe('job-alert');
  });

  it('an explicit broadcast opt-out wins over job-alert membership', () => {
    const { recipients, stats } = dedupeRecipients(
      [nl('out@x.ch', 'unsubscribed'), nl('bounced@x.ch', 'bounced')],
      [ja('out@x.ch', 'active'), ja('bounced@x.ch', 'active')],
    );
    expect(recipients).toHaveLength(0);
    expect(stats.optOutWins).toBe(2);
  });

  it('job-alert exclusion statuses are respected on the job-alert side', () => {
    const { recipients } = dedupeRecipients(
      [],
      [ja('ok@x.ch', 'active'), ja('gone@x.ch', 'inactive'), ja('none@x.ch', undefined)],
    );
    // undefined status = plain membership (root docs often carry no status)
    expect(recipients.map((r) => r.email).sort()).toEqual(['none@x.ch', 'ok@x.ch']);
  });

  it('order is deterministic: newsletter-confirmed first, then job-alert-only, alphabetical', () => {
    const { recipients } = dedupeRecipients(
      [nl('z@x.ch', 'confirmed'), nl('a@x.ch', 'confirmed')],
      [ja('m@x.ch'), ja('b@x.ch')],
    );
    expect(recipients.map((r) => r.email)).toEqual(['a@x.ch', 'z@x.ch', 'b@x.ch', 'm@x.ch']);
  });

  it('locale prefers the newsletter doc, falls back to job-alert, then it', () => {
    const { recipients } = dedupeRecipients(
      [nl('de@x.ch', 'confirmed', 'de')],
      [{ email: 'fr@x.ch', status: 'active', locale: 'fr', doc: {} }, ja('plain@x.ch')],
    );
    const byEmail = Object.fromEntries(recipients.map((r) => [r.email, r.locale]));
    expect(byEmail['de@x.ch']).toBe('de');
    expect(byEmail['fr@x.ch']).toBe('fr');
    expect(byEmail['plain@x.ch']).toBe('it');
  });
});
