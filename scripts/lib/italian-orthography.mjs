/**
 * Small, explicit guard for Italian copy emitted by deterministic builders.
 * This is intentionally not a general-purpose spellchecker: each entry is a
 * known ASCII fallback that must not reach public social copy.
 */

export const UNACCENTED_ITALIAN_FORMS = Object.freeze([
  Object.freeze({ form: 'piu', correct: 'più' }),
  Object.freeze({ form: 'perche', correct: 'perché' }),
  Object.freeze({ form: 'gia', correct: 'già' }),
  Object.freeze({ form: 'puo', correct: 'può' }),
  Object.freeze({ form: 'citta', correct: 'città' }),
  Object.freeze({ form: 'cosi', correct: 'così' }),
  Object.freeze({ form: "e'", correct: 'è' }),
  Object.freeze({ form: 'e’', correct: 'è' }),
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternFor(form) {
  if (form === "e'" || form === 'e’') {
    return new RegExp('\\b' + escapeRegExp(form) + '(?=\\s|$|[.,!?;:)\\]}])', 'giu');
  }
  return new RegExp('\\b' + escapeRegExp(form) + '\\b', 'giu');
}

/**
 * @param {unknown} text
 * @returns {Array<{form:string, correct:string, index:number}>}
 */
export function findUnaccentedItalianForms(text) {
  const value = String(text ?? '');
  const matches = [];
  for (const entry of UNACCENTED_ITALIAN_FORMS) {
    for (const match of value.matchAll(patternFor(entry.form))) {
      matches.push({
        form: entry.form,
        correct: entry.correct,
        index: match.index ?? -1,
      });
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}
