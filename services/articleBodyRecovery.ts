/** Punctuation-only bodies are missing content, not authoritative translations. */
export function isArticleBodyPlaceholder(value: string): boolean {
  return /^[…\s.]*$/.test(value);
}

export function needsArticleBodyRecovery(parts: readonly string[]): boolean {
  return parts.length === 0 || parts.some(isArticleBodyPlaceholder);
}
