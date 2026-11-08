/**
 * newsletterJobAlertCooldown.mjs — when the weekly newsletter defers a
 * subscriber because a job alert reached them in the last 36h.
 *
 * The cooldown is symmetric with send-job-alerts.mjs:NEWSLETTER_COOLDOWN_MS, so
 * nobody gets two automated emails in the same ~1.5-day window. On its own it
 * starves daily job-alert recipients: their `last_sent_at` is always < 36h old
 * when the newsletter runs, so every run defers them again until the campaign
 * closes. Measured on weekly_2026-09-28: 520 eligible subscribers never reached,
 * 149 of them also missing weekly_2026-09-21.
 *
 * So the deferral is bounded: the cooldown holds for the first
 * JOB_ALERT_COOLDOWN_MAX_DEFER_DAYS of the campaign week (UTC, from its Monday)
 * and is lifted after that, so whoever is still pending gets the issue. The
 * job-alert side keeps its own cooldown, so the alert after the newsletter is
 * the one that moves — one alert a week, instead of the whole newsletter.
 */

import { normalizeEmailAddress } from './parseEmailField.mjs';

export const JOB_ALERT_COOLDOWN_MS = 36 * 60 * 60 * 1000;
export const JOB_ALERT_COOLDOWN_MAX_DEFER_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the job-alert cooldown still applies to `campaignId` at `nowMs`.
 * An id that is not `weekly_YYYY-MM-DD` keeps the cooldown (conservative).
 * @param {{ campaignId: string, nowMs: number }} args
 * @returns {boolean}
 */
export function jobAlertCooldownApplies({ campaignId, nowMs }) {
  const m = /^weekly_(\d{4}-\d{2}-\d{2})$/.exec(String(campaignId || ''));
  if (!m) return true;
  const startMs = Date.parse(`${m[1]}T00:00:00Z`);
  if (!Number.isFinite(startMs)) return true;
  return nowMs < startMs + JOB_ALERT_COOLDOWN_MAX_DEFER_DAYS * DAY_MS;
}

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return new Date(value).getTime();
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
}

/**
 * Find only job-alert subscribers whose last send can still trigger the
 * newsletter cooldown. Timestamp and ISO-string queries cover the canonical
 * writer and the legacy string shape; callers still check the parsed instant
 * before excluding a newsletter recipient.
 * @param {FirebaseFirestore.Firestore} db
 * @param {number} cutoffMs
 * @returns {Promise<Set<string>>}
 */
export async function loadRecentJobAlertCooldownEmails(db, cutoffMs) {
  if (!Number.isFinite(cutoffMs)) throw new TypeError('cutoffMs must be a finite timestamp');
  const collection = db.collection('job_alert_subscribers');
  const cutoffDate = new Date(cutoffMs);
  const [timestampSnapshot, stringSnapshot] = await Promise.all([
    collection.where('last_sent_at', '>=', cutoffDate).get(),
    collection.where('last_sent_at', '>=', cutoffDate.toISOString()).get(),
  ]);

  const emails = new Set();
  for (const snapshot of [timestampSnapshot, stringSnapshot]) {
    for (const document of snapshot.docs || []) {
      const sentAt = timestampMillis(document.data()?.last_sent_at);
      if (sentAt >= cutoffMs) {
        const email = normalizeEmailAddress(document.id);
        if (email) emails.add(email);
      }
    }
  }
  return emails;
}
