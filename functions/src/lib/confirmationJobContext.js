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

/**
 * The title the client stamped into `source` at signup.
 *
 * Shape: `<prefix>:<company>:<title>` where prefix is `job_gate` or
 * `job_gate_email` (components/community/JobBoard.tsx). Either half may
 * contain a colon, so the company is taken from `job_company` and stripped as
 * a known prefix; only when that fails and the split is unambiguous (exactly
 * three parts) is the positional reading trusted.
 *
 * @param {Record<string, any>} data
 * @returns {string|null}
 */
export function jobTitleFromSource(data) {
  const source = typeof data?.source === 'string' ? data.source : '';
  const match = /^(job_[a-z_]*):/.exec(source);
  if (!match) return null;
  const rest = source.slice(match[0].length);
  const company = typeof data?.job_company === 'string' ? data.job_company : '';
  if (company && rest.startsWith(`${company}:`)) {
    return rest.slice(company.length + 1) || null;
  }
  const parts = rest.split(':');
  return parts.length === 2 ? parts[1] || null : null;
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

    const title = sanitizeConfirmationJobTitle(jobTitleFromSource(data), { truncated: true });
    const company = sanitizeCompany(data.job_company);
    if (!title && !company) return null;

    // "Zurich, Switzerland" → "Zurich": the country is noise in a sentence that
    // already says "in the area of".
    const rawLocation = [data.job_location, data.location_interest].find(
      (v) => typeof v === 'string' && v.trim(),
    );
    const location = rawLocation ? sanitizeLocation(String(rawLocation).split(',')[0]) : null;

    return { kind, title, company, location };
  } catch {
    return null;
  }
}
