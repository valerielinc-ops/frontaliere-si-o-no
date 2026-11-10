/**
 * The answer text of a Gemini response. Newer models (gemini-3.5-flash-lite
 * behind the `-latest` alias, 2026-11) split one answer across several text
 * parts, the last one carrying a `thoughtSignature`; reading only the first
 * part returned a truncated answer as a success, so a JSON answer failed to
 * parse on every retry. All text parts are joined; thought summaries
 * (`thought: true`) are not part of the answer.
 */
export function geminiResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part && typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text)
    .join('')
    .trim();
}
