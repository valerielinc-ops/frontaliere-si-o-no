/**
 * Brand shell of the assisted-application emails.
 *
 * Same palette and structure as the job alerts and the application-intent
 * reminder (scripts/send-job-alerts.mjs, scripts/lib/applicationIntentReminderEmail.mjs):
 * dark top bar with the orange dot, dark hero, white body, dark footer. The
 * letter from Valerie keeps its personal tone; the shell makes it read as
 * Frontaliere Ticino at first glance.
 *
 * One deliberate difference: text and buttons on white use orange-700
 * (#c2410c, 5.2:1 on white) instead of the brand orange (#f97316, 2.8:1),
 * which stays for accents, borders and links on the dark bands.
 *
 * Every text argument is plain text and escaped here; `bodyHtml` and the
 * block helpers' `html` arguments are trusted markup built by the caller.
 */

import { dataControllerFooterLine } from './lib/dataControllerIdentity.js';

const BRAND_ORANGE = '#f97316';
const ORANGE_TEXT = '#c2410c';
const ORANGE_TINT = '#fff7ed';
const ORANGE_BORDER = '#fed7aa';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f1f5f9';
const CARD_BG = '#f8fafc';
const WHITE = '#ffffff';
const TEXT = '#1e293b';
const MUTED = '#64748b';
const MUTED_ON_DARK = '#94a3b8';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const BRAND_SITE_URL = 'https://frontaliereticino.ch/';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function brandParagraph(html) {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT};">${html}</p>`;
}

export function brandFinePrint(html) {
  return `<p style="margin:0 0 12px;font-size:13px;line-height:1.55;color:${MUTED};">${html}</p>`;
}

/** Orange uppercase label above a block, as in the job-alert section headers. */
export function brandSectionLabel(text) {
  return `<div style="margin:22px 0 8px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${ORANGE_TEXT};">${esc(text)}</div>`;
}

export function brandLink(href, label) {
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" style="color:${ORANGE_TEXT};font-weight:600;text-decoration:underline;">${esc(label)}</a>`;
}

/** The job the order is about: title, company and the ad link. */
export function brandJobCard({ title, company, url = '', linkLabel = '' }) {
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:4px 0 18px;">`
    + `<tr><td style="background:${CARD_BG};border:1px solid #e2e8f0;border-left:4px solid ${BRAND_ORANGE};border-radius:10px;padding:14px 16px;">`
    + `<div style="font-size:16px;font-weight:800;color:${BRAND_DARK};line-height:1.35;">${esc(title)}</div>`
    + `<div style="font-size:14px;color:${MUTED};margin-top:3px;">${esc(company)}</div>`
    + (url ? `<div style="margin-top:10px;font-size:13px;">${brandLink(url, `${linkLabel} →`)}</div>` : '')
    + '</td></tr></table>';
}

/** Numbered checklist with orange-tinted counters (email-safe table layout). */
export function brandChecklist(items) {
  const rows = items.map((item, index) => (
    '<tr>'
    + '<td style="width:30px;vertical-align:top;padding:0 0 10px;">'
    + `<div style="width:22px;height:22px;border-radius:11px;background:${ORANGE_TINT};border:1px solid ${ORANGE_BORDER};color:${ORANGE_TEXT};font-size:12px;font-weight:700;line-height:22px;text-align:center;">${index + 1}</div>`
    + '</td>'
    + `<td style="vertical-align:top;padding:1px 0 10px;font-size:15px;line-height:1.5;color:${TEXT};">${esc(item)}</td>`
    + '</tr>'
  )).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 8px;">${rows}</table>`;
}

/** Highlighted box for the main action. */
export function brandCallout(html) {
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:6px 0 18px;">`
    + `<tr><td style="background:${ORANGE_TINT};border:1px solid ${ORANGE_BORDER};border-left:4px solid ${BRAND_ORANGE};border-radius:10px;padding:14px 16px;font-size:15px;line-height:1.55;color:${TEXT};">${html}</td></tr></table>`;
}

export function brandButton(href, label) {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:4px 0 20px;"><tr>`
    + `<td style="background:${ORANGE_TEXT};border-radius:8px;">`
    + `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:700;color:${WHITE};text-decoration:none;border-radius:8px;">${esc(label)}</a>`
    + '</td></tr></table>';
}

/** Neutral card with a small title, e.g. "What happens next". */
export function brandInfoCard(title, html) {
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:4px 0 18px;">`
    + `<tr><td style="background:${CARD_BG};border-radius:12px;padding:16px 18px;">`
    + `<div style="font-size:14px;font-weight:800;color:${BRAND_DARK};margin:0 0 6px;">${esc(title)}</div>`
    + `<div style="font-size:14px;line-height:1.55;color:#334155;">${html}</div>`
    + '</td></tr></table>';
}

export function brandSignature(name, role) {
  return '<table cellpadding="0" cellspacing="0" role="presentation" style="margin:8px 0 4px;"><tr>'
    + `<td style="border-left:3px solid ${BRAND_ORANGE};padding:2px 0 2px 12px;">`
    + `<div style="font-size:16px;font-weight:800;color:${BRAND_DARK};">${esc(name)}</div>`
    + `<div style="font-size:13px;color:${MUTED};margin-top:2px;">${esc(role)}</div>`
    + '</td></tr></table>';
}

/**
 * The full document.
 * @param {{locale?: string, preheader?: string, badge?: string, heroTitle: string,
 *   heroSubtitle?: string, bodyHtml: string, footerLines?: string[]}} args
 */
export function renderBrandedEmail({
  locale = 'it',
  preheader = '',
  badge = '',
  heroTitle,
  heroSubtitle = '',
  bodyHtml,
  footerLines = [],
}) {
  const footer = footerLines
    .filter(Boolean)
    .map((line) => `<div style="font-size:12px;line-height:1.5;color:${MUTED_ON_DARK};margin:0 0 6px;">${esc(line)}</div>`)
    .join('');
  return `<!DOCTYPE html><html lang="${esc(locale)}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">'
    + `<title>${esc(heroTitle)} — Frontaliere Ticino</title>`
    + `<style>body{margin:0;padding:0;background:${LIGHT_BG};font-family:${FONT};-webkit-text-size-adjust:100%;}table{border-collapse:collapse;}`
    + '@media only screen and (max-width:620px){.outer-table{width:100%!important;}.section-pad{padding-left:18px!important;padding-right:18px!important;}}</style>'
    + '</head><body>'
    + (preheader ? `<div style="display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(preheader)}&nbsp;&#8203;&#8203;&#8203;&#8203;</div>` : '')
    + `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${LIGHT_BG};"><tr><td align="center" style="padding:0;">`
    + `<table class="outer-table" width="620" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;max-width:620px;font-family:${FONT};">`
    // Top bar
    + `<tr><td style="background:${BRAND_DARK};padding:14px 28px;" class="section-pad"><table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>`
    + `<td style="font-size:15px;font-weight:800;color:${WHITE};letter-spacing:-0.3px;"><span style="color:${BRAND_ORANGE};">●</span> Frontaliere Ticino</td>`
    + (badge ? `<td align="right" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${BRAND_ORANGE};">${esc(badge)}</td>` : '')
    + '</tr></table></td></tr>'
    // Hero
    + `<tr><td style="background:${BRAND_DARK};padding:18px 28px 28px;" class="section-pad">`
    + `<div style="font-size:24px;font-weight:800;line-height:1.25;color:${WHITE};">${esc(heroTitle)}</div>`
    + (heroSubtitle ? `<div style="font-size:14px;line-height:1.45;color:${MUTED_ON_DARK};margin-top:8px;">${esc(heroSubtitle)}</div>` : '')
    + '</td></tr>'
    // Orange rule between hero and body
    + `<tr><td style="background:${BRAND_ORANGE};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>`
    // Body
    + `<tr><td style="background:${WHITE};padding:28px 28px 16px;" class="section-pad">${bodyHtml}</td></tr>`
    // Footer
    + `<tr><td style="background:${BRAND_DARK};padding:24px 28px;text-align:center;" class="section-pad">`
    + footer
    + `<div style="font-size:12px;margin:10px 0 6px;"><a href="${BRAND_SITE_URL}" target="_blank" rel="noopener noreferrer" style="color:${BRAND_ORANGE};text-decoration:none;font-weight:700;">frontaliereticino.ch</a></div>`
    + `<div style="font-size:12px;color:${MUTED_ON_DARK};margin-top:6px;">© ${new Date().getFullYear()} Frontaliere Ticino</div>`
    + `<div style="font-size:11px;color:${MUTED_ON_DARK};margin-top:6px;">${esc(dataControllerFooterLine(locale))}</div>`
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}
