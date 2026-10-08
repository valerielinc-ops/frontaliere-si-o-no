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
 * to a candidate (assistedApplicationAutomation.js): our dataset (the
 * published job-detail file is gone when the crawlers stopped seeing the job)
 * and the employer page, fetched with the SSRF guards of the posting fallback.
 * In the functions' sources so that both can run it; the runner imports it
 * through scripts/assisted-application/lib/liveness.mjs and posting-liveness.mjs.
 */

import { JOB_DETAIL_BASE, fetchPublicPage, fetchWorkdayPosting, htmlToText } from './assistedApplicationAiJob.js';

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
  /(offre|poste|annonce) (deja )?pourvu(e)?/i,
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
  /(stelle|inserat|stellenanzeige|ausschreibung) (ist |wurde )?(bereits )?(abgelaufen|geschlossen|deaktiviert)/i,
  /bewerbungsfrist (ist )?abgelaufen/i,
  /die stelle wurde (bereits )?besetzt/i,
];

const LISTING_PAGE_PATTERNS = [/\d+\s+jobs?\s+found/i, /\d+\s+(offerte|stellen|offres) (trovate|gefunden|trouvees)/i];
const SOFT_EXPIRED_PATTERNS = [/\bjob expired\b/i];
const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /performing security verification/i,
  /checking your browser before/i,
  /verify you are (a |not a )?human/i,
  /enable javascript and cookies to continue/i,
  /attention required.*cloudflare/i,
  /\bray id\b/i,
  /please complete the security check/i,
];
const EXPIRED_URL_PATTERNS = [/[?&]error=true/i];
const APPLY_PATTERNS = [
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
];
const MIN_CONTENT_CHARS = 300;
const JOB_ID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/gi;

function jobIdToken(url = '') {
  const matches = String(url).match(JOB_ID_TOKEN);
  return matches ? matches[matches.length - 1].toLowerCase() : null;
}

const firstMatch = (patterns, text = '') => patterns.find((pattern) => pattern.test(text));
const hasApplyControl = (controls = []) => controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));

export function classifyLiveness({ status = 0, requestedUrl = '', finalUrl = '', bodyText: rawBodyText = '', applyControls: rawApplyControls = [] } = {}) {
  const bodyText = normalizeForMatch(rawBodyText);
  const applyControls = (Array.isArray(rawApplyControls) ? rawApplyControls : []).map(normalizeForMatch);
  if (status === 404 || status === 410) return { result: 'expired', code: 'http_gone', reason: `HTTP ${status}` };
  const botChallenge = firstMatch(BOT_CHALLENGE_PATTERNS, bodyText);
  if (botChallenge) return { result: 'uncertain', code: 'bot_challenge', reason: 'anti-bot challenge' };
  if (status === 403 || status === 429 || status === 503) return { result: 'uncertain', code: 'access_blocked', reason: `HTTP ${status}` };
  if (status >= 500) return { result: 'uncertain', code: 'server_error', reason: `HTTP ${status}` };
  if (firstMatch(EXPIRED_URL_PATTERNS, finalUrl)) return { result: 'expired', code: 'expired_url', reason: 'error redirect' };
  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) return { result: 'expired', code: 'expired_body', reason: `pattern matched: ${expiredBody.source}` };
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
 * @param {{datasetGone:boolean}} dataset our own published job-detail file is gone (404)
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
  const re = /<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) && controls.length < 400) {
    const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 80) controls.push(text);
  }
  return controls;
}

const TIMEOUT_MS = 12_000;
const MAX_HTML = 1_500_000;

async function datasetGone(jobId, fetchImpl) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(String(jobId || ''))) return false;
  try {
    const response = await fetchImpl(`${JOB_DETAIL_BASE}/${encodeURIComponent(jobId)}.json`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.status === 404 || response.status === 410;
  } catch {
    return false;
  }
}

export async function checkPostingLiveness({ order, posting, fetchImpl = fetch, resolve }) {
  const gone = await datasetGone(order?.jobId, fetchImpl);
  const url = posting?.applyUrl && !/^mailto:/i.test(posting.applyUrl) ? posting.applyUrl : order?.jobUrl;
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
export function postingAddressOf(draft) {
  return draft?.channel?.postingUrl || draft?.channel?.applyUrl || draft?.job?.applyUrl || '';
}
