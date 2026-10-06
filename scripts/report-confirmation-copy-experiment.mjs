#!/usr/bin/env node

/**
 * Report read-only dell'esperimento copy DOI #6317.
 *
 * Unità primaria = iscritto eleggibile, deduplicato per indirizzo solo in
 * memoria; il denominatore è la prima richiesta inviata a quell'iscritto e
 * un clic su qualunque follow-up dello stesso braccio conta come successo.
 * Il messaggio provider, deduplicato per `message_id`, resta un conteggio
 * ausiliario per il controllo degli invii. Il report riduce gli eventi ai soli
 * aggregati per braccio, source_cta, provider e locale; non serializza email,
 * message id o altri identificativi.
 *
 * Criterio dichiarato prima dell'attivazione:
 *   - finestra: almeno 14 giorni dall'attivazione e almeno 400 invii per
 *     braccio: vale la condizione che arriva dopo;
 *   - confronto primario: differenza della percentuale di iscritti con almeno
 *     un clic di conferma `generic - contextual`, con IC 95%;
 *   - un braccio può prevalere solo se l'IC primario esclude lo zero e il
 *     segno regge in ogni strato principale con almeno 30 invii per braccio,
 *     considerando separatamente source_cta, provider e locale;
 *   - se il campione non è pronto, gli strati sono ambigui o la differenza è
 *     compatibile con la parità, la decisione resta `contextual`;
 *   - nessun peeking modifica il rollout durante la finestra.
 *
 * Uso:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
 *   node scripts/report-confirmation-copy-experiment.mjs \
 *     --activation 2026-10-07T00:00:00Z \
 *     --from 2026-10-07T00:00:00Z --to 2026-10-21T00:00:00Z \
 *     --out /tmp/confirmation-copy-ab.json
 *
 * Il processo legge soltanto Firestore e, se richiesto, scrive un file locale.
 * Non invia email e non modifica Remote Config.
 */

import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import {
  CONFIRMATION_COPY_CAMPAIGN_PREFIX,
  CONFIRMATION_COPY_VARIANTS,
  parseConfirmationCopyCampaignId,
} from '../functions/src/lib/confirmationCopyExperiment.js';
import { campaignIdFromTags } from '../functions/src/lib/mailerooRef.js';

export const REPORT_SCHEMA_VERSION = 1;
export const MIN_ARM_SENDS = 400;
export const MIN_STRATUM_SENDS = 30;
export const MIN_HORIZON_DAYS = 14;
export const CONFIRMATION_COPY_EVENT_TYPES = Object.freeze(['send', 'open', 'click']);

const DAY_MS = 24 * 60 * 60 * 1000;
const Z95 = 1.959964;
const EVENT_FIELDS = Object.freeze([
  'event_type',
  'campaign_id',
  'message_id',
  'provider',
  'email',
  'timestamp',
  'occurred_at',
  'metadata',
]);

/** Firestore Timestamp | Date | ISO | millis → millis, or null. */
export function toMillis(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value._seconds === 'number') return value._seconds * 1000;
    if (value instanceof Date) return value.getTime();
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(4));
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,30}$/.test(provider) ? provider : 'unknown';
}

function campaignIdFromEvent(event) {
  const direct = String(event?.campaign_id || '').trim();
  if (direct) return direct;
  const metadata = event?.metadata;
  const tags = metadata?.tags || metadata?.data?.tags;
  return campaignIdFromTags(tags);
}

function normalizeSubscriberKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.includes('@') ? normalized : '';
}

function eventMillis(event) {
  return toMillis(event?.timestamp ?? event?.occurred_at);
}

function messageJoinKey(event, campaignId) {
  const provider = normalizeProvider(event?.provider);
  const messageId = String(event?.message_id || '').trim();
  if (messageId) return `${provider}|${messageId}|${campaignId}`;
  // Provider events normally carry message_id. This fallback is retained for
  // old rows only; the address never leaves this in-memory join key.
  const address = String(event?.email || '').trim().toLowerCase();
  const occurred = String(event?.occurred_at || event?.timestamp || '');
  return `${provider}|${address}|${campaignId}|${occurred}`;
}

/**
 * Fold provider events into one compact record per experiment message.
 * Raw identifiers are used only as in-memory join keys and are not returned.
 */
export function aggregateConfirmationCopyEvents(events = []) {
  const messages = new Map();
  let experimentEvents = 0;
  let ignoredEvents = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const eventType = String(event.event_type || '');
    if (!CONFIRMATION_COPY_EVENT_TYPES.includes(eventType)) continue;
    const campaignId = campaignIdFromEvent(event);
    const parsed = parseConfirmationCopyCampaignId(campaignId);
    if (!parsed) {
      ignoredEvents++;
      continue;
    }
    experimentEvents++;
    const key = messageJoinKey(event, campaignId);
    let message = messages.get(key);
    if (!message) {
      message = {
        variant: parsed.variant,
        source_cta: parsed.source_cta,
        locale: parsed.locale,
        provider: normalizeProvider(event.provider),
        subscriberKey: normalizeSubscriberKey(event.email),
        sentAt: null,
        joinKey: key,
        sent: false,
        opened: false,
        clicked: false,
      };
      messages.set(key, message);
    }
    if (!message.subscriberKey) message.subscriberKey = normalizeSubscriberKey(event.email);
    if (eventType === 'send') message.sent = true;
    if (eventType === 'send') {
      const ms = eventMillis(event);
      if (ms != null && (message.sentAt == null || ms < message.sentAt)) message.sentAt = ms;
    }
    if (eventType === 'open') message.opened = true;
    if (eventType === 'click') message.clicked = true;
  }

  const sentMessages = [...messages.values()].filter((message) => message.sent);
  const subscribersByKey = new Map();
  let missingSubscriberIdentity = 0;
  for (const message of sentMessages) {
    // No identity, no subscriber. A message that cannot be tied to a person
    // stays in the auxiliary per-message tables, but it must not enter the
    // per-subscriber aggregates: counted as one more distinct person each, a
    // batch of identity-less follow-ups would inflate the denominator of the
    // primary metric and could satisfy the readiness floor on its own.
    if (!message.subscriberKey) {
      missingSubscriberIdentity += 1;
      continue;
    }
    const subscriberKey = message.subscriberKey;
    let subscriber = subscribersByKey.get(subscriberKey);
    if (!subscriber) {
      subscriber = {
        variant: message.variant,
        source_cta: message.source_cta,
        locale: message.locale,
        provider: message.provider,
        sentAt: message.sentAt,
        sentMessages: 0,
        opened: false,
        clicked: false,
      };
      subscribersByKey.set(subscriberKey, subscriber);
    }
    subscriber.sentMessages += 1;
    subscriber.opened ||= message.opened;
    subscriber.clicked ||= message.clicked;
    if (message.sentAt != null && (subscriber.sentAt == null || message.sentAt < subscriber.sentAt)) {
      subscriber.variant = message.variant;
      subscriber.source_cta = message.source_cta;
      subscriber.locale = message.locale;
      subscriber.provider = message.provider;
      subscriber.sentAt = message.sentAt;
    }
  }
  const subscribers = [...subscribersByKey.values()].map(({ sentAt, ...subscriber }) => subscriber);
  const safeMessages = sentMessages.map(({ subscriberKey, sentAt, joinKey, ...message }) => message);
  return {
    messages: safeMessages,
    subscribers,
    counters: {
      experiment_events: experimentEvents,
      ignored_provider_events: ignoredEvents,
      sent_messages: sentMessages.length,
      eligible_subscribers: subscribers.length,
      missing_subscriber_identity: missingSubscriberIdentity,
      followup_messages_collapsed: Math.max(0, sentMessages.length - missingSubscriberIdentity - subscribers.length),
      orphan_engagement_messages: [...messages.values()].filter((message) => !message.sent && (message.opened || message.clicked)).length,
    },
  };
}

function emptyCounts() {
  return { sends: 0, opened: 0, clicked: 0 };
}

function bump(counts, message) {
  counts.sends++;
  if (message.opened) counts.opened++;
  if (message.clicked) counts.clicked++;
}

function wilson(successes, trials) {
  if (!(trials > 0)) return null;
  const p = successes / trials;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const margin = Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials) / denominator;
  return { low_pct: round(100 * Math.max(0, centre - margin)), high_pct: round(100 * Math.min(1, centre + margin)) };
}

function cell(counts) {
  return {
    sends: counts.sends,
    opened: counts.opened,
    clicked: counts.clicked,
    open_rate_pct: counts.sends ? round(100 * counts.opened / counts.sends) : null,
    open_ci95_pct: wilson(counts.opened, counts.sends),
    click_rate_pct: counts.sends ? round(100 * counts.clicked / counts.sends) : null,
    click_ci95_pct: wilson(counts.clicked, counts.sends),
  };
}

function sortedObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function dimensionTable(messages, dimension) {
  const table = {};
  for (const message of messages) {
    const dimensionValue = message[dimension];
    if (!dimensionValue) continue;
    table[dimensionValue] ||= {
      [CONFIRMATION_COPY_VARIANTS.GENERIC]: emptyCounts(),
      [CONFIRMATION_COPY_VARIANTS.CONTEXTUAL]: emptyCounts(),
    };
    bump(table[dimensionValue][message.variant], message);
  }
  return sortedObject(Object.fromEntries(
    Object.entries(table).map(([key, arms]) => [key, Object.fromEntries(
      Object.entries(arms).map(([variant, counts]) => [variant, cell(counts)]),
    )]),
  ));
}

function rawDimensionTable(messages, dimension) {
  const table = {};
  for (const message of messages) {
    const dimensionValue = message[dimension];
    if (!dimensionValue) continue;
    table[dimensionValue] ||= {
      [CONFIRMATION_COPY_VARIANTS.GENERIC]: emptyCounts(),
      [CONFIRMATION_COPY_VARIANTS.CONTEXTUAL]: emptyCounts(),
    };
    bump(table[dimensionValue][message.variant], message);
  }
  return table;
}

function differenceCi(generic, contextual) {
  if (!(generic.sends > 0) || !(contextual.sends > 0)) return null;
  const genericRate = generic.clicked / generic.sends;
  const contextualRate = contextual.clicked / contextual.sends;
  const standardError = Math.sqrt(
    (genericRate * (1 - genericRate)) / generic.sends
    + (contextualRate * (1 - contextualRate)) / contextual.sends,
  );
  const difference = genericRate - contextualRate;
  return {
    low_pct_points: round(100 * (difference - Z95 * standardError)),
    high_pct_points: round(100 * (difference + Z95 * standardError)),
  };
}

function comparison(generic, contextual) {
  const difference = generic.sends > 0 && contextual.sends > 0
    ? round(100 * (generic.clicked / generic.sends - contextual.clicked / contextual.sends))
    : null;
  const ci = differenceCi(generic, contextual);
  const significant = Boolean(ci && (ci.low_pct_points > 0 || ci.high_pct_points < 0));
  return {
    generic: cell(generic),
    contextual: cell(contextual),
    difference_generic_minus_contextual_pct_points: difference,
    difference_ci95_pct_points: ci,
    significant,
  };
}

function principalComparisons(rawByDimension) {
  const output = [];
  for (const [dimension, table] of Object.entries(rawByDimension)) {
    for (const [value, arms] of Object.entries(table)) {
      if (arms.generic.sends < MIN_STRATUM_SENDS || arms.contextual.sends < MIN_STRATUM_SENDS) continue;
      output.push({ dimension, value, ...comparison(arms.generic, arms.contextual) });
    }
  }
  return output;
}

function decisionFor(messages, activationMs, toMs, rawByDimension, counters = {}) {
  const rawByVariant = {
    [CONFIRMATION_COPY_VARIANTS.GENERIC]: emptyCounts(),
    [CONFIRMATION_COPY_VARIANTS.CONTEXTUAL]: emptyCounts(),
  };
  for (const message of messages) bump(rawByVariant[message.variant], message);

  const generic = rawByVariant.generic;
  const contextual = rawByVariant.contextual;
  const primary = comparison(generic, contextual);
  const horizonDays = activationMs == null ? null : Math.max(0, (toMs - activationMs) / DAY_MS);
  const principal = principalComparisons(rawByDimension);
  const overallDirection = (primary.difference_generic_minus_contextual_pct_points || 0) > 0
    ? 'generic'
    : (primary.difference_generic_minus_contextual_pct_points || 0) < 0 ? 'contextual' : 'tie';
  const signHolds = principal.length > 0 && principal.every((row) => {
    if (!row.significant) return false;
    const delta = row.difference_generic_minus_contextual_pct_points;
    return overallDirection === 'generic' ? delta > 0 : overallDirection === 'contextual' && delta < 0;
  });
  const ready = generic.sends >= MIN_ARM_SENDS
    && contextual.sends >= MIN_ARM_SENDS
    && horizonDays != null
    && horizonDays >= MIN_HORIZON_DAYS;
  const evidence = ready && primary.significant && overallDirection !== 'tie' && signHolds;
  const warnings = [];
  if (activationMs == null) warnings.push('activation_at mancante: il conto dei 14 giorni non è verificabile');
  else if (horizonDays < MIN_HORIZON_DAYS) warnings.push(`orizzonte sotto ${MIN_HORIZON_DAYS} giorni dall'attivazione`);
  if (generic.sends < MIN_ARM_SENDS) warnings.push(`generic sotto la numerosità minima di ${MIN_ARM_SENDS} invii`);
  if (contextual.sends < MIN_ARM_SENDS) warnings.push(`contextual sotto la numerosità minima di ${MIN_ARM_SENDS} invii`);
  if (!principal.length) warnings.push(`nessuno strato principale ha almeno ${MIN_STRATUM_SENDS} invii per braccio`);
  if (counters.missing_subscriber_identity > 0) {
    warnings.push(
      `${counters.missing_subscriber_identity} invii senza identità dell'iscritto esclusi dagli aggregati primari`,
    );
  }
  for (const [dimension, table] of Object.entries(rawByDimension)) {
    for (const [value, arms] of Object.entries(table)) {
      for (const variant of Object.keys(arms)) {
        if (arms[variant].sends < MIN_STRATUM_SENDS) {
          warnings.push(`${dimension}=${value}/${variant} sotto la numerosità minima di ${MIN_STRATUM_SENDS}`);
        }
      }
    }
  }

  return {
    primary_metric: 'confirmation_click_rate_per_eligible_subscriber',
    minimums: {
      eligible_subscribers_per_arm: MIN_ARM_SENDS,
      horizon_days: MIN_HORIZON_DAYS,
      sends_per_principal_stratum_and_arm: MIN_STRATUM_SENDS,
    },
    activation_at: activationMs == null ? null : new Date(activationMs).toISOString(),
    measured_to: new Date(toMs).toISOString(),
    elapsed_days: horizonDays == null ? null : round(horizonDays),
    ready,
    primary,
    principal_strata_consistent: signHolds,
    decision: evidence && overallDirection === 'generic'
      ? 'promote_generic'
      : evidence && overallDirection === 'contextual'
        ? 'keep_contextual'
        : 'tie_or_not_ready_keep_contextual',
    warnings: [...new Set(warnings)],
  };
}

/** Aggregate only safe, non-identifying data for the report body. */
export function buildConfirmationCopyReport({ events = [], activationMs = null, fromMs, toMs }) {
  const folded = aggregateConfirmationCopyEvents(events);
  const primaryUnits = folded.subscribers;
  const rawByVariant = {
    [CONFIRMATION_COPY_VARIANTS.GENERIC]: emptyCounts(),
    [CONFIRMATION_COPY_VARIANTS.CONTEXTUAL]: emptyCounts(),
  };
  for (const subscriber of primaryUnits) bump(rawByVariant[subscriber.variant], subscriber);
  const rawByDimension = {
    source_cta: rawDimensionTable(primaryUnits, 'source_cta'),
    provider: rawDimensionTable(primaryUnits, 'provider'),
    locale: rawDimensionTable(primaryUnits, 'locale'),
  };
  const strata = rawDimensionTable(primaryUnits, 'source_cta');
  const combined = {};
  for (const subscriber of primaryUnits) {
    const key = `${subscriber.source_cta}|${subscriber.provider}|${subscriber.locale}`;
    combined[key] ||= {
      source_cta: subscriber.source_cta,
      provider: subscriber.provider,
      locale: subscriber.locale,
      [CONFIRMATION_COPY_VARIANTS.GENERIC]: emptyCounts(),
      [CONFIRMATION_COPY_VARIANTS.CONTEXTUAL]: emptyCounts(),
    };
    bump(combined[key][subscriber.variant], subscriber);
  }
  const rawMessageByVariant = {
    [CONFIRMATION_COPY_VARIANTS.GENERIC]: emptyCounts(),
    [CONFIRMATION_COPY_VARIANTS.CONTEXTUAL]: emptyCounts(),
  };
  for (const message of folded.messages) bump(rawMessageByVariant[message.variant], message);
  const strataRows = Object.values(combined).sort((a, b) => (
    `${a.source_cta}|${a.provider}|${a.locale}`.localeCompare(`${b.source_cta}|${b.provider}|${b.locale}`)
  )).map((row) => ({
    source_cta: row.source_cta,
    provider: row.provider,
    locale: row.locale,
    generic: cell(row.generic),
    contextual: cell(row.contextual),
  }));

  return {
    counters: folded.counters,
    by_variant: Object.fromEntries(Object.entries(rawByVariant).map(([variant, counts]) => [variant, cell(counts)])),
    by_source_cta: dimensionTable(primaryUnits, 'source_cta'),
    by_provider: dimensionTable(primaryUnits, 'provider'),
    by_locale: dimensionTable(primaryUnits, 'locale'),
    message_by_variant: Object.fromEntries(Object.entries(rawMessageByVariant)
      .map(([variant, counts]) => [variant, cell(counts)])),
    strata: strataRows,
    decision: decisionFor(primaryUnits, activationMs, toMs, rawByDimension, folded.counters),
    period: {
      from: fromMs == null ? null : new Date(fromMs).toISOString(),
      to: toMs == null ? null : new Date(toMs).toISOString(),
      event_time_field: 'timestamp in [from, to)',
    },
    // Keep the local variable referenced so future edits cannot accidentally
    // remove the source_cta dimension while retaining only the cross-product.
    source_cta_strata_present: Object.keys(strata).length > 0,
  };
}

const FORBIDDEN_KEYS = new Set(['email', 'message_id', 'uid', 'user_id', 'subscriber_id', 'document_id', 'doc_id']);

/** Guard the JSON boundary: no clear address or provider/message identifier. */
export function findIdentifierLeaks(value, path = '$', key = '') {
  const leaks = [];
  if (FORBIDDEN_KEYS.has(key)) leaks.push(`${path} (key)`);
  const check = (text, where) => {
    if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) leaks.push(`${where} (email)`);
  };
  if (typeof value === 'string') check(value, path);
  else if (Array.isArray(value)) value.forEach((item, index) => leaks.push(...findIdentifierLeaks(item, `${path}[${index}]`, key)));
  else if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      check(childKey, `${path}.${childKey}`);
      leaks.push(...findIdentifierLeaks(childValue, `${path}.${childKey}`, childKey));
    }
  }
  return leaks;
}

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} richiede un valore`);
      return argv[i];
    };
    if (arg === '--activation') options.activation = next();
    else if (arg === '--from') options.from = next();
    else if (arg === '--to') options.to = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--page-size') options.pageSize = Math.max(100, Math.min(10000, Number(next()) || 5000));
    else throw new Error(`opzione sconosciuta: ${arg}`);
  }
  if (!options.from) throw new Error('--from <ISO> obbligatorio');
  const fromMs = toMillis(options.from);
  const activationMs = options.activation == null ? null : toMillis(options.activation);
  const requestedToMs = options.to == null ? Date.now() : toMillis(options.to);
  if (fromMs == null) throw new Error(`--from non valido: ${options.from}`);
  if (options.activation != null && activationMs == null) throw new Error(`--activation non valido: ${options.activation}`);
  if (requestedToMs == null) throw new Error(`--to non valido: ${options.to}`);
  const toMs = Math.min(requestedToMs, Date.now());
  if (toMs <= fromMs) throw new Error('--to deve essere dopo --from');
  return { ...options, pageSize: options.pageSize || 5000, fromMs, toMs, requestedToMs, activationMs };
}

async function readPagedConfirmationEvents(db, { fromMs, toMs, pageSize }) {
  const events = [];
  let reads = 0;
  let lastDoc = null;
  for (;;) {
    let query = db.collectionGroup('events')
      .where('timestamp', '>=', new Date(fromMs))
      .where('timestamp', '<', new Date(toMs))
      .orderBy('timestamp')
      .select(...EVENT_FIELDS)
      .limit(pageSize);
    if (lastDoc) query = query.startAfter(lastDoc);
    const page = await query.get();
    reads += Math.max(1, page.size || page.docs?.length || 0);
    if (page.empty || !page.docs?.length) break;
    for (const document of page.docs) events.push(document.data());
    lastDoc = page.docs[page.docs.length - 1];
    if (page.size < pageSize) break;
  }
  return { events, reads };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = await getFirestoreDb();
  const { events, reads } = await readPagedConfirmationEvents(db, options);
  const report = {
    _what: 'Report read-only del copy DOI #6317: invii, aperture e clic per braccio e strato, solo aggregati.',
    _how: `Eventi Firestore letti per timestamp; campagna ${CONFIRMATION_COPY_CAMPAIGN_PREFIX}_*; nessuna email e nessuna scrittura Remote Config.`,
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    parameter: 'NEWSLETTER_CONFIRMATION_COPY_ROLLOUT',
    campaign_prefix: CONFIRMATION_COPY_CAMPAIGN_PREFIX,
    reads: { event_documents: events.length, billed_batches_estimate: reads },
    ...buildConfirmationCopyReport({ events, activationMs: options.activationMs, fromMs: options.fromMs, toMs: options.toMs }),
  };
  const leaks = findIdentifierLeaks(report);
  if (leaks.length) throw new Error(`identificativo nell'output aggregato: ${leaks.slice(0, 5).join(', ')}`);
  if (options.out) {
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report scritto: ${options.out}`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    console.error('report-confirmation-copy-experiment failed:', error?.stack || error);
    process.exit(1);
  });
}
