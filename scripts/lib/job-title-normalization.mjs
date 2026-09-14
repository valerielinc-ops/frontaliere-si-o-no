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
// `\b` is deliberately avoided at the start of these expressions because
// JavaScript word boundaries are ASCII-only (`Übersetzung` would not match).
const NARRATIVE_TITLE_INTRODUCERS = [
  /(?:^|[^\p{L}\p{N}_])(?:translation|traduzione|traduction|übersetzung)[^:!?\n]*:\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:the\s+)?title[^:!?\n]*:\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:here(?:'s| is)|ecco|voici|hier ist)[^:!?\n]*:\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:translation|traduzione|traduction|übersetzung)[^.!?\n]*(?:is|è|est|ist)\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:the\s+)?title[^.!?\n]*(?:needs?|appears?|translated?)(?:\s+to\s+be)?\s*:?\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])based on[^.!?\n]*context[^.!?\n]*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:i need to|let me|looking at|reading (?:the )?job files?|if you(?:'d| would) like me)[^.!?\n]*$/iu,
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
