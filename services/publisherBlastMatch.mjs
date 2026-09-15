/**
 * Targeted newsletter blast — match a sponsored publisher ad to the subscribers
 * most likely to care (e.g. the "fisioterapista Ticino" searchers).
 *
 * Pure + dependency-free (Node + browser safe) so it is unit-testable and usable
 * from the blast script. The inverse of services/newsletter-content.mjs
 * matchJobsForSubscriber: here we score SUBSCRIBERS against ONE ad.
 *
 * Signal (highest → lowest): subscriber.job_search_query (the exact role they
 * searched) > sector_interest / job_category > interests[] — matched against the
 * ad's title + category + sector. Location is a soft boost.
 */

// Shared, pure (browser-safe) suppression set — keeps every sender in agreement.
import { isCrossChannelStop } from './emailSuppression.mjs';

/**
 * The purpose-specific field, the legacy hard-deny switch, and the first page
 * version whose text named advertising (#5759).
 *
 * Both are declared in `services/communicationChannels.ts` too, as
 * `ADVERTISING_CONSENT_FIELD`, `ADVERTISING_OPT_OUT_FIELD` and
 * `ADVERTISING_NAMED_FROM_PAGE_VERSION`. This
 * file is an `.mjs` that Node senders load without a bundler and cannot import
 * TypeScript, so the literals are repeated and
 * `tests/consent-shown-at-signup.test.tsx` fails if the two sides disagree —
 * the same no-import-shape boundary, and the same remedy, as the cron
 * expressions and the `CHANNEL-STATUS` marker.
 *
 * `ADVERTISING_NAMED_FROM_PAGE_VERSION` is an audit date, not an eligibility
 * gate: it identifies the revision from which `/comunicazioni/` began naming
 * third-party advertising. `advertisingDisclosureWasShown` reports that fact;
 * `consentCoversAdvertising` below only honours an explicit category opt-out.
 */
export const ADVERTISING_OPT_OUT_FIELD = 'advertising_opt_out';
/** Activation marker written by a current base registration. */
export const ADVERTISING_CONSENT_FIELD = 'consent_advertising';
export const ADVERTISING_NAMED_FROM_PAGE_VERSION = '2026-08-13.2';

/** `YYYY-MM-DD.N` → comparable parts. `null` when the string is not a version. */
function parsePageVersion(raw) {
  const m = /(\d{4}-\d{2}-\d{2})\.(\d+)/.exec(String(raw ?? ''));
  return m ? { date: m[1], revision: Number(m[2]) } : null;
}

/**
 * Did the disclosure THIS person received name third-party advertising?
 *
 * A question about their stored document, not an eligibility decision. Every
 * displayed formula carries the page version inside the
 * sentence (#5765), so the document answers it by itself — `true` means the
 * page they were pointed at already had the advertising section,
 * `false` means an older version, no `consent_text` at all (8.505 of 8.605
 * documents, measured 2026-08-12) or a text with no version in it.
 *
 * It is kept, and kept honest, so the send log can distinguish recipients whose
 * stored proof predates the page disclosure from those who saw it. It is also a
 * useful audit signal if the consent policy changes later; re-deriving it from
 * an unread comment is how the comparison below gets rewritten wrong.
 *
 * Comparison is on (date, revision) and not lexicographic: `2026-08-13.10`
 * sorts BELOW `2026-08-13.2` as a string, and reporting that wrong would
 * understate the cohort by exactly the people the disclosure does cover.
 */
export function advertisingDisclosureWasShown(sub) {
  const stored = parsePageVersion(sub?.consent_text);
  if (!stored) return false;
  const floor = parsePageVersion(ADVERTISING_NAMED_FROM_PAGE_VERSION);
  if (!floor) return false;
  if (stored.date !== floor.date) return stored.date > floor.date;
  return stored.revision >= floor.revision;
}

/**
 * Does the consent we hold cover third-party advertising for this person?
 *
 * Advertising is activated by the same base registration as the other
 * communications, while remaining separately manageable in preferences. The
 * marker is informative for current rows; its absence is not a delivery gate,
 * so legacy and new rows follow the same rule. Explicit `false` or the legacy
 * opt-out field remains a hard deny.
 *
 * `advertisingDisclosureWasShown` above is intentionally separate: it reports
 * which page revision a stored proof points to, but a page revision never
 * replaces the base-activation marker or the preference opt-out used for
 * eligibility.
 */
export function consentCoversAdvertising(sub) {
  return Boolean(sub)
    && sub[ADVERTISING_CONSENT_FIELD] !== false
    && sub[ADVERTISING_OPT_OUT_FIELD] !== true;
}

/**
 * Has the reader switched this one channel off?
 *
 * A legacy explicit opt-out is always a hard deny. It is written by the
 * preference centre in both of its modes (`components/preferences/
 * SubscriptionPreferencesController.tsx` and
 * `functions/src/newsletterSubscriptionManagement.js`).
 */
export function isAdvertisingOptedOut(sub) {
  return sub?.[ADVERTISING_OPT_OUT_FIELD] === true
    || sub?.[ADVERTISING_CONSENT_FIELD] === false;
}

function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

function tokens(s) {
  return norm(s)
    .replace(/[^a-z0-9àèéìòù\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

/**
 * Score one subscriber against one ad. Returns 0 when not a match.
 * @param {object} ad          { title, category, sector, locations:[{label}] | location }
 * @param {object} sub         newsletter_subscribers doc (job_search_query, sector_interest, job_category, interests[], location_interest)
 * @returns {number} 0..~10
 */
export function scoreSubscriberForAd(ad, sub) {
  if (!ad || !sub) return 0;
  const adText = `${ad.title || ''} ${ad.category || ''} ${ad.sector || ''}`;
  const adTokens = new Set(tokens(adText));
  if (adTokens.size === 0) return 0;

  let score = 0;

  // Strongest: the exact role the subscriber searched.
  const query = norm(sub.job_search_query);
  if (query) {
    const qTokens = tokens(query);
    const overlap = qTokens.filter((w) => adTokens.has(w)).length;
    if (overlap > 0) score += 5 + overlap; // direct intent
  }

  // Sector / category alignment.
  const adCat = norm(ad.category);
  const adSec = norm(ad.sector);
  if (adCat && (norm(sub.sector_interest) === adCat || norm(sub.job_category) === adCat)) score += 3;
  if (adSec && (norm(sub.sector_interest) === adSec)) score += 2;

  // Interests array overlap.
  if (Array.isArray(sub.interests)) {
    for (const it of sub.interests) {
      if (adTokens.has(norm(it))) score += 1;
    }
  }

  // Soft location boost.
  const adLocations = Array.isArray(ad.locations)
    ? ad.locations.map((l) => norm(l && l.label != null ? l.label : l))
    : [norm(ad.location)];
  if (sub.location_interest && adLocations.includes(norm(sub.location_interest))) score += 1;

  return score;
}

/**
 * Rank + filter subscribers for one ad.
 * @param {object} ad
 * @param {object[]} subscribers
 * @param {object} [opts] { minScore=5, max=Infinity }
 * @returns {{email:string, locale:string, score:number, toldAboutAdvertising:boolean}[]} sorted desc by score
 */
export function matchSubscribersForAd(ad, subscribers, opts = {}) {
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 5;
  const max = Number.isFinite(opts.max) ? opts.max : Infinity;
  if (!Array.isArray(subscribers)) return [];

  const scored = [];
  for (const sub of subscribers) {
    if (!sub || !sub.email) continue;
    // Respect the recorded unsubscribe, hard address suppression and legacy
    // global stop-all flag. The advertising category also has its own explicit
    // opt-out field, which decides eligibility below.
    if (isCrossChannelStop(sub)) continue;
    // Third-party advertising is an ordinary base communication: no
    // double-opt-in proof, registration marker or status word is a delivery
    // gate. Only the explicit category opt-out below can stop this category.
    if (!consentCoversAdvertising(sub)) continue;
    const score = scoreSubscriberForAd(ad, sub);
    if (score >= minScore) {
      scored.push({
        email: String(sub.email),
        locale: sub.locale || 'it',
        score,
        // Audit signal only: whether this recipient's stored proof predates the
        // page disclosure. Eligibility was decided by the explicit field above.
        toldAboutAdvertising: advertisingDisclosureWasShown(sub),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}
