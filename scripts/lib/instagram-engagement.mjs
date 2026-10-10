/**
 * Stable names for the action requested by each Instagram treatment.
 *
 * Keep this mapping shared by carousel and Reel ledgers so the scorecard can
 * compare the CTA mechanism independently from the format that rendered it.
 */
const ENGAGEMENT_MECHANIC_BY_METRIC = Object.freeze({
  comments: 'keyword-comment',
  shares: 'direct-share',
  saves: 'save-reminder',
});

const RESPONSE_ACTION_BY_METRIC = Object.freeze({
  comments: 'Rispondere a ogni commento entro 24h e raggruppare le risposte ricorrenti.',
  shares: 'Rispondere entro 24h e annotare quali dati vengono passati ad altre persone.',
  saves: 'Rispondere entro 24h e annotare quale voce richiede una guida più chiara.',
});

const FOLLOW_UP_ACTION_BY_FORMAT = Object.freeze({
  'comment-reply': 'Entro 72h trasformare una domanda ricorrente in una risposta verificata.',
  'comment-reply-reel': 'Entro 72h registrare un Reel di risposta, anonimizzando il commento salvo consenso.',
  'story-poll': 'Entro 48h pubblicare un sondaggio nelle Stories e usare il risultato come contesto, non come prova causale.',
  'story-result': 'Entro 48h pubblicare il risultato nelle Stories e collegare una guida o un dato verificato.',
  'story-checklist': 'Entro 48h pubblicare una Story-quiz e rimandare alla checklist completa.',
  'story-quiz': 'Entro 48h pubblicare una Story-quiz e usare la risposta più frequente per la prossima guida.',
  'story-reminder': 'Entro 48h pubblicare un promemoria legato al momento concreto in cui riaprire il contenuto.',
  'carousel-checklist': 'Entro 72h usare le domande ricevute per costruire un carousel-checklist.',
});

const DECISION_ACTION = 'A 72h confrontare solo con osservazioni della stessa creatività e formato; non dichiarare un vincitore prima di 3 osservazioni comparabili.';

function creativeMetadataForEntry(entry) {
  if (!entry || entry.channel !== 'instagram' || !Array.isArray(entry.ledgerEntries)) return null;
  return entry.ledgerEntries.find((candidate) => (
    candidate
    && typeof candidate === 'object'
    && String(candidate.creativeId ?? candidate.creative_id ?? '').trim()
  )) || null;
}

export function instagramEngagementMechanic(primaryMetric) {
  return ENGAGEMENT_MECHANIC_BY_METRIC[String(primaryMetric || '').trim()] || 'unknown';
}

export function instagramResponseAction(primaryMetric) {
  return RESPONSE_ACTION_BY_METRIC[String(primaryMetric || '').trim()]
    || 'Entro 24h rispondere alle interazioni con un’informazione verificata.';
}

export function instagramFollowUpAction(followUpFormat) {
  return FOLLOW_UP_ACTION_BY_FORMAT[String(followUpFormat || '').trim()]
    || 'Entro 72h scegliere un follow-up editoriale coerente, senza automatizzare commenti, DM o Stories.';
}

/**
 * Build the small human-only follow-up brief that travels with a queued post.
 * The robot may print it in its local log, but never sends the interaction.
 * Unknown/legacy ledger rows return null instead of guessing a strategy.
 */
export function buildInstagramEngagementBrief(entry) {
  const metadata = creativeMetadataForEntry(entry);
  if (!metadata) return null;

  const primaryMetric = String(metadata.primaryMetric ?? metadata.primary_metric ?? '').trim();
  const creativeId = String(metadata.creativeId ?? metadata.creative_id ?? '').trim();
  if (!primaryMetric || !creativeId) return null;

  const followUpFormat = String(metadata.followUpFormat ?? metadata.follow_up_format ?? 'none').trim() || 'none';
  return {
    queueId: String(entry.id || '').trim(),
    day: String(entry.day || '').trim(),
    kind: String(entry.kind || '').trim(),
    creativeId,
    creativeBaseId: String(metadata.creativeBaseId ?? metadata.creative_base_id ?? '').trim(),
    creativeVariant: String(metadata.creativeVariant ?? metadata.creative_variant ?? '').trim(),
    primaryMetric,
    engagementMechanic: String(metadata.engagementMechanic ?? metadata.engagement_mechanic ?? '').trim()
      || instagramEngagementMechanic(primaryMetric),
    hookType: String(metadata.hookType ?? metadata.hook_type ?? '').trim() || 'unknown',
    attentionMechanic: String(metadata.attentionMechanic ?? metadata.attention_mechanic ?? '').trim() || 'unknown',
    engagementLoop: String(metadata.engagementLoop ?? metadata.engagement_loop ?? '').trim() || 'none',
    followUpFormat,
    responseAction: instagramResponseAction(primaryMetric),
    followUpAction: instagramFollowUpAction(followUpFormat),
    decisionAction: DECISION_ACTION,
    manualOnly: true,
    responseSlaHours: 24,
    storySlaHours: followUpFormat.startsWith('story-') ? 48 : null,
    decisionWindowHours: 72,
    minimumComparableObservations: 3,
  };
}

/** Format the brief as a compact block for the Mac host log. */
export function formatInstagramEngagementBrief(brief) {
  if (!brief) return '';
  return [
    `🧭 Instagram engagement — ${brief.queueId || 'post'} · ${brief.creativeId} · ${brief.primaryMetric}`,
    `   Hook: ${brief.hookType} · attenzione: ${brief.attentionMechanic} · loop: ${brief.engagementLoop}`,
    `   ${brief.responseAction}`,
    `   ${brief.followUpAction}`,
    `   ${brief.decisionAction}`,
    '   Manuale: nessun commento, DM o Story viene inviato dal robot.',
  ].join('\n');
}
