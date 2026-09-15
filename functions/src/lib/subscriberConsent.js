/**
 * subscriberConsent.js — the one place that answers whether a row carries a
 * durable double-opt-in proof. Ordinary communications do NOT use this proof
 * as a delivery gate; their recipients are selected from the subscription
 * relationship and the shared suppression predicates.
 *
 * Companion to `emailSuppression.js`, and deliberately separate from it: that
 * module owns the delivery stop conditions, while this one is the evidence
 * used by the confirmation-request and audit paths. A missing proof
 * is therefore not a reason for the ordinary newsletter, job-alert or
 * third-party senders to drop an otherwise subscribed row.
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

function readField(row, ...fields) {
  const d = row?.doc || {};
  for (const field of fields) {
    if (row?.[field] !== undefined) return row[field];
    if (d?.[field] !== undefined) return d[field];
  }
  return undefined;
}

/**
 * Server-owned provenance written by the DOI confirmation endpoint.
 *
 * A silent authentication row may already carry `confirmed_at`, but that
 * timestamp was not a newsletter act. This marker is the durable distinction
 * for the exceptional case where the recipient later clicks a real DOI link
 * while the old authentication state is still on the document. It is written
 * by the Admin SDK path only; browser writes are guarded in firestore.rules.
 */
export const CONFIRMATION_LINK_PROOF = 'confirmation_link';

/**
 * Purpose recorded by the shared communications checkbox. Keep this value in
 * the canonical consent reader too: senders must not infer the saved-jobs
 * channel from a generic confirmation stamp or from a profile default.
 */
export const UNIFIED_EMAIL_CONSENT_PURPOSE = 'unified_email_channels';

/**
 * Whether an append-only event is the server-recorded double-opt-in click.
 *
 * Historical client-side signup/authentication writers also used
 * `event_type: 'confirm'` when a row became active. The event type alone is
 * therefore not consent evidence. The confirmation endpoint is the only
 * writer allowed to use this source channel for the event, so both fields are
 * required here and every recovery/export reader shares the same fail-closed
 * interpretation.
 *
 * @param {Record<string, unknown> | null | undefined} event
 * @returns {boolean}
 */
export function isNewsletterConfirmationEvent(event) {
  return event?.event_type === 'confirm'
    && event?.source_channel === CONFIRMATION_LINK_PROOF;
}

/**
 * Whether the row carries the durable confirmation timestamp.
 *
 * This is intentionally weaker than `hasConfirmationProof`: a transactional
 * DOI request must not be re-sent merely because an old row is still marked
 * `pending`, but marketing eligibility additionally validates the provenance
 * of authentication-created stamps.
 *
 * @param {({doc?: object} & Record<string, unknown>) | null | undefined} row
 * @returns {boolean}
 */
export function hasConfirmationStamp(row) {
  return Boolean(readField(row, 'confirmed_at', 'confirmedAt'));
}

/**
 * The recorded proof that this address completed the double opt-in.
 *
 * `confirmed_at` / `confirmedAt` are the durable proof anchor. For records
 * whose provenance is an authentication path, the anchor is valid only when
 * the communications notice was actually displayed. This distinction matters
 * for historical rows created by the old silent auth writer: they carry a
 * timestamp and `consent_text_displayed: false`, but no subscription request.
 * Explicit communication gates also use an authentication act, and pass this
 * gate because their displayed flag is true.
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
 * The stamp is a durable record, not an inference from the signup form. For
 * authentication provenance, the displayed notice is part of that proof;
 * status alone — and a silent authentication timestamp — are NOT proof. A
 * server-owned `confirmed_via: 'confirmation_link'` marker is the other
 * allowed route: it records the recipient's later DOI click without claiming
 * that the old authentication flow displayed a newsletter notice. The
 * distinction is the whole of #5677, and both directions were measured on production
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
 * Delivery no longer keys ordinary communications on this proof. The
 * confirmation-request readers still use it to distinguish a completed DOI
 * from an unanswered request; `pending` must NOT be added to
 * `NEWSLETTER_EXCLUDED_STATUSES`, because that set owns delivery suppression
 * and not consent evidence.
 * @param {({doc?: object} & Record<string, unknown>) | null | undefined} row
 *   Either a raw Firestore row or a projection carrying the raw one on `.doc`;
 *   both spellings of the stamp are read on either level, and a caller may pass
 *   the whole document, extra fields and all.
 * @returns {boolean}
 */
export function hasConfirmationProof(row) {
  if (!hasConfirmationStamp(row)) return false;

  const act = String(readField(row, 'consent_act', 'consentAct') || '').trim().toLowerCase();
  const source = String(readField(row, 'source') || '').trim().toLowerCase();
  const sourceChannel = String(readField(row, 'source_channel', 'sourceChannel') || '').trim().toLowerCase();
  const confirmedVia = String(readField(row, 'confirmed_via', 'confirmedVia') || '').trim().toLowerCase();
  const authenticationPath =
    act === 'authentication'
    || sourceChannel.startsWith('auth_')
    || sourceChannel === 'chatbot'
    || source.startsWith('chatbot')
    || source.includes('auth');

  if (
    authenticationPath
    && confirmedVia !== CONFIRMATION_LINK_PROOF
    && readField(row, 'consent_text_displayed', 'consentTextDisplayed') !== true
  ) {
    return false;
  }
  return true;
}

/**
 * Compatibility predicate for callers that used to model a confirmation gate.
 *
 * There is deliberately no proof gate for base communications: neither legacy
 * rows nor new registrations wait for `confirmed_at`. Callers still have to
 * apply their channel's unsubscribe, explicit opt-out, hard suppression and
 * cadence rules. Keeping this no-op export makes an accidental old import
 * fail open rather than silently dropping the whole pending audience.
 *
 * @param {({doc?: object} & Record<string, unknown>) | null | undefined} row
 * @returns {boolean}
 */
export function isBaseCommunicationsReady(_row) {
  return true;
}

/**
 * Whether the confirmed relationship came from the displayed, unified email
 * choice. This enables recurring feature emails whose concrete content is
 * determined later (for example a digest of jobs the person actually saved),
 * while keeping historical channel-specific proof out of that audience.
 *
 * @param {({doc?: object} & Record<string, unknown>) | null | undefined} row
 * @returns {boolean}
 */
export function hasUnifiedEmailConsent(row) {
  if (!hasConfirmationProof(row)) return false;
  return String(readField(row, 'consent_purpose', 'consentPurpose') || '').trim().toLowerCase()
    === UNIFIED_EMAIL_CONSENT_PURPOSE;
}
