/**
 * Recover a job title from the specific AI-translation narrative shape that
 * has reached the corpus. This is intentionally narrow: a normal long title
 * may contain bold text, and asterisks can be legitimate employer wording.
 *
 * The assembler and the static renderers share this extractor so a repaired
 * corpus field and a display-only fallback make the same decision.
 */
// The lookarounds are intentional: a `***brand***` run must never be read as
// a `**brand**` segment beginning at its second asterisk.
const BOLD_SEGMENT_RE = /(?<!\*)\*\*([^*\n]{1,240})\*\*(?!\*)/g;

// A title is recoverable when a narrative sentence structurally introduces
// the following bold segment. This avoids length/suffix heuristics: the
// explanation may be short, and the actual title may be the final value.
const NARRATIVE_TITLE_INTRODUCERS = [
  /\b(?:translation|traduzione|traduction|übersetzung)\b[^:!?\n]{0,140}:\s*$/i,
  /\b(?:the\s+)?title\b[^:!?\n]{0,140}:\s*$/i,
  /\b(?:here(?:'s| is)|ecco|voici|hier ist)\b[^:!?\n]{0,140}:\s*$/i,
];

/**
 * Return a structurally introduced bold segment only when the surrounding
 * value is clearly an explanatory AI response rather than a job title.
 */
export function extractNarrativeJobTitle(value) {
  const source = String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const matches = [...source.matchAll(BOLD_SEGMENT_RE)];
  if (matches.length === 0) return '';

  // Prefer the last introduced segment, but keep looking if the explanation
  // contains another bold fragment after the actual title.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const candidate = String(match[1] || '').trim();
    const start = Number(match.index ?? -1);
    if (!candidate || start < 0) continue;
    const prefix = source.slice(0, start);
    if (NARRATIVE_TITLE_INTRODUCERS.some((introducer) => introducer.test(prefix))) {
      return candidate;
    }
  }
  return '';
}
