/** Lifecycle messages use the existing branded service email shell. */
import { brandButton, brandCallout, brandFinePrint, brandJobCard, brandParagraph, renderBrandedEmail } from './assistedApplicationEmailLayout.js';
import { conciergeServiceUrl } from './applicationConciergeNotifications.js';
import { conciergeRenewalOffer } from './applicationConciergeLifecyclePolicy.js';

const COPY = {
  it: { newSubject: 'Nuove opportunità selezionate per te', newTitle: 'Il prossimo passo potrebbe essere qui.', newBody: 'Abbiamo aggiornato la ricerca e trovato nuove posizioni in linea con il tuo profilo. Scegli quelle che ti interessano: prepariamo la candidatura dopo il tuo via libera.', newCta: 'Scopri le nuove proposte', renewalSubjects: ['La tua ricerca può continuare: 10 € di sconto', 'Altri 30 giorni, con 10 € di sconto riservati a te', 'Ultimo giorno per rinnovare a 29,99 €'], renewalTitle: 'Diamo un seguito alla tua ricerca.', renewalBody: 'I tuoi 30 giorni sono terminati. Riparti con altri 30 giorni di assistenza e fino a 10 nuove posizioni da approvare, al prezzo riservato di 29,99 € anziché 39,99 €.', renewalCta: 'Rinnova a 29,99 €', savings: 'Risparmi 10 € sul rinnovo', deadline: 'Offerta valida fino al', terms: 'Lo sconto dura 72 ore dalla scadenza del servizio. Dopo questa data il prezzo torna a 39,99 €. Il rinnovo richiede un nuovo pagamento.' },
  en: { newSubject: 'New opportunities selected for you', newTitle: 'Your next step could be here.', newBody: 'We refreshed your search and found new positions matching your profile. Choose the ones you like: we prepare the application after your approval.', newCta: 'See your new proposals', renewalSubjects: ['Keep your search moving: save €10', 'Another 30 days, with €10 off for you', 'Last day to renew for €29.99'], renewalTitle: 'Keep your search moving.', renewalBody: 'Your 30 days have ended. Continue with another 30 days of assistance and up to 10 new positions to approve, for €29.99 instead of €39.99.', renewalCta: 'Renew for €29.99', savings: 'Save €10 on your renewal', deadline: 'Offer valid until', terms: 'The discount lasts 72 hours from your service expiry. Afterwards the price returns to €39.99. Renewal requires a new payment.' },
  de: { newSubject: 'Neue Stellenangebote für dich', newTitle: 'Hier könnte dein nächster Schritt beginnen.', newBody: 'Wir haben deine Suche aktualisiert und neue passende Stellen gefunden. Wähle die interessanten Angebote aus: Wir bereiten die Bewerbung nach deiner Zustimmung vor.', newCta: 'Neue Vorschläge ansehen', renewalSubjects: ['Setze deine Suche fort: 10 € sparen', 'Weitere 30 Tage mit 10 € Rabatt für dich', 'Letzter Tag: für 29,99 € verlängern'], renewalTitle: 'Setze deine Suche fort.', renewalBody: 'Deine 30 Tage sind vorbei. Sichere dir weitere 30 Tage Unterstützung und bis zu 10 neue Stellen zur Freigabe für 29,99 € statt 39,99 €.', renewalCta: 'Für 29,99 € verlängern', savings: 'Spare 10 € bei der Verlängerung', deadline: 'Angebot gültig bis', terms: 'Der Rabatt gilt 72 Stunden ab Ablauf des Service. Danach kostet er wieder 39,99 €. Die Verlängerung erfordert eine neue Zahlung.' },
  fr: { newSubject: 'De nouvelles opportunités pour toi', newTitle: 'Ta prochaine étape est peut-être ici.', newBody: 'Nous avons actualisé ta recherche et trouvé de nouveaux postes adaptés à ton profil. Choisis ceux qui t’intéressent : nous préparons la candidature après ton accord.', newCta: 'Voir les nouvelles propositions', renewalSubjects: ['Continue ta recherche : économise 10 €', 'Encore 30 jours, avec 10 € de réduction', 'Dernier jour pour renouveler à 29,99 €'], renewalTitle: 'Donnons une suite à ta recherche.', renewalBody: 'Tes 30 jours sont terminés. Continue avec 30 jours d’assistance et jusqu’à 10 nouveaux postes à approuver, pour 29,99 € au lieu de 39,99 €.', renewalCta: 'Renouveler à 29,99 €', savings: 'Économise 10 € sur le renouvellement', deadline: 'Offre valable jusqu’au', terms: 'La réduction dure 72 heures après l’expiration du service. Ensuite le prix revient à 39,99 €. Le renouvellement nécessite un nouveau paiement.' },
};
const esc = (value) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buildConciergeNewJobsEmail(service, serviceId, proposals, { autologin = null } = {}) {
  const locale = Object.hasOwn(COPY, service.locale) ? service.locale : 'it';
  const copy = COPY[locale];
  const href = conciergeServiceUrl(service, serviceId, autologin);
  const cards = proposals.slice(0, 3).map(p => brandJobCard({ title: p.jobTitle, company: p.companyName, location: p.location || '', locale })).join('');
  return { subject: copy.newSubject, text: `${copy.newBody}\n\n${proposals.map(p => `${p.jobTitle} — ${p.companyName}`).join('\n')}\n\n${copy.newCta}: ${href}`,
    html: renderBrandedEmail({ locale, heroTitle: copy.newTitle, preheader: copy.newSubject, bodyHtml: brandParagraph(esc(copy.newBody)) + cards + brandButton(href, copy.newCta) }) };
}

export function buildConciergeRenewalEmail(service, serviceId, { nowMs = Date.now(), autologin = null } = {}) {
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
    + brandFinePrint(esc(copy.terms));
  return { subject, text: `${copy.renewalBody}\n\n${copy.savings}\n${copy.deadline} ${deadline} (${zoneLabel}).\n\n${copy.renewalCta}: ${href}\n\n${copy.terms}`, html: renderBrandedEmail({ locale, heroTitle: copy.renewalTitle, preheader: subject, bodyHtml }) };
}
