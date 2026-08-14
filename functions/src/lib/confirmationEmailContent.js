/**
 * confirmationEmailContent.js — the WORDS of the double opt-in, in one place
 * (#5692).
 *
 * The owner's decision of 2026-08-13, in full: a reminder is the confirmation
 * email again, with a different frame around it. Not a new email.
 *
 *   «Riusare il testo dell'email di conferma esistente, cambiando solo la
 *   cornice. È la scelta più sicura: non introduce parole nuove in un percorso
 *   di consenso, e il link è lo stesso.»
 *
 * That is a real constraint and not a shortcut. A person who did not answer the
 * first request has not consented to anything, so the second and third contact
 * may not carry a single sentence the first one did not: no offer, no urgency,
 * no second link. What changes is one banner at the top saying when we wrote
 * before, and — on the last one — that it is the last one. Everything below the
 * banner is byte-for-byte the email they already ignored.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than the template staying in
 * newsletterConfirmationEmail.js where it was: two senders now compose this
 * mail. The Cloud Function sends request #1 the moment somebody signs up, and
 * scripts/newsletter-confirmation-followups.mjs sends #2 and #3 the days after.
 * A script cannot import the Cloud Function — that module reaches for
 * firebase-admin, the Resend webhook core and Remote Config at module scope —
 * so the alternative to this file was a second copy of the template, which is
 * the construct that produced every drift defect this area has had. This module
 * imports nothing but the translations and the controller identity line, so
 * both sides can hold it.
 *
 * THE FRAME IS DERIVED FROM THE LEDGER, NEVER PASSED IN. `confirmationFrameForAttempt`
 * takes the attempt number the cap is already counting, so the banner cannot
 * disagree with the record: an email that says "this is the last reminder" is
 * the same event that writes `confirmation_attempts: 3`.
 */
import { t, htmlLang, normalizeLocale } from '../emailI18n.js';
import { dataControllerFooterLine } from './dataControllerIdentity.js';

export const CONFIRMATION_BASE_URL = 'https://frontaliereticino.ch';
export const CONFIRMATION_FROM_EMAIL = 'Frontaliere Ticino <confirmation@frontaliereticino.ch>';

const BRAND_BLUE = '#2563EB';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f3f4f6';
const CARD_BG = '#ffffff';
const TEXT_COLOR = '#1f2937';
const MUTED_COLOR = '#6b7280';
const BORDER_COLOR = '#dbe2ea';

/**
 * Which of the three requests this is, as far as the reader is concerned.
 *
 * Three values and not a boolean: the second reminder has to say something the
 * first one must not ("this is the last one"), and a boolean would have made
 * that a second parameter nobody remembers to pass.
 */
export const CONFIRMATION_FRAMES = Object.freeze({
  /** Request #1 — the ordinary confirmation email, unchanged since 2024. */
  FIRST: 'first',
  /** Request #2 — same body, preceded by "we wrote to you on <date>". */
  REMINDER: 'reminder',
  /** Request #3 — same again, and it says it is the last. */
  LAST: 'last-reminder',
});

/**
 * The frame for the Nth request, counting the first one.
 *
 * Anything past the third is still `LAST`, defensively: the cap in
 * confirmationFollowup.js is what stops a fourth send, and if it ever failed
 * the recipient must not receive an email that reads like a fresh signup.
 *
 * @param {number} attempt 1-based
 * @returns {string} one of CONFIRMATION_FRAMES
 */
export function confirmationFrameForAttempt(attempt) {
  const n = Number(attempt);
  if (!Number.isFinite(n) || n <= 1) return CONFIRMATION_FRAMES.FIRST;
  if (n === 2) return CONFIRMATION_FRAMES.REMINDER;
  return CONFIRMATION_FRAMES.LAST;
}

/** True for the two frames that carry the reminder banner. */
export const isReminderFrame = (frame) =>
  frame === CONFIRMATION_FRAMES.REMINDER || frame === CONFIRMATION_FRAMES.LAST;

/**
 * Month names, written out rather than left to `toLocaleDateString`.
 *
 * A Node built with small-icu formats every locale as English and would put
 * "14 August 2026" in a French email without failing anything. This mail is
 * shown to four language communities and its date is the one fact the reader
 * checks against their own memory, so it is not left to how the runtime happens
 * to be compiled.
 */
const MONTHS = {
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};

/** The recipients are in Ticino and northern Italy; the date they remember is the local one. */
const DISPLAY_TIME_ZONE = 'Europe/Rome';

/**
 * Calendar parts of an instant in the site's timezone.
 *
 * `en-US` and `formatToParts` because the parts are read BY TYPE, so the
 * locale's ordering and separators never matter — the one Intl call that gives
 * the same answer on a full-icu and a small-icu build alike. A runtime without
 * a timezone database falls back to UTC rather than to a wrong date.
 *
 * @param {number} ms
 * @returns {{year: number, month: number, day: number}}
 */
function calendarParts(ms) {
  const d = new Date(ms);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DISPLAY_TIME_ZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(d);
    const pick = (type) => Number(parts.find((p) => p.type === type)?.value);
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      return { year, month, day };
    }
  } catch {
    /* fall through to UTC */
  }
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * "14 agosto 2026" / "14 August 2026" / "14. August 2026" / "14 août 2026".
 *
 * @param {number|null|undefined} ms epoch milliseconds, or null when unknown
 * @param {string} locale
 * @returns {string|null} null when there is no date to state — the caller must
 *   then say "a few days ago" rather than invent one
 */
export function formatConfirmationDate(ms, locale) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  const lang = normalizeLocale(locale);
  const { year, month, day } = calendarParts(Number(ms));
  const name = (MONTHS[lang] || MONTHS.it)[month - 1];
  if (!name) return null;
  return lang === 'de' ? `${day}. ${name} ${year}` : `${day} ${name} ${year}`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * The one sentence a reminder adds, and — for the last one — the second.
 *
 * The date clause is a separate string per locale because a document can reach
 * a reminder with no usable first-send stamp (a legacy row, or one whose
 * anchor a later write dropped), and «ti avevamo scritto il undefined» is worse
 * than no date at all. The undated wording is the same sentence with "a few
 * days ago" in the slot, so the frame never has to be abandoned to stay honest.
 *
 * @param {string} locale
 * @param {{frame?: string, firstSentAt?: number|null}} [options]
 * @returns {string} HTML, or '' for the first request
 */
export function confirmationReminderBanner(locale, { frame, firstSentAt } = {}) {
  if (!isReminderFrame(frame)) return '';
  const lang = normalizeLocale(locale);
  const date = formatConfirmationDate(firstSentAt, lang);
  const when = date
    ? t(lang, 'confirmReminderWhenDated', { date: escapeHtml(date) })
    : t(lang, 'confirmReminderWhenUndated');
  const lead = t(lang, 'confirmReminderLead', { when });
  const last =
    frame === CONFIRMATION_FRAMES.LAST
      ? `<div style="margin-top:10px;">${t(lang, 'confirmReminderLastNotice')}</div>`
      : '';
  return `<div style="background:#f8fafc;border:1px solid ${BORDER_COLOR};border-left:4px solid ${BRAND_BLUE};border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:14px;line-height:1.6;color:${TEXT_COLOR};">
 ${lead}${last}
 </div>`;
}

/**
 * The subject line for each frame.
 *
 * @param {string} locale
 * @param {{frame?: string}} [options]
 * @returns {string}
 */
export function confirmationEmailSubject(locale, { frame } = {}) {
  const lang = normalizeLocale(locale);
  if (frame === CONFIRMATION_FRAMES.LAST) return t(lang, 'confirmReminderLastSubject');
  if (frame === CONFIRMATION_FRAMES.REMINDER) return t(lang, 'confirmReminderSubject');
  return t(lang, 'confirmSubject');
}

/**
 * The confirmation email, in one of its three frames.
 *
 * `options` is optional and its default is the plain first request, so every
 * existing caller — and the test that has rendered this template since 2024 —
 * gets exactly the bytes it got before.
 *
 * @param {string} confirmUrl
 * @param {string} [locale]
 * @param {{frame?: string, firstSentAt?: number|null}} [options]
 * @returns {string}
 */
export function buildNewsletterConfirmationEmailHtml(confirmUrl, locale = 'it', options = {}) {
 const lang = normalizeLocale(locale);
 const year = new Date().getFullYear();
 const banner = confirmationReminderBanner(lang, options);
 return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
 <meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 <title>${confirmationEmailSubject(lang, options)}</title>
</head>
<body style="margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
 <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};padding:32px 16px;">
 <tr><td align="center">
 <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
 <tr><td style="text-align:center;padding-bottom:24px;">
 <a target="_blank" rel="noopener noreferrer" href="${CONFIRMATION_BASE_URL}" style="text-decoration:none;">
 <img src="${CONFIRMATION_BASE_URL}/icons/icon-192x192.png" alt="${t(lang, 'brandName')}" width="48" height="48" style="display:block;margin:0 auto 8px;border-radius:12px;" />
 <div style="font-size:22px;font-weight:800;color:${BRAND_BLUE};">${t(lang, 'brandName')}</div>
 <div style="font-size:12px;color:${MUTED_COLOR};letter-spacing:.04em;">${t(lang, 'brandTagline')}</div>
 </a>
 </td></tr>
 <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:32px 28px;">
 ${banner}<div style="font-size:28px;font-weight:800;color:${BRAND_DARK};padding-bottom:8px;">${t(lang, 'confirmTitle')}</div>
 <div style="font-size:15px;line-height:1.6;color:${TEXT_COLOR};padding-bottom:20px;">
 ${t(lang, 'confirmIntro')}
 </div>
 <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
 <tr><td align="center">
 <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:16px 32px;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:.02em;">
 ${t(lang, 'confirmButton')}
 </a>
 </td></tr>
 </table>
 <div style="font-size:13px;color:${MUTED_COLOR};padding-bottom:10px;">
 ${t(lang, 'confirmAltLink')}
 </div>
 <div style="background:#f8fafc;border:1px solid ${BORDER_COLOR};border-radius:8px;padding:12px;font-size:12px;color:${MUTED_COLOR};word-break:break-all;">
 ${escapeHtml(confirmUrl)}
 </div>
 <div style="border-top:1px solid ${BORDER_COLOR};margin:24px 0;"></div>
 <div style="font-size:14px;color:${TEXT_COLOR};line-height:1.6;">
 ${t(lang, 'confirmWeeklyTitle')}
 <ul style="padding-left:20px;margin:10px 0;">
 <li>${t(lang, 'confirmWeeklyExchange')}</li>
 <li>${t(lang, 'confirmWeeklyJobs')}</li>
 <li>${t(lang, 'confirmWeeklyTax')}</li>
 <li>${t(lang, 'confirmWeeklyGuides')}</li>
 </ul>
 </div>
 <div style="border-top:1px solid ${BORDER_COLOR};margin:24px 0;"></div>
 <div style="font-size:13px;color:${MUTED_COLOR};line-height:1.6;">
 ${t(lang, 'confirmNotYou')}
 </div>
 </td></tr>
 <tr><td style="text-align:center;padding:20px 0 8px;">
 <div style="font-size:12px;color:${MUTED_COLOR};">
 ${t(lang, 'copyright', { year })} ·
 <a target="_blank" rel="noopener noreferrer" href="${CONFIRMATION_BASE_URL}" style="color:${MUTED_COLOR};text-decoration:none;">frontaliereticino.ch</a>
 </div>
 <div style="font-size:11px;color:${MUTED_COLOR};margin-top:6px;">${escapeHtml(dataControllerFooterLine(lang))}</div>
 </td></tr>
 </table>
 </td></tr>
 </table>
</body>
</html>`;
}

/**
 * The confirmation URL. Shared so the two senders cannot drift on the query
 * string the SPA parses — a reminder pointing at a slightly different URL would
 * be a dead link that still looked right in review.
 *
 * @param {{email: string, token: string|null, sourcePath?: string}} args
 * @returns {string}
 */
export function confirmationConfirmUrl({ email, token, sourcePath }) {
  const returnPath = sourcePath && sourcePath !== '/' ? sourcePath : '';
  return `${CONFIRMATION_BASE_URL}${returnPath}?action=confirm_newsletter&email=${encodeURIComponent(email)}&token=${token}`;
}

/**
 * Subject + body + tags for one confirmation request, in one call.
 *
 * `tags` carry the frame so the provider-side numbers can answer "do reminders
 * convert at all" without a second system: `campaign_id` stays `confirmation`
 * for every one of the three, because they are the same campaign.
 *
 * @param {{locale?: string, confirmUrl: string, frame?: string, firstSentAt?: number|null}} args
 * @returns {{subject: string, html: string, tags: Array<{name: string, value: string}>, frame: string}}
 */
export function buildConfirmationRequestEmail({ locale, confirmUrl, frame, firstSentAt } = {}) {
  const lang = normalizeLocale(locale);
  const resolved = frame || CONFIRMATION_FRAMES.FIRST;
  return {
    frame: resolved,
    subject: confirmationEmailSubject(lang, { frame: resolved }),
    html: buildNewsletterConfirmationEmailHtml(confirmUrl, lang, { frame: resolved, firstSentAt }),
    tags: [
      { name: 'campaign_id', value: 'confirmation' },
      { name: 'type', value: 'transactional' },
      { name: 'locale', value: lang },
      { name: 'frame', value: resolved },
    ],
  };
}
