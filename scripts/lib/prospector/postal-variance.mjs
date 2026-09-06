/**
 * Measurement of the "variable NPA" criterion for reading a vacancy's
 * municipality out of the free text of a detail page.
 *
 * The prospector currently refuses to read the location from prose, and the
 * reason is written down in #7464: on `physioswiss.ch` the vacancy's own NPA
 * (`4528 Zuchwil`, `9472 Grabs`, `4600 Olten`) sits in the body next to the
 * association's `3013 Bern`, which is on every single page; on Umantis tenants
 * a bare gazetteer match invents places (`alle`, German for "all", is also the
 * JU municipality Alle; `1271 Euro` reads as an NPA followed by a word).
 *
 * The proposed rule — "the NPA that varies between pages of the same employer
 * is the vacancy's, the one that repeats is boilerplate" — is plausible and
 * unmeasured. This module is the measurement, not the rule: it extracts every
 * NPA+municipality pair from a page, splits a host's pairs into constant and
 * variable, and scores the criterion against the location the listing already
 * knows. Nothing here is imported by the publishing path; the child issue
 * decides whether the numbers justify wiring it into
 * `scripts/lib/prospector/location-evidence.mjs`.
 */

import {
  normalizeSwissTargetLocationText,
  swissMunicipalityCantons,
} from '../target-swiss-locations.mjs';

/**
 * NPA followed by a capitalised place name, anywhere in the page text.
 *
 * Deliberately wider than `SWISS_POSTAL_ADDRESS_RX` in `extract.mjs`, which
 * only looks inside `<address>`/contact containers: the whole point of the
 * measurement is prose, where the vacancy's NPA usually is. Swiss NPAs are
 * 1000-9999, so a leading zero is not one.
 */
export const FREE_TEXT_POSTAL_RX =
  /(?:^|[\s,;:(–—-])(?:CH[\s-]?)?([1-9]\d{3})\s+(\p{Lu}[\p{L}'’.-]*(?:[ -]\p{L}[\p{L}'’.-]*){0,3})/gu;

const HTML_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#039': "'",
};

/**
 * Render an HTML document down to its visible text.
 *
 * Tags become newlines rather than nothing: gluing `<p>4528 Zuchwil</p>` to the
 * next block would let the municipality swallow the words that follow it, the
 * same trap `renderedPostalAddressCandidates()` documents.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html = '') {
  return String(html)
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, '\n')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (raw, name) => {
      const key = String(name).toLowerCase();
      if (Object.hasOwn(HTML_ENTITIES, key)) return HTML_ENTITIES[key];
      if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16) || 32);
      if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10) || 32);
      return raw;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

/**
 * Identity of an NPA mention: the code plus the normalised municipality. Two
 * pages naming `3013 Bern` name the same place even if one writes `CH-3013`.
 *
 * @param {{ postalCode: string, locality: string }} mention
 * @returns {string}
 */
export function postalMentionKey(mention) {
  return `${mention.postalCode} ${normalizeSwissTargetLocationText(mention.locality)}`.trim();
}

/**
 * Every NPA+place pair in a page, in document order, deduplicated by identity.
 *
 * `known` records whether the place name is in the municipality gazetteer. It
 * is reported rather than filtered on, because how much of the noise the
 * gazetteer alone removes is one of the numbers this measurement exists to
 * produce.
 *
 * @param {string} html
 * @returns {Array<{ postalCode: string, locality: string, key: string, cantons: string[], known: boolean }>}
 */
export function freeTextPostalMentions(html = '') {
  const text = htmlToText(html);
  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(FREE_TEXT_POSTAL_RX)) {
    const postalCode = match[1];
    const locality = match[2].replace(/[\s.]+$/, '').replace(/\s+/g, ' ').trim();
    if (!locality) continue;
    const mention = { postalCode, locality, key: '', cantons: [], known: false };
    mention.key = postalMentionKey(mention);
    if (seen.has(mention.key)) continue;
    seen.add(mention.key);
    mention.cantons = swissMunicipalityCantons(locality);
    mention.known = mention.cantons.length > 0;
    out.push(mention);
  }
  return out;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameLocality(a, b) {
  const left = normalizeSwissTargetLocationText(a);
  const right = normalizeSwissTargetLocationText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  // The listing truth is a display string (`8006 Zürich, ZH`), the mention is a
  // bare municipality: a whole-token containment is a match, a substring is not
  // (`Bern` must not match `Berneck`).
  const tokens = (value) => new Set(value.split(/[\s,;/|-]+/).filter(Boolean));
  const [shortSide, longSide] = left.length <= right.length ? [left, right] : [right, left];
  const shortTokens = [...tokens(shortSide)];
  const longTokens = tokens(longSide);
  return shortTokens.length > 0 && shortTokens.every((token) => longTokens.has(token));
}

/**
 * Split one host's sampled pages into boilerplate and vacancy-specific NPAs,
 * and score the "variable NPA" criterion against the listing's own location.
 *
 * A pair is boilerplate when it appears on *every* sampled page: that is the
 * criterion under test, stated exactly. Scoring only counts pages whose
 * location the listing already knows — everywhere else the criterion has an
 * answer and we have nothing to check it against, which is reported as
 * `withoutTruth` instead of being quietly folded into the rate.
 *
 * `baseline` scores the naive rule (take the first NPA on the page, variance
 * ignored). The criterion is only worth wiring in if it beats that.
 *
 * @param {Array<{ url: string, mentions: any[], truth?: string }>} pages
 */
export function summarizeHostPostalVariance(pages = []) {
  const usable = pages.filter((page) => Array.isArray(page.mentions));
  const counts = new Map();
  for (const page of usable) {
    for (const key of new Set(page.mentions.map((m) => m.key))) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  // With a single page nothing can be observed to vary: every pair would be
  // "constant" by arithmetic, not by evidence. Report it, do not score it.
  const measurable = usable.length >= 2;
  const constantKeys = new Set(
    measurable ? [...counts].filter(([, n]) => n === usable.length).map(([key]) => key) : [],
  );

  const score = { hits: 0, misses: 0, noPrediction: 0 };
  const baseline = { hits: 0, misses: 0, noPrediction: 0 };
  let withoutTruth = 0;
  const perPage = usable.map((page) => {
    const known = page.mentions.filter((m) => m.known);
    const variable = measurable ? known.filter((m) => !constantKeys.has(m.key)) : [];
    const predicted = variable[0] || null;
    const baselinePredicted = known[0] || null;
    const truth = String(page.truth || '').trim();
    let verdict = 'no-truth';
    let baselineVerdict = 'no-truth';
    if (!truth) {
      withoutTruth += 1;
    } else {
      const grade = (prediction, bucket) => {
        if (!prediction) { bucket.noPrediction += 1; return 'no-prediction'; }
        if (sameLocality(prediction.locality, truth)) { bucket.hits += 1; return 'hit'; }
        bucket.misses += 1;
        return 'miss';
      };
      verdict = grade(predicted, score);
      baselineVerdict = grade(baselinePredicted, baseline);
    }
    return {
      url: page.url,
      truth,
      mentions: page.mentions.length,
      knownMentions: known.length,
      variableMentions: variable.map((m) => m.key),
      predicted: predicted ? predicted.key : '',
      verdict,
      baselinePredicted: baselinePredicted ? baselinePredicted.key : '',
      baselineVerdict,
    };
  });

  return {
    pages: usable.length,
    measurable,
    constant: [...constantKeys].sort(),
    variable: [...counts].filter(([key]) => !constantKeys.has(key)).map(([key]) => key).sort(),
    withTruth: usable.length - withoutTruth,
    withoutTruth,
    criterion: rate(score),
    baseline: rate(baseline),
  };
}

/**
 * Precision counts only the pages where the criterion committed to an answer;
 * recall counts every page whose truth is known, so a criterion that stays
 * silent pays for it. Rates are `null`, never 0, when the denominator is empty:
 * "not measured" and "measured at zero" must not read the same in the report.
 *
 * @param {{ hits: number, misses: number, noPrediction: number }} score
 */
export function rate(score) {
  const decided = score.hits + score.misses;
  const graded = decided + score.noPrediction;
  return {
    ...score,
    precision: decided ? score.hits / decided : null,
    recall: graded ? score.hits / graded : null,
  };
}

/**
 * @param {Record<string, ReturnType<typeof summarizeHostPostalVariance>>} byHost
 */
export function aggregatePostalVariance(byHost = {}) {
  const totals = {
    hosts: 0,
    pages: 0,
    withTruth: 0,
    criterion: { hits: 0, misses: 0, noPrediction: 0 },
    baseline: { hits: 0, misses: 0, noPrediction: 0 },
  };
  for (const summary of Object.values(byHost)) {
    if (!summary?.measurable) continue;
    totals.hosts += 1;
    totals.pages += summary.pages;
    totals.withTruth += summary.withTruth;
    for (const bucket of /** @type {const} */ (['criterion', 'baseline'])) {
      for (const field of /** @type {const} */ (['hits', 'misses', 'noPrediction'])) {
        totals[bucket][field] += summary[bucket][field];
      }
    }
  }
  return { ...totals, criterion: rate(totals.criterion), baseline: rate(totals.baseline) };
}
