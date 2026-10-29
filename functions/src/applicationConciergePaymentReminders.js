/**
 * Four payment reminders for an unpaid application-concierge checkout.
 *
 * Each checkout is claimed before the email provider is called. A provider
 * failure is retryable; an ambiguous acknowledgement is terminal so a
 * recipient never gets a duplicate reminder. Payment and unsubscribe state
 * are checked again inside the claim transaction.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { bridgeEmailCascadeCredentialsToEnv, getNewsletterSecrets, getAutologinPolicyConfig } from './remoteConfigSecrets.js';
import { isProviderConfigured, PROVIDERS, sendEmailCascade } from './emailCascade.js';
import {
  brandButton,
  brandCallout,
  brandFinePrint,
  brandInfoCard,
  brandLink,
  brandParagraph,
  brandSectionLabel,
  renderBrandedEmail,
} from './assistedApplicationEmailLayout.js';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION } from './applicationConciergeConstants.js';
import { mintAutologinCode, resolveAutologinPolicy } from './lib/autologinCode.js';
import { makeAuthenticatedUrl } from './lib/newsletterUrls.js';
import { forensicsFields } from './lib/requestForensics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 200;
const SERVICE_URLS = Object.freeze({
  it: '/automatizza-ricerca-lavoro-svizzera/',
  en: '/en/automate-job-search-switzerland/',
  de: '/de/arbeitssuche-schweiz-automatisieren/',
  fr: '/fr/automatiser-recherche-emploi-suisse/',
});
const PAYMENT_REMINDER_UNSUBSCRIBE_URL = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/applicationConciergePaymentReminderUnsubscribe/';

export const APPLICATION_CONCIERGE_PAYMENT_REMINDER_STAGES = Object.freeze([3, 7, 14, 30]);

const COPY = Object.freeze({
  it: {
    metrics: ['più velocemente trovi lavoro', 'maggiori possibilità di essere assunto'],
    offer: '€39,99 una tantum · 30 giorni · fino a 10 posizioni approvate · nessun rinnovo.',
    noGuarantee: 'Le statistiche sono indicative: nessun servizio può garantire un’assunzione.',
    unsubscribe: 'Non vuoi altri promemoria? Disiscriviti qui.',
    badge: 'CANDIDATURA ASSISTITA',
    dayLabel: 'GIORNO',
    featuresTitle: 'Tu decidi. Alla parte operativa pensiamo noi.',
    stages: {
      3: {
        subject: 'La tua ricerca di lavoro può partire da qui',
        preheader: 'Tu ci invii il CV. Alla ricerca e alle candidature pensiamo noi.',
        title: 'Tu inviaci il CV. Alla ricerca pensiamo noi.',
        subtitle: 'Puoi ancora completare il servizio di candidatura assistita.',
        body: 'Cerchiamo posizioni in linea con la tua esperienza e ti sottoponiamo quelle più adatte. Dopo la tua approvazione, prepariamo e inviamo la candidatura.',
        highlight: 'Una ricerca seguita per te, senza passare ore a compilare candidature.',
        features: ['Posizioni selezionate in base al tuo profilo', 'CV e lettera di presentazione adattati a ogni ruolo', 'Invio solo dopo la tua approvazione'],
        cta: 'Vai al servizio',
      },
      7: {
        subject: 'Lascia a noi la parte lenta della candidatura',
        preheader: 'Tu valuti le opportunità. Noi prepariamo il materiale su misura.',
        title: 'Meno moduli, più candidature mirate.',
        subtitle: 'Il tuo assistente candidature segue con te ogni passaggio.',
        body: 'Individuiamo le offerte coerenti con il tuo percorso e prepariamo CV e lettera per ciascuna posizione. Tu devi solo dirci quali proposte approvare.',
        highlight: 'Niente candidature inviate alla cieca: ogni proposta passa prima da te.',
        features: ['Dati e documenti calibrati sull’annuncio', 'Nessun profilo da creare sui portali delle aziende', 'Aggiornamenti sugli stati delle candidature'],
        cta: 'Riprendi il percorso',
      },
      14: {
        subject: 'La lingua dell’annuncio non deve fermarti',
        preheader: 'Prepariamo candidature su misura anche per offerte in un’altra lingua.',
        title: 'Tu scegli le opportunità. Ci occupiamo della candidatura.',
        subtitle: 'Anche quando l’annuncio o il portale sono in un’altra lingua.',
        body: 'Interpretiamo i requisiti della posizione, adattiamo CV e lettera al ruolo e gestiamo l’invio dopo il tuo via libera. Le candidature restano mirate: niente invii indiscriminati o registrazioni sui portali aziendali.',
        highlight: 'La tua esperienza viene presentata nel modo più pertinente per ogni ruolo.',
        features: ['Requisiti dell’offerta spiegati chiaramente', 'CV e lettera personalizzati per la candidatura', 'Notifiche quando cambia lo stato della posizione'],
        cta: 'Scopri il servizio',
      },
      30: {
        subject: 'Ultimo promemoria per la candidatura assistita',
        preheader: 'Un solo servizio per 30 giorni: tu approvi, noi seguiamo il processo.',
        title: 'Vuoi che cerchiamo le opportunità per te?',
        subtitle: 'Questo è l’ultimo promemoria sul checkout lasciato in sospeso.',
        body: 'Con il tuo assistente candidature ci invii CV e dati, poi valuti le proposte che troviamo per te. Prepariamo i materiali su misura e seguiamo i passaggi della candidatura che hai approvato.',
        highlight: 'Meno tempo sui moduli. Più attenzione alle posizioni giuste per te.',
        features: ['30 giorni di assistenza', 'Fino a 10 posizioni approvate da te', 'Pagamento unico di €39,99, senza rinnovo'],
        cta: 'Vai alla candidatura assistita',
      },
    },
  },
  en: {
    metrics: ['faster to find a job', 'higher chance of getting hired'],
    offer: '€39.99 one-time · 30 days · up to 10 positions you approve · no renewal.',
    noGuarantee: 'These figures are indicative; no service can guarantee a job offer.',
    unsubscribe: 'Don’t want more reminders? Unsubscribe here.',
    badge: 'ASSISTED APPLICATIONS',
    dayLabel: 'DAY',
    featuresTitle: 'You choose. We handle the application work.',
    stages: {
      3: {
        subject: 'Your job search can start here',
        preheader: 'Send us your CV. We’ll find roles and prepare the applications.',
        title: 'Send us your CV. We’ll do the searching.',
        subtitle: 'You can still complete your assisted-application checkout.',
        body: 'We look for positions that fit your experience and share the best matches with you. Once you approve, we prepare and submit each application.',
        highlight: 'A job search handled for you, without hours spent filling out forms.',
        features: ['Roles matched to your profile', 'A CV and cover letter tailored to each position', 'Applications sent only after your approval'],
        cta: 'View the service',
      },
      7: {
        subject: 'Let us handle the slow parts of applying',
        preheader: 'You review the opportunities. We prepare tailored application materials.',
        title: 'Fewer forms. More relevant applications.',
        subtitle: 'Application Concierge works alongside you, like a personal assistant.',
        body: 'We find openings that fit your background and prepare a tailored CV and cover letter for each one. You only need to approve the opportunities you want to pursue.',
        highlight: 'No applications sent blindly: every opportunity comes to you first.',
        features: ['Your details and documents matched to the listing', 'No profile to create on company job portals', 'Updates on your application status'],
        cta: 'Continue your journey',
      },
      14: {
        subject: 'A job listing in another language need not stop you',
        preheader: 'We tailor applications even when the listing or portal uses another language.',
        title: 'Choose the roles. We’ll prepare the application.',
        subtitle: 'Even when the listing or application portal is in another language.',
        body: 'We interpret the role requirements, tailor your CV and cover letter, and handle submission after you approve. Applications stay targeted, without mass applications or company-portal registrations.',
        highlight: 'Your experience is presented for the role in the clearest, most relevant way.',
        features: ['Clear explanation of job requirements', 'A CV and letter tailored to each application', 'Notifications when a position changes status'],
        cta: 'Explore the service',
      },
      30: {
        subject: 'Final reminder about your assisted-application checkout',
        preheader: 'One service for 30 days: you approve opportunities, we handle the process.',
        title: 'Would you like us to find suitable roles for you?',
        subtitle: 'This is the final reminder about the checkout you left open.',
        body: 'With the concierge, you send us your CV and details, then review the opportunities we find. We tailor the materials and follow the application steps for each role you approve.',
        highlight: 'Less time on forms. More attention for the right opportunities.',
        features: ['30 days of assistance', 'Up to 10 positions approved by you', 'One-time €39.99 payment, no renewal'],
        cta: 'Open assisted applications',
      },
    },
  },
  de: {
    metrics: ['schneller eine Stelle finden', 'höhere Chance auf eine Anstellung'],
    offer: '39,99 € einmalig · 30 Tage · bis zu 10 von dir bestätigte Stellen · keine Verlängerung.',
    noGuarantee: 'Die Angaben sind Richtwerte; eine Anstellung kann kein Dienst garantieren.',
    unsubscribe: 'Keine weiteren Erinnerungen? Hier abmelden.',
    badge: 'BEWERBUNGSASSISTENZ',
    dayLabel: 'TAG',
    featuresTitle: 'Du entscheidest. Wir übernehmen die Bewerbung.',
    stages: {
      3: {
        subject: 'Deine Stellensuche kann hier beginnen',
        preheader: 'Du schickst uns deinen Lebenslauf. Wir suchen passende Stellen.',
        title: 'Schick uns deinen Lebenslauf. Wir suchen für dich.',
        subtitle: 'Du kannst den Checkout für die Bewerbungsassistenz noch abschliessen.',
        body: 'Wir suchen Stellen, die zu deiner Erfahrung passen, und zeigen dir die besten Treffer. Nach deiner Zustimmung bereiten wir die Bewerbung vor und senden sie ab.',
        highlight: 'Eine betreute Stellensuche, ohne stundenlang Formulare auszufüllen.',
        features: ['Stellen passend zu deinem Profil', 'Lebenslauf und Anschreiben für jede Stelle angepasst', 'Versand erst nach deiner Zustimmung'],
        cta: 'Dienst ansehen',
      },
      7: {
        subject: 'Wir übernehmen den langsamen Teil der Bewerbung',
        preheader: 'Du prüfst die Stellen. Wir erstellen passende Bewerbungsunterlagen.',
        title: 'Weniger Formulare. Passendere Bewerbungen.',
        subtitle: 'Application Concierge begleitet dich wie eine persönliche Assistenz.',
        body: 'Wir finden passende Stellen und stimmen Lebenslauf und Anschreiben auf jede Position ab. Du entscheidest nur, welche Vorschläge du weiterverfolgen möchtest.',
        highlight: 'Keine Bewerbung ohne dein Okay: Jede Stelle wird dir zuerst vorgeschlagen.',
        features: ['Angaben und Unterlagen auf die Ausschreibung abgestimmt', 'Kein Profil auf den Firmenportalen nötig', 'Aktuelle Informationen zum Bewerbungsstatus'],
        cta: 'Weiter zum Service',
      },
      14: {
        subject: 'Eine fremdsprachige Anzeige muss dich nicht aufhalten',
        preheader: 'Wir bereiten passende Bewerbungen auch für fremdsprachige Stellen vor.',
        title: 'Du wählst die Stellen. Wir bereiten die Bewerbung vor.',
        subtitle: 'Auch wenn Anzeige oder Bewerbungsportal in einer anderen Sprache sind.',
        body: 'Wir erklären die Anforderungen, passen Lebenslauf und Anschreiben an und übernehmen den Versand nach deiner Freigabe. Keine Massenbewerbungen und keine Registrierung auf Firmenportalen.',
        highlight: 'Deine Erfahrung wird für jede Stelle passend und verständlich dargestellt.',
        features: ['Anforderungen der Stelle verständlich erklärt', 'Lebenslauf und Anschreiben individuell angepasst', 'Mitteilungen, wenn sich der Status ändert'],
        cta: 'Service entdecken',
      },
      30: {
        subject: 'Letzte Erinnerung an deinen Checkout für Bewerbungsassistenz',
        preheader: '30 Tage Unterstützung: Du stimmst Stellen zu, wir kümmern uns um den Ablauf.',
        title: 'Sollen wir passende Stellen für dich suchen?',
        subtitle: 'Dies ist die letzte Erinnerung an den offenen Checkout.',
        body: 'Mit dem Concierge schickst du uns Lebenslauf und Angaben und prüfst danach die Vorschläge. Wir passen die Unterlagen an und übernehmen die Schritte für jede Stelle, die du freigibst.',
        highlight: 'Weniger Zeit mit Formularen. Mehr Zeit für passende Stellen.',
        features: ['30 Tage Unterstützung', 'Bis zu 10 von dir bestätigte Stellen', 'Einmalig 39,99 €, keine Verlängerung'],
        cta: 'Bewerbungsassistenz öffnen',
      },
    },
  },
  fr: {
    metrics: ['plus rapidement pour trouver un emploi', 'plus de chances d’être recruté'],
    offer: '39,99 € en un paiement · 30 jours · jusqu’à 10 postes validés par vous · sans renouvellement.',
    noGuarantee: 'Ces chiffres sont indicatifs ; aucun service ne peut garantir une embauche.',
    unsubscribe: 'Vous ne souhaitez plus de rappels ? Désinscrivez-vous ici.',
    badge: 'CANDIDATURE ACCOMPAGNÉE',
    dayLabel: 'JOUR',
    featuresTitle: 'Vous choisissez. Nous gérons la candidature.',
    stages: {
      3: {
        subject: 'Votre recherche d’emploi peut commencer ici',
        preheader: 'Envoyez-nous votre CV. Nous cherchons les postes et préparons les candidatures.',
        title: 'Envoyez-nous votre CV. Nous cherchons pour vous.',
        subtitle: 'Vous pouvez encore finaliser le paiement du service.',
        body: 'Nous recherchons des postes adaptés à votre expérience et vous présentons les meilleures options. Après votre accord, nous préparons et envoyons la candidature.',
        highlight: 'Une recherche suivie pour vous, sans passer des heures à remplir des formulaires.',
        features: ['Postes adaptés à votre profil', 'CV et lettre personnalisés pour chaque poste', 'Envoi uniquement après votre validation'],
        cta: 'Voir le service',
      },
      7: {
        subject: 'Confiez-nous les étapes les plus lentes',
        preheader: 'Vous examinez les offres. Nous préparons des dossiers sur mesure.',
        title: 'Moins de formulaires. Des candidatures plus ciblées.',
        subtitle: 'Application Concierge vous accompagne comme un assistant personnel.',
        body: 'Nous trouvons les offres correspondant à votre parcours et adaptons le CV et la lettre à chaque poste. Vous validez simplement les opportunités qui vous intéressent.',
        highlight: 'Aucune candidature envoyée à l’aveugle : chaque offre vous est d’abord présentée.',
        features: ['Vos informations adaptées à l’annonce', 'Aucun profil à créer sur les portails des entreprises', 'Des nouvelles sur le statut de vos candidatures'],
        cta: 'Reprendre le parcours',
      },
      14: {
        subject: 'Une annonce dans une autre langue ne doit pas vous arrêter',
        preheader: 'Nous préparons des candidatures sur mesure, même pour les annonces étrangères.',
        title: 'Vous choisissez les postes. Nous préparons votre candidature.',
        subtitle: 'Même si l’annonce ou le portail est dans une autre langue.',
        body: 'Nous clarifions les exigences du poste, adaptons le CV et la lettre, puis gérons l’envoi après votre accord. Pas d’envois massifs ni d’inscription sur les portails des entreprises.',
        highlight: 'Votre expérience est présentée de la façon la plus pertinente pour chaque poste.',
        features: ['Exigences de l’offre expliquées clairement', 'CV et lettre adaptés à chaque candidature', 'Notifications lorsque le statut évolue'],
        cta: 'Découvrir le service',
      },
      30: {
        subject: 'Dernier rappel pour votre paiement en attente',
        preheader: '30 jours d’accompagnement : vous validez les postes, nous gérons les démarches.',
        title: 'Souhaitez-vous que nous cherchions des postes pour vous ?',
        subtitle: 'Ceci est le dernier rappel concernant le paiement interrompu.',
        body: 'Avec le concierge, vous nous transmettez votre CV et vos informations, puis vous examinez les offres trouvées. Nous adaptons les documents et suivons les étapes des candidatures que vous validez.',
        highlight: 'Moins de temps sur les formulaires. Plus d’attention aux bons postes.',
        features: ['30 jours d’accompagnement', 'Jusqu’à 10 postes validés par vous', '39,99 € en un paiement, sans renouvellement'],
        cta: 'Ouvrir le service',
      },
    },
  },
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function timestampMillis(value) {
  if (value == null) return 0;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime() || 0;
  if (value instanceof Date) return value.getTime() || 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function localeFor(value) {
  return Object.hasOwn(COPY, value) ? value : 'it';
}

function stageKey(day) {
  return `day_${day}`;
}

function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function generateApplicationConciergePaymentReminderUnsubToken(uid, secret) {
  return createHmac('sha256', secret)
    .update(`application_concierge_payment_reminder_unsub:${uid}`)
    .digest('hex');
}

function verifyUnsubscribeToken(uid, token, secret) {
  if (!uid || !secret || !/^[a-f0-9]{64}$/i.test(String(token || ''))) return false;
  const expected = generateApplicationConciergePaymentReminderUnsubToken(uid, secret);
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function paymentReminderUrl(uid, secret) {
  const url = new URL(PAYMENT_REMINDER_UNSUBSCRIBE_URL);
  url.searchParams.set('uid', uid);
  url.searchParams.set('token', generateApplicationConciergePaymentReminderUnsubToken(uid, secret));
  return url.toString();
}

function conciergeUrl(locale, serviceId, autologin) {
  const url = new URL(SERVICE_URLS[locale], 'https://frontaliereticino.ch');
  url.searchParams.set('application_concierge_service_id', serviceId);
  url.searchParams.set('utm_source', 'email');
  url.searchParams.set('utm_medium', 'payment_reminder');
  url.searchParams.set('utm_campaign', 'application_concierge');
  if (!autologin?.email || !autologin?.autologinCode) return url.toString();
  return makeAuthenticatedUrl(url.toString(), autologin.email, {
    autologinCode: autologin.autologinCode,
    sessionGated: 'concierge payment recovery requires the recipient owner session',
    utmSource: 'email', utmMedium: 'payment_reminder', utmCampaign: 'application_concierge',
  });
}

function metricsHtml(locale) {
  const [faster, hiring] = COPY[locale].metrics;
  const cell = (value, label) => `<td width="50%" style="padding:16px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;text-align:center;vertical-align:top;">`
    + `<div style="font-size:28px;font-weight:800;line-height:1.1;color:#c2410c;">${value}</div>`
    + `<div style="margin-top:7px;font-size:12px;line-height:1.4;color:#334155;">${escapeHtml(label)}</div></td>`;
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 18px;"><tr>`
    + `${cell('12×', faster)}<td width="12"></td>${cell('3×', hiring)}`
    + '</tr></table>';
}

export function buildApplicationConciergePaymentReminderEmail({ day, locale = 'it', serviceId, unsubscribeUrl, autologin = null } = {}) {
  const safeLocale = localeFor(locale);
  const campaign = COPY[safeLocale];
  const copy = campaign.stages[Number(day)];
  if (!copy || !serviceId || !unsubscribeUrl) throw new Error('invalid_application_concierge_payment_reminder');
  const ctaUrl = conciergeUrl(safeLocale, serviceId, autologin);
  const featureList = `<ul style="margin:0;padding:0 0 0 18px;">${copy.features
    .map((feature) => `<li style="margin:0 0 8px;line-height:1.5;">${escapeHtml(feature)}</li>`)
    .join('')}</ul>`;
  const bodyHtml = [
    brandSectionLabel(campaign.badge),
    brandParagraph(copy.body),
    metricsHtml(safeLocale),
    brandCallout(`<strong>${escapeHtml(copy.highlight)}</strong>`),
    brandInfoCard(campaign.featuresTitle, featureList),
    brandButton(ctaUrl, copy.cta),
    brandFinePrint(escapeHtml(campaign.offer)),
    brandFinePrint(`${escapeHtml(campaign.noGuarantee)} ${brandLink(unsubscribeUrl, campaign.unsubscribe)}`),
  ].join('');
  const text = [
    copy.title,
    copy.subtitle,
    '',
    copy.body,
    '',
    `12× ${campaign.metrics[0]}; 3× ${campaign.metrics[1]}.`,
    copy.highlight,
    ...copy.features.map((feature) => `• ${feature}`),
    '',
    campaign.offer,
    campaign.noGuarantee,
    `${campaign.unsubscribe} ${unsubscribeUrl}`,
    '',
    `${copy.cta}: ${ctaUrl}`,
  ].join('\n');
  return {
    from: 'Il tuo assistente candidature · Frontaliere Ticino <confirmation@frontaliereticino.ch>',
    subject: copy.subject,
    html: renderBrandedEmail({
      locale: safeLocale,
      preheader: copy.preheader,
      badge: `${campaign.badge} · ${campaign.dayLabel} ${day}`,
      heroTitle: copy.title,
      heroSubtitle: copy.subtitle,
      bodyHtml,
    }),
    text,
    ctaUrl,
  };
}

function latestDueStage(createdAtMs, nowMs) {
  return APPLICATION_CONCIERGE_PAYMENT_REMINDER_STAGES
    .filter((day) => createdAtMs + day * DAY_MS <= nowMs)
    .at(-1) || 0;
}

async function claimReminder(db, serviceId, expectedDay, nowMs) {
  const serviceRef = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  return db.runTransaction(async (transaction) => {
    const serviceSnapshot = await transaction.get(serviceRef);
    if (!serviceSnapshot.exists) return { claimed: false, reason: 'service_missing' };
    const service = serviceSnapshot.data() || {};
    const createdAtMs = timestampMillis(service.createdAt);
    const dueDay = latestDueStage(createdAtMs, nowMs);
    const checkoutSessionStatus = String(service.checkoutSessionStatus || '').toLowerCase();
    const recoverable = (service.paymentStatus === 'pending'
        && service.serviceStatus === 'awaiting_payment'
        && !['pending', 'completed'].includes(checkoutSessionStatus))
      || (service.paymentStatus === 'failed'
        && service.serviceStatus === 'payment_failed'
        && checkoutSessionStatus === 'expired');
    if (!recoverable) {
      return { claimed: false, reason: 'payment_or_service_state_changed' };
    }
    if (service.paymentReminderStopped === true || !createdAtMs || dueDay !== expectedDay) {
      return { claimed: false, reason: 'not_due_or_stopped' };
    }
    const uid = String(service.userId || '').trim();
    const email = validEmail(service.customerEmail) || validEmail(service.applicantEmail);
    if (!uid || !email) {
      transaction.update(serviceRef, {
        paymentReminderStopped: true,
        paymentReminderStopReason: uid ? 'missing_recipient' : 'missing_user_id',
        paymentReminderStoppedAt: FieldValue.serverTimestamp(),
      });
      return { claimed: false, reason: 'missing_recipient_or_user' };
    }

    const userRef = db.collection('users').doc(uid);
    const userSnapshot = await transaction.get(userRef);
    if (userSnapshot.data()?.applicationConciergePaymentReminder?.optedOut === true) {
      transaction.update(serviceRef, {
        paymentReminderStopped: true,
        paymentReminderStopReason: 'unsubscribed',
        paymentReminderStoppedAt: FieldValue.serverTimestamp(),
      });
      return { claimed: false, reason: 'unsubscribed' };
    }

    const userServices = await transaction.get(
      db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).where('userId', '==', uid),
    );
    const laterPaidService = userServices.docs.some((snapshot) => {
      if (snapshot.id === serviceId) return false;
      const other = snapshot.data() || {};
      return other.paymentStatus === 'paid' && timestampMillis(other.paidAt) >= createdAtMs;
    });
    if (laterPaidService) {
      transaction.update(serviceRef, {
        paymentReminderStopped: true,
        paymentReminderStopReason: 'another_concierge_service_paid',
        paymentReminderStoppedAt: FieldValue.serverTimestamp(),
      });
      return { claimed: false, reason: 'another_service_paid' };
    }

    const reminders = service.paymentReminderDeliveries || {};
    const key = stageKey(expectedDay);
    const existing = reminders[key] || {};
    if (existing.status === 'sent' || existing.status === 'ambiguous') {
      return { claimed: false, reason: 'already_delivered' };
    }
    if (existing.status === 'sending' && nowMs - timestampMillis(existing.claimedAt) < CLAIM_TTL_MS) {
      return { claimed: false, reason: 'claim_in_progress' };
    }

    const updates = {};
    for (const day of APPLICATION_CONCIERGE_PAYMENT_REMINDER_STAGES) {
      if (day >= expectedDay || createdAtMs + day * DAY_MS > nowMs) continue;
      const earlierKey = stageKey(day);
      const earlier = reminders[earlierKey] || {};
      if (earlier.status === 'sent' || earlier.status === 'ambiguous') continue;
      if (earlier.status === 'sending' && nowMs - timestampMillis(earlier.claimedAt) < CLAIM_TTL_MS) {
        return { claimed: false, reason: 'earlier_claim_in_progress' };
      }
      updates[`paymentReminderDeliveries.${earlierKey}`] = {
        status: 'skipped',
        reason: 'later_reminder_due',
        updatedAt: FieldValue.serverTimestamp(),
      };
    }
    updates[`paymentReminderDeliveries.${key}`] = {
      status: 'sending',
      attempt: (Number(existing.attempt) || 0) + 1,
      claimedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.update(serviceRef, updates);
    return { claimed: true, service, uid, email, locale: localeFor(service.locale), day: expectedDay };
  });
}

async function finishReminder(db, serviceId, day, result, nowMs) {
  const key = stageKey(day);
  const serviceRef = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  const status = result.ambiguous ? 'ambiguous' : result.failed ? 'failed' : 'sent';
  const entry = {
    status,
    updatedAt: FieldValue.serverTimestamp(),
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.messageId ? { messageId: String(result.messageId).slice(0, 200) } : {}),
    ...(result.failed ? { error: 'email_provider_failed' } : {}),
    ...(status === 'sent' || status === 'ambiguous' ? { sentAt: FieldValue.serverTimestamp() } : {}),
  };
  await serviceRef.update({
    [`paymentReminderDeliveries.${key}`]: entry,
    ...(day === 30 && status !== 'failed' ? {
      paymentReminderStatus: 'completed',
      paymentReminderCompletedAt: FieldValue.serverTimestamp(),
    } : {}),
    paymentReminderLastAttemptAt: new Date(nowMs),
  });
}

async function processService(db, document, nowMs, newsletterSecret) {
  const service = document.data() || {};
  const createdAtMs = timestampMillis(service.createdAt);
  const day = latestDueStage(createdAtMs, nowMs);
  if (!day || service.paymentReminderStopped === true || service.paymentReminderStatus === 'completed') {
    return { sent: 0, skipped: 1, failed: 0 };
  }

  const claim = await claimReminder(db, document.id, day, nowMs);
  if (!claim.claimed) return { sent: 0, skipped: 1, failed: 0 };

  let deliveryResult = null;
  let providerCallStarted = false;
  try {
    const policy = resolveAutologinPolicy(await getAutologinPolicyConfig());
    const autologinCode = mintAutologinCode(claim.email, { secret: newsletterSecret, scheme: policy.mintScheme });
    const email = buildApplicationConciergePaymentReminderEmail({
      day,
      locale: claim.locale,
      autologin: { email: claim.email, autologinCode },
      serviceId: document.id,
      unsubscribeUrl: paymentReminderUrl(claim.uid, newsletterSecret),
    });
    const unsubscribeUrl = paymentReminderUrl(claim.uid, newsletterSecret);
    const payload = {
      from: email.from,
      to: [claim.email],
      subject: email.subject,
      html: email.html,
      text: email.text,
      tracking: false,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
    providerCallStarted = true;
    const outcome = await sendEmailCascade([
      { payload, recipient: { email: claim.email }, meta: { orderId: document.id, key: `payment_reminder_${day}` } },
    ], { delayMs: 0 });
    const sent = outcome.sent?.[0] || outcome.accepted?.[0] || {};
    const failed = outcome.failed || [];
    const result = {
      failed: failed.some((item) => !item.ambiguousDelivery),
      ambiguous: (outcome.ambiguous || []).length > 0
        || sent.ack === 'unidentifiable'
        || failed.some((item) => item.ambiguousDelivery),
      provider: sent.provider || null,
      messageId: sent.messageId || null,
    };
    deliveryResult = result;
    await finishReminder(db, document.id, day, result, nowMs);
    return { sent: result.failed ? 0 : 1, skipped: 0, failed: result.failed ? 1 : 0 };
  } catch (error) {
    const fallbackResult = deliveryResult
      ? (deliveryResult.failed
        ? deliveryResult
        : { ...deliveryResult, failed: false, ambiguous: true })
      : providerCallStarted
        ? { ambiguous: true }
        : { failed: true };
    try {
      await finishReminder(db, document.id, day, fallbackResult, nowMs);
    } catch (recordError) {
      console.error('[applicationConciergePaymentReminders] delivery state could not be persisted', {
        serviceId: document.id,
        day,
        errorType: recordError instanceof Error ? recordError.name : 'unknown',
      });
    }
    console.error('[applicationConciergePaymentReminders] send failed', {
      serviceId: document.id,
      day,
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }
}

/** Send the most recent due stage once per unpaid concierge checkout. */
export async function runApplicationConciergePaymentReminderSweep({ db, nowMs = Date.now() } = {}) {
  if (!db) throw new Error('firestore_required');
  await bridgeEmailCascadeCredentialsToEnv();
  const hasProvider = PROVIDERS.some((provider) => isProviderConfigured(provider.id));
  if (!hasProvider) return { scanned: 0, sent: 0, skipped: 0, failed: 0, reason: 'no_email_provider_configured' };
  const { newsletterSecret } = await getNewsletterSecrets();
  if (!newsletterSecret) return { scanned: 0, sent: 0, skipped: 0, failed: 0, reason: 'unsubscribe_secret_unavailable' };

  const collection = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION);
  let cursor = null;
  const summary = { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  while (true) {
    let query = collection.where('serviceStatus', 'in', ['awaiting_payment', 'payment_failed'])
      .orderBy('createdAt', 'asc').limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (let offset = 0; offset < page.docs.length; offset += 5) {
      const batch = page.docs.slice(offset, offset + 5);
      const results = await Promise.all(batch.map((document) => processService(db, document, nowMs, newsletterSecret)));
      for (const result of results) {
        summary.scanned += 1;
        summary.sent += result.sent;
        summary.skipped += result.skipped;
        summary.failed += result.failed;
      }
    }
    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) break;
  }
  return summary;
}

function unsubscribeHtml({ success, title, message }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle} — Frontaliere Ticino</title></head>`
    + '<body style="margin:0;padding:40px 16px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1e293b;">'
    + '<main style="max-width:520px;margin:0 auto;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;text-align:center;">'
    + `<div style="font-size:34px;margin-bottom:10px;">${success ? '✓' : '!'}</div>`
    + `<h1 style="margin:0 0 12px;font-size:23px;">${safeTitle}</h1><p style="margin:0;font-size:15px;line-height:1.6;">${safeMessage}</p>`
    + '</main></body></html>';
}

/** Handle the email-only opt-out for this reminder sequence. */
export async function handleApplicationConciergePaymentReminderUnsubscribe({
  uid,
  token,
  secret,
  forensics,
  db: injectedDb,
} = {}) {
  const db = injectedDb || getAdminDb();
  if (!uid || !verifyUnsubscribeToken(String(uid), token, secret)) {
    return {
      status: 403,
      html: unsubscribeHtml({ success: false, title: 'Link non valido', message: 'Il link di disiscrizione non è valido. Aprilo di nuovo dall’email.' }),
    };
  }
  const userRef = db.collection('users').doc(String(uid));
  await userRef.set({
    applicationConciergePaymentReminder: {
      optedOut: true,
      unsubscribedAt: FieldValue.serverTimestamp(),
      ...forensicsFields(forensics),
    },
  }, { merge: true });
  return {
    status: 200,
    html: unsubscribeHtml({ success: true, title: 'Disiscrizione completata', message: 'Non riceverai altri promemoria per il servizio di candidatura assistita.' }),
  };
}
