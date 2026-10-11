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
  comments: 'Il worker risponde automaticamente ai commenti entro 24h; Insights misura commenti e reach.',
  shares: 'Insights misura condivisioni e reach; il worker gestisce automaticamente le eventuali domande.',
  saves: 'Insights misura salvataggi e reach; il worker gestisce automaticamente le eventuali domande.',
});

const FOLLOW_UP_ACTION_BY_FORMAT = Object.freeze({
  'comment-reply': 'Entro 72h il worker mantiene il ciclo automatico di risposta; la coda continua la rotazione del test.',
  'comment-reply-reel': 'Entro 72h il worker risponde automaticamente; la coda Reel continua la rotazione sperimentale.',
  'story-poll': 'Entro 48h il worker pubblica automaticamente una Story visuale di follow-up e ne registra la pubblicazione.',
  'story-result': 'Entro 48h il worker pubblica automaticamente una Story visuale associata alla creatività; Insights misura il risultato.',
  'story-checklist': 'Entro 48h il worker pubblica automaticamente una Story visuale che riporta alla checklist.',
  'story-quiz': 'Entro 48h il worker pubblica automaticamente una Story visuale con la domanda del test.',
  'story-reminder': 'Entro 48h il worker pubblica automaticamente un promemoria visuale legato al momento utile.',
  'carousel-checklist': 'Entro 72h la coda automatica continua la rotazione del formato checklist.',
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
    || 'Entro 72h il worker registra un follow-up editoriale coerente e verificabile.';
}

/**
 * Build the follow-up contract that travels with a queued post. The Mac robot
 * prints it for observability and the Chrome worker uses the same metadata to
 * choose an automatic reply or Story follow-up. Unknown/legacy ledger rows
 * return null instead of guessing a strategy.
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
    automationMode: 'chrome-browser',
    manualOnly: false,
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
    '   Automatico: commenti e DM consentiti vengono gestiti dal worker Chrome; le Stories restano nel fallback Graph esplicito.',
  ].join('\n');
}
