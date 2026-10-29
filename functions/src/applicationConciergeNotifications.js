/** Paid parent-service receipts, separate from the €1.99 child order emails. */
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION, timestampMillis } from './applicationConciergeConstants.js';
import { ADMIN_QUEUE_URL, notificationNeedsRetry, sendOrderNotification } from './assistedApplicationNotifications.js';
import { brandButton, brandParagraph, renderBrandedEmail } from './assistedApplicationEmailLayout.js';
import { makeAuthenticatedUrl } from './lib/newsletterUrls.js';

const BACKSTOP_MS = 72 * 60 * 60 * 1000;
const COPY = {
  it: { path: '/automatizza-ricerca-lavoro-svizzera/', subject: 'Pagamento confermato: candidatura assistita', body: 'Il pagamento di 39,99 € è confermato. Il servizio dura 30 giorni e comprende fino a 10 posizioni approvate da te, senza rinnovo automatico. Carica il CV e completa i tuoi dati per ricevere proposte; puoi seguire le candidature dalla pagina del servizio.', cta: 'Apri il tuo servizio' },
  en: { path: '/en/automate-job-search-switzerland/', subject: 'Payment confirmed: assisted applications', body: 'Your €39.99 payment is confirmed. The service lasts 30 days and covers up to 10 positions you approve, with no automatic renewal. Upload your CV and complete your details to receive proposals; follow your applications on your service page.', cta: 'Open your service' },
  de: { path: '/de/arbeitssuche-schweiz-automatisieren/', subject: 'Zahlung bestätigt: Bewerbungsassistenz', body: 'Deine Zahlung von 39,99 € ist bestätigt. Der Service läuft 30 Tage und umfasst bis zu 10 von dir genehmigte Stellen, ohne automatische Verlängerung. Lade deinen Lebenslauf hoch und ergänze deine Angaben, um Vorschläge zu erhalten. Deine Bewerbungen findest du auf deiner Serviceseite.', cta: 'Deinen Service öffnen' },
  fr: { path: '/fr/automatiser-recherche-emploi-suisse/', subject: 'Paiement confirmé : candidatures assistées', body: 'Ton paiement de 39,99 € est confirmé. Le service dure 30 jours et couvre jusqu’à 10 postes approuvés par toi, sans renouvellement automatique. Ajoute ton CV et complète tes informations pour recevoir des propositions ; suis tes candidatures sur la page du service.', cta: 'Ouvrir ton service' },
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function conciergeServiceUrl(service, serviceId, autologin = null, { renewal = false } = {}) {
  const locale = Object.hasOwn(COPY, service.locale) ? service.locale : 'it';
  const url = new URL(COPY[locale].path, 'https://frontaliereticino.ch');
  url.searchParams.set('application_concierge_service_id', serviceId);
  if (renewal) url.searchParams.set('application_concierge_renewal', '1');
  return autologin?.email && autologin?.autologinCode
    ? makeAuthenticatedUrl(url.toString(), autologin.email, { autologinCode: autologin.autologinCode, sessionGated: 'concierge service requires the recipient owner session' })
    : url.toString();
}

export function buildConciergePaidEmail(service, serviceId, { audience = 'customer', autologin = null } = {}) {
  const locale = Object.hasOwn(COPY, service.locale) ? service.locale : 'it';
  const copy = COPY[locale];
  const owner = audience === 'owner';
  const href = owner ? ADMIN_QUEUE_URL : conciergeServiceUrl(service, serviceId, autologin);
  const price = new Intl.NumberFormat(locale === 'en' ? 'en-IE' : locale, { style: 'currency', currency: 'EUR' }).format((Number(service.amountTotal) || 3999) / 100);
  const subject = owner ? `Nuovo servizio candidatura assistita pagato — ${price}` : copy.subject;
  const body = owner
    ? `Pagamento confermato per il servizio di 30 giorni e fino a 10 posizioni approvate. Cliente: ${service.applicantName || 'dati da completare'}. Email: ${service.customerEmail || service.applicantEmail || 'non disponibile'}. Servizio: ${serviceId}.`
    : copy.body.replace(locale === 'en' ? '€39.99' : '39,99 €', price);
  const cta = owner ? 'Apri la gestione candidature' : copy.cta;
  return { subject, text: `${body}\n\n${cta}: ${href}`, html: renderBrandedEmail({ locale: owner ? 'it' : locale, preheader: subject, badge: 'Candidatura assistita · 30 giorni', heroTitle: subject, bodyHtml: brandParagraph(escapeHtml(body)) + brandButton(href, cta) }) };
}

export async function sendConciergePaidNotifications({ db, serviceId, nowMs = Date.now(), send = sendOrderNotification }) {
  const recordRef = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  const snapshot = await recordRef.get();
  if (!snapshot.exists || snapshot.data()?.paymentStatus !== 'paid') return [];
  const results = [];
  for (const audience of ['customer', 'owner']) {
    results.push(await send({ db, orderId: serviceId, recordRef, nowMs, audience,
      key: `concierge_paid_${audience}`,
      build: (service, options = {}) => buildConciergePaidEmail(service, serviceId, { ...options, audience }),
    }));
  }
  return results;
}

export async function handleConciergeServiceWritten(before, after, serviceId, deps) {
  if (after?.paymentStatus !== 'paid' || before?.paymentStatus === 'paid') return [];
  return sendConciergePaidNotifications({ ...deps, serviceId });
}

export async function sweepConciergePaidNotifications({ db, nowMs = Date.now(), send = sendOrderNotification }) {
  const snapshot = await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).where('paymentStatus', '==', 'paid').get();
  let attempted = 0;
  for (const doc of snapshot.docs || []) {
    const service = doc.data();
    const paidAt = timestampMillis(service.paidAt);
    if (!paidAt || nowMs - paidAt > BACKSTOP_MS) continue;
    if (!['customer', 'owner'].some((audience) => notificationNeedsRetry(service.notifications?.[`concierge_paid_${audience}`], nowMs))) continue;
    await sendConciergePaidNotifications({ db, serviceId: doc.id, nowMs, send });
    attempted += 1;
  }
  return { attempted };
}
