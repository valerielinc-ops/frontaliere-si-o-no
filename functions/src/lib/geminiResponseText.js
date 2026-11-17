/**
 * Legacy response-shape parser retained for regression fixtures only.
 * Production generation no longer imports this helper or calls the Google API.
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
