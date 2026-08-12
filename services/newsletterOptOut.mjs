/**
 * newsletterOptOut.mjs — is a recorded opt-out still binding on this document?
 *
 * ONE definition, shared by the browser writers (services/newsletterSubscribers.ts)
 * and by every Node sender (scripts/send-newsletter.mjs, scripts/send-onboarding-drip.mjs).
 * The Cloud Functions bundle cannot import outside `functions/`, so it carries a
 * pinned mirror at functions/src/lib/newsletterOptOut.js; parity between the two
 * is asserted by tests/newsletter-optout-supersession.test.ts, never assumed.
 *
 * WHY THIS FILE EXISTS AT ALL (#5711)
 * -----------------------------------
 * Until now a re-subscription DELETED `unsubscribed_at` / `unsubscribedAt`. That
 * made the readers trivial — "stamp present ⇒ do not mail" — at the cost of
 * destroying the only durable evidence that the person had ever opted out. The
 * cost was not theoretical: it is exactly why the 186 resurrected opt-outs of
 * #5672 could only be found by a method that a single resubscribe click erases,
 * and why the production case in #5711 (unsubscribe 12:40:53 → re-subscribe
 * 12:40:55, 1,5 s, `source_channel: resubscribe_link`) showed up afterwards with
 * `unsubscribed_at: null` — no trace left of the decision that was overridden.
 *
 * So the stamp is now APPEND-ONLY: nothing deletes it, ever. The readers get the
 * supersession rule instead, and it lives here so there is one of it.
 *
 * THE RULE
 * --------
 *   binding = (status === 'unsubscribed' OR an opt-out stamp exists)
 *             AND NOT superseded by a STRICTLY LATER explicit re-opt-in stamp
 *
 * `resubscribed_at` / `resubscribedAt` is the re-opt-in stamp, and the choice of
 * that field rather than `confirmed_at` is the whole safety argument:
 *
 *  - `confirmed_at` is written by anything that lands a document on `confirmed`,
 *    including the auto-subscribe ring #5672 closed. All 186 resurrected
 *    documents carried a `confirmed_at` NEWER than their opt-out, so a
 *    `confirmed_at > unsubscribed_at` supersession would exempt precisely the
 *    cohort the guard exists for. (scripts/lib/suppressionDecay.mjs does use
 *    that broader rule — deliberately, and for a different decision: whether to
 *    DECAY a machine-inferred suppression, never whether to mail someone.)
 *
 *  - `resubscribed_at` is written by four call sites and all four are an
 *    explicit act by the recipient: the `resubscribe` POST and the
 *    `toggle_newsletter_subscription` re-opt-in in
 *    functions/src/newsletterSubscriptionManagement.js, `authToggleNewsletter`
 *    in components/preferences/SubscriptionPreferencesController.tsx, and the
 *    `resubscribe_link` branch of services/newsletterSubscribers.ts. Every one
 *    of them is reachable only through `isExplicitNewsletterReOptIn`, i.e. the
 *    same two signals #5690 allows to lift an opt-out.
 *
 * STRICTLY LATER, and FAIL-CLOSED on anything unreadable: a re-opt-in stamp that
 * cannot be parsed into a timestamp, or that is not newer than the opt-out,
 * leaves the opt-out binding. The failure mode of the opposite default is a
 * silent resurrection, which is the class of defect this whole file is about.
 */

/** The two spellings of the opt-out stamp. Both are written; both are read. */
export const OPT_OUT_STAMP_FIELDS = Object.freeze(['unsubscribed_at', 'unsubscribedAt']);
/** The two spellings of the explicit re-opt-in stamp. */
export const RE_OPT_IN_STAMP_FIELDS = Object.freeze(['resubscribed_at', 'resubscribedAt']);

/**
 * Coerce whatever a Firestore document actually holds into epoch millis.
 *
 * Four shapes reach the readers and all four are real: a Firestore `Timestamp`
 * (Cloud Function writes), an ISO string (services/newsletterSubscribers.ts's
 * `buildNewsletterUnsubscribeFields` writes strings, not sentinels), a `Date`
 * (test fixtures and the admin SDK when `timestampsInSnapshots` is off), and a
 * number. Anything else — including an unresolved `serverTimestamp()` sentinel
 * read back inside the same write — yields null, which the caller treats as
 * "not proven newer".
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function toEpochMillis(value) {
  if (value == null) return null;
  try {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'object') {
      if (typeof value.toMillis === 'function') {
        const ms = value.toMillis();
        return Number.isFinite(ms) ? ms : null;
      }
      if (typeof value.toDate === 'function') {
        const ms = value.toDate()?.getTime?.();
        return Number.isFinite(ms) ? ms : null;
      }
      if (typeof value.seconds === 'number') {
        const nanos = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
        return value.seconds * 1000 + Math.floor(nanos / 1e6);
      }
      if (typeof value._seconds === 'number') {
        const nanos = typeof value._nanoseconds === 'number' ? value._nanoseconds : 0;
        return value._seconds * 1000 + Math.floor(nanos / 1e6);
      }
    }
  } catch { /* unreadable value → null, i.e. "not proven newer" */ }
  return null;
}

function firstMillis(sub, fields) {
  for (const field of fields) {
    const ms = toEpochMillis(sub?.[field]);
    if (ms != null) return ms;
  }
  return null;
}

/**
 * When did this document record an opt-out? Null when it never did, or when the
 * stamp is present but unreadable.
 * @param {Record<string, any> | null | undefined} sub
 * @returns {number|null}
 */
export function newsletterOptOutMillis(sub) {
  return firstMillis(sub, OPT_OUT_STAMP_FIELDS);
}

/**
 * When did this document record an explicit re-opt-in? Same null semantics.
 * @param {Record<string, any> | null | undefined} sub
 * @returns {number|null}
 */
export function newsletterReOptInMillis(sub) {
  return firstMillis(sub, RE_OPT_IN_STAMP_FIELDS);
}

/** Does the document carry an opt-out stamp under either spelling? */
export function hasNewsletterOptOutStamp(sub) {
  if (!sub) return false;
  return OPT_OUT_STAMP_FIELDS.some((f) => sub[f] != null);
}

/**
 * Has an explicit re-opt-in landed STRICTLY AFTER the recorded opt-out?
 *
 * Requires both stamps to be readable. A document with a re-opt-in stamp and no
 * opt-out stamp is not "superseded" — it has nothing to supersede — and a
 * document whose opt-out is unreadable stays binding.
 *
 * @param {Record<string, any> | null | undefined} sub
 * @returns {boolean}
 */
export function isNewsletterOptOutSuperseded(sub) {
  const optOut = newsletterOptOutMillis(sub);
  if (optOut == null) return false;
  const reOptIn = newsletterReOptInMillis(sub);
  if (reOptIn == null) return false;
  // `status: 'unsubscribed'` is the LAST word whatever the stamps say: every
  // writer that lands that status writes a fresh opt-out stamp with it, so a
  // document sitting there with an older-looking stamp is a document whose
  // stamps cannot be trusted to order the two events.
  if (String(sub?.status || '').trim().toLowerCase() === 'unsubscribed') return false;
  return reOptIn > optOut;
}

/**
 * Is a recorded opt-out still binding on this document?
 *
 * BOTH spellings of the stamp are read, and that is the point (#5673): the
 * Cloud Function path writes `unsubscribed_at` (snake_case) while the SPA path
 * wrote `unsubscribedAt` (camelCase) and nothing else. 458 production documents
 * measured on 2026-08-12 carry ONLY the camelCase spelling, so a guard that
 * reads one name honours half the opt-outs. No data migration is needed — and
 * none is performed — precisely because every reader accepts both.
 *
 * `status` alone is not enough either: it is a single last-writer-wins field,
 * and the resurrection ring #5672 exists to close overwrote it.
 *
 * @param {Record<string, any> | null | undefined} sub
 * @returns {boolean}
 */
export function isNewsletterOptOutBinding(sub) {
  if (!sub) return false;
  const recorded = String(sub.status || '').trim().toLowerCase() === 'unsubscribed'
    || hasNewsletterOptOutStamp(sub);
  if (!recorded) return false;
  return !isNewsletterOptOutSuperseded(sub);
}
