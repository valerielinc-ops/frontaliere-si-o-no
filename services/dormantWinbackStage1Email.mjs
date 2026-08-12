/**
 * Dormant win-back — stage 1 email ("here's what you missed").
 *
 * First touch of the two-email dormant re-engagement sequence (#4299, see
 * scripts/lib/dormantWinback.mjs for the classifier/thresholds). Lighter
 * touch than stage 2 (services/winbackEmail.mjs, reused as-is for stage 2's
 * "are you still there?" message) — no pause/urgency framing here, just a
 * friendly reminder of real content the subscriber missed while quiet, built
 * from the same article-performance winners (data/article-performance.json)
 * the regular weekly send uses (services/newsletter-segments.mjs +
 * scripts/lib/articleContent.mjs), so it's genuine content, not filler.
 *
 * Localised in all four site locales (it/en/de/fr), branded to match the
 * newsletter (dark bar + orange wordmark) and services/winbackEmail.mjs.
 * Pure + dependency-light so it is unit testable. Table-based inline-styled
 * HTML for email-client compatibility.
 */
import { makeAuthenticatedActionUrl, makeOneClickUnsubscribeUrl } from './newsletterUrls.mjs';
import { dataControllerFooterLine } from '../functions/src/lib/dataControllerIdentity.js';

// Canonical prod domain (no www) — matches BASE_URL in send-newsletter.mjs /
// newsletterUrls.mjs. `article.url` (from scripts/lib/articleContent.mjs's
// localizeArticle) is a locale-prefixed, trailing-slash-terminated relative
// path — this file only prepends the origin, never rebuilds the path.
const BASE_URL = 'https://frontaliereticino.ch';

// Brand tokens — kept in sync with services/newsletter-template.mjs / services/winbackEmail.mjs.
const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const INK = '#1f2937';
const MUTED = '#6b7280';
const CARD_BG = '#ffffff';
const PAGE_BG = '#f1f5f9';

const COPY = {
  it: {
    subject: 'Ecco cosa ti sei perso 👀',
    preheader: '3 letture veloci per rimetterti in pari.',
    emoji: '📰',
    heading: 'Ci sei ancora?',
    body: 'Non apri la newsletter da un po’, ma qualcosa di utile te lo sei perso comunque. Ecco le letture più cliccate delle ultime settimane:',
    footNote: 'Continuerai a riceverla come sempre — nessuna azione richiesta.',
    unsub: 'Non mi interessa più, disiscrivimi',
    wordmarkSub: 'Ticino',
  },
  en: {
    subject: "Here's what you missed 👀",
    preheader: '3 quick reads to catch up.',
    emoji: '📰',
    heading: 'Still with us?',
    body: 'You haven’t opened the newsletter in a while, but you still missed some useful stuff. Here are the most-clicked reads from the last few weeks:',
    footNote: 'You’ll keep getting it as usual — no action needed.',
    unsub: "Not interested anymore, unsubscribe me",
    wordmarkSub: 'Ticino',
  },
  de: {
    subject: 'Das hast du verpasst 👀',
    preheader: '3 kurze Lektüren zum Aufholen.',
    emoji: '📰',
    heading: 'Noch dabei?',
    body: 'Du hast den Newsletter eine Weile nicht geöffnet, aber etwas Nützliches hast du trotzdem verpasst. Hier die meistgeklickten Artikel der letzten Wochen:',
    footNote: 'Du erhältst ihn weiterhin wie gewohnt — keine Aktion nötig.',
    unsub: 'Kein Interesse mehr, abmelden',
    wordmarkSub: 'Ticino',
  },
  fr: {
    subject: 'Voici ce que tu as manqué 👀',
    preheader: '3 lectures rapides pour te remettre à jour.',
    emoji: '📰',
    heading: 'Toujours là ?',
    body: 'Tu n’as pas ouvert la newsletter depuis un moment, mais tu as quand même manqué des choses utiles. Voici les lectures les plus cliquées de ces dernières semaines :',
    footNote: 'Tu continueras à la recevoir comme d’habitude — aucune action requise.',
    unsub: 'Plus intéressé, désabonne-moi',
    wordmarkSub: 'Ticino',
  },
};

function norm(locale) {
  const l = String(locale || 'it').slice(0, 2).toLowerCase();
  return COPY[l] ? l : 'it';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * @param {{ email: string, locale?: string, articles: Array<{title:string, excerpt?:string, url:string}> }} args
 *   `articles` — 1-3 localized article objects (title/url REQUIRED), already
 *   resolved by the caller (see scripts/lib/articleContent.mjs's localizeArticle
 *   + services/newsletter-segments.mjs's selectWinnerCandidates). `url` is the
 *   relative, locale-prefixed, trailing-slash path — this builds the absolute link.
 * @returns {{ subject: string, html: string, text: string, unsubscribeUrl: string }}
 */
export function buildDormantWinbackStage1Email({ email, locale = 'it', articles = [] }) {
  const l = norm(locale);
  const s = COPY[l];
  const footerUnsubUrl = makeAuthenticatedActionUrl('unsubscribe', email);
  // Header List-Unsubscribe uses the dedicated one-click endpoint (RFC 8058) —
  // proxied straight to the Cloud Function, bypassing the SPA's `ac` requirement.
  const unsubscribeUrl = makeOneClickUnsubscribeUrl(email);

  const items = (articles || []).filter((a) => a?.title && a?.url).slice(0, 3);

  const cardsHtml = items.map((a) => `
        <tr><td style="padding:0 0 14px;">
          <a href="${BASE_URL}${a.url}" target="_blank" rel="noopener noreferrer" style="display:block;padding:14px 16px;background:${PAGE_BG};border-radius:10px;text-decoration:none;">
            <span style="display:block;font-size:15px;font-weight:700;color:${INK};line-height:1.4;">${escapeHtml(a.title)}</span>
            ${a.excerpt ? `<span style="display:block;margin-top:4px;font-size:13px;color:${MUTED};line-height:1.5;">${escapeHtml(a.excerpt)}</span>` : ''}
          </a>
        </td></tr>`).join('');

  const cardsText = items.map((a) => `- ${a.title}: ${BASE_URL}${a.url}`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="${l}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${s.heading}</title></head>
<body style="margin:0;padding:0;background:${PAGE_BG};-webkit-text-size-adjust:100%;">
<span style="display:none!important;max-height:0;overflow:hidden;opacity:0;color:${PAGE_BG};">${s.preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${CARD_BG};border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <!-- brand bar -->
      <tr><td style="background:${BRAND_DARK};padding:16px 28px;">
        <span style="font-size:17px;font-weight:900;letter-spacing:-0.3px;color:${BRAND_ORANGE};">Frontaliere</span><span style="font-size:17px;font-weight:900;letter-spacing:-0.3px;color:#ffffff;"> ${s.wordmarkSub}</span>
      </td></tr>
      <!-- hero -->
      <tr><td style="padding:32px 32px 8px;text-align:center;">
        <div style="font-size:44px;line-height:1;margin:0 0 12px;">${s.emoji}</div>
        <h1 style="margin:0;font-size:24px;line-height:1.2;color:${INK};font-weight:800;">${s.heading}</h1>
      </td></tr>
      <!-- body -->
      <tr><td style="padding:16px 32px 8px;">
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${INK};text-align:center;">${s.body}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cardsHtml}</table>
        <p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:${MUTED};text-align:center;">${s.footNote}</p>
      </td></tr>
      <!-- footer -->
      <tr><td style="border-top:1px solid #eef2f7;padding:18px 32px 24px;text-align:center;">
        <a href="${footerUnsubUrl}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:${MUTED};text-decoration:underline;">${s.unsub}</a>
      </td></tr>
    </table>
    <div style="max-width:520px;margin:14px auto 0;font-size:11px;color:#94a3b8;text-align:center;">Frontaliere Ticino · frontaliereticino.ch</div>
    <div style="max-width:520px;margin:4px auto 0;font-size:11px;color:#94a3b8;text-align:center;">${escapeHtml(dataControllerFooterLine(l))}</div>
  </td></tr>
</table>
</body>
</html>`;

  const text = `${s.heading}\n\n${s.body}\n\n${cardsText}\n\n${s.footNote}\n\n${s.unsub}: ${footerUnsubUrl}\n\nFrontaliere Ticino · frontaliereticino.ch\n${dataControllerFooterLine(l)}\n`;

  return { subject: s.subject, html, text, unsubscribeUrl };
}
