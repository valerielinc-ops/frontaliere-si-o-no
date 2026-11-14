/**
 * Is the posting still open? Port of career-ops' liveness-core.mjs (MIT,
 * © Santiago Fernández de Valderrama), extended with the Italian and Swiss
 * German closure banners of the postings this site lists.
 *
 * `classifyLiveness` is career-ops' classifier, unchanged in its decisions:
 * `expired` / `active` / `uncertain`, with a code. `isHardClosed` is ours and
 * deliberately narrower: it drives an AUTOMATIC refund ("the ad closed before
 * we could send it"), so it only accepts the unambiguous codes, or our own
 * dataset having dropped the job while the employer page shows no apply
 * control. An uncertain page never refunds.
 *
 * `checkPostingLiveness` is the gate itself, run by the runner before drafting
 * and again right before submitting, and by the functions before a reminder
 * to a candidate (assistedApplicationAutomation.js): our published active-ID
 * index no longer contains the job (detail files may be retained for historical
 * URLs/SEO) and the employer page, fetched with the SSRF guards of the posting fallback.
 * In the functions' sources so that both can run it; the runner imports it
 * through scripts/assisted-application/lib/liveness.mjs and posting-liveness.mjs.
 */

import { JOB_ACTIVE_IDS_URL, fetchJobPosting, fetchPublicPage, fetchWorkdayPosting, htmlToText } from './assistedApplicationAiJob.js';
import { JOB_ID_RE, MAX_ACTIVE_JOB_INDEX_BYTES, parseActiveJobIdIndex } from './assistedApplicationActiveJobIndex.js';

function normalizeForMatch(text = '') {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[‘’ʼ′´`]/g, "'")
    .replace(/[“”″]/g, '"')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /\b(?:job|jobs|position|role|posting|opening|vacancy|requisition|req|listing)\b[\s\S]{0,60}?(?<!\b(?:application|form)\s)has been filled\b(?!\s+out)/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this (?:job|role|position)(?: listing)? is closed\b(?!-)/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expiree|n'est plus disponible)/i,
  /(cette )?offre n'est plus (disponible|en ligne|active)/i,
  // «(offre|poste|annonce) (déjà) pourvu(e)» is read as a sentence of its own (FILLED_FORMS): anywhere in
  // the text it also matched a line of the other postings a page lists.
  /offre (cloturee|desactivee|terminee)/i,
  /ce poste n'est plus (disponible|a pourvoir|ouvert)/i,
  /recrutement (termine|cloture)/i,
  /candidatures (closes|cloturees)/i,
  // Italian and Swiss German (added for this site's postings).
  /(annuncio|offerta|posizione|posto) (di lavoro )?non (e )?piu (disponibile|attiv[ao]|aperta)/i,
  /(la )?(posizione|ricerca|selezione) (e stata )?(chiusa|conclusa|coperta)/i,
  /(offerta|annuncio) scadut[oa]/i,
  /candidature (chiuse|non piu accettate)/i,
  /(diese )?stelle (ist )?(leider )?nicht mehr (verfugbar|aktiv|ausgeschrieben|online)/i,
  /(stelle|inserat|stellenanzeige|ausschreibung) (ist |wurde )?(bereits )?(abgelaufen|geschlossen|deaktiviert|geloscht)/i,
  /bewerbungsfrist (ist )?abgelaufen/i,
  /die stelle (?:wurde (?:bereits )?besetzt|(?:bereits )?besetzt wurde)/i,
  // A portal's own page for a posting it no longer shows (SuccessFactors, Stadt Zürich 2026-11-10: «Diese
  // Stelle kann zurzeit nicht angezeigt werden. Sie wurde entweder gelöscht, oder man kann sich nicht länger
  // darauf bewerben.»), and the same statement in the other languages: always about this posting, never a
  // sentence an open posting prints.
  // «kann nicht angezeigt werden» alone may be a passing display failure: only with its deletion or
  // no-longer-apply clause is it the closure.
  /(?:kann|konnen) sich nicht (?:mehr|langer) (?:darauf |dafur |auf diese stelle )?bewerben/i,
  /non e piu possibile (?:candidarsi|candidarti|inviare (?:la (?:tua |sua )?)?candidatura)/i,
  /(?:l')?(?:annuncio|offerta) (?:e stat[ao] )?(?:rimoss[ao]|eliminat[ao])\b/i,
  /il n'est plus possible de (?:postuler|candidater)/i,
  /(?:offre|annonce) (?:a ete )?(?:supprimee|retiree)\b/i,
  /\b(?:job|position|role|posting|vacancy|opening|requisition) (?:has been|was|is now) (?:closed|removed|deleted|withdrawn)\b/i,
  /\byou can no longer apply\b/i,
];
const MULTI_SENTENCE_HARD_EXPIRED_PATTERNS = [
  // SuccessFactors can state the closed status across the «not displayed» and «deleted / no longer apply» sentences.
  /diese stelle kann (?:zurzeit|derzeit|momentan|leider) nicht (?:mehr )?angezeigt werden[\s\S]{0,200}?(?:geloscht|nicht (?:mehr|langer) (?:darauf |dafur )?bewerben)/i,
];
const CONDITIONAL_OR_TEMPORAL_CLAUSE = [
  /\b(?:after|before|once|when|if|until|whenever|unless|while|as soon as|as long as|provided that|in case|including after)\b/i,
  /\b(?:nachdem|sobald|wenn|falls|bis|solange)\b/i,
  /\b(?:dopo\s+che|una\s+volta\s+che|quando|finche|fino\s+a\s+quando)\b/i,
  /\b(?:une\s+fois(?:\s+que)?|lorsque|quand|si|apres\s+que|jusqu'a\s+ce\s+que)\b/i,
];
const ITALIAN_SE_CONDITIONAL = /\bse\b/i;
const SUPPORTED_PAGE_LANGUAGES = new Set(['de', 'en', 'fr', 'it']);

function normalizePageLanguage(language = '') {
  const primary = String(language || '').trim().toLowerCase().split(/[-_]/, 1)[0];
  return SUPPORTED_PAGE_LANGUAGES.has(primary) ? primary : '';
}

function pageLanguageFromHtml(html = '') {
  const attributes = /<html\b([^>]*)>/i.exec(String(html || ''))?.[1] || '';
  const match = /\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/i.exec(attributes);
  return normalizePageLanguage(match?.[1] || match?.[2] || match?.[3] || '');
}
const ACCESS_BLOCKED_PATTERNS = [
  /\b(?:your\s+|the\s+)?ip(?:[\s-]?address)?\s+(?:(?:has been|is|was)\s+)?(?:blocked|denied|banned)\b/i,
  /\b(?:il tuo\s+)?indirizzo ip\s+(?:(?:e stato|risulta|e)\s+)?(?:bloccato|negato|vietato)\b/i,
  /\b(?:ihre\s+)?ip-adresse\s+(?:wurde|ist|wird)\s+(?:blockiert|gesperrt)\b/i,
  /\b(?:votre\s+)?adresse ip\s+(?:a ete|est)\s+(?:bloquee|refusee)\b/i,
];

// «The post has been filled», in the forms employers print (Stadt Zürich's own posting page, 2026-11-10:
// «Diese Stelle wurde leider bereits besetzt.», which read as `insufficient_content`). Unlike the banners
// above, the words also occur in an open posting («per sofort zu besetzen», «Stelle neu besetzen») and in
// the other postings a page lists («weitere Stellen … besetzt»), so each form counts only as a sentence of
// its own (filledStatement): the whole sentence is the statement, with nothing but an apology and
// «leider / bereits / già / déjà / already» around it. A form that names the posting («diese Stelle»,
// «this position») is its own; a bare one («Stelle bereits besetzt», «poste pourvu») may be a line of a
// list, and counts only on a page that offers no apply control.
const FILLER = {
  de: '(?:(?:leider|bereits|schon|inzwischen|mittlerweile|nun) )*',
  it: '(?:(?:purtroppo|gia|ormai) )*',
  fr: '(?:(?:malheureusement|deja|desormais) )*',
  en: '(?:(?:unfortunately|already|now) )*',
};
const APOLOGY = {
  de: '(?:(?:es tut uns leid|wir bedauern),? )?',
  it: '(?:(?:ci dispiace|siamo spiacenti),? )?',
  fr: '(?:(?:desolee?s?|nous sommes desole(?:e)?s),? )?',
  en: "(?:(?:sorry|we're sorry|we are sorry),? )?",
};
const FILLED_FORMS = {
  de: {
    named: '(?:diese|die) (?:stelle|position|vakanz)',
    bare: '(?:stelle|position|vakanz)',
    said: (subject, f) => `(?:${subject} (?:(?:ist|wurde) )?${f}|(?:ist|wurde) ${subject} ${f})(?:besetzt|vergeben)(?: worden)?`,
  },
  it: {
    named: '(?:(?:questa|la) (?:posizione|offerta|ricerca)|(?:questo|il) (?:posto|ruolo))',
    bare: '(?:posizione|posto|ruolo)',
    said: (subject, f) => `${subject} (?:(?:e|risulta) )?${f}(?:stat[oa] )?${f}(?:copert|assegnat|occupat)[oa]`,
  },
  fr: {
    named: "(?:(?:ce|le) poste|(?:cette |l')(?:offre|annonce))",
    bare: '(?:poste|offre|annonce)',
    said: (subject, f) => `${subject} (?:(?:a|est) )?${f}(?:ete )?${f}(?:pourvue?|attribuee?)`,
  },
  en: {
    named: '(?:this|the) (?:position|role|job|vacancy|post|opening)',
    bare: '(?:position|role|job|vacancy|opening)',
    said: (subject, f) => `${subject} (?:(?:has|was|is) ${f}(?:been )?${f})?filled`,
  },
};
const filledPatterns = (kind) => Object.entries(FILLED_FORMS)
  .map(([lang, form]) => new RegExp(`^${APOLOGY[lang]}${FILLER[lang]}${form.said(form[kind], FILLER[lang])}$`, 'i'));
const NAMED_FILLED_PATTERNS = filledPatterns('named');
const BARE_FILLED_PATTERNS = filledPatterns('bare');

const LISTING_PAGE_PATTERNS = [/\d+\s+jobs?\s+found/i, /\d+\s+(offerte|stellen|offres) (trovate|gefunden|trouvees)/i];
const SOFT_EXPIRED_PATTERNS = [/\bjob expired\b/i];
const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /performing security verification/i,
  /checking your browser before/i,
  /verify you are (a |not a )?human/i,
  /verifica(?:re)? di essere (?:un )?umano/i,
  /sicherheitsuberprufung[\s\S]{0,80}\b(?:bitte|bestatigen|fortfahren|weiter|erforderlich|mensch|roboter)\b/i,
  /\bbitninja\b[\s\S]{0,100}\b(?:security check|security verification|verification|challenge|captcha|human)\b/i,
  /\b(?:security check|security verification|verification|challenge|captcha|human)[\s\S]{0,100}\bbitninja\b/i,
  /\b(?:complete|solve|enter|pass|verify|confirm|resolve)\s+(?:the\s+)?(?:captcha|recaptcha|hcaptcha|turnstile)\b/i,
  /\b(?:captcha|recaptcha|hcaptcha|turnstile)\b[\s\S]{0,50}\b(?:challenge|required|to continue|please complete|verification required|failed)\b/i,
  /enable javascript and cookies to continue/i,
  /attention required.*cloudflare/i,
  /\bray id\b/i,
  /please complete the security check/i,
];
const EXPIRED_URL_PATTERNS = [/[?&]error=true/i];
const APPLY_PATTERNS = [
  /^applica(?: ora| adesso| subito)?$/i,
  /\bapply\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
  /\bcandidati\b/i,
  /\bcandidarsi\b/i,
  /invia (la )?candidatura/i,
  /jetzt bewerben/i,
  /\bpostulez\b/i,
  // Some legacy employer pages use a neutral native-button value for the
  // application opener («cliccando qui», «click here»). The portal runner
  // still requires a route-bound vacancy before clicking it; liveness only
  // needs to avoid treating the open posting as a page with no apply control.
  /\bclicca(?:ndo)?\s+qui\b/i,
  /\bclick\s+here\b/i,
  /\bcliquez?\s+ici\b/i,
  /\bhier\s+klicken\b/i,
  /\bfare\s+clic\s+qui\b/i,
];
const MIN_CONTENT_CHARS = 300;
const JOB_ID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/gi;

function jobIdToken(url = '') {
  const matches = String(url).match(JOB_ID_TOKEN);
  return matches ? matches[matches.length - 1].toLowerCase() : null;
}

const firstMatch = (patterns, text = '') => patterns.find((pattern) => pattern.test(text));
const hasApplyControl = (controls = []) => controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));

function hasConditionalTemporalPrefix(statement, matchIndex, localeHint = '') {
  const leadIn = statement.slice(0, matchIndex);
  const locale = normalizePageLanguage(localeHint);
  return CONDITIONAL_OR_TEMPORAL_CLAUSE.some((clause) => clause.test(leadIn))
    || (locale === 'it' && ITALIAN_SE_CONDITIONAL.test(leadIn));
}

function firstUnconditionalStatementMatch(patterns, rawText = '', locale = '') {
  if (typeof rawText !== 'string') return undefined;
  const statements = rawText.split(/[\r\n]+|(?<=[.!?;])\s+/);
  for (const rawStatement of statements) {
    const statement = normalizeForMatch(rawStatement).trim();
    if (!statement) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(statement);
      if (!match) continue;
      if (hasConditionalTemporalPrefix(statement, match.index, locale)) continue;
      return pattern;
    }
  }
  return undefined;
}

function firstUnconditionalHardExpiredStatement(rawText = '', locale = '') {
  // A hard-closure phrase in a privacy clause describes a possible later state, not this posting's current state.
  const statementMatch = firstUnconditionalStatementMatch(HARD_EXPIRED_PATTERNS, rawText, locale);
  if (statementMatch) return statementMatch;
  const normalized = normalizeForMatch(rawText);
  for (const pattern of MULTI_SENTENCE_HARD_EXPIRED_PATTERNS) {
    const match = pattern.exec(normalized);
    if (!match) continue;
    const leadIn = normalized.slice(0, match.index).split(/(?<=[.!?;])\s+/).at(-1) || '';
    if (hasConditionalTemporalPrefix(leadIn, leadIn.length, locale)) continue;
    return pattern;
  }
  return undefined;
}

/**
 * The page's own sentences: its lines (htmlToText ends every block with one, innerText too), each split after
 * a full stop, with list bullets, quotes and closing punctuation trimmed. Read before the whitespace is
 * folded, which would join the lines.
 */
function sentencesOf(rawText = '') {
  if (typeof rawText !== 'string') return [];
  return rawText.split(/[\r\n]+|(?<=[.!?;])\s+/)
    .map((sentence) => normalizeForMatch(sentence).trim().replace(/^[-–—•·*>"'«»(\[\s]+|[-–—"'«»)\]\s.!?;:…]+$/g, ''))
    .filter((sentence) => sentence && sentence.length <= 160);
}

/** A sentence of the page that says this post has been filled (FILLED_FORMS), or undefined. */
function filledStatement(rawText, { applyControlVisible = false } = {}) {
  const patterns = applyControlVisible ? NAMED_FILLED_PATTERNS : [...NAMED_FILLED_PATTERNS, ...BARE_FILLED_PATTERNS];
  for (const sentence of sentencesOf(rawText)) {
    const pattern = firstMatch(patterns, sentence);
    if (pattern) return pattern;
  }
  return undefined;
}

/** `locale` is the posting-page language, from its explicit page metadata when available. */
export function classifyLiveness({ status = 0, requestedUrl = '', finalUrl = '', bodyText: rawBodyText = '', applyControls: rawApplyControls = [], locale = '' } = {}) {
  const pageLocale = normalizePageLanguage(locale);
  const bodyText = normalizeForMatch(rawBodyText);
  const applyControls = (Array.isArray(rawApplyControls) ? rawApplyControls : []).map(normalizeForMatch);
  if (status === 404 || status === 410) return { result: 'expired', code: 'http_gone', reason: `HTTP ${status}` };
  if (firstUnconditionalStatementMatch(ACCESS_BLOCKED_PATTERNS, rawBodyText, pageLocale)) return { result: 'uncertain', code: 'runner_ip_blocked', reason: 'IP access blocked' };
  const botChallenge = firstMatch(BOT_CHALLENGE_PATTERNS, bodyText);
  if (botChallenge) return { result: 'uncertain', code: 'bot_challenge', reason: 'anti-bot challenge' };
  if (status === 403 || status === 429 || status === 503) return { result: 'uncertain', code: 'access_blocked', reason: `HTTP ${status}` };
  if (status >= 500) return { result: 'uncertain', code: 'server_error', reason: `HTTP ${status}` };
  if (firstMatch(EXPIRED_URL_PATTERNS, finalUrl)) return { result: 'expired', code: 'expired_url', reason: 'error redirect' };
  const expiredBody = firstUnconditionalHardExpiredStatement(rawBodyText, pageLocale);
  if (expiredBody) return { result: 'expired', code: 'expired_body', reason: `pattern matched: ${expiredBody.source}` };
  const filled = filledStatement(rawBodyText, { applyControlVisible: hasApplyControl(applyControls) });
  if (filled) return { result: 'expired', code: 'expired_body', reason: `posting filled: ${filled.source}` };
  const jobId = jobIdToken(requestedUrl);
  if (jobId && finalUrl && !finalUrl.toLowerCase().includes(jobId)) {
    return { result: 'uncertain', code: 'redirected_off_posting', reason: 'job id missing from final URL' };
  }
  if (hasApplyControl(applyControls)) return { result: 'active', code: 'apply_control_visible', reason: 'visible apply control' };
  if (firstMatch(SOFT_EXPIRED_PATTERNS, bodyText)) return { result: 'expired', code: 'expired_body_soft', reason: 'soft expiry text' };
  if (firstMatch(LISTING_PAGE_PATTERNS, bodyText)) return { result: 'expired', code: 'listing_page', reason: 'redirected to a listing page' };
  if (bodyText.trim().length < MIN_CONTENT_CHARS) return { result: 'expired', code: 'insufficient_content', reason: 'insufficient content' };
  return { result: 'uncertain', code: 'no_apply_control', reason: 'content present but no apply control' };
}

/**
 * A Workday posting, by what Workday's own JSON says of it (fetchWorkdayPosting):
 * its page is an empty shell filled by script, the same for an open posting and
 * for one that is gone, so the page read «expired, insufficient_content» for
 * every Workday posting (a real order, 2026-10-07). Open when it is published
 * and takes applications; closed when Workday says it is not, or that it does
 * not exist. null when the JSON says nothing: the page is then read as before.
 * @param {{gone:boolean, info:object|null}|null} posting
 */
export function classifyWorkdayLiveness(posting) {
  if (!posting) return null;
  if (posting.gone) return { result: 'expired', code: 'ats_api_gone', reason: 'Workday: the posting does not exist, or is listed no more' };
  const { canApply, posted } = posting.info || {};
  if (canApply === true && posted !== false) return { result: 'active', code: 'ats_api_open', reason: 'Workday: published and taking applications' };
  if (canApply === false || posted === false) return { result: 'expired', code: 'ats_api_closed', reason: 'Workday: not published or closed to applications' };
  return null;
}

const HARD_CODES = new Set(['http_gone', 'expired_url', 'expired_body']);
// `insufficient_content` is NOT enough even with the dataset gone: a
// JavaScript-rendered portal (Workday) returns an almost empty HTML shell
// while the posting is still open. Workday's own answer that a posting is gone
// or closed is read from an address this code derives: it refunds only with
// our dataset having dropped the job too.
const CORROBORATED_CODES = new Set(['expired_body_soft', 'listing_page', 'ats_api_gone', 'ats_api_closed']);
// The posting's own word, with no reading of ours in between (postingSaysClosed).
const SAID_CLOSED_CODES = new Set([...HARD_CODES, 'ats_api_gone', 'ats_api_closed']);

/**
 * @param {{result:string, code:string}} page classification of the employer page
 * @param {{datasetGone:boolean}} dataset the published active-ID index omits this job
 */
export function isHardClosed(page, { datasetGone = false } = {}) {
  if (page?.result === 'expired' && HARD_CODES.has(page.code)) return true;
  return datasetGone && page?.result === 'expired' && CORROBORATED_CODES.has(page.code);
}

/**
 * The posting itself says it is closed: its page with an unambiguous code, or its ATS's own answer that it is
 * gone or takes no applications. Wider than isHardClosed, which also wants our dataset to agree before it
 * refunds: this one only stops a reminder to a candidate, for an application that could no longer leave, and
 * tells the owner (owner decision 2026-10-08). Never a page that merely looks empty or blocks the fetch.
 * @param {{page?:{result:string, code:string}, closed?:boolean}} liveness checkPostingLiveness's result
 */
export function postingSaysClosed(liveness) {
  if (liveness?.closed) return true;
  return liveness?.page?.result === 'expired' && SAID_CLOSED_CODES.has(liveness.page.code);
}

/** Visible texts of links/buttons, a cheap stand-in for a rendered DOM. */
export function applyControlsFromHtml(html) {
  const controls = [];
  const re = /<(a|button)\b[^>]*>([\s\S]*?)<\/\1>|<input\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) && controls.length < 400) {
    let text = match[2] ? match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!text && match[3]) {
      const type = /\btype\s*=\s*["']?([^\s"'>]+)/i.exec(match[3])?.[1] || '';
      if (/^(?:button|submit|image)$/i.test(type)) {
        text = /\bvalue\s*=\s*(["'])([\s\S]*?)\1/i.exec(match[3])?.[2]
          || /\bvalue\s*=\s*([^\s"'>]+)/i.exec(match[3])?.[1]
          || '';
      }
    }
    text = String(text).replace(/\s+/g, ' ').trim();
    if (text && text.length <= 80) controls.push(text);
  }
  return controls;
}

const TIMEOUT_MS = 12_000;
const MAX_HTML = 1_500_000;

async function datasetGone(jobId, fetchImpl) {
  const requestedId = String(jobId || '');
  if (!JOB_ID_RE.test(requestedId)) return false;
  try {
    const response = await fetchImpl(JOB_ACTIVE_IDS_URL, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) return false;
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_ACTIVE_JOB_INDEX_BYTES) return false;
    const activeIds = parseActiveJobIdIndex(await response.arrayBuffer());
    if (!activeIds) return false;
    return !activeIds.has(requestedId);
  } catch {
    return false;
  }
}

export async function checkPostingLiveness({ order, posting, fetchImpl = fetch, resolve }) {
  const gone = await datasetGone(order?.jobId, fetchImpl);
  // Check the employer's listing page before its ATS/application endpoint. Some ATS apply URLs
  // are stale or redirect to a generic homepage while the listing itself is still open.
  const url = posting?.postingUrl && !/^mailto:/i.test(posting.postingUrl)
    ? posting.postingUrl
    : posting?.applyUrl && !/^mailto:/i.test(posting.applyUrl) ? posting.applyUrl : order?.jobUrl;
  let page = { result: 'uncertain', code: 'not_checked', reason: 'no public url' };
  // The employer as the posting's own data names it (Workday's legal entity), for the runner's check that the
  // form is the posting's where the page shows only a brand (portal.mjs sameEmployerFamily).
  let organization = '';
  if (url) {
    try {
      // Workday's page is an empty shell (see classifyWorkdayLiveness): its own JSON answers first.
      const posting = await fetchWorkdayPosting(fetchImpl, url, resolve).catch(() => null);
      const workday = classifyWorkdayLiveness(posting);
      organization = String(posting?.organization || '');
      const response = workday ? null : await fetchPublicPage(fetchImpl, url, resolve);
      if (workday) {
        page = workday;
      } else if (response) {
        const html = (await response.text()).slice(0, MAX_HTML);
        page = classifyLiveness({
          status: response.status,
          requestedUrl: url,
          finalUrl: response.url || url,
          bodyText: htmlToText(html),
          applyControls: applyControlsFromHtml(html),
          locale: pageLanguageFromHtml(html),
        });
      } else {
        page = { result: 'uncertain', code: 'not_public', reason: 'url not fetchable' };
      }
    } catch (error) {
      page = { result: 'uncertain', code: 'fetch_failed', reason: error instanceof Error ? error.message.slice(0, 80) : 'fetch failed' };
    }
  }
  return { page, datasetGone: gone, closed: isHardClosed(page, { datasetGone: gone }), organization };
}

/**
 * The address a posting's liveness is read at, for an order with its draft: the posting's own page when the
 * channel is the ATS behind it (Coop: SuccessFactors' sign-in says nothing about the posting being open).
 * The same choice as the runner's check before submitting.
 */
export function postingAddressOf(draft, order = null) {
  return draft?.job?.postingUrl || order?.jobUrl || draft?.channel?.postingUrl || draft?.channel?.applyUrl || draft?.job?.applyUrl || '';
}

/**
 * Resolve a legacy draft's canonical posting page from the same published job detail used to build new drafts.
 * Older orders can have only a stale application endpoint in `order.jobUrl` and no `draft.job.postingUrl`.
 */
export async function resolvePublishedPostingAddressOf(draft, order = null, { fetchImpl = fetch, resolve } = {}) {
  const savedPublishedPostingUrl = String(draft?.job?.publishedPostingUrl || '').trim();
  if (savedPublishedPostingUrl) return savedPublishedPostingUrl;
  const savedPostingUrl = String(draft?.job?.postingUrl || '').trim();
  const savedApplyAddresses = new Set([
    order?.jobUrl,
    draft?.job?.applyUrl,
    draft?.channel?.applyUrl,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  if (savedPostingUrl && !savedApplyAddresses.has(savedPostingUrl)) return savedPostingUrl;
  try {
    const posting = await fetchJobPosting(order, { fetchImpl, resolve });
    if (posting?.publishedPostingUrl) return posting.publishedPostingUrl;
  } catch {
    // The saved order or channel address remains a best-effort fallback.
  }
  return '';
}

export async function resolvePostingAddressOf(draft, order = null, options = {}) {
  const publishedPostingUrl = Object.hasOwn(options, 'publishedPostingUrl')
    ? options.publishedPostingUrl
    : await resolvePublishedPostingAddressOf(draft, order, options);
  if (publishedPostingUrl) return publishedPostingUrl;
  return postingAddressOf(draft, order);
}
