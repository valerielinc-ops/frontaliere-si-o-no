/** Canonical text; only a whole, DOM-proven live counter may lose its numerator. */
export function nativeQuestionText(value, counter = null) {
  const text = String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!counter || !Number.isSafeInteger(counter.currentLength) || !Number.isSafeInteger(counter.maxLength)
    || counter.currentLength < 0 || counter.maxLength < 0) return text;
  const match = /^(\d{1,6})\s*\/\s*(\d{1,6})\s*(Zeichen|characters?|chars?|caratteri|caract[eè]res)$/iu.exec(text);
  return match && Number(match[1]) === counter.currentLength && Number(match[2]) === counter.maxLength
    ? `max ${counter.maxLength} ${match[3]}` : text;
}
