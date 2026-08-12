/**
 * resubscribePairs.mjs — find opt-outs that were undone seconds later.
 *
 * WHY THE OBVIOUS QUERY DOES NOT WORK (#5711)
 * -------------------------------------------
 * The 186 resurrected opt-outs of #5672 were found by looking for documents
 * that carry `unsubscribed_at` and are nevertheless active. That method is
 * blind to this defect, and blind for a structural reason: until #5711 a
 * re-subscription DELETED `unsubscribed_at`. The production case that opened
 * the issue — unsubscribe 12:40:53, back to `confirmed`/active at 12:40:55 with
 * `source_channel: resubscribe_link` — reads back with `unsubscribed_at: null`.
 * The faster the reactivation, the cleaner the document looks.
 *
 * What survives is the `events` SUBCOLLECTION, which is append-only: nothing in
 * the codebase deletes an event. So the measurement runs there, on PAIRS: an
 * opt-out event followed, within a short window, by a re-opt-in event on the
 * same address. 1,5 seconds is not a change of mind; it is a link-following
 * scanner, the same signature as the 25 fetches in 7 seconds of #5674.
 *
 * This module is the pure half — no Firestore, no network, no clock — so the
 * rule can be tested against fixtures (tests/resubscribe-pairs.test.ts) instead
 * of against production. scripts/audit-resubscribe-pairs.mjs is the IO half.
 */

import { toEpochMillis } from '../../services/newsletterOptOut.mjs';

/**
 * Event types that RECORD AN OPT-OUT.
 *
 * `unsubscribe` is what functions/src/newsletterSubscriptionManagement.js
 * writes for the footer link and the RFC 8058 one-click;
 * `subscription_unsubscribed` is the preference-centre toggle. Both are the
 * left half of a pair.
 */
export const OPT_OUT_EVENT_TYPES = Object.freeze(['unsubscribe', 'subscription_unsubscribed']);

/**
 * Event types that RECORD A RE-OPT-IN.
 *
 * `subscribe_completed` is what the `resubscribe` branch writes and the one the
 * issue names. `subscription_resubscribed` (preference centre) and `confirm`
 * (double opt-in) are included because they land the same state change, and a
 * measurement that only counted one route would under-report by exactly the
 * routes nobody thought to look at — the mistake #5673 made with the two
 * spellings of the stamp.
 */
export const RE_OPT_IN_EVENT_TYPES = Object.freeze([
  'subscribe_completed',
  'subscription_resubscribed',
  'confirm',
]);

/** Default pairing window. Generous on purpose — see the report's `gapMs`. */
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * When did this event happen? `occurred_at` is an ISO string written by the
 * same statement as the Firestore `timestamp` sentinel, and it is the one that
 * is readable without resolving a sentinel, so it wins.
 * @param {Record<string, any>} event
 * @returns {number|null}
 */
export function eventMillis(event) {
  return toEpochMillis(event?.occurred_at) ?? toEpochMillis(event?.timestamp);
}

function normalizeType(event) {
  return String(event?.event_type || '').trim().toLowerCase();
}

/**
 * Pair every opt-out event with the FIRST re-opt-in that follows it on the same
 * address, and report the pairs that land inside the window.
 *
 * "First that follows" and not "any that follows": someone who opts out, comes
 * back three months later and opts out again produces two independent pairs,
 * not four. Events with no readable timestamp are dropped rather than guessed
 * at — a pair whose gap cannot be computed is not evidence of anything.
 *
 * @param {Array<Record<string, any>>} events Flat list; each needs `email` and `event_type`.
 * @param {{ windowSeconds?: number }} [options]
 * @returns {Array<{email: string, optOutType: string, reOptInType: string, optOutAt: string, reOptInAt: string, gapMs: number, sourceChannel: string|null, requestMethod: string|null, userAgent: string|null}>}
 */
export function findRapidResubscribePairs(events, options = {}) {
  const windowSeconds = Number.isFinite(options.windowSeconds) && options.windowSeconds > 0
    ? options.windowSeconds
    : DEFAULT_WINDOW_SECONDS;
  const windowMs = windowSeconds * 1000;

  const byEmail = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const email = String(event?.email || '').trim().toLowerCase();
    if (!email) continue;
    const type = normalizeType(event);
    if (!OPT_OUT_EVENT_TYPES.includes(type) && !RE_OPT_IN_EVENT_TYPES.includes(type)) continue;
    const ms = eventMillis(event);
    if (ms == null) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push({ email, type, ms, raw: event });
  }

  const pairs = [];
  for (const [email, rows] of byEmail) {
    // Stable order: equal timestamps keep the order they arrived in, which for a
    // 0 ms pair is the only thing that says which side came first.
    rows.sort((a, b) => a.ms - b.ms);
    for (let i = 0; i < rows.length; i += 1) {
      if (!OPT_OUT_EVENT_TYPES.includes(rows[i].type)) continue;
      const next = rows.slice(i + 1).find((r) => RE_OPT_IN_EVENT_TYPES.includes(r.type));
      if (!next) continue;
      const gapMs = next.ms - rows[i].ms;
      if (gapMs > windowMs) continue;
      pairs.push({
        email,
        optOutType: rows[i].type,
        reOptInType: next.type,
        optOutAt: new Date(rows[i].ms).toISOString(),
        reOptInAt: new Date(next.ms).toISOString(),
        gapMs,
        sourceChannel: typeof next.raw?.source_channel === 'string' ? next.raw.source_channel : null,
        requestMethod: typeof next.raw?.request_method === 'string' ? next.raw.request_method : null,
        userAgent: typeof rows[i].raw?.unsubscribe_user_agent === 'string'
          ? rows[i].raw.unsubscribe_user_agent
          : null,
      });
    }
  }

  pairs.sort((a, b) => a.gapMs - b.gapMs || a.email.localeCompare(b.email));
  return pairs;
}

/**
 * Bucket the pairs so the report says something other than a total.
 *
 * The buckets are the argument, not decoration: a scanner clusters in the first
 * seconds and a human does not, so a distribution that is flat across minutes
 * would say the pairing rule is catching ordinary behaviour and should not be
 * acted on.
 *
 * @param {ReturnType<typeof findRapidResubscribePairs>} pairs
 */
export function summarizePairs(pairs) {
  const buckets = { '<2s': 0, '2-10s': 0, '10-60s': 0, '>60s': 0 };
  const byChannel = new Map();
  const byMethod = new Map();
  for (const p of pairs) {
    if (p.gapMs < 2000) buckets['<2s'] += 1;
    else if (p.gapMs < 10_000) buckets['2-10s'] += 1;
    else if (p.gapMs <= 60_000) buckets['10-60s'] += 1;
    else buckets['>60s'] += 1;
    const ch = p.sourceChannel || '(none)';
    byChannel.set(ch, (byChannel.get(ch) || 0) + 1);
    const m = p.requestMethod || '(unrecorded)';
    byMethod.set(m, (byMethod.get(m) || 0) + 1);
  }
  return {
    total: pairs.length,
    uniqueEmails: new Set(pairs.map((p) => p.email)).size,
    buckets,
    byChannel: Object.fromEntries([...byChannel].sort((a, b) => b[1] - a[1])),
    byMethod: Object.fromEntries([...byMethod].sort((a, b) => b[1] - a[1])),
  };
}
