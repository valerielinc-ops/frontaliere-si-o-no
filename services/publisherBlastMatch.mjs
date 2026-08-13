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
import { isNewsletterExcluded } from './emailSuppression.mjs';
import { isNewsletterOptOutBinding } from './newsletterOptOut.mjs';
import { hasConfirmationProof } from './subscriberConsent.mjs';

/**
 * The switch, and the first page version whose text named advertising (#5759).
 *
 * Both are declared in `services/communicationChannels.ts` too, as
 * `ADVERTISING_OPT_OUT_FIELD` and `ADVERTISING_NAMED_FROM_PAGE_VERSION`. This
 * file is an `.mjs` that Node senders load without a bundler and cannot import
 * TypeScript, so the literals are repeated and
 * `tests/consent-shown-at-signup.test.tsx` fails if the two sides disagree —
 * the same no-import-shape boundary, and the same remedy, as the cron
 * expressions and the `CHANNEL-STATUS` marker.
 */
export const ADVERTISING_OPT_OUT_FIELD = 'advertising_opt_out';
export const ADVERTISING_NAMED_FROM_PAGE_VERSION = '2026-08-13.2';

/** `YYYY-MM-DD.N` → comparable parts. `null` when the string is not a version. */
function parsePageVersion(raw) {
  const m = /(\d{4}-\d{2}-\d{2})\.(\d+)/.exec(String(raw ?? ''));
  return m ? { date: m[1], revision: Number(m[2]) } : null;
}

/**
 * Did the disclosure this person actually received name third-party
 * advertising?
 *
 * The owner's decision (#5764 §3) is an opt-out, and the defence it rests on is
 * "the formula names it and a switch stops it". That defence exists only for
 * someone whose stored sentence names it — every displayed formula since
 * `ADVERTISING_NAMED_FROM_PAGE_VERSION` carries the page version inside the
 * text (#5765), so the stored document answers the question by itself.
 *
 * Fail-closed on purpose, and the cases are not equivalent to each other only
 * in appearance: no `consent_text` at all (8.505 of 8.605 documents measured
 * 2026-08-12), a text from an older page version, or an unparseable one all
 * mean the same thing here — we cannot show that this person was told. The
 * audience refills with everyone who reads the new sentence.
 *
 * Comparison is on (date, revision) and not lexicographic: `2026-08-13.10`
 * sorts BELOW `2026-08-13.2` as a string, and getting that wrong would silently
 * start excluding people the disclosure does cover.
 */
export function consentCoversAdvertising(sub) {
  const stored = parsePageVersion(sub?.consent_text);
  if (!stored) return false;
  const floor = parsePageVersion(ADVERTISING_NAMED_FROM_PAGE_VERSION);
  if (!floor) return false;
  if (stored.date !== floor.date) return stored.date > floor.date;
  return stored.revision >= floor.revision;
}

/**
 * Has the reader switched this one channel off?
 *
 * Absent means ON, because the consent is an opt-out: only an explicit `true`
 * may be read as "no". Written by the preference centre in both of its modes
 * (`components/preferences/SubscriptionPreferencesController.tsx` and
 * `functions/src/newsletterSubscriptionManagement.js`).
 */
export function isAdvertisingOptedOut(sub) {
  return sub?.[ADVERTISING_OPT_OUT_FIELD] === true;
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
 * @returns {{email:string, locale:string, score:number}[]} sorted desc by score
 */
export function matchSubscribersForAd(ad, subscribers, opts = {}) {
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 5;
  const max = Number.isFinite(opts.max) ? opts.max : Infinity;
  if (!Array.isArray(subscribers)) return [];

  const scored = [];
  for (const sub of subscribers) {
    if (!sub || !sub.email) continue;
    // Respect unsubscribe + hard suppression (bounce/complaint/provider list).
    // Previously checked the literal 'complaint' — an event-type name, never a
    // subscriber status value — so complained/suppressed users were still mailed.
    // The stamp is the second half of the same record: `status` is one
    // last-writer-wins field and 458 documents carry only the camelCase
    // `unsubscribedAt` (#5673, #5688). Read through the shared predicate, which
    // also owns the supersession rule the append-only stamp needs (#5711).
    // `sub` is the raw doc — blast-publisher-ads.mjs passes `d.data()` straight
    // through — so every field the predicate reads is present.
    if (isNewsletterExcluded(sub.status) || isNewsletterOptOutBinding(sub)) continue;
    // ...and the other half of the question (#5686): the set above says who
    // opted OUT, this says who ever opted IN. A paid ad blast is ordinary
    // marketing sourced from the whole newsletter_subscribers collection —
    // exactly the shape that let the weekly newsletter mail 1.488 addresses
    // that never completed the double opt-in. The stamp decides, not `status`.
    if (!hasConfirmationProof(sub)) continue;
    // …and the third question, which only this channel has to ask (#5759).
    // Advertising is a consent category of its own, collected as an opt-out:
    // so the disclosure has to have named it (`consentCoversAdvertising`) and
    // the reader must not have switched it off (`isAdvertisingOptedOut`).
    // Order is irrelevant to the result and deliberate for the reader: "were
    // they told" comes before "did they object".
    if (!consentCoversAdvertising(sub)) continue;
    if (isAdvertisingOptedOut(sub)) continue;
    const score = scoreSubscriberForAd(ad, sub);
    if (score >= minScore) {
      scored.push({ email: String(sub.email), locale: sub.locale || 'it', score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}
