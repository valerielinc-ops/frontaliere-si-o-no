/**
 * confirmationJobContext.js — which job offer a double opt-in request is
 * about, when it is about one.
 *
 * WHY THIS EXISTS (measured 2026-09-24 on the 408 `job_board_email_unlock`
 * signups of the previous 30 days): the confirmation email was SENT to 100% of
 * them within seconds, DELIVERED to 92%, OPENED by 67% — and confirmed by 33%.
 * 148 people (36% of the cohort, 55% of those who opened) opened a request
 * after at least ten seconds, i.e. not a proxy prefetch, and never clicked.
 * Neither delivery, nor the provider (20-23% confirmed after request #1 on
 * each of Mailgun, Maileroo and Mailjet), nor the window (6 of 133
 * confirmations arrived after 96 hours) explains a loss of that size.
 *
 * What does: the person typed an email to SEE A JOB, the job unlocked on the
 * spot, and the email that followed said «Grazie per esserti iscritto alla
 * newsletter» and listed exchange rates and tax news. Nothing in it named the
 * offer, and nothing said what confirming would get them that they did not
 * already have. The popup signups, who did ask for a newsletter, confirm at
 * 65-67% with the same email.
 *
 * So the request names the offer and the one concrete thing confirming adds —
 * new similar offers, which is what the job-alert backfill built from this
 * very document delivers — and nothing else changes: same sender, same single
 * link, same token, same cadence, same cap. Double opt-in stays double.
 *
 * DEGRADE, NEVER GUESS, like welcomeSegment.js: every slot comes from the
 * subscriber document through a sanitizer, and `null` means "send the generic
 * email exactly as before". A wrong job title in a consent request is worse
 * than no title.
 */

import { sanitizeCompany, sanitizeLocation } from './welcomeSegment.js';

/**
 * `source_cta` → which wording applies.
 *
 * Deliberately an allowlist: `unlocked` says «you just unlocked the offer»,
 * which is only true of the job-gate surfaces; `expired` says the offer is no
 * longer active, which is only true of the expired-job view. Every other
 * surface (company follow, orphan, bridge, newsletter popup…) keeps the
 * generic email until somebody measures it and writes its own sentence.
 */
export const CONFIRMATION_JOB_CONTEXT_KINDS = Object.freeze({
  job_board_email_unlock: 'unlocked',
  job_gate_email_unlock: 'unlocked',
  job_board_social_unlock: 'unlocked',
  job_expired_email_unlock: 'expired',
});

/** The client truncates the title it stamps into `source` at this length. */
const SOURCE_TITLE_MAX = 60;

// Control, bidi-override and zero-width characters, markup, addresses, links.
const TITLE_FORBIDDEN_RE = /[\u0000-\u001F\u007F​-‏‪-‮⁠-⁤﻿<>@{}]|https?:\/\/|www\./i;

/**
 * A job title fit to be printed in a consent request, or null.
 *
 * Looser than `sanitizeCompany` on purpose — real titles are full of the
 * lowercase words and punctuation that rule treats as prose ("Collaboratore/trice
 * della ristorazione (m/w/d) 80-100%") — but just as strict on the characters
 * that could inject or spoof.
 *
 * @param {unknown} raw
 * @param {{truncated?: boolean}} [options] true when `raw` came out of the
 *   60-character `source` stamp and may have been cut mid-word
 * @returns {string|null}
 */
export function sanitizeConfirmationJobTitle(raw, { truncated = false } = {}) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (trimmed.length < 3 || trimmed.length > 90) return null;
  if (!/^[\p{L}\p{N}]/u.test(trimmed)) return null;
  if (TITLE_FORBIDDEN_RE.test(trimmed)) return null;
  if (!/\p{L}{2,}/u.test(trimmed)) return null;
  if (truncated && raw.length >= SOURCE_TITLE_MAX) {
    // Cut mid-word by the client: drop the fragment, say so with an ellipsis.
    const cut = trimmed.replace(/[\s,;:\-–—/(]+[^\s]*$/u, '').trim();
    return cut.length >= 3 ? `${cut}…` : null;
  }
  return trimmed;
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Read the title out of `source`, and say whether it belongs to the same offer
 * as `job_company`.
 *
 * Shape: `<prefix>:<company>:<title>` where prefix is `job_gate` or
 * `job_gate_email` (components/community/JobBoard.tsx). Either half may
 * contain a colon, so the company is taken from `job_company` and stripped as
 * a known prefix.
 *
 * WHY `mixed` EXISTS (measured 2026-09-25 on the 2,962 job-gate documents):
 * the two fields are not written by the same rule. `source` is FIRST-touch —
 * services/newsletterSubscribers.ts keeps the stored value and firestore.rules
 * forbids a browser from rewriting it — while `job_company`, `job_location`,
 * `source_cta` and `source_page` are LAST-touch. A person who unlocks offer A
 * and later offer B holds A's title next to B's company, and the old
 * positional fallback printed exactly that: 18 documents (3 still pending),
 * every one of them resolved to «A presso B». 5 of the 18 had a single
 * typed-email signup (March–April 2026): the list modal of JobBoard.tsx
 * stamped the clicked offer into `source` and another offer's slug into the
 * job fields, whose company a backfill later derived from that slug (fixed
 * there). Whichever the cause, a title the company does not corroborate is not
 * this offer's title, and «a wrong job title in a consent request is worse
 * than no title».
 *
 * @param {Record<string, any>} data
 * @returns {{title: string|null, mixed: boolean}}
 */
export function parseJobSource(data) {
  const source = typeof data?.source === 'string' ? data.source : '';
  const match = /^(job_[a-z_]*):/.exec(source);
  if (!match) return { title: null, mixed: false };
  const rest = source.slice(match[0].length);
  const company = typeof data?.job_company === 'string' ? collapse(data.job_company) : '';
  if (company) {
    // Try every colon: the company itself may contain one. Compared after
    // whitespace collapsing because `job_company` is stored trimmed and the
    // `source` stamp is not.
    for (let i = rest.indexOf(':'); i >= 0; i = rest.indexOf(':', i + 1)) {
      if (collapse(rest.slice(0, i)) === company) {
        return { title: rest.slice(i + 1) || null, mixed: false };
      }
    }
    return { title: null, mixed: true };
  }
  // No company to corroborate with: only an unambiguous split (exactly
  // `<company>:<title>`) is trusted, and the title then stands alone.
  const parts = rest.split(':');
  return { title: parts.length === 2 ? parts[1] || null : null, mixed: false };
}

/**
 * The title the client stamped into `source` at signup, when it belongs to the
 * offer `job_company` names (see parseJobSource).
 *
 * @param {Record<string, any>} data
 * @returns {string|null}
 */
export function jobTitleFromSource(data) {
  return parseJobSource(data).title;
}

/**
 * @typedef {{kind: 'unlocked'|'expired', title: string|null, company: string|null, location: string|null}} ConfirmationJobContext
 */

/**
 * The job context of a subscriber document, or null for the generic email.
 *
 * Returns a context only when the signup surface is on the allowlist above
 * AND at least a title or a company survived sanitization: «hai sbloccato
 * l'offerta» with nothing after it would be the worst of both emails.
 *
 * @param {Record<string, any>|null|undefined} data a `newsletter_subscribers` doc
 * @returns {ConfirmationJobContext|null}
 */
export function resolveConfirmationJobContext(data) {
  try {
    if (!data || typeof data !== 'object') return null;
    const kind = CONFIRMATION_JOB_CONTEXT_KINDS[String(data.source_cta || '').trim()];
    if (!kind) return null;

    // Title and company from two different offers: no context at all, not the
    // company alone. Which of the two is right cannot be told from the
    // document (a later signup makes `job_company` right and the title stale;
    // the old modal bug made the title right and `job_company` wrong), and the
    // location and the kind travel with `job_company`. The generic request is
    // the one every surface got before the contextual variant existed.
    const parsed = parseJobSource(data);
    if (parsed.mixed) return null;

    const title = sanitizeConfirmationJobTitle(parsed.title, { truncated: true });
    const company = sanitizeCompany(data.job_company);
    if (!title && !company) return null;

    // `source` is the only offer field this document keeps from first touch.
    // `job_location` and `location_interest` are last-touch fields, so using
    // either here can pair offer A's title/company with offer B's location —
    // including two offers from the same company. Until the first-touch write
    // carries a location that can be corroborated in the same way, degrade to
    // no location rather than guessing.
    const location = null;

    return { kind, title, company, location };
  } catch {
    return null;
  }
}

// ── The snapshot: request #1 decides, the reminders repeat ─────────────────

/**
 * The subscriber field that freezes the context of the current cycle.
 *
 * Written by the same ledger write that counts the request
 * (`buildConfirmationSentFields`, lib/confirmationFollowup.js), by both
 * senders; guarded in firestore.rules so no browser write can set or change
 * it. `null` is a value here — «request #1 was the generic email» — and is
 * kept apart from an absent field, which only a document asked before the
 * snapshot existed can have.
 */
export const CONFIRMATION_JOB_CONTEXT_FIELD = 'confirmation_job_context';

/**
 * @typedef {ConfirmationJobContext & {return_path: string|null}} ConfirmationJobSnapshot
 */

/**
 * An in-site pathname fit for the confirm link to return to, or null (the
 * link then lands on the home page and the email promises no return).
 *
 * Anything this does not recognise as a plain in-site pathname degrades to
 * null rather than to a broken or off-site link: a query string riding along
 * (a doubled `?` in confirmationConfirmUrl), a protocol-relative `//host/...`
 * that would redirect off-site, a backslash some browsers treat as a path
 * separator.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function sanitizeConfirmationReturnPath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const pathOnly = raw.split('?')[0].split('#')[0];
  if (!pathOnly) return null;
  if (!pathOnly.startsWith('/')) return null;
  if (pathOnly.startsWith('//')) return null;
  if (pathOnly.includes('\\')) return null;
  return pathOnly;
}

/**
 * The snapshot stored on the document, re-validated on the way out.
 *
 * Every slot goes back through the sanitizer it passed on the way in: the
 * value sits on a document a browser can create, and the email it feeds is a
 * consent request. A snapshot that no longer passes — a slot that fails its
 * sanitizer, an unknown kind, neither title nor company — reads as null, the
 * generic email, never as a partial context.
 *
 * @param {Record<string, any>|null|undefined} data a `newsletter_subscribers` doc
 * @returns {ConfirmationJobSnapshot|null|undefined} undefined when the document
 *   carries no snapshot at all (asked before it existed)
 */
export function readConfirmationJobSnapshot(data) {
  try {
    if (!data || typeof data !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(data, CONFIRMATION_JOB_CONTEXT_FIELD)) return undefined;
    const raw = data[CONFIRMATION_JOB_CONTEXT_FIELD];
    if (raw === undefined) return undefined;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const kind = Object.values(CONFIRMATION_JOB_CONTEXT_KINDS).includes(raw.kind) ? raw.kind : null;
    if (!kind) return null;
    const slot = (value, sanitize) => {
      if (value == null) return { ok: true, value: null };
      const clean = sanitize(value);
      return { ok: clean != null, value: clean };
    };
    const title = slot(raw.title, (v) => sanitizeConfirmationJobTitle(v));
    const company = slot(raw.company, sanitizeCompany);
    const location = slot(raw.location, sanitizeLocation);
    const returnPath = slot(raw.return_path, sanitizeConfirmationReturnPath);
    if (!title.ok || !company.ok || !location.ok || !returnPath.ok) return null;
    if (!title.value && !company.value) return null;

    return {
      kind,
      title: title.value,
      company: company.value,
      location: location.value,
      return_path: returnPath.value,
    };
  } catch {
    return null;
  }
}

/**
 * Which offer THIS request names, where its link returns, and the snapshot the
 * ledger write stores next to the counter.
 *
 * The first request of a cycle (`attemptsBefore === 0`) resolves the context
 * from the document, once, and freezes it with the return path its link used.
 * Every later request of the same cycle — the follow-up runner's #2 and #3,
 * or a "resend" that reaches the Cloud Function — repeats that snapshot
 * verbatim instead of re-reading `job_company`, `job_location`, `source_cta`
 * and `source_page`, which a later signup overwrites (measured 2026-09-25: in
 * 35 cycles the offer changed between request #1 and the last reminder).
 *
 * A snapshot found at `attemptsBefore === 0` is ignored and replaced: it
 * belongs to a previous cycle (a re-subscription after `expired` restarts the
 * count), or to nobody. A reminder on a document asked before the snapshot
 * existed resolves the context as request #1 did, and the ledger write then
 * freezes what it sent, so its next reminder repeats it.
 *
 * @param {Record<string, any>|null|undefined} data a `newsletter_subscribers` doc
 * @param {{attemptsBefore: number, returnPath?: string|null}} args `returnPath`
 *   is the path this sender would use without a snapshot
 * @returns {{jobContext: ConfirmationJobContext|null, returnPath: string|null, snapshot: ConfirmationJobSnapshot|null}}
 */
export function confirmationJobContextForSend(data, { attemptsBefore, returnPath = null } = {}) {
  const cleanReturnPath = sanitizeConfirmationReturnPath(returnPath);
  const stored = attemptsBefore > 0 ? readConfirmationJobSnapshot(data) : undefined;
  if (stored !== undefined) {
    // A generic request #1 stays generic, and keeps this sender's link: with
    // no offer named there is no return promise for the link to contradict.
    if (stored === null) return { jobContext: null, returnPath: cleanReturnPath, snapshot: null };
    const { return_path: frozenPath, ...jobContext } = stored;
    return { jobContext, returnPath: frozenPath, snapshot: stored };
  }
  const jobContext = resolveConfirmationJobContext(data);
  return {
    jobContext,
    returnPath: cleanReturnPath,
    snapshot: jobContext ? { ...jobContext, return_path: cleanReturnPath } : null,
  };
}
