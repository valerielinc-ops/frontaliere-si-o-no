/**
 * Detect and repair malformed UTF-8 text in job fields.
 *
 * Some translation batches wrote UTF-8 bytes as Latin-1 characters.  The
 * common complete form (`ActivitÃ©s`) can be decoded losslessly.  A smaller
 * class in the crawler data lost the second byte altogether (`piÃ1`, `puÃ2`)
 * or rendered it as a combining diaeresis.  The locale-aware fallback below
 * repairs only those observed fragments; an otherwise bare `Ã` is ambiguous
 * and stays queued for retranslation.
 */

const COMPLETE_UTF8_AS_LATIN1 = /(?:(?:Ã|Â)[\u0080-\u00BF])+/gu;
const MALFORMED_MARKERS = /Ã|�|Â(?=[\s\d])/u;

function decodeLatin1Utf8(value) {
  const bytes = Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
  const decoded = Buffer.from(bytes).toString('utf8');
  return decoded.includes('\uFFFD') ? value : decoded;
}

/**
 * Return true when a string still contains a known mojibake marker.
 * `Âge` is valid French and is intentionally not treated as corruption.
 */
export function hasMojibake(value) {
  return typeof value === 'string' && MALFORMED_MARKERS.test(value);
}

/**
 * Repair one user-visible text value.  The function is idempotent and leaves
 * non-string values untouched so callers can safely apply it to optional job
 * fields.
 */
export function repairMojibakeText(value, locale = '') {
  if (typeof value !== 'string' || !value) return value;

  let repaired = value.replace(COMPLETE_UTF8_AS_LATIN1, decodeLatin1Utf8);
  const targetLocale = String(locale || '').toLowerCase().split(/[-_]/u)[0];

  // A translation batch emitted the first UTF-8 byte as `Ã` and then either
  // dropped the continuation byte or rendered it as a combining diaeresis.
  // These are the only incomplete forms observed in the published crawler
  // slice.  Keep them locale-scoped.  A bare `Ã` has no safe meaning even
  // when the target language is known: `ActivitÃ` could be a truncated
  // `Activité`, while the Italian counterpart could be `Attività`; guessing
  // would publish an invented word and hide the source defect.
  if (targetLocale === 'it' || targetLocale === 'fr') {
    repaired = repaired
      .replace(/Ã[ \t]*\u0308/gu, 'è')
      .replace(/Ã1/gu, 'ù')
      .replace(/Ã2/gu, 'ò');
  }

  return repaired;
}

/**
 * Normalize the text fields rendered by a job page.  Locale maps carry their
 * locale so incomplete fragments can be repaired safely; the top-level fields
 * use the job source locale.
 */
const DROP_VALUE = Symbol('drop-mojibake-value');

/**
 * Repair a scalar or requirements array and report whether any marker could
 * not be repaired.  `dropUnrecoverable` is used only for the aggregate copy:
 * crawler slices must retain the original source so retranslation can use it.
 */
function repairValue(value, locale, { dropUnrecoverable }) {
  if (typeof value === 'string') {
    const repaired = repairMojibakeText(value, locale);
    if (!hasMojibake(repaired)) {
      return { value: repaired, changed: repaired !== value, unresolved: false };
    }
    return {
      value: dropUnrecoverable ? DROP_VALUE : value,
      changed: false,
      unresolved: true,
    };
  }

  if (Array.isArray(value)) {
    const next = [];
    let changed = false;
    let unresolved = false;
    for (const item of value) {
      const result = repairValue(item, locale, { dropUnrecoverable });
      changed ||= result.changed;
      unresolved ||= result.unresolved;
      if (result.value !== DROP_VALUE) next.push(result.value);
      else changed = true;
    }
    return { value: next, changed, unresolved };
  }

  return { value, changed: false, unresolved: false };
}

/**
 * Normalize the text fields rendered by a job.
 *
 * When `dropUnrecoverable` is true, unresolved strings are removed from the
 * assembled publication copy after setting `needsRetranslation`.  The default
 * keeps them in the crawler slice so the retranslation worker can inspect the
 * original source text.
 */
export function repairJobMojibakeInPlace(job, { dropUnrecoverable = false } = {}) {
  if (!job || typeof job !== 'object') return 0;
  let repairedCount = 0;
  const sourceLocale = job.sourceLang || '';

  const repairField = (key, locale = sourceLocale) => {
    if (job[key] === undefined || job[key] === null) return;
    const result = repairValue(job[key], locale, { dropUnrecoverable });
    if (result.unresolved) {
      job.needsRetranslation = true;
    }
    if (result.changed) repairedCount++;
    if (result.value === DROP_VALUE) delete job[key];
    else if (result.changed) job[key] = result.value;
  };

  repairField('title');
  repairField('description');
  repairField('requirements');

  for (const mapKey of ['titleByLocale', 'descriptionByLocale', 'requirementsByLocale']) {
    const values = job[mapKey];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [locale, value] of Object.entries(values)) {
      const result = repairValue(value, locale, { dropUnrecoverable });
      if (result.unresolved) {
        job.needsRetranslation = true;
      }
      if (result.changed) repairedCount++;
      if (result.value === DROP_VALUE) delete values[locale];
      else if (result.changed) values[locale] = result.value;
    }
  }

  return repairedCount;
}
