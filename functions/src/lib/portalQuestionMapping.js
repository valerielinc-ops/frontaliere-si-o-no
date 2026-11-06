function optionText(option) {
  return typeof option === 'object' ? option?.label ?? option?.value : option;
}

function normalizedOption(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function booleanOptionValue(value) {
  const normalized = normalizedOption(value);
  if (/^(?:yes|ja|si|sì|oui|vero|true)$/.test(normalized)) return true;
  if (/^(?:no|nein|non|falso|false)$/.test(normalized)) return false;
  return null;
}

function placeholderOption(value) {
  return /^(?:select|seleziona|selezionare|please select|bitte wahlen|bitte waehlen|auswahlen|auswaehlen|choisir|selectionner|a scelta|choose|select an option)$/.test(normalizedOption(value));
}

function sameOptionMeaning(left, right) {
  const a = normalizedOption(optionText(left));
  const b = normalizedOption(optionText(right));
  if (!a || !b) return false;
  if (a === b) return true;
  const leftBoolean = booleanOptionValue(a);
  const rightBoolean = booleanOptionValue(b);
  if (leftBoolean !== null && rightBoolean !== null) return leftBoolean === rightBoolean;
  return placeholderOption(a) && placeholderOption(b);
}

function hasUniqueNormalizedLabels(values) {
  const labels = new Set();
  for (const value of values) {
    const label = normalizedOption(value);
    if (!label || labels.has(label)) return false;
    labels.add(label);
  }
  return true;
}

function resolveUniqueOption(values, answer, label = optionText) {
  const value = String(answer ?? '').trim();
  const exact = values.filter((item) => String(label(item) ?? '').trim() === value);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const normalized = normalizedOption(value);
  if (!normalized) return null;
  const matches = values.filter((item) => normalizedOption(label(item)) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Return only mappings whose application label is an exact live option label.
 * A positional fallback is accepted only for identical, boolean, or placeholder
 * options; translated arbitrary choices must carry an explicit optionMap.
 */
export function portalOptionMap(question) {
  const candidateOptions = (Array.isArray(question?.options) ? question.options : []).map(optionText).map((value) => String(value ?? '').trim()).filter(Boolean);
  const applicationOptions = (Array.isArray(question?.applicationOptions) ? question.applicationOptions : []).map(optionText).map((value) => String(value ?? '').trim()).filter(Boolean);
  if (!applicationOptions.length) return [];
  const explicit = Array.isArray(question?.optionMap)
    ? question.optionMap.map((pair) => ({ candidate: String(pair?.candidate || '').trim(), application: String(pair?.application || '').trim() })).filter((pair) => pair.candidate && pair.application)
    : [];
  const applicationLabels = new Set(applicationOptions);
  const candidateLabels = new Set();
  if (explicit.length === applicationOptions.length
    && hasUniqueNormalizedLabels(applicationOptions)
    && hasUniqueNormalizedLabels(explicit.map((pair) => pair.candidate))
    && explicit.every((pair) => applicationLabels.has(pair.application) && !candidateLabels.has(normalizedOption(pair.candidate)) && candidateLabels.add(normalizedOption(pair.candidate)))
    && applicationOptions.every((label) => explicit.filter((pair) => pair.application === label).length === 1)) return explicit;
  if (candidateOptions.length !== applicationOptions.length) return [];
  const pairs = candidateOptions.map((candidate, index) => ({ candidate, application: applicationOptions[index] }));
  return hasUniqueNormalizedLabels(candidateOptions) && hasUniqueNormalizedLabels(applicationOptions)
    && pairs.every((pair) => sameOptionMeaning(pair.candidate, pair.application)) ? pairs : [];
}

/** Convert a candidate-facing option to the exact option label expected by the ATS. */
export function portalAnswerForApplication(question, answer) {
  const value = String(answer ?? '').trim();
  if (!value) return value;
  const mapping = portalOptionMap(question);
  const mapped = resolveUniqueOption(mapping, value, (pair) => pair.candidate);
  if (mapped) return mapped.application;
  const applicationOptions = Array.isArray(question?.applicationOptions) ? question.applicationOptions.map(optionText).map((item) => String(item ?? '').trim()).filter(Boolean) : [];
  const exact = resolveUniqueOption(applicationOptions, value);
  if (exact !== null) return exact;
  const boolean = booleanOptionValue(value);
  if (boolean !== null) {
    const matching = applicationOptions.filter((option) => booleanOptionValue(option) === boolean);
    if (matching.length === 1) return matching[0];
  }
  // A choice field with no trustworthy candidate→ATS mapping must not receive
  // a translated label: leaving it empty routes the question back for review.
  return applicationOptions.length ? '' : value;
}
