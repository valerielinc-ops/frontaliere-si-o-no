import { createHash } from 'node:crypto';
import admin from 'firebase-admin';
import { parseJobRankingClick } from './jobEmailRankingLinks.js';
import {
  buildEmbeddedRankingUpdate,
  pseudonymousUserId,
  rankingDay,
  stableJobId,
} from './jobEmailRanking.js';

export const JOB_EMAIL_RANKING_STATS_COLLECTION = 'job_email_ranking_stats';
export const JOB_EMAIL_RANKING_EVENTS_COLLECTION = 'job_email_ranking_events';
export const JOB_EMAIL_RANKING_DELIVERIES_COLLECTION = 'job_email_ranking_deliveries';
export const JOB_EMAIL_RANKING_RETENTION_DAYS = 100;

function hashId(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 40);
}

function variantKey(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'unknown';
}

function normalizeSurfaceId(surface, value) {
  if (value) return String(value);
  return surface === 'newsletter' ? 'newsletter_weekly' : null;
}

function retentionDate(value = Date.now()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  date.setUTCDate(date.getUTCDate() + JOB_EMAIL_RANKING_RETENTION_DAYS);
  return date;
}

export function rankingStatsDocumentId({ surface, surfaceId, jobId, day }) {
  return hashId(`${surface}|${surfaceId}|${jobId}|${day}`);
}

export function rankingEventDocumentId({ provider, messageId, deliveryId, jobId }) {
  // A recipient/job pair is a binary click signal. Prefer our stable delivery
  // id so a provider retry (or a provider-side id change) cannot inflate CTR;
  // fall back to provider metadata for legacy links without delivery_id.
  return hashId(deliveryId
    ? `delivery|${deliveryId}|${jobId}`
    : `${provider || 'unknown'}|${messageId || ''}|${jobId}`);
}

export function rankingDeliveryDocumentId(deliveryId) {
  return hashId(deliveryId);
}

function incrementField(data, path, amount) {
  if (amount > 0) data[path] = admin.firestore.FieldValue.increment(amount);
}

function jobManifestEntry(job, index) {
  const ranking = job?.ranking || {};
  return {
    job_id: String(job?.jobId || stableJobId(job)),
    position: Math.max(1, Math.trunc(Number(ranking.position || index + 1))),
    ranking_score: Number.isFinite(Number(ranking.rankingScore)) ? Number(ranking.rankingScore) : null,
    relevance_score: Number.isFinite(Number(ranking.relevanceScore)) ? Number(ranking.relevanceScore) : null,
    ctr_shrink: Number.isFinite(Number(ranking.ctrShrink)) ? Number(ranking.ctrShrink) : null,
    random_boost: Number.isFinite(Number(ranking.randomBoost)) ? Number(ranking.randomBoost) : null,
  };
}

/**
 * Persist confirmed impressions and the exact ranked manifest.  The function
 * aggregates writes in memory first, so a large newsletter does not issue one
 * Firestore commit per recipient.
 */
export async function recordJobEmailImpressions(db, records) {
  if (!db || !Array.isArray(records) || records.length === 0) return { recorded: 0 };
  const stats = new Map();
  const events = new Map();
  const deliveries = new Map();

  for (const record of records) {
    if (!record?.deliveryId || !record.surface || !Array.isArray(record.jobs)) continue;
    const sentAt = record.sentAt instanceof Date ? record.sentAt : new Date(record.sentAt || Date.now());
    const day = rankingDay(sentAt);
    const surfaceId = normalizeSurfaceId(record.surface, record.surfaceId);
    if (!surfaceId) continue;
    const variant = variantKey(record.variant);
    const userId = record.userId || pseudonymousUserId(record.email);
    const manifest = record.jobs.map(jobManifestEntry);
    deliveries.set(String(record.deliveryId), {
      delivery_id: String(record.deliveryId),
      user_id: userId,
      surface: record.surface,
      surface_id: surfaceId,
      alert_id: record.alertId || null,
      newsletter_id: record.newsletterId || null,
      ranking_variant: record.variant || 'unknown',
      jobs: manifest,
      sent_at: sentAt,
      expires_at: retentionDate(sentAt),
    });

    for (const [index, job] of record.jobs.entries()) {
      const manifestJob = manifest[index];
      const jobId = manifestJob.job_id;
      const docId = rankingStatsDocumentId({ surface: record.surface, surfaceId, jobId, day });
      let row = stats.get(docId);
      if (!row) {
        row = {
          surface: record.surface,
          surface_id: surfaceId,
          alert_id: record.alertId || null,
          newsletter_id: record.newsletterId || null,
          job_id: jobId,
          date: day,
          impressions: 0,
          position_sum: 0,
          variants: new Map(),
          ref: db.collection(JOB_EMAIL_RANKING_STATS_COLLECTION).doc(docId),
        };
        stats.set(docId, row);
      }
      row.impressions += 1;
      row.position_sum += manifestJob.position;
      row.variants.set(variant, (row.variants.get(variant) || 0) + 1);

      const eventId = hashId(`${record.deliveryId}|${jobId}`);
      events.set(eventId, {
        event_type: record.surface === 'job_alert' ? 'job_alert_impression' : 'newsletter_job_impression',
        delivery_id: String(record.deliveryId),
        surface: record.surface,
        surface_id: surfaceId,
        alert_id: record.alertId || null,
        newsletter_id: record.newsletterId || null,
        job_id: jobId,
        position: manifestJob.position,
        ranking_variant: record.variant || 'unknown',
        ranking_score: manifestJob.ranking_score,
        relevance_score: manifestJob.relevance_score,
        ctr_shrink: manifestJob.ctr_shrink,
        random_boost: manifestJob.random_boost,
        user_id: userId,
        occurred_at: sentAt,
        expires_at: retentionDate(sentAt),
        ref: db.collection(JOB_EMAIL_RANKING_EVENTS_COLLECTION).doc(eventId),
      });
    }
  }

  const operations = [];
  for (const row of stats.values()) {
    const data = {
      surface: row.surface,
      surface_id: row.surface_id,
      alert_id: row.alert_id || null,
      newsletter_id: row.newsletter_id || null,
      job_id: row.job_id,
      date: row.date,
      clicks: admin.firestore.FieldValue.increment(0),
      expires_at: retentionDate(),
    };
    incrementField(data, 'impressions', row.impressions);
    incrementField(data, 'position_sum', row.position_sum);
    for (const [variant, count] of row.variants) {
      data.impressions_by_variant = {
        ...(data.impressions_by_variant || {}),
        [variantKey(variant)]: admin.firestore.FieldValue.increment(count),
      };
    }
    operations.push({ type: 'set', ref: row.ref, data });
  }
  for (const event of events.values()) {
    const { ref, ...data } = event;
    operations.push({ type: 'set', ref, data });
  }
  for (const delivery of deliveries.values()) {
    const ref = db.collection(JOB_EMAIL_RANKING_DELIVERIES_COLLECTION).doc(rankingDeliveryDocumentId(delivery.delivery_id));
    operations.push({ type: 'set', ref, data: delivery });
  }

  let committed = 0;
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = db.batch();
    for (const operation of operations.slice(offset, offset + 400)) {
      batch.set(operation.ref, operation.data, { merge: true });
    }
    await batch.commit();
    committed += operations.slice(offset, offset + 400).length;
  }
  return { recorded: deliveries.size, writes: committed };
}

/**
 * Persist one click idempotently. Provider webhooks can retry the same event;
 * the deterministic event document prevents that retry from inflating CTR.
 */
export async function recordJobEmailRankingClick(db, {
  email,
  provider,
  messageId,
  occurredAt,
  url,
} = {}) {
  if (!db || !email || !url) return { skipped: true, reason: 'missing_input' };
  const click = parseJobRankingClick(url);
  if (!click) return { skipped: true, reason: 'not_a_ranking_link' };
  const surfaceId = normalizeSurfaceId(click.surface, click.surfaceId || click.alertId);
  if (!surfaceId) return { skipped: true, reason: 'missing_surface_id' };

  const occurred = occurredAt instanceof Date ? occurredAt : new Date(occurredAt || Date.now());
  const day = rankingDay(occurred);
  const eventId = rankingEventDocumentId({
    provider,
    messageId,
    deliveryId: click.deliveryId,
    jobId: click.jobId,
  });
  const eventRef = db.collection(JOB_EMAIL_RANKING_EVENTS_COLLECTION).doc(eventId);
  const statsRef = db.collection(JOB_EMAIL_RANKING_STATS_COLLECTION).doc(
    rankingStatsDocumentId({ surface: click.surface, surfaceId, jobId: click.jobId, day }),
  );
  const alertRef = click.surface === 'job_alert' && click.alertId
    ? db.collection('job_alert_subscribers').doc(String(email).trim().toLowerCase())
      .collection('alerts').doc(String(click.alertId))
    : null;
  const FieldValue = admin.firestore.FieldValue;
  const userId = pseudonymousUserId(email);
  const eventData = {
    event_type: click.surface === 'job_alert' ? 'job_alert_click' : 'newsletter_job_click',
    surface: click.surface,
    surface_id: surfaceId,
    alert_id: click.alertId || null,
    newsletter_id: click.newsletterId || null,
    job_id: click.jobId,
    delivery_id: click.deliveryId || null,
    position: click.position,
    ranking_variant: click.variant || 'unknown',
    ranking_score: click.rankingScore,
    relevance_score: click.relevanceScore,
    ctr_shrink: click.ctrShrink,
    random_boost: click.randomBoost,
    user_id: userId,
    provider: provider || 'unknown',
    message_id: messageId || null,
    occurred_at: occurred,
    expires_at: retentionDate(occurred),
  };

  // The alert mirror is optional. Probe it outside the transaction so clicks
  // on the same alert do not contend with the send path merely to decide
  // whether an embedded mirror should be updated.
  let alertSnapshot = null;
  if (alertRef) {
    try {
      alertSnapshot = await alertRef.get();
    } catch (error) {
      console.warn('⚠️ Job-email ranking alert mirror probe failed:', error?.message || error);
    }
  }

  let recorded = false;
  try {
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(eventRef);
      if (existing.exists) return;
      transaction.create(eventRef, eventData);
      transaction.set(statsRef, {
        surface: click.surface,
        surface_id: surfaceId,
        alert_id: click.alertId || null,
        newsletter_id: click.newsletterId || null,
        job_id: click.jobId,
        date: day,
        impressions: FieldValue.increment(0),
        position_sum: FieldValue.increment(0),
        clicks: FieldValue.increment(1),
        clicks_by_variant: {
          [variantKey(click.variant)]: FieldValue.increment(1),
        },
        expires_at: retentionDate(occurred),
      }, { merge: true });
      recorded = true;
    });

    if (recorded && alertRef && alertSnapshot?.exists) {
      const alertUpdate = buildEmbeddedRankingUpdate({
        jobId: click.jobId,
        day,
        eventType: 'click',
        variant: click.variant,
        FieldValue,
      });
      // buildEmbeddedRankingUpdate returns field-path keys for update()/batch.update().
      // `set(..., { merge: true })` would persist those dots literally. This
      // best-effort mirror is deliberately outside the durable transaction:
      // an alert deleted after the probe must not discard the click aggregate.
      try {
        await alertRef.update(alertUpdate);
      } catch (error) {
        console.warn('⚠️ Job-email ranking alert mirror update failed:', error?.message || error);
      }
    }
  } catch (error) {
    // Ranking analytics must never turn a provider webhook into a retry storm
    // or block the ordinary subscriber engagement update.
    console.warn('⚠️ Job-email ranking click persist failed:', error?.message || error);
    return { skipped: true, reason: 'persist_failed' };
  }
  return { recorded, click };
}

/** Load global newsletter daily rows for the configured ranking window. */
export async function loadNewsletterRankingStats(db, { sinceDay = null } = {}) {
  const result = new Map();
  if (!db) return result;
  try {
    let query = db.collection(JOB_EMAIL_RANKING_STATS_COLLECTION)
      .where('surface', '==', 'newsletter')
      .where('surface_id', '==', 'newsletter_weekly');
    if (sinceDay) query = query.where('date', '>=', String(sinceDay));
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const row = doc.data() || {};
      const jobId = String(row.job_id || '');
      if (!jobId) continue;
      const entry = result.get(jobId) || { days: {} };
      const day = String(row.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const dayRow = entry.days[day] || { impressions: 0, clicks: 0, position_sum: 0 };
      dayRow.impressions += Number(row.impressions) || 0;
      dayRow.clicks += Number(row.clicks) || 0;
      dayRow.position_sum += Number(row.position_sum) || 0;
      entry.days[day] = dayRow;
      result.set(jobId, entry);
    }
  } catch (error) {
    console.warn('⚠️ Newsletter job-ranking stats unavailable:', error?.message || error);
  }
  return result;
}
