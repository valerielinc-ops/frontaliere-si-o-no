// @vitest-environment node
/**
 * A `newsletter_subscribers` record is created only with a consent basis.
 *
 * Two writers could create one without (measured 2026-09-25 on the records
 * that carry no basis):
 *   - the provider webhooks: a transactional email to an address with no
 *     record (a calculator PDF deliberately does not create one) came back as
 *     a delivery/open event whose merge created a record holding only
 *     counters — 5 of them, the last on 2026-09-07 — and
 *     `syncNewsletterSubscriberAuth` (functions/index.js) then created a
 *     shadow Auth account for it;
 *   - a verified owner's profile-only create, allowed by firestore.rules for
 *     the authentication-only write of #8341 and no longer needed since #8754
 *     moved the terms-based upsert ahead of the profile merge.
 *
 * The per-provider behaviour is asserted in each
 * tests/newsletter-<provider>-webhook-core.test.ts and the rules against the
 * emulator in tests/firestore-rules-consent-write.test.ts (Java 21, outside
 * the related-tests gate). This file holds the two halves CI can run anywhere:
 * the shared merge helper, and the shape of the create clause.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  mergeAccountDeletedSubscriberUpdate,
  UNKNOWN_RECIPIENT,
} from '../functions/src/lib/subscriberReactivation.js';

function txDouble(docData: Record<string, unknown> | null) {
  const writes: Array<{ data: unknown; options: unknown }> = [];
  const ref = { id: 'x@example.com' };
  const db = {
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
      get: async () => ({ exists: docData !== null, data: () => docData }),
      set: (_ref: unknown, data: unknown, options: unknown) => writes.push({ data, options }),
    }),
  };
  return { db, ref, writes };
}

describe('mergeAccountDeletedSubscriberUpdate never creates the record', () => {
  it('writes nothing and returns null when the document does not exist', async () => {
    const { db, ref, writes } = txDouble(null);
    const result = await mergeAccountDeletedSubscriberUpdate(ref, { open_count: 1 }, () => ({ status: 'confirmed' }), db);
    expect(result).toBeNull();
    expect(writes).toEqual([]);
  });

  it('merges as before when it exists', async () => {
    const { db, ref, writes } = txDouble({ status: 'confirmed' });
    const result = await mergeAccountDeletedSubscriberUpdate(ref, { open_count: 1 }, null, db);
    expect(result).toEqual({ open_count: 1 });
    expect(writes).toEqual([{ data: { open_count: 1 }, options: { merge: true } }]);
  });

  it('shares its skip reason with inboundBounceReport.js', () => {
    expect(UNKNOWN_RECIPIENT).toBe('unknown_recipient');
    expect(readFileSync('functions/src/inboundBounceReport.js', 'utf8')).toContain("reason: 'unknown_recipient'");
  });

  it('every webhook core stops on it, on both the newsletter and the job-alert branch', () => {
    for (const provider of ['Mailgun', 'Mailjet', 'Mailtrap', 'Maileroo']) {
      const src = readFileSync(`functions/src/newsletter${provider}WebhookCore.js`, 'utf8');
      expect(src.match(/const merged = await mergeAccountDeletedSubscriberUpdate\(/g), provider).toHaveLength(2);
      expect(src.match(/if \(merged === null\) return \{ skipped: true, reason: UNKNOWN_RECIPIENT \};/g), provider).toHaveLength(2);
    }
    const resend = readFileSync('functions/src/newsletterResendWebhookCore.js', 'utf8');
    expect(resend).toContain('if (!subscriberDoc.exists) return false;');
    expect(resend).toContain('if (!subscriberKnown) return { handled: false, reason: UNKNOWN_RECIPIENT };');
    expect(resend).toContain('if (merged === null) return { handled: false, reason: UNKNOWN_RECIPIENT };');
  });
});

describe('firestore.rules: every newsletter_subscribers create carries a consent basis', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  const block = rules.slice(rules.indexOf('match /newsletter_subscribers/{email}'));
  const start = block.indexOf('allow create:');
  const create = block.slice(start, block.indexOf(';', start));

  it('admits only the pending, terms-based and visibly-confirmed shapes', () => {
    expect(create).toContain('isPendingNewsletterCreate()');
    expect(create).toContain('isTermsBasedConfirmedCreate(email)');
    expect(create).toContain('isVerifiedConfirmedCreate(email)');
    // The profile-only owner branch is gone: identity alone creates nothing.
    expect(create).not.toContain('isVerifiedSubscriberOwner(email)');
  });
});
