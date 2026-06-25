import { parseEmailField } from './parseEmailField.mjs';
import { calculateEngagementScore } from '../../functions/src/lib/engagementScore.js';

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
  return {
    email,
    // Greeting-name resolution: stored social name → display name harvested
    // from a "Name <addr>" email field → (later) dataset-validated email guess.
    name: row.name || parsed.displayName || null,
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
    preferences: row.preferences || {},
    type: row.type || null,
    // Default true: only skip autologin if user explicitly opted out
    autologinEnabled: row.autologin_enabled !== false,
    createdAt: row.createdAt?.toDate?.() || (row.created_at ? new Date(row.created_at) : null),
    // Engagement metadata used for prioritized send order
    sendCount: Number(row.send_count || row.sendCount) || 0,
    engagementScore: fresh.score,
    engagementLevel: fresh.level,
  };
}
