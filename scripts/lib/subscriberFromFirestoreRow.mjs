import { parseEmailField } from './parseEmailField.mjs';
import { deriveNameFromEmail, recognizeFirstName } from './deriveNameFromEmail.mjs';
import { sanitizeFirstName } from '../../services/newsletter-template.mjs';
import { calculateEngagementScore } from '../../functions/src/lib/engagementScore.js';

/**
 * Resolve the greeting first name for a subscriber row, highest confidence
 * first. Anything not confidently a real human first name resolves to null,
 * and the caller falls back to the generic "frontaliere" greeting.
 *
 *   1. row.firstName — clean stored first name (no re-derivation needed)
 *   2. row.name      — social display name (Google/LinkedIn/Facebook auth)
 *   3. display name harvested from a "Name <addr>" email field — dataset-validated
 *   4. dataset-validated guess from the email local-part
 *
 * (1)/(2) are trusted auth-provided names → only sanitized. (3)/(4) are
 * lower-trust → must clear recognizeFirstName/deriveNameFromEmail (role-word
 * + open-source names dataset), so "Frontaliere Ticino <addr>" or "info@…"
 * never produce a bogus greeting.
 *
 * @param {Record<string, any>} row
 * @param {{ email: string, displayName: string|null }} parsed
 * @returns {string|null}
 */
function resolveFirstName(row, parsed) {
  return (
    sanitizeFirstName(row.firstName) ||
    sanitizeFirstName(row.name) ||
    recognizeFirstName(parsed.displayName) ||
    deriveNameFromEmail(parsed.email) ||
    null
  );
}

/**
 * Project a raw `newsletter_subscribers` Firestore row into the subscriber
 * shape the send pipeline consumes. Extracted into its own module (away from
 * the CLI `send-newsletter.mjs`, which can't be imported by vitest — its
 * shebang + `import.meta.glob` break the vite/rollup parser) so the
 * name-harvest behaviour is unit-testable.
 *
 * IMPORTANT: callers must pass the RAW `row` (do NOT pre-normalize
 * `row.email`). The "Name <addr>" display name is harvested HERE via
 * parseEmailField; pre-stripping the wrapper upstream would silently disable
 * the greeting-name harvest while leaving `row.name` empty.
 *
 * @param {Record<string, any>} row
 * @returns {object | null} null when the row has no usable email address
 */
export function subscriberFromFirestoreRow(row) {
  const parsed = parseEmailField(row.email);
  const email = parsed.email;
  if (!email) return null;
  const fresh = calculateEngagementScore(row);
  const firstName = resolveFirstName(row, parsed);
  return {
    email,
    name: row.name || parsed.displayName || null,
    // Greeting first name (high-confidence or null → generic greeting).
    firstName,
    // When the doc has no stored firstName yet but we resolved one, persist it
    // on the next send so future runs skip re-derivation (see persistDelivery).
    firstNameToPersist: !row.firstName && firstName ? firstName : null,
    locale: (row.preferred_locale || row.locale || 'it').split(/[-_]/)[0] || 'it',
    sourceChannel: row.source_channel || row.source || 'newsletter_page',
    locationInterest: row.location_interest || null,
    sectorInterest: row.sector_interest || null,
    job_slug: row.job_slug || null,
    job_company: row.job_company || null,
    job_location: row.job_location || null,
    job_category: row.job_category || null,
    job_search_query: row.job_search_query || null,
    job_context_backfill_slug: row.job_context_backfill_slug || null,
    source: row.source || null,
    // Acquisition-surface signals written by services/newsletterSubscribers.ts
    // on signup. Feed services/newsletter-segments.mjs:inferInterest so
    // per-segment content assembly (#4299) knows jobs vs articles vs utility
    // interest without a separate tracking pipeline.
    sourceRouteFamily: row.source_route_family || null,
    sourceComponent: row.source_component || null,
    preferences: row.preferences || {},
    type: row.type || null,
    // Default true: only skip autologin if user explicitly opted out
    autologinEnabled: row.autologin_enabled !== false,
    createdAt: row.createdAt?.toDate?.() || (row.created_at ? new Date(row.created_at) : null),
    // Engagement metadata used for prioritized send order
    sendCount: Number(row.send_count || row.sendCount) || 0,
    engagementScore: fresh.score,
    engagementLevel: fresh.level,
    // Per-user scheduled-send hour (#3798) — written by
    // functions/src/lib/preferredSendHour.js from open/click history. null
    // hourUtc/0 sampleCount means "no personal preference yet" (cold start),
    // consumed by scripts/lib/send-schedule.mjs:resolveEffectivePreferredHour.
    preferredSendHourUtc: row.preferred_send_hour_utc ?? null,
    preferredSendSampleCount: row.preferred_send_sample_count ?? 0,
  };
}
