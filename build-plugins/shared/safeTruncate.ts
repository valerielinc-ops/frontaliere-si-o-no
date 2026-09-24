/**
 * Surrogate-safe string truncation for JSON-LD / meta text.
 *
 * Astral characters — emoji (🤝 = `🤝`), some CJK, math symbols —
 * occupy TWO UTF-16 code units (a high + low surrogate pair). A naive
 * `str.slice(0, n)` can cut *between* the two halves, leaving an unpaired high
 * surrogate (`\uD83E`) at the end. Browsers render it as the replacement
 * character and, critically, Google Rich Results rejects the JSON-LD with
 * "Unparsable structured data / Truncated Unicode character" (and the SPA's
 * own structured-data validators choke the same way).
 *
 * `truncateCodeUnits` caps a string to at most `max` UTF-16 code units WITHOUT
 * splitting a surrogate pair: if the boundary lands mid-pair it backs off one
 * unit so the trailing astral char is dropped whole. `stripLoneSurrogates` is
 * a defensive final pass that removes ANY unpaired surrogate anywhere in the
 * string — use it on text whose provenance you don't fully control.
 */

/**
 * Truncate `input` to at most `max` UTF-16 code units without splitting a
 * surrogate pair. Returns the input unchanged when already within budget.
 */
export function truncateCodeUnits(input: string, max: number): string {
  if (max <= 0) return '';
  if (input.length <= max) return input;
  let end = max;
  // If `end` would fall between a high and low surrogate, drop the dangling
  // high half so we never emit a lone surrogate.
  const code = input.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return input.slice(0, end);
}

/**
 * Remove any unpaired surrogate code unit (high without low, or low without high).
 *
 * Copies clean runs with `slice` instead of appending one code unit at a time:
 * the per-unit `output +=` loop built one rope node per character (~7 s and
 * ~250 MB of heap on a 10M-unit input, follow-up FU-2026-09-24-034 of #9609).
 * A well-formed input is returned as is, without any copy.
 */
export function stripLoneSurrogates(input: string): string {
  let parts: string[] | null = null;
  let runStart = 0;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    }
    // Lone surrogate: keep the clean run before it and skip this unit.
    (parts ??= []).push(input.slice(runStart, index));
    runStart = index + 1;
  }
  if (parts === null) return input;
  parts.push(input.slice(runStart));
  return parts.join('');
}

/** Google's practical limit for JSON-LD `description` values. */
export const MAX_ARTICLE_JSONLD_DESCRIPTION_CHARS = 5000;

/**
 * Guard a `description` value bound for an `Article` JSON-LD object: a
 * blank/whitespace-only input returns `undefined` (so `JSON.stringify` drops
 * the key entirely rather than emitting `""`), a non-blank one is capped at
 * `MAX_ARTICLE_JSONLD_DESCRIPTION_CHARS` via `truncateCodeUnits`.
 */
export function guardArticleJsonLdDescription(input: string): string | undefined {
  const trimmed = input.trim();
  return trimmed ? truncateCodeUnits(trimmed, MAX_ARTICLE_JSONLD_DESCRIPTION_CHARS) : undefined;
}
