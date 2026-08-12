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
import { hasConfirmationProof } from './subscriberConsent.mjs';

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
    if (isNewsletterExcluded(sub.status)) continue;
    // ...and the other half of the question (#5686): the set above says who
    // opted OUT, this says who ever opted IN. A paid ad blast is ordinary
    // marketing sourced from the whole newsletter_subscribers collection —
    // exactly the shape that let the weekly newsletter mail 1.488 addresses
    // that never completed the double opt-in. The stamp decides, not `status`.
    if (!hasConfirmationProof(sub)) continue;
    const score = scoreSubscriberForAd(ad, sub);
    if (score >= minScore) {
      scored.push({ email: String(sub.email), locale: sub.locale || 'it', score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}
