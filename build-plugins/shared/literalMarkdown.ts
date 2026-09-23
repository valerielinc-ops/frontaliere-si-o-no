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
// build-time normalizer; this deliberately small parser keeps its client path
// free of regex lookbehind while preserving the known narrative shape.
export function sanitizeBrowserJobTitle(value: string): string {
  if (!value) return value;
  const source = String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const whole = stripWholeMarkdownBoldWrapper(source);
  const narrativePrefix = /(?:translation|traduzione|traduction|übersetzung|(?:the\s+)?title|here(?:'s| is)|ecco|voici|hier ist|based on[^.!?]*context|i need to|let me|looking at|reading (?:the )?job files?|if you(?:'d| would) like me)[^.!?\n]*:?\s*$/iu;
  const segments = [...source.matchAll(/(^|[^*])\*\*([^*\n]{1,240})\*\*(?!\*)/g)];
  let narrative = '';
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const match = segments[index];
    const start = Number(match.index ?? -1) + String(match[1] || '').length;
    if (start >= 0 && narrativePrefix.test(source.slice(0, start))) {
      narrative = String(match[2] || '').trim();
      break;
    }
  }
  return stripJobTitleMarkdown(narrative || (whole !== source ? whole : source));
}
