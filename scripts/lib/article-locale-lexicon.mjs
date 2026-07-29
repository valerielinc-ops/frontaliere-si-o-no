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
 *      "Verbatim" is load-bearing and was nearly lost. This file and the
 *      2026-07-29 precision pass on the Italian tax cues were written in
 *      parallel, and the first merge attempt carried the PRE-precision Italian
 *      literals — which would have taken `tax-implausible` back from 2 to 15
 *      reports on the same corpus. The Italian entries here are therefore the
 *      post-precision ones, and the corpus audit run on `--locale it` is the
 *      check that says so: 3575 scanned, 153 flagged, 48 blocking.
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
  // Apostrophes group unconditionally, tolerating the stray spaces the German
  // bodies carry ("80 '000"). A bare space groups ONLY when followed by exactly
  // three digits: without that guard "2023, 20" — a year and the start of a
  // list — collapsed into the number 2023,20.
  const t = raw
    .replace(/\s*['’]\s*/g, '')
    .replace(/[   ]/g, '')
    .replace(/ (?=\d{3}(?!\d))/g, '');
  if (!/^\d+(?:[.,]\d+)*$/.test(t)) return NaN;

  const parts = t.split(/[.,]/);
  if (parts.length === 1) return Number(parts[0]);

  const tail = parts.slice(1);
  // A number that opens on a bare 0 has no thousands to group, so its separator
  // is the decimal mark whatever follows it. Without this the rate "0.032" read as
  // the integer 32 — three digits after a separator look exactly like a thousands
  // group — and the arithmetic gate then rejected "0.032 x 60,000 = 1,920", which
  // is correct English prose.
  if (parts[0] !== '0' && tail.every((g) => g.length === 3)) return Number(parts.join(''));

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
// These seven entries drive incomeTaxPairs() in article-factuality-gates.mjs:
// an amount is an income when an income cue introduces it (or a genitive cue
// trails it), and its tax when a tax cue sits between the two — unless a
// threshold marker or a non-tax noun sits closer to the figure.
//
// The Italian entries are that file's own literals, moved unchanged. Each one
// encodes a false positive that was measured on the live corpus and is
// documented at its definition there; do not "tidy" them.
//
// The non-Italian cue lists are deliberately NARROWER than a dictionary would
// be, and every omission below is a measured one:
//
//   - English "pay" is absent from taxCue. It is the tax verb ("pays 6,000")
//     and the income noun ("pay of 60,000") at once, so it makes the two roles
//     collide. Italian has the same collision and accepts it because THRESHOLD
//     and NON_TAX cues fence it in; English "due"/"owed" have no such fence —
//     "due to" alone produced 32 impossible-tax reports out of correct prose
//     (`universita-ticino-frontalieri`, `crescita-economica-ticino-2026`).
//   - French "cotisation" is absent for the same reason: social contributions
//     are quoted per hour next to a minimum wage and are not a tax on it
//     (`lavoretti-estivi-2026-regole-frontalieri`).
//
// A missed defect in a translation costs one uncaught article; a false positive
// costs every article that uses the word. The asymmetry is the whole design.

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

    // Every entry below is moved verbatim from article-factuality-gates.mjs as
    // of the 2026-07-29 precision pass — the state in which the Italian corpus
    // audit reads 153 flagged articles, 48 blocking and 2 `tax-implausible`.
    // The comment on each one is the false positive it was written to kill,
    // kept here because the constant is now the only place it is visible.

    currency: String.raw`(?:franchi\s+svizzeri|franchi|CHF|euro|EUR|€)`,

    // Capture group 2 is the text between the cue word and the amount: whatever
    // sits in that gap is closer to the figure than the income word is, and wins.
    // "Un residente con lo stesso stipendio lordo PAGA CIRCA 900 franchi di tasse"
    // opens on an income word but names a tax (`divario-salari-ticino-frontalieri-2026`).
    incomeCue: /\b(reddito|guadagn\w*|stipendio|salario|retribuzione|percep\w*)([^.\n]{0,40}?)$/i,

    // An amount can also be named as income AFTER the figure. "ha pagato 4.500
    // franchi di tasse per ogni 1.000 franchi DI REDDITO" only reads as a 450%
    // rate once the 1.000 is recognised as the base; with leading cues alone the
    // gate latched onto a later amount and reported the right defect against the
    // wrong pair of numbers (`bossi-commemorazione-bagarrata`).
    incomeCueTrailing: /^\s*(?:di|d'|del|dello|della|delle|dei|sul|sui|su)\s*(?:reddito|stipendio|salario|retribuzione|guadagn\w*)/i,

    // "tass\w*" also matched `tasso`/`tassi` — the exchange RATE, not a tax. That
    // one collision blocked `franco-forte-stipendio-frontalieri`, whose only sin
    // was converting a salary: "guadagna 5.000 CHF netti al mese, convertendo a un
    // TASSO di 0,92, porta a casa circa 5.435 EUR" became a 109% tax.
    // The leading \b is load-bearing: unanchored, `pag\w*` matched the middle of
    // "equiPAGGi" and turned a charity donation into a tax
    // (`momoride-carpooling-frontalieri-benefici`).
    taxCue: /\b(?:impost\w*|tass[ae]\b|tassat\w*|tassazion\w*|tassabil\w*|pag\w*|trattenut\w*|prelievo|carico\s+fiscale|quota\s+di\s+imposta)/i,

    // Brackets, floors and caps: the amount marks where a rule starts or stops
    // applying, never what someone hands over. Excluded from the tax role only —
    // "un reddito di oltre 80.000 franchi" is still a usable income base.
    thresholdCue: /\b(?:oltre|pi[uù]\s+di|superior[ei]\s+a(?:i|l|lla|lle|gli)?|maggior[ei]\s+di|almeno|a\s+partire\s+da|fino\s+a(?:i|l|lla|lle|gli)?|massimo\s+di|al\s+massimo|non\s+oltre|meno\s+di|inferior[ei]\s+a(?:i|l|lla)?|sopra\s+i|sotto\s+i)\s*$/i,

    // Money that is demonstrably not a tax. taxCue is deliberately loose (`pag\w*`
    // matches "pagamento", which in `funivia-monte-lema-stagione-2026` referred to
    // a monthly invoice for a cable-car pass), so when one of these words sits
    // closer to the amount than any tax word, it vetoes the pairing.
    //
    // Three groups, all learned from the audit of the surviving findings:
    //
    //  - what the worker keeps (netto, porta a casa, pensione) — six of the
    //    thirteen false positives were take-home pay read as the tax;
    //  - what the tax is computed ON rather than what it comes to (imponibile,
    //    "tassato solo su", credito d'imposta) — five more;
    //  - a tax word that is negated ("non è stata trattenuta") or that follows
    //    "dopo", which turns the clause into an after-tax residue rather than an
    //    assertion about the tax itself. These phrases deliberately SPAN the tax
    //    word so presentedAsTax() can discount it — see the overlap filter there.
    nonTaxCue: /(?:\bcost[aoi]\b|\bcostano\b|\bcostav\w*|\bprezz[oi]\b|\babbonament[oi]\b|\bbigliett[oi]\b|\btariff[ae]\b|\bdetrazion[ei]\b|\bdetrarre\b|\bfranchigi[ae]\b|\brisparmi\w*|\bscont[oi]\b|\bbonus\b|\brimbors[oi]\b|\bcanone\b|\bnoleggi\w*|\bnett[oi]\b|\bpension[ei]\b|\bimponibil[ei]\b|\bport\w*\s+a\s+casa\b|\bin\s+tasca\b|\bcredit[oi]\s+d['’]impost\w*|(?:\btassat\w*|\btassazion\w*|\bimposizion\w*)\s+(?:solo\s+)?(?:su|sul|sulla|sui|sugli|sulle)\b|\bnon\s+(?:è\s+|sono\s+|viene\s+|vengono\s+)?(?:stat[aeio]\s+)?(?:trattenut\w*|tassat\w*|pagat\w*|prelevat\w*)|\bdopo\b[^.;:]{0,40}?(?:impost[ae]\w*|tass[ae]\b|tassazion\w*|ritenut[ae]\b|prelievi|trattenut\w*|detrazion\w*|contribut\w*))/i,

    // Words that mark a parenthesis as restating a figure already on the page.
    approximation: String.raw`circa|pari\s+a|equivalent\w*\s+a|corrispondent\w*\s+a|ossia|ovvero|cio[èe]|all'incirca`,

    // Moved verbatim from periodOf(); matched against an already-lowercased
    // 40-char tail, which is why none of these carry the `i` flag. "l’ora" with a
    // curly apostrophe is how the corpus actually writes hourly pay, and it was
    // the one form the first version missed.
    periods: [
      ['month', /\b(al|a|ogni|per)\s+mese|mensil|\/mese/],
      ['year', /\b(all'anno|annu|ogni\s+anno|\/anno)/],
      ['week', /\b(a|alla|per)\s+settimana|settimanal/],
      ['hour', /\b(?:al|all['’]|l['’]|ogni|per)\s*ora\b|orari[ao]/],
    ],
  },
  en: {
    months: MONTHS.en,
    currency: String.raw`(?:Swiss\s+francs?|francs?|CHF|euros?|EUR|€)`,
    incomeCue: /\b(income|earnings|salary|salaries|wages?|remuneration|gross\s+pay)([^.\n]{0,40}?)$/i,
    // English postposes the noun bare: "500,000 francs income: 80,000 francs in
    // Freienbach" (`costo-vita-svizzera-mappa`). Requiring "of"/"in" first made
    // the gate read the 80,000 as the income and the 500,000 as a 625% tax.
    incomeCueTrailing: /^\s*(?:of\s+|in\s+)?(?:income|salary|wages?|earnings)\b/i,
    // No "pay"/"due"/"owed": see the note above the lexicon.
    taxCue: /\b(?:tax\w*|withhold\w*|levy|levies|levied|deduction\w*|surcharge\w*)/i,
    thresholdCue: /\b(?:over|above|more\s+than|at\s+least|starting\s+(?:at|from)|up\s+to|no\s+more\s+than|less\s+than|below|under|exceed\w*|maximum\s+of)\s*$/i,
    nonTaxCue: /(?:\bcosts?\b|\bcosting\b|\bprices?\b|\bsubscriptions?\b|\btickets?\b|\bfares?\b|\bdeductibles?\b|\ballowances?\b|\bsavings?\b|\bdiscounts?\b|\bbonus\b|\brefunds?\b|\brents?\b|\bnet\b)/i,
    approximation: String.raw`about|approximately|around|roughly|equal\s+to|equivalent\s+to|i\.e\.|that\s+is`,
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
    incomeCue: /\b(Einkommen\w*|Lohn\w*|L(?:ö|oe)hne\w*|Gehalt\w*|Geh(?:ä|ae)lter\w*|Verdienst\w*|verdien\w*|Brutto\w*|Entgelt\w*)([^.\n]{0,40}?)$/i,
    // "4.000 Franken brutto im Monat" postposes the qualifier, so the amount was
    // not recognised as the base and the rent behind it became a 300% tax
    // (`primo-maggio-varese-2026-lavoro`).
    incomeCueTrailing: /^\s*(?:an|des|der)?\s*(?:Einkommen\w*|Lohn\w*|Gehalt\w*|Verdienst\w*|brutto\w*)/i,
    // Franken …, zahlt etwa 1.200 Franken Steuern" put no tax word in the gap
    // after the income cue, so the 1.200 was itself read as the income and the
    // net pay behind it became a 300% tax
    // (`divario-salari-ticino-frontalieri-2026`). German has no noun sense of
    // "Zahlung" meaning salary, so this does not repeat the English "pay"
    // collision documented above.
    taxCue: /\b(?:Steuer\w*|steuer\w*|Quellensteuer\w*|Abz(?:u|ü)g\w*|Abgabe\w*|besteuer\w*|Steuerlast\w*|zahl\w*|Zahlung\w*)/i,
    thresholdCue: /\b(?:(?:mehr|weniger)\s+als|(?:ü|ue)ber|unter|mindestens|h(?:ö|oe)chstens|ab|bis\s+zu|maximal)\s*$/i,
    // `Freibetrag` is the Italian `franchigia`: an exempt band, not a sum paid.
    nonTaxCue: /(?:\bkostet\b|\bkosten\b|\bpreis\w*|\babonnement\w*|\bticket\w*|\btarif\w*|\bfranchise\w*|\bfreibetrag\w*|\bfreibetr(?:ä|ae)ge\w*|\bersparnis\w*|\brabatt\w*|\bbonus\b|\br(?:ü|ue)ckerstattung\w*|\bmiete\w*|\bnetto\b)/i,
    approximation: String.raw`circa|etwa|ungef(?:ä|ae)hr|rund|entspricht|gleich|also|d\.h\.`,
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
    // No bare "brut": it matched "IRPEF brute", which is an Italian income TAX,
    // and turned the surcharge beside it into a 1459% rate
    // (`credito-imposta-doppia-tassazione`). It survives as a trailing cue
    // below, where it can only qualify an amount already named as pay.
    incomeCue: /\b(revenus?|salaires?|r(?:é|e)mun(?:é|e)ration\w*|gagn\w*|salaire\s+brut)([^.\n]{0,40}?)$/i,
    incomeCueTrailing: /^\s*(?:de|du|des|d')?\s*(?:revenus?|salaires?|r(?:é|e)mun(?:é|e)ration|brut)\b/i,
    // "payer" mirror the Italian `pag\w*`; the bare noun "paie"/"paye" is
    // deliberately absent, because in French that IS the wage.
    taxCue: /\b(?:imp(?:ô|o)t\w*|taxe\w*|impos(?:é|e)\w*|imposition\w*|pr(?:é|e)l(?:è|e)vement\w*|retenue\w*|charge\s+fiscale|payer|paient|paiera\w*|pay(?:é|e)e?s?)\b/i,
    thresholdCue: /\b(?:plus\s+de|moins\s+de|au\s+moins|au\s+plus|(?:à|a)\s+partir\s+de|jusqu'(?:à|a)|sup(?:é|e)rieur\w*\s+(?:à|a)|inf(?:é|e)rieur\w*\s+(?:à|a)|maximum\s+de|au-del(?:à|a)\s+de)\s*$/i,
    nonTaxCue: /(?:\bco(?:û|u)te\w*\b|\bco(?:û|u)ts?\b|\bprix\b|\babonnement\w*|\bbillet\w*|\btarif\w*|\bfranchise\w*|\b(?:é|e)conomie\w*|\bremise\w*|\bbonus\b|\bremboursement\w*|\bloyer\w*|\bnet\b)/i,
    approximation: String.raw`environ|approximativement|(?:à|a)\s+peu\s+pr(?:è|e)s|(?:é|e)quivalent\w*\s+(?:à|a)|(?:é|e)gal\w*\s+(?:à|a)|soit|c'est-(?:à|a)-dire`,
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

/**
 * Union of all four currency vocabularies: translations mix them freely, and
 * the Italian-vs-translation comparison has to see the same amount on both
 * sides regardless of which language named the currency.
 *
 * Longest-first ordering is load-bearing. With `francs?` ahead of
 * `Swiss\s+francs?`, "6,000 Swiss francs" never matched — the number is
 * followed by "Swiss", not by "francs" — and every English body using the
 * spelt-out form looked like it had dropped all of its amounts.
 */
const ANY_CURRENCY = String.raw`(?:franchi\s+svizzeri|francs?\s+suisses?|Schweizer\s+Franken|Swiss\s+francs?|franchi|Franken|francs?|CHF|euros?|EUR|€)`;

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
