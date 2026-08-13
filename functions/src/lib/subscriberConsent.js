/**
 * subscriberConsent.js — the one place that answers "may we mail this person?"
 * from the RECORD of their consent rather than from the word in `status`.
 *
 * Companion to `emailSuppression.js`, and deliberately separate from it: that
 * module is a vocabulary of `status` strings (who has opted OUT), this one is
 * the evidence that somebody ever opted IN. #5677 measured that the two
 * questions do not answer each other, and #5686 is what happens when one is
 * used as if it did — `scripts/send-newsletter.mjs` shipped a weekly campaign
 * to every non-excluded row, `pending` included, on the strength of a comment
 * claiming that "clicking a link auto-confirms them". No code ever did that.
 *
 * MOVED HERE from `services/subscriberConsent.mjs` by #5692, following that
 * file's own instruction: "If a Cloud Function ever needs this gate, move the
 * body to functions/src/lib/ and leave a re-export here". One now does —
 * `newsletterConfirmationEmail.js` must not count a passwordless login link or
 * a re-probe of an already-confirmed address against the three-request cap,
 * and Cloud Functions have no bundler and cannot import outside `functions/`.
 * The `services/` path still resolves to this exact module, so every existing
 * script and test importer is unchanged and the two cannot drift.
 */

/**
 * The recorded proof that this address ever completed the double opt-in.
 *
 * `confirmed_at` / `confirmedAt` are written by the two branches of
 * functions/src/newsletterSubscriptionManagement.js that a RECIPIENT reaches by
 * clicking, and by nothing else: `action === 'confirm'` (the double-opt-in
 * link) and `action === 'resubscribe'` (the "riattiva" click), each in the same
 * `.set()` that writes `status: 'confirmed'`.
 *
 * The resubscribe half was added by #5677 itself. That branch wrote `confirmed`
 * with NO stamp, and its token is an HMAC(email) checked without reference to
 * the previous status — so someone who had never confirmed could unsubscribe
 * (the link rides every transactional email), click "riattiva" on the response
 * page, and land on `confirmed` with nothing behind it. It hid because the
 * `unsubscribe` branch does not delete `confirmed_at`, so anyone who HAD
 * confirmed once kept an old stamp across the cycle. Treating the reactivation
 * click as consent rather than refusing it matches #5690, which made
 * `resubscribe_link` one of only two signals allowed to lift a recorded
 * opt-out.
 *
 * So the stamp is a record of a click, not an inference from the signup form,
 * and that distinction is the whole of #5677: `status` alone is NOT proof, in
 * BOTH directions, and both directions were measured on production
 * (2026-08-12, 8.617 docs; re-measured 2026-08-13 on 8.670):
 *
 *   - `status: 'confirmed'` WITHOUT the stamp: 392 docs, of which 380 carry a
 *     restore marker (183 explicitly `mailtrap_suspension_mismapped`). ZERO of
 *     the 392 carry a `confirm` event. They were marked confirmed by a
 *     recovery procedure that DEDUCED consent from the signup origin — the
 *     fabricated consent this gate refuses to honour.
 *   - `status: 'pending'` WITH the stamp: 847 docs (848 on 2026-08-13), 823 of
 *     them also carrying `suppressed_at` + `reactivated_at`. These people DID
 *     click: scripts/mailtrap-suppression-retry.mjs:176 writes
 *     `status: 'pending', isActive: true` on a previously-confirmed address as
 *     a DELIVERABILITY re-probe, so the send cascade retries the mailbox. The
 *     word `pending` there means "re-probe me", not "never consented".
 *
 * That second cohort is why #5692's follow-up policy asks this question FIRST,
 * before it counts a single confirmation attempt: 848 of the 1.498 `pending`
 * documents have already confirmed, and a cycle that expired them would close
 * 848 real subscriptions.
 *
 * So the gate keys on the stamp and never on the word. Blocking every
 * `pending` row instead would have silently dropped 535 people who had
 * confirmed (496 of them with the `confirm` event still in their event log)
 * along with the 561 who never did — which is also why `pending` must NOT be
 * added to `NEWSLETTER_EXCLUDED_STATUSES`: that Set is shared with the sunset
 * and win-back channels, whose whole purpose is reaching people the ordinary
 * campaigns no longer may.
 *
 * @param {({doc?: object} & Record<string, unknown>) | null | undefined} row
 *   Either a raw Firestore row or a projection carrying the raw one on `.doc`;
 *   both spellings of the stamp are read on either level, and a caller may pass
 *   the whole document, extra fields and all.
 * @returns {boolean}
 */
export function hasConfirmationProof(row) {
  const d = row?.doc || {};
  return !!(d.confirmed_at || d.confirmedAt || row?.confirmed_at || row?.confirmedAt);
}
