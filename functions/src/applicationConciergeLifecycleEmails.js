/** Lifecycle messages use the existing branded service email shell. */
import { brandButton, brandCallout, brandFinePrint, brandJobCard, brandLink, brandParagraph, renderBrandedEmail } from './assistedApplicationEmailLayout.js';
import { conciergeServiceUrl } from './applicationConciergeNotifications.js';
import { conciergeRenewalOffer } from './applicationConciergeLifecyclePolicy.js';

const COPY = {
  it: { newSubject: 'Nuove opportunità selezionate per te', newTitle: 'Il prossimo passo potrebbe essere qui.', newBody: 'Abbiamo aggiornato la ricerca e trovato nuove posizioni in linea con il tuo profilo. Scegli quelle che ti interessano: prepariamo la candidatura dopo il tuo via libera.', newCta: 'Scopri le nuove proposte', renewalSubjects: ['Continua la ricerca e risparmia 10 €', 'Altri 30 giorni con 10 € di sconto', 'Ultimo giorno: rinnova con il 25% di sconto'], renewalTitle: 'Continua la ricerca con il 25% di sconto.', renewalBody: 'I tuoi primi 30 giorni sono terminati. L’offerta vale per 72 ore dalla scadenza del servizio: riparti con altri 30 giorni di assistenza e fino a 10 posizioni da approvare a 29,99 € invece di 39,99 €.', renewalCta: 'Continua a 29,99 €', savings: 'Risparmi 10 € — circa il 25% sul prezzo standard', deadline: 'Offerta valida fino al', terms: 'Lo sconto dura 72 ore dalla scadenza del servizio. Dopo questa data il prezzo torna a 39,99 €. Il rinnovo richiede un nuovo pagamento.' },
  en: { newSubject: 'New opportunities selected for you', newTitle: 'Your next step could be here.', newBody: 'We refreshed your search and found new positions matching your profile. Choose the ones you like: we prepare the application after your approval.', newCta: 'See your new proposals', renewalSubjects: ['Keep your search moving: save €10', 'Another 30 days with €10 off', 'Last day: renew with 25% off'], renewalTitle: 'Keep your search moving with 25% off.', renewalBody: 'Your first 30 days have ended. The offer is valid for 72 hours after your service expires: continue with another 30 days of assistance and up to 10 new positions to approve for €29.99 instead of €39.99.', renewalCta: 'Continue for €29.99', savings: 'Save €10 — about 25% off the standard price', deadline: 'Offer valid until', terms: 'The discount lasts 72 hours from your service expiry. Afterwards the price returns to €39.99. Renewal requires a new payment.' },
  de: { newSubject: 'Neue Stellenangebote für dich', newTitle: 'Hier könnte dein nächster Schritt beginnen.', newBody: 'Wir haben deine Suche aktualisiert und neue passende Stellen gefunden. Wähle die interessanten Angebote aus: Wir bereiten die Bewerbung nach deiner Zustimmung vor.', newCta: 'Neue Vorschläge ansehen', renewalSubjects: ['Setze deine Suche fort und spare 10 €', 'Weitere 30 Tage mit 10 € Rabatt', 'Letzter Tag: jetzt 25 % sparen'], renewalTitle: 'Setze deine Suche mit 25 % Rabatt fort.', renewalBody: 'Deine ersten 30 Tage sind vorbei. Innerhalb von 72 Stunden nach Ablauf deines Service kannst du deine Suche um weitere 30 Tage Unterstützung und bis zu 10 Stellen zur Freigabe verlängern: 29,99 € statt 39,99 €.', renewalCta: 'Für 29,99 € fortfahren', savings: '10 € sparen — rund 25 % unter dem Normalpreis', deadline: 'Angebot gültig bis', terms: 'Der Rabatt gilt 72 Stunden ab Ablauf des Service. Danach kostet er wieder 39,99 €. Die Verlängerung erfordert eine neue Zahlung.' },
  fr: { newSubject: 'De nouvelles opportunités pour toi', newTitle: 'Ta prochaine étape est peut-être ici.', newBody: 'Nous avons actualisé ta recherche et trouvé de nouveaux postes adaptés à ton profil. Choisis ceux qui t’intéressent : nous préparons la candidature après ton accord.', newCta: 'Voir les nouvelles propositions', renewalSubjects: ['Continue ta recherche et économise 10 €', '30 jours de plus avec 10 € de réduction', 'Dernier jour : 25 % de réduction'], renewalTitle: 'Poursuis ta recherche avec 25 % de réduction.', renewalBody: 'Tes 30 premiers jours sont terminés. L’offre est valable pendant les 72 heures suivant l’expiration de ton service : continue avec 30 jours d’assistance supplémentaires et jusqu’à 10 postes à valider pour 29,99 € au lieu de 39,99 €.', renewalCta: 'Continuer pour 29,99 €', savings: 'Économise 10 €, soit environ 25 % du prix normal', deadline: 'Offre valable jusqu’au', terms: 'La réduction dure 72 heures après l’expiration du service. Ensuite le prix revient à 39,99 €. Le renouvellement nécessite un nouveau paiement.' },
};
const esc = (value) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buildConciergeNewJobsEmail(service, serviceId, proposals, { autologin = null } = {}) {
  const locale = Object.hasOwn(COPY, service.locale) ? service.locale : 'it';
  const copy = COPY[locale];
  const href = conciergeServiceUrl(service, serviceId, autologin);
  const cards = proposals.slice(0, 3).map(p => brandJobCard({
    title: p.jobTitle,
    company: p.companyName,
    location: p.location || '',
    logoUrl: p.companyLogo || p.companyLogoUrl || p.logoUrl || '',
    contract: p.contract || '',
    salaryMin: p.salaryMin,
    salaryMax: p.salaryMax,
    salaryCurrency: p.salaryCurrency || '',
    baseSalary: p.baseSalary || null,
    firstSeenAt: p.firstSeenAt || p.postedDate || '',
    locale,
    url: p.jobUrl || '',
  })).join('');
  return { subject: copy.newSubject, text: `${copy.newBody}\n\n${proposals.map(p => `${p.jobTitle} — ${p.companyName}`).join('\n')}\n\n${copy.newCta}: ${href}`,
    html: renderBrandedEmail({ locale, heroTitle: copy.newTitle, preheader: copy.newSubject, bodyHtml: brandParagraph(esc(copy.newBody)) + cards + brandButton(href, copy.newCta) }) };
}

export function buildConciergeRenewalEmail(service, serviceId, { nowMs = Date.now(), autologin = null, unsubscribeUrl } = {}) {
  if (!unsubscribeUrl) throw new Error('concierge_renewal_unsubscribe_required');
  const offer = conciergeRenewalOffer(service, nowMs);
  if (!offer?.discounted) throw new Error('concierge_renewal_offer_expired');
  const locale = Object.hasOwn(COPY, service.locale) ? service.locale : 'it';
  const copy = COPY[locale];
  const subject = copy.renewalSubjects[offer.reminderStage];
  const deadline = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(new Date(offer.discountExpiresAt));
  const zoneLabel = { it: 'ora svizzera', en: 'Swiss time', de: 'Schweizer Zeit', fr: 'heure suisse' }[locale];
  const href = conciergeServiceUrl(service, serviceId, autologin, { renewal: true });
  const money = (cents) => new Intl.NumberFormat(locale === 'en' ? 'en-IE' : locale, { style: 'currency', currency: 'EUR' }).format(cents / 100);
  const bodyHtml = brandParagraph(esc(copy.renewalBody))
    + brandCallout(`<div style="font-size:30px;font-weight:800;color:#0f172a;line-height:1.2">${esc(money(offer.amountTotal))} <span style="font-size:16px;color:#64748b;font-weight:400;text-decoration:line-through">${esc(money(3999))}</span></div><div style="margin-top:8px;font-weight:700;color:#c2410c">${esc(copy.savings)}</div>`)
    + brandButton(href, copy.renewalCta)
    + brandParagraph(`<strong>${esc(copy.deadline)} ${esc(deadline)} (${esc(zoneLabel)}).</strong>`)
    + brandFinePrint(esc(copy.terms))
    + brandFinePrint(brandLink(unsubscribeUrl, { it: 'Non vuoi altri promemoria? Disiscriviti', en: 'Unsubscribe from reminders', de: 'Keine weiteren Erinnerungen: abmelden', fr: 'Se désinscrire des rappels' }[locale]));
  return { subject, headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, text: `${copy.renewalBody}\n\n${copy.savings}\n${copy.deadline} ${deadline} (${zoneLabel}).\n\n${copy.renewalCta}: ${href}\n\n${copy.terms}\n\n${unsubscribeUrl}`, html: renderBrandedEmail({ locale, heroTitle: copy.renewalTitle, preheader: subject, bodyHtml }) };
}
