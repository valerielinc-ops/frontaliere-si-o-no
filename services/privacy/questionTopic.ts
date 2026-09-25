/**
 * Closed-enum topic classification for user-authored questions (issue #5196).
 *
 * ── WHY THIS EXISTS, WHEN `redactPii.ts` ALREADY RUNS ──
 *
 * `redactPii.ts` is a deny-list over free text, and a deny-list over free text
 * has no upper bound. Every gap in it is discovered the same way: after the
 * data has already left. The history of #5196 is exactly that — the original
 * three regexes looked complete until a question carrying a name, a date of
 * birth and a street address turned up in production; the rewrite that replaced
 * them looked complete until French number-first addresses, vehicle plates and
 * passport numbers were tried against it and walked straight through.
 *
 * And some of it is not reachable by regex at all. "sono mario rossi" — no
 * capital letters, the single most common shape typed on a phone — cannot be
 * separated from ordinary prose by any pattern, because there is nothing in the
 * string that marks it as a name. No amount of further work on the deny-list
 * closes that, which means the deny-list can never be the last line of defence
 * for text that leaves the browser.
 *
 * So the fix is to stop shipping the text. What analytics actually needs from a
 * question is what it was ABOUT, and that is answerable with a value drawn from
 * a fixed list. This module turns free text into one of `QUESTION_TOPICS`.
 *
 * ── THE PROPERTY THAT MAKES THIS DIFFERENT ──
 *
 * `classifyQuestionTopic` returns an element of `QUESTION_TOPICS` and nothing
 * else. It never returns a substring of its input, never concatenates input
 * into its result, and has no code path that constructs a string at all. The
 * input is read only to *choose among* pre-existing constants.
 *
 * That is a guarantee of construction rather than of coverage. A deny-list is
 * safe only for the inputs someone thought of; this is safe for every input,
 * including the ones nobody has thought of yet. There is no question — in any
 * language, with any personal data in it — that can cause this function to emit
 * personal data, because there is no path from the characters of the input to
 * the characters of the output.
 *
 * Redaction stays in place for the fields where the text itself is the product
 * (site search, job-alert keywords). It is a net, not a guarantee, and it is
 * used where a guarantee is not available.
 */

/**
 * The complete set of values that may ever be reported as a question topic.
 *
 * Closed on purpose, and `as const` so TypeScript treats it as the literal
 * union rather than `string[]` — adding a topic is a deliberate edit here, and
 * a reviewable one, which is the whole point. Order is significant: it breaks
 * ties, so classification is deterministic.
 *
 * `other` is the catch-all and MUST stay last: an unrecognised question is
 * reported as unrecognised, never guessed at and never quoted.
 */
export const QUESTION_TOPICS = [
  'permits',
  'taxes',
  'salary',
  'social_security',
  'pension',
  'healthcare',
  'unemployment',
  'housing',
  'family',
  'commute',
  'remote_work',
  'jobs',
  'banking',
  'vehicle',
  'education',
  'site_help',
  'other',
] as const;

export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

/**
 * Word-initial stems per topic, in the site's four locales.
 *
 * Stems, not whole words: `permess` covers "permesso" and "permessi",
 * `steuer` covers "Steuer", "Steuern" and "Steuererklärung". Matching is
 * anchored at a word start (see `matches`), so `avs` does not fire inside
 * "avsenden" — but a stem still matches the rest of the word, which is what
 * makes one entry cover a Romance or German inflection table.
 *
 * These are matched against folded text (lower-cased, accents removed), so
 * entries here are written without diacritics.
 */
const TOPIC_STEMS: Record<Exclude<QuestionTopic, 'other'>, readonly string[]> = {
  permits: [
    'permess', 'permis', 'permit', 'bewilligung', 'aufenthalt', 'niederlassung', 'soggiorn',
    'rinnov', 'renew', 'erneuer', 'renouvel',
    // NOTE: "frontaliere" / "Grenzgänger" / "cross-border worker" deliberately
    // appear in NO topic. They are the site's entire subject — present in a
    // large share of every kind of question — so as a stem they carry no topic
    // signal at all and simply drag whichever list holds them to the top.
    // Adding one here scored "Come mi iscrivo alla disoccupazione da
    // frontaliere?" as `permits`.
    'residenz', 'domicili', 'notifica', 'meldepflicht', 'anmeldung', 'ricongiungiment',
    'cittadinanz', 'naturalizzaz', 'einbuergerung', 'nationalit', 'visa', 'visto',
  ],
  taxes: [
    'tass', 'imposta', 'imposte', 'fiscal', 'quellensteuer', 'steuer', 'impot',
    'irpef', 'iva ', 'tva ', 'mwst', 'ritenut', 'dichiarazione', 'deduzion', 'detrazion',
    'aliquot', 'ristorn', 'doppia imposiz', 'agenzia entrate', 'tax', 'rimborso fiscal',
    'modello 730', 'unico', 'accordo fiscal',
  ],
  salary: [
    'salari', 'stipendi', 'lohn', 'gehalt', 'paga', 'netto', 'lordo', 'brutto',
    'ral ', 'tredicesim', 'gratifica', 'bonus', 'aumento', 'busta paga',
    'minimo salarial', 'mindestlohn', 'remunerat', 'guadagn', 'quanto si guadagna',
  ],
  social_security: [
    'avs', 'ahv', 'contribut', 'ipg', 'lpga', 'assicurazione sociale',
    'sozialversicherung', 'securite sociale', 'previdenz', 'primo pilastr',
    'attestazione a1', 'formulario a1', 'distacc',
  ],
  pension: [
    'pension', 'rendita', 'rente', 'lpp', 'bvg', 'secondo pilastr', 'terzo pilastr',
    'pilier', 'saeule', 'saule', 'prevoyance', 'cassa pension', 'riscatt',
    'prelievo capital', 'liquidazione', 'retrait',
  ],
  healthcare: [
    'cassa malat', 'malattia', 'lamal', 'kvg', 'krankenkass', 'krankenvers',
    'assicurazione malat', 'caisse malad', 'sanitar', 'medic', 'ospedal', 'spital',
    'franchigia', 'premio cassa', 'diritto di opzione', 'gesundheit', 'dentist',
    'maternita', 'infortun', 'suva', 'lainf', 'invalidit', 'health insurance',
  ],
  unemployment: [
    'disoccupaz', 'disoccupat', 'arbeitslos', 'chomage', 'unemploy', 'licenziament',
    'kuendigung', 'kundigung', 'preavviso', 'indennit', 'naspi', 'cassa integraz',
    'lavoro ridott', 'kurzarbeit',
  ],
  housing: [
    'alloggi', 'affitt', 'appartament', 'wohnung', 'miete', 'logement', 'loyer',
    'casa', 'immobil', 'mutuo', 'hypothek', 'ipotec', 'trasloc', 'umzug',
    'cauzione', 'kaution', 'inquilin', 'comprare casa', 'acquisto immobil',
  ],
  family: [
    'figli', 'bambin', 'kinder', 'enfant', 'assegni familiar', 'familienzulage',
    'allocation famil', 'coniug', 'moglie', 'marito', 'ehepartner', 'conjoint',
    'matrimoni', 'divorzi', 'scheidung', 'asilo nido', 'kita', 'congedo parental',
    'unione domestic', 'convivent',
  ],
  commute: [
    'frontier', 'dogana', 'zoll', 'douane', 'valico', 'pendolar', 'tragitt',
    'traffic', 'coda', 'stau', 'treno', 'zug ', 'train', 'ffs', 'sbb', 'cff',
    'tilo', 'arcobaleno', 'abbonament', 'parcheggi', 'parkplatz', 'navett',
    'tempo di percorrenza', 'strada', 'autostrad', 'vignett',
  ],
  remote_work: [
    'telelavor', 'smart working', 'home office', 'homeoffice', 'remot', 'teletravail',
    'giorni da cas', 'lavorare da cas', 'accordo telelavoro', 'percentuale telelavoro',
  ],
  jobs: [
    'lavoro', 'lavorare', 'impiego', 'offert', 'annunci', 'posto di lavoro',
    'arbeit', 'stelle', 'emploi', 'job', 'assunz', 'colloqui', 'vorstellungsgespr',
    'entretien', 'curriculum', 'cv ', 'candidat', 'contratto di lavoro',
    'arbeitsvertrag', 'periodo di prova', 'probezeit', 'ferie', 'urlaub', 'vacanz',
    'orario di lavoro', 'straordinar',
  ],
  banking: [
    'conto corrente', 'conto banc', 'banca', 'bank', 'iban', 'bonifico',
    'cambio', 'wechselkurs', 'valuta', 'euro', 'franchi', 'franken', 'chf',
    'carta di credit', 'prestito', 'kredit', 'risparmi', 'transfer',
  ],
  vehicle: [
    'auto ', 'veicol', 'fahrzeug', 'voiture', 'targa', 'kontrollschild',
    'immatricolaz', 'immatriculation', 'patente', 'fuehrerausweis', 'fuhrerausweis',
    'permis de conduire', 'assicurazione auto', 'bollo', 'motorfahrzeugsteuer',
    'importare auto', 'benzina', 'carburant',
  ],
  education: [
    'scuola', 'schule', 'ecole', 'school', 'universit', 'formazion', 'ausbildung',
    'corso', 'diploma', 'attestat', 'riconosciment', 'anerkennung', 'equipollenz',
    'apprendistat', 'lehre', 'master', 'laurea', 'studi',
  ],
  site_help: [
    'sito', 'calcolator', 'simulator', 'account', 'registrazion', 'login',
    'newsletter', 'password', 'profilo', 'abbonarmi', 'disiscriv', 'privacy',
    'come funziona il sito', 'chatbot', 'assistente', 'errore', 'non funziona',
  ],
};

/** Topics in scoring order — declaration order in `QUESTION_TOPICS`, minus `other`. */
const SCORED_TOPICS = QUESTION_TOPICS.filter(
  (t): t is Exclude<QuestionTopic, 'other'> => t !== 'other',
);

/**
 * Lower-case, strip accents, and reduce everything that is not a letter or
 * digit to a single space, with one leading and trailing space.
 *
 * The padding is what lets a plain `includes(' ' + stem)` mean "at a word
 * start" without a regex per stem.
 */
function fold(raw: string): string {
  const lowered = String(raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  return ` ${lowered.replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * A stem matches when it appears at a word start.
 *
 * A TRAILING SPACE in the stem means "whole word": `'auto '` matches "auto" but
 * not "autorizzazione", which otherwise would have scored a permits question as
 * a vehicle one. Without that opt-out every short stem is a prefix and quietly
 * over-matches — `iva` inside "Ivan", `cv` inside "cvs".
 */
function matches(folded: string, stem: string): boolean {
  const wholeWord = /\s$/.test(stem);
  // Stems may themselves contain spaces ("doppia imposiz"); folding them the
  // same way keeps multi-word stems working after punctuation is flattened.
  const core = stem.trim().replace(/[^a-z0-9]+/g, ' ');
  if (!core) return false;
  return folded.includes(wholeWord ? ` ${core} ` : ` ${core}`);
}

/**
 * Classify a user-authored question into exactly one `QuestionTopic`.
 *
 * Scoring is a count of distinct matching stems, highest wins, ties broken by
 * the declaration order of `QUESTION_TOPICS`. No match at all yields `other`.
 *
 * Safe to call on the RAW question, before redaction, and that is what the
 * caller does — the raw text classifies better, and the closed return type
 * means passing raw text in cannot cause anything to come out. This function
 * having no way to emit its input is precisely what removes the need to trust
 * the redactor here.
 */
export function classifyQuestionTopic(raw: string): QuestionTopic {
  const folded = fold(raw);
  if (folded.trim().length === 0) return 'other';

  let best: QuestionTopic = 'other';
  let bestScore = 0;

  for (const topic of SCORED_TOPICS) {
    let score = 0;
    for (const stem of TOPIC_STEMS[topic]) {
      if (matches(folded, stem)) score += 1;
    }
    // Strictly greater, so an earlier topic in QUESTION_TOPICS wins a tie.
    if (score > bestScore) {
      bestScore = score;
      best = topic;
    }
  }

  return best;
}
