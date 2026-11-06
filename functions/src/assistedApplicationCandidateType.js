/**
 * Which application this is, decided in code (study 2026-10-02,
 * report-cv-lettera §4): the CV and the letter follow the template of the
 * type, the way the Swiss career services (SDBB/CSFO) and SECO describe them.
 *   apprentice  the posting offers an apprenticeship (Lehrstelle, apprendistato,
 *               place d'apprentissage): school, taster placements, aptitude
 *               tests, interests and references; no professional summary;
 *   first_job   no job of the candidate yet, only placements, side jobs or
 *               volunteering: education before experience;
 *   qualified   everything else.
 * The sector (health, IT) only adds the sections such CVs need
 * (recognition of the diploma, projects).
 */

const BEFORE = String.raw`(?<![\p{L}])`;
const AFTER = String.raw`(?![\p{L}])`;
// In Italy a «tirocinio formativo / curriculare / extracurriculare / non curriculare» is an internship.
const INTERNSHIP_KIND = String.raw`\s+(?:formativ|curric|extra[\s-]?curric|non[\s-]?curric)`;
// Who an apprenticeship looks for, or the place it offers, in the singular or with a gender mark. A title
// may say it in the plural («Lehrstellen 2027»); in the text the plural is what a company does every year
// or who a job is about («bieten jedes Jahr zwölf Lehrstellen an», «nous formons des apprenti·e·s»,
// «Betreuung der Lernenden»). «Lernende» alone is both, so it counts only when it opens the title.
const trainee = (plural) => String.raw`lehrstelle${plural ? 'n?' : ''}|lernende(?:r|[/:*_]-?[rn]|\([rn]\))|lehrling|place d['’]apprentissage|apprenti${plural ? '' : String.raw`(?![·.\-/]?e?[·.\-/]?s(?![\p{L}])|\(e\)s(?![\p{L}]))`}(?:[·.\-/]?e|\(e\))?|apprendista|post${plural ? '[oi]' : 'o'} di tirocinio(?!${INTERNSHIP_KIND})`;
// Words that also name a training already done or asked for («abgeschlossene Lehre als Kauffrau», «CFC
// obtenu par apprentissage»): in the title unless a done word goes with them (doneInTitle), in the text
// only as what a verb offers (offersTraining).
const TRAINING = String.raw`berufslehre|lehre als|apprentissage|apprendistato|apprenticeship`;
const OFFER_IN_TITLE = new RegExp(`${BEFORE}(?:${trainee(true)})${AFTER}`, 'iu');
const TRAINING_IN_TITLE = new RegExp(`${BEFORE}(?:${TRAINING}|apprenticeships)${AFTER}`, 'giu');
const OFFER_IN_TEXT = new RegExp(`${BEFORE}(?:${trainee(false)})${AFTER}`, 'iu');
// A training done, and the words that ask for one («mit abgeschlossener Berufslehre», «après l'apprentissage»).
const DONE = String.raw`(?:abgeschlossen|absolviert|beendet)(?:e[mnrs]?)?|(?:conclus|terminat|completat|finit)[oaie]|(?:terminé|obtenu|achevé|réussi|complété)e?s?|completed|finished`;
const WITH = String.raw`nach|mit|après|avec|dopo|con|after|with`;
const DONE_OR_WITH = new RegExp(String.raw`^(?:${DONE}|${WITH})$`, 'iu');
const DONE_AFTER = new RegExp(String.raw`${BEFORE}(?:${DONE})${AFTER}`, 'iu');
const TITLE_SEPARATOR = /[,;:.!?()[\]|–—]|\s-\s/;
// The training offered: the object of a verb of offering, with at most a pronoun, an article and adjectives
// between («Wir bieten dir eine dreijährige Berufslehre», «Offriamo un tirocinio triennale», «Nous proposons
// un apprentissage»); never a training named after another word («Wir bieten Absolventen einer
// Berufslehre…», «… im Anschluss an Ihre Berufslehre», «… ayant terminé leur apprentissage»), nor the places
// a company offers every year («offre ogni anno posti di tirocinio», «des places d'apprentissage»).
const OFFER_VERB = String.raw`bieten|bietet|anbieten|vergeben|vergibt|offriamo|offre|offrono|proponiamo|propone|offrons|offrent|proposons|proposent|offer|offers|offering`;
const PRONOUN = String.raw`wir|dir|dich|ihnen|euch|you`;
// The object's article; never a German genitive or dative («Absolventen einer Berufslehre»).
const ARTICLE = String.raw`ein|eine|einen|die|den|das|un|uno|una|une|il|lo|la|le|a|an|the`;
// When the offer starts, from a closed list: «ab August 2027», «ab sofort», «per 1. August», «dal 1° settembre»,
// «da agosto 2027», «dès août 2027», «à partir de septembre», «from August 2027», «starting in August».
const MONTH = String.raw`januar|februar|m(?:ä|ae)rz|april|mai|juni|juli|august|september|oktober|november|dezember|sommer|herbst|fr(?:ü|ue)hling|winter|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|estate|autunno|primavera|inverno|janvier|f[ée]vrier|mars|avril|juin|juillet|ao[uû]t|septembre|octobre|d[ée]cembre|[ée]t[ée]|automne|printemps|hiver|rentr[ée]e|january|february|march|may|june|july|october|december|summer|autumn|fall|spring`;
const DAY = String.raw`\d{1,2}(?!\d)(?:\.|°|º|er|st|nd|rd|th)?`;
const DATE = String.raw`(?:(?:la|le|the)\s+|l['’])?(?:${DAY}\s*)?(?:${MONTH})${AFTER}(?:\s+${DAY})?(?:,?\s+(?:19|20)\d\d)?|${DAY}\s*\d{1,2}\.(?:\s*(?:19|20)\d\d)?|(?:19|20)\d\d`;
const TIME = String.raw`(?:(?:ab|per|im|zum|auf|da|dal|dalla|a\s+partire\s+(?:da|dal|dalla)|dès|à\s+partir\s+(?:de|du)|en|pour|from|starting(?:\s+(?:in|on|from))?|as\s+of|in)\s+|(?:dall|a\s+partire\s+dall|à\s+partir\s+d)['’]\s*)(?:sofort|subito|maintenant|now|immediately|${DATE})${AFTER}`;
// Whom it is offered to, one noun phrase before the object: «Schulabgängern», «jungen Menschen», «motivierten
// Jugendlichen», «ai giovani», «a giovani motivati», «aux jeunes», «à des jeunes», «young people», «school
// leavers», «a motivated young person».
const DE_YOUNG = String.raw`\p{L}*schulabg(?:ä|ae)nger\p{L}*|jugendlichen?|\p{L}*sch(?:ü|ue)ler\p{L}*`;
const BENEFICIARY = [
  String.raw`(?:den\s+)?(?:\p{L}+en\s+){0,2}(?:${DE_YOUNG}|menschen)(?:\s+(?:und|oder)\s+(?:${DE_YOUNG}))?`,
  String.raw`(?:ai|agli|alle|a)\s+(?:\p{L}+\s+)?(?:giovani|ragazz[ei]|studenti|studentesse|allievi|allieve)(?:\s+[\p{L}·-]+)?`,
  String.raw`(?:aux|à\s+(?:des|un|une))\s+(?:\p{L}+\s+)?(?:jeunes?|[ée]l[èe]ves?|adolescent(?:e)?s?|[ée]tudiant(?:e)?s?)(?:\s+[\p{L}·-]+)?`,
  String.raw`(?:(?:a|an)\s+)?(?:\p{L}+\s+){0,2}(?:young\s+(?:people|persons?|adults?)|school\s+leavers?|students?|pupils?|teenagers?)`,
].join('|');
const offerOf = (training) => new RegExp(String.raw`${BEFORE}(?:${OFFER_VERB})(?:\s+(?:${PRONOUN})${AFTER}){0,2}(?:\s*,?\s+${TIME},?)?(?:\s+(?<beneficiary>${BENEFICIARY})${AFTER})?(?:\s*,?\s+${TIME},?)?(?:\s+(?:${ARTICLE})${AFTER}|\s+(?:l|un)['’])?(?<adjectives>(?:(?:\s+|(?<=['’]))[\p{L}\p{N}-]+){0,2})(?:\s+|(?<=['’]))(?:${training})${AFTER}`, 'giu');
// An adjective starts in lower case in the four languages, unlike a German noun (checked without the
// case-insensitive flag, which folds \p{Ll} into upper case too), and is no done, «with», plural, article or
// preposition word: those start another phrase («students of an apprenticeship»).
const ADJECTIVE = /^[\p{Ll}\p{N}][\p{L}\p{N}-]*$/u;
const NOT_ADJECTIVE = new RegExp(String.raw`^(?:${DONE}|${WITH}|posti|places|des|dei|degli|delle|mehrere|verschiedene|zahlreiche|diverse|diversi|plusieurs|several|various|ein|eine[mnrs]?|der|die|das|den|dem|un|uno|una|une|il|lo|la|le|les|l|i|gli|a|an|the|of|di|de|du|von|vom|zum|zur|im|in|nel|nella|al|alla|au|aux|à|für|for|per|pour|par|by|da|dal|dalla|dès|ab|from)$`, 'iu');
const TRAINING_OFFERED = offerOf(TRAINING);
const LERNENDE_FIRST = /^[^\p{L}]*lernende(?![\p{L}])/iu;
// In Ticino «tirocinio» is the apprenticeship; alone it is told from an internship by the diploma (AFC, CFP).
const TIROCINIO_IN_TITLE = new RegExp(`${BEFORE}tirocinio${AFTER}(?!${INTERNSHIP_KIND})`, 'giu');
const TIROCINIO_OFFERED = offerOf(String.raw`tirocinio(?!${INTERNSHIP_KIND})`);
const TICINO_DIPLOMA = /(?<![\p{L}\p{N}])(?:AFC|CFP)(?![\p{L}\p{N}])/u;
// The federal diplomas an apprenticeship leads to. In a title they are also a qualification asked of an
// adult («Informatiker EFZ Systemtechnik 100%»), so alone they say nothing.
const DIPLOMA = /(?<![\p{L}\p{N}])(?:EFZ|EBA|AFC|CFP|CFC|AFP)(?![\p{L}\p{N}])/u;
// Never an apprenticeship: a traineeship or an internship, and a job that trains or leads apprentices
// («Leiter/in Berufslehre», «Responsable de l'apprentissage»); not the training company that offers the
// place («Apprenti·e … – entreprise formatrice»).
const NOT_AN_APPRENTICESHIP = new RegExp(`${BEFORE}(?:trainee|praktikum|praktika|praktikant\\p{L}*|stage|stagiaire|stagist[ae]|internship|tirocinio${INTERNSHIP_KIND}\\p{L}*|berufsbildner\\p{L}*|ausbild(?:n)?er\\p{L}*|lehrmeister\\p{L}*|leiter(?:in)?|verantwortlich\\p{L}*|betreuer\\p{L}*|responsable|responsabile|(?<!(?:entreprise|azienda)\\s+)(?:formateur|formatrice|formatore)|ma[iî]tres?|coordinat\\p{L}*|koordinator\\p{L}*|manager|trainer\\p{L}*|tutor\\p{L}*)${AFTER}`, 'iu');
const HEALTH = /\b(?:pflege\w*|fage|fachfrau gesundheit|fachmann gesundheit|mpa\b|infermier\w*|infirmi\w*|oss\b|assc\b|ospedal\w*|spital\w*|hôpital|clinic\w*|klinik\w*|medizin\w*|médic\w*|medic\w*|nurs\w*|hebamme|sage-femme|ostetric\w*|physiotherap\w*|fisioterap\w*)/i;
// "IT" alone only in capitals: case-insensitive it would read the English and Italian word.
const IT_ACRONYM = /\bIT\b/;
const IT = /\b(?:informatik\w*|informatic\w*|informaticien\w*|software|entwickl\w*|sviluppat\w*|développeu\w*|developer|devops|ict\b|it-|data engineer|full-?stack|front-?end|back-?end|applikationsentwicklung|plattformentwicklung)/i;

const NOT_A_JOB = new Set(['internship', 'trial_apprenticeship', 'side_job', 'volunteer']);

/**
 * Whether the title names the training as one done or asked for: a done word or «mit/con/avec/with»
 * among the two words before it, or a done word after it in the same part («Sachbearbeiter/in mit
 * abgeschlossener Berufslehre», «CFC obtenu par apprentissage», «con apprendistato concluso»).
 * «mit Berufsmaturität» after it is what the apprenticeship comes with.
 */
function doneInTitle(title, start, end) {
  const before = title.slice(0, start).split(TITLE_SEPARATOR).pop().split(/[\s'’]+/).filter(Boolean).slice(-2);
  return before.some((word) => DONE_OR_WITH.test(word)) || DONE_AFTER.test(title.slice(end).split(TITLE_SEPARATOR)[0]);
}

function trainingInTitle(title, pattern) {
  return [...title.matchAll(pattern)].some((match) => !doneInTitle(title, match.index, match.index + match[0].length));
}

function offersTraining(text, pattern) {
  return [...text.matchAll(pattern)].some(({ groups }) => groups.adjectives.split(/[\s'’]+/).filter(Boolean)
    .every((word) => ADJECTIVE.test(word) && !NOT_ADJECTIVE.test(word))
    && !String(groups.beneficiary || '').split(/\s+/).some((word) => DONE_OR_WITH.test(word)));
}

/**
 * An apprenticeship only when the title offers one, or when the title carries a
 * federal diploma, the text offers the place and the candidate has no job yet
 * (verification of 2026-10-03: «Sachbearbeiter/in 80%» with «Betreuung der
 * Lernenden», «Trainee Position», «tirocinio formativo» were all read as one).
 * The apprentice CV and letter are those of a 14-16 year old.
 * @param {{profile?:object, postingTitle?:string, postingText?:string}} input
 * @returns {{type:'apprentice'|'first_job'|'qualified', sector:'health'|'it'|'other'}}
 */
export function candidateType({ profile = {}, postingTitle = '', postingText = '' } = {}) {
  const title = String(postingTitle);
  const text = String(postingText).slice(0, 4000);
  const jobs = (profile.experience || []).filter((role) => !NOT_A_JOB.has(role.kind));
  const ticino = TICINO_DIPLOMA.test(title);
  const offered = OFFER_IN_TITLE.test(title) || LERNENDE_FIRST.test(title) || trainingInTitle(title, TRAINING_IN_TITLE)
    || (ticino && trainingInTitle(title, TIROCINIO_IN_TITLE));
  const named = DIPLOMA.test(title) && jobs.length === 0
    && (OFFER_IN_TEXT.test(text) || offersTraining(text, TRAINING_OFFERED) || (ticino && offersTraining(text, TIROCINIO_OFFERED)));
  const type = !NOT_AN_APPRENTICESHIP.test(title) && (offered || named)
    ? 'apprentice'
    : jobs.length === 0 ? 'first_job' : 'qualified';
  const profileText = [profile.headline, ...(profile.experience || []).map((role) => role.role), ...(profile.education || []).map((item) => item.degree)].join('\n');
  const sector = HEALTH.test(postingTitle) || HEALTH.test(profileText)
    ? 'health'
    : [postingTitle, profileText].some((value) => IT.test(value) || IT_ACRONYM.test(value)) ? 'it' : 'other';
  return { type, sector };
}

/**
 * The type a draft was written for, as a string: the draft keeps `{ type, sector }`
 * (candidateType), a plain string is read too. '' when the draft is older than the types.
 */
export function draftCandidateType(draft) {
  const value = draft?.candidateType;
  return String((typeof value === 'string' ? value : value?.type) || '');
}

// How a title says it is an apprenticeship, around the trade: «Lehrstelle 2027: Informatiker/in EFZ»,
// «Lernende/r Informatiker/in», «Apprentissage d'opérateur·trice», «Kauffrau/Kaufmann EFZ (Lehrstelle 2027)»,
// «Detailhandelsfachfrau EFZ – Lehrstelle 2027», «…, Lehrbeginn August 2027».
const SAID = String.raw`(?:lehrstellen?(?:\s+als)?|berufslehre(?:\s+als)?|lehre als|lernende(?:r|[/:*_]-?[rn]|\([rn]\))?|lehrling|lehrbeginn(?:\s+\p{L}+)?|place d['’]apprentissage|apprentissage|apprenti(?:[·.\-/]?e|\(e\))?|post[oi] di (?:tirocinio(?!${INTERNSHIP_KIND})|apprendistato)|apprendistato|apprendista|tirocinio(?!${INTERNSHIP_KIND})|apprenticeships?)${AFTER}(?:\s+(?:19|20)\d\d)?`;
const SAID_FIRST = new RegExp(String.raw`^(?:${SAID}\s*(?:[/:|–—-]\s*)?)+(?:(?:als|zum/zur|zur/zum|zum|zur|de|di|come|quale|as)\s+|d['’]\s*)?`, 'iu');
const SAID_IN_BRACKETS = new RegExp(String.raw`\s*\(\s*${SAID}\s*\)`, 'giu');
const SAID_LAST = new RegExp(String.raw`\s*(?:[,;:|–—-]\s*)?${BEFORE}(?:(?:en|in)\s+)?${SAID}\s*$`, 'iu');
// The start year is no part of the trade («Kauffrau/Kaufmann EFZ 2027», «… (2027)»).
const YEAR_LAST = /\s*[,;:|–—-]?\s*(?:\(\s*(?:19|20)\d\d\s*\)|(?:19|20)\d\d)$/u;
// What is left is no trade when it still speaks of the apprenticeship, or reads as a phrase
// («Lehrstelle in der Pflege», «… de l'»).
const STILL_SAID = /lehrstell|berufslehre|lehrling|lernend|(?<![\p{L}])lehre(?![\p{L}])|lehrbeginn|apprenti|apprendist|tirocini/iu;
const NOT_A_TRADE = /^(?:in|im|bei|für|mit|ab|per|der|die|das|den|dem|en|dans|chez|pour|au|aux|du|des|le|la|les|un|une|à|presso|nel|nella|nello|al|alla|allo|del|della|il|lo|una|a|at|for|with|the|an)\s|(?:^|\s)(?:als|zum|zur|de|di|da|du|des|la|le|come|quale|as|of|for|the|en|in|et|und|and)$|['’]$/iu;
// The Italian «e» only in lower case: «Profil E» is the commercial profile, not a conjunction.
const AND_LAST = /(?:^|\s)e$/u;

/** The title without the words that say it is an apprenticeship, and whether it had any. */
function tradeOf(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  const without = text.replace(SAID_IN_BRACKETS, ' ').replace(SAID_LAST, '').replace(SAID_FIRST, '');
  const said = without !== text;
  const rest = without.replace(/\s{2,}/g, ' ').replace(YEAR_LAST, '').replace(/^[\s,;:|–—-]+|[\s,;:|–—-]+$/g, '');
  return { said, trade: STILL_SAID.test(rest) || NOT_A_TRADE.test(rest) || AND_LAST.test(rest) ? '' : rest };
}

/**
 * The trade of an apprenticeship title: «Lehrstelle 2027: Informatiker/in EFZ» →
 * «Informatiker/in EFZ». '' when the title does not say it is an apprenticeship,
 * when nothing is left, or when what is left is not the trade alone: the letter's
 * subject then keeps its general form.
 */
export function apprenticeTrade(title) {
  const { said, trade } = tradeOf(title);
  return said ? trade : '';
}

const TARGET = { de: 'Berufswunsch', fr: 'Objectif professionnel', it: 'Obiettivo professionale', en: 'Career goal' };

/**
 * The apprentice's headline: the trade they apply for, said as a goal ("Berufswunsch:
 * Informatiker/in EFZ Applikationsentwicklung"), never as a role they already have.
 */
export function apprenticeHeadline(title, language = 'it') {
  const { trade } = tradeOf(title);
  // French puts a no-break space before the colon.
  return trade ? `${TARGET[language] || TARGET.it}${language === 'fr' ? ' :' : ':'} ${trade}` : '';
}
