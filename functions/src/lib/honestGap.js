/**
 * The honest gap of a cover letter, read by closed templates.
 *
 * A tool the posting names and the candidate's texts do not back is a claim,
 * unless the letter says the candidate does not have it ("I have not used
 * SAP yet", "Non ho ancora esperienza con SAP", "Mit SAP habe ich noch nicht
 * gearbeitet", "Je ne connais pas encore SAP") or wants to learn it ("I am
 * motivated to learn the hotel's LQA and Forbes standards", a real order of
 * 2026-10-03). The fact gate (assistedApplicationAiFactCheck.js) reports such
 * a tool as a `gap` advisory instead of blocking the draft.
 *
 * Repair of 2026-10-04: the first two readers looked for cue words in the
 * clause of the tool, and every phrasing their lists did not foresee let a
 * claim through ("I wouldn't say I'm new to SAP", "I have never used SAP
 * without delivering on time"). A third one closed only the stretch of the
 * sentence around the tool, and what came after it carried the claim ("I have
 * no experience with SAP, outside of a two-day workshop at university", "I
 * have not used SAP yet, but I know the basics from my studies"). Here the
 * whole sentence is closed: it lets its tools through only when it splits,
 * at commas, dashes, semicolons, colons and coordinators, into pieces each of
 * which is a template of this module (a lack, a wish to learn, a pronoun that
 * learns the tool, a short neutral clause such as "I learn quickly"). Any
 * other piece, even one about a tool the CV backs ("…, as I did with Opera
 * PMS at the Kulm"), and no tool of the sentence is a gap: as before the
 * exemption existed, each is a claim the owner confirms. A lack said of a part
 * only is no template on purpose, since it says the rest was used: "not in
 * production", "no professional experience", "some SAP modules", "your
 * specific SAP modules", "SAP systems of this size", "relatively new to". In a
 * lack the tool stands with an article and a generic noun at most.
 *
 * What gets through all the same, known: a later sentence that takes the tool
 * up ("I am eager to learn SAP. I use it daily."); a tool written with
 * look-alike letters of another alphabet, which no check of the gate reads as
 * that tool.
 *
 * The templates are trees of words matched token by token (matcher), not
 * regular expressions: those took eleven seconds to compile on the first
 * letter after a cold start. A sentence is read as tokens (readSentence):
 * lowercase, a tool as `§` (with a closed list of words glued after it:
 * "SAP-Kenntnisse" is `§-kenntnisse`, "LQA- und" is `§- und`; anything else
 * glued to it makes it no tool head: "non-SAP", "SAP-Alternativen"), a
 * capitalised word that is no function word as `^word` (a name, a German
 * noun), a word of the noun-phrase lists with its class tags ("D:die"), a
 * comma, dash, semicolon or colon as `,`, any other punctuation as `¦`, which
 * no template crosses.
 */

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const list = (words) => words.trim().split(/\s+/);

// Determiners that may open a noun phrase: articles, demonstratives and the possessives that are not the
// candidate's own ("your", "vostro", "Ihre", "votre"; never "my": "my SAP skills"). No quantifier: "all",
// "some", "tutti", "alle", "tous" say a part ("I have not used all SAP modules").
const DETERMINERS = `
  the a an your its their this these those any
  il lo la i gli le l' un uno una un' vostro vostra vostri vostre suo sua suoi sue loro questo questa questi queste
  quel quello quella quei quegli quelle quell'
  der die das den dem des ein eine einen einem einer eines ihr ihre ihren ihrem ihrer ihres dieser diese dieses diesen diesem
  les une du de d' votre vos leur leurs ce cet cette ces son sa ses`;
// Adjectives the noun phrase of a wish may carry ("your internal SAP processes"): none that says the candidate
// uses it ("daily", "existing"), counts a part ("various", "different") or knows an older one ("new").
const MODIFIERS = `
  internal specific relevant local main standard necessary required respective
  interni interne interno interna specifici specifiche specifico specifica relativi relative locali principali
  necessarie necessari necessaria necessario richieste richiesti
  internen interne internes spezifischen spezifische jeweiligen relevanten lokalen hausinternen nötigen notwendigen erforderlichen
  internes spécifiques spécifique locaux locales principaux principales nécessaires requises requis`;
// Nouns that may head a noun phrase next to the tool ("the SAP system", "gli standard LQA", "les standards
// LQA", "die SAP-Standards"), in the four languages; German ones are read without their capital.
const GENERIC_NOUNS = `
  standard standards system systems software platform platforms tool tools module modules environment environments
  process processes procedure procedures method methods methodology methodologies practice practices guideline guidelines
  norm norms requirement requirements product products solution solutions suite stack framework frameworks technology
  technologies region area language languages application applications program programs programme programmes service
  services cloud ecosystem toolchain workflow workflows skills basics fundamentals
  sistema sistemi piattaforma piattaforme strumento strumenti modulo moduli ambiente ambienti processo processi procedura
  procedure metodo metodi metodologia metodologie pratiche norme requisiti prodotti soluzioni gestionale gestionali
  programma programmi applicativo applicativi applicazione applicazioni regione zona territorio lingua tecnologia
  tecnologie servizi linee guida competenze basi fondamenti
  normes système systèmes logiciel logiciels plateforme plateformes outil outils environnement environnements
  processus procédure procédures méthode méthodes méthodologie méthodologies exigences produits programmes
  région langue technologie compétences bases
  modul systeme umgebung umgebungen plattform plattformen prozesse prozess lösungen anwendungen anwendung werkzeuge
  richtlinien normen grundlagen kenntnisse`;
// What may be glued after a tool ("SAP-Kenntnisse", "LQA-Standards"): anything else is another word
// ("SAP-Alternativen", "SAP-fremden", "AWS-free") and the token is no tool head.
const GLUED_AFTER_TOOL = new Set(list(`
  kenntnisse kenntnissen grundkenntnisse erfahrung erfahrungen praxis know-how grundlagen zertifizierung schulung
  standards standard module modul modulen system systeme systemen umgebung umgebungen plattform prozesse prozessen
  lösungen anwendungen tools cluster clustern`));
// Words that are grammar: a capital does not make them a name (the first word of a sentence, "Ihre",
// "Sie", "Some"), and a genitive never ends on one ("of my", "del mio").
const FUNCTION_WORDS = new Set(list(`${DETERMINERS}
  i i'm i've i'd i'll me my mine myself we our us you he she it they them him her his
  io mi me mio mia miei mie noi ci nostro nostra nostri nostre ne si
  ich mich mir mein meine meinen meinem meiner meines wir uns unser unsere unseren unserem unserer unseres sie ihnen es er
  je j' me m' moi mon ma mes nous notre nos il elle on y en
  and or but yet so nor e ed o ma però und oder aber doch sondern et ou mais ni né noch weder neither either
  of to in on at by for with from about as into than
  di da in su per con tra fra a ad al allo alla ai agli alle all' dal dallo dalla dai dagli dalle dall' del dello della dei degli
  delle dell' nel nello nella nei negli nelle nell' sul sullo sulla sui sugli sulle sull'
  mit von zu zum zur bei beim im in an am auf aus nach über für um vom ins
  à au aux de des du dans sur pour par avec chez en vers
  not no never non mai nicht nie kein keine ne n' pas jamais
  all both each some few many most several every
  tutti tutte ogni alcuni alcune pochi poche molti molte certi certe diversi diverse vari varie
  alle einige wenige viele manche mehrere kaum jede jeder jedes
  tous toutes chaque certains certaines quelques peu plusieurs beaucoup`));
const DETERMINER_SET = new Set(list(DETERMINERS));
const MODIFIER_SET = new Set(list(MODIFIERS));
const GENERIC_SET = new Set(list(GENERIC_NOUNS));

// ---------------------------------------------------------------------------
// Template building blocks
// ---------------------------------------------------------------------------

// What the token line writes around a word: its class tags ("D:" for "die", readSentence) and its capital
// mark ("^mit" at the start of a sentence).
const bare = (norm) => norm.replace(/^[A-Z]+:/, '').replace(/^\^/, '');
// A template is a tree of nodes, matched token by token (matcher).
const token = (test) => ({ type: 'token', test });
// One word: a plain word as it is written, a word with a pattern ("familiari[sz]e") as a regular expression.
const word = (pattern) => {
  if (/^[\p{L}\p{N}'’,&-]+$/u.test(pattern)) return token((norm) => bare(norm) === pattern);
  const regex = new RegExp(`^(?:${pattern})$`, 'u');
  return token((norm) => regex.test(bare(norm)));
};
const phrase = (words) => ({ type: 'seq', items: list(words).map(word) });
const piece = (item) => (typeof item === 'string' ? phrase(item) : item);
const seq = (...items) => ({ type: 'seq', items: items.map(piece) });
const any = (...items) => ({ type: 'any', items: items.map(piece) });
const repeat = (item, min, max) => ({ type: 'repeat', item: piece(item), min, max });
const opt = (...items) => repeat(seq(...items), 0, 1);
const star = (...items) => repeat(seq(...items), 0, Infinity);
const oneOf = (words) => {
  const set = new Set(list(words));
  return token((norm) => set.has(bare(norm)));
};

// The noun phrase that holds the tool: determiners, adjectives, a name first if any ("Forbes standards",
// "the Engadin"), then tools and generic nouns ("SAP S/4HANA", "the SAP system", "gli standard LQA"), one
// genitive ("of the hotel", "dell'hotel", "des Hotels", "de l'hôtel"), and more of the same after a comma,
// "and", "or". Nothing else: no preposition, no verb, no quantifier, no possessive of the candidate.
const DETERMINER = token((norm) => /^[A-Z]*D[A-Z]*:/.test(norm) || /^[^§,¦^:]+'s$/.test(norm));
const MODIFIER = token((norm) => /^[A-Z]*M[A-Z]*:/.test(norm));
const TOOL_HEAD = token((norm) => norm === '§' || norm === '§-' || (norm.startsWith('§-') && GLUED_AFTER_TOOL.has(norm.slice(2))));
const NAME_HEAD = token((norm) => /^(?:[A-Z]+:)?\^/.test(norm) && !norm.includes('§'));
const GENERIC_HEAD = token((norm) => /^[A-Z]*H[A-Z]*:/.test(norm));
const TAIL_HEAD = any(TOOL_HEAD, GENERIC_HEAD);
// The word of a genitive: a word that is no grammar ("of the hotel", "dell'hotel"), never the candidate's own
// ("of my", "del mio"), never an adverb after a bare preposition ("di recente", "de nouveau", "of late").
const GENITIVE_WORD = token((norm) => !/[§,¦]/.test(norm) && !FUNCTION_WORDS.has(bare(norm)));
const GENITIVE = any(
  seq(oneOf(`of di de d' von del della dello dei degli delle dell' des der du`), TOOL_HEAD),
  seq(oneOf(`del della dello dei degli delle dell' des der du`), GENITIVE_WORD),
  seq(oneOf(`of di de d'`), repeat(DETERMINER, 1, 2), GENITIVE_WORD),
  seq(oneOf(`of di de d' del della dello dei degli delle dell' des der du`), NAME_HEAD));
const ITEM = seq(star(DETERMINER), star(MODIFIER), any(seq(NAME_HEAD, repeat(TAIL_HEAD, 0, 3)), repeat(TAIL_HEAD, 1, 4)), opt(GENITIVE));
const SEPARATOR = oneOf(', and or & e ed o oppure und oder sowie et ou nonché');
const NP = seq(ITEM, star(SEPARATOR, ITEM));
// A list that repeats its preposition: "with SAP or with Kubernetes", "né con SAP né con Kubernetes",
// "mit SAP und auch nicht mit Kubernetes", "avec SAP ni avec Kubernetes". Never "but" or "only".
const NEITHER = opt(oneOf('either neither né ni weder'));
const LIST_JOIN = any(SEPARATOR, oneOf('nor né ni noch nemmeno neanche neppure'), 'and not', 'and also not', 'e nemmeno', 'e neanche',
  'e neppure', 'und auch nicht', 'und nicht', 'et pas', ', ni');
const pps = (preposition) => seq(NEITHER, preposition, NEITHER, NP, star(LIST_JOIN, opt(preposition), NP));
// In a lack the noun phrase is the tool itself, with an article and a generic noun at most ("the SAP system",
// "i moduli SAP", "die SAP-Module"): an adjective, a possessive, a demonstrative, a genitive or a name would say
// a part ("your specific SAP modules", "SAP systems of this size", "the new SAP system", "Enterprise SAP").
const ARTICLE = oneOf(`the a an il lo la i gli le l' un uno una un' der die das den dem ein eine einen einem les une des du de d'`);
const LACK_ITEM = seq(opt(ARTICLE), opt(GENERIC_HEAD), repeat(TOOL_HEAD, 1, 3), opt(GENERIC_HEAD));
const LNP = seq(LACK_ITEM, star(SEPARATOR, LACK_ITEM));
const lpps = (preposition) => seq(NEITHER, preposition, NEITHER, LNP, star(LIST_JOIN, opt(preposition), LNP));

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------

const EN_PRE = opt(any('although', 'though', 'even though', 'while', 'whilst', 'despite', 'as', 'since', 'because',
  'so far', 'to date', 'until now', 'admittedly', 'honestly', 'frankly', 'to be honest', 'currently', 'at present',
  'at the moment', 'personally', 'unfortunately', 'of course', 'naturally', 'moreover', 'furthermore', 'in addition',
  'also', 'therefore'));
const EN_I_AM = any('i am', "i'm", 'am');
const EN_DEGREE = star(oneOf('very really highly particularly truly genuinely extremely fully absolutely especially also equally therefore thus most'));
// When and where the learning will happen: the new job, never the past, never a deepening ("in depth").
const EN_ADVERB = star(any('quickly', 'rapidly', 'soon', 'fast', 'swiftly', 'thoroughly', 'properly', 'on the job',
  'as quickly as possible', 'as soon as possible', 'from scratch', 'step by step', 'with your team', 'alongside your team', 'with you',
  'in this role', 'in the new role', 'in the coming months', 'in the first months', 'within the first months', 'in my first months',
  'in the first weeks', 'within the first weeks', 'during onboarding', 'during the onboarding', 'from day one', 'now', 'next', 'in the future'));
const EN_EXPERIENCE = oneOf('experience knowledge skills expertise familiarity exposure');
const EN_GAIN_ADJ = opt(oneOf('the'));
const EN_GAIN_KIND = opt(oneOf('hands-on practical first some solid direct real necessary required'));
const EN_LEARN = any('learn', 'learn about', 'learn to use', 'learn how to use', 'learn to work with', 'learn how to work with', 'study',
  'acquire', 'get to know', 'get familiar with', 'become familiar with', 'familiari[sz]e myself with', 'pick up', 'get up to speed (?:with|on)',
  seq(oneOf('gain build get acquire develop'), EN_GAIN_ADJ, EN_GAIN_KIND, EN_EXPERIENCE, oneOf('with in of on using for')));
const EN_LEARNING = any('learning', 'learning about', 'learning to use', 'learning how to use', 'studying', 'acquiring', 'getting to know',
  'getting familiar with', 'becoming familiar with', 'familiari[sz]ing myself with', 'picking up', 'getting up to speed (?:with|on)',
  seq(oneOf('gaining building getting acquiring developing'), EN_GAIN_ADJ, EN_GAIN_KIND, EN_EXPERIENCE, oneOf('with in of on using for')));
const EN_INF = seq(EN_ADVERB, EN_LEARN, NP, EN_ADVERB);
const EN_GERUND = seq(EN_ADVERB, EN_LEARNING, NP, EN_ADVERB);
const EN_MORE = (inf) => star(any(', and', 'and', ','), opt('to'), inf);
const EN_ADJECTIVE = oneOf('motivated eager keen ready willing happy glad excited determined prepared enthusiastic delighted');
const EN_CONFIDENT = any(seq(EN_I_AM, EN_DEGREE, oneOf('confident sure certain convinced')), 'i have no doubt', "i've no doubt");
const EN_INTENT = [
  seq(EN_PRE, EN_I_AM, EN_DEGREE, EN_ADJECTIVE, 'to', EN_INF, EN_MORE(EN_INF)),
  seq(EN_PRE, any("i would like", "i'd like", 'i would love', "i'd love", 'i want', 'i wish', 'i hope', 'i plan', 'i intend',
    'i aim', 'would like', 'want', 'hope', 'plan', 'intend', 'aim', 'i would welcome the (?:opportunity|chance)',
    "i'd welcome the (?:opportunity|chance)", 'i welcome the (?:opportunity|chance)', 'my (?:goal|aim|objective|plan) is',
    seq(any('i would be', "i'd be", 'i will be', "i'll be", 'would be', 'will be'), EN_DEGREE, EN_ADJECTIVE)),
  'to', EN_INF, EN_MORE(EN_INF)),
  seq(EN_PRE, any('i look forward', 'i am looking forward', "i'm looking forward", 'look forward', 'looking forward'), 'to', EN_GERUND, EN_MORE(EN_GERUND)),
  seq(EN_PRE, EN_I_AM, EN_DEGREE, any('interested in', 'committed to', 'open to', 'dedicated to', 'excited about', 'enthusiastic about', 'keen on'),
    EN_GERUND, EN_MORE(EN_GERUND)),
  seq(EN_PRE, EN_CONFIDENT, opt('that'), any('i can', 'i will', "i'll", 'i could', 'i would'), EN_INF, EN_MORE(EN_INF)),
  seq(EN_PRE, any('i will', "i'll", 'will', 'i can', 'can'), EN_INF, EN_MORE(EN_INF)),
];
const EN_HAVE = any('i have', "i've", 'have');
const EN_HAVE_NOT = any('i have not', "i haven't", "i've not", 'i have never', "i've never", 'have not', "haven't", 'have never');
const EN_DO_NOT = any('i do not', "i don't", 'do not', "don't");
const EN_TRAIL = opt(any('yet', 'so far', 'before', 'until now', 'to date', 'as yet', 'previously', 'in the past'));
// "No prior experience" is none at all; "no professional, hands-on or direct experience" says another kind was had.
const EN_EXP_ADJ = opt(oneOf('prior previous'));
const EN_USED = seq(any('used', 'worked with', 'worked on', 'worked in'), LNP, star(LIST_JOIN, opt(oneOf('with on in')), LNP));
const EN_LACK = [
  seq(EN_PRE, EN_HAVE_NOT, opt('yet'), EN_USED, EN_TRAIL),
  seq(EN_PRE, EN_HAVE_NOT, opt('yet'), 'had', oneOf('the a an'), oneOf('chance opportunity'), 'to', any('use', 'work with', 'work on', 'work in', 'learn'),
    LNP, star(LIST_JOIN, opt(oneOf('with on in')), LNP), EN_TRAIL),
  seq(EN_PRE, EN_HAVE, 'yet to', any('use', 'work with', 'work on', 'work in', 'learn'), LNP, star(LIST_JOIN, opt(oneOf('with on in')), LNP), EN_TRAIL),
  seq(EN_PRE, EN_HAVE, 'no', EN_EXP_ADJ, oneOf('experience knowledge exposure background familiarity'), lpps(any(oneOf('with in of using on'), 'working with')), EN_TRAIL),
  seq(EN_PRE, EN_HAVE, 'no', EN_EXP_ADJ, LNP, oneOf('experience knowledge exposure skills background'), EN_TRAIL),
  seq(EN_PRE, EN_DO_NOT, opt('yet'), 'have', opt('any'), EN_EXP_ADJ, oneOf('experience knowledge exposure familiarity'), lpps(oneOf('with in of using on')), EN_TRAIL),
  seq(EN_PRE, EN_DO_NOT, opt('yet'), 'have', opt('any'), EN_EXP_ADJ, LNP, oneOf('experience knowledge exposure skills'), EN_TRAIL),
  seq(EN_PRE, any('i lack', 'lack', 'i am lacking', "i'm lacking"), opt('any'), EN_EXP_ADJ, oneOf('experience knowledge exposure familiarity'), lpps(oneOf('with in of using on')), EN_TRAIL),
  seq(EN_PRE, any('i lack', 'lack'), EN_EXP_ADJ, LNP, oneOf('experience knowledge exposure skills'), EN_TRAIL),
  seq(EN_PRE, EN_I_AM, any('not yet', 'not', 'still not'), 'familiar', lpps(oneOf('with')), EN_TRAIL),
  seq(EN_PRE, EN_I_AM, opt('still'), 'unfamiliar', lpps(oneOf('with')), EN_TRAIL),
  seq(EN_PRE, EN_I_AM, opt('still'), opt(oneOf('completely entirely totally')), 'new', lpps(oneOf('to'))),
  seq(EN_PRE, LNP, oneOf('is are'), opt('still'), opt(oneOf('completely entirely totally')), 'new to me'),
  seq(EN_PRE, LNP, oneOf('is are'), oneOf('a an'), oneOf('tool system platform technology software solution program programme'),
    opt(oneOf('that which')), EN_HAVE_NOT, opt('yet'), any('used', 'worked with', 'worked on'), EN_TRAIL),
  seq(EN_PRE, EN_DO_NOT, opt('yet'), 'know', LNP, star(LIST_JOIN, LNP), EN_TRAIL),
  seq(EN_PRE, EN_DO_NOT, 'yet use', LNP, star(LIST_JOIN, LNP)),
  seq(EN_PRE, EN_DO_NOT, 'use', LNP, star(LIST_JOIN, LNP), 'yet'),
  seq(EN_PRE, 'not having', opt('yet'), EN_USED, EN_TRAIL),
  seq(EN_PRE, 'my', oneOf('background experience cv'), any('does not', "doesn't"), opt('yet'), 'include', LNP, star(LIST_JOIN, LNP), EN_TRAIL),
  seq(EN_PRE, LNP, any('is not', "isn't", 'are not', "aren't"), oneOf('a an'), oneOf('tool system platform technology software solution program programme'),
    opt(oneOf('that which')), any('i have', "i've"), any('used', 'worked with', 'worked on'), EN_TRAIL),
];
// "…, but I am eager to learn it": the pronoun is the tool of the gap before.
const EN_LEARN_IT = seq(EN_ADVERB, any('learn', 'master', 'acquire', 'pick up', 'get to know'), oneOf('it them'), EN_ADVERB);
const EN_PRONOUN = [
  seq(EN_PRE, EN_I_AM, EN_DEGREE, EN_ADJECTIVE, 'to', EN_LEARN_IT),
  seq(EN_PRE, any("i would like", "i'd like", 'i want', 'i hope', 'i plan', 'i intend', 'would like', 'want', 'i would welcome the (?:opportunity|chance)',
    "i'd welcome the (?:opportunity|chance)", 'i welcome the (?:opportunity|chance)'), 'to', EN_LEARN_IT),
  seq(EN_PRE, EN_CONFIDENT, opt('that'), any('i can', 'i will', "i'll", 'i could'), EN_LEARN_IT),
  seq(EN_PRE, any('i will', "i'll", 'will', 'i can', 'can'), EN_LEARN_IT),
];
// A short clause that says nothing of any tool: it may stand next to a gap ("…, but I learn quickly").
const EN_NEUTRAL = [
  seq(opt(oneOf('but and though although yet')), any('i learn', 'i adapt', 'i pick things up', 'i pick up new tools', 'i get up to speed'), opt(oneOf('very really')), oneOf('quickly fast easily'),
    opt('to new', oneOf('systems tools environments software'))),
  seq(opt(oneOf('but and though although yet')), EN_I_AM, any('a fast learner', 'a quick learner'), opt('and', EN_DEGREE, EN_ADJECTIVE, 'to', any('learn', 'get up to speed'))),
  // A wish to learn with no object: it says nothing the candidate has ("…, but I am eager to learn").
  seq(opt(oneOf('but and')), EN_I_AM, EN_DEGREE, EN_ADJECTIVE, 'to', any('learn', 'get up to speed', 'close this gap', 'close the gap', 'fill this gap')),
  seq(opt(oneOf('but and')), any("i would like", "i'd like", 'i want'), 'to', any('learn', 'close this gap', 'close the gap', 'fill this gap')),
  seq(opt(oneOf('but and')), opt('i'), 'enjoy', opt('learning'), 'new', oneOf('tools systems things challenges')),
  // Contributing to the employer's team, said in a closed form ("…and help your finance team").
  seq(opt(oneOf('and to')), oneOf('help support assist'), oneOf('your the'), opt(oneOf('finance accounting sales operations')), oneOf('team teams company department colleagues customers clients guests')),
  seq(opt(oneOf('and to')), 'contribute to', oneOf('your the'), opt(oneOf('finance accounting sales operations')), oneOf('team teams company department')),
  oneOf('however moreover nevertheless nonetheless'),
];

// ---------------------------------------------------------------------------
// Italian
// ---------------------------------------------------------------------------

const IT_PRE = opt(any('pur', 'anche se', 'sebbene', 'benché', 'seppure', 'seppur', 'finora', 'ad oggi', 'fino ad oggi', 'purtroppo',
  'onestamente', 'francamente', 'attualmente', 'per ora', 'al momento', 'personalmente', 'inoltre', 'quindi', 'certo',
  'naturalmente', 'tuttavia', 'però', 'poiché', 'siccome', 'dato che'));
const IT_TO = oneOf("a ad di d'");
const IT_DEGREE = star(oneOf('molto davvero particolarmente fortemente assolutamente pienamente altamente quindi inoltre anche sempre'));
const IT_ADVERB = star(any('rapidamente', 'velocemente', 'presto', 'in fretta', 'bene', 'subito', 'al più presto',
  'sul campo', 'gradualmente', 'in breve tempo', 'da zero', 'passo dopo passo', 'con il vostro team', 'con voi', 'nel nuovo ruolo',
  'in questo ruolo', 'nei primi mesi', 'entro i primi mesi', 'nelle prime settimane', 'fin da subito', 'dal primo giorno',
  "durante l' inserimento", 'ora', 'adesso', 'in futuro'));
const IT_EXPERIENCE = oneOf('esperienza esperienze pratica dimestichezza competenze conoscenze familiarità');
const IT_LEARN = any('imparare', 'apprendere', 'acquisire', 'conoscere', 'studiare', 'familiarizzare con', 'prendere confidenza con',
  'formarmi su', 'formarmi in', "formarmi sull'", 'impratichirmi con', 'imparare (?:a|ad) (?:usare|utilizzare|gestire)', 'imparare (?:a|ad) lavorare con',
  seq(oneOf('acquisire maturare fare farmi'), IT_ADVERB, opt(oneOf("una un' dell' la l' le i gli")), opt(oneOf('prima buona solida concreta')), IT_EXPERIENCE,
    opt(oneOf('diretta pratica concreta necessarie necessaria richieste')), any(oneOf('con in di su'), "nell' uso di", "nell' utilizzo di", "sull' uso di")));
const IT_INF = seq(IT_ADVERB, IT_LEARN, IT_ADVERB, NP, IT_ADVERB);
const IT_MORE = star(any(', e', 'e', 'ed', ','), opt(IT_TO), IT_INF);
const IT_FRAME = any(
  seq(any('sono', 'sarei', 'sarò', 'mi sento'), IT_DEGREE,
    oneOf('motivato motivata desideroso desiderosa pronto pronta disposto disposta felice lieto lieta entusiasta determinato determinata impaziente curioso curiosa interessato interessata'), IT_TO),
  any('desidero', 'vorrei', 'voglio', 'intendo', 'spero di', 'conto di', 'mi piacerebbe', 'mi propongo di', 'mi impegno a', 'mi impegnerò a',
    "non vedo l' ora di", 'ho voglia di', "ho intenzione di", 'mi interessa', 'punto a', 'il mio obiettivo è', 'il mio obiettivo è quello di',
    'ho la motivazione (?:per|di)', 'ho tutta la motivazione (?:per|di)', 'sono (?:convint|sicur|cert)[oa] di poter', 'mi sento in grado di'));
const IT_INTENT = [
  seq(IT_PRE, IT_FRAME, IT_INF, IT_MORE),
  seq(IT_PRE, oneOf('imparerò apprenderò acquisirò conoscerò studierò'), IT_ADVERB, NP, IT_ADVERB, IT_MORE),
];
const IT_NOT_HAVE = any('non ho', 'non avendo', 'pur non avendo', 'non abbia', 'pur non avendone');
const IT_AGAIN = star(oneOf('ancora mai finora'));
const IT_TRAIL = opt(any('finora', 'prima', 'in precedenza', 'fino ad oggi', 'fino ad ora', 'per ora'));
const IT_EXP_PREP = any(oneOf('con di in su del della dei nel nella sul sulla'), "nell' uso di", "nell' utilizzo di", "sull' uso di");
const IT_USED = seq(any('lavorato con', 'lavorato su', 'lavorato in', 'usato', 'utilizzato', 'adoperato', 'impiegato'), LNP,
  star(LIST_JOIN, opt(oneOf('con su in')), LNP));
const IT_LACK = [
  seq(IT_PRE, IT_NOT_HAVE, IT_AGAIN, IT_USED, IT_TRAIL),
  seq(IT_PRE, IT_NOT_HAVE, IT_AGAIN, 'avuto', any('modo', 'occasione', "l' occasione", 'la possibilità'), oneOf("di d'"),
    any('usare', 'utilizzare', 'lavorare con', 'lavorare su', 'imparare', 'conoscere'), LNP, star(LIST_JOIN, opt(oneOf('con su')), LNP), IT_TRAIL),
  seq(IT_PRE, IT_NOT_HAVE, IT_AGAIN, opt(oneOf('avuto maturato')), opt(oneOf("alcuna nessuna un' una")), IT_EXPERIENCE,
    opt(oneOf('precedente pregressa')), lpps(IT_EXP_PREP), IT_TRAIL),
  seq(IT_PRE, any('non conosco', 'pur non conoscendo', 'non conoscendo'), opt('ancora'), LNP, star(LIST_JOIN, LNP), IT_TRAIL),
  seq(IT_PRE, any('non uso ancora', 'non utilizzo ancora'), LNP, star(LIST_JOIN, LNP)),
  seq(IT_PRE, LNP, 'non', any(seq(oneOf('lo la li le'), 'conosco', opt('ancora')), seq(oneOf("lo la li le l'"), any('ho mai', 'ho ancora'),
    oneOf('usato usata usati usate utilizzato utilizzata utilizzati utilizzate')))),
  seq(IT_PRE, any('mi manca', 'mi mancano', 'manca'), opt('ancora'), opt(oneOf("l' la un' una le")), IT_EXPERIENCE, lpps(IT_EXP_PREP)),
  seq(IT_PRE, LNP, oneOf('è sono'), star(any('ancora', 'per me', 'del tutto', 'completamente')), oneOf('nuovo nuova nuovi nuove'), opt('per me')),
  seq(IT_PRE, LNP, 'è', star(any('ancora', 'per me')), any('una novità', "un' assoluta novità"), opt('per me')),
  seq(IT_PRE, 'senza', opt(oneOf('aver avere')), IT_AGAIN, IT_USED),
  seq(IT_PRE, 'senza', opt(oneOf('alcuna una')), oneOf('esperienza esperienze'), opt(oneOf('pregressa precedente')), lpps(oneOf('con di in su'))),
];
const IT_PRONOUN = [
  seq(IT_PRE, IT_FRAME, IT_ADVERB, token((norm) => /^(?:imparar|apprender|conoscer|acquisir|padroneggiar)(?:lo|la|li|le)$/u.test(bare(norm))), IT_ADVERB),
  seq(IT_PRE, oneOf('lo la li le'), oneOf('imparerò apprenderò conoscerò'), IT_ADVERB),
  seq(IT_PRE, IT_FRAME, oneOf('poterlo poterla poterli poterle'), oneOf('imparare conoscere apprendere'), IT_ADVERB),
  seq(IT_PRE, 'sono', oneOf('convinto convinta sicuro sicura certo certa'), 'di', oneOf('poterlo poterla poterli poterle'), oneOf('imparare conoscere apprendere'), IT_ADVERB),
];
const IT_NEUTRAL = [
  seq(opt(oneOf('ma e però')), any('imparo', 'apprendo'), opt('molto'), any('in fretta', 'velocemente', 'rapidamente', 'presto')),
  seq(opt(oneOf('ma e però')), 'mi adatto', any('rapidamente', 'velocemente', 'facilmente', 'in fretta')),
  seq(opt(oneOf('ma e però')), 'sono una persona che impara', any('in fretta', 'rapidamente', 'velocemente')),
  seq(opt(oneOf('ma e però')), IT_FRAME, any('imparare', 'formarmi', 'colmare questa lacuna', 'colmare la lacuna')),
  seq(opt(oneOf('e')), opt(oneOf('a ad per')), oneOf('aiutare supportare sostenere'), any('il vostro team', 'il vostro reparto', 'la vostra azienda', 'i vostri clienti', 'i vostri ospiti')),
  seq(opt(oneOf('e')), opt(oneOf('a per')), any('contribuire al vostro team', 'contribuire al successo del vostro team', 'contribuire alla vostra azienda')),
  oneOf('tuttavia comunque'),
];

// ---------------------------------------------------------------------------
// German
// ---------------------------------------------------------------------------

const DE_PRE = opt(any('bisher', 'bislang', 'leider', 'ehrlich gesagt', 'zugegeben', 'zugegebenermassen', 'zugegebenermaßen', 'derzeit',
  'aktuell', 'zwar', 'allerdings', 'momentan', 'zurzeit', 'natürlich', 'selbstverständlich', 'zudem', 'ausserdem', 'außerdem', 'auch', 'daher', 'deshalb'));
const DE_ADVERB = star(any('schnell', 'rasch', 'zügig', 'gründlich', 'gerne', 'gern', 'bald', 'möglichst schnell', 'so schnell wie möglich',
  'zeitnah', 'umgehend', 'auch', 'von grund auf', 'schritt für schritt', 'in den ersten monaten', 'in den ersten wochen',
  'innerhalb der ersten monate', 'von anfang an', 'ab dem ersten tag', 'in meiner neuen stelle', 'in der neuen stelle', 'bei ihnen',
  'in ihrem team', 'im neuen job', 'im team', 'nun', 'jetzt', 'künftig', 'zukünftig'));
const DE_DEGREE = star(oneOf('sehr hoch äusserst äußerst besonders wirklich absolut voll gerne gern jederzeit auch daher deshalb zudem aber jedoch'));
const DE_EXPERIENCE = oneOf('erfahrung erfahrungen kenntnisse praxis');
const DE_EXP_ADJ = opt(oneOf('vorherige vorherigen bisherige bisherigen'));
const DE_EXP_PREP = any('mit', 'in', 'im umgang mit', 'bei');
// The learn verb closes its phrase: as an infinitive with "zu" after a frame and a comma, or bare after a modal.
const deItem = ({ learn, settle, acquire, familiar, gather }) => any(
  seq(DE_ADVERB, NP, DE_ADVERB, learn),
  seq('mich', DE_ADVERB, 'in', NP, DE_ADVERB, settle),
  seq('mir', DE_ADVERB, NP, DE_ADVERB, acquire),
  seq('mir', DE_ADVERB, opt(oneOf('erste ersten')), DE_EXPERIENCE, pps(DE_EXP_PREP), DE_ADVERB, acquire),
  seq('mich', DE_ADVERB, 'mit', NP, DE_ADVERB, familiar),
  seq(DE_ADVERB, opt(oneOf('erste ersten praktische praktischen')), DE_EXPERIENCE, pps(DE_EXP_PREP), DE_ADVERB, gather));
const DE_ZU_ITEM = deItem({
  learn: any('zu lernen', 'zu erlernen', 'kennenzulernen', 'kennen zu lernen', 'zu studieren', 'lernen zu können', 'erlernen zu können', 'kennenlernen zu können'),
  settle: any('einzuarbeiten', 'einarbeiten zu können'),
  acquire: any('anzueignen', 'aneignen zu können'),
  familiar: any('vertraut zu machen', 'vertraut machen zu können'),
  gather: any('zu sammeln', 'zu gewinnen', 'zu erwerben', 'aufzubauen', 'sammeln zu können'),
});
const DE_BARE_ITEM = deItem({
  learn: any('lernen', 'erlernen', 'kennenlernen', 'kennen lernen', 'studieren'),
  settle: 'einarbeiten',
  acquire: 'aneignen',
  familiar: 'vertraut machen',
  gather: any('sammeln', 'gewinnen', 'erwerben', 'aufbauen'),
});
const DE_ZU_FRAME = any(
  seq(any('ich bin', 'bin ich', 'bin', 'ich wäre', 'wäre ich', 'ich fühle mich'), DE_DEGREE,
    oneOf('motiviert hochmotiviert bereit gewillt interessiert entschlossen gespannt begierig überzeugt zuversichtlich sicher')),
  seq(any('ich freue mich', 'freue mich', 'ich habe lust', 'ich habe grosse lust', 'ich habe große lust', 'ich habe vor', 'habe vor',
    'ich plane', 'ich beabsichtige', 'mein ziel ist es', 'es ist mein ziel'), opt('darauf')),
  seq('ich bringe die', opt(oneOf('nötige notwendige grosse große')), oneOf('bereitschaft motivation'), 'mit'));
const DE_MODAL = any('ich möchte', 'möchte ich', 'möchte', 'ich will', 'will ich', 'ich würde gerne', 'ich würde gern', 'würde ich gerne',
  'würde gerne', 'ich werde', 'werde ich', 'werde', 'gerne möchte ich', 'ich kann', 'kann ich');
const DE_INTENT = [
  seq(DE_PRE, DE_ZU_FRAME, ',', DE_ZU_ITEM, star(any('und', ', und', ','), DE_ZU_ITEM)),
  seq(DE_PRE, DE_MODAL, DE_DEGREE, DE_BARE_ITEM, star(any('und', ', und'), DE_BARE_ITEM)),
  seq(DE_PRE, NP, any('möchte ich', 'will ich', 'werde ich', 'würde ich'), DE_ADVERB, any('lernen', 'erlernen', 'kennenlernen')),
  seq(DE_PRE, 'in', NP, any('möchte ich', 'will ich', 'werde ich', 'würde ich'), 'mich', DE_ADVERB, 'einarbeiten'),
  seq(DE_PRE, opt(oneOf('erste ersten')), DE_EXPERIENCE, pps(DE_EXP_PREP), any('möchte ich', 'will ich', 'werde ich', 'würde ich'), DE_ADVERB,
    any('sammeln', 'gewinnen', 'erwerben', 'aufbauen')),
  // "Gerne arbeite ich mich in SAP ein", "Kubernetes lerne ich gerne": a willingness in the present.
  seq(DE_PRE, oneOf('gerne gern'), any(
    seq('arbeite ich mich', DE_ADVERB, 'in', NP, DE_ADVERB, 'ein'),
    seq('eigne ich mir', DE_ADVERB, NP, DE_ADVERB, 'an'),
    seq('sammle ich', opt(oneOf('erste')), DE_EXPERIENCE, pps(DE_EXP_PREP)),
    seq('lerne ich', NP, DE_ADVERB),
    seq('mache ich mich', DE_ADVERB, 'mit', NP, DE_ADVERB, 'vertraut'))),
  seq(DE_PRE, any('ich arbeite mich', 'arbeite mich'), DE_ADVERB, 'in', NP, DE_ADVERB, 'ein'),
  seq(DE_PRE, NP, 'lerne ich', DE_ADVERB),
];
const DE_HABE = any('ich habe', 'habe ich', 'habe', 'hab ich');
const DE_AGAIN = star(oneOf('noch bisher bislang leider zwar allerdings jedoch'));
const DE_NEVER = any('nie', 'nicht', 'noch nie', 'noch nicht', 'niemals');
const DE_USED = oneOf('eingesetzt verwendet genutzt benutzt angewendet angewandt gelernt');
const DE_WITH = (preposition) => seq(preposition, LNP, star(LIST_JOIN, opt(preposition), LNP));
const DE_LACK = [
  seq(DE_PRE, DE_HABE, DE_AGAIN, oneOf('keine keinerlei'), DE_EXP_ADJ, DE_EXPERIENCE, lpps(DE_EXP_PREP)),
  seq(DE_PRE, DE_HABE, DE_AGAIN, oneOf('keine keinerlei'), DE_EXP_ADJ,
    star(token((norm) => norm === '§' || norm === '§-'), opt(oneOf(', und oder'))),
    token((norm) => /^§-(?:kenntnisse|erfahrung|erfahrungen|praxis|know-how|grundkenntnisse)$/.test(norm))),
  seq(DE_PRE, DE_HABE, DE_AGAIN, DE_NEVER, DE_WITH(oneOf('mit')), any('gearbeitet', 'zu tun gehabt')),
  seq(DE_PRE, DE_HABE, LNP, star(LIST_JOIN, LNP), DE_AGAIN, DE_NEVER, DE_USED),
  seq(DE_PRE, LNP, any('habe ich', 'hab ich'), DE_AGAIN, DE_NEVER, DE_USED),
  seq(DE_PRE, 'mit', LNP, any('habe ich', 'hab ich'), DE_AGAIN, DE_NEVER, 'gearbeitet'),
  seq(DE_PRE, 'mit', LNP, any('habe ich', 'hab ich'), DE_AGAIN, oneOf('keine keinerlei'), DE_EXP_ADJ, DE_EXPERIENCE),
  seq(DE_PRE, 'mit', LNP, any('bin ich', 'ich bin'), DE_AGAIN, any('nicht', 'noch nicht'), 'vertraut'),
  seq(DE_PRE, 'ich bin', DE_AGAIN, any('nicht', 'noch nicht'), DE_WITH(oneOf('mit')), 'vertraut'),
  seq(DE_PRE, LNP, 'kenne ich', DE_AGAIN, 'nicht'),
  seq(DE_PRE, 'ich kenne', LNP, star(LIST_JOIN, LNP), DE_AGAIN, 'nicht'),
  seq(DE_PRE, any('ich nutze', 'ich verwende', 'ich benutze'), LNP, star(LIST_JOIN, LNP), 'noch nicht'),
  seq(DE_PRE, any('ich verfüge', 'verfüge ich'), DE_AGAIN, any(seq('nicht über', DE_EXPERIENCE), seq('über keine', DE_EXP_ADJ, DE_EXPERIENCE)), lpps(DE_EXP_PREP)),
  seq(DE_PRE, any('mir fehlt', 'mir fehlen', 'es fehlt mir', 'fehlt mir'), DE_AGAIN, opt(oneOf('die eine')), DE_EXP_ADJ,
    DE_EXPERIENCE, lpps(any(DE_EXP_PREP, 'von'))),
  seq(DE_PRE, LNP, oneOf('ist sind'), star(any('für mich', 'mir', 'noch', 'bisher', 'bislang', 'völlig', 'ganz')), oneOf('neu neuland'), opt('für mich')),
  seq(DE_PRE, DE_EXPERIENCE, lpps(DE_EXP_PREP), any('bringe ich', 'habe ich'), DE_AGAIN, 'nicht', opt('mit')),
  seq(DE_PRE, any('ich hatte', 'hatte ich'), DE_AGAIN, 'keine gelegenheit', ',', any(seq('mit', LNP, 'zu arbeiten'),
    seq(LNP, any('einzusetzen', 'zu nutzen', 'zu verwenden', 'kennenzulernen')))),
  seq('ohne', DE_AGAIN, DE_WITH(oneOf('mit')), 'gearbeitet zu haben'),
  seq('ohne', LNP, DE_AGAIN, DE_USED, 'zu haben'),
  seq('ohne', DE_EXP_ADJ, DE_EXPERIENCE, lpps(DE_EXP_PREP)),
  seq(any('obwohl ich', 'auch wenn ich', 'wenngleich ich', 'da ich', 'weil ich'), DE_AGAIN, any(
    seq(oneOf('keine keinerlei'), DE_EXP_ADJ, DE_EXPERIENCE, lpps(DE_EXP_PREP), 'habe'),
    seq(DE_NEVER, DE_WITH(oneOf('mit')), 'gearbeitet habe'),
    seq(LNP, DE_AGAIN, DE_NEVER, DE_USED, 'habe'),
    seq(LNP, DE_AGAIN, 'nicht kenne'))),
];
const DE_PRONOUN = [
  seq(DE_PRE, DE_ZU_FRAME, ',', oneOf('es sie ihn das dies diese'), DE_ADVERB, any('zu lernen', 'zu erlernen', 'kennenzulernen')),
  seq(DE_PRE, DE_ZU_FRAME, ',', 'mich', DE_ADVERB, any('darin einzuarbeiten', 'damit vertraut zu machen')),
  seq(DE_PRE, DE_ZU_FRAME, ',', oneOf('es sie ihn das dies diese'), 'mir', DE_ADVERB, 'anzueignen'),
  seq(DE_PRE, DE_ZU_FRAME, ',', 'mir', oneOf('es sie ihn das dies diese'), DE_ADVERB, 'anzueignen'),
  seq(DE_PRE, DE_MODAL, DE_DEGREE, oneOf('es sie ihn das dies diese'), DE_ADVERB, any('lernen', 'erlernen', 'kennenlernen')),
  seq(DE_PRE, any('ich eigne', 'eigne ich'), oneOf('es sie ihn'), 'mir', DE_ADVERB, 'an'),
  seq(DE_PRE, any('ich eigne mir', 'eigne ich mir'), oneOf('es sie ihn'), DE_ADVERB, 'an'),
  seq(opt(oneOf('aber und')), any('eigne', 'eigne ich'), oneOf('es sie ihn'), 'mir', opt(oneOf('aber jedoch')), DE_ADVERB, 'an'),
];
const DE_NEUTRAL = [
  seq(opt(oneOf('aber und doch jedoch')), any('ich lerne', 'lerne ich', 'lerne'), opt(oneOf('aber jedoch')), oneOf('schnell rasch')),
  seq(opt(oneOf('aber und doch jedoch')), any('ich arbeite mich', 'arbeite mich', 'arbeite ich mich'), opt(oneOf('aber jedoch')), repeat(oneOf('schnell rasch gerne gern'), 1, 2), 'ein'),
  seq(opt(oneOf('und')), any('ihrem team helfen', 'ihr team unterstützen', 'ihre kunden unterstützen', 'zum erfolg ihres teams beitragen')),
  seq(opt(oneOf('aber und')), DE_ZU_FRAME, ',', opt('mich'), DE_ADVERB, any('einzuarbeiten', 'diese lücke zu schliessen', 'diese lücke zu schließen')),
  oneOf('allerdings jedoch trotzdem dennoch'),
];

// ---------------------------------------------------------------------------
// French
// ---------------------------------------------------------------------------

const FR_PRE = opt(any('bien que', 'même si', 'quoique', 'si', "pour l' instant", 'pour le moment', "jusqu' ici", "jusqu' à présent",
  'à ce jour', 'honnêtement', 'actuellement', 'malheureusement', 'certes', 'personnellement', 'toutefois', 'cependant',
  'néanmoins', 'par ailleurs', 'de plus', 'en outre', 'aussi', 'donc', 'bien sûr', 'comme', 'puisque'));
const FR_TO = oneOf("à de d'");
const FR_DEGREE = star(any('très', 'particulièrement', 'vraiment', 'tout à fait', 'pleinement', 'fortement', 'donc', 'aussi', 'également', 'tout'));
const FR_ADVERB = star(any('rapidement', 'vite', 'bien', 'au plus vite', 'progressivement', 'sur le terrain', 'au plus tôt',
  'à vos côtés', 'avec votre équipe', 'au sein de votre équipe', 'dans ce poste', 'dans les premiers mois', 'dès les premiers mois',
  'au cours des premiers mois', 'dès le départ', 'dès le premier jour', 'de zéro', 'à partir de zéro', 'pas à pas', 'désormais',
  'maintenant', "à l' avenir"));
const FR_LEARN = any('apprendre', 'acquérir', 'découvrir', 'connaître', 'étudier', 'me familiariser avec', 'me former à', 'me former sur',
  'me former en', 'me former aux', 'me former au', "m' initier à", "m' initier aux", "m' initier au", 'prendre en main',
  'apprendre à (?:utiliser|maîtriser)', 'apprendre à travailler avec',
  seq(oneOf('acquérir gagner développer'), opt(any("de l'", 'une', 'des', "d'", "l'", 'les')), opt(oneOf('première solide bonne')),
    oneOf('expérience pratique compétences connaissances'), opt(oneOf('pratique concrète directe nécessaires requises')), oneOf('avec en sur dans de')));
const FR_INF = seq(FR_ADVERB, FR_LEARN, FR_ADVERB, NP, FR_ADVERB);
const FR_MORE = star(any(', et', 'et', ','), opt(FR_TO), FR_INF);
const FR_FRAME = any(
  seq(any('je suis', 'je serais', 'je serai', 'je me sens', 'suis'), FR_DEGREE,
    oneOf('motivé motivée prêt prête disposé disposée désireux désireuse impatient impatiente heureux heureuse ravi ravie déterminé déterminée enthousiaste curieux curieuse intéressé intéressée'), FR_TO),
  any('je souhaite', 'je souhaiterais', 'je veux', 'je voudrais', "j' aimerais", 'je compte', 'je prévois de', "je prévois d'",
    "j' ai l' intention de", "j' ai l' intention d'", "je m' engage à", "j' ai hâte de", "j' ai hâte d'", "j' ai envie de", "j' ai envie d'",
    'je me réjouis de', "je me réjouis d'", 'souhaite', 'compte', 'aimerais', 'mon objectif est de', "mon objectif est d'",
    'je suis (?:convaincue?|sûre?|certaine?) de pouvoir', 'je me sens capable de'));
const FR_INTENT = [
  seq(FR_PRE, FR_FRAME, FR_INF, FR_MORE),
  seq(FR_PRE, any("j' apprendrai", "j' acquerrai", 'je découvrirai'), FR_ADVERB, NP, FR_ADVERB, FR_MORE),
];
const FR_NOT_HAVE = any("je n' ai", "n' ai", "je n' aie", "n' aie");
const FR_TRAIL = opt(any("jusqu' ici", "pour l' instant", 'pour le moment', 'auparavant', "jusqu' à présent", 'à ce jour'));
const FR_USED = seq(any('utilisé', 'travaillé avec', 'travaillé sur', 'travaillé dans', 'pratiqué'), LNP, star(LIST_JOIN, opt(oneOf('avec sur')), LNP));
const FR_LACK = [
  seq(FR_PRE, FR_NOT_HAVE, any('pas', 'jamais', 'pas encore', 'encore jamais', 'jamais encore'), FR_USED, FR_TRAIL),
  seq(FR_PRE, FR_NOT_HAVE, any('pas', 'jamais', 'pas encore', 'encore jamais'), "eu l' occasion",
    any("d' utiliser", 'de travailler avec', 'de travailler sur', "d' apprendre", 'de découvrir', 'de pratiquer'), LNP,
    star(LIST_JOIN, opt(oneOf('avec sur')), LNP), FR_TRAIL),
  seq(FR_PRE, FR_NOT_HAVE, any(seq(any('pas', 'pas encore', 'jamais', 'encore'), oneOf("d' de")), seq(opt('encore'), 'aucune')),
    oneOf('expérience connaissance connaissances pratique compétences'), opt(oneOf('préalable antérieure')),
    lpps(oneOf('avec en de sur dans du des')), FR_TRAIL),
  seq(FR_PRE, any('je ne dispose', 'ne dispose'), 'pas', opt('encore'), any("d' expérience", 'de connaissances', 'de compétences'), lpps(oneOf('avec en de sur dans'))),
  seq(FR_PRE, any('je ne connais', 'ne connais', 'je ne maîtrise', 'ne maîtrise'), 'pas', opt('encore'), LNP, star(LIST_JOIN, LNP), FR_TRAIL),
  seq(FR_PRE, any("je n' utilise", "n' utilise"), 'pas encore', LNP, star(LIST_JOIN, LNP)),
  seq(FR_PRE, any('je manque', 'manque', 'manquant'), opt('encore'), any("d' expérience", 'de pratique', 'de connaissances'), lpps(oneOf('avec en sur dans de'))),
  seq(FR_PRE, LNP, oneOf('est sont'), star(any('encore', 'pour moi', 'totalement', 'complètement')), oneOf('nouveau nouvelle nouveaux nouvelles'), opt('pour moi')),
  seq(FR_PRE, LNP, "m' est", star(oneOf('encore totalement complètement')), oneOf('inconnu inconnue inconnus inconnues')),
  seq(FR_PRE, 'sans', opt('avoir'), star(oneOf('encore jamais')), FR_USED),
  seq(FR_PRE, 'sans', oneOf("expérience connaissances"), opt(oneOf('préalable')), lpps(oneOf('avec de en sur'))),
];
const FR_PRONOUN = [
  seq(FR_PRE, FR_FRAME, oneOf("l' le la les"), FR_ADVERB, oneOf('apprendre découvrir maîtriser acquérir connaître'), FR_ADVERB),
  seq(FR_PRE, any("je l' apprendrai", 'je les apprendrai', "je l' acquerrai"), FR_ADVERB),
];
const FR_NEUTRAL = [
  seq(opt(oneOf('mais et')), "j' apprends", opt('très'), oneOf('vite rapidement')),
  seq(opt(oneOf('mais et')), "je m' adapte", oneOf('vite rapidement facilement')),
  seq(opt(oneOf('mais et')), FR_FRAME, any('apprendre', 'me former', 'combler cette lacune', 'combler la lacune')),
  seq(opt(oneOf('et')), opt(oneOf('à pour')), oneOf('aider soutenir'), any('votre équipe', 'vos équipes', 'vos clients', 'votre entreprise')),
  seq(opt(oneOf('et')), opt(oneOf('à pour')), any('contribuer à votre équipe', 'contribuer au succès de votre équipe')),
  oneOf('cependant toutefois néanmoins pourtant'),
];

// ---------------------------------------------------------------------------
// The sentence, closed
// ---------------------------------------------------------------------------

// Where the pieces of a sentence meet: a comma, a dash, a semicolon or a colon (all read as `,`), or a coordinator.
const COORDINATORS = new Set(list(`and but or e ed ma però eppure o oppure und aber doch jedoch sondern oder et mais ou`));
const isBoundary = (norm) => norm === ',' || COORDINATORS.has(bare(norm));
const GAP_TEMPLATES = [...EN_INTENT, ...IT_INTENT, ...DE_INTENT, ...FR_INTENT, ...EN_LACK, ...IT_LACK, ...DE_LACK, ...FR_LACK];
// The pieces that may stand next to a gap: a pronoun that learns the tool, a neutral clause.
const OTHER_TEMPLATES = [...EN_PRONOUN, ...IT_PRONOUN, ...DE_PRONOUN, ...FR_PRONOUN, ...EN_NEUTRAL, ...IT_NEUTRAL, ...DE_NEUTRAL, ...FR_NEUTRAL];
const TEMPLATES = [...GAP_TEMPLATES, ...OTHER_TEMPLATES];

/**
 * Where a node can end when it starts at a token, for one sentence. Memoised per node and position: the
 * noun phrase every template holds is read once per position. A repetition takes one token at least
 * each time, so every node ends after a bounded number of steps.
 */
function matcher(tokens) {
  const memo = new Map();
  const ends = (node, start) => {
    let table = memo.get(node);
    if (!table) {
      table = new Map();
      memo.set(node, table);
    }
    const known = table.get(start);
    if (known) return known;
    let found;
    if (node.type === 'token') {
      found = start < tokens.length && node.test(tokens[start].norm) ? [start + 1] : [];
    } else if (node.type === 'seq') {
      let current = [start];
      for (const item of node.items) {
        const next = new Set();
        for (const at of current) for (const end of ends(item, at)) next.add(end);
        current = [...next];
        if (!current.length) break;
      }
      found = current;
    } else if (node.type === 'any') {
      const all = new Set();
      for (const item of node.items) for (const end of ends(item, start)) all.add(end);
      found = [...all];
    } else {
      const all = new Set(node.min === 0 ? [start] : []);
      let current = new Set([start]);
      for (let count = 1; count <= node.max && current.size; count += 1) {
        const next = new Set();
        for (const at of current) for (const end of ends(node.item, at)) if (end > at) next.add(end);
        if (count >= node.min) for (const end of next) all.add(end);
        current = next;
      }
      found = [...all];
    }
    table.set(start, found);
    return found;
  };
  return ends;
}

/** Whether a sentence splits, at its boundaries, into templates only. */
function closed(tokens) {
  const ends = matcher(tokens);
  const n = tokens.length;
  const skip = (position) => {
    let at = position;
    while (at < n && isBoundary(tokens[at].norm)) at += 1;
    return at;
  };
  const first = skip(0);
  if (first === n) return false;
  const seen = new Set();
  const stack = [first];
  while (stack.length) {
    const at = stack.pop();
    if (seen.has(at)) continue;
    seen.add(at);
    const pieceEnds = new Set();
    for (const template of TEMPLATES) for (const end of ends(template, at)) if (end > at) pieceEnds.add(end);
    for (const end of pieceEnds) {
      if (end === n) return true;
      if (!isBoundary(tokens[end].norm)) continue;
      const next = skip(end);
      if (next === n) return true;
      stack.push(next);
    }
  }
  return false;
}

// A sentence ends at . ! ? … before a capital, a digit or the end of the text, or at an empty line. Not before a
// lowercase word ("…, which I used", "! after all"), not at the dot of an abbreviation ("d. h.", "e.g.", "z.B.",
// "bzw."), and a single line break inside a paragraph is a space ("…,\nbut I used it daily").
const SENTENCE_END_RE = /[.!?…]+(?=\s|$)|\n[^\S\n]*\n/g;
const ABBREVIATIONS = new Set(list(`bzw ca etc ecc usw evtl ggf inkl vgl resp sog dr prof sig dott nr st mio mrd vs cf es ex`));
function sentences(text) {
  const spans = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END_RE)) {
    if (!match[0].startsWith('\n')) {
      const after = /^\s*(\S)/u.exec(text.slice(match.index + match[0].length))?.[1] || '';
      if (/[\p{Ll},;:]/u.test(after)) continue;
      if (after && /^\.+$/.test(match[0])) {
        const word = /(\p{L}+)$/u.exec(text.slice(Math.max(start, match.index - 12), match.index))?.[1] || '';
        if (word.length === 1 || ABBREVIATIONS.has(word.toLowerCase())) continue;
      }
    }
    spans.push([start, match.index]);
    start = match.index + match[0].length;
  }
  spans.push([start, text.length]);
  return spans;
}
// Elided articles and pronouns are tokens of their own ("l'esperienza", "dell'hotel", "j'aimerais"); a word
// keeps its inner hyphen, slash, dot and apostrophe ("SAP-Kenntnisse", "S/4HANA", "hotel's"), and a hyphen
// it ends on ("LQA- und Forbes-Standards"). A dash, a semicolon or a colon separates like a comma.
const TOKEN_RE = /(?<![\p{L}\p{N}])(?:l|d|j|n|m|t|s|c|qu|dell|all|nell|sull|dall|coll|un|quest|quell|nessun|jusqu|lorsqu|puisqu|quoiqu)['’](?=\p{L})|[\p{L}\p{N}]+(?:[-'’/.][\p{L}\p{N}]+)*-?|[,;:–—]|[^\s\p{L}\p{N}]/giu;
// Past these sizes a sentence gets no exemption: a gap is said in a short sentence.
const MAX_TOKENS = 80;
const MAX_CHARS = 1200;

/** The tokens of one sentence, each with the tools (claims, sorted) it holds. */
function readSentence(text, start, end, claims) {
  const tokens = [];
  let next = 0;
  for (const match of text.slice(start, end).matchAll(TOKEN_RE)) {
    const from = start + match.index;
    const to = from + match[0].length;
    const raw = match[0].replace(/’/g, "'");
    const low = raw.toLowerCase();
    while (next < claims.length && claims[next].index + claims[next].length <= from) next += 1;
    const tools = [];
    for (let at = next; at < claims.length && claims[at].index < to; at += 1) tools.push(claims[at]);
    let norm = low;
    if (tools.length) {
      // The tool's letters become §; a word glued after it stays ("SAP-Kenntnisse" → "§-kenntnisse"), and so
      // does one glued before it, which makes the token no tool head ("non-SAP" → "non-§").
      const head = Math.max(0, tools[0].index - from);
      const tail = Math.min(raw.length, Math.max(...tools.map((claim) => claim.index + claim.length)) - from);
      norm = `${low.slice(0, head)}§${low.slice(tail)}`;
    } else if (/^[,;:–—]$/.test(raw)) {
      norm = ',';
    } else if (!/^[\p{L}\p{N}]/u.test(raw)) {
      norm = '¦';
    } else {
      const tags = `${DETERMINER_SET.has(low) ? 'D' : ''}${MODIFIER_SET.has(low) ? 'M' : ''}${GENERIC_SET.has(low) ? 'H' : ''}`;
      norm = `${tags ? `${tags}:` : ''}${/^\p{Lu}/u.test(raw) && !FUNCTION_WORDS.has(low) ? '^' : ''}${low}`;
    }
    tokens.push({ raw, low, norm, tools });
    if (tokens.length > MAX_TOKENS) break;
  }
  return tokens;
}

/** The claim indexes of one sentence that are a gap: all of its tools when the sentence is closed, else none. */
function gapsOfSentence(text, start, end, claims) {
  const inside = claims.filter((claim) => claim.index >= start && claim.index < end);
  if (!inside.length || end - start > MAX_CHARS) return new Set();
  const tokens = readSentence(text, start, end, inside);
  if (tokens.length > MAX_TOKENS || !closed(tokens)) return new Set();
  return new Set(inside.map((claim) => claim.index));
}

/**
 * Whether a tool of a text is said as an honest gap.
 * @param {string} text the generated text
 * @param {Array<{index:number, length:number}>} claims every tool of the text (claimTokens)
 * @returns {(claim: {index:number}) => boolean}
 */
export function gapReader(text, claims) {
  const source = String(text || '');
  const spans = sentences(source);
  const sorted = [...claims].sort((left, right) => left.index - right.index);
  const read = new Map();
  return (claim) => {
    const sentence = spans.find(([from, to]) => claim.index >= from && claim.index < to);
    if (!sentence) return false;
    if (!read.has(sentence[0])) read.set(sentence[0], gapsOfSentence(source, sentence[0], sentence[1], sorted));
    return read.get(sentence[0]).has(claim.index);
  };
}
