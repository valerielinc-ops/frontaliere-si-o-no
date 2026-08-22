/**
 * Deterministic factuality gates for generated articles.
 *
 * Added after the 2026-07-28 incident on `frontalieri-altre-tasse-2026`
 * (run 30350429920, source ilgiorno.it/sondrio/cronaca/caso-frontalieri-altre-tasse).
 *
 * WHAT HAPPENED. The source said Ticino now taxes opt-in-Omnibus frontalieri at
 * 100% OF THE WITHHOLDING TABLES (A/B/C/H) instead of the reduced 80%, on top of
 * the Italian 25% substitute tax. The shipped article read "100%" as "100% of
 * gross salary" and published, in four locales:
 *
 *   - "0,45 x 60.000 = 27.000" presented as "4,5%"     → factor-of-10 error
 *   - income 60.000 CHF → tax 60.000 CHF               → tax == gross income
 *   - the same scenario answered 28.920 / 60.000 / 6.000 in three sections
 *   - "Ufficio federale delle imposte (UFI)" — an institution that does not exist
 *   - Decreto Omnibus dated "1° gennaio 2023" AND "1° gennaio 2024"
 *   - a 25 January 2026 source published as news on 28 July 2026, in future tense
 *   - the 80% reduced rate and the Italian 25% substitute tax — the two figures
 *     that make "100%" legible — dropped entirely
 *
 * WHY THE EXISTING GATE MISSED IT. Verification was delegated entirely to
 * llmFactCheck() — a probabilistic judge that (a) fails open when its models are
 * down, (b) only ever saw the first 8000 chars of the article, and (c) was
 * explicitly instructed to prefer false positives. Because its issues are fed
 * back as rewrite instructions, those false positives pushed the writer AWAY
 * from the source on every retry until the surviving draft no longer discussed
 * the source at all.
 *
 * Every failure listed above is decidable without an LLM: arithmetic is
 * arithmetic, a tax cannot equal gross pay, unbalanced `**` is unbalanced, and
 * a date difference is a subtraction. This module does exactly that — no model
 * calls, no network, fully deterministic, so it cannot fail open.
 *
 * Checks never throw on malformed input; they return issue objects. Callers
 * decide what blocks (see runFactualityGates → `blocking`).
 *
 * LOCALES. Generation happens in Italian and en/de/fr are translations of it,
 * so these gates were Italian-only — which left the TRANSLATION step ungated,
 * and that is where "frontalieri" shipped as "border guards" in 7 English
 * titles. Sections 2, 3 and 4 now take a `locale` and read their vocabulary
 * from article-locale-lexicon.mjs, whose Italian entries are this file's own
 * literals moved unchanged; sections 9 and 10 compare a translation against
 * the Italian it derives from. Everything else stays Italian-only on purpose —
 * see the comment on runFactualityGates.
 */

import { tokenizeIt, containmentSim } from './it-text-similarity.mjs';
import {
  LOCALE_LEXICON,
  lexiconFor,
  canonicalNumeric,
  NUMBER_TOKEN,
  extractNumericFacts,
  FALSE_FRIEND_PATTERNS,
  ITALIAN_BORDER_GUARD_ANCHOR,
} from './article-locale-lexicon.mjs';

/** Severity ranking used to sort and to decide what blocks publication. */
export const SEVERITY = { critical: 3, major: 2, minor: 1 };

/**
 * Formats a number in Italian convention (1.234,5).
 *
 * Not toLocaleString('it-IT'): Node builds with a reduced ICU fall back to the
 * C locale and silently emit "2700" where the article needs "2.700" — and
 * these strings go into remediation text the writer copies from.
 */
export function formatItalianNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  const [int, dec] = Math.abs(value).toString().split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = value < 0 ? '-' : '';
  return dec ? `${sign}${grouped},${dec}` : `${sign}${grouped}`;
}

/**
 * Parses a number written in Italian convention.
 *   "60.000"   → 60000     (dot = thousands separator)
 *   "0,45"     → 0.45      (comma = decimal separator)
 *   "1.234,56" → 1234.56
 *   "0.45"     → 0.45      (dot NOT followed by exactly 3 digits = decimal)
 * Returns NaN when the token is not a number.
 */
export function parseItalianNumber(raw) {
  if (typeof raw !== 'string') return NaN;
  const token = raw.trim().replace(/\s/g, '');
  if (!token || !/^\d[\d.,]*$/.test(token)) return NaN;

  const [intPartRaw, ...decParts] = token.split(',');
  // More than one comma is not a number we understand.
  if (decParts.length > 1) return NaN;

  // Dots are thousands separators only when every group after the first is
  // exactly 3 digits ("1.234.567"). Otherwise treat the dot as decimal ("0.45").
  let intPart = intPartRaw;
  if (intPart.includes('.')) {
    const groups = intPart.split('.');
    const isThousands = groups.length > 1 && groups.slice(1).every((g) => /^\d{3}$/.test(g));
    if (isThousands) {
      intPart = groups.join('');
    } else if (decParts.length === 0 && groups.length === 2) {
      // "0.45" — dot acts as the decimal separator.
      return Number(`${groups[0]}.${groups[1]}`);
    } else {
      return NaN;
    }
  }

  const decPart = decParts[0];
  const normalized = decPart === undefined ? intPart : `${intPart}.${decPart}`;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : NaN;
}

/**
 * @param {string} code      stable identifier for the defect class
 * @param {string} severity  critical | major | minor
 * @param {string} message   what is wrong (diagnosis)
 * @param {string} evidence  the offending text
 * @param {string} fix       what to DO about it (remediation)
 *
 * `fix` is not decoration. Gate issues are reinjected into the regeneration
 * prompt, and a diagnosis alone ("percentage and factor are inconsistent")
 * leaves the writer to guess which of the two numbers to change — it often
 * guessed wrong, or deleted the whole passage. Every fix below therefore
 * carries the concrete corrected values, computed here where they are known.
 */
function issue(code, severity, message, evidence, fix = '') {
  return { code, severity, message, evidence: (evidence || '').slice(0, 200), fix };
}

// ─── 1. Truncated / cut-off text ──────────────────────────────────────
//
// Not a defect of the incident article — but the retro-audit over the 3564
// published bodies found 35 paragraphs with an unclosed parenthesis and 5 with
// an unclosed bold marker, i.e. text a model stopped emitting mid-clause. The
// generation pipeline has fought free-tier truncation before (see the cap
// comments in create-article.mjs), so the class is worth a cheap standing check.

// Typographic closing quotes count as sentence ends exactly like the ASCII `"`
// already listed. Italian sources quote with `”` and `›`, and the corpus triage
// (2026-07-29) found three articles flagged purely for closing a quotation
// properly ("…che ne certificano l'ubicazione.”").
// U+2019 `’` is deliberately NOT here: Italian uses it as an apostrophe
// ("un po’", "l’ufficio"), so accepting it would rescue genuine cut-offs.
const SENTENCE_END = /[.!?:;»›"”')\]}…]$/;

// A footnote reference sits AFTER the full stop it annotates ("…in seguito. 6").
// Whitespace before the digits is required: without it "…il tetto sale a 60.000"
// would lose its "000" and pass on the "60." left behind.
const TRAILING_FOOTNOTE_REF = /\s+\[?\^?\d{1,3}\]?$/;

/**
 * Detects text that was cut off mid-generation.
 * @param {string} text
 * @param {{label?: string}} [opts]
 */
// ─── Leaked prompt scaffolding ────────────────────────────────────────
//
// The generation and translation prompts carry section markers and rule blocks
// ("TITOLO ARTICOLO:", "TERMINOLOGIE DEUTSCH OBBLIGATORISCH", "Verwenden Sie
// ZERO Fettschrift", "MAI \"G-Führerschein\"") that the model sometimes copies
// into its own output instead of obeying. The result ships as prose: one German
// article published the entire translator rulebook, terminology bans included.
//
// Found 2026-07-29 while clearing the corpus: 41 bodies carried `TITOLO
// ARTICOLO`, plus a handful with the translation rule block. It is invisible to
// every other gate — the text is well-formed, the arithmetic is fine, the
// institutions are real. It is simply not an article.
//
// Detection is exact-token, not heuristic: these are strings the prompts
// literally contain, so a match is the prompt leaking, never prose that happens
// to resemble it. Anchored to line starts and all-caps forms to keep an article
// that legitimately discusses "la terminologia" from tripping it.
const SCAFFOLDING_MARKERS = [
  { re: /^\s*#{0,4}\s*TITOLO ARTICOLO\s*:?/m, what: 'marcatore di sezione del prompt di generazione' },
  { re: /^\s*#{0,4}\s*(?:ESEMPIO|ESEMPI) CONCRET[OI]\s*:?\s*$/m, what: 'marcatore di sezione del prompt' },
  { re: /^\s*#{0,4}\s*(?:NOTE|NOTA) PER (?:IL|LA) (?:MODELLO|TRADUZIONE)\s*:?/mi, what: 'nota interna del prompt' },
  // Case-SENSITIVE and line-anchored on purpose. The prompt shouts its headings
  // ("TERMINOLOGIE DEUTSCH OBBLIGATORISCH:"); ordinary prose does not. A
  // case-insensitive version flagged the sentence "La terminologia usata negli
  // accordi bilaterali è obbligatoria per i Comuni di confine" — caught by the
  // negative test before it could block a correct article.
  { re: /^\s*TERMINOLOGI[AE]\b[^\n]{0,40}\b(?:OBBLIGATORI\w*|OBLIGATORISCH|MANDATORY)\s*:/m, what: 'blocco di regole terminologiche del prompt di traduzione' },
  { re: /\bVerwenden Sie ZERO\b|\bUsa ZERO\b|\bUse ZERO\b/, what: 'istruzione di formattazione del prompt' },
  { re: /\bMAI\s+"[^"]{2,40}"/, what: 'divieto terminologico del prompt di traduzione' },
];

/**
 * Flags prompt scaffolding that reached the published body.
 *
 * @param {string} text
 * @param {{label?: string}} [opts]
 */
export function detectLeakedScaffolding(text, opts = {}) {
  const issues = [];
  if (typeof text !== 'string' || !text.trim()) return issues;
  const label = opts.label ? `[${opts.label}] ` : '';

  for (const { re, what } of SCAFFOLDING_MARKERS) {
    const m = text.match(re);
    if (!m) continue;
    const at = text.indexOf(m[0]);
    issues.push(issue(
      'leaked-prompt-scaffolding',
      'critical',
      `${label}Istruzioni del prompt finite nel testo pubblicato: ${what}`,
      text.slice(Math.max(0, at - 40), at + 160).trim(),
      `Rimuovi il blocco: è un'istruzione rivolta al modello, non contenuto per il lettore. `
      + `Cancella dal marcatore fino alla fine del blocco di regole, e verifica che il testo attorno `
      + `resti una frase compiuta. Non riscrivere l'istruzione in prosa: non deve esserci affatto.`,
    ));
  }

  return issues;
}

export function detectTruncation(text, opts = {}) {
  const issues = [];
  if (typeof text !== 'string' || !text.trim()) return issues;
  const label = opts.label ? `[${opts.label}] ` : '';

  // (a) Unbalanced parentheses / bold, checked PER PARAGRAPH.
  //
  // Document-level counting is not enough: the shipped body1 cut off at
  // "(0,45 x 60.000 = 27.000 operative**" yet balanced out overall because a
  // later paragraph carried the matching "(" and "**". A clause must close
  // inside the paragraph that opened it.
  const paragraphs = text.split(/\n{2,}/);
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const opens = (para.match(/\(/g) || []).length;
    const closes = (para.match(/\)/g) || []).length;
    if (opens !== closes) {
      issues.push(issue(
        'unbalanced-parentheses',
        opens > closes ? 'critical' : 'major',
        `${label}Parentesi non bilanciate nel paragrafo (${opens} aperte, ${closes} chiuse) — testo troncato`,
        para.trim().slice(-140),
        opens > closes
          ? `Chiudi la parentesi rimasta aperta in ${label || 'questo paragrafo'} completando la frase interrotta, oppure rimuovi la parentesi di apertura se la precisazione non serve.`
          : `Rimuovi la parentesi di chiusura in eccesso in ${label || 'questo paragrafo'}.`,
      ));
    }
    const paraBold = (para.match(/\*\*/g) || []).length;
    if (paraBold % 2 !== 0) {
      issues.push(issue(
        'truncated-bold',
        'critical',
        `${label}Marker bold "**" non chiuso nel paragrafo — testo troncato`,
        para.trim().slice(-140),
        'Chiudi il grassetto aggiungendo il "**" mancante alla fine del testo che deve risultare in grassetto, oppure rimuovi il "**" orfano.',
      ));
    }
  }

  // (b) The text should end on a sentence boundary. Several endings are
  // legitimate and must not be flagged (they produced 117 false positives on
  // the first corpus pass): tables, lists, headings, "Fonte: …" attribution
  // lines, footnote entries and markers, a typographic closing quote, and a
  // trailing emoji after real punctuation.
  //
  // The exemptions stop there on purpose. The 2026-07-29 triage read all 47
  // corpus hits: 41 were real defects (24 sentences cut mid-word, 17 bodies
  // ending on leaked scaffolding — "TITOLO ARTICOLO:", a source footer, a slug
  // list). Only 6 were noise, and all 6 fall in the classes handled here. In
  // particular the `looksLikeHeading` cut-off stays at 60 chars: the leaked
  // "TITOLO ARTICOLO:" tails run 61-80 chars and must keep failing.
  const trimmed = text.trimEnd();
  const lastLine = trimmed.split('\n').filter((l) => l.trim()).pop() || '';
  const isStructural = /^\s*([|#\-*>]|\d+\.)/.test(lastLine);
  // A "📊 *Fonte: …*"-style footer routinely opens on an emoji before the
  // asterisk ("📊 *Dati: AFC/ESTV, …*", frontaliere-pensione-complementare-
  // terzo-pilastro), which the `^` anchor below cannot see past — strip it
  // first. "Dati"/"Data"/"Daten"/"Données" are this same footer's word for
  // "Fonte"/"Source"/"Quelle" in the article's own locale (translations of
  // one generated body, not independent prose), so they carry the same
  // reference-apparatus meaning and must be exempted identically.
  //
  // "Dati"/"Data" are common Italian/German words, so a bare `parola:` prefix
  // is not enough to identify the footer — "Data: 15 marzo 2024, il Consiglio
  // federale ha approvato…" is leaked-scaffolding prose, not a source line,
  // and must still be flagged. The footer is always wrapped in a single
  // italic span end to end ("*Dati: AFC/ESTV, …*"), so require both the
  // opening AND closing asterisk to anchor on that shape specifically.
  const attributionLine = lastLine.replace(/^\s*[\p{Extended_Pictographic}️]+\s*/u, '');
  const isAttribution = /^\*\s*(fonte|source|quelle|dati|data|daten|données)\s*:.*\*\s*$/i.test(attributionLine);
  // A markdown footnote entry closes on the back-reference glyph "↩" and carries
  // no sentence punctuation of its own. Same call as `isAttribution`: the line is
  // reference apparatus, not prose, so its ending says nothing about truncation.
  const isFootnote = /↩\s*$/.test(lastLine);
  // Strip trailing emoji / footnote glyphs before judging the punctuation.
  let withoutTrailingGlyphs = trimmed
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍↩*_\s]+$/gu, '');
  // Drop a trailing footnote reference ONLY when the text still ends on a
  // sentence boundary once it is gone. A genuine cut-off that happens to end in
  // a digit is therefore never rescued — it simply fails the check below.
  const withoutFootnoteRef = withoutTrailingGlyphs.replace(TRAILING_FOOTNOTE_REF, '');
  if (withoutFootnoteRef !== withoutTrailingGlyphs && SENTENCE_END.test(withoutFootnoteRef)) {
    withoutTrailingGlyphs = withoutFootnoteRef;
  }
  const endsCleanly = SENTENCE_END.test(withoutTrailingGlyphs);
  // A short tail is usually a heading, not a cut-off sentence.
  const looksLikeHeading = lastLine.trim().length < 60 && !/[,;]$/.test(lastLine.trim());

  if (!isStructural && !isAttribution && !isFootnote && !endsCleanly && !looksLikeHeading) {
    issues.push(issue(
      'incomplete-ending',
      'major',
      `${label}Il testo non termina con punteggiatura di fine frase — possibile troncamento`,
      lastLine.slice(-100),
      `Completa la frase finale di ${label || 'questa sezione'} e chiudila con un punto. Non lasciare il periodo sospeso.`,
    ));
  }

  return issues;
}

// ─── 2. Inline arithmetic ─────────────────────────────────────────────
//
// The shipped text wrote: "imposta del 4,5% (0,45 x 60.000 = 27.000)".
// The multiplication itself is right; the FACTOR contradicts the percentage by
// exactly 10×. Both halves are checked separately so a correct line like
// "3,2% (0,032 x 60.000 = 1.920)" stays clean.

const REL_TOLERANCE = 0.005;

/**
 * Reads an amount the way its own locale writes it.
 *
 * Italian keeps parseItalianNumber untouched, deliberately: it is the parser
 * every shipped Italian verdict was computed with, and the corpus audit has to
 * stay bit-for-bit comparable across the locale change. The other three go
 * through the shape-reading canonicaliser, which additionally copes with
 * 60'000 and 60 000 — forms Italian prose never uses.
 */
function parseAmount(raw, locale) {
  return locale === 'it' ? parseItalianNumber(raw) : canonicalNumeric(raw);
}

/**
 * Regex source for one number token, in the conventions `locale` may use.
 * The Italian branch is the original literal: widening it would change which
 * Italian expressions the arithmetic gate sees.
 */
function numberTokenFor(locale) {
  return locale === 'it' ? String.raw`\d[\d.,]*` : `(?:${NUMBER_TOKEN})`;
}

/** "A x B = C", written in whatever number convention `locale` uses. */
function arithmeticRe(locale) {
  const n = numberTokenFor(locale);
  return new RegExp(String.raw`(${n})\s*[x×*]\s*(${n})\s*=\s*(${n})`, 'gi');
}

/**
 * "…4,5%" / "…4,5 per cento" immediately before an expression.
 *
 * The Italian branch stays alone with its two original spellings: folding the
 * other locales' words into it would make "percentuale" match `percent` and
 * silently move an Italian verdict this change is required not to move.
 */
const SPELT_PERCENT = {
  it: String.raw`%|per\s*cento`,
  en: String.raw`%|per\s*cent\b|percent\b`,
  de: String.raw`%|Prozent\b`,
  fr: String.raw`%|pour\s*cent\b`,
};
function percentRe(locale) {
  const spelt = SPELT_PERCENT[locale] || SPELT_PERCENT.it;
  return new RegExp(String.raw`(${numberTokenFor(locale)})\s*(?:${spelt})`, 'gi');
}

function relDiff(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale;
}

/**
 * Verifies every explicit "A x B = C" and its surrounding percentage claim.
 * @param {string} text
 * @param {{locale?: string}} [opts]
 */
export function checkInlineArithmetic(text, opts = {}) {
  const issues = [];
  if (typeof text !== 'string') return issues;
  const locale = opts.locale || 'it';

  for (const m of text.matchAll(arithmeticRe(locale))) {
    const [full, aRaw, bRaw, cRaw] = m;
    const a = parseAmount(aRaw, locale);
    const b = parseAmount(bRaw, locale);
    const c = parseAmount(cRaw, locale);
    if (![a, b, c].every(Number.isFinite)) continue;

    // (a) Does the stated product actually hold?
    if (relDiff(a * b, c) > REL_TOLERANCE) {
      issues.push(issue(
        'arithmetic-error',
        'critical',
        `Calcolo errato: ${aRaw} × ${bRaw} = ${formatItalianNumber(a * b)}, non ${cRaw}`,
        full,
        `Sostituisci "${full}" con "${aRaw} × ${bRaw} = ${formatItalianNumber(a * b)}". `
        + `Poi aggiorna ogni totale o confronto che usava il valore errato ${cRaw}.`,
      ));
    }

    // (b) When a percentage introduces the expression, one of the two operands
    // must be that percentage as a decimal. "4,5% (0,45 x ...)" is off by 10×.
    //
    // Either operand: multiplication is commutative and articles write it both
    // ways. Assuming the factor was always the LEFT one blocked
    // `stipendio-saldatore-frontaliere-ticino`, which states "del 20% … 80.000 x
    // 0,20 = 16.000" — arithmetically perfect, reported as "400000× il valore
    // corretto" because 80.000 was compared against 0,2.
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const pctMatch = [...before.matchAll(percentRe(locale))].pop();
    if (pctMatch) {
      const pct = parseAmount(pctMatch[1], locale);
      const asDecimal = pct / 100;
      const stated = Number.isFinite(pct) && pct !== 0
        && relDiff(a, asDecimal) > REL_TOLERANCE
        && relDiff(b, asDecimal) > REL_TOLERANCE;
      if (stated) {
        // Neither operand is the rate. The one meant to be it is the smaller:
        // a rate is a fraction, the other side is a salary.
        const factorIsA = Math.abs(a) <= Math.abs(b);
        const factor = factorIsA ? a : b;
        const factorRaw = factorIsA ? aRaw : bRaw;
        const base = factorIsA ? b : a;
        const ratio = factor / asDecimal;
        issues.push(issue(
          'percent-factor-mismatch',
          'critical',
          `Percentuale e fattore incoerenti: dichiarato ${pctMatch[1]}% ma moltiplicato per ${factorRaw} `
          + `(${Number.isFinite(ratio) ? `${ratio.toFixed(0)}× il valore corretto ${asDecimal.toString().replace('.', ',')}` : 'valore incoerente'})`,
          `${pctMatch[0]} ... ${full}`,
          `Decidi quale dei due numeri è giusto e allinea l'altro. `
          + `Se la percentuale corretta è ${pctMatch[1]}%, il fattore deve essere `
          + `${asDecimal.toString().replace('.', ',')} e il risultato ${formatItalianNumber(asDecimal * base)}. `
          + `Se invece il risultato ${cRaw} è quello giusto, la percentuale da dichiarare è `
          + `${(factor * 100).toString().replace('.', ',')}%. Non lasciare i due valori incoerenti e non cancellare l'esempio.`,
        ));
      }
    }
  }

  return issues;
}

// ─── 3. Tax plausibility ──────────────────────────────────────────────
//
// The article's core error — reading "100% of the withholding TABLES" as "100%
// of gross salary" — always surfaces as a tax that swallows the whole income.
// A tax equal to or above gross pay is arithmetically impossible.
//
// PRECISION PASS (2026-07-29). The first cut paired amounts per LINE and
// reported 59 blocking findings over 48 articles; sampling them by hand showed
// most were correct prose. A crying-wolf gate is not a harmless nuisance here:
// its issues are fed straight back into the regeneration prompt, and the
// writer's cheapest reply to an "impossible tax" it cannot see is to delete the
// example — the exact failure mode these gates exist to stop. Four causes, one
// named constant each:
//
//   (a) a "line" is not a statement. Bulleted scenarios ("- Scenario 1: … -
//       Scenario 4: …") share one line, so the 4.000 CHF monthly salary of the
//       first was paired with the 6.000 CHF salary of the fourth
//       (`lpp-minimo-secondo-pilastro-2026`) → LIST_MARKER_RE / SENTENCE_BREAK_RE
//       now cut a line into the statements a reader actually sees.
//   (b) a threshold is not a sum paid. "chi ha un reddito di OLTRE 80.000
//       franchi è tenuto a pagare le tasse" repeats one bracket twice and the
//       second copy was read as a tax equal to the income — 4 of the 6 findings
//       on `tasse-frontalieri-scambio-dati-stipendi-italia` → `thresholdCue`.
//   (c) not every franc figure is a tax. Prices, season passes, deductions and
//       refunds share the paragraph → `nonTaxCue`.
//   (d) nothing bounded how far apart the two numbers could sit: the 41-franc
//       IRPEF refund of `funivia-monte-lema-stagione-2026` was matched against
//       a 290-franc ski pass eight sentences later → MAX_PAIR_DISTANCE.
//
// Segmentation alone would have cost the very defect it was built for: the
// incident article states the income in one sentence and the impossible tax in
// the next. Hence the one-statement carry-over in incomeTaxPairs().

// The seven cue sets this section runs on now live in article-locale-lexicon.mjs,
// one entry per locale, so the same pairing rules can judge a translation. The
// Italian entries there are the literals that used to sit here, moved unchanged
// — each still carrying, at its definition, the corpus false positive that
// shaped it:
//
//   currency            what counts as money at all.
//   incomeCue           whatever sits between the cue word and the amount is
//                       closer to the figure than the income word is, and wins
//                       (`divario-salari-ticino-frontalieri-2026`).
//   incomeCueTrailing   an amount can be named as income AFTER the figure
//                       (`bossi-commemorazione-bagarrata`).
//   taxCue              excludes `tasso`, the exchange RATE
//                       (`franco-forte-stipendio-frontalieri`).
//   thresholdCue        brackets, floors and caps mark where a rule starts
//                       applying, never what someone hands over.
//   nonTaxCue           prices, passes, net pay, taxable bases and after-tax
//                       residues (`funivia-monte-lema-stagione-2026`).
//   approximation       words that mark a parenthesis as restating a figure
//                       already on the page (`frontalieri-calano-ticino`).
//   periods             time base, so a monthly salary is never compared with
//                       an annual tax.

// How far apart an income and its alleged tax may sit. The real defects state
// both inside one breath — 133 chars on the incident article ("un reddito di
// 60.000 … all'anno. … ovvero 60.000 franchi svizzeri"), 173 on
// `proposta-choc-ticino-frontalieri`. Past ~250 chars the two figures belong to
// different thoughts and pairing them is a coin toss.
const MAX_PAIR_DISTANCE = 260;

// A list item starts a new, independent scenario, so nothing carries across it.
// A bare "-" counts only when it introduces a capitalised clause: otherwise
// every numeric range ("60.000 - 70.000 franchi") would be cut in half.
const LIST_MARKER_RE = /(?:^|\s)(?:[*•]|[-–—](?=\s+[A-ZÀ-Ü]))\s+/g;
// Sentence break, taken only where a new clause visibly begins. The dot inside
// "1.000" is followed by a digit and never matches. Table cell separators are
// soft breaks, not hard ones: "| reddito 60.000 | imposta 72.000 |" is one
// claim spread over two cells and must still be checkable.
const SENTENCE_BREAK_RE = /(?<=[.!?;])\s+(?=[«"'([*•A-ZÀ-Ü])|\s*\|\s*/g;

/**
 * Ranges of the text that restate a figure already on the page rather than
 * assert a new one. Two shapes, both parenthetical:
 *
 *  - a working ("24.000 CHF (30% di 80.000)"). Without this the 80.000 inside
 *    the parenthesis read as a tax equal to the 80.000 income — 96 false
 *    positives on the first corpus pass.
 *  - a currency conversion or approximation ("30.000 euro (circa 31.200 franchi
 *    svizzeri)"). Same number, other currency: `frontalieri-calano-ticino` was
 *    blocked for a "tax" 104% of an income that was in fact that same income
 *    converted to francs one word later.
 *  - a working with no percentage in it, "(80.000 CHF - 10.000 CHF)", which
 *    shows where the figure in front of it came from. The 80.000 inside read
 *    as a 114% tax on the 70.000 it derives
 *    (`terzo-pilastro-3a-vantaggi-canton-ginevra`).
 */
function restatementSpans(text, locale = 'it') {
  const spans = [];
  const { approximation } = lexiconFor(locale);
  const re = new RegExp(
    String.raw`\([^)]*%[^)]*\)`
    + String.raw`|\(\s*(?:${approximation}|≈|~)[^)]*\)`
    + String.raw`|\([^)]*\d[^)]*[-−+x×*=/][^)]*\d[^)]*\)`,
    'gi',
  );
  for (const m of text.matchAll(re)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/**
 * Time base an amount is expressed in, read from the words right after it.
 * Comparing a monthly salary against an annual tax is not a contradiction, and
 * treating it as one produced most of the residual noise ("4.000 CHF al mese"
 * vs a yearly figure). Amounts with different, known periods are never paired.
 */
function periodOf(text, afterIndex, locale = 'it') {
  const tail = text.slice(afterIndex, afterIndex + 40).toLowerCase();
  for (const [name, re] of lexiconFor(locale).periods) {
    if (re.test(tail)) return name;
  }
  return '';
}

/**
 * Extracts every "<amount> <currency>" occurrence with its position.
 *
 * The apostrophe is the Swiss thousands separator and half the corpus writes
 * salaries that way. Reading only `[\d.,]` truncated "4'500 CHF" to 500 and
 * "80'000 CHF" to zero, which invented impossible ratios out of perfectly
 * correct arithmetic — "guadagna 4'500 CHF al mese e paga 1'200 CHF di
 * imposte" came out as a 120% tax (`frontaliere-ticino-panettiere-guadagno`,
 * `quanto-guadagna-un-polimeccanico-frontaliere-in-ticino`).
 *
 * Italian keeps that hand-written token and parseItalianNumber; the other
 * locales use the shared shape-reading token, which covers the same apostrophe
 * plus the French "70 000" and the English "70,000".
 */
function extractAmounts(text, locale = 'it') {
  const { currency } = lexiconFor(locale);
  const token = locale === 'it'
    ? String.raw`\d[\d.,]*(?:['’]\d{3})*(?:[.,]\d+)?`
    : `(?:${NUMBER_TOKEN})`;
  const re = new RegExp(String.raw`(${token})\s*${currency}`, 'gi');
  const skip = restatementSpans(text, locale);
  const out = [];
  for (const m of text.matchAll(re)) {
    if (skip.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const value = locale === 'it'
      ? parseItalianNumber(m[1].replace(/['’]/g, ''))
      : canonicalNumeric(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({
      value,
      raw: m[0],
      index: m.index,
      period: periodOf(text, m.index + m[0].length, locale),
    });
  }
  return out;
}

/** True when two amounts are stated over different, known time bases. */
function periodsConflict(a, b) {
  return Boolean(a.period) && Boolean(b.period) && a.period !== b.period;
}

/**
 * Cuts a line into the statements a reader treats as separate claims, tagging
 * each with the list item ("block") it belongs to. Statements in different
 * blocks are different scenarios and never share an income.
 */
function statementSpans(line) {
  const cuts = [
    ...[...line.matchAll(LIST_MARKER_RE)].map((m) => ({ at: m.index + m[0].length, hard: true })),
    ...[...line.matchAll(SENTENCE_BREAK_RE)].map((m) => ({ at: m.index + m[0].length, hard: false })),
  ].sort((a, b) => a.at - b.at || Number(b.hard) - Number(a.hard));

  const spans = [];
  let start = 0;
  let block = 0;
  for (const cut of cuts) {
    if (cut.at > start) spans.push({ start, end: cut.at, block });
    if (cut.hard) block += 1;
    start = Math.max(start, cut.at);
  }
  spans.push({ start, end: line.length, block });
  return spans;
}

// Global twins of the two cue sets, one pair per locale. `.test()` needs the
// non-global originals (a `g` regex carries lastIndex across calls and silently
// skips); positional comparison needs matchAll, which requires `g`. Same source,
// one truth — built once per locale rather than per call, because these are
// recompiled for every candidate amount of every line of every body.
const CUE_GLOBALS = new Map();
function cueGlobals(locale) {
  const key = LOCALE_LEXICON[locale] ? locale : 'it';
  if (!CUE_GLOBALS.has(key)) {
    const { taxCue, nonTaxCue } = LOCALE_LEXICON[key];
    CUE_GLOBALS.set(key, {
      tax: new RegExp(taxCue.source, 'gi'),
      nonTax: new RegExp(nonTaxCue.source, 'gi'),
    });
  }
  return CUE_GLOBALS.get(key);
}

/**
 * The cue matches in `window`, with tax cues that fall INSIDE a non-tax phrase
 * discarded. Such a tax word belongs to that phrase and is not a cue of its
 * own: "DOPO le tasse", "credito d'IMPOSTA", "non è stata TRATTENUTA",
 * "TASSATO solo su" each name something that is not the tax.
 */
function cueMatches(window, locale) {
  const { tax: taxG, nonTax: nonTaxG } = cueGlobals(locale);
  const nonTax = [...window.matchAll(nonTaxG)];
  const tax = [...window.matchAll(taxG)]
    .filter((m) => !nonTax.some((n) => m.index >= n.index && m.index < n.index + n[0].length));
  return { tax, nonTax };
}

/**
 * What the amount at the end of `window` is being presented as, decided by the
 * cue NEAREST to it.
 *
 * The first version asked two independent questions — "is there a non-tax word
 * in the last 40 characters?" and "is there a tax word anywhere between the
 * income and here?" — and let the second win whenever both were true. That
 * asymmetry is the whole of the residual noise: a hand audit of the 15
 * surviving `tax-implausible` findings returned 13 false positives and every
 * one of them named its real, plausible tax on the same line. The check was
 * never picking the wrong article, only the wrong amount on it.
 *
 *   "pagherà circa 12.480 CHF di tasse, lasciando un NETTO di 50.920 CHF"
 *   "stipendio NETTO dopo l'applicazione dell'Imposta federale … è di 56.100 CHF"
 *
 * Both name the take-home pay, and in both the tax word is real but further
 * away. Distance decides.
 *
 * @returns {'tax'|'other'|''} '' when nothing qualifies the amount at all.
 */
function presentedAsTax(window, locale = 'it') {
  const { tax, nonTax } = cueMatches(window, locale);
  if (!tax.length) return nonTax.length ? 'other' : '';
  const lastTax = tax[tax.length - 1].index;
  const lastOther = nonTax.length ? nonTax[nonTax.length - 1].index : -1;
  return lastTax > lastOther ? 'tax' : 'other';
}

/**
 * How far past the currency a postposed qualifier is still read as belonging to
 * the amount. Long enough for "3.600 Franken netto" and "3 600 francs net",
 * short enough not to reach into the next clause.
 */
const TRAILING_QUALIFIER_CHARS = 18;

/**
 * The same verdict read FORWARD, for languages that put the qualifier after the
 * figure: Italian writes "un netto di 3.600 franchi", German "3.600 Franken
 * netto" and French "3 600 francs net". Reading backwards only, the veto fired
 * on the Italian and missed both translations, and net pay was reported as a
 * 300% tax (`divario-salari-ticino-frontalieri-2026`).
 *
 * Only the veto direction is implemented. A trailing TAX word is not taken as
 * promoting an amount to a tax, because backwards is where the evidence for
 * that already comes from and widening it would move Italian verdicts — which
 * this whole change is required not to do.
 *
 * @returns {boolean} true when a non-tax word owns the amount.
 */
function trailingCueVetoes(window, locale = 'it') {
  const { tax, nonTax } = cueMatches(window, locale);
  if (!nonTax.length) return false;
  // Nearest wins, and forward nearest means the LOWEST index.
  return !(tax.length && tax[0].index < nonTax[0].index);
}

/** True when the amount is named as an income, by a cue before or right after it. */
function namesAnIncome(line, span, amt, locale = 'it') {
  const { incomeCue, incomeCueTrailing, taxCue } = lexiconFor(locale);
  const cue = line.slice(span.start, amt.index).match(incomeCue);
  // A tax word in the gap sits closer to the figure than the income word does,
  // so the figure is the tax — see the incomeCue note in the lexicon.
  if (cue && !taxCue.test(cue[2])) return true;
  const after = amt.index + amt.raw.length;
  return incomeCueTrailing.test(line.slice(after, after + 30));
}

/**
 * Every (income, amount-presented-as-its-tax) pair a single line asserts.
 *
 * Shared by the plausibility gate and the cross-section conflict gate. The two
 * carried copy-pasted pairing code, so a precision fix applied to one left the
 * other flagging the same false positive — the duplication is the bug.
 */
function* incomeTaxPairs(line, locale = 'it') {
  const { thresholdCue } = lexiconFor(locale);
  const amounts = extractAmounts(line, locale);
  if (amounts.length < 2) return;

  // An income reaches the NEXT statement and no further: the incident article
  // splits the claim over two sentences ("… un reddito di 60.000 franchi
  // svizzeri all'anno." / "Se optasse …, ovvero 60.000 franchi svizzeri"), while
  // anything beyond one hop reintroduces the cross-scenario noise. A statement
  // that names its own income never inherits — that is what clears
  // `lpp-minimo-secondo-pilastro-2026`, where "se il suo stipendio aumenta a
  // 7.000 CHF" is a new base, not a tax on the 6.000 CHF of the sentence before.
  let carried = null;

  for (const span of statementSpans(line)) {
    const local = amounts.filter((a) => a.index >= span.start && a.index < span.end);
    const own = local.find((a) => namesAnIncome(line, span, a, locale));
    const income = own || (carried && carried.block === span.block ? carried.amount : null);
    carried = own ? { amount: own, block: span.block } : null;
    if (!income) continue;

    for (const amt of local) {
      if (amt === income) continue;
      // A second income is a second scenario, never the first one's tax. One
      // sentence routinely carries both: "un paziente con un reddito di 50.000
      // franchi pagherà il 10%, mentre un paziente con un reddito di 100.000
      // franchi pagherà il 20%" was read as a 200% tax rate
      // (`costi-cure-domocilio-ticino-2026`).
      if (namesAnIncome(line, span, amt, locale)) continue;
      if (periodsConflict(income, amt)) continue;
      if (Math.abs(amt.index - income.index) > MAX_PAIR_DISTANCE) continue;

      // An income tax is never quoted per hour. Reading a wage as one paired
      // the 21 franchi/hour a company pays with the 21,50 floor it will have to
      // meet (`salario-minimo-ticino-2027-2029`).
      if (amt.period === 'hour') continue;

      const near = line.slice(Math.max(span.start, amt.index - 40), amt.index);
      if (thresholdCue.test(near)) continue;

      // A qualifier sitting right AFTER the currency owns the amount, whatever
      // the run-up says: see trailingCueVetoes.
      const afterAmt = amt.index + amt.raw.length;
      const trailing = line.slice(afterAmt, afterAmt + TRAILING_QUALIFIER_CHARS);
      if (trailingCueVetoes(trailing, locale)) continue;

      // The window in which the candidate has to be introduced as a tax: from
      // the income forward, or the run-up to the candidate when it precedes the
      // income. The cue may not sit upstream of the income — a tax word
      // belonging to the income's own clause used to qualify the alternative
      // that followed it ("pagare le imposte solo sul reddito residuo di 70.000
      // CHF (…) o 72.500 CHF", `terzo-pilastro-3a-vantaggi-canton-ginevra`).
      const from = amt.index >= income.index
        ? Math.max(span.start, income.index)
        : Math.max(span.start, amt.index - 80);
      if (presentedAsTax(line.slice(from, amt.index), locale) !== 'tax') continue;

      yield { income, tax: amt };
    }
  }
}

/**
 * Flags a stated tax that meets or exceeds the gross income it is computed on.
 * @param {string} text
 * @param {{implausibleRatio?: number, locale?: string}} [opts] ratio above which a tax is "major"
 */
export function checkTaxPlausibility(text, opts = {}) {
  const issues = [];
  if (typeof text !== 'string') return issues;
  const implausibleRatio = opts.implausibleRatio ?? 0.6;
  const locale = opts.locale || 'it';
  // One report per (income, tax) pair — the same example restated across
  // paragraphs otherwise emitted the identical issue a dozen times.
  const reported = new Set();

  for (const line of text.split('\n')) {
    for (const { income, tax } of incomeTaxPairs(line, locale)) {
      const dedupKey = `${income.value}|${tax.value}`;
      if (reported.has(dedupKey)) continue;
      reported.add(dedupKey);

      const ratio = tax.value / income.value;
      if (ratio >= 1) {
        issues.push(issue(
          'tax-exceeds-income',
          'critical',
          `Imposta ${tax.raw} pari o superiore al reddito lordo ${income.raw} (${Math.round(ratio * 100)}%) — impossibile`,
          line.trim(),
          `Un'imposta non può essere pari o superiore al reddito lordo. Errore tipico: leggere "aliquota al 100%" `
          + `come "il 100% dello stipendio". Il 100% si riferisce all'ALIQUOTA PIENA della tabella d'imposta, non al reddito. `
          + `Correggi indicando l'importo effettivo dell'imposta (per un frontaliere in Ticino, tipicamente il 5-15% del lordo, `
          + `quindi nell'ordine di ${formatItalianNumber(Math.round(income.value * 0.1))} su ${income.raw}) `
          + `oppure esprimi il passaggio in punti di aliquota invece che in franchi.`,
        ));
      } else if (ratio > implausibleRatio) {
        issues.push(issue(
          'tax-implausible',
          'major',
          `Imposta ${tax.raw} = ${Math.round(ratio * 100)}% del reddito ${income.raw} — implausibile per un frontaliere`,
          line.trim(),
          `Verifica l'aliquota: l'imposta alla fonte per un frontaliere in Ticino sta tipicamente tra il 5% e il 15% del lordo. `
          + `Se ${tax.raw} include anche contributi o imposte italiane, dichiaralo esplicitamente e scomponi le voci; `
          + `altrimenti correggi l'importo.`,
        ));
      }
    }
  }

  return issues;
}

// ─── 4. Cross-section numeric conflicts ───────────────────────────────
//
// The shipped article answered the SAME scenario (60.000 CHF, opting in) with
// 28.920 in body1, 60.000 in body2 and "+6.000" in body3. Comparison is
// restricted to DIFFERENT sections so a legitimate two-column table
// ("current | projected") in one section never trips the gate.

/**
 * @param {Record<string,string>} sections e.g. { body1, body2, body3 }
 * @param {{conflictRatio?: number}} [opts]
 */
export function checkCrossSectionNumericConflicts(sections, opts = {}) {
  const issues = [];
  if (!sections || typeof sections !== 'object') return issues;
  const conflictRatio = opts.conflictRatio ?? 3;
  const locale = opts.locale || 'it';

  // base income value → [{ section, tax }]
  const byIncome = new Map();

  for (const [section, text] of Object.entries(sections)) {
    if (typeof text !== 'string') continue;
    for (const line of text.split('\n')) {
      // Same pairing rules as the plausibility gate, deliberately: this gate
      // used to re-derive them and drifted, so a false pair fixed there kept
      // firing here on the same sentence.
      for (const { income, tax } of incomeTaxPairs(line, locale)) {
        const key = income.value;
        if (!byIncome.has(key)) byIncome.set(key, []);
        byIncome.get(key).push({ section, tax: tax.value, raw: tax.raw, line: line.trim() });
      }
    }
  }

  for (const [income, entries] of byIncome) {
    const sectionsSeen = new Set(entries.map((e) => e.section));
    if (sectionsSeen.size < 2) continue; // same section → could be a legit table

    const min = entries.reduce((a, b) => (a.tax <= b.tax ? a : b));
    const max = entries.reduce((a, b) => (a.tax >= b.tax ? a : b));
    if (min.section === max.section) continue;
    if (min.tax > 0 && max.tax / min.tax >= conflictRatio) {
      issues.push(issue(
        'contradictory-figures',
        'critical',
        `Stesso scenario (reddito ${formatItalianNumber(income)}) con esiti incompatibili: `
        + `${min.raw} in ${min.section} vs ${max.raw} in ${max.section} (${(max.tax / min.tax).toFixed(1)}× di scarto)`,
        `${min.line} ⟷ ${max.line}`,
        `Scegli UN solo valore corretto per lo scenario "reddito ${formatItalianNumber(income)}" e usalo identico in `
        + `${min.section} e ${max.section}. Se le due cifre rispondono a domande diverse (imposta totale vs solo aumento, `
        + `prima vs dopo), esplicita la differenza nel testo — non lasciare due risposte alla stessa domanda.`,
      ));
    }
  }

  return issues;
}

// ─── 5. Fabricated institutions ───────────────────────────────────────
//
// "Ufficio federale delle imposte (UFI)" does not exist — the federal body is
// the AFC/ESTV, and the source actually cited the CANTONAL ufficio imposte alla
// fonte. Only acronyms introduced in parentheses after an institution noun are
// checked: high signal, and a name alone is too noisy to gate on.

// An allowlist can never be complete, and treating "unknown" as "invented"
// produced 560 false positives across the corpus on the first pass — USTRA,
// EOC, DECS, URC, DEFR, DFI, DFGP, UFAM, UFT, UFE, IPI, OFS are all real. So
// the gate is split in two: a denylist of acronyms observed being hallucinated
// (blocking), and the allowlist below (silences the known-real). Anything in
// neither is reported as `major` — surfaced for a human, never auto-blocking.
export const KNOWN_INSTITUTION_ACRONYMS = new Set([
  // Swiss federal — administration
  'AFC', 'ESTV', 'UST', 'BFS', 'OFS', 'SECO', 'UFSP', 'BAG', 'UFAS', 'BSV', 'SEM', 'UDSC', 'BAZG',
  'USTRA', 'ASTRA', 'UFT', 'BAV', 'UFAM', 'BAFU', 'UFE', 'BFE', 'UFAG', 'BLW', 'UFC', 'BAK',
  'UFCOM', 'BAKOM', 'UFSC', 'UFAB', 'UFPP', 'BABS', 'UFG', 'BJ', 'UFM', 'IPI', 'METAS', 'SEFRI',
  'UFU', 'ARE', 'UFRI', 'SER', 'USTI', 'UFS', 'UFF', 'UFD', 'UFAE', 'UJP', 'UIDP', 'UDI', 'OSF',
  // Swiss federal — departments
  'DFI', 'DFGP', 'DFF', 'DFAE', 'DDPS', 'DATEC', 'DEFR', 'DFE', 'EDI', 'EJPD', 'EFD', 'EDA',
  // Swiss institutions / oversight
  'FINMA', 'BNS', 'SNB', 'COMCO', 'WEKO', 'IFD', 'SUVA', 'CDF', 'EFK', 'PFPDT', 'IFPDT',
  'ETHZ', 'EPFL', 'PSI', 'EMPA', 'WSL', 'AGROSCOPE', 'IUFFP', 'SUPSI', 'USI', 'SUP', 'SUFFP',
  // Swiss social insurance / schemes
  'AVS', 'AHV', 'AI', 'IV', 'LPP', 'BVG', 'LAMal', 'KVG', 'LAINF', 'UVG', 'AD', 'ALV', 'CMI',
  'LADI', 'AVIG', 'APG', 'EO', 'PC', 'EL',
  // Ticino cantonal
  'DECS', 'DSS', 'DT', 'DI', 'DFE', 'EOC', 'ORL', 'CSI', 'URC', 'USTAT', 'SPAAS', 'IOSI',
  'IRB', 'CRS', 'ATT', 'ETL', 'OTR', 'ACR',
  // Italian
  'INPS', 'INAIL', 'MEF', 'ADE', 'AE', 'ISTAT', 'IRPEF', 'IVA', 'IMU', 'ASL', 'ATS', 'ARPA',
  'CGIL', 'CISL', 'UIL', 'UGL', 'ANPAL', 'MIUR', 'MIT',
  // Unions / associations
  'OCST', 'UNIA', 'SYNA', 'VPOD', 'SYNDICOM', 'AITI', 'CC-TI', 'USS', 'SSIC', 'ASTAG',
  // EU / international
  'UE', 'EU', 'SEE', 'EEA', 'OCSE', 'OECD', 'AELS', 'EFTA', 'ONU', 'OIL', 'ILO', 'OMS', 'WHO',
  'FMI', 'IMF', 'BCE', 'ECB', 'NATO', 'CEDU', 'CGUE',

  // ── Added by the 2026-07-29 corpus triage ──
  // 175 `unknown-institution` warnings over 156 distinct acronyms, each one
  // checked against the body's own site before being listed here. Swiss federal
  // offices publish under three or four acronyms (IT / FR / DE / EN) and the
  // generator quotes whichever the source used, so the language variants of an
  // office already listed above still have to be enumerated.

  // Swiss federal — Italian, French and English acronyms of listed offices
  'SFI',      // Segreteria di Stato per le questioni finanziarie internazionali — sif.admin.ch
  'AFD',      // Amministrazione federale delle dogane — pre-2022 name of UDSC/BAZG
  'FSO',      // Federal Statistical Office — English acronym of UST/BFS/OFS
  'UFAC',     // Ufficio federale dell'aviazione civile — bazl.admin.ch/it
  'UFSPO',    // Ufficio federale dello sport — baspo.admin.ch/it
  'FOSPO',    // Federal Office for Sport — English acronym of UFSPO/BASPO
  'FSVO',     // Federal Food Safety and Veterinary Office — English acronym of USAV/BLV
  'OFAS',     // Office fédéral des assurances sociales — French acronym of UFAS/BSV
  'OFT',      // Office fédéral des transports — French acronym of UFT/BAV
  'DETEC',    // French/English acronym of DATEC — uvek.admin.ch
  'FDF',      // Département fédéral des finances — French acronym of DFF/EFD — admin.ch
  'CFSL',     // Commissione federale di coordinamento per la sicurezza sul lavoro — ekas.admin.ch/it
  'CFST',     // French acronym of the same commission
  'MEBEKO',   // Commissione delle professioni mediche — bag.admin.ch/it
  // Superseded federal offices. Still correct in articles that quote an older
  // source, and the successor bodies are already listed above.
  'UFAP',     // Ufficio federale delle assicurazioni private → FINMA (2009)
  'UFFT',     // Ufficio federale della formazione professionale e della tecnologia → SEFRI (2013)
  'UFPC',     // Ufficio federale della protezione civile → UFPP (2003)

  // Swiss cantonal, consortia and academic institutes
  'IAS',      // Istituto delle assicurazioni sociali, Ticino — ti.ch/ias
  'UPAAI',    // Ufficio della protezione delle acque e dell'approvvigionamento idrico, TI
  'IFC',      // Istituto della formazione continua, Ticino — ifc.ti.ch
  'IRE',      // Istituto di ricerche economiche, USI — ire.usi.ch
  'IAST',     // Istituto per l'architettura sostenibile e la tecnologia, USI — arc.usi.ch
  'ERSL',     // Ente Regionale per lo Sviluppo del Luganese — ersl.ch
  'CMAL',     // Consorzio Manutenzione Alta Leventina — cmal.ch
  'CPC',      // Commissione paritetica cantonale — cpc-ticino.ch
  'OCIRT',    // Office cantonal de l'inspection et des relations du travail, Ginevra — ge.ch
  'DGSS',     // Dipartimento di giustizia, sicurezza e sanità, Grigioni — gr.ch
  'KOF',      // KOF Konjunkturforschungsstelle, ETH Zurigo — kof.ethz.ch
  'UPI',      // Ufficio prevenzione infortuni (bfu/upi) — bfu.ch/it

  // Italian
  'ADM',      // Agenzia delle Dogane e dei Monopoli — adm.gov.it
  'INGV',     // Istituto Nazionale di Geofisica e Vulcanologia — ingv.it
  'ISS',      // Istituto Superiore di Sanità — iss.it
  'IVASS',    // Istituto per la Vigilanza sulle Assicurazioni — ivass.it
  'AIFA',     // Agenzia Italiana del Farmaco — aifa.gov.it
  'IEO',      // Istituto Europeo di Oncologia — ieo.it
  'IGM',      // Istituto Geografico Militare — igmi.esercito.difesa.it
  'ADBPO',    // Autorità di bacino distrettuale del fiume Po — adbpo.it
  'COSFEL',   // Commissione per la stabilità finanziaria degli enti locali — Min. Interno
  'AVC',      // Autorità di vigilanza e controllo — usata testualmente negli atti VIA (mite.gov.it)
  'DDA',      // Direzione distrettuale antimafia

  // EU / international
  'EPO',      // European Patent Office — epo.org
  'ESA',      // European Space Agency — esa.int
  'EASA',     // Agenzia dell'Unione europea per la sicurezza aerea — easa.europa.eu
  'IARC',     // International Agency for Research on Cancer — iarc.who.int
  'AIE',      // Agenzia internazionale dell'energia (IEA)
  'SMPA',     // Swiss Music Promoters Association — smpa.ch
  'FIBL',     // FiBL, Istituto di ricerca dell'agricoltura biologica — fibl.org
  'NIA',      // National Immigration Administration (Cina) — en.nia.gov.cn
  // 2026-08-03. Added when extractSourceAnchors switched to judging the SOURCE
  // against this set: these appear in frontalieri tax/social-security sources
  // constantly and were absent, so they would have silently stopped being
  // required anchors. Each meets the entry criterion above — the body or scheme
  // publishes under this acronym.
  'IPG',      // Indennità di perdita di guadagno (CH) — the I of AVS/AI/IPG
  'CAF',      // Centro di assistenza fiscale (IT)
  'ISEE',     // Indicatore della situazione economica equivalente (IT)
  'TFR',      // Trattamento di fine rapporto (IT)
  'CCNL',     // Contratto collettivo nazionale di lavoro (IT)
  'AIRE',     // Anagrafe degli italiani residenti all'estero (IT)
  'ANF',      // Assegno per il nucleo familiare (IT, INPS)
]);

/**
 * Acronyms caught being invented by the generator. These block.
 * `UFI` ("Ufficio federale delle imposte") shipped in 4 articles — the federal
 * body is the AFC/ESTV, and withholding tax is administered CANTONALLY.
 *
 * ENTRY CRITERION (2026-07-29). An acronym is listed here only when BOTH hold:
 *   1. searching its own expansion returns the REAL body under a DIFFERENT
 *      acronym (or returns nothing at all), and
 *   2. no institution reachable by this site's subject matter — Swiss federal
 *      or cantonal, Italian national or regional, EU/international bodies
 *      relevant to cross-border work — publishes under that acronym.
 * Collisions with unrelated foreign or technical acronyms do not disqualify an
 * entry, because the check only fires on `<institution noun> … (ACRONYM)`.
 *
 * Anything that failed either test was left out of BOTH lists on purpose: it
 * keeps reporting as `major`, which surfaces it for a human without blocking.
 * A real body listed here would block correct articles, so "uncertain" always
 * loses to "unlisted".
 */
export const FABRICATED_INSTITUTION_ACRONYMS = new Set([
  'UFI', 'UFOL', 'UWL', 'UFIS', 'CFL', 'DEMAS', 'LCFL', 'UFLAV', 'CNFL', 'UFIF',

  // ── Added by the 2026-07-29 corpus triage ──
  // Invented federal offices. Every one of these was generated as a plausible
  // Italian expansion of a Swiss federal office that does not exist; the real
  // body (named in each comment) is already in the allowlist above.
  'UFSTR',    // "Ufficio federale delle strade" → USTRA/ASTRA
  'UFID',     // "Ufficio federale delle imposte dirette" → AFC/ESTV
  'FSD',      // same invention, different acronym → AFC/ESTV
  'UQF',      // "Ufficio federale delle questioni fiscali" → AFC/ESTV
  'UEF',      // "Ufficio federale delle Entrate" → AFC/ESTV
  'UFEF',     // "Ufficio federale delle finanze" → AFF/EFV
  'UQJ',      // "Ufficio federale delle questioni giuridiche" → UFG/BJ
  'UJF',      // same invention, letters transposed (#5661) → UFG/BJ
  'UJG',      // same invention, different acronym → UFG/BJ
  'UVMS',     // "Ufficio federale per la migrazione e il soggiorno" → SEM
  'UFIAI',    // "Ufficio federale per l'immigrazione e l'integrazione" → SEM
  'UVIA',     // same invention, different acronym → SEM
  'UFA',      // "Ufficio federale per l'assistenza sociale" → UFAS/BSV
  'UVAS',     // "Ufficio federale delle assicurazioni sociali" → UFAS/BSV
  'UAS',      // same invention, different acronym → UFAS/BSV
  'UVA',      // same invention, different acronym → UFAS/BSV
  'UAFS',     // same invention (letters transposed), same body → UFAS/BSV
  'UVSS',     // "Ufficio federale dei servizi sociali" → UFAS/BSV
  'UFP',      // "Ufficio federale delle pensioni" → UFAS/BSV
  'USVP',     // "Ufficio federale per la sanità pubblica" → UFSP/BAG
  'UFSK',     // "Ufficio federale per l'istruzione e la cultura" → UFC/BAK
  'UFEFP',    // "Ufficio federale dell'istruzione e della formazione professionale" → SEFRI
  'UFES',     // "Ufficio di Stato per l'istruzione e la formazione professionale" → SEFRI
  'UFJU',     // "Ufficio federale per l'istruzione e la gioventù" → SEFRI
  'JUW',      // "Ufficio federale della formazione, dell'istruzione e della ricerca" → SEFRI
  'SEFO',     // "Segreteria di Stato per la formazione, la ricerca e l'innovazione" → SEFRI
  'AGP',      // "Agenzia Svizzera per la Protezione dell'Ambiente" → UFAM/BAFU
  'AASTI',    // "Agenzia dell'Ambiente della Svizzera Italiana" → UFAM/BAFU
  'ALPA',     // "Dipartimento federale dell'agricoltura, degli alloggi e dell'ambiente" → UFAM/UFAG
  'SERAT',    // "Ufficio federale della statistica sulla ricerca e le tecnologie" → UST/BFS
  'UZBS',     // "Ufficio federale statistici svizzero" → UST/BFS
  'UVTTB',    // "Ufficio federale dei trasporti, ticche e brevetti" → UFT/BAV
  'USGC',     // "Ufficio di Stato per la Gestione dei Conti" — no such body
  'IUSM',     // "Istituto Universitario Svizzero di Santa Maria della Versa" — no such body
  'OFOS',     // "Ufficio federale della svizzera" (#5661) — not a real office name, no such body

  // Invented federal departments. The Swiss federal departments are a closed
  // set of seven, all already in the allowlist (DFI, DFGP, DFF, DFAE, DDPS,
  // DATEC, DEFR).
  'DEEF',     // "Dipartimento federale dell'economia, delle imprese e della formazione" → DEFR
  'DFFFR',    // same invention, different acronym → DEFR
  'EFER',     // same invention, different acronym → DEFR
  'DEDF',     // "Dipartimento federale dell'economia e delle finanze" → DEFR/DFF
  'DETEA',    // "Dipartimento federale dei trasporti, dell'energia e dell'ambiente" → DATEC
  'DET',      // "Dipartimento federale dei trasporti, ticinesi e di famiglia" → DATEC
  'DTF',      // "Dipartimento federale delle strade ticinese" → USTRA/ASTRA
  'DSPSS',    // "Dipartimento federale per la sanità pubblica e la protezione sociale" → DFI
  'DIJ',      // "Dipartimento federale dell'istruzione e della gioventù" → DEFR
  'UGCI',     // "Ufficio del Governo Confederale per la Svizzera italiana" — no such body
  'UDD',      // "Ufficio delle dogane e dei dazi" → AFD/UDSC/BAZG

  // Invented cantonal offices. Ticino's real ones (URC, USTAT, SPAAS, UPAAI,
  // IAS, IFC …) are in the allowlist above.
  'USTIC',    // "Ufficio di statistica del Cantone Ticino" → USTAT
  'UCL',      // "Ufficio cantonale del lavoro" → URC / USML / UIL
  'UCO',      // "Ufficio Cantonale dell'Occupazione" → URC
  'UTL',      // "Ufficio ticinese del Lavoro" → USML / UIL
  'UPL',      // "Ufficio della protezione dei lavoratori" → UIL
  'OLPS',     // "Ufficio del Lavoro e delle Politiche Sociali" → UIL / DSS
  'UCAS',     // "Ufficio Cantonale delle Assicurazioni Sociali" → IAS (TI) / OCAS (GE)
  'UTPS',     // "Ufficio ticinese delle prestazioni sociali" → DASF/DSS
  'UPAI',     // "Ufficio protezione delle acque e dell'approvvigionamento idrico" → UPAAI
  'UCSV',     // "Ufficio di Controllo e Sanità Veterinaria" → USAV / UVAC
  'UMP',      // "Ufficio di Miglioramento Professionale" — no such body
  'DVC',      // "Dipartimento per la Valutazione delle Competenze" — no such body
  'EMC',      // "Ufficio della migrazione ticinese" → Ufficio della migrazione (nessuna sigla EMC)
  'CIVIF',    // "Commissione di vigilanza degli intermediari finanziari" → FINMA
]);

const INSTITUTION_NOUN = String.raw`(?:Ufficio|Uffici|Istituto|Agenzia|Commissione|Osservatorio|Autorit[àa]|Dipartimento|Segreteria|Direzione|Ente|Amministrazione)`;
const INSTITUTION_RE = new RegExp(String.raw`(${INSTITUTION_NOUN}[^().\n]{0,80}?)\(([A-Z]{2,8})\)`, 'g');

/** Below this, a source page is too thin to conclude anything from an absence. */
const MIN_SOURCE_CHARS_FOR_SUPPORT = 400;

/**
 * Fraction of an institution NAME's distinctive tokens that must survive in the
 * source for the entity to count as supported.
 *
 * Looser than fact-check-consensus's SOURCE_SUPPORT_THRESHOLD (0.7) on purpose:
 * that one judges a whole claim, this one judges a 3-8 word institution name
 * whose tokens are largely generic ("Ufficio", "federale", "delle"). After
 * tokenizeIt drops stop-words and stems, "Ufficio federale delle imposte" is
 * three tokens — one miss already costs 33%. The asymmetry of the store makes
 * this the right way to err: a loose support test produces false CLEARANCES
 * (an entity stays merely reported), a strict one produces false BLOCKS.
 */
const INSTITUTION_NAME_SUPPORT_THRESHOLD = 0.6;

/**
 * Every institution acronym the article introduces, with a verdict on whether
 * the run's own SOURCE backs it up.
 *
 * This is the observation feed of the learning loop (see
 * scripts/lib/article-defect-memory.mjs). The support verdict is what makes
 * learning possible without a model call and without the loop grading its own
 * homework: the source text is fetched, not written, so it is an oracle the
 * generator being judged cannot influence. Absence of support is the ONLY
 * signal allowed to push an entity toward blocking; frequency is not.
 *
 * The article's own text is never used as evidence for or against itself.
 *
 * @param {string} text
 * @param {{sourceText?: string}} [opts]
 * @returns {Array<{acronym: string, name: string, support: 'present'|'absent'|'unknown'}>}
 */
export function collectInstitutionAcronyms(text, opts = {}) {
  const out = [];
  if (typeof text !== 'string') return out;
  const sourceText = typeof opts.sourceText === 'string' ? opts.sourceText : '';
  // No usable source (evergreen path, corpus retro-scan) → 'unknown'. Reporting
  // 'absent' here would let source-less runs manufacture blocking evidence out
  // of nothing, which is the fabrication of evidence, not the detection of it.
  const canJudge = sourceText.length >= MIN_SOURCE_CHARS_FOR_SUPPORT;
  const sourceTokens = canJudge ? tokenizeIt(sourceText) : [];

  const seen = new Set();
  for (const m of text.matchAll(INSTITUTION_RE)) {
    const [, name, acronym] = m;
    if (seen.has(acronym)) continue;
    seen.add(acronym);

    let support = 'unknown';
    if (canJudge) {
      const literal = new RegExp(String.raw`\b${acronym}\b`).test(sourceText);
      // An article may correctly introduce an acronym the source only spells
      // out in full ("Amministrazione federale delle contribuzioni" → "(AFC)").
      // Judging on the literal acronym alone would score that as fabricated.
      const nameSupported = containmentSim(tokenizeIt(name), sourceTokens) >= INSTITUTION_NAME_SUPPORT_THRESHOLD;
      support = literal || nameSupported ? 'present' : 'absent';
    }
    out.push({ acronym, name: name.trim(), support });
  }
  return out;
}

/**
 * Flags institution acronyms that are not in the known-real allowlist.
 *
 * Three tiers, in descending order of confidence and of consequence:
 *   1. curated denylist + learned CONFIRMED → critical (blocks)
 *   2. learned SUSPECT                      → major   (reported, prompt hint)
 *   3. anything else unknown                → major   (reported)
 *
 * Tiers 2 and 3 carry the same severity today; they are kept distinct because
 * the message differs (a suspect can tell the writer how many times the
 * pipeline has already seen it invented) and because collapsing them would
 * lose the only signal that says the memory is doing something.
 *
 * @param {string} text
 * @param {{learnedDenylist?: Set<string>, learnedSuspects?: Set<string>,
 *          memoryDegraded?: string|null}} [opts]
 */
export function checkFabricatedInstitutionAcronyms(text, opts = {}) {
  const issues = [];
  if (typeof text !== 'string') return issues;
  const learnedDenylist = opts.learnedDenylist || new Set();
  const learnedSuspects = opts.learnedSuspects || new Set();

  const seen = new Set();
  for (const m of text.matchAll(INSTITUTION_RE)) {
    const [full, name, acronym] = m;
    // The curated allowlist wins over everything, including the learner: a
    // human checked a register, the learner counted. Belt and braces — the
    // memory refuses to promote allowlisted acronyms too (evaluateEntity).
    if (KNOWN_INSTITUTION_ACRONYMS.has(acronym)) continue;
    if (seen.has(acronym)) continue;
    seen.add(acronym);

    if (FABRICATED_INSTITUTION_ACRONYMS.has(acronym) || learnedDenylist.has(acronym)) {
      const learned = !FABRICATED_INSTITUTION_ACRONYMS.has(acronym);
      issues.push(issue(
        'fabricated-institution',
        'critical',
        `Ente inesistente: "${name.trim()} (${acronym})" — acronimo noto come inventato dal generatore`
        + `${learned ? ' (appreso: confermato da avvistamenti ripetuti senza riscontro nelle fonti)' : ''}`,
        full.trim(),
        `Rimuovi "${acronym}": non esiste. In materia fiscale federale svizzera l'ente reale è l'Amministrazione federale `
        + `delle contribuzioni (AFC/ESTV); l'imposta alla fonte è però amministrata a livello CANTONALE `
        + `("ufficio imposte alla fonte" del Cantone). Se il dato non ha una fonte verificabile, elimina l'attribuzione `
        + `e il dato insieme — non sostituire un ente inventato con un altro.`,
      ));
    } else if (learnedSuspects.has(acronym)) {
      issues.push(issue(
        'suspected-institution',
        'major',
        `Ente sotto osservazione: "${name.trim()} (${acronym})" — già emesso in run precedenti senza riscontro nelle fonti`,
        full.trim(),
        `"${acronym}" è nella lista di sorveglianza: il generatore lo ha già scritto senza che la fonte lo nominasse. `
        + `Se la fonte di questo articolo lo cita, tienilo. Altrimenti usa il nome per esteso dell'ente reale, `
        + `oppure togli l'attribuzione insieme al dato che le si appoggia.`,
      ));
    } else {
      issues.push(issue(
        'unknown-institution',
        'major',
        `Ente non in allowlist: "${name.trim()} (${acronym})" — verificare che esista davvero`,
        full.trim(),
        `Verifica che "${acronym}" sia un ente reale e che il nome per esteso sia quello ufficiale. `
        + `Se non ne hai conferma nella fonte, togli l'acronimo e cita l'ente per esteso, o rimuovi l'attribuzione.`,
      ));
    }
  }

  // Never fail open in silence. If the memory could not be read, the run has
  // been evaluated with a defence that is not actually there, and the log must
  // say so — the curated lists still hold, so this is a `minor`, not a block.
  if (opts.memoryDegraded) {
    issues.push(issue(
      'defect-memory-unavailable',
      'minor',
      `Memoria dei difetti non leggibile (${opts.memoryDegraded}) — le difese apprese NON sono state applicate `
      + 'in questo run; restano attive solo le liste curate a mano',
      '',
      'Ripristina o rigenera data/article-defect-memory.json: finché è illeggibile il loop non apprende e '
      + 'gli enti già confermati come inventati non bloccano.',
    ));
  }

  return issues;
}

// ─── 5b. Fabricated NORM acronyms ──────────────────────────────
//
// corpus#323 e la sua recidiva del 15-16/08/2026: `(LFW)` per la legge sul
// lavoro e `(LPS)` per due leggi che non esistono sono ricomparsi in 9 corpi su
// 4 locali DOPO che l'incidente era stato chiuso, perché nessuno dei gate di
// questo file li poteva vedere.
//
// Il punto cieco è STRUTTURALE, non una voce mancante in una lista:
// INSTITUTION_RE (sezione 5) riconosce solo nomi di ENTE — `Ufficio`,
// `Istituto`, `Agenzia`, `Autorità`, ... — e `Legge` non è fra questi. Una
// sigla NORMATIVA inventata non produce quindi né `fabricated-institution`,
// né `unknown-institution`, né una observation per il learner del
// defect-memory: attraversa tutti e tre i tier senza toccarne nessuno.
// L'altra metà della difesa (`FABRICATED_ACRONYMS` in create-article.mjs)
// contiene già quattro sigle di legge inventate (`LCFL`, `LFP`, `RTL`, `LTL`)
// ma non queste due, e vive fuori da questo modulo.
//
// Perché una tabella byte-exact e non un'euristica «acronimo + anno»: quella
// è già stata misurata e scartata in #261 — 41 hit su 16.676 file, per lo più
// norme e istituzioni VERE (`SECO 2024`, `KVG 2023`, `SCP 2026`, il nome di
// una scuola). Qui entrano solo sigle osservate dal vivo nel corpus e
// verificate come inesistenti: le stesse che il test sui dati
// (generator/tests/telelavoro-frontalieri-normative-citations.test.mjs) cerca
// su tutti i corpi. Guard e test guardano la stessa lista di nomi, quindi non
// possono divergere su cosa sia fabbricato.
//
// I confini sono su LETTERE e non `\b`, esattamente come nel test: `MLPS`
// (Ministero del Lavoro e delle Politiche Sociali) e `TULPS` (Testo Unico
// Leggi Pubblica Sicurezza) sono norme VERE e devono restare fuori match —
// 8 file al 2026-08-18.
//
// Il flag `i` e' piu' permissivo di INSTITUTION_RE (`[A-Z]{2,8}`, sezione 5)
// e la review su #6005 lo ha segnalato come rischio di falso positivo non
// escluso: una occorrenza minuscola di `lfw`/`lps` dentro una parola
// straniera o un acronimo di prodotto passerebbe anch'essa. Verificato
// 2026-08-18 sull'intero corpus tirato (`packages/articles/content/`,
// 17.872 file su it/en/de/fr): zero occorrenze minuscole o miste, solo la
// forma maiuscola esatta della sigla inventata. Il flag oggi non cattura
// altro che la sigla stessa: restringerlo toglierebbe copertura senza un
// difetto reale da mostrare. Ri-misurare se il corpus cresce di molto o se
// emerge un hit minuscolo — a quel punto il fix e' un boundary aggiuntivo o
// la rimozione del flag, non prima.
//
// LCL e LCO (follow-up #6017, item 2/3 di #6005) verificate con la stessa
// disciplina: misurate sul corpus tirato con la stessa regex a confini di
// lettera — 3 occorrenze in 2 file (`LCL`), 7 in 4 file (`LCO`). `LCL`
// fabbrica DUE leggi diverse e incompatibili nello stesso corpus: «legge
// cantonale sulla naturalizzazione del Cantone di Lucerna... (LCL 2020,
// art. 15)» in un articolo e «La legge cantonale sul lavoro (LCL) del 15
// dicembre 1995» in un altro — stesso acronimo, domini e date che si
// escludono, la stessa firma di fabbricazione di LFW. `LCO` («Federal Act
// on Combating Organized Crime (LCO)», 2013) e' invece consistente ma
// sopravvive identica a it/en/de/fr in `infiltrazioni-criminali-ticino-
// grigioni` — nessuna legge federale svizzera con questa sigla esiste, la
// lotta alla criminalita' organizzata e' nel Codice penale (art. 260ter
// CP), lo stesso argomento «sopravvive alla traduzione» gia' usato per
// LFW/LPS. Zero occorrenze minuscole/miste di `lcl`/`lco` sullo stesso
// corpus tirato, stessa verifica di cui sopra.
// Cue di CITAZIONE GIURIDICA, multilingue per costruzione: serve alle entry
// che portano un `context` (oggi solo `LCL`, vedi sotto). Copre le quattro
// lingue del corpus — it `legge/legislazione/articolo/art.`, fr `loi/article`,
// de `Gesetz/Bundesgesetz/Artikel/Abs.`, en `law on/act on/article` — piu' i
// riferimenti svizzeri `RS <numero>` e `cpv.`, che sono gia' locale-neutri.
// L'obiezione «una parola come "legge" non regge su de/fr/en» e' corretta per
// una singola parola italiana, e infatti qui non ce n'e' una sola.
// La chiusura di ogni alternativa NON e' uniforme, ed e' deliberato: dipende
// da come compone la lingua, e ci sono TRE casi distinti, non due.
//
// 1. Chiuse con `\b` — la coda del prefisso e' fitta di parole ordinarie:
//    `Artikeln?\b` (`Artikelnummer` e' un codice prodotto, `Artikelserie` una
//    serie giornalistica; la `n?` tiene il dativo plurale «in den Artikeln 5
//    und 6»), `articol[oi]\b` (`articolista`, `articolistica`: chi scrive sui
//    giornali, non chi cita una legge) e la famiglia
//    `legg[ei]\b`/`legislazion[ei]\b`/`lois?\b`.
// 2. Aperte a prefisso — li' la composizione va nell'altra direzione, e i
//    composti sono TUTTI contesto di citazione normativa: `Gesetzgebung`,
//    `Gesetzbuch`, `Gesetzentwurf`, `Gesetzeslage`, `Bundesgesetzblatt`.
//    Chiudere `Gesetz`/`Bundesgesetz` darebbe falsi NEGATIVI, non toglierebbe
//    falsi positivi — lo stesso difetto per cui `legislazion[ei]` ha il
//    plurale invece del solo singolare. `articles?` sta QUI e non nel caso 1,
//    benche' l'italiano `articol[oi]` sia chiuso: la coda inglese di
//    `article-` non e' fitta di parole ordinarie come quella italiana, e' di
//    nuovo dominio giuridico (`articled clerk`, `articling student` sono il
//    praticante di studio legale). Un `\b` qui sarebbe una chiusura senza un
//    caso che la giustifichi — e infatti la prova di mutazione la lascia
//    verde, cioe' nessun test morirebbe togliendola.
// 3. Aperta MA con una sola coda esclusa — `Gesetz(?:es|e)?(?!t)`. Restare
//    aperti vale per i composti veri, cioe' per le parole che hanno `Gesetz`
//    come RADICE; `gesetzt` non e' un composto, e' il participio di `setzen`
//    («der Rahmen ist gesetzt», «gesetzt den Fall») piu' le sue forme declinate
//    `gesetzte/-r/-n/-m/-s`. Condivide le prime sei lettere per coincidenza
//    morfologica, non per composizione, ed e' parola comunissima in un pezzo
//    de-locale: entro i 120 caratteri di `contextWindow` bastava a far scattare
//    `fabricated-norm-acronym` `critical` su una banca legittima. La `t` e'
//    l'unica coda esclusa perche' nessun composto giuridico con `Gesetz-` in
//    testa comincia per `t`; `Gesetzestext` sopravvive per backtracking
//    (`es` fallisce il lookahead, `e` lo passa lasciando `stext`).
//
// I test «leaves the bank LCL alone …» e «keeps German legal compounds as
// citation cues» codificano le tre scelte insieme, perche' non vengano
// «riparate» una per giro: chiudere le aperte fa passare il primo e rompe il
// secondo, e togliere il `(?!t)` rompe il terzo.
const NORM_CITATION_CUE =
  /\b(?:legg[ei]\b|legislazion[ei]\b|lois?\b|Gesetz(?:es|e)?(?!t)|Bundesgesetz|federal\s+act\b|act\s+on\b|law\s+on\b|articol[oi]\b|articles?|Artikeln?\b|art\.|cpv\.|Abs\.|RS\s*\d)/i;

export const FABRICATED_NORM_ACRONYMS = [
  {
    acronym: 'LFW',
    re: /(?<![A-Za-z])LFW(?![A-Za-z])/i,
    real: "la legge sul lavoro è LL (RS 822.11, 13 marzo 1964); per l'apprendistato è la LFPr (RS 412.10)",
  },
  {
    acronym: 'LPS',
    re: /(?<![A-Za-z])LPS(?![A-Za-z])/i,
    real: 'non esiste: previdenza → LAVS/LAI/LPP, assicurazione malattie → LAMal/LVAMal, permesso di soggiorno → LStrI (RS 142.20)',
  },
  {
    acronym: 'LCL',
    re: /(?<![A-Za-z])LCL(?![A-Za-z])/i,
    real: "non esiste: la legge sul lavoro è LL (RS 822.11); la cittadinanza svizzera è la LCit (RS 141.0) più il diritto cantonale, nessuna sigla ufficiale «LCL»",
    // A bare substring match on `LCL` also matches the real French bank (ex
    // Crédit Lyonnais) — a future article mentioning it (this corpus already
    // has 175 files on frontalieri Francia-Svizzera and 29 naming other
    // French banks) would be rejected as a fabricated norm.
    //
    // Il primo giro di questa guardia chiedeva un ANNO vicino. Non basta, ed
    // e' misurato: «Dal 2024 LCL offre un conto dedicato ai frontalieri» —
    // una frase bancaria del tutto ordinaria — porta un anno a due parole
    // dalla sigla e veniva rigettata lo stesso. In un articolo su conti e
    // mercati un anno vicino e' la norma, non l'eccezione, quindi come
    // discriminante non separa niente.
    //
    // Serve invece il segno di una CITAZIONE di norma. L'obiezione con cui
    // era stato scelto l'anno («non una parola specifica di una lingua, il
    // check gira anche su de/fr/en») e' giusta contro UNA parola italiana, e
    // infatti `NORM_CITATION_CUE` e' multilingue per costruzione. Entrambe le
    // fabbricazioni reali del corpus restano rilevate — `(LCL) del 15
    // dicembre 1995` ha «legge» 28 caratteri prima, `(LCL 2020, art. 15)` ha
    // «art.» subito dopo — e le due sono le sole occorrenze vere: negli altri
    // tre file la sigla e' `LCLoc`, che il lookahead `(?![A-Za-z])` esclude.
    context: NORM_CITATION_CUE,
    contextWindow: 120,
  },
  {
    acronym: 'LCO',
    re: /(?<![A-Za-z])LCO(?![A-Za-z])/i,
    real: 'non esiste: il contrasto alla criminalità organizzata è nel Codice penale, art. 260ter CP (RS 311.0)',
  },
];

/**
 * Flags known-fabricated NORM acronyms, in any locale.
 *
 * Locale-independent by construction: an invented acronym survives translation
 * unchanged — `(LFW)` arrived byte-identical in the de/fr/en bodies of
 * `apprendistato-urie-2024-2025` — so judging it on Italian alone would let
 * the three translations through. Same argument already written for
 * FABRICATED_LABOR_OFFICE_ACRONYMS in create-article.mjs.
 *
 * @param {string} text
 * @param {{locale?: string}} [opts]
 * @returns {Array<{code: string, severity: string, message: string}>}
 */
export function checkFabricatedNormAcronyms(text, opts = {}) {
  const issues = [];
  if (typeof text !== 'string' || !text) return issues;
  const locale = opts.locale || 'it';
  for (const { acronym, re, real, context, contextWindow } of FABRICATED_NORM_ACRONYMS) {
    // `re` is deliberately non-global: a `g` regex carries `lastIndex` across
    // calls, and this table is module-level shared state. Lo scan qui sotto
    // usa quindi un CLONE locale con flag `g`, mai la regex della tabella:
    // l'invariante `entry.re.global === false` resta vera e nessuna entry
    // diventa stateful fra due chiamate.
    //
    // Perche' non basta la prima occorrenza: con una guardia `context` il
    // primo match puo' essere legittimo (la banca francese LCL) e nascondere
    // una fabbricazione piu' in basso nello stesso testo. Senza `context` il
    // difetto non poteva esistere, perche' il primo match era sempre anche
    // l'issue: nasce con la guardia e va chiuso con lei.
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = scan.exec(text)) !== null) {
      if (m[0] === '') { scan.lastIndex += 1; continue; }
      if (context) {
        const w = contextWindow ?? 80;
        const nearby = text.slice(Math.max(0, m.index - w), m.index + m[0].length + w);
        if (!context.test(nearby)) continue;
      }
      issues.push(issue(
        'fabricated-norm-acronym',
        'critical',
        `[${locale}] Sigla normativa inventata: «${acronym}» — ${real}`,
        text.slice(Math.max(0, m.index - 90), m.index + 60),
        'Cita la norma reale con la sua sigla ufficiale, oppure togli la citazione. '
        + "Una sigla di legge inesistente è una fabbricazione anche quando la frase intorno è corretta, "
        + "e sopravvive alla traduzione: va tolta nell'originale, non nei singoli locali.",
      ));
      break; // una sola issue per sigla, come prima
    }
  }
  return issues;
}

/**
 * BLOCKING — checkFabricatedNormAcronyms() across every locale a caller
 * already has content for, in ONE place so every producer wires the same
 * check the same way instead of each re-deriving it.
 *
 * `runFactualityGates()` already runs checkFabricatedNormAcronyms(), but only
 * where a caller actually invokes runFactualityGates — and that is exactly
 * where this gate leaked: create-article.mjs's AI-generation path calls it
 * only on `data.content.it`, before translateArticle() exists, so an acronym
 * that survives translation unchanged (see checkFabricatedNormAcronyms doc)
 * was never re-checked on en/de/fr. publish-journalist-article.mjs never
 * calls runFactualityGates at all — a journalist submission passed through
 * no norm-acronym check in ANY locale, IT included. Same shape of gap as
 * assertNoFabricatedLaborOfficeCrossLocale, and wired the same way: called
 * directly on IT content, and again on en/de/fr after translateArticle().
 *
 * @param {Record<string, {title?: string, body1?: string, body2?: string, body3?: string} | undefined>} contentByLocale
 */
export function assertNoFabricatedNormAcronyms(contentByLocale) {
  const issues = [];
  for (const [locale, content] of Object.entries(contentByLocale || {})) {
    if (!content) continue;
    const text = [content.title || '', content.body1 || '', content.body2 || '', content.body3 || ''].join(' ');
    for (const found of checkFabricatedNormAcronyms(text, { locale })) {
      issues.push(found.message);
    }
  }
  if (issues.length > 0) {
    const msg = issues.map((i, idx) => `  ${idx + 1}. ${i}`).join('\n');
    throw new Error(`Articolo rigettato — sigla normativa fabbricata:\n${msg}`);
  }
}

// ─── 6. Contradictory dates for the same named norm ───────────────────
//
// "Il Decreto Omnibus è stato varato il 1° gennaio 2023" coexisted with "Il 1°
// gennaio 2024 entrerà in vigore il Decreto Omnibus" in the same article.

// The same table the cross-locale date comparison reads, kept in one place so
// the two can never disagree about what "marzo" means.
const MONTHS_IT = LOCALE_LEXICON.it.months;
// Built from that same table rather than re-listing the twelve names: a regex
// and a lookup map that must agree on the spelling of "märz" is exactly the
// literal duplication AGENTS.md #6 forbids, and here the two are now in
// different files, where the drift would be invisible.
const DATE_IT_RE = new RegExp(
  String.raw`(\d{1,2})\s*°?\s+(${Object.keys(MONTHS_IT).join('|')})\s+(\d{4})`,
  'gi',
);
// Deliberately excludes Accordo / Convenzione / Trattato. An international
// instrument legitimately carries a signature date, a ratification date and an
// entry-into-force date, all of which read as "promulgation" — that alone
// accounted for 116 of the 116 remaining false positives on the corpus
// ("Accordo Frontalieri" signed 23/12/2020, in force 1/1/2024, Bilaterali
// 1999 and 2001). Domestic decrees and laws have a single enactment date.
const NORM_RE = /((?:Decreto|Legge|Regolamento|Direttiva|Ordinanza)\s+[A-ZÀ-Ü][\wÀ-ü'-]*(?:\s+[A-ZÀ-Ü][\wÀ-ü'-]*)?)/g;

// A norm legitimately carries several dates — signature, entry into force,
// transposition, deadlines. Grouping any date near a norm name flagged the
// "Accordo Frontalieri" in 120 articles for correctly stating that it was
// signed in 2020 and took effect in 2024. So dates are grouped by PREDICATE:
// two different "was enacted on" dates for one norm is a contradiction, an
// enactment date plus an entry-into-force date is not.
const NORM_PREDICATES = [
  { key: 'promulgazione', re: /\b(?:varat\w+|approvat\w+|emanat\w+|promulgat\w+|firmat\w+|siglat\w+|adottat\w+)\b/i },
  { key: 'vigore', re: /\b(?:entrat\w+\s+in\s+vigore|in\s+vigore\s+dal?|vigenza|entrer[àa]\s+in\s+vigore|efficace\s+dal?)\b/i },
  { key: 'abrogazione', re: /\b(?:abrogat\w+|soppress\w+|decadut\w+)\b/i },
];

/** Flags one norm given two different dates for the SAME predicate. */
export function checkContradictoryNormDates(text) {
  const issues = [];
  if (typeof text !== 'string') return issues;

  // norm → predicate → Map(dateKey → context)
  const byNorm = new Map();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const norms = [...sentence.matchAll(NORM_RE)].map((m) => m[1].trim());
    if (!norms.length) continue;
    // A sentence carrying more than one predicate ("varato il X ed entrato in
    // vigore il Y") cannot have its dates attributed without parsing clause
    // structure, and guessing produces false contradictions. Skip it.
    const matching = NORM_PREDICATES.filter((p) => p.re.test(sentence));
    if (matching.length !== 1) continue;
    const predicate = matching[0];

    const dates = [...sentence.matchAll(DATE_IT_RE)].map((m) => ({
      key: `${m[3]}-${String(MONTHS_IT[m[2].toLowerCase()]).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`,
      raw: m[0],
    }));
    if (!dates.length) continue;

    for (const norm of new Set(norms)) {
      if (!byNorm.has(norm)) byNorm.set(norm, new Map());
      const byPredicate = byNorm.get(norm);
      if (!byPredicate.has(predicate.key)) byPredicate.set(predicate.key, new Map());
      for (const d of dates) byPredicate.get(predicate.key).set(d.key, { raw: d.raw, sentence: sentence.trim() });
    }
  }

  for (const [norm, byPredicate] of byNorm) {
    for (const [predicate, dateMap] of byPredicate) {
      if (dateMap.size < 2) continue;
      const entries = [...dateMap.values()];
      issues.push(issue(
        'contradictory-norm-dates',
        'critical',
        `"${norm}" ha ${dateMap.size} date di ${predicate} incompatibili: ${entries.map((e) => e.raw).join(' / ')}`,
        entries.map((e) => e.sentence).join(' ⟷ '),
        `Una norma ha UNA sola data di ${predicate}. Tieni solo quella confermata dalla fonte e correggi le altre. `
        + `Se le date si riferiscono a passaggi diversi (firma, entrata in vigore, scadenza di un adempimento), `
        + `scrivilo esplicitamente accanto a ciascuna invece di presentarle tutte come data della norma.`,
      ));
    }
  }

  return issues;
}

// ─── 7. Source freshness ──────────────────────────────────────────────
//
// A 25 January 2026 source was published as news on 28 July 2026, still in the
// future tense ("entrerà in vigore"). Both halves are checked.

// No `g` flag: this regex is only ever used with .test(), and a global regex
// carries `lastIndex` across calls — the second .test() on a different string
// then starts mid-way and silently misses. (Cost us a false negative in the
// first draft of this module.)
const FUTURE_TENSE_RE = /\b(entrer[àa]|sar[àa]\s+in\s+vigore|scadr[àa]|verr[àa]\s+(?:introdott|applicat|varat)\w*|opterann?o|dovrann?o\s+presentare)\b/i;

/**
 * @param {{sourceDate?: string|Date, publishedAt?: string|Date, text?: string,
 *          maxAgeDays?: number, now?: Date}} params
 */
export function checkSourceFreshness(params = {}) {
  const issues = [];
  const { sourceDate, publishedAt, text = '', maxAgeDays = 30 } = params;

  const src = sourceDate ? new Date(sourceDate) : null;
  const pub = publishedAt ? new Date(publishedAt) : (params.now || null);

  if (src && !Number.isNaN(src.getTime()) && pub && !Number.isNaN(pub.getTime())) {
    const ageDays = Math.floor((pub.getTime() - src.getTime()) / 86_400_000);
    if (ageDays > maxAgeDays) {
      // The defect is presenting an old fact as breaking news, not covering an
      // old fact at all. An article that explicitly dates the event ("da gennaio
      // 2026 l'ufficio ha comunicato…") does not mislead the reader, so it is
      // reported but does not block. One that never names the period does.
      const srcMonth = Object.keys(MONTHS_IT).find((k) => MONTHS_IT[k] === src.getUTCMonth() + 1);
      const srcYear = src.getUTCFullYear();
      const datesTheFact = typeof text === 'string'
        && new RegExp(String.raw`${srcMonth}\s+${srcYear}`, 'i').test(text);

      issues.push(issue(
        'stale-source',
        datesTheFact ? 'major' : (ageDays > maxAgeDays * 3 ? 'critical' : 'major'),
        `Fonte del ${src.toISOString().slice(0, 10)} pubblicata come notizia il ${pub.toISOString().slice(0, 10)} `
        + `— ${ageDays} giorni di ritardo (max ${maxAgeDays})`
        + `${datesTheFact ? ' — il testo però data esplicitamente il fatto, quindi non fuorvia' : ''}`,
        '',
        `Non presentare la notizia come appena avvenuta. Colloca esplicitamente il fatto nel tempo `
        + `("secondo quanto comunicato nel ${src.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}"), `
        + `usa i tempi al passato per ciò che è già accaduto, e metti in evidenza ciò che è ancora attuale per il lettore `
        + `oggi (scadenze future, adempimenti ancora aperti). Se nulla è più attuale, l'articolo non va pubblicato.`,
      ));
    }
  } else if (publishedAt && !sourceDate) {
    issues.push(issue(
      'missing-source-date',
      'minor',
      'Data di pubblicazione della fonte non estratta — freshness non verificabile',
      '',
      `Non datare il fatto al presente ("oggi", "da questa settimana", "in queste ore"): la data della fonte `
      + `non è nota, quindi una collocazione temporale implicita è un'affermazione non verificata. Attribuisci `
      + `il fatto alla fonte senza fissarlo nel tempo ("come riportato dalla fonte") oppure usa solo le date `
      + `esplicitamente citate nel SOURCE CONTENT.`,
    ));
  }

  // Future tense pointing at a date that has already passed at publication time.
  if (pub && !Number.isNaN(pub.getTime()) && typeof text === 'string' && FUTURE_TENSE_RE.test(text)) {
    for (const m of text.matchAll(DATE_IT_RE)) {
      const day = Number(m[1]);
      const month = MONTHS_IT[m[2].toLowerCase()];
      const year = Number(m[3]);
      const when = new Date(Date.UTC(year, month - 1, day));
      if (when.getTime() >= pub.getTime()) continue;
      const around = text.slice(Math.max(0, m.index - 120), m.index + 40);
      if (!FUTURE_TENSE_RE.test(around)) continue;
      issues.push(issue(
        'past-date-future-tense',
        'major',
        `Data già passata (${m[0]}) presentata al futuro rispetto alla pubblicazione del ${pub.toISOString().slice(0, 10)}`,
        around.trim(),
        `${m[0]} è già passata: riscrivi al passato ("è entrato in vigore", "andava presentata entro"). `
        + `Se stai indicando una scadenza da rispettare, non può essere una data trascorsa — usa la scadenza `
        + `realmente ancora aperta indicata dalla fonte, oppure togli l'indicazione.`,
      ));
    }
  }

  return issues;
}

// ─── 8. Source fidelity (recall) ──────────────────────────────────────
//
// THE ROOT-CAUSE GATE. llmFactCheck only ever asked "does the article contain a
// claim I cannot verify?" — never "did the article keep what the source
// actually said?". Under a retry loop that feeds issues back as rewrite
// instructions, dropping every specific fact is the winning strategy: the final
// draft lost 80%, 25%, OCST, "vecchio elenco" and "fine 2026" and passed.
//
// Measuring RECALL of the source's anchored facts makes that strategy lose.

// All-caps tokens that are not institutions. Italian and Swiss news pages carry
// all-caps subheads, bylines and currency codes, and counting those as "source
// anchors" both dilutes genuine recall and can pad it past the threshold with
// noise that happens to survive into the article.
const STOP_TOKENS = new Set([
  '2026', '2025', '2024', '2023', '2022', '100', '000',
  // currencies and units
  'CHF', 'EUR', 'USD', 'GBP', 'IVA', 'KM', 'KG', 'MQ', 'ORE',
  // formats / tech / web furniture
  'PDF', 'HTML', 'URL', 'JPG', 'PNG', 'GIF', 'API', 'RSS', 'WWW', 'HTTP', 'HTTPS', 'CSS', 'XML',
  // company forms
  'SRL', 'SPA', 'SAGL', 'SNC', 'SAS', 'GMBH',
  // common all-caps editorial furniture
  'NEWS', 'VIDEO', 'FOTO', 'LIVE', 'HOME', 'MENU', 'LEGGI', 'ANCHE', 'TUTTI',
  'ANSA', 'ADN', 'REG', 'ART', 'CAP', 'TEL', 'FAX',
]);

/** Extracts the source's checkable anchors: percentages, amounts, dates, distances, acronyms. */
export function extractSourceAnchors(sourceText) {
  const anchors = new Set();
  if (typeof sourceText !== 'string') return anchors;

  // Percentages: "80%", "25%", "cento per cento"
  for (const m of sourceText.matchAll(/(\d[\d.,]*)\s*%/g)) anchors.add(`pct:${parseItalianNumber(m[1])}`);
  // Distances: "20 km"
  for (const m of sourceText.matchAll(/(\d[\d.,]*)\s*km\b/gi)) anchors.add(`km:${parseItalianNumber(m[1])}`);
  // Full dates
  for (const m of sourceText.matchAll(DATE_IT_RE)) {
    anchors.add(`date:${m[3]}-${String(MONTHS_IT[m[2].toLowerCase()]).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`);
  }
  // Institution / organisation acronyms actually present in the source.
  //
  // ALLOW-LIST, not deny-list. The deny-list version of this loop is what
  // stalled generation from 2026-07-30 to 2026-08-03. `[A-Z]{3,8}` minus
  // STOP_TOKENS harvests every all-caps word, and an evergreen SEO brief is
  // full of all-caps EMPHASIS rather than acronyms — so on the frontalieri
  // tax brief it produced, alongside 14 genuine bodies, these eight required
  // "facts": ARTICOLO and SEO (from the brief's own `[ARTICOLO EVERGREEN SEO]`
  // header), SOLO and MAI (from «trattenuta SOLO in Svizzera (MAI "in entrambi
  // i paesi")»), NON (from «(NON 2026)»), VALIDI (from «Acronimi/enti VALIDI»),
  // GENNAIO (a month), and IPG.
  //
  // Those are structurally unsatisfiable: no article will ever contain "VALIDI"
  // as an entity, let alone reproduce a prompt header. They sat permanently in
  // the denominator and permanently outside the numerator, pinning recall below
  // the 50% gate no matter how faithful the draft was — measured at 16% then
  // 43% on successive attempts of run 30784967708, never passing. The retry
  // loop then burned all six attempts and the job was hard-killed at 2400s with
  // no article. Worse, `source-fidelity-low`'s remediation quotes the missing
  // anchors back to the writer, so the gate was actively instructing the model
  // to insert the word "VALIDI" into a tax article.
  //
  // KNOWN_INSTITUTION_ACRONYMS is already this module's authority on what is a
  // real body — checkFabricatedInstitutionAcronyms judges the ARTICLE against
  // it. Judging the SOURCE against the same list is the consistent rule, and it
  // fails safe: an unlisted acronym stops being a *required* anchor instead of
  // becoming an impossible one. If a real institution is being missed, the fix
  // is to add it to that set, which improves both gates at once.
  for (const m of sourceText.matchAll(/\b([A-Z]{3,8})\b/g)) {
    const token = m[1].toUpperCase();
    if (STOP_TOKENS.has(m[1])) continue;
    if (!KNOWN_INSTITUTION_ACRONYMS.has(token)) continue;
    anchors.add(`org:${token}`);
  }
  return anchors;
}

/**
 * Render one anchor in the EXACT literal form matchedAnchors() searches for.
 *
 * Anchors are stored in a machine key form (`date:2023-07-17`, `km:20`) that
 * the recall matcher never looks for verbatim — dates, for instance, are only
 * matched as "17 luglio 2023". Every message that asks a writer to include an
 * anchor must therefore go through this function, or it asks for a string that
 * cannot satisfy the check it is quoting. That is not hypothetical: the
 * `source-fidelity-low` remediation used to interpolate the raw key, so an
 * article that dutifully wrote "2023-07-17" still failed the gate that had
 * demanded it, and the retry loop could never converge on a date anchor.
 *
 * Kept next to matchedAnchors() deliberately: check and instruction are one
 * unit, and a change to either without the other is a silent contradiction.
 */
export function renderAnchorForPrompt(anchor) {
  const [kind, value] = String(anchor).split(':');
  // Italian decimal comma, because that is the ONLY form matchedAnchors()
  // accepts: it tests `n.toString().replace('.', ',')`. This branch used to
  // return the raw key, so the contract and every remediation asked for "5.3%"
  // while the recall check would only ever credit "5,3%" — the identical defect
  // the `date` branch below was already fixed for, and with the identical
  // consequence: a writer that complied EXACTLY still failed the gate, and no
  // retry could converge.
  //
  // It is invisible on whole numbers ("23".replace('.', ',') === "23"), which
  // is why it survived: only fractional rates are affected. Run 30784967708 is
  // the proof — across six attempts the writer recovered 18%, 23%, 35% and 43%
  // and never once recovered 5.3%, 1.1% or 1.5%, which are exactly the three
  // non-integer percentages in that source.
  if (kind === 'pct') return `${Number(value).toString().replace('.', ',')}%`;
  if (kind === 'km') return `${Number(value)} km`;
  if (kind === 'date') {
    const [y, mo, d] = value.split('-');
    const monthName = Object.keys(MONTHS_IT).find((k) => MONTHS_IT[k] === Number(mo));
    return monthName ? `${Number(d)} ${monthName} ${y}` : value;
  }
  return value;
}

/**
 * The RegExp that decides whether a piece of text carries `anchor`.
 *
 * One definition, two callers: `findAnchorSentence` uses it to pick the
 * sentence, `truncateForPrompt` uses it to keep the fact inside the window it
 * cuts. Two copies would drift, and this particular drift is invisible — a
 * truncation that no longer knows what it must preserve still returns a
 * plausible-looking quote (AGENTS.md #6: a regex needed in two places goes
 * into one place).
 *
 * Returns null when the kind is unknown or the date cannot be parsed.
 */
function anchorNeedle(anchor) {
  const [kind, value] = String(anchor).split(':');
  if (kind === 'pct') return new RegExp(String.raw`${value.replace('.', '[.,]')}\s*%`);
  if (kind === 'km') return new RegExp(String.raw`${Number(value)}\s*km`, 'i');
  if (kind === 'org') return new RegExp(String.raw`\b${value}\b`);
  if (kind === 'date') {
    const [y, mo, d] = value.split('-');
    const monthName = Object.keys(MONTHS_IT).find((k) => MONTHS_IT[k] === Number(mo));
    if (!monthName) return null;
    return new RegExp(String.raw`${Number(d)}\s*°?\s+${monthName}\s+${y}`, 'i');
  }
  return null;
}

/**
 * The source's OWN sentence carrying `anchor`, untruncated. Internal: callers
 * that group by evidence (see `groupedAnchorEvidence`) need the full sentence
 * as the grouping key, because two distinct sentences that share their first
 * 237+ chars and diverge only after would otherwise collide once truncated,
 * merging two distinct source quotations under one.
 */
function findAnchorSentence(sourceText, anchor) {
  if (typeof sourceText !== 'string' || !sourceText) return '';
  const needle = anchorNeedle(anchor);
  if (!needle) return '';

  // Sentence-ish split: enough to isolate the claim without dragging in the
  // whole paragraph, and tolerant of the ragged text scrapers produce.
  for (const sentence of sourceText.split(/(?<=[.!?])\s+|\n+/)) {
    if (needle.test(sentence)) return sentence.replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** Prompt budget for one quoted sentence, ellipsis included. */
const EVIDENCE_MAX_CHARS = 240;

/**
 * Caps a sentence for prompt use — display only, never a grouping key.
 *
 * The window is cut AROUND `anchors`, not from the head of the sentence.
 * Cutting from the head produced quotes that no longer contained the fact
 * they were quoted FOR, and did it silently: measured on the pulled corpus
 * of published article bodies (17.804 bodies, 65.223 anchors) 1.689 anchors
 * across 930 documents got a 238-char quote whose datum sat past char 237.
 * The instruction then read «reintegra DATEC — la fonte dice: "<237 chars
 * that do not contain DATEC>"», which is precisely the "never a wrong quote"
 * guarantee of `anchorEvidence` below, broken. Handing back the wrong
 * sentence is worse than handing back none: the writer reinstates what it was
 * shown, so a mis-cut quote is how a dropped fact comes back invented — the
 * same failure the evidence was added to prevent.
 *
 * Sentences whose anchor already fits in the head window keep the exact old
 * output, so this is strictly additive: 63.534 of those 65.223 anchors are
 * byte-identical before and after.
 */
function truncateForPrompt(sentence, anchors = []) {
  if (sentence.length <= EVIDENCE_MAX_CHARS) return sentence;
  const head = EVIDENCE_MAX_CHARS - 3;

  // Earliest position that must survive the cut. Anchors further right are
  // still lost to the budget, but the first one never is — before this, none
  // was safe.
  let at = -1;
  let hitLen = 0;
  for (const a of [].concat(anchors)) {
    const needle = anchorNeedle(a);
    const m = needle ? sentence.match(needle) : null;
    if (m && (at === -1 || m.index < at)) { at = m.index; hitLen = m[0].length; }
  }
  // Unknown anchor, or the fact already inside the head window → old behaviour.
  if (at === -1 || at + hitLen <= head) return `${sentence.slice(0, head)}…`;

  // Slide a window that keeps the fact, with some left context for sense.
  const width = EVIDENCE_MAX_CHARS - 2; // room for the two ellipses
  let from = Math.min(Math.max(0, at - 60), Math.max(0, sentence.length - width));
  if (from > at) from = at; // pathological: never cut the fact off the left
  // Snap forward to a word boundary so the quote does not open mid-word, but
  // never far enough to eat into the fact itself.
  const snap = sentence.slice(from, Math.min(at, from + 30)).indexOf(' ');
  if (snap > 0) from += snap + 1;
  const to = Math.min(sentence.length, from + width);
  return `${from > 0 ? '…' : ''}${sentence.slice(from, to)}${to < sentence.length ? '…' : ''}`;
}

/**
 * The source's OWN sentence carrying `anchor`, trimmed for prompt use.
 *
 * A gate that only names what is missing leaves the writer to reconstruct the
 * fact from memory — which is how a dropped "80%" comes back as an invented
 * one, and how the same anchor gets lost again on the next attempt. Handing
 * back the source sentence makes the repair mechanical: the material to
 * reinstate is already in front of the writer, quoted from the very text the
 * recall check reads. Returns '' when the anchor cannot be located (the
 * instruction then degrades to naming it, never to a wrong quote).
 */
export function anchorEvidence(sourceText, anchor) {
  const sentence = findAnchorSentence(sourceText, anchor);
  return sentence ? truncateForPrompt(sentence, [anchor]) : '';
}

/** Human label per anchor kind, for grouping the contract below. */
const ANCHOR_KIND_LABEL_IT = {
  pct: 'percentuali',
  km: 'distanze',
  date: 'date',
  org: 'istituzioni e sigle',
};

/**
 * The blocking gates in this module, restated UP FRONT as instructions the
 * writer can actually satisfy — the single most important thing this file
 * exports.
 *
 * Until this existed the generator ran an open loop. The prompt only ever
 * stated a PRECISION rule ("every fact must come from the source"), while
 * `checkSourceFidelity` blocks on RECALL ("did you keep what the source
 * said?") and `checkSourceFreshness` blocks on an old source not being dated
 * in the text. Neither requirement was ever shown to the writer before it
 * wrote, so the safest-looking strategy — generic prose that asserts nothing
 * specific — was exactly the one that maximised rejection. Run 30442955458:
 * 8 headlines × 6 model attempts, 48 full articles generated, ZERO published,
 * with recall going 38% → 13% → 0% → 0% across the retries of one headline
 * because each attempt was as blind as the first.
 *
 * Returns '' when the source carries too few anchors for the fidelity gate to
 * apply, so the contract is never stated where it would not be enforced.
 *
 * @param {{sourceText?: string, sourceDate?: string|Date, publishedAt?: string|Date,
 *          minRecall?: number, minAnchors?: number, maxAgeDays?: number}} params
 */
export function buildSourceContract(params = {}) {
  const {
    sourceText = '',
    sourceDate,
    publishedAt,
    minRecall = 0.5,
    minAnchors = 3,
    maxAgeDays = 30,
  } = params;

  const lines = [];
  const anchors = extractSourceAnchors(sourceText);
  if (anchors.size >= minAnchors) {
    const byKind = new Map();
    for (const a of anchors) {
      const kind = String(a).split(':')[0];
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(renderAnchorForPrompt(a));
    }
    const needed = Math.ceil(anchors.size * minRecall);
    lines.push(
      `═══ DATI OBBLIGATORI DALLA FONTE (controllo automatico, non negoziabile) ═══`,
      `La bozza viene RIGETTATA se cita meno di ${needed} di questi ${anchors.size} dati. Riportali TESTUALMENTE, nella forma indicata:`,
    );
    for (const [kind, values] of byKind) {
      lines.push(`- ${ANCHOR_KIND_LABEL_IT[kind] || kind}: ${values.join(', ')}`);
    }
    const pcts = byKind.get('pct') || [];
    if (pcts.length >= 2) {
      lines.push(
        `- Le percentuali sono controllate a parte: perderne due (${pcts.join(', ')}) blocca la pubblicazione da sola. `
        + `Scrivi ogni percentuale spiegando a cosa si riferisce, come fa la fonte.`,
      );
    }
    lines.push(
      `Il controllo è LETTERALE: "${renderAnchorForPrompt([...anchors][0])}" conta solo se compare esattamente così. `
      + `Non parafrasare una cifra ("circa un quarto"), non sostituirla con una formulazione generica.`,
    );
  }

  const src = sourceDate ? new Date(sourceDate) : null;
  const pub = publishedAt ? new Date(publishedAt) : null;
  if (src && !Number.isNaN(src.getTime()) && pub && !Number.isNaN(pub.getTime())) {
    const ageDays = Math.floor((pub.getTime() - src.getTime()) / 86_400_000);
    if (ageDays > maxAgeDays) {
      const monthName = Object.keys(MONTHS_IT).find((k) => MONTHS_IT[k] === src.getUTCMonth() + 1);
      const stamp = `${monthName} ${src.getUTCFullYear()}`;
      lines.push(
        ``,
        `═══ FONTE NON RECENTE (${ageDays} giorni fa) — DATAZIONE OBBLIGATORIA ═══`,
        `DEVI scrivere nel testo la stringa esatta "${stamp}" (es. "secondo quanto comunicato nel ${stamp}"). `
        + `Senza quella datazione esplicita l'articolo viene rigettato perché presenta un fatto vecchio come notizia di oggi. `
        + `Usa i tempi al passato per ciò che è già accaduto e metti in evidenza ciò che è ancora attuale oggi.`,
      );
    }
  }

  return lines.length ? lines.join('\n') : '';
}

/** Returns the subset of `anchors` that the article still mentions. */
export function matchedAnchors(articleText, anchors) {
  const found = new Set();
  if (typeof articleText !== 'string') return found;
  const lower = articleText.toLowerCase();

  for (const anchor of anchors) {
    const [kind, value] = anchor.split(':');
    if (kind === 'pct') {
      const n = Number(value);
      const written = n === 100 ? ['100%', '100 %', 'cento per cento'] : [];
      const it = n.toString().replace('.', ',');
      if (articleText.includes(`${it}%`) || articleText.includes(`${it} %`)
        || written.some((w) => lower.includes(w))) found.add(anchor);
    } else if (kind === 'km') {
      if (new RegExp(String.raw`${Number(value)}\s*km`, 'i').test(articleText)) found.add(anchor);
    } else if (kind === 'date') {
      const [y, mo, d] = value.split('-');
      const monthName = Object.keys(MONTHS_IT).find((k) => MONTHS_IT[k] === Number(mo));
      if (new RegExp(String.raw`${Number(d)}\s*°?\s+${monthName}\s+${y}`, 'i').test(articleText)) found.add(anchor);
    } else if (kind === 'org') {
      if (new RegExp(String.raw`\b${value}\b`, 'i').test(articleText)) found.add(anchor);
    }
  }
  return found;
}

/**
 * Blocks an article that dropped too much of what the source actually said.
 * @param {string} articleText
 * @param {string} sourceText
 * @param {{minRecall?: number, minAnchors?: number}} [opts]
 */
/**
 * Group anchors by the source sentence that carries them, so one sentence is
 * quoted ONCE with every anchor it holds instead of once per anchor.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * `anchorEvidence` hands the writer the source's own sentence for each missing
 * anchor, which is what makes the repair mechanical rather than recalled. But a
 * source sentence rarely carries one number: "l'aliquota ordinaria resta al 5,3%
 * mentre quella ridotta scende all'1,1% e la soglia si ferma all'1,5%" carries
 * three, and it used to be pasted into the prompt three times, verbatim.
 *
 * That is not cosmetic. Every failed attempt re-runs the gates and re-appends
 * their `fix` text — `evidence` is capped at 200 chars, `fix` is not — and the
 * prompt is what the model roster refuses on size: on 2026-08-14 the estimate
 * went 8274 → 9740 tokens in a single retry, and 41 of the ~104 candidate models
 * were skipped pre-flight because the request exceeded their input cap (the most
 * permissive being 8000). Measured on a five-sentence source with clustered
 * anchors: 16 quotations, 5 distinct — 1133 characters, ~283 tokens, of text the
 * writer had already been shown.
 *
 * Deliberately NOT shared across the two gates. `source-key-rates-dropped` and
 * `source-fidelity-low` fire together and their missing sets overlap by
 * construction, so a ledger spanning both would drop a few more repeats — but it
 * was measured at only 43 tokens on top of what grouping already saves (905 →
 * 591 with grouping alone, → 548 with the shared ledger), and it costs the
 * property that every issue is self-contained: the second gate would say "see
 * the sentence quoted above", which is true only while both issues reach the
 * model, in that order, un-truncated by `formatRemediation`'s cap. Forty-three
 * tokens is not worth an invariant that holds by luck of ordering — and
 * `tests/scripts/article-gates-propositive.test.ts` pins the self-containment
 * on purpose ("hands back the source sentence carrying each dropped fact").
 *
 * The instruction is not weakened: every missing anchor is still named, still in
 * the exact literal form `matchedAnchors` credits (via renderAnchorForPrompt),
 * and still next to the source text that proves it. Only the repetition goes.
 *
 * @param sourceText the source body to quote from
 * @param anchorList missing anchors, in the order they should be presented
 * @param bullet line prefix (the two gates indent differently)
 */
function groupedAnchorEvidence(sourceText, anchorList, bullet = '') {
  // Keyed on the FULL, untruncated sentence: two distinct sentences sharing
  // their first 237+ chars would collide on the truncated form and merge
  // under one quotation (see findAnchorSentence). Truncation applies only
  // when the line is rendered below, never to the grouping key.
  /** @type {Map<string, string[]>} evidence sentence → labels it carries */
  const byEvidence = new Map();
  /** @type {Map<string, string[]>} same key → the anchor keys, for truncation */
  const anchorsByEvidence = new Map();
  const withoutEvidence = [];
  for (const a of anchorList) {
    const label = renderAnchorForPrompt(a);
    const evidence = findAnchorSentence(sourceText, a);
    if (!evidence) { withoutEvidence.push(label); continue; }
    if (!byEvidence.has(evidence)) { byEvidence.set(evidence, []); anchorsByEvidence.set(evidence, []); }
    byEvidence.get(evidence).push(label);
    anchorsByEvidence.get(evidence).push(a);
  }
  const lines = [];
  for (const [evidence, labels] of byEvidence) {
    // The anchors of THIS group, so the window keeps a fact the line names
    // instead of the first 237 chars of a sentence that may not carry any.
    const quote = truncateForPrompt(evidence, anchorsByEvidence.get(evidence));
    lines.push(`${bullet}${labels.join(', ')} — la fonte dice: «${quote}»`);
  }
  // Anchors the matcher could not locate in the source degrade to their name
  // only, never to a wrong quote (see anchorEvidence).
  for (const label of withoutEvidence) lines.push(`${bullet}${label}`);
  return lines.join('\n');
}

export function checkSourceFidelity(articleText, sourceText, opts = {}) {
  const issues = [];
  const minRecall = opts.minRecall ?? 0.5;
  const minAnchors = opts.minAnchors ?? 3;

  const anchors = extractSourceAnchors(sourceText);
  // Too few anchors to judge (thin or narrative source) → not a gate.
  if (anchors.size < minAnchors) return issues;

  const found = matchedAnchors(articleText, anchors);

  // Percentages carry the meaning of a tax story, so they get their own gate.
  // The shipped article kept 4/6 anchors overall (recall 67%, above threshold)
  // while dropping exactly the two that mattered — the 80% reduced rate and the
  // Italian 25% substitute tax. Without those the "100%" is unreadable, which
  // is precisely how "100% of the tables" became "100% of your salary".
  const srcPct = [...anchors].filter((a) => a.startsWith('pct:'));
  const missingPct = srcPct.filter((a) => !found.has(a));
  if (srcPct.length >= 2 && missingPct.length >= 2) {
    issues.push(issue(
      'source-key-rates-dropped',
      'critical',
      `L'articolo ha perso ${missingPct.length}/${srcPct.length} delle percentuali della fonte `
      // renderAnchorForPrompt, never `slice(4)`: the raw key is dot-decimal and
      // the recall check only credits the comma form, so quoting the key here
      // asked the writer for a string that could not satisfy the gate quoting it.
      + `(${missingPct.map(renderAnchorForPrompt).join(', ')}) — senza queste il dato resta incomprensibile`,
      `percentuali fonte: ${srcPct.map(renderAnchorForPrompt).join(', ')}`,
      `${groupedAnchorEvidence(sourceText, missingPct)}\n`
      + `Reintegra nel testo le percentuali ${missingPct.map(renderAnchorForPrompt).join(' e ')} spiegando a cosa si riferiscono, `
      + `come fa la fonte. Scrivile ESATTAMENTE nella forma indicata qui sopra: il controllo è letterale e vuole la `
      + `virgola decimale, quindi "5,3%" conta e "5.3%" no — anche se la fonte usa il punto. `
      + `NON rimuovere le altre cifre per "mettere a posto" l'articolo: il problema è che ne mancano, `
      + `non che ce ne siano troppe. Un'aliquota citata senza il suo termine di paragone è incomprensibile per il lettore.`,
    ));
  }

  const recall = found.size / anchors.size;
  if (recall < minRecall) {
    const missing = [...anchors].filter((a) => !found.has(a));
    issues.push(issue(
      'source-fidelity-low',
      'critical',
      `L'articolo conserva solo ${found.size}/${anchors.size} dei fatti verificabili della fonte `
      + `(recall ${(recall * 100).toFixed(0)}% < ${(minRecall * 100).toFixed(0)}%) — omissioni critiche`,
      // Rendered, not raw keys: `evidence` is echoed to the writer too, and a
      // raw `pct:5.3` / `date:2024-01-01` names a string the gate would refuse.
      `mancanti: ${missing.slice(0, 12).map(renderAnchorForPrompt).join(', ')}`,
      // renderAnchorForPrompt, not a local copy: the `date` branch here used to
      // return the raw key, so this instruction asked for "2023-07-17" while
      // matchedAnchors only ever accepts "17 luglio 2023" — a writer that
      // complied exactly still failed the gate, and no retry could converge on
      // a date anchor.
      //
      // Each missing anchor ships with the source sentence that carries it, so
      // the writer reinstates the fact by reusing verified material instead of
      // recalling it (see anchorEvidence).
      // How many more are actually needed to clear the gate, not just "you
      // failed". A writer told only "recall 43% < 50%" cannot tell whether it
      // needs one more fact or fifteen, and across six attempts it has no way
      // to see whether it is converging. Naming the shortfall turns the gate
      // from a verdict into an instruction with a finish line.
      `Ne mancano ${Math.max(1, Math.ceil(anchors.size * minRecall) - found.size)} per superare il controllo `
      + `(ne servono ${Math.ceil(anchors.size * minRecall)} su ${anchors.size}, adesso ne hai ${found.size}). `
      + `Riscrivi ATTENENDOTI alla fonte e reintegra i dati mancanti. `
      + `Per ognuno hai qui sotto la frase della fonte da cui ricavarlo — riusala, non ricostruirla a memoria. `
      + `Scrivi ogni dato nella forma ESATTA indicata qui sotto: il controllo è letterale, `
      + `quindi "5,3%" conta e "5.3%" no, "1 gennaio 2024" conta e "2024-01-01" no.\n`
      + `${groupedAnchorEvidence(sourceText, missing.slice(0, 10), '  • ')}\n`
      + `Ogni dato della fonte è verificato: riportarlo è sempre corretto. Se un fatto ti sembra dubbio, `
      + `attribuiscilo alla fonte invece di ometterlo. Non sostituire i dati della fonte con formulazioni generiche.`,
    ));
  }

  return issues;
}

// ─── 9. Italian ↔ translation numeric consistency ─────────────────────
//
// Everything above judges one body against itself or against its source. This
// judges a TRANSLATION against the Italian it came from — the only vantage
// point from which a translation-time defect is visible at all.
//
// Reading numbers by SHAPE rather than by locale is what makes it usable: the
// corpus mixes conventions inside every locale, and 6.500 CHF and 6,500 CHF
// both occur in English bodies. See canonicalNumeric.

const NUMERIC_KIND_LABEL = {
  pct: 'percentuali', amt: 'importi', km: 'distanze in km', date: 'date',
};

function renderNumericValue(kind, value) {
  if (kind === 'pct') return `${formatItalianNumber(value)}%`;
  if (kind === 'km') return `${formatItalianNumber(value)} km`;
  if (kind === 'date') return String(value);
  return formatItalianNumber(value);
}

/**
 * The digits of a number, ignoring where the separator fell.
 *
 * Leading zeros go (0,25 and 25 are the same digits mis-scaled); trailing
 * zeros STAY. Stripping them too would make 6.000 and 60.000 identical, which
 * is the ordinary transcription slip this check must NOT claim to have
 * diagnosed — 12 of the 28 corpus hits were exactly that shape.
 */
function digitSignature(value) {
  return String(value).replace(/[^0-9]/g, '').replace(/^0+/, '') || '0';
}

/**
 * The Italian value a translated number is a rescaled copy of.
 *
 * Two conditions, and the second one is what makes this check publishable.
 * The ratio must be a whole power of ten AND the two numbers must carry the
 * SAME significant digits. Ratio alone is not evidence: on the live corpus it
 * paired an Italian nursery fee of 70-120 CHF/day with a German rent gap of
 * 800-1.200 EUR/month, and a 50% AVS pro-rata with an unrelated French 5%
 * capital tax — coincidences, because percentages live in a small value space
 * and every article carries dozens of numbers.
 *
 * Same digits + different magnitude is not a coincidence: it is what a botched
 * separator conversion leaves behind. The case that survives the rule is real
 * — `franco-svizzero-minimi-euro` states "465 franchi svizzeri" in Italian and
 * "CHF 4.65" in English, a 100× error introduced purely by re-punctuating.
 */
function rescaledFrom(value, candidates) {
  const signature = digitSignature(value);
  for (const other of candidates) {
    if (digitSignature(other) !== signature) continue;
    for (const factor of [10, 100, 1000, 0.1, 0.01, 0.001]) {
      const scaled = other * factor;
      if (Math.abs(value - scaled) <= Math.max(1e-9, Math.abs(scaled) * 1e-9)) return other;
    }
  }
  return null;
}

/**
 * Below this, a set difference is noise rather than signal.
 *
 * Measured, not guessed. A single missing number is dominated by artefacts the
 * comparison cannot see through: ranges name only one endpoint next to the
 * currency ("da 60.000 a 100.000 franchi" yields 100000, "from CHF 60,000 to
 * 100,000" yields 60000), and translations legitimately merge or reorder
 * clauses. Requiring at least two values AND a quarter of that kind's set
 * concentrates the report on translations that actually lost their figures.
 */
const MIN_NUMERIC_DIVERGENCE = 2;
const MIN_NUMERIC_DIVERGENCE_SHARE = 0.25;

function worthReporting(diverged, total) {
  return diverged.length >= MIN_NUMERIC_DIVERGENCE
    && diverged.length >= total * MIN_NUMERIC_DIVERGENCE_SHARE;
}

/**
 * Compares the numbers of an Italian body against one of its translations.
 *
 * @param {string} italianText
 * @param {string} translatedText
 * @param {string} locale        en | de | fr
 * @param {{maxReported?: number}} [opts]
 */
export function checkTranslationNumericConsistency(italianText, translatedText, locale, opts = {}) {
  const issues = [];
  if (typeof italianText !== 'string' || typeof translatedText !== 'string') return issues;
  if (!italianText.trim() || !translatedText.trim()) return issues;
  const maxReported = opts.maxReported ?? 8;

  const src = extractNumericFacts(italianText, 'it');
  const dst = extractNumericFacts(translatedText, locale);

  for (const kind of ['pct', 'amt', 'km', 'date']) {
    const dropped = [...src[kind]].filter((v) => !dst[kind].has(v));
    const added = [...dst[kind]].filter((v) => !src[kind].has(v));
    const label = NUMERIC_KIND_LABEL[kind];

    // A date carries no magnitude, so it can never be a rescaled other date.
    if (kind !== 'date') {
      for (const value of added) {
        const original = rescaledFrom(value, dropped);
        if (original === null) continue;
        issues.push(issue(
          'translation-number-magnitude',
          'critical',
          `[${locale}] ${renderNumericValue(kind, value)} nella traduzione dove l'italiano scrive `
          + `${renderNumericValue(kind, original)} — stessa cifra, ordine di grandezza diverso`,
          `it: ${renderNumericValue(kind, original)} → ${locale}: ${renderNumericValue(kind, value)}`,
          `Riporta il valore dell'italiano: ${renderNumericValue(kind, original)}. `
          + `Le due cifre hanno le stesse cifre significative e differiscono per un fattore esatto di 10, `
          + `quindi non è un arrotondamento ma una conversione sbagliata del separatore `
          + `(l'italiano scrive 60.000 e 0,25 dove l'inglese scrive 60,000 e 0.25). Correggi la cifra, non cancellarla.`,
        ));
      }
    }

    if (worthReporting(dropped, src[kind].size)) {
      issues.push(issue(
        'translation-number-dropped',
        'major',
        `[${locale}] ${dropped.length}/${src[kind].size} ${label} dell'italiano assenti dalla traduzione`,
        dropped.slice(0, maxReported).map((v) => renderNumericValue(kind, v)).join(', '),
        `Reintegra nella versione ${locale} i valori mancanti così come li scrive l'italiano. `
        + `Se un passaggio è stato riassunto, il riassunto deve comunque conservare le cifre: `
        + `un lettore non italiano non ha modo di recuperarle.`,
      ));
    }

    if (worthReporting(added, dst[kind].size)) {
      issues.push(issue(
        'translation-number-added',
        'major',
        `[${locale}] ${added.length}/${dst[kind].size} ${label} della traduzione assenti dall'italiano`,
        added.slice(0, maxReported).map((v) => renderNumericValue(kind, v)).join(', '),
        `Una traduzione non introduce dati nuovi. Rimuovi dalla versione ${locale} i valori che `
        + `l'italiano non riporta, oppure — se il dato è giusto e manca all'italiano — aggiungilo prima all'italiano.`,
      ));
    }
  }

  return issues;
}

// ─── 10. Professions invented in translation ──────────────────────────
//
// A "frontaliere" is a cross-border COMMUTER. Every target language has a
// similar-looking word for a border GUARD, and the translation step reached for
// it: 7 English titles/excerpts shipped calling this site's entire audience
// "border guards", plus one French "gardes-frontières". Fixed by hand on
// 2026-07-28 — no gate saw them, because no gate ever read a translation.

/**
 * Flags a profession the translation invented out of "frontalieri".
 *
 * LIMIT, stated plainly: this does not read the sentence, so it cannot tell a
 * mistranslated commuter from a genuine customs officer on its own. It defers
 * to the Italian instead — if the Italian body names a guard, a customs
 * officer, a finanziere or the dogana anywhere, the check stays silent for the
 * whole article. That is a deliberate loss of recall: an article that discusses
 * BOTH real border guards and frontalieri will not be checked at all. It buys
 * the precision the gate needs to block, and it is why the anchor list is
 * broad enough to include plain "dogana".
 *
 * @param {string} italianText    the Italian original
 * @param {string} translatedText the translation to judge
 * @param {string} locale         en | de | fr
 */
export function checkTranslationFalseFriends(italianText, translatedText, locale) {
  const issues = [];
  if (typeof italianText !== 'string' || typeof translatedText !== 'string') return issues;
  const patterns = FALSE_FRIEND_PATTERNS[locale];
  if (!patterns) return issues;
  if (ITALIAN_BORDER_GUARD_ANCHOR.test(italianText)) return issues;

  for (const { re, correct } of patterns) {
    const m = translatedText.match(re);
    if (!m) continue;
    const at = translatedText.indexOf(m[0]);
    issues.push(issue(
      'translation-false-friend',
      'critical',
      `[${locale}] "${m[0]}" traduce "frontalieri": è la guardia di confine, un mestiere diverso `
      + `— l'italiano non nomina mai guardie, dogane o finanzieri`,
      translatedText.slice(Math.max(0, at - 70), at + 70).replace(/\n/g, ' ').trim(),
      `Sostituisci "${m[0]}" con "${correct}". "Frontaliere" è chi RISIEDE in Italia e LAVORA in Svizzera, `
      + `non chi presidia il confine. Correggi ogni occorrenza nel testo, nel titolo e nell'excerpt.`,
    ));
  }

  return issues;
}

// ─── Orchestrator ─────────────────────────────────────────────────────

/**
 * Content claims whose source of truth is the Italian body, not the translation.
 *
 * A translation restates what the Italian says; it does not decide whether a
 * tax exceeds an income. So when one of these fires on a translation and NOT
 * on the Italian it derives from, the likelier explanation is the translated
 * cue list, not a defect in the article — and the corpus says so plainly:
 * every one of the 14 surviving `tax-exceeds-income` reports on en/de/fr had
 * no Italian counterpart, and all five read by hand were misreadings of word
 * order ("500,000 francs income", "4.000 Franken brutto", "IRPEF brute").
 *
 * They stay reported, because a translation CAN mangle a figure badly enough
 * to invert a ratio — they simply stop blocking on their own evidence.
 * Structural defects are not in this set: an unclosed `**` in the German body
 * is the German body's own defect and keeps blocking.
 */
const ITALIAN_ADJUDICATED_CODES = new Set([
  'tax-exceeds-income', 'contradictory-figures', 'arithmetic-error', 'percent-factor-mismatch',
]);

/**
 * Demotes a translation-only content claim to `major`, saying why in the text.
 * Issues the Italian raises too are left alone: those are real, and blocking
 * them once on the Italian body is enough.
 */
function adjudicateAgainstItalian(issues, italianCodes) {
  return issues.map((i) => {
    if (i.severity !== 'critical') return i;
    if (!ITALIAN_ADJUDICATED_CODES.has(i.code)) return i;
    if (italianCodes.has(i.code)) return i;
    return {
      ...i,
      severity: 'major',
      message: `${i.message} — non presente nell'italiano, quindi verosimilmente `
        + 'un limite del riconoscimento nella lingua di destinazione: da verificare a mano, non bloccante',
    };
  });
}

/**
 * Runs every deterministic gate.
 *
 * On a translation (`locale` != 'it') only the checks decidable without
 * Italian-specific knowledge run — truncation, arithmetic, tax plausibility,
 * cross-section conflicts — plus the two cross-locale checks, and those only
 * when `italianSections` is supplied. The four that are skipped are skipped on
 * purpose, not for lack of time: the institution allowlist, the norm-date
 * predicates and the future-tense markers are Italian vocabulary whose
 * translated equivalents would each need their own hand-tuned allowlist, and
 * the source-fidelity gate has already judged the Italian this text derives
 * from — re-running it here would only restate the same finding four times.
 *
 * `memory` is the OPTIONAL learned-defence input (see article-defect-memory.mjs).
 * Omitting it reproduces the pre-learning behaviour exactly — the curated lists
 * still apply — which is what the corpus retro-audit wants and what keeps this
 * change safe to roll back by deleting one argument.
 *
 * The returned `observations` are this run's contribution BACK to the memory.
 * They are returned rather than written here on purpose: a gate that mutates
 * persistent state while deciding whether to block would be judging a corpus
 * it is concurrently editing, and would learn from drafts that never ship.
 * The caller persists them once, after the run's outcome is known.
 *
 * @param {{sections: Record<string,string>, sourceText?: string,
 *          sourceDate?: string|Date, publishedAt?: string|Date,
 *          locale?: string, italianSections?: Record<string,string>,
 *          options?: object,
 *          memory?: {denylist?: Set<string>, suspects?: Set<string>, degraded?: string|null}}} params
 * @returns {{passed: boolean, issues: object[], blocking: object[], observations: object[]}}
 */
export function runFactualityGates(params = {}) {
  const {
    sections = {}, sourceText = '', sourceDate, publishedAt,
    locale = 'it', italianSections = null, options = {}, memory = {},
  } = params;
  const joined = (obj) => Object.values(obj).filter((v) => typeof v === 'string').join('\n\n');
  const fullText = joined(sections);
  const localeOptions = { ...options, locale };

  let issues = [];
  for (const [label, text] of Object.entries(sections)) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const sectionLabel = locale === 'it' ? label : `${locale}/${label}`;
    issues.push(...detectTruncation(text, { label: sectionLabel }));
    issues.push(...detectLeakedScaffolding(text, { label: sectionLabel }));
  }
  issues.push(...checkInlineArithmetic(fullText, localeOptions));
  issues.push(...checkTaxPlausibility(fullText, localeOptions));
  issues.push(...checkCrossSectionNumericConflicts(sections, localeOptions));
  // Fuori dal ramo `locale === 'it'` di proposito: una sigla normativa
  // inventata resta identica in de/fr/en (vedi checkFabricatedNormAcronyms),
  // quindi il giorno in cui le traduzioni passeranno di qui il controllo
  // c'è già e non va ricordato. `critical` → finisce in `blocking`, e il
  // chiamante rigetta l'articolo (create-article.mjs, `if (!gateResult.passed)`).
  issues.push(...checkFabricatedNormAcronyms(fullText, localeOptions));

  if (locale === 'it') {
    issues.push(...checkFabricatedInstitutionAcronyms(fullText, {
      learnedDenylist: memory.denylist,
      learnedSuspects: memory.suspects,
      memoryDegraded: memory.degraded,
    }));
    issues.push(...checkContradictoryNormDates(fullText));
    issues.push(...checkSourceFreshness({ sourceDate, publishedAt, text: fullText, ...options }));
    if (sourceText && sourceText.length >= 100) {
      issues.push(...checkSourceFidelity(fullText, sourceText, options));
    }
  } else if (italianSections) {
    const italianText = joined(italianSections);

    // What the Italian says about its own numbers, used to adjudicate the
    // content claims above — see ITALIAN_ADJUDICATED_CODES.
    const italianCodes = new Set([
      ...checkInlineArithmetic(italianText, options),
      ...checkTaxPlausibility(italianText, options),
      ...checkCrossSectionNumericConflicts(italianSections, options),
    ].map((i) => i.code));
    issues = adjudicateAgainstItalian(issues, italianCodes);

    issues.push(...checkTranslationNumericConsistency(italianText, fullText, locale, options));
    issues.push(...checkTranslationFalseFriends(italianText, fullText, locale));
  } else {
    // A translation judged with no Italian to judge it against. Every
    // cross-locale check above needs the reference, so all three go quiet —
    // and quiet is the problem: a wrong article id or a stale cache on the
    // caller's side would disable the entire translation-fidelity layer while
    // the audit still printed a reassuring "0 blocking" for that locale.
    //
    // Say so instead. `major`, not `critical`: the missing reference is a
    // wiring fault, not evidence about the article, and blocking on it would
    // punish the content for the harness being wrong. But it is never silent.
    issues.push(issue(
      'translation-unadjudicated',
      'major',
      `[${locale}] Traduzione valutata senza il testo italiano di riferimento — `
      + 'i controlli di fedeltà (numeri, falsi amici, ordini di grandezza) NON sono stati eseguiti',
      '',
      `Passa \`italianSections\` a runFactualityGates() per il locale "${locale}". `
      + "Se l'articolo esiste solo come traduzione, senza originale italiano, allora non c'è "
      + 'riferimento contro cui verificarlo e il verdetto su questo locale va letto come parziale.',
    ));
  }

  // Institution acronyms are an Italian-vocabulary observation, and the learner
  // that consumes them is keyed on the acronym alone. Harvesting the same
  // acronym four times, once per locale, would quadruple every sighting count
  // and promote unknowns to CONFIRMED on one article's evidence.
  const observations = locale === 'it' ? collectInstitutionAcronyms(fullText, { sourceText }) : [];

  issues.sort((a, b) => (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0));
  const blocking = issues.filter((i) => i.severity === 'critical');
  return { passed: blocking.length === 0, issues, blocking, observations };
}

/** Human-readable one-line-per-issue rendering for CI logs. */
export function formatIssues(issues) {
  const icon = { critical: '🚨', major: '⚠️', minor: 'ℹ️' };
  return (issues || [])
    .map((i) => `  ${icon[i.severity] || '•'} [${i.code}] ${i.message}`
      + `${i.evidence ? `\n       ↳ ${i.evidence}` : ''}`
      + `${i.fix ? `\n       🔧 ${i.fix}` : ''}`)
    .join('\n');
}

/**
 * The fact-check prompt's category vocabulary — the single source of truth.
 *
 * create-article.mjs renders the prompt's "Categorie valide:" line from this
 * list, and REMEDIATION_BY_CATEGORY below is keyed on it. Keeping the two in
 * one place means a new category cannot silently ship without remediation text
 * (which would drop the "CORREZIONE RICHIESTA" line for those issues and give
 * the rewrite loop nothing to act on). A test asserts the two stay in sync.
 */
export const FACT_CHECK_CATEGORIES = [
  'leggi', 'istituzioni', 'aliquote', 'statistiche', 'date', 'coerenza',
  'fatti_inventati', 'persone', 'geografia', 'eu_svizzera', 'rilevanza_topica',
];

// Fallback remediation for LLM-verifier issues, which carry a free-text reason
// but no structured fix. Keyed on the checker's own category vocabulary.
const REMEDIATION_BY_CATEGORY = {
  leggi: 'Verifica estremo per estremo il riferimento normativo (tipo di atto, numero, anno) contro la fonte. '
    + 'Se la fonte non lo riporta, cita la norma solo come la nomina la fonte, senza aggiungere numeri o date che non ci sono.',
  istituzioni: "Usa il nome ufficiale dell'ente così come compare nella fonte. Non introdurre acronimi che la fonte non usa "
    + "e non attribuire un fatto a un ente diverso da quello citato (in particolare: non confondere un ufficio cantonale con uno federale).",
  aliquote: "Riporta l'aliquota esattamente come nella fonte, con il termine di paragone che la rende leggibile "
    + '(rispetto a cosa aumenta o diminuisce). Non arrotondare e non convertire una percentuale in un importo senza base esplicita.',
  statistiche: 'Ogni statistica deve essere attribuita a chi l\'ha prodotta e presente nella fonte. '
    + 'Se non lo è, rimuovi il numero e mantieni l\'affermazione qualitativa, senza inventare una cifra al suo posto.',
  date: 'Allinea le date alla fonte. Se la fonte non dà una data, non dedurla: descrivi il momento come fa la fonte.',
  coerenza: 'Riallinea il passaggio alla fonte. Se la fonte lo dice, riportalo (anche alla lettera); '
    + 'se non lo dice, toglilo. Non sostituirlo con una formulazione più vaga che dice la stessa cosa senza appoggio.',
  fatti_inventati: "Elimina l'episodio, la dichiarazione o il caso concreto: non risulta dalla fonte. "
    + 'Non rimpiazzarlo con un altro esempio inventato — se serve un esempio, presentalo come scenario esplicitamente ipotetico.',
  persone: 'Cita solo persone e ruoli presenti nella fonte, con il ruolo esatto che la fonte attribuisce loro.',
  geografia: 'Correggi il riferimento geografico: verifica da che parte del confine si trova ogni località citata '
    + "e che il ruolo (comune di residenza vs comune di lavoro) sia quello giusto.",
  eu_svizzera: 'La Svizzera non è membro UE né SEE. Riformula in termini di Accordi Bilaterali.',
  rilevanza_topica: 'Il nesso con il frontaliere Ticino-Italia deve essere reale e presente nella fonte. '
    + 'Se non c\'è, non forzarlo con paragrafi di consigli generici: l\'articolo non va scritto.',
  infra: 'La verifica non è stata eseguita: l\'articolo non può essere pubblicato in questo stato.',
};

/**
 * Renders issues as CORRECTIVE INSTRUCTIONS for the regeneration prompt.
 *
 * The regeneration loop used to receive a bare list of complaints. Faced with
 * "questo claim non è nella fonte" and no instruction, the writer's cheapest
 * move is deletion — which is how the 2026-07-28 article lost every real fact
 * it had and kept only the invented ones. Telling it exactly what to change,
 * with the corrected values, makes repair cheaper than removal.
 *
 * @param {object[]} issues
 * @param {{cap?: number}} [opts]
 */
export function formatRemediation(issues, opts = {}) {
  const cap = opts.cap ?? 8;
  const list = (issues || []).slice(0, cap);
  if (!list.length) return '';

  const lines = list.map((i, n) => {
    const what = i.message || i.reason || '';
    const how = i.fix || REMEDIATION_BY_CATEGORY[i.category] || '';
    const where = i.evidence || i.claim || '';
    return [
      `${n + 1}. PROBLEMA: ${what}`,
      where ? `   TESTO: "${String(where).slice(0, 180)}"` : '',
      how ? `   CORREZIONE RICHIESTA: ${how}` : '',
    ].filter(Boolean).join('\n');
  });

  const overflow = (issues || []).length > cap
    ? `\n(+${issues.length - cap} altri problemi dello stesso tipo: applica la stessa correzione a tutto il testo.)`
    : '';

  return `Il testo precedente è stato RESPINTO. Correggi i punti seguenti e restituisci l'articolo completo.

REGOLA GENERALE: correggi, non cancellare. Rimuovere un passaggio problematico invece di sistemarlo
peggiora l'articolo: i fatti della fonte devono restare, con i numeri giusti. Non accorciare il testo
per far passare i controlli, e non sostituire dati precisi con formule generiche.

${lines.join('\n\n')}${overflow}`;
}
