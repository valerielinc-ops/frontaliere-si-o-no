/** Sections and groups whose fields belong to a past experience or education row. */
const INLINE_HISTORY_PATTERNS = [
  String.raw`(?:work|employment|professional|career|job)\s+(?:history|experience)`,
  String.raw`(?:(?:previous|past|former)\s+(?:work|employment|professional|career|job)(?:\s+(?:history|experience))?)`,
  String.raw`history\s+of\s+(?:work|employment|jobs?)`,
  String.raw`(?:education|éducation|training|academic|study|studies|school)(?:\s+(?:history|experience|record|background))?`,
  String.raw`(?:previous|past|former)\s+(?:education|éducation|training|academic|study|studies|school)(?:\s+(?:history|record|background))?`,
  String.raw`(?:work|employment)\s+(?:record|background)`,
  String.raw`(?:history|experience|berufserfahrung|ausbildung|schulbildung|studium)`,
  String.raw`exp[ée]rience(?:\s+professionnelle)?|formation|études|etudes`,
  String.raw`esperienza\s+(?:lavorativa|professionale)|lavoro\s+precedente|impiego\s+precedente|formazione|istruzione|studi`,
].join('|');

export const WORK_HISTORY_SECTION_RE = new RegExp([
  String.raw`^\s*(?:(?:my|your|candidate(?:'s)?|profile'?s?)\s+)?(?:(?:work|employment|professional|career|job|education|éducation|academic|training|study|studies|school)\s+)?(?:history|experience|education|éducation|training|studies|berufserfahrung|ausbildung|bildung|studium|exp[ée]rience|formation|formazione|istruzione|educazione|études|etudes)\s*$`,
  String.raw`^\s*(?:employment|work|career|education|éducation|training|study|studies|school|academic|ausbildung|bildung|studium|formation|formazione|istruzione|educazione|exp[ée]rience)\s*$`,
  String.raw`\b(?:${INLINE_HISTORY_PATTERNS})\b`,
].join('|'), 'i');

const HISTORY_CONTEXT_KEYS = [
  'section', 'sectionLabel', 'sectionTitle', 'context', 'group', 'groupLabel', 'groupName',
  'fieldset', 'fieldsetLabel', 'fieldsetName', 'heading', 'containerLabel',
];

function contextLabels(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(contextLabels);
  if (!value || typeof value !== 'object') return [];
  return ['label', 'name', 'title', 'text'].flatMap((key) => contextLabels(value[key]));
}

/** Match only section/group metadata, never the question's own label. */
export function isWorkHistoryContext(question) {
  if (!question || typeof question !== 'object') return false;
  const context = HISTORY_CONTEXT_KEYS.flatMap((key) => contextLabels(question[key])).join(' ');
  return WORK_HISTORY_SECTION_RE.test(context);
}
