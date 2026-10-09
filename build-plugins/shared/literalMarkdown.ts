function findClosingBracket(value: string, openingIndex: number): number {
  let depth = 0;
  for (let index = openingIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findClosingParenthesis(value: string, openingIndex: number): number {
  let depth = 0;
  let angleDestination = false;
  let quotedTitle = '';
  for (let index = openingIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (quotedTitle) {
      if (char === quotedTitle) quotedTitle = '';
      continue;
    }
    if (angleDestination) {
      if (char === '>') angleDestination = false;
      continue;
    }
    if (depth === 1 && (char === '"' || char === "'")) {
      quotedTitle = char;
      continue;
    }
    if (depth === 1 && char === '<') {
      angleDestination = true;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function stripMarkdownLinks(value: string): string {
  let result = '';
  let cursor = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '[' || isEscaped(value, index)) continue;
    const labelEnd = findClosingBracket(value, index);
    if (labelEnd < 0) continue;

    let linkEnd = -1;
    const next = value[labelEnd + 1];
    if (next === '(') {
      const destinationEnd = findClosingParenthesis(value, labelEnd + 1);
      if (destinationEnd >= 0) linkEnd = destinationEnd;
    } else if (next === '[') {
      const referenceEnd = findClosingBracket(value, labelEnd + 1);
      if (referenceEnd >= 0) linkEnd = referenceEnd;
    } else {
      let referenceStart = labelEnd + 1;
      while (referenceStart < value.length && /[ \t]/.test(value[referenceStart])) referenceStart += 1;
      if (value[referenceStart] === '[') {
        const referenceEnd = findClosingBracket(value, referenceStart);
        if (referenceEnd >= 0) linkEnd = referenceEnd;
      }
    }
    if (linkEnd < 0) continue;

    const tokenStart = index > 0 && value[index - 1] === '!' && !isEscaped(value, index - 1) ? index - 1 : index;
    result += value.slice(cursor, tokenStart);
    result += stripMarkdownLinks(value.slice(index + 1, labelEnd));
    cursor = linkEnd + 1;
    index = linkEnd;
  }

  return result + value.slice(cursor);
}

function stripLiteralHeadingMarkers(value: string): string {
  return value
    .split('\n')
    .map((line) => {
      let foundHeading = false;
      const withoutOpening = line.replace(/(^|[\s([{])#{1,6}(?=\s+)/g, (_match, prefix: string) => {
        foundHeading = true;
        return prefix;
      });
      return foundHeading ? withoutOpening.replace(/\s+#{1,6}\s*$/g, '') : withoutOpening;
    })
    .join('\n');
}

/** Browser-safe literal-markdown cleanup shared by build and SPA callers. */
export function stripLiteralMarkdown(value: string): string {
  if (!value) return value;
  let t = String(value);
  // 1. Unwrap balanced bold, keeping the inner text (`**Requisitos:**` → `Requisitos:`).
  t = stripMarkdownLinks(t);
  t = t.replace(/\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*/g, '$1');
  // 2. Nuke remaining runs of 2+ asterisks, including orphaned crawler output.
  t = t.replace(/\*{2,}/g, '');
  // 3. A description can be a one-line export of a Markdown heading (for
  // example `## In breve - ...`). Strip the marker wherever it starts a
  // heading, including when several flattened headings share one line.
  t = stripLiteralHeadingMarkers(t);
  // 4. Unwrap strong emphasis before its single-marker form. Both inner edges
  // must be non-whitespace, while the outer delimiters may touch punctuation;
  // this keeps `a * b * c` as prose and still cleans `Titolo:*term*—nota`.
  t = t.replace(/(^|[^\p{L}\p{N}_\\])__([^\s_](?:[^_\n]*?[^\s_])?)__(?=$|[^\p{L}\p{N}_])/gu, '$1$2');
  t = t.replace(/(^|[^\p{L}\p{N}_*\\])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?=$|[^\p{L}\p{N}_*])/gu, '$1$2');
  t = t.replace(/(^|[^\p{L}\p{N}_\\])_([^\s_](?:[^_\n]*?[^\s_])?)_(?=$|[^\p{L}\p{N}_])/gu, '$1$2');
  // 5. Separator runs (3+ of `_`, `=`, `~`) — drop.
  t = t.replace(/[_=~]{3,}/g, ' ');
  // 6. Orphan leading/trailing single `*` survivors.
  t = t.replace(/^\s*\*+\s*/, '').replace(/\s*\*+\s*$/, '');
  // 7. Collapse any double-spaces created by the strips.
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

function narrativeTitleRank(prefix: string): number {
  return NARRATIVE_TITLE_INTRODUCERS.findIndex((introducer) => introducer.test(prefix));
}

export function sanitizeBrowserJobTitle(value: string): string {
  if (!value) return value;
  const source = String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const whole = stripWholeMarkdownBoldWrapper(source);
  const segments = [...source.matchAll(/(^|[^*])\*\*([^*\n]{1,240})\*\*(?!\*)/g)];
  let narrative = '';
  let narrativeRank = Number.POSITIVE_INFINITY;
  // Prefer the strongest semantic introducer and keep the first segment when
  // two introducers have the same strength, in lockstep with build-time.
  for (let index = 0; index < segments.length; index += 1) {
    const match = segments[index];
    const candidate = String(match[2] || '').trim();
    const start = Number(match.index ?? -1) + String(match[1] || '').length;
    if (!candidate || start < 0) continue;
    const prefix = source.slice(0, start);
    const rank = narrativeTitleRank(prefix);
    if (rank >= 0 && rank < narrativeRank) {
      narrative = candidate;
      narrativeRank = rank;
    }
  }
  return stripJobTitleMarkdown(narrative || (whole !== source ? whole : source));
}
