/**
 * Affermazioni editoriali che non possono uscire sul sito, in ogni lingua.
 *
 * Audit del 31/10/2026: il corpus ripeteva in centinaia di articoli regole
 * fiscali opposte alla fonte ufficiale. La causa non era il singolo modello: la
 * scheda «fatti verificati» del generatore prescriveva essa stessa «trattenuta
 * SOLO in Svizzera (MAI "in entrambi i paesi")» ed «esenzione €7'500, regime
 * transitorio 2024–2033», e il fact-checker bloccava chi se ne discostava.
 *
 * Fonti delle regole qui sotto, lette il 31/10/2026:
 *  - Accordo Italia-Svizzera del 23.12.2020 (RS 0.642.045.43), art. 2, 3 e 9:
 *    i nuovi frontalieri sono imponibili in Svizzera fino all'80% e «lo Stato di
 *    residenza assoggetta a sua volta ad imposizione ed elimina la doppia
 *    imposizione»; solo chi rientra nell'art. 9 par. 1 resta imponibile
 *    «soltanto in Svizzera». Il 2033 dell'art. 9 par. 2 e' la
 *    fine della compensazione ai Comuni, non del regime fiscale.
 *  - L. 83/2023 art. 4 (dal 2027 TUIR D.Lgs. 117/2026 art. 217): franchigia di
 *    10.000 euro. Nessuna fonte ufficiale attribuisce 7.500 euro ai vecchi
 *    frontalieri, che su quel reddito non pagano IRPEF.
 *  - L. 213/2023 art. 1 c. 237-239: quota di compartecipazione al SSN dal 3% al
 *    6% del salario netto, da 30 a 200 euro per mese lavorato, definita ogni
 *    anno dalla Regione di residenza.
 *
 * Il modulo e' puro, senza import: sta nell'engine per scendere nel corpus con
 * il lockstep, e lo usano sia il generatore sia il gate su `content/**`.
 */

export const CLAIM_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

const ABBREVIATION_GUARD = String.raw`(?<![Aa]rt\.)(?<![Cc]pv\.)(?<!\bn\.)(?<!\bN\.)(?<!\bnr\.)(?<!\bNr\.)(?<!\bca\.)(?<!\bz\.B\.)(?<!\bd\.h\.)(?<!\bp\.es\.)`;
const GERMAN_DAY_DOT = String.raw`(?<!(?<!\d)\d{1,2}\.(?=\s+(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b))`;

/** Separa senza perdere nulla: le posizioni dispari sono i separatori originali. */
const SENTENCE_BOUNDARY = new RegExp(
  String.raw`(${ABBREVIATION_GUARD}${GERMAN_DAY_DOT}(?<=[.!?;])\s+|\\n|\n+|\s\|\s|"\s*\}\s*,\s*\{\s*\\?"q\\?"\s*:\s*\\?"|\\?"\s*,\s*\\?"a\\?"\s*:\s*\\?"|\\?"\s*\}\s*\]\s*$)`,
  'u',
);

/** Spezza un campo in frasi; `join('')` restituisce il testo identico. */
export function splitClaimSegments(text) {
  return String(text ?? '').split(SENTENCE_BOUNDARY);
}

const ONLY = {
  it: String.raw`(?:solo|soltanto|esclusivamente|unicamente|solamente)`,
  en: String.raw`(?:only|solely|exclusively)`,
  de: String.raw`(?:nur|ausschliesslich|ausschließlich|allein|einzig)`,
  fr: String.raw`(?:uniquement|seulement|exclusivement)`,
};
const IN_SWITZERLAND = {
  it: String.raw`(?:in|dalla|alla|nella)\s+(?:Svizzera|CH)\b`,
  en: String.raw`(?:in|by)\s+Switzerland\b`,
  de: String.raw`in\s+der\s+Schweiz\b`,
  fr: String.raw`en\s+Suisse\b`,
};

/** Frase che parla legittimamente d'altro: vecchi frontalieri, residenti, previdenza. */
const LEGITIMATE_SCOPE = {
  it: /vecch[ioae]\b|\bstoric[io]\b|\bex[- ]frontalier|regime\s+(?:transitorio|precedente|storico)|art(?:icolo|\.)?\s*9\b|accordo\s+del\s+1974|prima\s+del(?:l['’]|\s)|fino\s+al\s+(?:17|31|2023)|in\s+passato|residen\w+\s+(?:fiscale\s+)?in\s+Svizzera|risied\w*\s+in\s+Svizzera|vive\w*\s+in\s+Svizzera|trasferi\w+\s+in\s+Svizzera|permesso\s+[BCL]\b|dimora|domicili\w+\s+in\s+Svizzera|pension|rendit|AVS|LPP|LAMal|\bIVA\b|immobil|dividend|successione|mutuo|contribut/i,
  en: /\bold\b|\bhistoric|\bformer\b|legacy|transitional|art(?:icle|\.)?\s*9\b|1974|before\s|until\s+(?:17|31|2023)|in\s+the\s+past|resid\w+\s+in\s+Switzerland|lives?\s+in\s+Switzerland|mov\w+\s+to\s+Switzerland|[BCL]\s+permit|permit\s+[BCL]\b|pension|annuit|AHV|AVS|LPP|LAMal|\bVAT\b|real\s+estate|propert|dividend|inherit|mortgage|contribution/i,
  de: /\balt(?:e|en|er|es)?[\s»«„“”\"']+(?:Grenzg|Regel|Regim|System|Abkommen)|Altgrenz|bisherig|Übergangs|Art(?:ikel|\.)?\s*9\b|1974|\bvor\s+dem\s|bis\s+(?:zum\s+)?(?:17|31|2023)|früher|wohnhaft\s+in\s+der\s+Schweiz|in\s+der\s+Schweiz\s+(?:wohn|ansässig|leb)|ansässig\w*\s+in\s+der\s+Schweiz|[BCL][- ](?:Bewilligung|Ausweis)|(?:Ausweis|Bewilligung)\s+[BCL]\b|Rente|Pension|AHV|BVG|LPP|LAMal|KVG|MWST|Immobil|Dividend|Erbschaft|Hypothek|Beitr[aä]g/i,
  fr: /anciens?\s*»?\s+(?:frontalier|travailleur|régime|accord)|\bhistoriques?\b|régime\s+(?:transitoire|précédent)|art(?:icle|\.)?\s*9\b|1974|avant\s+(?:le|l['’]|2024)|jusqu['’]au\s+(?:17|31|2023)|par\s+le\s+passé|résid\w+\s+en\s+Suisse|vit\s+en\s+Suisse|s['’]install\w+\s+en\s+Suisse|permis\s+[BCL]\b|retraite|pension|rente|AVS|LPP|LAMal|\bTVA\b|immobili|dividend|succession|hypoth|cotisation/i,
};

const TAX_CONTEXT = {
  it: /tass|impost|imposiz|fiscal|Irpef|alla\s+fonte|imponibil|prelievo|trattenut|ritenut/i,
  en: /tax|withh|deduct|IRPEF|fiscal|levied/i,
  de: /steuer|besteuer|einbehalt|Quelle|IRPEF|Fiskus|abgezogen|Abzug/i,
  fr: /impos|impôt|fiscal|IRPEF|retenu|prélev|taxé|taxat/i,
};

const BOTH_COUNTRIES = {
  it: [
    /\s*\((?:e\s+)?(?:mai|non)\s+in\s+entrambi[^)]*\)/gi,
    /\s*[,;:—–-]+\s*(?:e\s+)?(?:mai|non)\s+in\s+entrambi\s+i\s+paesi(?:\s+contemporaneamente)?/gi,
    /\s+e\s+(?:mai|non)\s+in\s+entrambi\s+i\s+paesi(?:\s+contemporaneamente)?/gi,
  ],
  en: [
    /\s*\((?:and\s+)?(?:never|not)\s+in\s+both[^)]*\)/gi,
    /\s*[,;:—–-]+\s*(?:and\s+)?(?:never|not)\s+in\s+both\s+countries(?:\s+at\s+the\s+same\s+time)?/gi,
    /\s+(?:and\s+)?(?:never|not)\s+in\s+both\s+countries(?:\s+at\s+the\s+same\s+time)?/gi,
  ],
  de: [
    /\s*\((?:und\s+)?(?:nie(?:mals)?|nicht)\s+in\s+beiden[^)]*\)/gi,
    /\s*[,;:—–-]+\s*(?:und\s+)?(?:nie(?:mals)?|nicht)\s+in\s+beiden\s+Ländern(?:\s+gleichzeitig)?/gi,
    /\s+(?:und\s+)?(?:nie(?:mals)?|nicht)\s+in\s+beiden\s+Ländern(?:\s+gleichzeitig)?/gi,
  ],
  fr: [
    /\s*\((?:et\s+)?(?:jamais|pas|non)\s+dans\s+les\s+deux[^)]*\)/gi,
    /\s*[,;:—–-]+\s*(?:et\s+)?(?:jamais|pas|non)\s+dans\s+les\s+deux\s+pays(?:\s+en\s+même\s+temps)?/gi,
    /\s+(?:et\s+)?(?:jamais|pas|non)\s+dans\s+les\s+deux\s+pays(?:\s+en\s+même\s+temps)?/gi,
  ],
};

const NO_DOUBLE_TAXATION = {
  it: [/(?:\bsenza(?:\s+alcuna)?|(?<=[,—–-]\s)(?:niente|nessuna))\s+doppia\s+(?:imposizione|tassazione)(?:\s+fiscale)?/gi, "con credito d'imposta in Italia per i nuovi frontalieri"],
  en: [/(?:\bwithout(?:\s+any)?|\bwith\s+no|(?<=[,—–-]\s)no)\s+double\s+taxation/gi, 'with an Italian tax credit for new cross-border workers'],
  de: [/(?:\bohne|(?<=[,—–-]\s)keine)\s+Doppelbesteuerung/gi, 'mit Steuergutschrift in Italien für neue Grenzgänger'],
  fr: [/(?:\bsans|(?<=[,—–-]\s)(?:pas\s+de|aucune))\s+double\s+imposition/gi, "avec crédit d'impôt en Italie pour les nouveaux frontaliers"],
};

/** Inserita dove il testo dice «tassato» e non solo «trattenuto». */
const NEW_WORKER_NOTE = {
  it: " (per i nuovi frontalieri anche in Italia, con credito d'imposta)",
  en: ' (for new cross-border workers also in Italy, with a tax credit)',
  de: ' (bei neuen Grenzgängern auch in Italien, mit Steuergutschrift)',
  fr: " (pour les nouveaux frontaliers aussi en Italie, avec crédit d'impôt)",
};
const CLAIMS_TAXATION = {
  it: /\b(?:tassat[oaie]|tassazione|imposizione|tasse|imposte\b(?!\s+alla\s+fonte)|imponibil\w+)\b/i,
  en: /\b(?:taxed|taxation|taxes\b|taxable)\b/i,
  de: /\b(?:besteuert|Besteuerung|Steuern\b|steuerpflichtig|Steuerpflicht)\b/i,
  fr: /\b(?:imposés?|imposées?|imposition|taxés?|taxation|impôts\b|imposables?)\b/i,
};
const MENTIONS_CREDIT = /credito\s+d|tax\s+credit|Steuergutschrift|crédit\s+d/i;
/** «Trattenuta in Svizzera» resta vera per tutti: la nota serve solo a «tassato». */
const WITHHOLDING_ONLY = {
  it: /trattenut|ritenut|alla\s+fonte/i,
  en: /withh|deduct|at\s+source/i,
  de: /einbehalt|Quellensteuer|abgezogen/i,
  fr: /retenu|prélev|à\s+la\s+source/i,
};

function exclusiveRe(locale, flags = 'i') {
  return new RegExp(String.raw`\b${ONLY[locale]}\b(\*\*)?\s+(\*\*)?${IN_SWITZERLAND[locale]}`, flags);
}

const EXCLUSIVE_TAXATION_NOUN = {
  it: /\b(?:tassazione|imposizione)\s+(?:esclusiv\w+|unica|solo\s+alla\s+fonte)\s+(?:alla\s+fonte\s+)?(?:in\s+Svizzera|svizzera)|\btassazione\s+(?:esclusiv\w+|unica)\s+nel\s+[Pp]aese\s+(?:dove|di)\s+\w+(?:\s*\(Svizzera\))?/i,
  en: /\b(?:exclusive|sole|single)\s+(?:taxation|taxing\s+right)\s+(?:at\s+source\s+)?in\s+Switzerland/i,
  de: /\b(?:ausschliessliche|ausschließliche|alleinige|einzige)\s+(?:Besteuerung|Quellenbesteuerung)\s+in\s+der\s+Schweiz/i,
  fr: /\b(?:imposition|taxation)\s+(?:exclusive|unique)\s+en\s+Suisse/i,
};

/** Forma telegrafica degli elenchi: «imposta alla fonte solo Svizzera». */
const TERSE_EXCLUSIVE = {
  it: [/\b(fonte|trattenut\S*)\s+solo\s+Svizzera\b/gi, '$1 in Svizzera'],
  en: [/\b(source|withholding\s+tax|withheld|deducted)\s+only\s+Switzerland\b/gi, '$1 in Switzerland'],
  de: [/\b(Quellensteuer|einbehalten)\s+nur\s+Schweiz\b/gi, '$1 in der Schweiz'],
  fr: [/\b(source|retenu\S*)\s+(?:uniquement|seulement)\s+Suisse\b/gi, '$1 en Suisse'],
};

/** Il soggetto della frase e' il nuovo frontaliere, anche se poi cita i vecchi. */
const NEW_WORKER_SUBJECT = {
  it: /\bnuov[oi]\s+frontalier\S*/i,
  en: /\bnew\s+(?:cross-border|border|frontier)\s+\S+/i,
  de: /\bneuen?\s+Grenzgänger\S*/i,
  fr: /\bnouveaux?\s+(?:travailleurs\s+)?frontaliers?\b/i,
};

function newWorkerExclusiveClause(sentence, locale) {
  const subject = NEW_WORKER_SUBJECT[locale].exec(sentence);
  if (!subject) return null;
  const clause = sentence.slice(subject.index).split(/[,;:]/u)[0];
  const exclusive = exclusiveRe(locale).exec(clause);
  return exclusive ? { index: subject.index + exclusive.index, text: exclusive[0] } : null;
}

/** Vero se la frase generalizza l'imposizione esclusiva svizzera ai frontalieri. */
function isRegimeClaim(sentence, locale) {
  if (newWorkerExclusiveClause(sentence, locale)) return true;
  if (LEGITIMATE_SCOPE[locale].test(sentence)) return false;
  if (!TAX_CONTEXT[locale].test(sentence)) return false;
  if (exclusiveRe(locale).test(sentence) || EXCLUSIVE_TAXATION_NOUN[locale].test(sentence)) return true;
  if (sentence.search(TERSE_EXCLUSIVE[locale][0]) !== -1) return true;
  return BOTH_COUNTRIES[locale].some((re) => {
    re.lastIndex = 0;
    return re.test(sentence);
  });
}

/** Riscrive una frase con imposizione esclusiva generalizzata, o torna `null`. */
export function repairRegimeSentence(sentence, locale) {
  if (!isRegimeClaim(sentence, locale)) return null;
  // Solo la clausola sul nuovo frontaliere: quella sui vecchi e' vera e resta.
  const clause = newWorkerExclusiveClause(sentence, locale);
  if (clause) {
    const place = clause.text.match(new RegExp(IN_SWITZERLAND[locale], 'i'))?.[0] ?? '';
    const [noDouble, withCredit] = NO_DOUBLE_TAXATION[locale];
    const tail = sentence.slice(clause.index + clause.text.length);
    const fixedTail = tail.replace(noDouble, withCredit);
    const note = fixedTail === tail ? NEW_WORKER_NOTE[locale] : '';
    return `${sentence.slice(0, clause.index)}${place}${note}${fixedTail}`;
  }
  let out = sentence.replace(
    new RegExp(String.raw`(\*\*)?\b${ONLY[locale]}\b(\*\*)?\s+(\*\*)?(${IN_SWITZERLAND[locale]})(\*\*)?`, 'gi'),
    (match, open, innerClose, innerOpen, place, close) => {
      const bold = (open || innerOpen) && close;
      return bold ? `**${place}**` : place;
    },
  );
  const adverbRemoved = out !== sentence;
  out = out.replace(...TERSE_EXCLUSIVE[locale]);
  for (const re of BOTH_COUNTRIES[locale]) out = out.replace(re, '');
  out = out.replace(EXCLUSIVE_TAXATION_NOUN[locale], (match) => (locale === 'it'
    ? 'tassazione in Svizzera'
    : { en: 'taxation in Switzerland', de: 'Besteuerung in der Schweiz', fr: 'imposition en Suisse' }[locale]));
  const [noDouble, withCredit] = NO_DOUBLE_TAXATION[locale];
  const rewroteDouble = noDouble.test(out);
  noDouble.lastIndex = 0;
  out = out.replace(noDouble, withCredit);
  if (adverbRemoved && !rewroteDouble && CLAIMS_TAXATION[locale].test(sentence)
    && !WITHHOLDING_ONLY[locale].test(sentence) && !MENTIONS_CREDIT.test(out)) {
    out = out.replace(new RegExp(IN_SWITZERLAND[locale], 'i'), (place) => `${place}${NEW_WORKER_NOTE[locale]}`);
  }
  return out === sentence ? null : out;
}

const AMOUNT_7500 = String.raw`\b7[.,'’\s]?500\b`;
const OLD_FRANCHISE_NOUN = {
  it: /esenzion|franchigi|esent[ie]|non\s+(?:è\s+)?(?:tassat|soggett|imponibil)|regime\s+transitorio/i,
  en: /exempt|franchise|allowance|deductible|transitional|not\s+(?:be\s+)?taxed|tax-free/i,
  de: /Freibetrag|Befreiung|befreit|Selbstbehalt|Franchise|steuerfrei|Übergangs|nicht\s+besteuert/i,
  fr: /exon[ée]r|franchise|abattement|transitoire|non\s+impos|pas\s+impos/i,
};
const WORKED_EXAMPLE = /=|×|\bx\b\s*\d|\d\s*[-−–]\s*(?:€|CHF|EUR)?\s*7/;
const OFF_TOPIC_7500 = {
  it: /metro\s+quadr|\bm²|stipendio|salario|al\s+mese|mensil|premio|affitt|prezzo|costo|multa|sanzion|prestito|malattia/i,
  en: /square\s+met|\bm²|salary|per\s+month|monthly|premium|rent|price|cost|fine\b|penalt|loan|illness/i,
  de: /Quadratmeter|\bm²|Gehalt|Lohn|pro\s+Monat|monatlich|Prämie|Miete|Preis|Kosten|Busse|Strafe|Darlehen|Krankheit/i,
  fr: /mètre\s+carré|\bm²|salaire|par\s+mois|mensuel|prime|loyer|prix|coût|amende|sanction|prêt|maladie/i,
};
const TRANSITIONAL_2033 = {
  it: /regime\s+transitorio[^.;|]{0,40}2033|2024\s*[-–—]\s*2033[^.;|]{0,30}regime|(?:vecchi|esenzion)[^.;|]{0,90}(?:fino\s+al|entro\s+il|sino\s+al)\s+(?:31\s+dicembre\s+)?2033/i,
  en: /transitional\s+(?:regime|scheme|period)[^.;|]{0,40}2033|2024\s*[-–—]\s*2033[^.;|]{0,30}(?:regime|scheme)|(?:\bold\b|exempt)[^.;|]{0,90}(?:until|through|to)\s+(?:31\s+December\s+)?2033/i,
  de: /Übergangs\w*[^.;|]{0,40}2033|2024\s*[-–—]\s*2033[^.;|]{0,30}(?:Regelung|Regime)|(?:\balt\w*\s+Grenzg|Altgrenz|Befreiung)[^.;|]{0,90}bis\s+(?:zum\s+)?(?:31\.?\s+Dezember\s+)?2033/i,
  fr: /régime\s+transitoire[^.;|]{0,40}2033|2024\s*[-–—]\s*2033[^.;|]{0,30}régime|(?:anciens|exon[ée]r)[^.;|]{0,90}jusqu['’](?:au|en)\s+(?:31\s+décembre\s+)?2033/i,
};
const RISTORNI_CONTEXT = {
  it: /ristorn|compensazion|comuni\s+(?:italiani|di\s+confine)|40\s?%/i,
  en: /ristorn|rebate|refund|compensation|municipalit|40\s?%/i,
  de: /Ristorn|Rückerstattung|Rückzahlung|Ausgleich|Gemeinden|40\s?%/i,
  fr: /ristorn|rétrocession|remboursement|compensation|communes|40\s?%/i,
};
const MENTIONS_NEW_WORKERS = {
  it: /\bnuov[oiae]\b|10[.'’\s ]?000/i,
  en: /\bnew\b|10[,.'’\s ]?000/i,
  de: /\bneu(?:e|en|er|es)?\b|10[.'’\s ]?000/i,
  fr: /\bnouveaux?\b|\bnouvelles?\b|10[.'’\s ]?000/i,
};
const ANY_7500 = new RegExp(AMOUNT_7500);

/** Una frase che attribuisce ai vecchi frontalieri la franchigia 7.500 o il 2033. */
function isOldRegimeClaim(sentence, locale) {
  if (RISTORNI_CONTEXT[locale].test(sentence) && !ANY_7500.test(sentence)) return false;
  if (ANY_7500.test(sentence)) {
    return OLD_FRANCHISE_NOUN[locale].test(sentence) && !OFF_TOPIC_7500[locale].test(sentence);
  }
  return TRANSITIONAL_2033[locale].test(sentence);
}

const OLD_REGIME_TEXT = {
  it: {
    both: 'I nuovi frontalieri hanno una franchigia IRPEF di 10.000 euro, mentre i vecchi frontalieri restano tassati solo in Svizzera (art. 9 dell\'Accordo del 2020).',
    old: 'I vecchi frontalieri restano tassati solo in Svizzera (art. 9 dell\'Accordo del 2020).',
    question: 'Quale regime fiscale si applica ai vecchi frontalieri?',
  },
  en: {
    both: 'New cross-border workers have a €10,000 IRPEF allowance, while old cross-border workers remain taxed only in Switzerland (Art. 9 of the 2020 Agreement).',
    old: 'Old cross-border workers remain taxed only in Switzerland (Art. 9 of the 2020 Agreement).',
    question: 'Which tax regime applies to old cross-border workers?',
  },
  de: {
    both: 'Neue Grenzgänger haben einen IRPEF-Freibetrag von 10.000 Euro, während alte Grenzgänger weiterhin nur in der Schweiz besteuert werden (Art. 9 des Abkommens von 2020).',
    old: 'Alte Grenzgänger werden weiterhin nur in der Schweiz besteuert (Art. 9 des Abkommens von 2020).',
    question: 'Welche Steuerregelung gilt für alte Grenzgänger?',
  },
  fr: {
    both: "Les nouveaux frontaliers ont une franchise IRPEF de 10 000 euros, tandis que les anciens frontaliers restent imposés uniquement en Suisse (art. 9 de l'Accord de 2020).",
    old: "Les anciens frontaliers restent imposés uniquement en Suisse (art. 9 de l'Accord de 2020).",
    question: 'Quel régime fiscal s’applique aux anciens frontaliers ?',
  },
};

const LIST_MARKER = /^\s*(?:[-*•]\s+|\d+[.)]\s+|\|\s*)?/u;
const BOLD_LABEL = /^(?:\*\*[^*?]{1,50}:?\*\*:?\s*)/u;

/** «€7.500 (vecchi) o €10.000 (nuovi)», «€7.500–€10.000»: basta togliere la prima cifra. */
const AMOUNT_PAIR = new RegExp(
  String.raw`(?:[€]|EUR|CHF)?\s?7[.,'’\s]?500(?:\s?(?:[€]|euro|EUR|CHF))?(?:\s*\([^)]{0,30}\))?\s*(?:[–—/-]|\b(?:o|e|vs\.?|or|and|oder|und|ou|et)\b)\s*(?:[^\d€.;|]{0,25})?(?=(?:[€]|EUR|CHF)?\s?10[.,'’\s]?000)`,
  'gi',
);

/** Riscrive la frase sui 7.500 euro o sul 2033, oppure torna `null`. */
export function repairOldRegimeSentence(sentence, locale) {
  if (!isOldRegimeClaim(sentence, locale)) return null;
  if (WORKED_EXAMPLE.test(sentence)) return null;
  const narrowed = sentence.replace(AMOUNT_PAIR, '');
  if (narrowed !== sentence && !isOldRegimeClaim(narrowed, locale) && narrowed.length > 40) return narrowed;
  const copy = OLD_REGIME_TEXT[locale];
  const isQuestion = /\?\s*$/.test(sentence);
  const text = isQuestion ? copy.question : (MENTIONS_NEW_WORKERS[locale].test(sentence) ? copy.both : copy.old);
  const marker = sentence.match(LIST_MARKER)?.[0] ?? '';
  const label = isQuestion ? '' : (sentence.slice(marker.length).match(BOLD_LABEL)?.[0] ?? '');
  // Un'etichetta che porta la cifra errata non si conserva.
  return `${marker}${ANY_7500.test(label) ? '' : label}${text}`;
}

/**
 * «Il frontaliere non paga imposte in Italia» detto senza limitarlo ai vecchi:
 * e' la stessa regola sbagliata scritta dalla parte dell'Italia. Le soglie e il
 * caso dell'imposta svizzera piu' alta restano fuori: li' la frase e' vera.
 */
const NO_ITALIAN_TAX = {
  it: /\bnon\s+(?:dovr\S*|dev\S*|ha\s+da|paga\S*|pagher\S*|versa\S*)\s+(?:più\s+)?(?:pagare|versare|dichiarare|presentare\s+la\s+dichiarazione|nulla|alcuna)?[^.;|]{0,30}(?:imposte?|tasse|Irpef|dichiarazione\s+dei\s+redditi)[^.;|]{0,25}\b(?:in\s+Italia|italian[ae])|\bsenza\s+(?:dover\s+)?pagare\s+(?:le\s+)?(?:imposte|tasse)\s+(?:italiane|in\s+Italia)|\bnon\s+(?:è|sono|viene|vengono)\s+tassat\w+\s+in\s+Italia|\b(?:nessuna|senza)\s+(?:imposta|imposizione|tassazione)\s+(?:parallela|in\s+Italia|italiana)|\bnon\s+a\s+imposta\s+parallela\s+italiana|\besent\w+\s+(?:da(?:lle|ll['’])?\s+)?(?:Irpef|tasse\s+aggiuntive|imposte)\s+in\s+Italia|\btrattenuta\s+è\s+solo\s+svizzera/i,
  en: /\b(?:do(?:es)?\s+not|don['’]t|doesn['’]t|will\s+not|won['’]t|need\s+not)\s+(?:have\s+to\s+|need\s+to\s+)?(?:pay|file|declare)[^.;|]{0,30}(?:tax(?:es)?|IRPEF|return)[^.;|]{0,25}\b(?:in\s+Italy|Italian)|\bwithout\s+(?:having\s+to\s+)?pay(?:ing)?\s+(?:any\s+)?(?:Italian\s+tax(?:es)?|tax(?:es)?\s+in\s+Italy)|\b(?:is|are)\s+not\s+taxed\s+in\s+Italy|\bno\s+(?:parallel\s+)?(?:tax(?:ation)?)\s+in\s+(?:Italy|the\s+country\s+of\s+residence)/i,
  de: /\b(?:muss|müssen|müsste\w*|wird|werden)\s+[^.;|]{0,30}\b(?:keine|nicht)\s+[^.;|]{0,25}(?:Steuern?|IRPEF|Steuererklärung)[^.;|]{0,30}\bin\s+Italien|\b(?:wird|werden)\s+[^.;|]{0,20}in\s+Italien\s+nicht\s+besteuert|\bkeine\s+(?:parallele\s+)?(?:Besteuerung|Steuer)\s+(?:in\s+Italien|im\s+Wohnsitzland)|\bohne\s+[^.;|]{0,15}italienische\s+Steuern/i,
  fr: /\b(?:ne\s+(?:paie|paient|paiera|paieront|devra|devront|doit|doivent)\b)[^.;|]{0,40}(?:impôts?|IRPEF|déclaration)[^.;|]{0,25}\b(?:en\s+Italie|italien\w*)|\bsans\s+(?:devoir\s+)?payer\s+(?:d['’]|les\s+)?impôts?\s+(?:italiens|en\s+Italie)|\bn['’](?:est|sont)\s+pas\s+imposés?\s+en\s+Italie|\baucune?\s+(?:imposition|impôt)\s+(?:parallèle\s+)?(?:en\s+Italie|dans\s+le\s+pays\s+de\s+résidence)/i,
};
const NO_ITALIAN_TAX_EXEMPT = {
  it: /franchigi|soglia|fino\s+a|sotto|10[.'’\s]?000|superiore|più\s+alt|già\s+coper|non\s+residenti|credito\s+d['’]imposta\s+(?:copre|azzera)/i,
  en: /allowance|deductible|franchise|threshold|up\s+to|below|under\b|10[,.'’\s]?000|higher|non-resident/i,
  de: /Freibetrag|Selbstbehalt|Schwelle|bis\s+zu|unter(?:halb)?\b|10[.'’\s]?000|höher|Nichtansässig/i,
  fr: /franchise|seuil|jusqu['’]à|en\s+dessous|sous\b|10[\s.'’]?000|supérieur|plus\s+élevé|non-résident/i,
};
const NO_ITALIAN_TAX_TEXT = {
  it: "I nuovi frontalieri dichiarano il reddito anche in Italia e recuperano l'imposta svizzera con il credito d'imposta, mentre i vecchi frontalieri restano tassati solo in Svizzera (art. 9 dell'Accordo del 2020).",
  en: 'New cross-border workers also declare their income in Italy and recover the Swiss tax through the tax credit, while old cross-border workers remain taxed only in Switzerland (Art. 9 of the 2020 Agreement).',
  de: 'Neue Grenzgänger deklarieren ihr Einkommen auch in Italien und rechnen die Schweizer Steuer über die Steuergutschrift an, während alte Grenzgänger weiterhin nur in der Schweiz besteuert werden (Art. 9 des Abkommens von 2020).',
  fr: "Les nouveaux frontaliers déclarent aussi leur revenu en Italie et récupèrent l'impôt suisse via le crédit d'impôt, tandis que les anciens frontaliers restent imposés uniquement en Suisse (art. 9 de l'Accord de 2020).",
};

function isNoItalianTaxClaim(sentence, locale) {
  return NO_ITALIAN_TAX[locale].test(sentence)
    && !LEGITIMATE_SCOPE[locale].test(sentence)
    && !NO_ITALIAN_TAX_EXEMPT[locale].test(sentence)
    && !/\?\s*$/.test(sentence);
}

/** Sostituisce la frase intera: non esiste una versione minima vera della regola. */
export function repairNoItalianTaxSentence(sentence, locale) {
  if (!isNoItalianTaxClaim(sentence, locale)) return null;
  const marker = sentence.match(LIST_MARKER)?.[0] ?? '';
  return `${marker}${NO_ITALIAN_TAX_TEXT[locale]}`;
}

/**
 * Eco del prompt: l'elenco di parole chiave del generatore («permesso G, AVS,
 * LPP, … nuovo accordo fiscale 2026, doppia imposizione») e l'avviso «(NON 2026)»
 * della scheda fatti finivano stampati come frasi. Il nome «accordo fiscale 2026»
 * non esiste: l'Accordo e' applicabile dal 2024.
 */
const KEYWORD_LABEL = {
  it: /\bnuovo\s+accordo\s+fiscale(?:\s+del)?\s+2026\b/gi,
  en: /\bnew\s+(?:2026\s+)?(?:tax|fiscal)\s+agreement(?:\s+(?:of\s+)?2026)?\b(?<=2026\s(?:tax|fiscal)\sagreement|agreement\s2026|agreement\sof\s2026)/gi,
  de: /\b(neue[nsr]?\s+(?:Steuerabkommens?|Steuervertrag(?:s|es)?))\s+(?:von\s+|aus\s+|im\s+Jahr\s+)?2026\b/gi,
  fr: /\b(nouvel\s+accord\s+fiscal)\s+(?:de\s+)?2026\b/gi,
};
const KEYWORD_LABEL_REPLACEMENT = { it: 'Nuovo Accordo Frontalieri', en: 'new tax agreement', de: '$1', fr: '$1' };
const PROMPT_KEYWORDS = {
  it: /permesso\s+G|\bAVS\b|\bLPP\b|LAMal|ristorni|imposta\s+alla\s+fonte|\bINPS\b|Brogeda|doppia\s+imposizione|accordo\s+fiscale\s+2026/gi,
  en: /G[- ]permit|permit\s+G|\bAVS\b|\bAHV\b|\bLPP\b|LAMal|ristorni|rebates|withholding\s+tax|\bINPS\b|Brogeda|double\s+taxation|tax\s+agreement/gi,
  de: /G-(?:Bewilligung|Ausweis)|Ausweis\s+G|Permesso\s+G|\bAVS\b|\bAHV\b|\bLPP\b|\bBVG\b|LAMal|Ristorni|Rückerstattung\w*|Quellensteuer|\bINPS\b|Brogeda|Doppelbesteuerung|Steuerabkommen\w*/gi,
  fr: /permis\s+G|\bAVS\b|\bLPP\b|LAMal|ristorni|rétrocessions?|remboursements|impôt\s+à\s+la\s+source|\bINPS\b|Brogeda|double\s+imposition|accord\s+fiscal/gi,
};
const PROMPT_NEGATION = {
  it: /\bnon\b|\bné\b|neppure|nemmeno/i,
  en: /\bnot?\b|\bnor\b|neither|without/i,
  de: /\bkein\w*|\bnicht\b|\bweder\b/i,
  fr: /\bne\b|\bn['’]|\bni\b|\bsans\b/i,
};
const PROMPT_LIST_CUE = {
  it: /\b(?:la\s+fonte|il\s+testo|l['’]articolo|il\s+comunicato|la\s+notizia|il\s+documento)\b|\bnon\s+(?:parla|tratta|cita|contiene|indica|fornisce|riporta|entra|menziona|elenca|compare|compaiono|quantifica|offre)\b|\bnessun\s+(?:dato|riferimento|cenno)|\bnon\s+si\s+possono\s+ricavare/i,
  en: /\bthe\s+(?:source|text|article|communication|statement|notice)\b|\b(?:does|do)\s+not\s+(?:mention|cover|address|contain|discuss|provide|cite|deal)|\bprovides?\s+no\b|\bno\s+information\b/i,
  de: /\b(?:die\s+Quelle|der\s+Text|der\s+Artikel|die\s+Mitteilung)\b|\b(?:enthält|nennt|erwähnt|behandelt|liefert)\b[^.]{0,20}\b(?:keine|nicht)\b|\bkeine\s+Angaben/i,
  fr: /\b(?:la\s+source|le\s+texte|l['’]article|le\s+communiqué)\b|\bne\s+(?:mentionne|traite|contient|cite|décrit|fournit|précise|donne|parle)\b|\baucune\s+(?:information|donnée)|\bne\s+dit\s+rien/i,
};
const DATE_WARNING = {
  it: /,?\s*non\s+(?:il|al|dal|nel)\s+2026\b|\bdicitura\b[^.]{0,60}accordo\s+fiscale|\b(?:formula|espressione)\s+[«"]?nuovo\s+accordo\s+fiscale|\briferimento\s+corretto,?\s+quindi|\bcalendario\s+corretto\s+non\s+è\s+il\s+2026|accordo\s+fiscale\s+2026[^.]{0,80}\b(?:non\s+(?:coincide|sostituisce|sposta|indica|descrive|equivale|va)|decorrenza)/i,
  en: /,?\s*not\s+(?:in\s+)?2026\b|\b(?:wording|phrase|expression|label)\b[^.]{0,40}tax\s+agreement|tax\s+agreement[^.]{0,80}\b(?:does\s+not\s+(?:replace|come\s+into|coincide|mean)|must\s+therefore|correct\s+(?:effective\s+)?date)/i,
  de: /,?\s*nicht\s+(?:erst\s+)?2026\b|\b(?:Formulierung|Bezeichnung|Ausdruck)\b[^.]{0,40}Steuerabkommen|Steuerabkommen[^.]{0,80}\b(?:ersetzt\s+nicht|nicht\s+(?:mit|das)|zu\s+überprüfende\s+Datum)/i,
  fr: /,?\s*(?:et\s+)?(?:non|pas)\s+(?:en\s+)?2026\b|\b(?:mention|expression|formule)\b[^.]{0,40}accord\s+fiscal|accord\s+fiscal[^.]{0,80}\b(?:ne\s+(?:remplace|coïncide|doit)|trompeuse|date\s+à\s+retenir)/i,
};

function isPromptEcho(sentence, locale) {
  if (DATE_WARNING[locale].test(sentence)) return true;
  const hits = new Set((sentence.match(PROMPT_KEYWORDS[locale]) ?? []).map((word) => word.toLowerCase()));
  return hits.size >= 3 && PROMPT_NEGATION[locale].test(sentence) && PROMPT_LIST_CUE[locale].test(sentence);
}

/** Toglie l'eco del prompt; il solo nome «2026» si corregge sul posto. */
export function repairPromptEchoSentence(sentence, locale) {
  if (isPromptEcho(sentence, locale)) return '';
  const label = KEYWORD_LABEL[locale];
  label.lastIndex = 0;
  if (!label.test(sentence)) return null;
  label.lastIndex = 0;
  return sentence.replace(label, KEYWORD_LABEL_REPLACEMENT[locale]);
}

function hasPromptEcho(sentence, locale) {
  if (isPromptEcho(sentence, locale)) return true;
  const label = KEYWORD_LABEL[locale];
  label.lastIndex = 0;
  return label.test(sentence);
}

/** Etichette del prompt tradotte: «TITOLO ARTICOLO:» arriva in quattro lingue. */
const PROMPT_TITLE_LABEL = /(?<![\p{L}\p{N}])(?:TITOLO\s+(?:DELL['’]?ARTICOLO|ARTICOLO)|TITRE(?:\s+(?:DE\s+L['’]ARTICLE|ARTICLE))?|TITEL(?:\s+(?:DES\s+ARTIKELS|ARTIKEL))?|ARTIKEL-?TITEL|ARTICLE\s+TITLE|TITLE\s+ARTICLE|TITLE\s+OF\s+THE\s+ARTICLE)\s*:\s*/u;
const LABEL_LINE_MAX = 180;
/** Stessa etichetta come riga intera, anche in minuscolo o come intestazione. */
const PROMPT_TITLE_LINE = /^[ \t]*#{0,6}[ \t]*(?:\*\*)?(?:titolo\s+(?:dell['’]?articolo|articolo)|article\s+title|title\s+of\s+the\s+article|title\s+article|titel\s+des\s+artikels|artikel-?titel|titre\s+(?:de\s+l['’]artic\S*|article))(?:\*\*)?[ \t]*(?::[^\n]{0,200})?$\n?/gimu;

/**
 * Toglie la riga con l'etichetta del prompt. Se dopo l'etichetta c'e' testo vero
 * sulla stessa riga si toglie solo il titolo noto, altrimenti la sola etichetta.
 */
export function stripPromptTitleLabels(text, { title = '' } = {}) {
  let removed = 0;
  let value = String(text ?? '').replace(PROMPT_TITLE_LINE, () => {
    removed += 1;
    return '';
  });
  if (removed > 0) value = value.replace(/\n{3,}/g, '\n\n');
  for (let match = value.match(PROMPT_TITLE_LABEL); match; match = value.match(PROMPT_TITLE_LABEL)) {
    const start = match.index;
    const afterLabel = start + match[0].length;
    const newline = value.indexOf('\n', afterLabel);
    const lineEnd = newline === -1 ? value.length : newline;
    const rest = value.slice(afterLabel, lineEnd);
    let cut = afterLabel;
    if (rest.length <= LABEL_LINE_MAX) cut = lineEnd;
    else if (title && rest.startsWith(title)) cut = afterLabel + title.length;
    const before = value.slice(0, start).replace(/[ \t]+$/, '');
    const after = value.slice(cut);
    value = cut === lineEnd ? `${before.replace(/\n+$/, '')}${after}` : `${before}${before ? ' ' : ''}${after.replace(/^\s+/, '')}`;
    removed += 1;
  }
  return { value, removed };
}

/**
 * Permesso G. SEM, FAQ del 06.07.2026: «Se il contratto di lavoro presentato dura
 * meno di un anno, la durata di validità del permesso equivale alla durata di
 * validità del contratto. Se il contratto di lavoro ha una validità superiore a
 * un anno, il permesso vale cinque anni.» e «I cittadini dell'UE/AELS non
 * sottostanno più alle zone di frontiera.» I 20 km sono dell'Accordo fiscale.
 * Sezione della popolazione del Ticino: la richiesta va trasmessa «prima
 * d'iniziare l'attività». Gli importi cambiano per cantone e fattispecie: una
 * cifra non verificata si toglie, non si sostituisce.
 */
const G_PERMIT = {
  it: /permess[oi]\s+(?:di\s+frontalier\w+\s+)?G\b|\*\*permesso\s+G\*\*/i,
  en: /\bG[- ]permits?\b|\bpermits?\s+G\b/i,
  de: /\bG-(?:Bewilligung|Ausweis)|\b(?:Bewilligung|Ausweis)\s+G\b|\bPermesso\s+G\b|Grenzgängerbewilligung/i,
  fr: /\bpermis\s+G\b|\bpermis\s+frontalier/i,
};
const G_WRONG_DURATION = {
  it: /\b(?:dura|durata|valid\S*|rinnov\S*|scad\S*)\b[^.;|]{0,70}\b(?:(?:massimo\s+(?:di\s+)?)?(?:1|2|3|4|8|10|un|uno|due|tre|otto|dieci)\s+ann[oi]|12\s+mesi|1\s*[-–]\s*[25]\s+anni|annuale?\b|ogni\s+(?:anno|due\s+anni))/i,
  en: /\b(?:valid|lasts?|duration|renew\S*|expires?)\b[^.;|]{0,70}\b(?:(?:1|2|3|4|8|10|one|two|three|eight|ten)[- ]years?|12\s+months|1\s*[-–]\s*[25]\s+years|annual|every\s+(?:year|two\s+years))/i,
  de: /\b(?:gültig\S*|dauert|Dauer|verlänger\S*|Gültigkeit)\b[^.;|]{0,70}\b(?:(?:1|2|3|4|8|10|ein\S*|zwei|drei|acht|zehn)\s+Jahr\S*|12\s+Monate|1\s*[-–]\s*[25]\s+Jahre|jährlich)|\b(?:1|2|3|4|8|10|ein\S*|zwei|drei|acht|zehn)\s+Jahre?\s+gültig/i,
  fr: /\b(?:valable|dur\S*|validité|renouvel\S*|expire)\b[^.;|]{0,70}\b(?:(?:1|2|3|4|8|10|un|une|deux|trois|huit|dix)\s+ans?\b|12\s+mois|1\s*[-–]\s*[25]\s+ans|annuel\S*|chaque\s+année)/i,
};
const G_COST_WORD = {
  it: String.raw`(?:costo|costa|quota|tariffa|emolument\w*|importo|pagamento|tassa|contributo\s+annuale)`,
  en: String.raw`(?:cost|costs|fee|fees|payment|charge)`,
  de: String.raw`(?:Kosten|kostet|Gebühr\w*|Zahlung|Betrag)`,
  fr: String.raw`(?:coût|coûte|frais|taxe|émolument\w*|paiement|montant)`,
};
const AMOUNT = String.raw`(?:(?:CHF|Fr\.|fr\.|€|EUR)\s?\d|\d[\d.'’]*\s?(?:CHF|franchi|francs|Franken|Fr\.|€|euros?|Euro)\b)`;
const G_COST = Object.fromEntries(Object.keys(G_COST_WORD).map((locale) => {
  const permit = G_PERMIT[locale].source;
  const word = G_COST_WORD[locale];
  return [locale, new RegExp(
    String.raw`\b${word}\b[^.;|]{0,30}(?:${permit})[^.;|]{0,50}${AMOUNT}|(?:${permit})[^.;|]{0,40}\b${word}\b[^.;|]{0,30}${AMOUNT}|^\s*[-*•]?\s*(?:\*\*)?${word}\b[^.;|]{0,40}${AMOUNT}`,
    'i',
  )];
}));
const G_COST_OFF_TOPIC = {
  it: /LAMal|franchigi|premi|stagional|abbonament|pacchett|scont|stipendio|salario|guadagn/i,
  en: /LAMal|deductible|premium|subscription|package|discount|salary|earn/i,
  de: /LAMal|Franchise|Prämie|Abonnement|Paket|Rabatt|Lohn|Gehalt|verdien/i,
  fr: /LAMal|franchise|prime|abonnement|forfait|réduction|salaire|gagne/i,
};
const G_DEADLINE = {
  it: /\bentro\s+(?:i\s+)?\d+\s+(?:giorni|settimane)\b[^.;|]{0,50}\b(?:inizio|ingresso|assunzione|partenza|primo\s+giorno)|\b(?:inizio|assunzione)\b[^.;|]{0,40}\bentro\s+(?:i\s+)?\d+\s+giorni/i,
  en: /\bwithin\s+\d+\s+(?:days|weeks)\b[^.;|]{0,50}\b(?:start|entry|hiring|first\s+day|commencement)/i,
  de: /\binnerhalb\s+(?:von\s+)?\d+\s+(?:\w+\s+)?(?:Tagen|Wochen)\b[^.;|]{0,50}\b(?:Beginn|Einreise|Arbeitsbeginn|Arbeitsantritt|ersten\s+Tag)|\b(?:spätestens|bis)\s+\d+\s+Tage\b[^.;|]{0,40}\bBeginn/i,
  fr: /\b(?:dans\s+les|sous)\s+\d+\s+(?:jours|semaines)\b[^.;|]{0,50}\b(?:début|entrée|embauche|premier\s+jour)/i,
};
const G_BORDER_ZONE_REQUIREMENT = {
  it: /(?:\b(?:riservat\S*|destinat\S*|requisit\S*|rientra\S*|obbligo|condizione|per\s+(?:richiedere|ottenere)|autorizzat\S*)\b[^.;|]{0,90}(?:20\s?km|30\s?km|zona\s+di\s+frontiera|fascia\s+(?:di\s+)?(?:confine|frontiera)|zona\s+dei\s+20)|(?:20\s?km|zona\s+di\s+frontiera|fascia\s+(?:di\s+)?(?:confine|frontiera))[^.;|]{0,70}\bper\s+(?:il\s+permesso|richiedere|ottenere))/i,
  en: /\b(?:reserved|intended|requirement|required|eligib\S*|must\s+(?:live|reside)|in\s+order\s+to\s+(?:obtain|apply))\b[^.;|]{0,90}(?:20[- ]?km|30[- ]?km|border\s+(?:zone|area|strip))/i,
  de: /\b(?:vorbehalten|bestimmt|Voraussetzung|erforderlich|müssen\s+\S+\s+wohnen|um\s+\S+\s+zu\s+erhalten)\b[^.;|]{0,90}(?:20\s?km|30\s?km|Grenzzone|Grenzgebiet)/i,
  fr: /\b(?:réservé\S*|destiné\S*|condition\S*|exig\S*|requis\S*|pour\s+(?:obtenir|demander))\b[^.;|]{0,90}(?:20\s?km|30\s?km|zone\s+frontalière|zone\s+de\s+frontière)/i,
};
const G_BORDER_OFF_TOPIC = {
  it: /transito|pedagg|bozza|DATEC|non\s+richiede|non\s+(?:è\s+)?(?:più\s+)?(?:richiest|necessari)|Accordo\s+(?:fiscale|frontalieri)\s+art|fiscal/i,
  en: /transit|toll|draft|no\s+longer|does\s+not\s+require|tax\s+agreement|fiscal/i,
  de: /Transit|Maut|Entwurf|nicht\s+mehr|keinen\s+Wohnsitz|Steuerabkommen/i,
  fr: /transit|péage|projet|n['’]exige\s+pas|plus\s+(?:requis|nécessaire)|accord\s+fiscal/i,
};
const G_TEXT = {
  it: {
    duration: 'Il permesso G vale cinque anni con un contratto superiore a un anno; con un contratto più breve dura quanto il contratto.',
    deadline: "In Ticino la richiesta del permesso G va trasmessa all'Ufficio della migrazione prima di iniziare l'attività.",
    zone: "Per i cittadini UE/AELS il permesso G non richiede la residenza in una zona di frontiera: basta rientrare al domicilio almeno una volta alla settimana. I 20 km valgono solo per l'Accordo fiscale.",
  },
  en: {
    duration: 'The G permit is valid for five years with a contract of more than one year; with a shorter contract it lasts as long as the contract.',
    deadline: 'In Ticino the G permit application must reach the Migration Office before work starts.',
    zone: 'For EU/EFTA citizens the G permit does not require residence in a border zone: returning home at least once a week is enough. The 20 km apply only to the tax agreement.',
  },
  de: {
    duration: 'Die G-Bewilligung gilt fünf Jahre bei einem Vertrag von mehr als einem Jahr; bei einem kürzeren Vertrag gilt sie für die Vertragsdauer.',
    deadline: 'Im Tessin muss das Gesuch für die G-Bewilligung vor Arbeitsbeginn beim Migrationsamt eingereicht werden.',
    zone: 'Für EU/EFTA-Bürger setzt die G-Bewilligung keinen Wohnsitz in einer Grenzzone voraus: Es genügt, mindestens einmal pro Woche an den Wohnort zurückzukehren. Die 20 km gelten nur für das Steuerabkommen.',
  },
  fr: {
    duration: 'Le permis G est valable cinq ans avec un contrat de plus d’un an ; avec un contrat plus court, il dure autant que le contrat.',
    deadline: 'Au Tessin, la demande de permis G doit être transmise à l’Office de la migration avant le début de l’activité.',
    zone: 'Pour les citoyens UE/AELE, le permis G n’exige pas de résider dans une zone frontalière : il suffit de rentrer au domicile au moins une fois par semaine. Les 20 km ne valent que pour l’accord fiscal.',
  },
};

/** La riforma degli apprendisti e la patente hanno durate proprie. */
const G_OTHER_SUBJECT = {
  it: /apprendist|tirocin|mozione|riforma|patente|targa|abbonament/i,
  en: /apprentic|motion|reform|driving\s+licen|plate|subscription/i,
  de: /Lehrling|Lernende|Lehre\b|Motion|Reform|Führerschein|Fahrausweis|Abonnement/i,
  fr: /apprenti|motion|réforme|permis\s+de\s+conduire|plaque|abonnement/i,
};
const CORRECT_DURATION = /(?=.*\b(?:cinque|five|fünf|cinq|5)\b)(?=.*(?:contratt|contract|Vertrag|contrat))/i;

function classifyGPermit(sentence, locale) {
  if (!G_PERMIT[locale].test(sentence) || G_OTHER_SUBJECT[locale].test(sentence)) return null;
  if (/\?\s*$/.test(sentence)) return null;
  if (G_BORDER_ZONE_REQUIREMENT[locale].test(sentence) && !G_BORDER_OFF_TOPIC[locale].test(sentence)) return 'zone';
  if (G_WRONG_DURATION[locale].test(sentence) && !CORRECT_DURATION.test(sentence)) return 'duration';
  if (G_DEADLINE[locale].test(sentence)) return 'deadline';
  if (G_COST[locale].test(sentence) && !G_COST_OFF_TOPIC[locale].test(sentence)) return 'cost';
  return null;
}

/** Riscrive una frase errata sul permesso G; una cifra di costo si toglie. */
export function repairGPermitSentence(sentence, locale) {
  const kind = classifyGPermit(sentence, locale);
  if (!kind) return null;
  if (kind === 'cost') return '';
  const marker = sentence.match(LIST_MARKER)?.[0] ?? '';
  return `${marker}${G_TEXT[locale][kind]}`;
}

/**
 * Tassa sulla salute. L. 213/2023 art. 1 c. 237-239: quota dal 3% al 6% del
 * salario netto, da 30 a 200 euro per mese lavorato, definita ogni anno dalla
 * Regione. Nessun atto regionale verificato ne fissa l'importo: una cifra diversa
 * non si sostituisce, si toglie. I sondaggi sulla tassa («l'87,8% la ritiene
 * penalizzante») e i ristorni sospesi non sono importi della tassa.
 */
const HEALTH_TAX = {
  it: /tassa\s+(?:sulla\s+)?salute|tassa\s+sanitaria|tassa\s+sulla\s+sanit\S*|contributo\s+sanitario|compartecipazione\s+al\s+(?:SSN|Servizio)/i,
  en: /health\s+(?:tax|levy)|healthcare\s+(?:tax|levy)|health\s+contribution/i,
  de: /Gesundheits(?:steuer|abgabe|beitrag)/i,
  fr: /taxe\s+(?:sur\s+la\s+)?sant[ée]|taxe\s+sanitaire|contribution\s+sant[ée]|taxe\s+dite\s+«\s*santé/i,
};
const HEALTH_TAX_WRONG_LAW = {
  it: /Legge\s+di\s+Bilancio\s+20(?:19|20|21|22|23)|legge\s+federale\s+[^.;|]{0,30}(?:tassa|sanit)|legge\s+sulla?\s+(?:tassa|tasse)\s+(?:sulla\s+salute|sanitari)/i,
  en: /(?:Budget|Finance|Stability)\s+(?:Law|Act)\s+(?:of\s+)?20(?:19|20|21|22|23)|federal\s+(?:law|act)\s+[^.;|]{0,30}health\s+tax/i,
  de: /(?:Haushalts|Stabilitäts|Budget)gesetz\w*\s+(?:von\s+)?20(?:19|20|21|22|23)|Bundesgesetz\s+[^.;|]{0,30}Gesundheitssteuer/i,
  fr: /loi\s+de\s+(?:finances|budget|bilan)\s+(?:de\s+)?20(?:19|20|21|22|23)|loi\s+fédérale\s+[^.;|]{0,30}taxe\s+(?:sur\s+la\s+)?sant/i,
};
const HEALTH_TAX_EXEMPT = {
  it: /ristorn|sospes|bloccat|franchigi|non\s+esiste|non\s+si\s+tratta|confus|intervistat|sondaggio|penalizzant|LAMal\s+(?:non|è)|(?:non|né)\s+(?:è\s+)?una\s+.?tassa/i,
  en: /ristorn|rebate|refund|suspend|blocked|deductible|not\s+(?:a|to\s+be\s+confused)|confus|does\s+not\s+exist|surve|respondents|penali[sz]|LAMal\s+is/i,
  de: /Ristorn|Rückerstatt|Rückzahl|gesperrt|ausgesetzt|Franchise|Selbstbehalt|keine[nr]?\s+.?Gesundheits|verwechsel|existiert\s+nicht|Umfrage|Befragten|benachteilig|KVG|LAMal\s+ist/i,
  fr: /ristorn|rétrocession|remboursement|suspend|bloqu|franchise|confond|n['’]est\s+pas\s+une|n['’]existe\s+pas|enquête|sondage|pénalisant|LAMal\s+(?:n['’]|est)/i,
};
const SWISS_FRANC_AMOUNT = /(?:CHF|Fr\.)\s?\d|\d[\d.'’\s]*\s?(?:CHF|franchi|Franken|francs)\b/i;
const YEARLY_EURO = {
  it: /\d[\d.'’]*\s?(?:euro|€|EUR)\s+(?:l['’]anno|all['’]anno|annu[ie]|annuali)|(?:euro|€)\s?\d[\d.'’]*\s+(?:l['’]anno|all['’]anno|annu[ie]|annuali)/i,
  en: /\d[\d,.'’]*\s?(?:euros?|€|EUR)\s+(?:a|per)\s+year|(?:€|EUR)\s?\d[\d,.'’]*\s+(?:a|per)\s+year/i,
  de: /\d[\d.'’]*\s?(?:Euro|€|EUR)\s+(?:pro\s+Jahr|im\s+Jahr|jährlich)|(?:€|EUR)\s?\d[\d.'’]*\s+(?:pro\s+Jahr|im\s+Jahr|jährlich)/i,
  fr: /\d[\d\s.'’]*\s?(?:euros?|€|EUR)\s+(?:par\s+an|annuels?)/i,
};
const MONTHLY_EURO = {
  it: /(?:(?:€|EUR)\s?(\d[\d.'’]*)|(\d[\d.'’]*)\s?(?:euro|€|EUR))\s+(?:al\s+mese|mensili|per\s+mese|ogni\s+mese)/gi,
  en: /(?:(?:€|EUR)\s?(\d[\d,.'’]*)|(\d[\d,.'’]*)\s?(?:euros?|€|EUR))\s+(?:a\s+month|per\s+month|monthly)/gi,
  de: /(?:(?:€|EUR)\s?(\d[\d.'’]*)|(\d[\d.'’]*)\s?(?:Euro|€|EUR))\s+(?:pro\s+Monat|im\s+Monat|monatlich)/gi,
  fr: /(?:(?:€|EUR)\s?(\d[\d\s.'’]*)|(\d[\d\s.'’]*)\s?(?:euros?|€|EUR))\s+(?:par\s+mois|mensuels?)/gi,
};

function hasMonthlyAmountOutOfRange(sentence, locale) {
  return [...sentence.matchAll(MONTHLY_EURO[locale])].some(([, before, after]) => {
    const amount = Number(String(before ?? after).replace(/\D/g, ''));
    return amount < 30 || amount > 200;
  });
}

const PERCENT_OF_PAY = {
  it: /(\d{1,2}(?:[.,]\d+)?)\s?(?:%|per\s+cento)\s+(?:del(?:lo|l['’])?|sul(?:lo|l['’])?)\s+(?:salario|stipendio|reddito|netto|lordo|imposta)/gi,
  en: /(\d{1,2}(?:[.,]\d+)?)\s?(?:%|percent)\s+(?:of|on)\s+(?:the\s+)?(?:gross|net|salary|income|wage)/gi,
  de: /(\d{1,2}(?:[.,]\d+)?)\s?(?:%|Prozent)\s+(?:des|vom|auf\s+das)\s+(?:Brutto|Netto|Lohn\w*|Einkommen\w*|Gehalt\w*)/gi,
  fr: /(\d{1,2}(?:[.,]\d+)?)\s?(?:%|pour\s+cent)\s+(?:du|sur\s+le)\s+(?:salaire|revenu|brut|net)/gi,
};

function isHealthTaxClaim(sentence, locale) {
  if (!HEALTH_TAX[locale].test(sentence) || /\?\s*$/.test(sentence)) return false;
  if (HEALTH_TAX_WRONG_LAW[locale].test(sentence)) return true;
  if (HEALTH_TAX_EXEMPT[locale].test(sentence)) return false;
  if (SWISS_FRANC_AMOUNT.test(sentence) || YEARLY_EURO[locale].test(sentence)) return true;
  if (hasMonthlyAmountOutOfRange(sentence, locale)) return true;
  return [...sentence.matchAll(PERCENT_OF_PAY[locale])].some(([, value]) => !['3', '6'].includes(value.replace(',', '.')));
}

/** Un importo o una base non verificabile si toglie: non c'e' un valore da mettere. */
export function repairHealthTaxSentence(sentence, locale) {
  return isHealthTaxClaim(sentence, locale) ? '' : null;
}

/** Sintesi per excerpt e description rimasti vuoti dopo la rimozione di una cifra. */
export const HEALTH_TAX_SUMMARY = Object.freeze({
  it: 'Tassa sulla salute: quota al SSN dal 3% al 6% del salario netto svizzero, da 30 a 200 euro per mese lavorato, definita ogni anno dalla Regione.',
  en: 'Health tax: a contribution to the Italian health service of 3% to 6% of the Swiss net salary, 30 to 200 euros per month worked, set yearly by the region.',
  de: 'Gesundheitssteuer: Beitrag an den italienischen Gesundheitsdienst von 3 % bis 6 % des Schweizer Nettolohns, 30 bis 200 Euro pro Arbeitsmonat, jährlich von der Region festgelegt.',
  fr: 'Taxe santé : contribution au service de santé italien de 3 % à 6 % du salaire net suisse, de 30 à 200 euros par mois travaillé, fixée chaque année par la région.',
});

const CLASS_RULES = Object.freeze([
  { id: 'regime-fiscale', repair: repairRegimeSentence, test: isRegimeClaim },
  { id: 'regime-fiscale', repair: repairNoItalianTaxSentence, test: isNoItalianTaxClaim },
  {
    id: 'regime-vecchi-frontalieri',
    repair: repairOldRegimeSentence,
    test: (sentence, locale) => isOldRegimeClaim(sentence, locale),
  },
  { id: 'stringa-prompt', repair: repairPromptEchoSentence, test: hasPromptEcho },
  { id: 'tassa-salute', repair: repairHealthTaxSentence, test: isHealthTaxClaim },
  { id: 'permesso-g', repair: repairGPermitSentence, test: (sentence, locale) => classifyGPermit(sentence, locale) !== null },
]);

/** Elenca le frasi vietate di un campo. */
export function findEditorialClaims(text, { locale = 'it' } = {}) {
  const found = [];
  const raw = String(text ?? '');
  const label = raw.match(PROMPT_TITLE_LABEL) ?? raw.match(new RegExp(PROMPT_TITLE_LINE.source, 'imu'));
  if (label) found.push({ class: 'stringa-prompt', sentence: label[0].trim() });
  const segments = splitClaimSegments(text);
  for (let index = 0; index < segments.length; index += 2) {
    const sentence = segments[index];
    if (!sentence) continue;
    for (const rule of CLASS_RULES) {
      if (rule.test(sentence, locale)) found.push({ class: rule.id, sentence });
    }
  }
  return found;
}

/**
 * Applica le riparazioni deterministiche a un campo. Una stessa frase canonica
 * non si ripete nello stesso campo: la seconda occorrenza si toglie, tranne nei
 * punti strutturali (elenchi, tabelle, FAQ) dove la riga deve restare.
 */
export function repairEditorialClaims(text, { locale = 'it', title = '' } = {}) {
  const stripped = stripPromptTitleLabels(text, { title });
  const segments = splitClaimSegments(stripped.value);
  const changes = stripped.removed > 0
    ? [{ class: 'stringa-prompt', before: `${stripped.removed} etichette`, after: '' }]
    : [];
  const used = new Set();
  for (let index = 0; index < segments.length; index += 2) {
    const sentence = segments[index];
    if (!sentence) continue;
    let current = sentence;
    for (const rule of CLASS_RULES) {
      const fixed = rule.repair(current, locale);
      if (fixed !== null && fixed !== current) {
        changes.push({ class: rule.id, before: current, after: fixed });
        current = fixed;
        if (!current) break;
      }
    }
    if (current === sentence) continue;
    if (!current) {
      segments[index] = '';
      // La frase sparisce con il suo separatore, salvo i confini di FAQ e tabelle.
      const after = segments[index + 1] ?? '';
      if (/^\s+$/.test(after)) segments[index + 1] = '';
      else if (!after && /^\s+$/.test(segments[index - 1] ?? '')) segments[index - 1] = '';
      continue;
    }
    const canonical = [
      ...Object.values(OLD_REGIME_TEXT[locale]),
      NO_ITALIAN_TAX_TEXT[locale],
      ...Object.values(G_TEXT[locale]),
    ]
      .find((value) => current.endsWith(value));
    const prev = segments[index - 1] ?? '';
    const next = segments[index + 1] ?? '';
    const structural = /^\s*(?:[-*•|]|\d+[.)])/.test(current) || /\|/.test(prev) || /\|/.test(next)
      || /"/.test(prev) || /"/.test(next);
    if (canonical && used.has(canonical) && !structural) {
      segments[index] = '';
      if (index + 1 < segments.length) segments[index + 1] = prev && /\n/.test(next) ? next : '';
      continue;
    }
    if (canonical) used.add(canonical);
    segments[index] = current;
  }
  return { value: segments.join(''), changes };
}

/**
 * Gate di pubblicazione: stessa forma di assertNoFabricatedNormAcronyms, un
 * articolo con una frase vietata non esce in nessuna lingua. Legge ogni stringa
 * del contenuto, anche dentro array e oggetti: titolo, excerpt, FAQ, sezioni.
 *
 * @param {Record<string, Record<string, unknown> | undefined>} contentByLocale
 */
export function assertNoEditorialClaims(contentByLocale) {
  const issues = [];
  const visit = (value, locale, field) => {
    if (typeof value === 'string') {
      for (const claim of findEditorialClaims(value, { locale })) {
        issues.push(`[${locale}/${field}] ${claim.class}: ${claim.sentence.slice(0, 160)}`);
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, locale, `${field}.${key}`);
    }
  };
  for (const [locale, content] of Object.entries(contentByLocale ?? {})) {
    if (!content || !CLAIM_LOCALES.includes(locale)) continue;
    for (const [field, value] of Object.entries(content)) visit(value, locale, field);
  }
  if (issues.length > 0) {
    const list = issues.map((item, index) => `  ${index + 1}. ${item}`).join('\n');
    throw new Error(`Articolo rigettato — affermazione editoriale vietata:\n${list}`);
  }
}
