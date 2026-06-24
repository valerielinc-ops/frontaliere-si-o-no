/**
 * Win-back ("are you still there?") email for the newsletter sunset lifecycle.
 *
 * Sent ONCE to a never-engaging long-term subscriber before they are soft-moved
 * to `inactive` (see scripts/lib/subscriberSunset.mjs). The single goal is a
 * re-engagement click: ANY open/click resets their engagement and cancels the
 * sunset. Localised in all four site locales (it/en/de/fr).
 *
 * Pure + dependency-light (only the shared HMAC URL builders) so it is unit
 * testable. Table-based inline-styled HTML for email-client compatibility.
 */
import { makeUnsubscribeUrl, makeResubscribeUrl } from './newsletterUrls.mjs';

const BRAND_ORANGE = '#ea580c';
const TEXT = '#1f2937';
const MUTED = '#6b7280';

const COPY = {
  it: {
    subject: 'Ci sei ancora? Stiamo per sospendere la newsletter',
    preheader: 'Conferma con un clic per continuare a riceverla.',
    heading: 'Ci sei ancora?',
    body: 'Non apri la nostra newsletter da un po’. Per rispettare la tua casella, stiamo per sospendere gli invii — ma se vuoi continuare a ricevere offerte di lavoro e novità per frontalieri, basta un clic.',
    cta: 'Sì, voglio restare iscritto',
    footer: 'Se non fai nulla, sospenderemo la newsletter tra qualche giorno. Potrai riattivarla quando vuoi.',
    unsub: 'Annulla iscrizione',
  },
  en: {
    subject: 'Still there? We’re about to pause your newsletter',
    preheader: 'Confirm with one click to keep receiving it.',
    heading: 'Still there?',
    body: 'You haven’t opened our newsletter in a while. To respect your inbox we’re about to pause it — but if you’d like to keep getting cross-border job offers and news, just one click is enough.',
    cta: 'Yes, keep me subscribed',
    footer: 'If you do nothing, we’ll pause the newsletter in a few days. You can reactivate it anytime.',
    unsub: 'Unsubscribe',
  },
  de: {
    subject: 'Noch da? Wir pausieren bald deinen Newsletter',
    preheader: 'Bestätige mit einem Klick, um ihn weiter zu erhalten.',
    heading: 'Noch da?',
    body: 'Du hast unseren Newsletter seit einer Weile nicht geöffnet. Aus Rücksicht auf dein Postfach pausieren wir ihn bald — wenn du aber weiterhin Stellenangebote und News für Grenzgänger erhalten möchtest, genügt ein Klick.',
    cta: 'Ja, ich bleibe dabei',
    footer: 'Wenn du nichts tust, pausieren wir den Newsletter in wenigen Tagen. Du kannst ihn jederzeit reaktivieren.',
    unsub: 'Abmelden',
  },
  fr: {
    subject: 'Toujours là ? Nous allons suspendre votre newsletter',
    preheader: 'Confirmez en un clic pour continuer à la recevoir.',
    heading: 'Toujours là ?',
    body: 'Vous n’avez pas ouvert notre newsletter depuis un moment. Pour respecter votre boîte mail, nous allons la suspendre — mais si vous souhaitez continuer à recevoir offres d’emploi et actualités pour frontaliers, un seul clic suffit.',
    cta: 'Oui, je reste abonné',
    footer: 'Sans action de votre part, nous suspendrons la newsletter dans quelques jours. Vous pourrez la réactiver quand vous voulez.',
    unsub: 'Se désabonner',
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
  const stayUrl = makeResubscribeUrl(email);
  const unsubscribeUrl = makeUnsubscribeUrl(email);

  const html = `<!DOCTYPE html>
<html lang="${l}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${s.heading}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${s.preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:${TEXT};">${s.heading}</h1>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:${TEXT};">${s.body}</p>
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${BRAND_ORANGE};">
          <a href="${stayUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${s.cta}</a>
        </td></tr></table>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:${MUTED};">${s.footer}</p>
        <p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:${MUTED};">
          <a href="${unsubscribeUrl}" target="_blank" rel="noopener noreferrer" style="color:${MUTED};text-decoration:underline;">${s.unsub}</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = `${s.heading}\n\n${s.body}\n\n${s.cta}: ${stayUrl}\n\n${s.footer}\n\n${s.unsub}: ${unsubscribeUrl}\n`;

  return { subject: s.subject, html, text, unsubscribeUrl };
}
