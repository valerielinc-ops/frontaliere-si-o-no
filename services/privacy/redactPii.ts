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
 * ── SCOPE ──
 *
 * This redacts text **from here on**. It does nothing about records already in
 * GA4/PostHog: deleting personal data from a third-party system is irreversible
 * and is the owner's decision, not an agent's. See #5196.
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

/** Cues that introduce a person's name in the four locales. */
// Apostrophes are a character class, not a literal: the corpus mixes the ASCII
// `'` and the typographic `’`, and a rule that only knows one of them silently
// misses half the real inputs.
const APOS = "['’]";
const NAME_CUES =
  "mi\\s+chiamo|il\\s+mio\\s+nome\\s+[eè]|nome\\s+e\\s+cognome|nome|cognome|" +
  `my\\s+name\\s+is|i\\s+am\\s+called|i${APOS}?m\\s+called|` +
  "ich\\s+heisse|ich\\s+heiße|mein\\s+name\\s+ist|" +
  `je\\s+m${APOS}\\s*appelle|je\\s+me\\s+nomme|mon\\s+nom\\s+est`;

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

/** EN address: number first, then the street name, then the street type. */
const ADDRESS_EN = /\b\d{1,4}\s+[\p{L}][\p{L}'’.\-]*(?:\s+[\p{L}'’.\-]+){0,3}\s+(?:street|st\.|road|rd\.|avenue|ave\.|lane|drive|square)\b/giu;

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

/** Long digit runs — phones, and any other identifier the rules above missed. */
const PHONE = /\b(?:\+?\d[\s().-]?){7,}\d\b/g;

/** "mi chiamo Mario Rossi", "Nome: Hatam Kerimi". Captures up to three capitalised words. */
const NAME_AFTER_CUE = new RegExp(
  `\\b(${NAME_CUES})\\b(\\s*[:\\-]?\\s*)(\\p{Lu}[\\p{L}'’\\-]+(?:\\s+\\p{Lu}[\\p{L}'’\\-]+){0,2})`,
  'giu',
);

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

  apply(DATE_TEXTUAL, 'date');
  apply(DATE_ISO, 'date');
  apply(DATE_NUMERIC, 'date');

  apply(ADDRESS_IT_FR, 'address');
  apply(ADDRESS_DE, 'address');
  apply(ADDRESS_EN, 'address');
  // Anchored form first: proves the trailing "6965 Cadro" belongs to an address.
  out = out.replace(ZIP_CITY_AFTER_ADDRESS, () => {
    kinds.add('address');
    return REDACTION_TOKENS.address;
  });
  apply(ZIP_CITY, 'address');

  apply(PHONE, 'phone');

  // Names last: the cue/honorific rules must run before the generic run rule,
  // so "Nome: Hatam Kerimi" is caught even if the pair were somehow allowlisted.
  out = out.replace(NAME_AFTER_CUE, (_m, cue: string, sep: string) => {
    kinds.add('name');
    // Keep the cue and its separator: "Nome: [name]" still reads as a labelled
    // field, which is what makes the redacted question usable for analytics.
    return `${cue}${sep}${REDACTION_TOKENS.name}`;
  });
  out = out.replace(NAME_AFTER_HONORIFIC, (_m, title: string) => {
    kinds.add('name');
    return `${title} ${REDACTION_TOKENS.name}`;
  });
  if (inferNamesFromCapitalisation) {
    out = out.replace(CAPITALISED_RUN, (run: string) => {
      if (isDomainPhrase(run)) return run;
      kinds.add('name');
      return REDACTION_TOKENS.name;
    });
  }

  return {
    text: out.replace(/\s+/g, ' ').trim(),
    kinds: [...kinds].sort(),
  };
}
