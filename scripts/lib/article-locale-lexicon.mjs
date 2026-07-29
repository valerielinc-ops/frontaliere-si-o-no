/**
 * Per-locale vocabulary and number handling for the factuality gates.
 *
 * WHY THIS FILE EXISTS. The gates in `article-factuality-gates.mjs` were written
 * against the Italian body only, because generation happens in Italian and the
 * other three locales are translations of it. That covers the GENERATION step
 * and nothing else — a defect introduced by the TRANSLATION step was, until
 * 2026-07-28, caught by nobody.
 *
 * It was not hypothetical. "frontalieri" (cross-border commuters) shipped as
 * "border guards" in 7 English titles/excerpts and as "gardes-frontières" in a
 * French one: a different profession entirely, on a site whose entire audience
 * is cross-border commuters. Found by hand. No gate would have seen it.
 *
 * Extending the gates therefore needs two things the Italian-only code never
 * had, and both are shared by more than one caller — so per AGENTS.md #6 they
 * live here once rather than being copied per check:
 *
 *   1. A LEXICON. `CURRENCY`, `INCOME_CUE`, `TAX_CUE` and the time-base cues
 *      were Italian string literals inside the gate functions. The Italian
 *      entries below are those literals, moved verbatim: the Italian gate
 *      behaviour is unchanged by construction, not by inspection.
 *
 *   2. NUMBER CANONICALISATION. Italian writes 60.000 and 0,25 where English
 *      writes 60,000 and 0.25, and the corpus mixes both inside a single locale
 *      (translations frequently keep the Italian punctuation). Comparing raw
 *      strings across locales, or trusting the locale label, produces nothing
 *      but noise — measured, not assumed: an early locale-keyed parser scored
 *      6.500 CHF (it) against 6,500 CHF (en) as a mismatch on ~700 articles.
 *      `canonicalNumeric` below ignores the locale and reads the SHAPE instead.
 */

// ─── Numbers ──────────────────────────────────────────────────────────
//
// A group separator is a dot, a comma, an apostrophe (Swiss 80'000) or any of
// the spaces French uses (70 000, plus NBSP and narrow NBSP). The apostrophe
// form is allowed to carry stray whitespace: 113 German bodies contain
// "CHF 80 '000" and "CHF 120' 000", the translation step having inserted a
// space next to the apostrophe. Tolerating it here is what keeps those from
// being read as the number 80 — i.e. from being reported as a 1000× error that
// the text does not actually contain.
const GROUP_SEP = String.raw`(?:[.,]|\s*['’]\s*|[    ])`;

/**
 * Regex SOURCE (not a RegExp) for one written number, in any of the four
 * locales' conventions. Grouped forms must use exact 3-digit groups, which is
 * what stops "In 2023, 20% of" from being read as the number 202320.
 */
export const NUMBER_TOKEN = String.raw`\d{1,3}(?:${GROUP_SEP}\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;

/**
 * Reads a number written in ANY of the four locales' conventions.
 *
 * Locale-agnostic on purpose: the separator role is decided by shape, not by
 * the file the string came from. A dot or comma followed by exactly three
 * digits groups thousands; anything else is the decimal mark. So 60.000,
 * 60,000, 60'000 and 60 000 all read 60000, while 0,45 and 0.45 both read 0.45.
 *
 * The one genuinely ambiguous form, "1,500" meaning one-and-a-half, does not
 * occur in this corpus (prose writes 1,5) and is resolved as 1500.
 *
 * Returns NaN when the token is not a number.
 */
export function canonicalNumeric(raw) {
  if (typeof raw !== 'string') return NaN;
  const t = raw.replace(/\s*['’]\s*/g, '').replace(/[    ]/g, '');
  if (!/^\d+(?:[.,]\d+)*$/.test(t)) return NaN;

  const parts = t.split(/[.,]/);
  if (parts.length === 1) return Number(parts[0]);

  const tail = parts.slice(1);
  if (tail.every((g) => g.length === 3)) return Number(parts.join(''));

  // The last separator is the decimal mark; every earlier one must still be a
  // well-formed thousands group, otherwise the token is not a number at all.
  const head = parts.slice(0, -1);
  if (!head.slice(1).every((g) => g.length === 3)) return NaN;
  return Number(`${head.join('')}.${tail[tail.length - 1]}`);
}

/**
 * Scale words, so "140 milioni di franchi" and "CHF 140 million" land on the
 * same value. Without this the two sides of a correct translation disagree by
 * six orders of magnitude and every article quoting a public budget is flagged.
 */
const SCALE_WORD = String.raw`(?:mila|migliaia|milion\w*|miliard\w*|thousands?|millions?|billions?|Tausend|Millionen?|Milliarden?|Mio\.?|Mrd\.?|mille|milliers?|milliards?)`;
const SCALE_FACTORS = [
  [/^(?:mila|migliaia|thousands?|tausend|mille|milliers?)$/i, 1e3],
  [/^(?:milion\w*|millions?|millionen|million|mio\.?)$/i, 1e6],
  [/^(?:miliard\w*|billions?|milliarden?|milliards?|mrd\.?)$/i, 1e9],
];

/** Multiplier carried by a scale word; 1 for none/unknown. */
export function scaleFactor(word) {
  if (!word) return 1;
  for (const [re, mul] of SCALE_FACTORS) if (re.test(word.trim())) return mul;
  return 1;
}

// ─── Lexicon ──────────────────────────────────────────────────────────
//
// `currency`, `incomeCue` and `taxCue` drive checkTaxPlausibility and
// checkCrossSectionNumericConflicts: an amount counts as income when an income
// cue introduces it, and as tax when a tax cue sits between it and the income.
//
// The non-Italian cue lists are deliberately NARROWER than a dictionary would
// be. English "pay" is the obvious omission: it is the tax verb ("pays 6,000")
// and the income noun ("pay of 60,000") at once, so including it makes the two
// roles collide and manufactures impossible-tax reports out of correct prose.
// A missed defect in a translation costs one uncaught article; a false positive
// costs every article that uses the word.

/** Month name → number, per locale. Accentless spellings are accepted too. */
const MONTHS = {
  it: {
    gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
    luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
  },
  en: {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  },
  de: {
    januar: 1, februar: 2, 'märz': 3, marz: 3, april: 4, mai: 5, juni: 6,
    juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
  },
  fr: {
    janvier: 1, 'février': 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
    juillet: 7, 'août': 8, aout: 8, septembre: 9, octobre: 10, novembre: 11,
    'décembre': 12, decembre: 12,
  },
};

export const LOCALE_LEXICON = {
  it: {
    months: MONTHS.it,
    // Moved verbatim from article-factuality-gates.mjs — do not "tidy".
    currency: String.raw`(?:franchi\s+svizzeri|franchi|CHF|euro|EUR|€)`,
    incomeCue: /(?:reddito|guadagn\w*|stipendio|salario|retribuzione|percep\w*)[^.\n]{0,40}?$/i,
    taxCue: /(?:impost\w*|tass\w*|pag\w*|trattenut\w*|prelievo|carico\s+fiscale|quota\s+di\s+imposta)/i,
    // Moved verbatim from periodOf(); matched against an already-lowercased
    // 40-char tail, which is why none of these carry the `i` flag.
    periods: [
      ['month', /\b(al|a|ogni|per)\s+mese|mensil|\/mese/],
      ['year', /\b(all'anno|annu|ogni\s+anno|\/anno)/],
      ['week', /\b(a|alla|per)\s+settimana|settimanal/],
      ['hour', /\b(al|all'|per)\s*ora|orari/],
    ],
  },
  en: {
    months: MONTHS.en,
    currency: String.raw`(?:Swiss\s+francs?|francs?|CHF|euros?|EUR|€)`,
    incomeCue: /(?:income|earnings|salary|salaries|wages?|remuneration|gross)[^.\n]{0,40}?$/i,
    taxCue: /(?:tax\w*|withhold\w*|levy|levies|deduct\w*|owed?|due|remit\w*)/i,
    periods: [
      ['month', /\b(per|a|each|every)\s+month|monthly|\/month/],
      ['year', /\b(per|a|each|every)\s+year|annually|yearly|per\s+annum|\/year/],
      ['week', /\b(per|a|each|every)\s+week|weekly|\/week/],
      ['hour', /\b(per|an|each|every)\s+hour|hourly|\/hour/],
    ],
  },
  de: {
    months: MONTHS.de,
    currency: String.raw`(?:Schweizer\s+Franken|Franken|Francs?|CHF|Euros?|EUR|€)`,
    incomeCue: /(?:Einkommen\w*|L(?:o|ö)hn\w*|Lohn\w*|Gehalt\w*|Verdienst\w*|verdien\w*|Brutto\w*|Entgelt\w*)[^.\n]{0,40}?$/i,
    taxCue: /(?:Steuer\w*|steuer\w*|Quellensteuer\w*|Abz(?:u|ü)g\w*|Abgabe\w*|besteuer\w*)/i,
    // Lowercase on purpose: periodOf() lowercases the tail before testing, so
    // German nouns must be written lowercase here or they never match.
    periods: [
      ['month', /\b(pro|im|je)\s+monat|monatlich|\/monat/],
      ['year', /\b(pro|im|je)\s+jahr|j(ä|ae)hrlich|\/jahr/],
      ['week', /\b(pro|je)\s+woche|w(ö|oe)chentlich|\/woche/],
      ['hour', /\b(pro|je)\s+stunde|st(ü|ue)ndlich|\/stunde/],
    ],
  },
  fr: {
    months: MONTHS.fr,
    currency: String.raw`(?:francs?\s+suisses?|francs?|CHF|euros?|EUR|€)`,
    incomeCue: /(?:revenus?|salaires?|r(?:é|e)mun(?:é|e)ration\w*|gagn\w*|brut)[^.\n]{0,40}?$/i,
    taxCue: /(?:imp(?:ô|o)t\w*|taxes?|pr(?:é|e)l(?:è|e)vement\w*|retenue\w*|charge\s+fiscale|cotisation\w*)/i,
    periods: [
      ['month', /\b(par|le)\s+mois|mensuel|\/mois/],
      ['year', /\bpar\s+an\b|annuel|\/an\b/],
      ['week', /\b(par|la)\s+semaine|hebdomadaire|\/semaine/],
      ['hour', /\b(par|de\s+l')\s*heure|horaire|\/heure/],
    ],
  },
};

/** The lexicon for `locale`, falling back to Italian for anything unknown. */
export function lexiconFor(locale) {
  return LOCALE_LEXICON[locale] || LOCALE_LEXICON.it;
}

// ─── Numeric facts, for the Italian↔translation comparison ────────────

/** Union of all four currency vocabularies: translations mix them freely. */
const ANY_CURRENCY = String.raw`(?:franchi\s+svizzeri|franchi|francs?\s+suisses?|Schweizer\s+Franken|Franken|francs?|CHF|euros?|EUR|€)`;

/**
 * Paragraphs the Italian body carries and the translations never do.
 *
 * `create-article` appends an Italian-only "## Tool utili per il tuo caso" CTA
 * with internal (nav:) links AFTER translation, to 581 of the 3573 bodies. It
 * mentions "20 km", so comparing raw bodies reported a dropped distance in ~650
 * articles — the single largest source of noise measured, and pure artefact.
 */
function withoutUntranslatedBlocks(text) {
  return text.split(/\n{2,}/).filter((p) => !p.includes('](nav:')).join('\n\n');
}

/**
 * Extracts the numbers a translation must preserve, normalised so that the
 * Italian and the translated spelling of the same number collide.
 *
 * @param {string} text
 * @param {string} locale used only to pick month names; numbers are shape-read
 * @returns {{pct: Set<number>, amt: Set<number>, km: Set<number>, date: Set<string>}}
 */
export function extractNumericFacts(text, locale = 'it') {
  const out = {
    pct: new Set(), amt: new Set(), km: new Set(), date: new Set(),
  };
  if (typeof text !== 'string' || !text.trim()) return out;
  const t = withoutUntranslatedBlocks(text);

  for (const m of t.matchAll(new RegExp(String.raw`(${NUMBER_TOKEN})\s*%`, 'g'))) {
    const v = canonicalNumeric(m[1]);
    if (Number.isFinite(v)) out.pct.add(v);
  }

  // Both orders: Italian prose writes "60.000 CHF", English and the Swiss house
  // style write "CHF 60,000". Matching only one of them made every article
  // using the other convention look like it had lost all of its amounts.
  const amountRe = new RegExp(
    String.raw`(?:(${NUMBER_TOKEN})\s*(?:(${SCALE_WORD})\s*)?(?:di\s+|de\s+|of\s+)?${ANY_CURRENCY}\b`
    + String.raw`|${ANY_CURRENCY}\s*(${NUMBER_TOKEN})\s*(?:(${SCALE_WORD})\b)?)`,
    'gi',
  );
  for (const m of t.matchAll(amountRe)) {
    const v = canonicalNumeric(m[1] ?? m[3]) * scaleFactor(m[2] ?? m[4]);
    if (Number.isFinite(v) && v > 0) out.amt.add(v);
  }

  for (const m of t.matchAll(new RegExp(String.raw`(${NUMBER_TOKEN})\s*(?:km|chilometri|kilomet\w*)\b`, 'gi'))) {
    const v = canonicalNumeric(m[1]);
    if (Number.isFinite(v)) out.km.add(v);
  }

  // Both "31 dicembre 2018" / "31. Dezember 2018" and the English
  // "December 31, 2018". Keyed on the ISO date so spellings collapse.
  const months = lexiconFor(locale).months;
  const names = Object.keys(months).join('|');
  const dateRe = new RegExp(
    String.raw`(\d{1,2})\s*[°.]?\s+(${names})\s+(\d{4})|(${names})\s+(\d{1,2}),?\s+(\d{4})`,
    'gi',
  );
  for (const m of t.matchAll(dateRe)) {
    const day = Number(m[1] ?? m[5]);
    const month = months[(m[2] ?? m[4]).toLowerCase()];
    const year = Number(m[3] ?? m[6]);
    if (month && day >= 1 && day <= 31) {
      out.date.add(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }

  return out;
}

// ─── False friends ────────────────────────────────────────────────────
//
// "Frontaliere" is a cross-border COMMUTER. Every locale has a similar-looking
// word for a border GUARD, and the translation step reached for it: 7 English
// titles/excerpts and 1 French excerpt shipped that way before being fixed by
// hand on 2026-07-28.
//
// The pattern alone is not enough to accuse a translation, because some
// articles really are about customs officers. What settles it is the Italian
// source: if the Italian body never mentions a guard, a customs officer or the
// Guardia di Finanza, then "border guards" in the translation can only have
// come from "frontalieri". That anchor is what takes the English body sweep
// from 101 hits to 59, and all 59 sampled read as genuine mistranslations.

export const FALSE_FRIEND_PATTERNS = {
  en: [{
    re: /\b(?:border|frontier)\s+guards?\b/i,
    correct: 'cross-border worker(s) / cross-border commuter(s)',
  }],
  de: [{
    re: /\bGrenzw(?:ä|ae)chter\w*|\bGrenzsch(?:ü|ue)tzer\w*|\bGrenzbeamt\w*/i,
    correct: 'Grenzgänger',
  }],
  fr: [{
    re: /\bgardes?[-\s]fronti(?:è|e)res?\b/i,
    correct: 'travailleur(s) frontalier(s)',
  }],
};

/**
 * Italian terms that make a border-guard mention in the translation legitimate.
 * Deliberately broad — including plain "dogana" — because suppressing a real
 * defect costs one article while accusing a correct translation costs trust in
 * the whole gate.
 */
export const ITALIAN_BORDER_GUARD_ANCHOR = /guardi\w*\s+(?:di\s+)?(?:confin\w*|frontier\w*)|guardie\s+confinari\w*|doganier\w*|finanzier\w*|guardia\s+di\s+finanza|polizia\s+di\s+frontiera|corpo\s+delle\s+guardie|dogan\w*|\bUDSC\b|\bAFD\b|\bBAZG\b/i;
