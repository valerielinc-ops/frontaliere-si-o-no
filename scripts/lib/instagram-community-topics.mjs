import { createHash } from 'node:crypto';

export const INSTAGRAM_COMMUNITY_TOPIC_WINDOW_DAYS = 30;
export const INSTAGRAM_COMMUNITY_TOPIC_MINIMUM = 10;
export const INSTAGRAM_COMMUNITY_TOPIC_RETENTION_DAYS = 35;
export const INSTAGRAM_COMMUNITY_TOPIC_MAX_SIGNALS = 5_000;
export const INSTAGRAM_COMMUNITY_TOPIC_SOURCE = 'public-instagram-comments-local-closed-taxonomy';

export const INSTAGRAM_COMMUNITY_TOPIC_CATEGORIES = Object.freeze([
  'lavoro-contratti',
  'fisco-previdenza',
  'assicurazione-salute',
  'permessi-amministrazione',
  'mobilita-valichi',
  'vita-famiglia',
]);
export const INSTAGRAM_COMMUNITY_TOPIC_COUNT_BANDS = Object.freeze(['10-24', '25-49', '50+']);

const CATEGORY_PATTERNS = Object.freeze({
  'lavoro-contratti': /(?<![\p{L}\p{M}\p{N}\p{Cf}_])(?:lavor\p{L}*|contratt\p{L}*|stipend\p{L}*|salari\p{L}*|frontalier\p{L}*|arbeit\p{L}*|arbeitsvertrag\p{L}*|gehalt\p{L}*|emploi\p{L}*|contrat\p{L}*|salaire\p{L}*|work|job|salary)(?![\p{L}\p{M}\p{N}\p{Cf}_])/iu,
  'fisco-previdenza': /(?<![\p{L}\p{M}\p{N}\p{Cf}_])(?:tass\p{L}*|fisc\p{L}*|impost\p{L}*|dichiarazion\p{L}*|pension\p{L}*|avs|inps|retrait\p{L}*|steuer\p{L}*|ahv|imp[oô]t\p{L}*|tax\p{L}*)(?![\p{L}\p{M}\p{N}\p{Cf}_])/iu,
  'assicurazione-salute': /(?<![\p{L}\p{M}\p{N}\p{Cf}_])(?:assicurazion\p{L}*\s+(?:malatt\p{L}*|sanitari\p{L}*)|cassa\s+malat\p{L}*|lamal|krankenkass\p{L}*|krankenversicherung\p{L}*|assurance\s+maladie|health\s+insurance|sick\s+fund)(?![\p{L}\p{M}\p{N}\p{Cf}_])/iu,
  'permessi-amministrazione': /(?<![\p{L}\p{M}\p{N}\p{Cf}_])(?:permess\p{L}*|document\p{L}*|autorizzazion\p{L}*|residenz\p{L}*|bewilligung\p{L}*|aufenthalt\p{L}*|permis|autorisation\p{L}*|permit\p{L}*|residence\s+card)(?![\p{L}\p{M}\p{N}\p{Cf}_])/iu,
  'mobilita-valichi': /(?<![\p{L}\p{M}\p{N}\p{Cf}_])(?:traffico\p{L}*|traffic|valich\p{L}*|frontier\p{L}*|dogan\p{L}*|pendolar\p{L}*|mobilit\p{L}*|trasport\p{L}*|grenz\p{L}*|stau\p{L}*|douan\p{L}*|trajet\p{L}*|commut\p{L}*|border\s+cross\p{L}*|transport\p{L}*)(?![\p{L}\p{M}\p{N}\p{Cf}_])/iu,
  'vita-famiglia': /(?<![\p{L}\p{M}\p{N}\p{Cf}_])(?:famigli\p{L}*|figli\p{L}*|scuol\p{L}*|asil\p{L}*|famil\p{L}*|kind\p{L}*|schul\p{L}*|enfant\p{L}*|école\p{L}*|ecole\p{L}*|child\p{L}*|school\p{L}*)(?![\p{L}\p{M}\p{N}\p{Cf}_])/iu,
});

const QUESTION_START_RE = /^(?:come|cosa|che\s+cosa|quale|quali|quanto|quanta|quando|dove|chi|perch[eé]|wie|was|welche|welcher|wann|wo|wer|warum|pourquoi|comment|quel(?:le)?|quand|où|ou|qui|what|how|when|where|which|who)(?![\p{L}\p{M}\p{N}\p{Cf}_])/iu;
const NON_ROAD_TRAFFIC_CONTEXT_RE = /(?<![\p{L}\p{M}\p{N}\p{Cf}_])(?:web|websites?|web[\s\p{Pd}]+sites?|sites?|networks?|internet|social)(?![\p{L}\p{M}\p{N}\p{Cf}_])(?:\s+|[\p{Pd}])traffic(?![\p{L}\p{M}\p{N}\p{Cf}_])|(?<![\p{L}\p{M}\p{N}\p{Cf}_])(?:websites?|sites?|networks?|internet)['’]s\s+traffic(?![\p{L}\p{M}\p{N}\p{Cf}_])|(?<![\p{L}\p{M}\p{N}\p{Cf}_])traffic(?![\p{L}\p{M}\p{N}\p{Cf}_])\s+(?:to|on|from)(?![\p{L}\p{M}\p{N}\p{Cf}_])\s+(?:(?:a|an|the|our|my|your|their|its|this|that)\s+)?(?:websites?|web\s+sites?|sites?|networks?|internet)(?![\p{L}\p{M}\p{N}\p{Cf}_])|(?<![\p{L}\p{M}\p{N}\p{Cf}_])traffic(?![\p{L}\p{M}\p{N}\p{Cf}_])\s+(?:auf|in|zu|vom|im|zum)(?![\p{L}\p{M}\p{N}\p{Cf}_])\s+(?:(?:der|dem|den|des|eine|einer|einem|unserer|unserem|unseren|eurer|eurem|ihre|ihrem|ihren)\s+)?(?:website|webseite|webseiten|site|sites|netzwerk|netzwerke|internet)(?![\p{L}\p{M}\p{N}\p{Cf}_])/iu;
const PERSONAL_CASE_RE = /(?:^|[.!?]\s*)(?:io\s+|nel\s+mio\s+caso|per\s+me\b|mi\s+[èe]\s+success\w*|ho\s+(?:avuto|ricevuto|perso|un\b|una\b)|sono\s+(?:stato|stata|un\b|una\b)|meu\s+caso|mon\s+cas|mein\s+fall)\b/iu;
const CONTACT_OR_IDENTIFIER_RE = /(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:\+?\d[\s().-]*){8,})/iu;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function dateMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function instagramCommunityTopicSignalKey(platformId) {
  const id = String(platformId || '').trim();
  return id ? createHash('sha256').update(`instagram-community-topic\u0000${id}`).digest('hex') : null;
}

/** Classify a public comment in memory; return only a closed topic ID, never text. */
export function classifyInstagramCommunityQuestion(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.length > 500 || CONTACT_OR_IDENTIFIER_RE.test(normalized)
    || PERSONAL_CASE_RE.test(normalized)) return null;
  const beginsWithQuestion = QUESTION_START_RE.test(normalized.replace(/^[\p{P}\p{S}\p{Cf}\s]+/u, ''));
  if (!normalized.includes('?') && !beginsWithQuestion) return null;
  if (NON_ROAD_TRAFFIC_CONTEXT_RE.test(normalized)) return null;
  const matches = INSTAGRAM_COMMUNITY_TOPIC_CATEGORIES.filter((category) => CATEGORY_PATTERNS[category].test(normalized));
  return matches.length === 1 ? matches[0] : null;
}

export function normalizeInstagramCommunityTopicSignals(signals, { asOf = new Date() } = {}) {
  const asOfMs = asOf instanceof Date ? asOf.getTime() : Date.parse(String(asOf));
  if (!Number.isFinite(asOfMs)) throw new TypeError('community topic asOf must be a valid date');
  const cutoff = asOfMs - INSTAGRAM_COMMUNITY_TOPIC_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set();
  return (Array.isArray(signals) ? signals : [])
    .filter((signal) => isRecord(signal)
      && Object.keys(signal).length === 3
      && Object.keys(signal).every((key) => ['key', 'category', 'receivedAt'].includes(key))
      && /^[a-f0-9]{64}$/u.test(String(signal.key || ''))
      && INSTAGRAM_COMMUNITY_TOPIC_CATEGORIES.includes(signal.category)
      && dateMs(signal.receivedAt) !== null
      && dateMs(signal.receivedAt) <= asOfMs
      && dateMs(signal.receivedAt) >= cutoff)
    .filter((signal) => {
      if (seen.has(signal.key)) return false;
      seen.add(signal.key);
      return true;
    })
    .slice(-INSTAGRAM_COMMUNITY_TOPIC_MAX_SIGNALS)
    .map((signal) => ({ key: signal.key, category: signal.category, receivedAt: new Date(dateMs(signal.receivedAt)).toISOString() }));
}

function countBand(count) {
  if (count >= 50) return '50+';
  if (count >= 25) return '25-49';
  return '10-24';
}

/** Expose only categories supported by ten distinct public comments in 30 days. */
export function summarizeInstagramCommunityQuestionDemand(signals, {
  asOf = new Date(),
  minimum = INSTAGRAM_COMMUNITY_TOPIC_MINIMUM,
  windowDays = INSTAGRAM_COMMUNITY_TOPIC_WINDOW_DAYS,
} = {}) {
  if (!Number.isSafeInteger(minimum) || minimum < 10 || minimum > 100
    || !Number.isSafeInteger(windowDays) || windowDays < 7 || windowDays > INSTAGRAM_COMMUNITY_TOPIC_RETENTION_DAYS) {
    throw new TypeError('community topic threshold or window is invalid');
  }
  const current = asOf instanceof Date ? asOf : new Date(asOf);
  if (!Number.isFinite(current.getTime())) throw new TypeError('community topic asOf must be a valid date');
  const cutoff = current.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const rows = normalizeInstagramCommunityTopicSignals(signals, { asOf: current });
  const counts = new Map(INSTAGRAM_COMMUNITY_TOPIC_CATEGORIES.map((category) => [category, 0]));
  for (const row of rows) {
    const at = dateMs(row.receivedAt);
    if (at >= cutoff) counts.set(row.category, counts.get(row.category) + 1);
  }
  const categories = [...counts.entries()]
    .filter(([, count]) => count >= minimum)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => ({ category, countBand: countBand(count) }));
  return {
    status: categories.length ? 'available' : 'suppressed',
    source: INSTAGRAM_COMMUNITY_TOPIC_SOURCE,
    windowDays,
    minimumPerCategory: minimum,
    categories,
  };
}
