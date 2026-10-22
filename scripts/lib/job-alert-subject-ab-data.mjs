/**
 * Firestore loader and pure aggregation for the daily job-alert subject test.
 *
 * Sends are read from the canonical `campaign_deliveries` rows written by the
 * sender. Engagement is matched by provider message id because job-alert
 * webhooks use different delivery document ids (and some providers do not
 * copy the alert id into their event log). Cloudflare is reported, but its
 * open/click tracking is not put in the primary KPI denominator.
 */
import {
  JOB_ALERT_SUBJECT_EXPERIMENT_ID,
  JOB_ALERT_SUBJECT_VARIANTS,
  jobAlertSubjectPeriodId,
} from './job-alert-subject-experiment.mjs';
import { toMillis } from './firestoreTimestamp.mjs';

export const EXPERIMENT_EXCLUDED_PROVIDERS = new Set(['mailtrap']);
export const UNTRACKED_PROVIDERS = new Set(['cloudflare']);
const EVENT_QUERY_CHUNK_SIZE = 30;
const EVENT_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedProvider(value) {
  return String(value || 'unknown').trim().toLowerCase() || 'unknown';
}

function eventTimeMs(event) {
  return toMillis(event?.occurred_at) || toMillis(event?.timestamp);
}

function eventKey(email, alertId) {
  return `${normalizedEmail(email)}|${String(alertId || '')}`;
}

function percentage(numerator, denominator) {
  return denominator > 0 ? (100 * numerator) / denominator : 0;
}

function rateCell(cell) {
  const allSendOpenRate = percentage(cell.opens, cell.sends);
  const allSendCtr = percentage(cell.clicks, cell.sends);
  const allSendCtor = percentage(cell.clicks, cell.opens);
  const trackedOpenRate = percentage(cell.trackedOpens, cell.trackedSends);
  const trackedCtr = percentage(cell.trackedClicks, cell.trackedSends);
  const trackedCtor = percentage(cell.trackedClicks, cell.trackedOpens);
  return {
    ...cell,
    // Primary KPI aliases, comparable across providers with tracking.
    openRate: trackedOpenRate,
    ctr: trackedCtr,
    ctor: trackedCtor,
    // Explicit aliases retained for machine consumers that want to state the
    // denominator in their label rather than infer it from trackingAvailable.
    trackedOpenRate,
    trackedClickRate: trackedCtr,
    trackedCtor,
    allSendOpenRate,
    allSendCtr,
    allSendCtor,
    clickRate: allSendCtr,
    trackingAvailable: cell.trackedSends > 0,
  };
}

function emptyCell() {
  return {
    sends: 0,
    opens: 0,
    clicks: 0,
    trackedSends: 0,
    trackedOpens: 0,
    trackedClicks: 0,
  };
}

function buildLegacySignalsByDelivery(deliveries, eventByEmailAlert) {
  const candidatesByKey = new Map();
  for (const [index, delivery] of (deliveries || []).entries()) {
    if (delivery?.inExperiment === false) continue;
    if (EXPERIMENT_EXCLUDED_PROVIDERS.has(normalizedProvider(delivery?.provider))) continue;
    // A message-id delivery is resolved by its authoritative direct signal.
    // Legacy attribution is reserved for rows that genuinely lack one.
    if (delivery?.messageId) continue;
    const sentAt = Number(delivery?.sentAt || 0);
    if (!Number.isFinite(sentAt) || sentAt <= 0) continue;
    const key = eventKey(delivery?.email, delivery?.alertId);
    if (key === '|') continue;
    const list = candidatesByKey.get(key) || [];
    list.push({ index, sentAt });
    candidatesByKey.set(key, list);
  }

  const signals = new Map();
  for (const [key, events] of eventByEmailAlert) {
    const candidates = candidatesByKey.get(key) || [];
    for (const event of events) {
      // An event carrying a message id belongs to the direct-signal path. Do
      // not let a mismatched/late delivery row steal it through the fallback.
      if (event.messageId || !event.at) continue;
      let closest = null;
      for (const candidate of candidates) {
        if (event.at < candidate.sentAt || event.at > candidate.sentAt + EVENT_ATTRIBUTION_WINDOW_MS) continue;
        if (!closest || candidate.sentAt > closest.sentAt) closest = candidate;
      }
      if (!closest) continue;
      const signal = signals.get(closest.index) || { open: false, click: false, matchedEvents: 0 };
      signal[event.type] = true;
      signal.matchedEvents++;
      signals.set(closest.index, signal);
    }
  }
  return signals;
}

/**
 * Aggregate already-normalized canonical deliveries and webhook events.
 *
 * The primary `tracked*Rate` fields are the comparable KPI. The unqualified
 * rates remain in the output so a reader can see the conservative all-send
 * rate when an untracked provider carried part of the traffic.
 */
export function aggregateJobAlertSubjectReport(deliveries = [], events = []) {
  const eventByMessage = new Map();
  const eventByEmailAlert = new Map();
  let matchedEvents = 0;

  for (const event of events || []) {
    const type = String(event?.event_type || '').trim().toLowerCase();
    if (type !== 'open' && type !== 'click') continue;
    const signal = eventByMessage.get(String(event?.message_id || '')) || { open: false, click: false };
    if (event?.message_id) {
      signal[type === 'open' ? 'open' : 'click'] = true;
      eventByMessage.set(String(event.message_id), signal);
    }
    const key = eventKey(event?.email, event?.alert_id);
    if (key !== '|') {
      const list = eventByEmailAlert.get(key) || [];
      list.push({ type, at: eventTimeMs(event), messageId: event?.message_id ? String(event.message_id) : null });
      eventByEmailAlert.set(key, list);
    }
  }

  const legacySignalsByDelivery = buildLegacySignalsByDelivery(deliveries, eventByEmailAlert);

  const cells = {};
  const byVariant = {};
  const ensure = (provider, variant) => {
    cells[provider] ??= {};
    cells[provider][variant] ??= emptyCell();
    byVariant[variant] ??= emptyCell();
    return [cells[provider][variant], byVariant[variant]];
  };
  for (const { id } of JOB_ALERT_SUBJECT_VARIANTS) {
    byVariant[id] = emptyCell();
  }

  let totalSends = 0;
  let totalOpens = 0;
  let totalClicks = 0;
  let trackedSends = 0;
  let trackedOpens = 0;
  let trackedClicks = 0;

  for (const [deliveryIndex, rawDelivery] of (deliveries || []).entries()) {
    if (rawDelivery?.inExperiment === false) continue;
    const provider = normalizedProvider(rawDelivery?.provider);
    if (EXPERIMENT_EXCLUDED_PROVIDERS.has(provider)) continue;
    const variant = String(rawDelivery?.variant || 'control');
    const [cell, pooled] = ensure(provider, variant);
    const messageId = rawDelivery?.messageId ? String(rawDelivery.messageId) : '';
    const directSignal = messageId ? eventByMessage.get(messageId) : null;
    const legacySignal = legacySignalsByDelivery.get(deliveryIndex);
    let opened = Boolean(rawDelivery?.openedAt);
    let clicked = Boolean(rawDelivery?.clickedAt);
    if (directSignal) {
      opened ||= directSignal.open;
      clicked ||= directSignal.click;
      matchedEvents += Number(directSignal.open) + Number(directSignal.click);
    }
    if (legacySignal) {
      // Legacy/provider events without a message id are assigned once, to the
      // closest preceding send of the same alert and recipient. This also
      // preserves a legacy click when the same delivery has a direct open.
      opened ||= legacySignal.open;
      clicked ||= legacySignal.click;
      matchedEvents += legacySignal.matchedEvents;
    }

    const trackable = !UNTRACKED_PROVIDERS.has(provider);
    for (const target of [cell, pooled]) {
      target.sends++;
      if (opened) target.opens++;
      if (clicked) target.clicks++;
      if (trackable) {
        target.trackedSends++;
        if (opened) target.trackedOpens++;
        if (clicked) target.trackedClicks++;
      }
    }
    totalSends++;
    if (opened) totalOpens++;
    if (clicked) totalClicks++;
    if (trackable) {
      trackedSends++;
      if (opened) trackedOpens++;
      if (clicked) trackedClicks++;
    }
  }

  const finalize = (map) => Object.fromEntries(
    Object.entries(map).map(([key, value]) => [key, rateCell(value)]),
  );
  const finalizedCells = Object.fromEntries(
    Object.entries(cells).map(([provider, variants]) => [provider, finalize(variants)]),
  );
  const finalizedByVariant = finalize(byVariant);

  return {
    experimentId: JOB_ALERT_SUBJECT_EXPERIMENT_ID,
    cells: finalizedCells,
    byVariant: finalizedByVariant,
    totalSends,
    totalOpens,
    totalClicks,
    trackedSends,
    trackedOpens,
    trackedClicks,
    trackedOpenRate: percentage(trackedOpens, trackedSends),
    trackedClickRate: percentage(trackedClicks, trackedSends),
    trackedCtor: percentage(trackedClicks, trackedOpens),
    matchedEvents,
  };
}

function emailFromDoc(doc, data) {
  return normalizedEmail(data?.email || doc?.ref?.parent?.parent?.id);
}

function normalizeDeliveryDoc(doc) {
  const data = doc.data();
  const email = emailFromDoc(doc, data);
  return {
    email,
    alertId: String(data.campaign_id || '').trim(),
    provider: normalizedProvider(data.provider),
    messageId: data.message_id ? String(data.message_id) : null,
    sentAt: toMillis(data.sent_at),
    openedAt: toMillis(data.opened_at),
    clickedAt: toMillis(data.clicked_at),
    variant: data.subject_variant || 'control',
    inExperiment: data.subject_experiment_active === true,
    operatorVerification: data.is_operator_verification === true,
    periodId: data.subject_experiment_period || null,
    subjectLine: data.subject_line || null,
  };
}

async function loadEventsByMessageId(db, messageIds) {
  const uniqueIds = [...new Set(messageIds.filter(Boolean).map(String))];
  const docs = [];
  for (let i = 0; i < uniqueIds.length; i += EVENT_QUERY_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + EVENT_QUERY_CHUNK_SIZE);
    const snap = await db.collectionGroup('events').where('message_id', 'in', chunk).get();
    docs.push(...snap.docs);
  }
  return docs;
}

async function loadEventsByAlertId(db, alertIds) {
  const uniqueIds = [...new Set(alertIds.filter(Boolean).map(String))];
  const docs = [];
  for (let i = 0; i < uniqueIds.length; i += EVENT_QUERY_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + EVENT_QUERY_CHUNK_SIZE);
    const snap = await db.collectionGroup('events').where('alert_id', 'in', chunk).get();
    docs.push(...snap.docs);
  }
  return docs;
}

function mergeEventDocs(...groups) {
  const unique = new Map();
  for (const docs of groups) {
    for (const doc of docs) {
      const key = doc?.ref?.path || doc?.id;
      if (key) unique.set(key, doc);
    }
  }
  return [...unique.values()];
}

/**
 * Read one UTC-week slice. The sender writes the experiment id and period on
 * the canonical send row, so this query never depends on webhook document ids.
 */
export async function loadJobAlertSubjectExperimentReport(
  db,
  { periodId = jobAlertSubjectPeriodId(), experimentId = JOB_ALERT_SUBJECT_EXPERIMENT_ID } = {},
) {
  const sendSnap = await db.collectionGroup('campaign_deliveries')
    .where('subject_experiment', '==', experimentId)
    .get();
  const deliveries = sendSnap.docs
    .map(normalizeDeliveryDoc)
    .filter((delivery) => delivery.sentAt > 0)
    .filter((delivery) => delivery.operatorVerification !== true)
    .filter((delivery) => delivery.periodId === periodId);
  const messageIdEvents = await loadEventsByMessageId(db, deliveries.map(({ messageId }) => messageId));
  // Older job-alert events may have no provider message id. Query their alert
  // ids only for deliveries in that legacy shape; current sends stay on the
  // cheaper, collision-safe message-id path.
  const legacyAlertIds = deliveries
    .filter(({ messageId }) => !messageId)
    .map(({ alertId }) => alertId);
  const legacyEvents = legacyAlertIds.length > 0
    ? await loadEventsByAlertId(db, legacyAlertIds)
    : [];
  const normalizedEvents = mergeEventDocs(messageIdEvents, legacyEvents).map((doc) => doc.data());
  return {
    ...aggregateJobAlertSubjectReport(deliveries, normalizedEvents),
    experimentId,
    periodId,
    deliveryCountBeforeProviderExclusion: deliveries.length,
    eventDocumentsRead: normalizedEvents.length,
  };
}
