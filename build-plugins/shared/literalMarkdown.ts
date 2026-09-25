/** Browser-safe literal-markdown cleanup shared by build and SPA callers. */
export function stripLiteralMarkdown(value: string): string {
  if (!value) return value;
  let t = String(value);
  // 1. Unwrap balanced bold, keeping the inner text (`**Requisitos:**` → `Requisitos:`).
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  // 2. Nuke remaining runs of 2+ asterisks, including orphaned crawler output.
  t = t.replace(/\*{2,}/g, '');
  // 3. Separator runs (3+ of `_`, `=`, `~`) — drop.
  t = t.replace(/[_=~]{3,}/g, ' ');
  // 4. Orphan leading/trailing single `*` survivors.
  t = t.replace(/^\s*\*+\s*/, '').replace(/\s*\*+\s*$/, '');
  // 5. Collapse any double-spaces created by the strips.
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t.trim();
}

/** Remove a markdown bold wrapper only when it surrounds the whole value. */
export function stripWholeMarkdownBoldWrapper(value: string): string {
  if (!value) return value;
  const source = String(value);
  const trimmed = source.trim();
  if (trimmed.length < 5 || !trimmed.startsWith('**') || !trimmed.endsWith('**')) return source;
  const inner = trimmed.slice(2, -2).trim();
  if (!inner || inner.includes('*')) return source;
  return inner;
}

export function stripJobTitleMarkdown(value: string): string {
  const protectedRuns: string[] = [];
  const protectedValue = String(value).replace(/\*{3,}/g, (run) => {
    const index = protectedRuns.push(run) - 1;
    return `\uE000${index}\uE001`;
  });
  return stripLiteralMarkdown(protectedValue).replace(
    /\uE000(\d+)\uE001/g,
    (_match, index: string) => protectedRuns[Number(index)] || '',
  );
}

// Runtime fallback for already-published records. The corpus owns the richer
// build-time normalizer (`scripts/lib/job-title-normalization.mjs`); this copy
// keeps its client path free of regex lookbehind but MUST reach the same
// decision, because `jobPostingSchema.ts` feeds it the same title that
// `sanitizeJobTitleForDisplay()` renders in the visible H1. A looser prefix
// here (optional colon, no word boundary) turned real titles such as
// `Translation Specialist **Project Manager**` into `Project Manager` in the
// JobPosting JSON-LD while the page kept the full title.
// `\b` is avoided on purpose: JavaScript word boundaries are ASCII-only.
const NARRATIVE_TITLE_INTRODUCERS: readonly RegExp[] = [
  /(?:^|[^\p{L}\p{N}_])(?:translation|traduzione|traduction|übersetzung)(?=$|[^\p{L}\p{N}_])[^:!?\n]*:\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:the\s+)?title(?=$|[^\p{L}\p{N}_])[^:!?\n]*:\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:here(?:'s| is)|ecco|voici|hier ist)(?=$|[^\p{L}\p{N}_])[^:!?\n]*:\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:translation|traduzione|traduction|übersetzung)(?=$|[^\p{L}\p{N}_])[^.!?\n]*(?:^|[^\p{L}\p{N}_])(?:is|è|est|ist)(?=$|[^\p{L}\p{N}_])\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:the\s+)?title(?=$|[^\p{L}\p{N}_])[^.!?\n]*(?:^|[^\p{L}\p{N}_])(?:needs?|appears?|translated?)(?=$|[^\p{L}\p{N}_])(?:\s+to\s+be)?\s*:?\s*$/iu,
  /(?:^|[^\p{L}\p{N}_])based on(?=$|[^\p{L}\p{N}_])[^.!?\n]*(?:^|[^\p{L}\p{N}_])context(?=$|[^\p{L}\p{N}_])[^.!?\n]*$/iu,
  /(?:^|[^\p{L}\p{N}_])(?:i need to|let me|looking at|reading (?:the )?job files?|if you(?:'d| would) like me)(?=$|[^\p{L}\p{N}_])[^.!?\n]*$/iu,
];

export function sanitizeBrowserJobTitle(value: string): string {
  if (!value) return value;
  const source = String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const whole = stripWholeMarkdownBoldWrapper(source);
  const segments = [...source.matchAll(/(^|[^*])\*\*([^*\n]{1,240})\*\*(?!\*)/g)];
  let narrative = '';
  // Prefer the last introduced segment, but keep looking if the explanation
  // contains another bold fragment after the actual title.
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const match = segments[index];
    const candidate = String(match[2] || '').trim();
    const start = Number(match.index ?? -1) + String(match[1] || '').length;
    if (!candidate || start < 0) continue;
    const prefix = source.slice(0, start);
    if (NARRATIVE_TITLE_INTRODUCERS.some((introducer) => introducer.test(prefix))) {
      narrative = candidate;
      break;
    }
  }
  return stripJobTitleMarkdown(narrative || (whole !== source ? whole : source));
}
