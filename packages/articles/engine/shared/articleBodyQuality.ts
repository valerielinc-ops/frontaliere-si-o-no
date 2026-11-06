/**
 * Quality signals for localized article bodies.
 *
 * The corpus generator uses an ASCII ellipsis as a prompt placeholder when a
 * translation body was not produced. It can be the whole value or the prefix
 * of the small tool blocks appended by the generator. This detector is kept
 * deliberately narrow: it only inspects `bodyN` fields and requires the
 * marker to end the value or a line before treating it as a placeholder.
 *
 * Keeping the producer-shaped signal here gives every article renderer the
 * same indexability decision while the upstream corpus batch replaces the
 * historical values. It does not classify ordinary prose that merely
 * contains an ellipsis.
 */

export type ArticleBodyQualityInput = Readonly<Record<string, unknown>> | undefined;

const BODY_FIELD_RE = /^body\d+$/;
const PROMPT_PLACEHOLDER_PREFIX_RE = /^\.{3,}[ \t]*(?:\r?\n|$)/;

/** True when a body field starts with the corpus translation prompt marker. */
export function isArticleBodyPromptPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return PROMPT_PLACEHOLDER_PREFIX_RE.test(value.trimStart());
}

/** True when any localized article body section is still a prompt placeholder. */
export function hasArticleBodyPromptPlaceholder(body: ArticleBodyQualityInput): boolean {
  if (!body) return false;
  return Object.entries(body).some(([key, value]) =>
    BODY_FIELD_RE.test(key) && isArticleBodyPromptPlaceholder(value),
  );
}
