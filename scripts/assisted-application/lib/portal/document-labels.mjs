const documentContextRe = (terms) => new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}])(?:${terms})(?![\\p{L}\\p{N}\\p{M}])`,
  'iu',
);

export const CV_DOCUMENT_TERMS = 'cv|resume|résumé|lebenslauf|curriculum(?:\\s+vitae)?';
export const COVER_LETTER_DOCUMENT_TERMS = 'cover\\s+letter|motivation(?:s|al)?\\s+(?:letter|schreiben)|anschreiben|motivationsschreiben|lettre\\s+de\\s+motivation|lettera\\s+di\\s+(?:motivazione|presentazione)';
export const CV_DOCUMENT_CONTEXT_RE = documentContextRe(CV_DOCUMENT_TERMS);
export const COVER_LETTER_DOCUMENT_CONTEXT_RE = documentContextRe(COVER_LETTER_DOCUMENT_TERMS);

export function isCvDocumentLabel(value) {
  const label = String(value || '');
  return CV_DOCUMENT_CONTEXT_RE.test(label) && !COVER_LETTER_DOCUMENT_CONTEXT_RE.test(label);
}
