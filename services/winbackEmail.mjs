/**
 * Win-back ("are you still there?") email for the newsletter sunset lifecycle.
 *
 * Sent ONCE to a never-engaging long-term subscriber before they are soft-moved
 * to `inactive` (see scripts/lib/subscriberSunset.mjs). The single goal is a
 * re-engagement click: clicking the CTA hits ?action=resubscribe on our canonical
 * origin and resets engagement, cancelling the sunset. Localised in all four site
 * locales (it/en/de/fr), branded to match the newsletter (dark bar + orange
 * wordmark), with a deliberately playful CTA.
 *
 * Pure + dependency-light (only the shared HMAC URL builders) so it is unit
 * testable. Table-based inline-styled HTML for email-client compatibility.
 */
import { makeAuthenticatedActionUrl, makeOneClickUnsubscribeUrl } from './newsletterUrls.mjs';

// Brand tokens — kept in sync with services/newsletter-template.mjs.
const BRAND_ORANGE = '#f97316'; // accent / wordmark
const CTA_ORANGE = '#ea580c';   // button bg (darker → white label passes 3:1 AA large)
const BRAND_DARK = '#0f172a';
const INK = '#1f2937';
const MUTED = '#6b7280';
const CARD_BG = '#ffffff';
const PAGE_BG = '#f1f5f9';

const COPY = {
  it: {
    subject: 'Ci sei ancora? 👀 La newsletter sta per andare in pausa',
    preheader: 'Un tap e resti a bordo — niente più, promesso.',
    emoji: '👋',
    heading: 'Ci manchi!',
    body: 'Da un po’ non apri la nostra newsletter. Nessun problema — ma per non intasarti la casella stiamo per metterla in pausa. Se vuoi continuare a ricevere <strong>offerte di lavoro in Svizzera</strong>, novità sul confine e dritte per frontalieri, basta un tap.',
    cta: '🚀 Sì, resto a bordo',
    keepNote: 'Se non fai nulla, la mettiamo in pausa tra qualche giorno. Puoi riattivarla quando vuoi — nessun rancore. 🙂',
    unsub: 'No grazie, preferisco salutarti',
    wordmarkSub: 'Ticino',
  },
  en: {
    subject: 'Still there? 👀 Your newsletter is about to take a nap',
    preheader: 'One tap and you stay aboard — nothing more, promise.',
    emoji: '👋',
    heading: 'We miss you!',
    body: 'You haven’t opened our newsletter in a while. No worries — but to keep your inbox tidy we’re about to pause it. If you’d like to keep getting <strong>jobs in Switzerland</strong>, cross-border news and tips for commuters, one tap is all it takes.',
    cta: '🚀 Yep, keep me aboard',
    keepNote: 'Do nothing and we’ll pause it in a few days. You can switch it back on anytime — no hard feelings. 🙂',
    unsub: 'No thanks, time to say goodbye',
    wordmarkSub: 'Ticino',
  },
  de: {
    subject: 'Noch da? 👀 Dein Newsletter macht bald Pause',
    preheader: 'Ein Tap und du bleibst an Bord — mehr nicht, versprochen.',
    emoji: '👋',
    heading: 'Wir vermissen dich!',
    body: 'Du hast unseren Newsletter eine Weile nicht geöffnet. Kein Problem — aber damit dein Postfach aufgeräumt bleibt, pausieren wir ihn bald. Wenn du weiterhin <strong>Jobs in der Schweiz</strong>, Grenzgänger-News und Tipps erhalten möchtest, genügt ein Tap.',
    cta: '🚀 Ja, ich bleibe an Bord',
    keepNote: 'Tust du nichts, pausieren wir ihn in ein paar Tagen. Du kannst ihn jederzeit wieder aktivieren — alles gut. 🙂',
    unsub: 'Nein danke, Zeit für ein Tschüss',
    wordmarkSub: 'Ticino',
  },
  fr: {
    subject: 'Toujours là ? 👀 Ta newsletter va faire une pause',
    preheader: 'Un tap et tu restes à bord — rien de plus, promis.',
    emoji: '👋',
    heading: 'Tu nous manques !',
    body: 'Tu n’as pas ouvert notre newsletter depuis un moment. Pas de souci — mais pour garder ta boîte mail au propre, nous allons la suspendre. Si tu veux continuer à recevoir des <strong>offres d’emploi en Suisse</strong>, l’actu de la frontière et des astuces pour frontaliers, un tap suffit.',
    cta: '🚀 Oui, je reste à bord',
    keepNote: 'Sans action de ta part, nous la suspendrons dans quelques jours. Tu pourras la réactiver quand tu veux — sans rancune. 🙂',
    unsub: 'Non merci, je préfère partir',
    wordmarkSub: 'Ticino',
  },
};

function norm(locale) {
  const l = String(locale || 'it').slice(0, 2).toLowerCase();
  return COPY[l] ? l : 'it';
}

/**
 * @param {{ email: string, locale?: string }} args
 * @returns {{ subject: string, html: string, text: string, unsubscribeUrl: string }}
 */
export function buildWinbackEmail({ email, locale = 'it' }) {
  const l = norm(locale);
  const s = COPY[l];
  // Authenticated links (carry the `ac` autologin code) so the SPA accepts the
  // action instead of rejecting with "Link non valido".
  const stayUrl = makeAuthenticatedActionUrl('resubscribe', email);
  const footerUnsubUrl = makeAuthenticatedActionUrl('unsubscribe', email);
  // Header List-Unsubscribe uses the dedicated one-click endpoint (RFC 8058) —
  // proxied straight to the Cloud Function, bypassing the SPA's `ac` requirement.
  const unsubscribeUrl = makeOneClickUnsubscribeUrl(email);

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
      <tr><td style="padding:36px 32px 8px;text-align:center;">
        <div style="font-size:48px;line-height:1;margin:0 0 12px;">${s.emoji}</div>
        <h1 style="margin:0;font-size:26px;line-height:1.2;color:${INK};font-weight:800;">${s.heading}</h1>
      </td></tr>
      <!-- body -->
      <tr><td style="padding:16px 32px 28px;text-align:center;">
        <p style="margin:0 0 28px;font-size:16px;line-height:1.65;color:${INK};">${s.body}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr><td style="border-radius:999px;background:${CTA_ORANGE};box-shadow:0 6px 16px rgba(234,88,12,0.32);">
          <a href="${stayUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:16px 34px;font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${s.cta}</a>
        </td></tr></table>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.55;color:${MUTED};">${s.keepNote}</p>
      </td></tr>
      <!-- footer -->
      <tr><td style="border-top:1px solid #eef2f7;padding:18px 32px 24px;text-align:center;">
        <a href="${footerUnsubUrl}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:${MUTED};text-decoration:underline;">${s.unsub}</a>
      </td></tr>
    </table>
    <div style="max-width:520px;margin:14px auto 0;font-size:11px;color:#94a3b8;text-align:center;">Frontaliere Ticino · frontaliereticino.ch</div>
  </td></tr>
</table>
</body>
</html>`;

  // Plain-text part mirrors the message (emoji stripped from the CTA label).
  const text = `${s.heading}\n\n${s.body.replace(/<[^>]+>/g, '')}\n\n${s.cta.replace(/^[^\w]+/, '').trim()}: ${stayUrl}\n\n${s.keepNote}\n\n${s.unsub}: ${footerUnsubUrl}\n\nFrontaliere Ticino · frontaliereticino.ch\n`;

  return { subject: s.subject, html, text, unsubscribeUrl };
}
