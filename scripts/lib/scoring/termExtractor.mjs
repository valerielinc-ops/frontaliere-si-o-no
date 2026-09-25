// scripts/lib/scoring/termExtractor.mjs
//
// Extract candidate terms (unigrams, bigrams, trigrams, proper nouns,
// stems) from a headline string, for use by the cascaded scorer's
// GSC-bridge stage.
//
// Spec: design doc § 5.3.

// Italian stopwords — articles + prepositions only, per spec § 5.3
// step 3. Extended categories were rejected: short lists are predictable
// and avoid removing real signal words.
const STOPWORDS = new Set([
  'il', 'la', 'i', 'le', 'un', 'una', 'di', 'da', 'del', 'della', 'dello',
  'dei', 'delle', 'degli', 'a', 'al', 'alla', 'allo', 'ai', 'agli', 'alle',
  'in', 'nel', 'nella', 'nello', 'nei', 'nelle', 'negli', 'con', 'su', 'sul',
  'sulla', 'sullo', 'sui', 'sulle', 'sugli', 'per', 'tra', 'fra', 'e', 'o',
  'che', 'non',
]);

const MIN_UNIGRAM_LEN = 3;
const MIN_NGRAM_LEN = 6;

// Strip diacritics — NFD then drop combining marks.
function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '');
}

// Lightweight Italian stemmer. Avoids pulling wink-lemmatizer (heavy
// dependency for one suffix family). Truncates the most common Italian
// inflectional endings; conservative — only suffixes ≥3 chars touched and
// only when the resulting stem is still ≥3 chars.
function stemIt(token) {
  if (!token || token.length < 4) return token;
  const suffixes = [
    'amente', 'azione', 'azioni', 'mento', 'menti',
    'iamo', 'ate', 'ato', 'ata', 'ati', 'ano',
    'are', 'ere', 'ire',
    'osi', 'ose', 'oso', 'osa',
    'ico', 'ica', 'ici', 'iche',
    'oni', 'one',
    'i', 'e', 'a', 'o',
  ];
  for (const suf of suffixes) {
    if (token.length - suf.length >= 3 && token.endsWith(suf)) {
      return token.slice(0, -suf.length);
    }
  }
  return token;
}

/**
 * Tokenize a headline into raw tokens with capitalization preserved
 * (used to detect proper nouns) AND a lowercased/diacritic-stripped
 * variant (used for everything else).
 *
 * @param {string} headline
 * @returns {{ raw: string[], normalized: string[] }}
 */
function tokenize(headline) {
  const text = String(headline || '');
  const raw = text.split(/[\s\p{P}\p{S}]+/u).filter((t) => t.length > 0);
  const normalized = raw.map((t) => stripDiacritics(t).toLowerCase());
  return { raw, normalized };
}

/**
 * Extract candidate terms (unigrams, bigrams, trigrams, proper nouns,
 * stems) from a headline.
 *
 * @param {string} headline
 * @returns {{
 *   unigrams: string[],
 *   bigrams: string[],
 *   trigrams: string[],
 *   properNouns: string[],
 *   stems: string[],
 * }}
 */
export function extractTerms(headline) {
  const { raw, normalized } = tokenize(headline);

  // Unigrams: lowercased, diacritic-stripped, stopword-filtered, ≥3 chars.
  const unigrams = [];
  const stems = [];
  for (const tok of normalized) {
    if (tok.length < MIN_UNIGRAM_LEN) continue;
    if (STOPWORDS.has(tok)) continue;
    unigrams.push(tok);
    stems.push(stemIt(tok));
  }

  // Bigrams + trigrams: sliding window over normalized stream (stopwords
  // included so multi-word phrases like "permesso di soggiorno" survive).
  const bigrams = [];
  const trigrams = [];
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const bi = `${normalized[i]} ${normalized[i + 1]}`;
    if (bi.length >= MIN_NGRAM_LEN) bigrams.push(bi);
  }
  for (let i = 0; i < normalized.length - 2; i += 1) {
    const tri = `${normalized[i]} ${normalized[i + 1]} ${normalized[i + 2]}`;
    if (tri.length >= MIN_NGRAM_LEN) trigrams.push(tri);
  }

  // Proper nouns: tokens originally capitalized in the source (after
  // skipping the first sentence-position token, which is always
  // capitalized). Also concatenate adjacent capitalized pairs as a single
  // proper-noun phrase ("Lugano Centro").
  const properNouns = [];
  let runStart = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const tok = raw[i];
    const isCap = /^\p{Lu}/u.test(tok);
    if (isCap && i > 0) {
      properNouns.push(stripDiacritics(tok).toLowerCase());
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0 && i - runStart >= 2) {
        const phrase = raw.slice(runStart, i).map((t) => stripDiacritics(t).toLowerCase()).join(' ');
        properNouns.push(phrase);
      }
      runStart = -1;
    }
  }
  // Tail run.
  if (runStart >= 0 && raw.length - runStart >= 2) {
    const phrase = raw.slice(runStart).map((t) => stripDiacritics(t).toLowerCase()).join(' ');
    properNouns.push(phrase);
  }

  return {
    unigrams: dedup(unigrams),
    bigrams: dedup(bigrams),
    trigrams: dedup(trigrams),
    properNouns: dedup(properNouns),
    stems: dedup(stems),
  };
}

function dedup(arr) {
  return Array.from(new Set(arr));
}

// Exposed for tests.
export const __internals = { stemIt, tokenize, STOPWORDS };
