/**
 * Che cosa dice un bando comunale ticinese.
 *
 * L'albo di un Comune non e' una bacheca di lavoro. Nella stessa categoria
 * «Concorsi» convivono bandi di assunzione, appalti, locazioni, concorsi
 * fotografici e i formulari di autocertificazione; e molti Comuni ripubblicano
 * per cortesia i bandi di consorzi, associazioni e di altri Comuni. Le quattro
 * domande di questo modulo sono misurate sui bandi veri del 2026-10-31:
 *
 *   classifyNoticeTitle  e' un posto di lavoro, o altro?
 *   roleTitleFromNotice  come si chiama il posto?
 *   resolveNoticeIssuer  chi assume davvero?  (il datore corretto)
 *   extractDeadline      scade quando?        (i concorsi scaduti restano fuori)
 *
 * Tutto puro e senza rete: i test passano testo, non URL.
 */
import { normalizeJobTitle, normalizeSpace, parseMunicipalDate } from './ticino-comuni-job-parser.mjs';

/** Senza scadenza leggibile un bando vale quanto la soglia stale della pipeline. */
export const MAX_NO_DEADLINE_AGE_DAYS = 60;
/** Oltre questa eta' un documento dell'albo non si scarica nemmeno. */
export const MAX_NOTICE_AGE_DAYS = 365;

const ITALIAN_MONTHS = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];
const MONTH_RE = ITALIAN_MONTHS.join('|');

function isoDate(year, month, day) {
  return parseMunicipalDate(`${day}.${month}.${year}`);
}

function foldText(value = '') {
  return normalizeSpace(String(value || ''))
    .replace(/[’‘`´]/g, "'")
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/* ── Tipo di documento ───────────────────────────────────────── */

const FORM_RE = /autocertificaz|questionari|formulari|autorizzazione\s+rilascio|casellario|stato\s+di\s+salute|dati\s+personali|modulo\s+di\s+candidatura/;
const ATTACHMENT_RE = /^(?:capitolato|mansionario|descrizione\s+della\s+funzione)\b|capitolato\s+d['i]\s*oneri|[-–]\s*(?:capitolato|mansionario|descrizione)\b/;
const NOT_A_JOB_RE = new RegExp([
  'opere\\s', 'opere$', 'prestazioni\\s+d', 'fornitura', 'locazione', 'affitto', 'vendita', 'mappale',
  'appalt', 'commesse', 'raccolta\\s+(?:dei\\s+)?rifiuti', 'smaltimento', 'gestione\\s+del\\s+servizio',
  'concorso\\s+di\\s+(?:idee|progett|architettura|disegno|scrittura|fotografia)',
  'concorso\\s+fotografico', 'fotografic', 'balconi', 'fiorit[ao]', 'borse?\\s+di\\s+studio', 'premio\\b',
  'esposizione', 'rapporto\\s+(?:della\\s+)?giuria', 'risultato', 'esito', 'vincitor', 'sondaggio',
  'famiglie\\s+ospitanti', 'volontari', 'piano\\s+regolatore', 'messaggio\\s+municipale',
  'richiesta\\s+di\\s+(?:un\\s+)?credito', 'interpellanza', 'mozione', 'ordinanza',
].join('|'));
const ROLE_RE = new RegExp([
  'operai', 'operatric', 'operator', 'impiegat', 'funzionari', 'collaborator', 'collaboratric',
  'segretari', 'tecnic[oaie]', 'responsabil', 'direttor', 'direttric', 'dirigent', 'capo\\s',
  'animator', 'animatric', 'custod', 'bagnin', 'avventiz', 'pulizi', 'ausiliari', 'cuoc[oa]',
  'educator', 'educatric', 'docent', 'insegnant', 'maestr', 'infermier', 'agent[ei]', 'sergent',
  'giardinier', 'montator', 'cassier', 'cantonier', 'usciere', 'bibliotecari', 'contabil',
  'stagist', 'apprendist', 'assistent', 'architett', 'ingegner', 'comandant', 'personale',
  'addett', 'autist', 'sorvegliant', 'monitor', 'manutentor', 'ispettor', 'lavori\\s+estivi',
].join('|'));
const HIRING_WORD_RE = /assunzion|nomina|incarico|concorso|bando|avviso|cercasi|cerchiamo|posto\s+(?:di|da)|supplent/;

/**
 * @returns {'job'|'attachment'|'form'|'not-a-job'}
 */
export function classifyNoticeTitle(rawTitle = '') {
  const t = foldText(rawTitle);
  if (!t) return 'not-a-job';
  if (FORM_RE.test(t)) return 'form';
  if (NOT_A_JOB_RE.test(t)) return 'not-a-job';
  const namesARole = ROLE_RE.test(t);
  if (ATTACHMENT_RE.test(t)) return namesARole ? 'attachment' : 'not-a-job';
  // Una parola di concorso da sola non basta: «Concorso pubblico» puo' essere un
  // appalto. «Concorso generale/permanente» invece e' sempre di assunzione.
  if (namesARole && HIRING_WORD_RE.test(t)) return 'job';
  if (/concorso\s+(?:generale|permanente)\b/.test(t)) return 'job';
  return 'not-a-job';
}

/* ── Titolo del posto ────────────────────────────────────────── */

const LEADING_NOTICE_RE = new RegExp(
  '^(?:(?:avviso\\s+di\\s+pubblicazione|avviso|bando|capitolato|mansionario)\\s+(?:di\\s+|del\\s+|al\\s+)?)?'
  + 'concorso(?:\\s+(?:pubblico|generale|permanente|interno))*'
  + '(?:\\s+\\d{4}(?:\\s*/\\s*\\d{2,4})?)?\\s*[-–:]?\\s*',
  'i',
);
const LEADING_PURPOSE_RE = /^(?:per\s+)?(?:l['’]\s*|la\s+|il\s+|un\s+)?(?:assunzione|nomina|incarico(?:\s+al\s+\d+\s*%)?\s+(?:di|per|quale)|posto\s+d[ai])\b[\s,]*(?:a\s+titolo\s+di\s+incarico\s*,?\s*)?(?:ad?\s+incarico\s+)?(?:(?:di|da|quale|come)\s+)?/i;
const TRAILING_NOTICE_RE = /\s*[-–]\s*(?:bando|capitolato(?:\s+d['’]oneri)?|avviso|mansionario|descrizione(?:\s+della\s+funzione)?)\s*$/i;
const LEADING_COUNT_RE = /^(?:(?:una?|due|tre|quattro|cinque|alcun[ei])\/?(?:\s*\/\s*una?)?|un\/una|una\/un|un\/a|un-a)\s+/i;

export function roleTitleFromNotice(rawTitle = '') {
  let t = normalizeSpace(rawTitle).replace(TRAILING_NOTICE_RE, '');
  t = t.replace(LEADING_NOTICE_RE, '');
  t = t.replace(/^(?:per\s+)?incarico\b/i, (m) => (/per/i.test(m) ? 'Incarico' : m));
  t = t.replace(LEADING_PURPOSE_RE, '');
  t = t.replace(LEADING_COUNT_RE, '');
  t = t.replace(/^[-–:,\s]+/, '').replace(/[-–:,\s]+$/, '');
  // «Concorso permanente Istituti sociali» non nomina un ruolo: togliendo
  // «Concorso» resterebbe il nome di un ente, non un posto di lavoro.
  if (!ROLE_RE.test(foldText(t))) return normalizeSpace(rawTitle).replace(TRAILING_NOTICE_RE, '');
  return normalizeJobTitle(t);
}

/* ── Chi assume ──────────────────────────────────────────────── */

const ISSUER_SENTENCE_RE = new RegExp(
  '(?:^|[\\s.:])(?:il|i|la|l\'|le|lo)\\s*'
  + '(municipi[oi]\\b.{0,70}?|delegazione\\b.{0,90}?|consorzio\\b.{0,90}?|associazione\\b.{0,90}?'
  + '|fondazione\\b.{0,90}?|comitato\\b.{0,90}?|consiglio\\s+(?:direttivo|di\\s+amministrazione|di\\s+fondazione)\\b.{0,90}?'
  + '|direzione\\b.{0,90}?|cooperativa\\b.{0,90}?|ente\\b.{0,90}?)'
  + '\\s*,?\\s+(?:apre|aprono|indice|indicono|bandisce|bandiscono|comunica|comunicano|pubblica|mette|mettono'
  + '|e\\s+alla\\s+ricerca|sono\\s+alla\\s+ricerca|cerca|ricerca|intende\\s+assumere|rende\\s+noto|avvisa)\\b',
);
const FOREIGN_TITLE_RE = /\bcdaled\b|\bcsbvm\b|\bconsorzi[oa]\b|\bconsortile\b|\bprotezione\s+civile\b|\bpci\b|\bassociazione\b|\bfondazione\b|\bautorita\s+regionale\b|\barp\b|\bpatriziato\b|\bparrocchia\b|\bnido\s+d'infanzia\b|\bcoop(?:erativa)?\b|\bsa\b|\bsagl\b/;

function issuerAliases(entry) {
  return [entry.municipality, ...(entry.issuerAliases || [])].map(foldText).filter(Boolean);
}

function namesMunicipality(text, entry) {
  return issuerAliases(entry).some((name) => text.includes(name));
}

/**
 * Un Comune ripubblica sul proprio albo bandi che non sono suoi. Il datore e'
 * chi firma la frase d'apertura del bando: se e' un altro ente, l'annuncio non
 * entra in questo crawler (attribuirlo al Comune sarebbe un datore sbagliato).
 *
 * @param {{ title?: string, text?: string, entry: { municipality: string, issuerAliases?: string[] } }} args
 * @returns {{ own: boolean, issuer: string, reason: string }}
 */
export function resolveNoticeIssuer({ title = '', text = '', entry }) {
  const body = foldText(text);
  const sentence = ISSUER_SENTENCE_RE.exec(body);
  if (sentence) {
    const issuer = normalizeSpace(sentence[1]);
    if (/^municipi/.test(issuer)) {
      // «Il Municipio di X apre»: X decide. «I Municipi di A, B e C» e' un bando
      // intercomunale: e' di questo Comune solo se lo nomina.
      const named = /\bdi\s+\S/.test(issuer);
      if (!named) {
        return namesMunicipality(body, entry)
          ? { own: true, issuer, reason: 'municipio-senza-nome-comune-citato' }
          : { own: false, issuer, reason: 'municipio-di-altro-comune' };
      }
      const own = namesMunicipality(issuer, entry);
      return { own, issuer, reason: own ? 'municipio-del-comune' : 'municipio-di-altro-comune' };
    }
    return { own: false, issuer, reason: 'altro-ente' };
  }
  if (FOREIGN_TITLE_RE.test(foldText(title))) {
    return { own: false, issuer: '', reason: 'altro-ente-nel-titolo' };
  }
  return namesMunicipality(body, entry)
    ? { own: true, issuer: '', reason: 'comune-citato-nel-testo' }
    : { own: false, issuer: '', reason: 'emittente-non-verificato' };
}

/* ── Date del testo ──────────────────────────────────────────── */

const DATE_IN_TEXT = new RegExp(
  `\\b(\\d{1,2})\\s*[.°º]?\\s*(${MONTH_RE})(?:\\s+(\\d{4}))?\\b`
  + '|\\b(\\d{1,2})[./](\\d{1,2})[./](\\d{4}|\\d{2})\\b',
  'gi',
);

function parseTextDate(match, fallbackYear) {
  if (match[2]) {
    const month = ITALIAN_MONTHS.indexOf(match[2].toLowerCase()) + 1;
    const year = match[3] || fallbackYear;
    return year ? isoDate(year, month, match[1]) : '';
  }
  return parseMunicipalDate(`${match[4]}.${match[5]}.${match[6]}`);
}

const DEADLINE_ANCHOR_RE = /\b(?:entro|scadenza|termine|scade|pervenire|inoltrat[ei]|presentat[ei])\b/gi;
const DEADLINE_WINDOW = 170;
// Tra l'ancora e la data non deve esserci un'altra frase, ne' l'inizio del lavoro.
const DEADLINE_BLOCKER_RE = /\b(?:entrata|entrare|inizio|funzione\s+prevista|contratto|nat[oa]\s+il)\b/i;

/**
 * La scadenza scritta nel bando, in ISO, o ''. Una data precedente alla
 * pubblicazione non e' la scadenza (es. una risoluzione municipale citata).
 *
 * @param {string} text
 * @param {{ publishedIso?: string }} [options]
 */
export function extractDeadline(text = '', { publishedIso = '' } = {}) {
  const body = normalizeSpace(text);
  const fallbackYear = publishedIso ? publishedIso.slice(0, 4) : '';
  for (const anchor of body.matchAll(DEADLINE_ANCHOR_RE)) {
    const start = anchor.index + anchor[0].length;
    const window = body.slice(start, start + DEADLINE_WINDOW);
    for (const match of window.matchAll(DATE_IN_TEXT)) {
      if (DEADLINE_BLOCKER_RE.test(window.slice(0, match.index))) break;
      const iso = parseTextDate(match, fallbackYear);
      if (!iso) continue;
      if (publishedIso && iso < publishedIso) continue;
      return iso;
    }
  }
  return '';
}

/**
 * La data scritta in testa al bando («Massagno, 5 febbraio 2026») o nella
 * formula di pubblicazione, per le pagine che non mostrano la data di albo.
 */
export function extractNoticeDate(text = '') {
  const body = normalizeSpace(text);
  const published = /pubblicazione[^.]{0,80}?(?:dal|il)\s+(\d{1,2})\s*[.°º]?\s*([a-z]+)\s+(\d{4})/i.exec(body);
  if (published) {
    const month = ITALIAN_MONTHS.indexOf(published[2].toLowerCase()) + 1;
    if (month > 0) return isoDate(published[3], month, published[1]);
  }
  const head = body.slice(0, 300);
  for (const match of head.matchAll(DATE_IN_TEXT)) {
    // Solo la forma «5 febbraio 2026»: un numerico in testa e' un riferimento.
    if (!match[2] || !match[3]) continue;
    const iso = parseTextDate(match, '');
    if (iso) return iso;
  }
  return '';
}

/* ── Scaduto? ────────────────────────────────────────────────── */

function ageInDays(iso, now) {
  const then = Date.parse(`${iso}T00:00:00Z`);
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  return (today - then) / 86_400_000;
}

export function isTooOldToOpen(listingIso, now = new Date()) {
  return Boolean(listingIso) && ageInDays(listingIso, now) > MAX_NOTICE_AGE_DAYS;
}

/**
 * Fail-closed: senza una scadenza futura e senza una data di pubblicazione
 * recente non si puo' provare che il concorso sia aperto, quindi resta fuori.
 */
export function isNoticeOpen({ deadline = '', publishedIso = '' }, now = new Date()) {
  if (deadline) return ageInDays(deadline, now) <= 0;
  if (publishedIso) return ageInDays(publishedIso, now) <= MAX_NO_DEADLINE_AGE_DAYS;
  return false;
}

/* ── Bando e allegati ────────────────────────────────────────── */

const SAME_NOTICE_DAYS = 3;

/**
 * Il bando e i suoi allegati (capitolato, mansionario) sono un annuncio solo.
 * Un allegato sopravvive solo se e' l'unico documento di quel concorso, come il
 * capitolato di Ascona, che e' l'unica pubblicazione del posto. Una pagina senza
 * date (Biasca) non permette di appaiarli: li' un bando basta a scartarli.
 *
 * @template {{ title: string, kind: string, date?: string }} T
 * @param {T[]} notices
 * @returns {T[]}
 */
export function dropAttachmentsOfPublishedNotices(notices) {
  const primaries = notices.filter((notice) => notice.kind === 'job');
  const hasPrimaryNearby = (attachment) => primaries.some((primary) => {
    if (!attachment.date || !primary.date) return true;
    const gap = Math.abs(Date.parse(attachment.date) - Date.parse(primary.date)) / 86_400_000;
    return gap <= SAME_NOTICE_DAYS;
  });
  const seenTitles = new Set();
  return notices.filter((notice) => {
    if (notice.kind === 'attachment' && hasPrimaryNearby(notice)) return false;
    const key = foldText(roleTitleFromNotice(notice.title));
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });
}
