/**
 * Recover a job title from the specific AI-translation narrative shape that
 * has reached the corpus. This is intentionally narrow: a normal long title
 * may contain bold text, and asterisks can be legitimate employer wording.
 *
 * The assembler and the static renderers share this extractor so a repaired
 * corpus field and a display-only fallback make the same decision.
 */
const BOLD_SEGMENT_RE = /\*\*([^*\n]{1,240})\*\*/g;
const AI_TITLE_NARRATIVE_MARKERS = [
  /\bi need to\b/i,
  /\blet me\b/i,
  /\blooking at\b/i,
  /\breading (?:the )?job files?\b/i,
  /\bthe title\b[^.]{0,140}\b(?:needs?|appears?|translated?)\b/i,
  /\bbased on\b[^.]{0,100}\bcontext\b/i,
  /\bhere(?:'s| is)\b[^.]{0,100}\btranslation\b/i,
  /\bthe translation\b/i,
  /\bif you(?:'d| would) like me\b/i,
  /\bla traduzione\b/i,
  /\becco la traduzione\b/i,
  /\bvoici la traduction\b/i,
  /\bla traduction\b/i,
  /\bdie übersetzung\b/i,
];

/**
 * Return the last balanced bold segment only when the surrounding value is
 * clearly an explanatory AI response rather than a job title.
 */
export function extractNarrativeJobTitle(value) {
  const source = String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (source.length < 180) return '';

  const matches = [...source.matchAll(BOLD_SEGMENT_RE)];
  if (matches.length === 0) return '';
  const last = matches[matches.length - 1];
  const candidate = String(last[1] || '').trim();
  const start = Number(last.index ?? -1);
  const after = start >= 0 ? source.slice(start + last[0].length).trim() : '';

  if (!candidate || start < 24 || after.length < 16) return '';
  if (!AI_TITLE_NARRATIVE_MARKERS.some((marker) => marker.test(source))) return '';
  return candidate;
}
