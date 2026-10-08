/**
 * A question that only asks whether the candidate holds a document the same
 * application has them upload («Possédez-vous une carte de qualification de
 * conducteur à jour ?», next to that very card among the documents to attach).
 *
 * Owner decision of 2026-10-08, on a real order held twice for one
 * requirement: the question is not asked — the upload is the answer — and
 * where a portal's form asks it, the attached document says «yes».
 *
 * Deliberately narrow. The question is a yes/no one, and its whole content is
 * «do you hold» + the document's own name (its label, or one of the keywords
 * the requirements pass read with it) + words that qualify nothing only the
 * candidate knows («valid», «up to date», an article). A question that names
 * the document and asks more («…valid for category D?», «…with an average
 * above 5?») is not this one: only the candidate can answer it.
 *
 * Pure JavaScript: imported by the functions and by the runner scripts.
 */

/** Lower case, no accents, everything but letters and digits as one space: «Possédez-vous» → «possedez vous». */
const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

const phrases = (text) => text.split('\n').map((line) => fold(line)).filter(Boolean).sort((left, right) => right.length - left.length);

// «Do you hold», in the four languages and both forms of address, already folded.
const HOLDS = phrases(`
possiedi
possiede
hai
ha
sei in possesso
e in possesso
disponi
dispone
sei titolare
e titolare
detieni
detiene
possedez vous
possedes tu
vous possedez
tu possedes
avez vous
as tu
vous avez
tu as
disposez vous
disposes tu
vous disposez
tu disposes
etes vous titulaire
es tu titulaire
etes vous en possession
es tu en possession
detenez vous
detiens tu
besitzen sie
besitzt du
haben sie
hast du
verfugen sie uber
verfugst du uber
sind sie im besitz
bist du im besitz
sind sie inhaber
sind sie inhaberin
bist du inhaber
bist du inhaberin
do you have
do you hold
do you possess
do you own
have you got
are you in possession
are you the holder
are you a holder
`);

// Words that ask nothing more than the document itself shows: articles, possessives, «valid», «up to date»,
// «already», and the «and» between two documents. Never «or»: «a licence or a card?» is not answered by one upload.
const FILLERS = new Set(`
un una uno il lo la l i gli le di del della dello dei delle degli dell gia ancora tuo tua tuoi tue suo sua suoi sue
valido valida validi valide aggiornato aggiornata aggiornati aggiornate attuale attuali attualmente personale in corso validita e ed nonche
une les de d du des deja votre vos ton ta tes valable valables valides a jour actuel actuelle actuels actuelles actuellement
en cours validite personnel personnelle est ce que qu et ainsi
ein eine einen einem einer eines der die das den dem des bereits schon ihr ihre ihren ihrem ihrer ihres dein deine deinen deinem
deiner deines gultig gultige gultigen gultiger gultiges gultigem aktuell aktuelle aktuellen aktueller aktuelles aktuellem derzeit
uber von im und sowie
an the your of already valid current currently up to date personal and
`.split(/\s+/).filter(Boolean));

const YES_RE = /^(?:ja|si|yes|oui|vero|true)$/;
const NO_RE = /^(?:nein|no|non|falso|false)$/;

/** The answer says «yes», in one of the four languages. */
export const saysYes = (value) => YES_RE.test(fold(value));

/**
 * The option that says «yes» of a yes/no choice (its own label), '' for any other list: one «yes», one «no», and
 * at most a prompt besides («Select one»).
 * @param {Array<string|{label?:string}>} options
 */
export function yesOption(options) {
  const labels = (Array.isArray(options) ? options : []).map((option) => String(option?.label ?? option ?? '').trim()).filter(Boolean);
  const yes = labels.filter((label) => YES_RE.test(fold(label)));
  const no = labels.filter((label) => NO_RE.test(fold(label)));
  return yes.length === 1 && no.length === 1 && labels.length <= 3 ? yes[0] : '';
}

/** The names a document goes by, folded: its label (with and without what it holds in brackets) and its keywords. */
function namesOf(document) {
  const label = String(document?.label || '');
  const names = [
    label,
    label.replace(/\([^)]*\)/g, ' '),
    ...[...label.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]),
    ...(Array.isArray(document?.keywords) ? document.keywords : []),
  ];
  return [...new Set(names.map(fold).filter((name) => name.length >= 3))].sort((left, right) => right.length - left.length);
}

const holdsPhrase = (text, phrase) => ` ${text} `.includes(` ${phrase} `);
const withoutPhrase = (text, phrase) => ` ${text} `.split(` ${phrase} `).join(' ').replace(/\s+/g, ' ').trim();

/**
 * The documents a question asks the candidate to hold, when it asks nothing else; [] for every other question.
 * @param {{question?:string, label?:string, type?:string, options?:Array}} question a draft's question, or a form
 *   field read as one
 * @param {Array<{id?:string, label:string, keywords?:string[]}>} documents the documents the candidate uploads
 * @returns {Array<object>} the documents named, as given
 */
export function documentsHeldAsked(question, documents) {
  const yesNo = question?.type === 'yes_no' || Boolean(yesOption(question?.options));
  if (!yesNo) return [];
  let rest = fold(question?.question || question?.label);
  if (!rest) return [];
  const named = [];
  for (const document of Array.isArray(documents) ? documents : []) {
    const names = namesOf(document).filter((name) => holdsPhrase(rest, name));
    if (!names.length) continue;
    named.push(document);
    for (const name of names) rest = withoutPhrase(rest, name);
  }
  if (!named.length) return [];
  const holds = HOLDS.find((phrase) => holdsPhrase(rest, phrase));
  if (!holds) return [];
  rest = withoutPhrase(rest, holds);
  return rest.split(' ').filter((word) => word && !FILLERS.has(word)).length ? [] : named;
}
