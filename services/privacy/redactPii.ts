/**
 * Redaction of personal data from free-text a user typed (issue #5196).
 *
 * WHAT WENT WRONG. `sanitizeChatbotQuestion` stripped email, URL and phone and
 * nothing else, and the chatbot question text is shipped to GA4 and PostHog as
 * the `question_text` event property. Inspecting a year of `chatbot_question`
 * events surfaced at least one question carrying a real full name, date of
 * birth and street address in clear.
 *
 * That is personal data at rest in a third-party analytics system. The audience
 * is Swiss and Italian, so GDPR and the Swiss FADP both apply, and product
 * telemetry is not a lawful basis for holding someone's name and address.
 *
 * And it is predictable that it recurs: someone writing to an assistant
 * describes their situation, and on a cross-border-worker site the situation IS
 * residence, civil status and permit. This is not an outlier to patch, it is
 * the normal shape of the input.
 *
 * ── THE ASYMMETRY THAT SETS EVERY THRESHOLD BELOW ──
 *
 * Recognising a person's name in free text is heuristic and cannot be made
 * exact. So every judgement call here resolves the same way: **over-redact**.
 * An over-redacted question loses some analytic value. An under-redacted one is
 * a data-protection incident. Those are not comparable costs, and nothing in
 * this file should be tightened to "reduce false positives" without that
 * trade being argued explicitly.
 *
 * The one place the asymmetry is deliberately NOT followed is documented inline
 * (bare 4-digit postal codes vs years — see `ZIP_CITY`), because there the
 * naive rule would redact a large share of ordinary questions like
 * "tasse 2026 Lugano" while catching almost no real addresses that the street
 * patterns do not already catch.
 *
 * ── SCOPE, AND WHY THIS IS NO LONGER THE LAST LINE OF DEFENCE ──
 *
 * This redacts text **from here on**. It does nothing about records already in
 * GA4/PostHog: deleting personal data from a third-party system is irreversible
 * and is the owner's decision, not an agent's. See #5196.
 *
 * More importantly: a deny-list over free text has no upper bound. This file
 * has now been widened twice, each time after data had already reached two
 * vendors — first for the name + date-of-birth + address incident, then for
 * French number-first addresses, vehicle plates and passport numbers. And some
 * shapes are not reachable at all: an all-lowercase "sono mario rossi" has
 * nothing in it that marks it as a name, which no pattern can fix.
 *
 * So the chatbot question is no longer shipped as text. `chatbot_question`
 * reports a topic drawn from the closed enum in `./questionTopic.ts`, which
 * cannot emit user text for any input. This file remains the net for the
 * fields where the text itself is the product — on-site search, job-alert
 * keywords — where a guarantee of that kind is not available.
 */

/** Tokens substituted for redacted spans. Deliberately in English, matching the pre-existing `[email]`/`[url]`/`[phone]`. */
export const REDACTION_TOKENS = {
  email: '[email]',
  url: '[url]',
  phone: '[phone]',
  name: '[name]',
  date: '[date]',
  address: '[address]',
  id: '[id]',
  iban: '[iban]',
} as const;

export type RedactionKind = keyof typeof REDACTION_TOKENS;

/**
 * Capitalised words that are domain vocabulary, not people.
 *
 * Used ONLY by the trailing "two adjacent capitalised words" heuristic, which
 * is the broadest and least precise rule in this file. A run is kept only when
 * EVERY word in it is listed here — an unknown capitalised pair is redacted.
 * That means gaps in this list cause over-redaction, which is the safe
 * direction; the list exists to preserve analytic value, not to gate safety.
 *
 * Lowercased, accents folded, at lookup time.
 */
const DOMAIN_CAPITALISED = new Set([
  // Countries / regions / cantons, four locales
  'svizzera', 'suisse', 'schweiz', 'switzerland', 'svizzero', 'svizzera italiana',
  'italia', 'italy', 'italien', 'italie', 'italiana', 'italiano',
  'ticino', 'tessin', 'lombardia', 'lombardy', 'lombardie',
  'grigioni', 'graubunden', 'vallese', 'valais', 'vaud', 'ginevra', 'geneve', 'genf', 'geneva',
  'zurigo', 'zurich', 'basilea', 'basel', 'berna', 'bern', 'lucerna', 'luzern', 'lucerne',
  'argovia', 'aargau', 'turgovia', 'thurgau', 'san gallo', 'sankt gallen', 'friburgo', 'fribourg',
  'neuchatel', 'giura', 'jura', 'soletta', 'solothurn', 'sciaffusa', 'schaffhausen',
  'svitto', 'schwyz', 'uri', 'zugo', 'zug', 'glarona', 'glarus', 'appenzello', 'appenzell',
  'nidvaldo', 'nidwalden', 'obvaldo', 'obwalden', 'liechtenstein', 'austria', 'osterreich',
  'francia', 'france', 'frankreich', 'germania', 'deutschland', 'germany', 'allemagne',
  'europa', 'europe', 'ue', 'eu', 'aels', 'efta', 'schengen',
  // Cities that appear constantly as query context, not as someone's address
  'lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso', 'biasca', 'ascona', 'losone',
  'como', 'varese', 'milano', 'milan', 'mailand', 'brescia', 'bergamo', 'sondrio', 'lecco',
  'domodossola', 'verbania', 'novara', 'torino', 'roma',
  // Institutions, schemes, documents
  'avs', 'ahv', 'ai', 'ipg', 'lpp', 'bvg', 'lamal', 'kvg', 'lainf', 'suva', 'lpga',
  'iva', 'tva', 'mwst', 'irpef', 'imu', 'inps', 'inail', 'agenzia entrate', 'agenzia delle entrate',
  // Benefit and form names that read as a capitalised pair. Measured on the
  // site's own 412-question FAQ corpus: without these, "La NASpI" and
  // "Assegno Unico Universale" are reported as people.
  'naspi', 'assegno', 'unico', 'universale', 'anf', 'redditi', 'gav', 'ccl', 'cct',
  'rav', 'urc', 'kae', 'tfr', 'ssn', 'serafe', 'srg', 'rsi',
  'cassa malati', 'cassa malattia', 'krankenkasse', 'caisse maladie',
  'permesso', 'permis', 'bewilligung', 'permit',
  'imposta', 'imposta alla fonte', 'quellensteuer', 'impot', 'steuer',
  'pilastro', 'terzo pilastro', 'secondo pilastro', 'saule', 'pilier', 'saeule',
  'fondo pensione', 'pensione', 'rendita', 'rente', 'pension',
  'frontaliere', 'frontalieri', 'frontalier', 'frontaliers', 'grenzganger', 'grenzgaenger',
  'cross border', 'cross-border',
  'ffs', 'sbb', 'cff', 'arcobaleno', 'trenord', 'tilo',
  'fedlex', 'admin', 'seco', 'ustat', 'bfs', 'ufs', 'ofs',
  'coop', 'migros', 'manor', 'denner', 'lidl', 'aldi',
  // Generic capitalised sentence-openers that pair with another capital
  'buongiorno', 'buonasera', 'salve', 'ciao', 'grazie',
  'guten tag', 'guten morgen', 'hallo', 'danke',
  'bonjour', 'bonsoir', 'merci', 'salut',
  'hello', 'good morning', 'thanks', 'thank',
]);

/** Month names across the four site locales, for textual dates. */
const MONTHS = [
  // it
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto',
  'settembre', 'ottobre', 'novembre', 'dicembre',
  // en
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  // de
  'januar', 'februar', 'marz', 'märz', 'april', 'mai', 'juni', 'juli', 'august',
  'september', 'oktober', 'november', 'dezember',
  // fr
  'janvier', 'fevrier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'août',
  'septembre', 'octobre', 'novembre', 'decembre', 'décembre',
];

/** Street-type words that introduce an address in IT / FR (type first, then name, then number). */
const STREET_PREFIX_IT_FR =
  'via|viale|v\\.le|corso|c\\.so|piazza|p\\.zza|piazzale|vicolo|largo|strada|contrada|localita|località|frazione|' +
  'rue|avenue|av\\.|boulevard|bd\\.?|chemin|ch\\.|route|place|impasse|quai|allee|allée|sentier';

/** German street compounds end in one of these and are followed by the number. */
const STREET_SUFFIX_DE = 'strasse|straße|str\\.|weg|gasse|platz|allee|ring|steig|damm';

/**
 * Add an initial-capital variant of every alternative in an `a|b|c` pattern.
 *
 * Needed because the number-first address rule below matches on case: it
 * requires the street NAME to be capitalised (that is what separates
 * "12 avenue des Alpes" from "1 corso di formazione"), so it cannot carry the
 * `i` flag — under `i`, `\p{Lu}` matches lowercase too and the distinction
 * disappears. The street TYPE still has to match whether the user wrote
 * "rue" or "Rue", so its capitalised form is spelled out instead.
 */
function withInitialCapVariants(alternation: string): string {
  const alts = alternation.split('|');
  return [...alts, ...alts.map((a) => a.charAt(0).toUpperCase() + a.slice(1))].join('|');
}

/**
 * Articles and particles that sit between a French/Italian street type and the
 * proper name: "rue **de la** Gare", "avenue **des** Alpes", "rue **d'**Italie".
 *
 * Deliberately excludes Italian `di`, which would let "1 corso di formazione"
 * — a course, not an avenue — reach the capitalised-name test.
 */
const STREET_PARTICLE = "(?:(?:de|du|des|della|dello|dei|degli|delle|la|le|les|lo)\\s+|[ldLD]['’]\\s*)";

/** Cues that introduce a person's name in the four locales. */
// Apostrophes are a character class, not a literal: the corpus mixes the ASCII
// `'` and the typographic `’`, and a rule that only knows one of them silently
// misses half the real inputs.
const APOS = "['’]";

/**
 * STRONG cues: a predication that can only introduce the speaker's own name.
 *
 * Whatever follows one of these is a name, in any case. The rule below is
 * case-insensitive on purpose and that matters more than it looks: on a phone
 * keyboard people type "mi chiamo mario rossi" all lowercase, and nothing in
 * that string except the cue marks it as a name.
 */
const NAME_CUES_STRONG =
  "mi\\s+chiamo|il\\s+mio\\s+nome\\s+[eè]|" +
  `my\\s+name\\s+is|i\\s+am\\s+called|i${APOS}?m\\s+called|` +
  "ich\\s+heisse|ich\\s+heiße|mein\\s+name\\s+ist|" +
  `je\\s+m${APOS}\\s*appelle|je\\s+me\\s+nomme|mon\\s+nom\\s+est`;

/**
 * LABEL cues: the bare words for "name", which introduce a value only when they
 * are used as a FORM LABEL.
 *
 * These were treated exactly like the strong cues, and because the rule carries
 * the `i` flag — which makes `\p{Lu}` match lowercase too — the bare `nome`
 * swallowed whatever three words came after it. On a cross-border-worker site
 * that is not a rare shape, it is a top-frequency question:
 *
 *   "nome del datore di lavoro?"     → "nome [name] lavoro?"
 *   "il nome della cassa malati?"    → "il nome [name]?"
 *   "qual è il cognome sul modulo?"  → "qual è il cognome [name]?"
 *
 * The distinction is not a confidence threshold, it is a grammatical one: as a
 * label, `Nome` carries a separator (`Nome: Marco`) or a capitalised value
 * (`Nome Marco Bernasconi`) — that is what a pasted form looks like. Without
 * either, `nome` is just the Italian word for "name" inside a question.
 *
 * What this gives up, plainly: `nome mario rossi`, lowercase and with no
 * punctuation, is no longer redacted by this rule. Every prose phrasing people
 * actually use to volunteer a name is a STRONG cue and is unaffected, and the
 * form-shaped paste that motivated the rule carries the colon.
 */
const NAME_CUES_LABEL = 'nome\\s+e\\s+cognome|nome|cognome';

/** Honorifics that precede a surname. */
const HONORIFICS =
  'sig\\.ra|sig\\.na|sig\\.|signora|signorina|signor|sig|dott\\.ssa|dott\\.|dottore|dottoressa|' +
  'herr|frau|fraulein|fräulein|' +
  'monsieur|madame|mademoiselle|mme|mlle|m\\.|' +
  'mr\\.|mrs\\.|ms\\.|mr|mrs|ms|dr\\.|dr';

// ── Patterns, applied in this order ─────────────────────────────────────────
// Specific-and-unambiguous first, broad-and-heuristic last, so a span that is
// really an IBAN is not first eaten by the generic long-digit phone rule.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL = /\bhttps?:\/\/\S+/gi;

/** IBAN — CH/IT/DE/FR and friends. Two letters, two check digits, then 11–30 alphanumerics in optional 4-char groups. */
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;

/** Italian codice fiscale — 16 chars, fixed letter/digit skeleton. Unambiguous. */
const CODICE_FISCALE = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi;

/**
 * Swiss AVS/AHV social-security number: always starts 756, then 4-4-2 digits.
 * Ahead of the phone rule, which would otherwise swallow it and mislabel it.
 */
const AVS_NUMBER = /\b756[.\s-]?\d{4}[.\s-]?\d{4}[.\s-]?\d{2}\b/g;

/**
 * Travel / identity documents, in the shapes this audience actually holds.
 *
 *  - `YA1234567` — Italian passport (2 letters + 7 digits)
 *  - `X1234567`  — Swiss passport (1 letter + 7 digits)
 *  - `CA12345AB` — Italian carta d'identità elettronica (2 + 5 + 2)
 *
 * A document number is a direct national identifier: on its own it links to a
 * named person in a state register, which puts it in the same class as the AVS
 * number and the codice fiscale rather than in the heuristic tier below.
 *
 * These run AFTER the IBAN rule, which is longer and would otherwise be cut
 * short by them, and BEFORE the plate and phone rules, which are shorter and
 * would otherwise swallow their prefix.
 */
const ID_DOCUMENT = /\b(?:[A-Z]{2}\d{7}|[A-Z]\d{7}|[A-Z]{2}\d{5}[A-Z]{2})\b/gi;

/**
 * Swiss vehicle plate: canton code then 1–6 digits ("TI 123456").
 *
 * A plate is held in a public register keyed to its owner, so it identifies a
 * household as directly as an address does.
 *
 * Two deliberate narrowings, both for the same reason the `ZIP_CITY` rule
 * carves out years — a two-letter token followed by digits is an extremely
 * common shape in ordinary prose here, and the naive rule would fire constantly
 * while catching almost nothing extra:
 *
 *  - the canton code is an explicit list and is matched CASE-SENSITIVELY, so
 *    German "So 3000 Franken" and Italian "ne 1234" are not plates;
 *  - a bare 4-digit group in the 1900–2099 window is skipped, because
 *    "TI 2026" is a tax year in almost every real occurrence.
 *
 * Fewer than three digits is not matched at all: "GE 12" is far more often a
 * fragment than a plate.
 */
const CH_PLATE =
  /\b(?:AG|AI|AR|BE|BL|BS|FR|GE|GL|GR|JU|LU|NE|NW|OW|SG|SH|SO|SZ|TG|TI|UR|VD|VS|ZG|ZH|FL)[\s-]?(?!(?:19|20)\d{2}\b)\d{3,6}\b/g;

/** Italian vehicle plate: `AB123CD`, also written `AB 123 CD`. Case-sensitive — plates are upper-case. */
const IT_PLATE = /\b[A-Z]{2}[\s-]?\d{3}[\s-]?[A-Z]{2}\b/g;

/** Numeric dates: 22/02/2008, 22.02.2008, 22-2-08. Requires day AND month, so a bare year survives. */
const DATE_NUMERIC = /\b\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})\b/g;

/** ISO dates: 2008-02-22. */
const DATE_ISO = /\b\d{4}-\d{2}-\d{2}\b/g;

/** Textual dates in any of the four locales: "22 febbraio 2008", "22. Februar 2008", "22 février 2008". */
const DATE_TEXTUAL = new RegExp(
  `\\b\\d{1,2}\\.?\\s*(?:°|º|er)?\\s*(?:de\\s+|di\\s+|of\\s+)?(?:${MONTHS.join('|')})\\.?\\s+\\d{4}\\b`,
  'gi',
);

/** IT/FR address: street-type word, then the name, then the house number. */
const ADDRESS_IT_FR = new RegExp(
  `\\b(?:${STREET_PREFIX_IT_FR})\\s+[\\p{L}'’.\\-]+(?:\\s+[\\p{L}'’.\\-]+){0,4}\\s*,?\\s*(?:n\\.?|no\\.?)?\\s*\\d+\\s*[a-zA-Z]?\\b`,
  'giu',
);

/** DE address: compound street word ending in -strasse/-weg/…, then the number. */
const ADDRESS_DE = new RegExp(
  `\\b[\\p{L}\\-]*(?:${STREET_SUFFIX_DE})\\s*,?\\s*\\d+\\s*[a-zA-Z]?\\b`,
  'giu',
);

/**
 * FR/IT address in the **number-first** form: "5 rue de la Gare".
 *
 * This is the standard French postal order, and `fr` is one of the site's four
 * locales — `ADDRESS_IT_FR` above only knows the type-first order
 * ("Rue du Rhône 14"), which is the Swiss-Romand habit but not the general one.
 * Without this rule a plain French home address passed through in clear.
 *
 * The street NAME must be capitalised. That is not an attempt to reduce false
 * positives below what the module's asymmetry allows — it is what makes the
 * rule terminate. Type-first addresses end at the house number, which bounds
 * the match; number-first ones have no trailing anchor, so an unbounded word
 * run would swallow the rest of the sentence ("5 rue de la Gare **a Ginevra**")
 * and, worse, would fire on ordinary Italian prose where `corso`, `largo` and
 * `strada` are common nouns.
 *
 * Consequence, stated plainly: an all-lowercase "5 rue de la gare" is NOT
 * caught. That is the same limit as every other case-based rule here, and it is
 * the argument for not relying on this file alone — see `questionTopic.ts`.
 */
const ADDRESS_NUM_FIRST = new RegExp(
  `\\b\\d{1,4}\\s*(?:[Bb]is|[Tt]er|[Qq]uater)?,?\\s+(?:${withInitialCapVariants(STREET_PREFIX_IT_FR)})\\s+` +
    `${STREET_PARTICLE}*\\p{Lu}[\\p{L}'’\\-]*(?:\\s+\\p{Lu}[\\p{L}'’\\-]*){0,2}`,
  'gu',
);

/**
 * EN address: number first, then the street name, then the street type.
 *
 * The house number carries an optional letter suffix, so "221B Baker Street"
 * is redacted whole. Without it the rule failed on the very shape it targets:
 * `221B` did not match `\d{1,4}\s`, the generic name heuristic then ate
 * "Baker Street", and the house number survived in clear next to a `[name]`.
 */
const ADDRESS_EN = /\b\d{1,4}\s*[a-z]?\s+[\p{L}][\p{L}'’.\-]*(?:\s+[\p{L}'’.\-]+){0,3}\s+(?:street|st\.|road|rd\.|avenue|ave\.|lane|drive|square)\b/giu;

/**
 * A postal code + town glued to an address we already redacted, e.g.
 * "[address], 6965 Cadro". Safe because the anchor proves it is an address.
 */
const ZIP_CITY_AFTER_ADDRESS = /(\[address\])[,\s]+(?:CH-|I-|IT-|D-|F-)?\d{4,5}\s+\p{Lu}[\p{L}'’\-]+/gu;

/**
 * A standalone postal code + town.
 *
 * This is the one rule that does NOT follow the over-redact default, and the
 * reason is quantitative rather than aesthetic: a bare 4-digit number followed
 * by a capitalised town is indistinguishable from a YEAR followed by a town,
 * and "tasse 2026 Lugano" / "salario 2026 Ticino" is one of the most common
 * question shapes on this site. Redacting on the naive rule would blank a large
 * share of ordinary questions while catching almost nothing the street patterns
 * above miss — an address in free text virtually always carries its street.
 *
 * So a 4-digit code in the plausible-year window (1900–2099) is only treated as
 * a postal code when it carries an explicit country prefix (`CH-6900`). Italian
 * 5-digit codes are never years, so they need no prefix.
 */
const ZIP_CITY = /\b(?:(?:CH-|I-|IT-|D-|F-)\d{4,5}|\d{5}|(?!(?:19|20)\d{2}\b)\d{4})\s+\p{Lu}[\p{L}'’\-]{2,}/gu;

/**
 * Swiss national phone format, INCLUDING the slash separator.
 *
 * The generic `PHONE` rule below needs eight consecutive digits whose only
 * separators are space, dot, parenthesis or hyphen. A Swiss number is very
 * often written `091/123 45 67`, and the slash splits it into `091` + a
 * seven-digit tail — one digit under the floor — so the whole number went out
 * **in clear**. Measured on the module as it stood: `079/1234567`,
 * `022/345 67 89`, `091/123 45 67` and `+41 91/123 45 67` were all returned
 * untouched, with `kinds` empty.
 *
 * The shape is not invented here. `scripts/lib/strip-contact-pii.mjs` already
 * carries the same format for scraped recruiter numbers and already lists
 * "space / dot / slash / hyphen" as the separators — this repo knew about the
 * slash in one PII stripper and not in the other.
 *
 * Anchoring on `+41` / `0041` / a leading `0` is what keeps it off ordinary
 * numbers: `2026/2027` and `9/17` do not start a national number, so the
 * slash does not turn a year range into a phone call.
 */
const PHONE_CH = /(?:\+41[\s./-]?|0041[\s./-]?|\b0)\d{1,2}[\s./-]?\d{3}[\s./-]?\d{2}[\s./-]?\d{2}\b/g;

/** Long digit runs — phones, and any other identifier the rules above missed. */
const PHONE = /\b(?:\+?\d[\s().-]?){7,}\d\b/g;

/**
 * A number introduced by an explicit identifier label: "permesso G n. 1234567",
 * "matricola 1234567", "Ausweis Nr. 12345".
 *
 * Everything above matches a *shape*. A residence-permit card number has no
 * shape to match — it is a bare digit run, and this audience's most common one
 * is seven digits, one short of the generic phone rule's eight-digit floor. So
 * `permesso G n. 1234567` and `matricola 1234567` both passed through in clear,
 * while the same numbers with one more digit were caught (and mislabelled
 * `phone`). The label is the only thing that marks them, so the label is what
 * this rule anchors on.
 *
 * Five digits is the floor, which puts every four-digit year out of reach: the
 * cost of a lower one would be "numero 2026" redacted on a site whose most
 * common question token is a tax year.
 *
 * Runs AFTER both phone rules, so a real phone number keeps the `phone` label
 * and only the sub-eight-digit leftovers land here.
 */
const ID_AFTER_CUE = new RegExp(
  "\\b(n\\.|nr\\.|no\\.|numero|numeri|nummer|num[eé]ro|matricola|tessera|" +
    "permesso\\s+\\p{L}|permis\\s+\\p{L}|bewilligung\\s+\\p{L}|ausweis)" +
    "(\\s*[:\\-]?\\s*)(\\d{5,})\\b",
  'giu',
);

/** "mi chiamo Mario Rossi", "ich heisse jürgen müller". Up to three words, any case. */
const NAME_AFTER_STRONG_CUE = new RegExp(
  `\\b(${NAME_CUES_STRONG})\\b(\\s*[:\\-]?\\s*)(\\p{Lu}[\\p{L}'’\\-]+(?:\\s+\\p{Lu}[\\p{L}'’\\-]+){0,2})`,
  'giu',
);

/** "Nome: Hatam Kerimi", "Cognome Bernasconi" — only in label position, see `NAME_CUES_LABEL`. */
const NAME_AFTER_LABEL_CUE = new RegExp(
  `\\b(${NAME_CUES_LABEL})\\b(\\s*[:\\-]\\s*|\\s+)(\\p{Lu}[\\p{L}'’\\-]+(?:\\s+\\p{Lu}[\\p{L}'’\\-]+){0,2})`,
  'giu',
);

/** True when the label cue is genuinely acting as a form label. */
function isLabelPosition(separator: string, value: string): boolean {
  if (/[:\-=]/.test(separator)) return true;
  const first = value.charAt(0);
  return first !== '' && first !== first.toLowerCase();
}

/** "Sig. Rossi", "Herr Müller", "M. Dupont". */
const NAME_AFTER_HONORIFIC = new RegExp(
  `\\b(${HONORIFICS})\\s+(\\p{Lu}[\\p{L}'’\\-]+(?:\\s+\\p{Lu}[\\p{L}'’\\-]+){0,1})`,
  'giu',
);

/**
 * Two or three adjacent capitalised words, none of which is domain vocabulary.
 *
 * The broadest rule here, and the one that carries the asymmetry: an unknown
 * capitalised pair is assumed to be a person. Single capitalised words are NOT
 * matched — that would redact every sentence opener and every place name the
 * allowlist happens to miss, which is over-redaction past the point of
 * usefulness. Words shorter than two letters are excluded so "Permesso G" and
 * "Classe A" survive.
 */
const CAPITALISED_RUN = /\p{Lu}[\p{L}'’\-]{1,}(?:\s+\p{Lu}[\p{L}'’\-]{1,}){1,2}/gu;

/**
 * Capitalised words that are grammar, not the start of a person's name:
 * interrogatives, auxiliaries and modals, prepositions and conjunctions, plus
 * adjectives of nationality. They appear capitalised because they open a
 * sentence, or because German capitalises where the other three locales do not.
 *
 * ── WHY THIS LIST EXISTS, MEASURED ──
 *
 * `CAPITALISED_RUN` was calibrated on 112 real ITALIAN chatbot questions (6.3%
 * touched). Two of the site's four locales do not behave like Italian: German
 * capitalises every noun, and English capitalises brand and scheme names, so an
 * ordinary question in either produces adjacent capitals with no person in it.
 * Run against the site's own FAQ corpus — 412 editorial questions across it/en/
 * de/fr, `data/faq-hub/category-*.ts`, containing no personal data at all —
 * the rule fired on **56 of them (13.6%), every single one a false positive**:
 *   "Welche Kündigungsfristen gelten in Schweizer Arbeitsverträgen?"
 *      → "[name] gelten in [name]?"
 *   "Does Swiss law provide a TFR equivalent as in Italy?"
 *      → "[name] law provide a TFR equivalent as in Italy?"
 *
 * That is not a cosmetic loss. The chatbot no longer ships question text at
 * all (see `questionTopic.ts`), so what `CAPITALISED_RUN` produces there is the
 * `redacted_kinds` signal — the one number the owner has to decide the historic
 * cleanup with. A rule that reports `name` on one German question in seven that
 * contains no name makes exactly that signal unreadable.
 *
 * ── THE TRADE, STATED ──
 *
 * Dropping these tokens from the EDGES of a run is a narrowing of the broadest
 * rule in this file, so it goes against the module's over-redact default and
 * has to earn it. It does, on two counts. First, it cannot hide a name that is
 * flanked by grammar: "Kann Mario Rossi …" still leaves `Mario Rossi`, two
 * name-like tokens, and is still redacted — only the word `Kann` survives.
 * Second, the shapes it gives up are the ones every other rule still holds:
 * a cue ("mi chiamo …"), an honorific, an email, a phone, an address, a date.
 *
 * What it does give up is stated rather than buried: a run left with fewer than
 * two name-like tokens is kept. So `Anna NERI` — a given name beside a
 * SHORT ALL-CAPS surname — is no longer redacted by this rule, because a 2–4
 * character all-caps token is read as an acronym (`AVS`, `KVG`, `SBB`, `PF`).
 * It still is when introduced by a cue or an honorific. The cap is 4 characters
 * precisely so that the common all-caps surname length stays out of it.
 */
const NON_NAME_CAPITALISED = new Set([
  // it — interrogatives, auxiliaries, modals, prepositions, conjunctions
  'quale', 'quali', 'quanto', 'quanti', 'quanta', 'quante', 'quando', 'come', 'cosa',
  'chi', 'dove', 'perche', 'se', 'esiste', 'esistono', 'serve', 'servono', 'vale',
  'posso', 'puoi', 'puo', 'possiamo', 'potete', 'possono',
  'devo', 'devi', 'deve', 'dobbiamo', 'dovete', 'devono',
  'sono', 'sei', 'siamo', 'siete', 'ho', 'hai', 'ha', 'abbiamo', 'avete', 'hanno',
  'con', 'per', 'senza', 'dopo', 'prima', 'anche', 'ma', 'oppure', 'invece', 'ogni',
  // en
  'which', 'what', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'do', 'does', 'did',
  'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would',
  'have', 'has', 'had', 'the', 'an', 'my', 'your', 'our', 'their',
  'this', 'that', 'these', 'those', 'and', 'or', 'but', 'if', 'with', 'without',
  'for', 'from', 'about', 'after', 'before', 'also', 'still', 'only', 'every',
  // de
  'welche', 'welcher', 'welches', 'welchen', 'welchem', 'wie', 'wer', 'wen', 'wem',
  'wann', 'wo', 'warum', 'weshalb', 'wieso',
  'ist', 'sind', 'war', 'waren', 'bin', 'bist', 'hat', 'habe', 'haben', 'hast',
  'hatte', 'hatten', 'kann', 'kannst', 'konnen', 'koennen',
  'muss', 'mussen', 'muessen', 'darf', 'durfen', 'duerfen', 'soll', 'sollen',
  'wird', 'werden', 'wurde', 'wurden', 'gibt', 'der', 'die', 'das', 'den', 'dem',
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'mein', 'meine', 'meinen',
  'mit', 'fur', 'fuer', 'ohne', 'nach', 'vor', 'bei', 'aus', 'auch', 'und',
  'oder', 'aber', 'wenn', 'als', 'noch', 'schon', 'jede', 'jeder', 'jedes',
  // fr
  'quel', 'quelle', 'quels', 'quelles', 'comment', 'combien', 'quand', 'pourquoi',
  'qui', 'que', 'quoi', 'est', 'sont', 'ai', 'ont', 'peut', 'peux', 'peuvent',
  'dois', 'doit', 'doivent', 'faut', 'avec', 'sans', 'pour', 'par', 'dans', 'sur',
  'mais', 'si', 'aussi', 'encore', 'je', 'tu', 'nous', 'vous', 'ils', 'elles',
  'mon', 'ma', 'mes', 'votre', 'notre', 'leur', 'chaque',
  // Adjectives of nationality — the single most frequent capitalised
  // non-name word on this site, in every locale ("Schweizer Bankkonto",
  // "Swiss CV", "Italian ANF"). Deliberately NOT the country nouns, which are
  // already in DOMAIN_CAPITALISED.
  'swiss', 'suisse', 'suisses', 'schweizer', 'schweizerisch', 'schweizerische',
  'schweizerischen', 'schweizerischer', 'tessiner', 'ticinese', 'ticinesi',
  'italian', 'italien', 'italienne', 'italiens', 'italiennes',
  'italienisch', 'italienische', 'italienischen', 'italienischer',
]);

/**
 * A 2–4 character all-caps token: an acronym, not a name.
 *
 * Four is a ceiling with a reason: `AVS`, `AHV`, `KVG`, `SBB`, `RAV`, `GAV`,
 * `TFR`, `SSN`, `ANF`, `CHF`, `URC`, `SRG`, `PF`, `CV`, `GA` are the tokens
 * that pair with an ordinary noun and turn a normal question into a `[name]`.
 * Raising it to five or six would also swallow an ALL-CAPS surname, which is a
 * shape people really type into forms — so it stays at four, and the surname
 * keeps being caught.
 */
const ACRONYM_TOKEN = /^[\p{Lu}\d]{2,4}$/u;

/** Fold accents + lowercase, for allowlist lookup only. */
function foldForLookup(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function isDomainPhrase(run: string): boolean {
  const folded = foldForLookup(run);
  if (DOMAIN_CAPITALISED.has(folded)) return true;
  // Every word individually recognised → still domain vocabulary
  // ("Cassa Malati", "Imposta Fonte").
  const words = folded.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => DOMAIN_CAPITALISED.has(w));
}

/** A token that cannot be part of a person's name: grammar, or an acronym. */
function isNonNameToken(word: string): boolean {
  if (ACRONYM_TOKEN.test(word)) return true;
  const folded = foldForLookup(word);
  return NON_NAME_CAPITALISED.has(folded) || DOMAIN_CAPITALISED.has(folded);
}

/**
 * Narrow a capitalised run to the span that could actually be a person, by
 * discarding non-name tokens at either END of it.
 *
 * Only the ends: a non-name token in the MIDDLE ("Grenzgängern Schweizer
 * Stipendien") leaves the run intact and redacted, because splitting there
 * would need a judgement about which side the person is on, and the safe
 * answer to that question is "redact".
 *
 * Returns `null` when fewer than two name-like tokens remain — the same
 * two-token floor the rule has always had, applied after the noise is removed.
 */
function nameSpanOf(words: string[]): { start: number; end: number } | null {
  let start = 0;
  let end = words.length;
  while (start < end && isNonNameToken(words[start])) start += 1;
  while (end > start && isNonNameToken(words[end - 1])) end -= 1;
  return end - start >= 2 ? { start, end } : null;
}

export interface RedactionOptions {
  /**
   * Whether an unknown pair of adjacent capitalised words counts as a person.
   *
   * ON (default) for prose the user wrote about themselves — the chatbot.
   * Measured against 112 real production questions: 6.3% touched, 95% of
   * characters retained, and the one known question carrying name + date of
   * birth + address fully redacted. That is the trade the asymmetry asks for.
   *
   * OFF for SHORT STRUCTURED fields — the on-site search box, job-alert
   * keywords — where a capitalised multi-word phrase is the *content*, not a
   * person. Measured against 800 distinct real search terms: leaving it on
   * would redact 1.1% of them, and every single one was signal, not PII —
   * `Project Manager`, `Data Engineer`, `Ente Ospedaliero Cantonale`,
   * `Amministrazione Cantonale Ticino`. Turning it off there does not weaken
   * protection where it matters: email, phone, IBAN, AVS number, codice
   * fiscale, dates, addresses and cue-introduced names ("mi chiamo …") are all
   * still redacted.
   */
  inferNamesFromCapitalisation?: boolean;
}

export interface RedactionResult {
  /** The redacted text. */
  text: string;
  /**
   * Which kinds fired, sorted and de-duplicated.
   *
   * Safe to ship as telemetry — it says "this question contained an address"
   * without saying which. That is exactly the signal needed to tell whether
   * users keep pasting personal data, without holding any of it.
   */
  kinds: RedactionKind[];
}

/**
 * Redact personal data from user-authored free text.
 *
 * Order matters: specific identifiers first (IBAN, codice fiscale, AVS), then
 * dates and addresses, then the generic digit-run and name heuristics. A span
 * already replaced by a `[token]` cannot be re-matched, because every token is
 * lowercase inside brackets and no rule below matches that shape.
 */
export function redactPersonalData(raw: string, options: RedactionOptions = {}): RedactionResult {
  const { inferNamesFromCapitalisation = true } = options;
  const kinds = new Set<RedactionKind>();
  let out = String(raw ?? '').replace(/\s+/g, ' ');

  const apply = (re: RegExp, kind: RedactionKind, replacement?: string) => {
    out = out.replace(re, (...args) => {
      kinds.add(kind);
      return replacement ?? REDACTION_TOKENS[kind];
    });
  };

  apply(EMAIL, 'email');
  apply(URL, 'url');
  apply(IBAN, 'iban');
  apply(CODICE_FISCALE, 'id');
  apply(AVS_NUMBER, 'id');
  // Documents before plates before phone: longest and most specific first, so a
  // passport number is not first truncated by the plate rule and a plate is not
  // first swallowed by the generic digit-run rule.
  apply(ID_DOCUMENT, 'id');
  apply(IT_PLATE, 'id');
  apply(CH_PLATE, 'id');

  apply(DATE_TEXTUAL, 'date');
  apply(DATE_ISO, 'date');
  apply(DATE_NUMERIC, 'date');

  // Number-first before type-first: on "5 rue de la Gare 1204" the type-first
  // rule would match from "rue" and leave the house number behind.
  apply(ADDRESS_NUM_FIRST, 'address');
  apply(ADDRESS_IT_FR, 'address');
  apply(ADDRESS_DE, 'address');
  apply(ADDRESS_EN, 'address');
  // Anchored form first: proves the trailing "6965 Cadro" belongs to an address.
  out = out.replace(ZIP_CITY_AFTER_ADDRESS, () => {
    kinds.add('address');
    return REDACTION_TOKENS.address;
  });
  apply(ZIP_CITY, 'address');

  // Swiss national format first: it knows the slash separator that splits a
  // real number below the generic rule's eight-digit floor.
  apply(PHONE_CH, 'phone');
  apply(PHONE, 'phone');
  // After both phone rules, so a real phone keeps the `phone` label and only
  // the short label-anchored numbers (permit, matricola) land as `id`.
  out = out.replace(ID_AFTER_CUE, (_m, cue: string, sep: string) => {
    kinds.add('id');
    return `${cue}${sep}${REDACTION_TOKENS.id}`;
  });

  // Names last: the cue/honorific rules must run before the generic run rule,
  // so "Nome: Hatam Kerimi" is caught even if the pair were somehow allowlisted.
  out = out.replace(NAME_AFTER_STRONG_CUE, (_m, cue: string, sep: string) => {
    kinds.add('name');
    // Keep the cue and its separator: "Nome: [name]" still reads as a labelled
    // field, which is what makes the redacted question usable for analytics.
    return `${cue}${sep}${REDACTION_TOKENS.name}`;
  });
  out = out.replace(NAME_AFTER_LABEL_CUE, (match, cue: string, sep: string, value: string) => {
    if (!isLabelPosition(sep, value)) return match;
    kinds.add('name');
    return `${cue}${sep}${REDACTION_TOKENS.name}`;
  });
  out = out.replace(NAME_AFTER_HONORIFIC, (_m, title: string) => {
    kinds.add('name');
    return `${title} ${REDACTION_TOKENS.name}`;
  });
  if (inferNamesFromCapitalisation) {
    out = out.replace(CAPITALISED_RUN, (run: string) => {
      if (isDomainPhrase(run)) return run;
      // Whitespace was collapsed to single spaces at the top of this function,
      // so the run round-trips through split/join without losing anything.
      const words = run.split(' ');
      const span = nameSpanOf(words);
      if (!span) return run;
      kinds.add('name');
      return [...words.slice(0, span.start), REDACTION_TOKENS.name, ...words.slice(span.end)].join(' ');
    });
  }

  return {
    text: out.replace(/\s+/g, ' ').trim(),
    kinds: [...kinds].sort(),
  };
}
