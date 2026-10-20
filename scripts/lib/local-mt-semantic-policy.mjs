// Fail-closed overwrite policy for the Argos mop-up (#9676).
//
// The judge in ./local-mt-semantic-judge.mjs returns one number: the e5-small
// cosine between the source and the finalized candidate. Measured on the
// calibration dataset (tests/fixtures/local-mt-semantic-cases.json, scores in
// tests/fixtures/local-mt-semantic-e5-scores.json) that number cannot tell a
// correct translation from a wrong one: preserved 0.881-0.934, inversion
// 0.847-0.941, loss 0.821-0.889, unclear 0.857-0.911. A threshold on the cosine
// alone either writes inversions or writes nothing.
//
// This module adds what the cosine does not read, and decides where the
// cosine still helps:
//
// 1. Deterministic meaning guards, computed on the texts, no model: negation
//    parity, polarity pairs of the job-posting vocabulary (full/part time,
//    start/end, permanent/temporary), quantities and level codes that must
//    survive, the order of named places, truncation of a sentence, and a no-op
//    against the stored value. Each guard only ever REJECTS: a false positive
//    keeps the stored value, it never writes.
// 2. An echo ceiling: a cross-lingual pair scoring like a same-language copy
//    (>= 0.97; correct pairs top out at 0.934, wrong-language copies start at
//    0.9805) is a source echo, not a translation.
// 3. A conservative cutoff on the survivors, derived by
//    calibrateOverwriteCutoff() so that NO labelled negative of the dataset is
//    accepted. What the guards cannot see (`unclear` word-sense cases, a role
//    inversion such as `Mitarbeiter Rezeption -> Ricevimento dei dipendenti`)
//    sits at 0.857-0.925, so the cutoff lands above it and most correct
//    candidates fall in the `unclear` band. That is the price of precision,
//    and on the overwrite arm it is the right price: `unclear` keeps the value
//    already published.
//
// Scope: the policy governs REPLACING an existing value (the language-driven
// arm of classifyMopupStructure(), rollout switch LOCAL_MT_LANG_AWARE_OVERWRITE,
// default off). Filling an empty slot keeps the judge's bootstrap gate: the
// guards were not measured on production fills and tightening them before the
// telemetry of #9677 exists would change the production rollout blind.
//
// Rollback: createSemanticRollbackGuard() watches one run of the overwrite
// arm. Any unavailable verdict, or a share of rejected candidates above
// SEMANTIC_ROLLBACK_MAX_REGRESSION_RATE (below the 12.3% regression rate the
// Argos A/B measured), switches the arm off for the rest of the run before
// the next candidate is written.

export const LOCAL_MT_SEMANTIC_POLICY_VERSION = 'local-mt-semantic-policy-v1';

/** Candidates scoring at or above this are echoes of the source, not translations. */
export const SEMANTIC_ECHO_CEILING = 0.97;

/**
 * Overwrite cutoff on the e5-small cosine, for candidates that pass every
 * guard. Calibrated by calibrateOverwriteCutoff() on the dataset plus the
 * #9675 report pairs: the highest surviving negative scores 0.9246 and the
 * lowest preserved candidate above it 0.9344. The test suite fails if a
 * dataset change moves either bound past this value.
 */
export const SEMANTIC_OVERWRITE_CUTOFF = 0.93;

/** Below this candidate/source length ratio a SENTENCE is treated as truncated. */
export const SEMANTIC_MIN_LENGTH_RATIO = 0.7;
/** Titles and compounds contract legitimately (`Elektroinstallateur -> Elettricista`). */
export const SEMANTIC_TRUNCATION_MIN_SOURCE_CHARS = 24;

export const SEMANTIC_ROLLBACK_MAX_REGRESSION_RATE = 0.05;
export const SEMANTIC_ROLLBACK_MIN_OBSERVATIONS = 20;

export const POLICY_VERDICT = Object.freeze({
  ACCEPT: 'accept',
  REJECT: 'reject',
  UNCLEAR: 'unclear',
  UNAVAILABLE: 'unavailable',
});

const L = '[\\p{L}\\p{N}]';
const word = (body) => new RegExp(`(?<!${L})(?:${body})(?!${L})`, 'giu');
// German compounds carry the concept inside the word (`Vollzeitvertrag`).
const stem = (body) => new RegExp(`(?<!${L})(?:${body})`, 'giu');

const NEGATION = {
  it: word('non|mai|senza|nessun[oa]?|né'),
  en: word('not|no|never|without|none|nor|cannot') ,
  de: word('nicht|kein(?:e|en|er|es|em)?|nie|niemals|ohne'),
  // `ne ... pas` is one negation: count the second particle only.
  fr: word('pas|jamais|aucun(?:e)?|sans|ni'),
};
const EN_CONTRACTED_NEGATION = /n't(?![\p{L}\p{N}])/giu;

// Pairs of mutually exclusive facts of a job posting. A candidate that drops
// one side and states the other has inverted the fact.
const POLARITY_PAIRS = [
  ['full-time', {
    it: word('tempo pieno'), en: word('full[- ]time'), de: stem('vollzeit'), fr: word('temps plein|plein temps'),
  }, 'part-time', {
    it: word('tempo parziale|part[- ]time'), en: word('part[- ]time'), de: stem('teilzeit'), fr: word('temps partiel'),
  }],
  ['permanent', {
    it: word('(?:tempo )?indeterminato'), en: word('permanent|open[- ]ended'), de: stem('unbefristet'),
    fr: word('(?:durée )?indéterminée|cdi'),
  }, 'temporary', {
    it: word('tempo determinato|temporaneo|temporanea'), en: word('temporary|fixed[- ]term'),
    de: new RegExp(`(?<!${L})(?<!un)befristet`, 'giu'), fr: word('durée déterminée|cdd|temporaire'),
  }],
  ['start', {
    it: word('inizi(?:a|ano|o|are|ato)'), en: word('start(?:s|ing)?|begin(?:s|ning)?'),
    de: word('beginn(?:t|en)?|startet|starten'), fr: word('commenc\\p{L}*|débute?|débutent'),
  }, 'end', {
    it: word('termin(?:a|ano|are|ato)|finisce'), en: word('ends?|ending|finish(?:es)?'),
    de: word('endet|enden|ende'), fr: word('termine|terminent|finit|fin'),
  }],
];

// Number words 2-12. `one` is left out (article in it/de/fr), and so are the
// words that are also ordinary words: it `sei` (you are), fr `neuf` (new).
const NUMBER_WORDS = {
  it: ['', '', 'due', 'tre', 'quattro', 'cinque', '', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici'],
  en: ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'],
  de: ['', '', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'],
  fr: ['', '', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', '', 'dix', 'onze', 'douze'],
};

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function countMatches(text, regex) {
  regex.lastIndex = 0;
  return (text.match(regex) || []).length;
}

function has(text, regex) {
  regex.lastIndex = 0;
  return regex.test(text);
}

function negations(text, lang) {
  const pattern = NEGATION[lang];
  if (!pattern) return null;
  const extra = lang === 'en' ? countMatches(text, EN_CONTRACTED_NEGATION) : 0;
  return countMatches(text, pattern) + extra;
}

function quantities(text, lang) {
  const found = new Set();
  for (const match of text.matchAll(/\d+(?:[.,:]\d+)?/g)) found.add(match[0].replace(',', '.'));
  const words = NUMBER_WORDS[lang] || [];
  words.forEach((w, value) => {
    if (w && has(text, word(w))) found.add(String(value));
  });
  return found;
}

function levelCodes(text) {
  // Tokens mixing capitals and digits: CEFR levels (B2), licences, standards.
  return new Set(
    [...text.matchAll(/(?<![\p{L}\p{N}])(?=[\p{L}\p{N}]*\d)(?=[\p{L}\p{N}]*\p{Lu})[\p{L}\p{N}]{2,}(?![\p{L}\p{N}])/gu)]
      .map((m) => m[0].toLowerCase()),
  );
}

function capitalizedTokens(text) {
  const tokens = [];
  const re = /[\p{L}]+/gu;
  let match;
  let first = true;
  while ((match = re.exec(text))) {
    const token = match[0];
    const sentenceStart = first || /[.!?:]\s*$/.test(text.slice(0, match.index));
    first = false;
    if (!sentenceStart && token.length >= 4 && /^\p{Lu}\p{Ll}/u.test(token)) {
      tokens.push({ token: token.toLowerCase(), index: match.index });
    }
  }
  return tokens;
}

function samePlace(a, b) {
  const min = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < min && a[prefix] === b[prefix]) prefix++;
  // `Bellinzone`/`Bellinzona`, `Zurigo`... share all but the ending.
  return prefix >= Math.max(4, min - 2);
}

function placeOrderSwapped(source, candidate) {
  const candidateTokens = capitalizedTokens(candidate);
  const positions = [];
  for (const { token } of capitalizedTokens(source)) {
    const hit = candidateTokens.find((c) => samePlace(token, c.token));
    if (hit && !positions.includes(hit.index)) positions.push(hit.index);
  }
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] < positions[i - 1]) return true;
  }
  return false;
}

/**
 * Deterministic reasons why `candidateText` must not replace the stored value.
 * Pure, no model, no I/O. An empty array means "no guard objects", not "the
 * meaning is preserved": the caller still needs a score for that.
 */
export function meaningGuardFindings({
  sourceText,
  sourceLang,
  candidateText,
  targetLocale,
  existingText = '',
} = {}) {
  const source = clean(sourceText);
  const candidate = clean(candidateText);
  const existing = clean(existingText);
  const findings = [];
  if (!source || !candidate) return ['missing-text'];

  if (existing && existing.toLowerCase() === candidate.toLowerCase()) findings.push('no-op');

  const sourceNeg = negations(source, sourceLang);
  const candidateNeg = negations(candidate, targetLocale);
  if (sourceNeg !== null && candidateNeg !== null && sourceNeg !== candidateNeg) {
    findings.push('negation');
  }

  for (const [nameA, a, nameB, b] of POLARITY_PAIRS) {
    const [sa, ca, sb, cb] = [a[sourceLang], a[targetLocale], b[sourceLang], b[targetLocale]];
    if (!sa || !ca || !sb || !cb) continue;
    if (has(source, sa) && !has(candidate, ca) && has(candidate, cb)) findings.push(`polarity:${nameA}->${nameB}`);
    if (has(source, sb) && !has(candidate, cb) && has(candidate, ca)) findings.push(`polarity:${nameB}->${nameA}`);
  }

  const candidateQuantities = quantities(candidate, targetLocale);
  for (const value of quantities(source, sourceLang)) {
    if (!candidateQuantities.has(value)) findings.push(`quantity:${value}`);
  }

  const candidateCodes = levelCodes(candidate);
  for (const code of levelCodes(source)) {
    if (!candidateCodes.has(code)) findings.push(`code:${code}`);
  }

  if (placeOrderSwapped(source, candidate)) findings.push('place-order');

  if (source.length >= SEMANTIC_TRUNCATION_MIN_SOURCE_CHARS
    && candidate.length / source.length < SEMANTIC_MIN_LENGTH_RATIO) {
    findings.push('truncation');
  }

  return [...new Set(findings)];
}

function validScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

function decide(verdict, reason, extra) {
  return Object.freeze({
    verdict,
    shouldWrite: verdict === POLICY_VERDICT.ACCEPT,
    reason,
    ...extra,
  });
}

/**
 * The overwrite decision for one candidate. Only `accept` writes. A missing
 * or non-finite score is `unavailable`, any guard finding or an echo is
 * `reject`, a clean candidate below the cutoff is `unclear`.
 */
export function evaluateOverwritePolicy({
  sourceText,
  sourceLang,
  candidateText,
  targetLocale,
  existingText = '',
  score,
  cutoff = SEMANTIC_OVERWRITE_CUTOFF,
  echoCeiling = SEMANTIC_ECHO_CEILING,
} = {}) {
  const base = { score: validScore(score) ? score : null, cutoff, findings: [] };
  if (base.score === null) return decide(POLICY_VERDICT.UNAVAILABLE, 'score-unavailable', base);
  if (!validScore(cutoff)) return decide(POLICY_VERDICT.UNAVAILABLE, 'cutoff-unavailable', base);

  const findings = meaningGuardFindings({ sourceText, sourceLang, candidateText, targetLocale, existingText });
  if (findings.length > 0) {
    return decide(POLICY_VERDICT.REJECT, findings[0] === 'no-op' ? 'no-op' : 'meaning-guard', { ...base, findings });
  }
  if (score >= echoCeiling) return decide(POLICY_VERDICT.REJECT, 'source-echo', base);
  if (score < cutoff) return decide(POLICY_VERDICT.UNCLEAR, 'below-cutoff', base);
  return decide(POLICY_VERDICT.ACCEPT, 'clears-cutoff', base);
}

/**
 * Derive the overwrite cutoff from labelled rows `{ label, score, ...texts }`.
 * `preserved` is the only positive label; every other label must not write.
 * Rows the guards reject or that score as echoes never reach the cutoff; the
 * cutoff must then sit strictly above every surviving negative. Returns
 * `status: 'unavailable'` when no preserved row clears that bar, so a caller
 * can never mistake "nothing separates" for a number.
 */
export function calibrateOverwriteCutoff(rows, { echoCeiling = SEMANTIC_ECHO_CEILING } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return Object.freeze({ status: 'unavailable', reason: 'no-rows' });
  }
  const survivors = rows
    .filter((row) => validScore(row.score) && row.score < echoCeiling)
    .filter((row) => meaningGuardFindings({
      sourceText: row.source,
      sourceLang: row.sourceLang,
      candidateText: row.candidate,
      targetLocale: row.targetLocale,
      existingText: row.existing,
    }).length === 0);
  const positives = rows.filter((row) => row.label === 'preserved');
  const negatives = survivors.filter((row) => row.label !== 'preserved');
  const maxNegativeScore = negatives.length ? Math.max(...negatives.map((row) => row.score)) : -1;
  const accepted = survivors
    .filter((row) => row.label === 'preserved' && row.score > maxNegativeScore)
    .map((row) => row.score);
  if (accepted.length === 0) {
    return Object.freeze({ status: 'unavailable', reason: 'no-separating-cutoff', maxNegativeScore });
  }
  return Object.freeze({
    status: 'ready',
    maxNegativeScore,
    lowestAcceptedScore: Math.min(...accepted),
    guardSurvivors: survivors.length,
    survivingNegatives: negatives.map((row) => row.id),
    acceptedPositives: accepted.length,
    positives: positives.length,
    recall: accepted.length / positives.length,
  });
}

/**
 * One run of the overwrite arm. observe() takes each policy result (or a
 * judge `unavailable`), status() says whether the arm may still write. The
 * guard trips on the first unavailable verdict, or once at least
 * `minObservations` candidates were seen and the rejected share exceeds
 * `maxRegressionRate`. A tripped guard stays tripped for the run.
 */
export function createSemanticRollbackGuard({
  maxRegressionRate = SEMANTIC_ROLLBACK_MAX_REGRESSION_RATE,
  minObservations = SEMANTIC_ROLLBACK_MIN_OBSERVATIONS,
} = {}) {
  const state = { observed: 0, regressions: 0, unavailable: 0, withheld: 0, trippedReason: null };

  function status() {
    const regressionRate = state.observed ? state.regressions / state.observed : 0;
    return Object.freeze({
      tripped: state.trippedReason !== null,
      reason: state.trippedReason ?? 'within-policy',
      ...state,
      regressionRate,
      maxRegressionRate,
      minObservations,
    });
  }

  return {
    observe(result) {
      if (state.trippedReason) return status();
      state.observed++;
      const verdict = result?.verdict;
      if (verdict === POLICY_VERDICT.UNAVAILABLE || verdict === undefined) {
        state.unavailable++;
        state.trippedReason = 'semantic-unavailable';
      } else if (verdict === POLICY_VERDICT.REJECT && result.reason !== 'no-op') {
        state.regressions++;
      }
      if (!state.trippedReason
        && state.observed >= minObservations
        && state.regressions / state.observed > maxRegressionRate) {
        state.trippedReason = 'regression-limit';
      }
      return status();
    },
    withhold() {
      state.withheld++;
      return status();
    },
    status,
  };
}
