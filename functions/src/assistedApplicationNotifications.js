/**
 * Email concierge for the one-off assisted-application service (0,99 €).
 *
 * The product is email-first: the moment Stripe confirms the payment, the
 * customer receives a personal email FROM valerie@frontaliereticino.ch that
 * lists everything needed to apply on their behalf, and Valerie receives an
 * internal notification with the order and a one-click reply to the customer.
 * The customer can simply answer that email with the CV attached (replies to
 * valerie@ are always forwarded to the human inbox by
 * infra/cloudflare-email-worker/stop-reply-handler.js); the upload page stays
 * available as the second path.
 *
 * Every message is keyed (`notifications.<key>` on the order) and claimed in a
 * transaction before the provider is called, so the at-least-once Firestore
 * trigger, the hourly backstop and the owner's recovery script can all run
 * against the same order without sending twice. A provider failure releases
 * the claim (`failed`, retryable); a provider-accepted send without a durable
 * id is `ambiguous` and never retried automatically.
 */

import admin from 'firebase-admin';
import { bridgeEmailCascadeCredentialsToEnv } from './remoteConfigSecrets.js';
import { sendEmailCascade, PROVIDERS, isProviderConfigured } from './emailCascade.js';
import {
  ASSISTED_APPLICATIONS_COLLECTION,
  ASSISTED_APPLICATION_PRICE_EUR_CENTS,
} from './assistedApplicationConstants.js';
import { checkAssistedApplicationCv } from './assistedApplicationCvCheck.js';

export const ASSISTED_APPLICATION_SENDER = 'Valerie · Frontaliere Ticino <valerie@frontaliereticino.ch>';
export const ASSISTED_APPLICATION_OWNER_EMAIL = 'valerie@frontaliereticino.ch';
const INTERNAL_SENDER = 'Candidatura assistita <confirmation@frontaliereticino.ch>';
const SITE_ORIGIN = 'https://frontaliereticino.ch';
const TRUSTED_HOSTS = new Set(['frontaliereticino.ch', 'www.frontaliereticino.ch']);
const LOCALES = ['it', 'en', 'de', 'fr'];

/** Section roots that mount the JobBoard (see scripts/lib/jobBoardSections.mjs). */
const JOB_BOARD_ROOT_BY_LOCALE = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
};

/** Admin panel slug (services/routeSlugs.data.ts `admin`), owner-only. */
const ADMIN_QUEUE_URL = `${SITE_ORIGIN}/gestione-contenuti-xk9mp2q/`;

/** Claims older than this are considered abandoned by a crashed process. */
const CLAIM_TTL_MS = 10 * 60 * 1000;
/** Automatic sends only look this far back: older orders need the recovery script. */
export const INTRO_BACKSTOP_WINDOW_MS = 72 * 60 * 60 * 1000;
export const MATERIALS_REMINDER_DELAY_MS = 48 * 60 * 60 * 1000;
export const MATERIALS_REMINDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Message keys. Each one is sent at most once per order.
 * `audience` decides the recipient; `customer_intro` and `customer_recovery`
 * share the same content slot, so the recovery email counts as the intro.
 */
export const NOTIFICATION_KEYS = Object.freeze({
  customerIntro: 'customer_intro',
  ownerNewOrder: 'owner_new_order',
  customerReminder: 'customer_materials_reminder',
  customerMaterialsReceived: 'customer_materials_received',
  ownerMaterialsUploaded: 'owner_materials_uploaded',
  customerSubmitted: 'customer_submitted',
});

const CUSTOMER_KEYS = new Set([
  NOTIFICATION_KEYS.customerIntro,
  NOTIFICATION_KEYS.customerReminder,
  NOTIFICATION_KEYS.customerMaterialsReceived,
  NOTIFICATION_KEYS.customerSubmitted,
]);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clean(value, max = 300) {
  const result = String(value ?? '').replace(/\s+/g, ' ').trim();
  return result.length > max ? `${result.slice(0, max - 1)}…` : result;
}

function timestampMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value.toDate === 'function') {
    const millis = value.toDate().getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/** Locale of an order: explicit field, else the prefix of its return path. */
export function resolveOrderLocale(order) {
  if (LOCALES.includes(order?.locale)) return order.locale;
  try {
    const path = new URL(String(order?.orderPageUrl || '')).pathname;
    const prefix = path.split('/')[1];
    if (LOCALES.includes(prefix)) return prefix;
  } catch {
    // fall through
  }
  return 'it';
}

/**
 * Locale implied by a site return URL (`/en/…`, `/de/…`, `/fr/…`, else it).
 * Only frontaliereticino.ch URLs count; anything else yields null.
 */
export function localeFromSiteUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !TRUSTED_HOSTS.has(url.hostname)) return null;
    const prefix = url.pathname.split('/')[1];
    return LOCALES.includes(prefix) ? prefix : 'it';
  } catch {
    return null;
  }
}

/**
 * The page where the customer resumes the order. Only a same-site return URL
 * is trusted (a client could otherwise plant any link in an email we sign as
 * Valerie); everything else falls back to the locale's job-board root, which
 * mounts the same upload page for `?assisted_application_order_id=`.
 */
export function buildOrderPageUrl(order, orderId, locale = resolveOrderLocale(order)) {
  let base = `${SITE_ORIGIN}${JOB_BOARD_ROOT_BY_LOCALE[locale] || JOB_BOARD_ROOT_BY_LOCALE.it}`;
  try {
    const stored = new URL(String(order?.orderPageUrl || ''));
    if (stored.protocol === 'https:' && TRUSTED_HOSTS.has(stored.hostname)) {
      base = `${SITE_ORIGIN}${stored.pathname}`;
    }
  } catch {
    // keep the locale root
  }
  const url = new URL(base);
  url.searchParams.set('assisted_application_order_id', String(orderId));
  return url.toString();
}

/** Where the customer is reachable: the address typed in the form wins over Stripe's. */
export function customerEmailFor(order) {
  const candidates = [order?.applicantEmail, order?.customerEmail];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320) return value;
  }
  return '';
}

/** The price is in EUR: format it the euro-area way ("0,99 €"), not the Swiss one. */
const INTL_LOCALE = { it: 'it-IT', fr: 'fr-FR', de: 'de-DE', en: 'en-IE' };

function formatPrice(order, locale) {
  const cents = Number.isFinite(Number(order?.amountTotal))
    ? Number(order.amountTotal)
    : ASSISTED_APPLICATION_PRICE_EUR_CENTS;
  const currency = String(order?.currency || 'eur').toUpperCase();
  try {
    return new Intl.NumberFormat(INTL_LOCALE[locale] || 'it-IT', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function formatDate(millis, locale) {
  try {
    return new Intl.DateTimeFormat(INTL_LOCALE[locale] || 'it-IT', { dateStyle: 'long', timeZone: 'Europe/Zurich' })
      .format(new Date(millis));
  } catch {
    return new Date(millis).toISOString().slice(0, 10);
  }
}

// ── Customer copy ─────────────────────────────────────────────────────────
// Written in Valerie's first person: the email is the start of a real
// conversation, not a receipt. Placeholders: {job}, {company}, {price}, {date}.

const COPY = {
  it: {
    greeting: (name) => (name ? `Ciao ${name},` : 'Ciao,'),
    introSubject: 'La tua candidatura per {job}: cosa mi serve per inviarla',
    recoverySubject: 'La tua candidatura per {job}: riprendiamo da qui',
    introLead: 'sono Valerie di Frontaliere Ticino. Ho ricevuto il tuo pagamento di {price} per la candidatura assistita a questo annuncio:',
    recoveryLead: 'sono Valerie di Frontaliere Ticino. Ti scrivo con qualche giorno di ritardo e me ne scuso: dopo il tuo pagamento di {price} un problema tecnico del nostro sito ha impedito il caricamento del CV, quindi non ho ancora ricevuto i tuoi documenti. Il problema è stato risolto e la tua candidatura è ancora in carico a me:',
    jobLink: "Vedi l'annuncio",
    needTitle: 'Per preparare e inviare la candidatura al posto tuo mi servono:',
    needs: [
      'il tuo CV (PDF, DOC o DOCX);',
      "nome e cognome, telefono ed email da indicare all'azienda;",
      'il tuo permesso di lavoro in Svizzera (per esempio G o B) oppure la tua nazionalità;',
      'da quando sei disponibile e se cerchi un tempo pieno o parziale;',
      'le lingue che parli e il livello;',
      "facoltativi: pretesa salariale, lettera di motivazione, diplomi o certificati di lavoro richiesti dall'annuncio. Se non hai una lettera, la preparo io.",
    ],
    replyTitle: 'Il modo più semplice: rispondi a questa email',
    replyBody: 'allegando il CV e scrivendo le informazioni qui sopra.',
    uploadAlt: "In alternativa puoi caricare il CV dalla pagina del tuo ordine, accedendo con lo stesso account usato per il pagamento:",
    uploadCta: 'Apri il tuo ordine',
    nextTitle: 'Cosa succede dopo',
    nextBody: "Entro 2 giorni lavorativi dalla ricezione dei documenti preparo la candidatura e la invio all'azienda attraverso il canale indicato nell'annuncio (portale o email). Ti scrivo appena è inviata. Se l'annuncio è chiuso o l'invio non è possibile, ti rimborso i {price}.",
    recoveryOut: "Se l'annuncio non ti interessa più, rispondimi con «rimborso» e ti restituisco i {price}; se preferisci, posso usare il pagamento per un annuncio simile che mi indichi tu.",
    noGuarantee: "Non posso garantire una risposta, un colloquio o l'assunzione: Frontaliere Ticino non è affiliato all'azienda.",
    signature: 'Valerie',
    orderRef: 'Riferimento ordine',
    privacy: "I tuoi dati servono solo per questa candidatura e vengono cancellati entro 90 giorni dall'invio o dal rimborso. Per accesso, rettifica o cancellazione rispondi a questa email.",
    reminderSubject: 'Promemoria: mi servono i documenti per la tua candidatura a {job}',
    reminderLead: "ti ricordo che per inviare la tua candidatura a {job} presso {company} mi mancano ancora il CV e qualche informazione. Basta rispondere a questa email con il CV allegato: ci penso io al resto.",
    reminderOut: "Se nel frattempo hai cambiato idea, rispondi con «rimborso» e ti restituisco i {price}.",
    receivedSubject: 'Ho ricevuto il tuo CV per {job}',
    receivedLead: "ho ricevuto il tuo CV e il mandato per la candidatura a {job} presso {company}. Preparo la candidatura e ti scrivo appena la invio, entro 2 giorni lavorativi. Se vuoi aggiungere qualcosa (lettera, certificati, disponibilità), rispondi pure a questa email.",
    submittedSubject: 'Ho inviato la tua candidatura a {company}',
    submittedLead: "ti confermo che il {date} ho inviato la tua candidatura per {job} presso {company}, attraverso il canale indicato nell'annuncio.",
    submittedNext: "Se l'azienda ti contatta, rispondi direttamente a loro. Se ricevi una risposta o hai bisogno di altro, scrivimi pure rispondendo a questa email. In bocca al lupo!",
  },
  fr: {
    greeting: (name) => (name ? `Bonjour ${name},` : 'Bonjour,'),
    introSubject: "Votre candidature pour {job} : ce dont j'ai besoin pour l'envoyer",
    recoverySubject: 'Votre candidature pour {job} : reprenons ici',
    introLead: "je suis Valerie de Frontaliere Ticino. J'ai bien reçu votre paiement de {price} pour la candidature assistée à cette annonce :",
    recoveryLead: "je suis Valerie de Frontaliere Ticino. Je vous écris avec quelques jours de retard, et je vous prie de m'en excuser : après votre paiement de {price}, un problème technique de notre site a empêché l'envoi du CV, je n'ai donc pas encore reçu vos documents. Le problème est corrigé et je m'occupe toujours de votre candidature :",
    jobLink: "Voir l'annonce",
    needTitle: "Pour préparer et envoyer la candidature à votre place, j'ai besoin de :",
    needs: [
      'votre CV (PDF, DOC ou DOCX) ;',
      "vos nom et prénom, téléphone et e-mail à communiquer à l'entreprise ;",
      'votre permis de travail en Suisse (par exemple G ou B) ou votre nationalité ;',
      'votre date de disponibilité et si vous cherchez un temps plein ou partiel ;',
      'les langues que vous parlez et votre niveau ;',
      "facultatif : prétentions salariales, lettre de motivation, diplômes ou certificats de travail demandés par l'annonce. Si vous n'avez pas de lettre, je la prépare.",
    ],
    replyTitle: 'Le plus simple : répondez à cet e-mail',
    replyBody: 'en joignant votre CV et en indiquant les informations ci-dessus.',
    uploadAlt: 'Vous pouvez aussi déposer votre CV depuis la page de votre commande, avec le même compte que pour le paiement :',
    uploadCta: 'Ouvrir ma commande',
    nextTitle: 'La suite',
    nextBody: "Dans les 2 jours ouvrables suivant la réception de vos documents, je prépare la candidature et je l'envoie à l'entreprise par le canal indiqué dans l'annonce (portail ou e-mail). Je vous écris dès qu'elle est envoyée. Si l'annonce est fermée ou si l'envoi est impossible, je vous rembourse les {price}.",
    recoveryOut: "Si l'annonce ne vous intéresse plus, répondez « remboursement » et je vous rends les {price} ; si vous préférez, je peux utiliser ce paiement pour une annonce similaire que vous m'indiquez.",
    noGuarantee: "Je ne peux garantir ni réponse, ni entretien, ni embauche : Frontaliere Ticino n'est pas affilié à l'entreprise.",
    signature: 'Valerie',
    orderRef: 'Référence de commande',
    privacy: "Vos données servent uniquement à cette candidature et sont supprimées dans les 90 jours suivant l'envoi ou le remboursement. Pour y accéder, les corriger ou les supprimer, répondez à cet e-mail.",
    reminderSubject: "Rappel : j'ai besoin de vos documents pour la candidature à {job}",
    reminderLead: "petit rappel : pour envoyer votre candidature à {job} chez {company}, il me manque encore votre CV et quelques informations. Il suffit de répondre à cet e-mail avec le CV en pièce jointe, je m'occupe du reste.",
    reminderOut: 'Si vous avez changé d’avis entre-temps, répondez « remboursement » et je vous rends les {price}.',
    receivedSubject: "J'ai bien reçu votre CV pour {job}",
    receivedLead: "j'ai bien reçu votre CV et votre mandat pour la candidature à {job} chez {company}. Je prépare la candidature et je vous écris dès qu'elle est envoyée, dans les 2 jours ouvrables. Pour ajouter quelque chose (lettre, certificats, disponibilités), répondez simplement à cet e-mail.",
    submittedSubject: "J'ai envoyé votre candidature à {company}",
    submittedLead: "je vous confirme que le {date} j'ai envoyé votre candidature pour {job} chez {company}, par le canal indiqué dans l'annonce.",
    submittedNext: "Si l'entreprise vous contacte, répondez-lui directement. Si vous recevez une réponse ou avez besoin d'autre chose, écrivez-moi en répondant à cet e-mail. Bonne chance !",
  },
  de: {
    // Informal «du», like the German site copy (services/locales/de-core.ts).
    greeting: (name) => (name ? `Hallo ${name},` : 'Hallo,'),
    introSubject: 'Deine Bewerbung für {job}: was ich für den Versand brauche',
    recoverySubject: 'Deine Bewerbung für {job}: so geht es weiter',
    introLead: 'ich bin Valerie von Frontaliere Ticino. Ich habe deine Zahlung von {price} für die begleitete Bewerbung auf diese Stelle erhalten:',
    recoveryLead: 'ich bin Valerie von Frontaliere Ticino. Ich melde mich mit einigen Tagen Verspätung und entschuldige mich dafür: Nach deiner Zahlung von {price} hat ein technisches Problem unserer Website das Hochladen des Lebenslaufs verhindert, deshalb habe ich deine Unterlagen noch nicht erhalten. Das Problem ist behoben und ich kümmere mich weiterhin um deine Bewerbung:',
    jobLink: 'Zur Stellenanzeige',
    needTitle: 'Um die Bewerbung für dich vorzubereiten und zu versenden, brauche ich:',
    needs: [
      'deinen Lebenslauf (PDF, DOC oder DOCX);',
      'Vor- und Nachname, Telefon und E-Mail für das Unternehmen;',
      'deine Arbeitsbewilligung in der Schweiz (zum Beispiel G oder B) oder deine Staatsangehörigkeit;',
      'ab wann du verfügbar bist und ob du Voll- oder Teilzeit suchst;',
      'deine Sprachen und das jeweilige Niveau;',
      'optional: Lohnvorstellung, Motivationsschreiben, Diplome oder Arbeitszeugnisse, falls die Anzeige sie verlangt. Wenn du kein Motivationsschreiben hast, schreibe ich es.',
    ],
    replyTitle: 'Am einfachsten: Antworte auf diese E-Mail',
    replyBody: 'mit deinem Lebenslauf im Anhang und den Angaben oben.',
    uploadAlt: 'Alternativ kannst du den Lebenslauf auf der Seite deiner Bestellung hochladen, mit demselben Konto wie bei der Zahlung:',
    uploadCta: 'Bestellung öffnen',
    nextTitle: 'Wie es weitergeht',
    nextBody: 'Innerhalb von 2 Arbeitstagen nach Erhalt deiner Unterlagen bereite ich die Bewerbung vor und sende sie über den in der Anzeige genannten Kanal (Portal oder E-Mail) an das Unternehmen. Ich schreibe dir, sobald sie versendet ist. Ist die Stelle geschlossen oder der Versand nicht möglich, erstatte ich dir die {price}.',
    recoveryOut: 'Falls dich die Stelle nicht mehr interessiert, antworte mit «Rückerstattung» und du bekommst die {price} zurück; wenn du willst, nutze ich die Zahlung auch für eine ähnliche Stelle, die du mir nennst.',
    noGuarantee: 'Ich kann keine Antwort, kein Vorstellungsgespräch und keine Anstellung garantieren: Frontaliere Ticino ist nicht mit dem Unternehmen verbunden.',
    signature: 'Valerie',
    orderRef: 'Bestellreferenz',
    privacy: 'Deine Daten werden nur für diese Bewerbung verwendet und spätestens 90 Tage nach Versand oder Rückerstattung gelöscht. Für Auskunft, Berichtigung oder Löschung antworte auf diese E-Mail.',
    reminderSubject: 'Erinnerung: Ich brauche deine Unterlagen für die Bewerbung auf {job}',
    reminderLead: 'eine kurze Erinnerung: Für deine Bewerbung auf {job} bei {company} fehlen mir noch dein Lebenslauf und einige Angaben. Antworte einfach auf diese E-Mail mit dem Lebenslauf im Anhang, um den Rest kümmere ich mich.',
    reminderOut: 'Falls du es dir anders überlegt hast, antworte mit «Rückerstattung» und du bekommst die {price} zurück.',
    receivedSubject: 'Ich habe deinen Lebenslauf für {job} erhalten',
    receivedLead: 'ich habe deinen Lebenslauf und den Auftrag für die Bewerbung auf {job} bei {company} erhalten. Ich bereite die Bewerbung vor und melde mich, sobald sie versendet ist, innerhalb von 2 Arbeitstagen. Wenn du etwas ergänzen möchtest (Motivationsschreiben, Zeugnisse, Verfügbarkeit), antworte einfach auf diese E-Mail.',
    submittedSubject: 'Ich habe deine Bewerbung an {company} gesendet',
    submittedLead: 'hiermit bestätige ich, dass ich deine Bewerbung für {job} bei {company} am {date} über den in der Anzeige genannten Kanal versendet habe.',
    submittedNext: 'Wenn sich das Unternehmen meldet, antworte bitte direkt. Wenn du eine Antwort erhältst oder noch etwas brauchst, schreib mir einfach auf diese E-Mail. Viel Erfolg!',
  },
  en: {
    greeting: (name) => (name ? `Hi ${name},` : 'Hi,'),
    introSubject: 'Your application for {job}: what I need to send it',
    recoverySubject: 'Your application for {job}: picking up from here',
    introLead: "I'm Valerie from Frontaliere Ticino. I received your payment of {price} for the assisted application to this job:",
    recoveryLead: "I'm Valerie from Frontaliere Ticino. I'm writing a few days late, and I apologise: after your payment of {price}, a technical problem on our site blocked the CV upload, so I haven't received your documents yet. The problem is fixed and I'm still handling your application:",
    jobLink: 'See the job ad',
    needTitle: 'To prepare and send the application on your behalf I need:',
    needs: [
      'your CV (PDF, DOC or DOCX);',
      'your full name, phone number and email to give the company;',
      'your Swiss work permit (for example G or B) or your nationality;',
      'when you can start and whether you want full-time or part-time work;',
      'the languages you speak and your level;',
      "optional: salary expectation, cover letter, diplomas or work certificates the ad asks for. If you don't have a cover letter, I'll write it.",
    ],
    replyTitle: 'The easiest way: reply to this email',
    replyBody: 'with your CV attached and the information above.',
    uploadAlt: 'Alternatively you can upload your CV from your order page, signing in with the same account you used to pay:',
    uploadCta: 'Open my order',
    nextTitle: 'What happens next',
    nextBody: "Within 2 working days of receiving your documents I prepare the application and send it to the company through the channel the ad asks for (portal or email). I'll write to you as soon as it's sent. If the ad is closed or the application can't be sent, I'll refund your {price}.",
    recoveryOut: "If you're no longer interested in this job, reply «refund» and I'll give you back the {price}; if you prefer, I can use the payment for a similar job you point me to.",
    noGuarantee: "I can't guarantee a reply, an interview or a job: Frontaliere Ticino is not affiliated with the company.",
    signature: 'Valerie',
    orderRef: 'Order reference',
    privacy: 'Your data is used only for this application and deleted within 90 days of sending or refund. For access, correction or deletion, reply to this email.',
    reminderSubject: 'Reminder: I need your documents for the {job} application',
    reminderLead: "a quick reminder: to send your application for {job} at {company} I still need your CV and a few details. Just reply to this email with your CV attached and I'll take care of the rest.",
    reminderOut: "If you've changed your mind, reply «refund» and I'll give you back the {price}.",
    receivedSubject: 'I received your CV for {job}',
    receivedLead: "I received your CV and your mandate for the application to {job} at {company}. I'm preparing the application and will write as soon as it's sent, within 2 working days. If you want to add anything (cover letter, certificates, availability), just reply to this email.",
    submittedSubject: 'I sent your application to {company}',
    submittedLead: 'I can confirm that on {date} I sent your application for {job} at {company}, through the channel the ad asks for.',
    submittedNext: "If the company contacts you, reply to them directly. If you hear back or need anything else, just reply to this email. Good luck!",
  },
};

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] ?? ''));
}

function fillHtml(template, vars) {
  return esc(String(template)).replace(/\{(\w+)\}/g, (_, key) => (
    key === 'job' || key === 'company' ? `<strong>${esc(vars[key] ?? '')}</strong>` : esc(vars[key] ?? '')
  ));
}

function paragraph(html) {
  return `<p style="margin:0 0 14px;line-height:1.55">${html}</p>`;
}

function shell(bodyHtml) {
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;'
    + 'font-size:15px;color:#1f2933;max-width:560px">'
    + bodyHtml
    + '</div>';
}

function orderVars(order, orderId, locale, nowMs) {
  return {
    job: clean(order?.jobTitle, 200) || '—',
    company: clean(order?.companyName, 200) || '—',
    price: formatPrice(order, locale),
    date: formatDate(timestampMillis(order?.submittedAt) || nowMs, locale),
    orderId: String(orderId),
  };
}

function jobBlock(order, copy, vars) {
  const jobUrl = safeHttpsUrl(order?.jobUrl);
  const html = `<div style="margin:0 0 16px;padding:12px 14px;border:1px solid #d9e2ec;border-radius:10px">`
    + `<strong>${esc(vars.job)}</strong><br>${esc(vars.company)}`
    + (jobUrl ? `<br><a href="${esc(jobUrl)}">${esc(copy.jobLink)}</a>` : '')
    + '</div>';
  const text = `${vars.job}\n${vars.company}${jobUrl ? `\n${copy.jobLink}: ${jobUrl}` : ''}`;
  return { html, text };
}

function footer(copy, vars) {
  const html = paragraph(esc(copy.signature))
    + `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#52606d">`
    + `Frontaliere Ticino · <a href="${SITE_ORIGIN}/">frontaliereticino.ch</a><br>`
    + `${esc(copy.orderRef)}: ${esc(vars.orderId)}<br>${esc(copy.privacy)}</p>`;
  const text = `${copy.signature}\n\n--\nFrontaliere Ticino · ${SITE_ORIGIN}/\n${copy.orderRef}: ${vars.orderId}\n${copy.privacy}`;
  return { html, text };
}

/**
 * Build a customer-facing message.
 * @param {'intro'|'recovery'|'reminder'|'received'|'submitted'} kind
 * @returns {{subject:string, html:string, text:string, locale:string}}
 */
export function buildCustomerEmail(kind, order, orderId, { nowMs = Date.now() } = {}) {
  const locale = resolveOrderLocale(order);
  const copy = COPY[locale] || COPY.it;
  const vars = orderVars(order, orderId, locale, nowMs);
  const greeting = copy.greeting(clean(order?.applicantName, 80).split(' ')[0] || '');
  const pageUrl = buildOrderPageUrl(order, orderId, locale);
  const job = jobBlock(order, copy, vars);
  const foot = footer(copy, vars);
  const htmlParts = [paragraph(esc(greeting))];
  const textParts = [greeting];

  if (kind === 'intro' || kind === 'recovery') {
    const lead = kind === 'recovery' ? copy.recoveryLead : copy.introLead;
    htmlParts.push(paragraph(fillHtml(lead, vars)), job.html);
    textParts.push(fill(lead, vars), job.text);
    htmlParts.push(paragraph(esc(copy.needTitle)));
    htmlParts.push(`<ol style="margin:0 0 16px;padding-left:20px;line-height:1.55">${copy.needs.map((item) => `<li>${esc(item)}</li>`).join('')}</ol>`);
    textParts.push(copy.needTitle, copy.needs.map((item, index) => `${index + 1}. ${item}`).join('\n'));
    htmlParts.push(paragraph(`<strong>${esc(copy.replyTitle)}</strong> ${esc(copy.replyBody)}`));
    textParts.push(`${copy.replyTitle} ${copy.replyBody}`);
    htmlParts.push(paragraph(`${esc(copy.uploadAlt)}<br><a href="${esc(pageUrl)}">${esc(copy.uploadCta)}</a>`));
    textParts.push(`${copy.uploadAlt}\n${pageUrl}`);
    htmlParts.push(paragraph(`<strong>${esc(copy.nextTitle)}</strong><br>${fillHtml(copy.nextBody, vars)}`));
    textParts.push(`${copy.nextTitle}\n${fill(copy.nextBody, vars)}`);
    if (kind === 'recovery') {
      htmlParts.push(paragraph(fillHtml(copy.recoveryOut, vars)));
      textParts.push(fill(copy.recoveryOut, vars));
    }
    htmlParts.push(paragraph(esc(copy.noGuarantee)));
    textParts.push(copy.noGuarantee);
  } else if (kind === 'reminder') {
    htmlParts.push(paragraph(fillHtml(copy.reminderLead, vars)), job.html);
    textParts.push(fill(copy.reminderLead, vars), job.text);
    htmlParts.push(paragraph(`${esc(copy.uploadAlt)}<br><a href="${esc(pageUrl)}">${esc(copy.uploadCta)}</a>`));
    textParts.push(`${copy.uploadAlt}\n${pageUrl}`);
    htmlParts.push(paragraph(fillHtml(copy.reminderOut, vars)));
    textParts.push(fill(copy.reminderOut, vars));
  } else if (kind === 'received') {
    htmlParts.push(paragraph(fillHtml(copy.receivedLead, vars)));
    textParts.push(fill(copy.receivedLead, vars));
  } else if (kind === 'submitted') {
    htmlParts.push(paragraph(fillHtml(copy.submittedLead, vars)), job.html);
    textParts.push(fill(copy.submittedLead, vars), job.text);
    htmlParts.push(paragraph(esc(copy.submittedNext)), paragraph(esc(copy.noGuarantee)));
    textParts.push(copy.submittedNext, copy.noGuarantee);
  } else {
    throw new Error(`unknown_assisted_application_email:${kind}`);
  }

  const subjectTemplate = {
    intro: copy.introSubject,
    recovery: copy.recoverySubject,
    reminder: copy.reminderSubject,
    received: copy.receivedSubject,
    submitted: copy.submittedSubject,
  }[kind];

  htmlParts.push(foot.html);
  textParts.push(foot.text);
  return {
    subject: clean(fill(subjectTemplate, vars), 180),
    html: shell(htmlParts.join('')),
    text: textParts.join('\n\n'),
    locale,
  };
}

// ── Owner copy (Italian, operational) ─────────────────────────────────────

/**
 * @param {'new_order'|'materials_uploaded'} kind
 */
export function buildOwnerEmail(kind, order, orderId, { nowMs = Date.now(), customerKey = null } = {}) {
  const locale = resolveOrderLocale(order);
  const vars = orderVars(order, orderId, locale, nowMs);
  const customerEmail = customerEmailFor(order);
  const customerSubject = customerKey === 'recovery'
    ? fill(COPY[locale].recoverySubject, vars)
    : fill(COPY[locale].introSubject, vars);
  const mailto = customerEmail
    ? `mailto:${encodeURIComponent(customerEmail)}?subject=${encodeURIComponent(`Re: ${customerSubject}`)}`
    : '';
  const jobUrl = safeHttpsUrl(order?.jobUrl);
  const paidAt = timestampMillis(order?.paidAt);
  const rows = [
    ['Annuncio', `${vars.job} — ${vars.company}`],
    ['Link annuncio', jobUrl || '—'],
    ['Cliente', customerEmail || 'email non disponibile'],
    ['Nome', clean(order?.applicantName, 120) || '—'],
    ['Telefono', clean(order?.applicantPhone, 60) || '—'],
    ['Lingua cliente', locale],
    ['Pagato', `${vars.price}${paidAt ? ` il ${new Date(paidAt).toISOString().replace('T', ' ').slice(0, 16)} UTC` : ''}`],
    ['CV caricato sul sito', order?.cvStorageKey ? 'sì (scaricalo dalla coda admin)' : 'no'],
    ['Ordine', String(orderId)],
  ];
  const subject = kind === 'materials_uploaded'
    ? `CV caricato — ${vars.job} (${vars.company})`
    : `Nuova candidatura assistita pagata — ${vars.job} (${vars.company})`;
  const lead = kind === 'materials_uploaded'
    ? 'Il cliente ha caricato CV e dati dalla pagina dell’ordine. La candidatura è in coda come «Pronta per invio».'
    : 'Pagamento confermato da Stripe. Al cliente è partita (o sta partendo) l’email da valerie@ con la checklist dei documenti: le sue risposte arrivano nella tua inbox.';
  const todo = kind === 'materials_uploaded'
    ? 'Da fare: scarica il CV dalla coda admin, invia la candidatura e segna «Inviata» (parte in automatico l’email di conferma al cliente).'
    : 'Da fare: quando ricevi i documenti via email, segna «Materiali ricevuti» nella coda admin (ferma il promemoria automatico a 48 h); dopo l’invio segna «Inviata» (parte l’email di conferma al cliente).';

  const htmlRows = rows.map(([label, value]) => (
    `<tr><td style="padding:4px 12px 4px 0;color:#52606d;vertical-align:top">${esc(label)}</td>`
    + `<td style="padding:4px 0">${label === 'Link annuncio' && jobUrl ? `<a href="${esc(jobUrl)}">${esc(jobUrl)}</a>` : esc(value)}</td></tr>`
  )).join('');
  const html = shell(
    paragraph(esc(lead))
    + `<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px">${htmlRows}</table>`
    + (mailto ? paragraph(`<a href="${esc(mailto)}">Rispondi al cliente</a>`) : '')
    + paragraph(`<a href="${ADMIN_QUEUE_URL}">Apri la coda «Candidature» nel pannello admin</a>`)
    + paragraph(esc(todo)),
  );
  const text = [
    lead,
    rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
    mailto ? `Rispondi al cliente: ${customerEmail}` : '',
    `Coda admin: ${ADMIN_QUEUE_URL} (sezione «Candidature»)`,
    todo,
  ].filter(Boolean).join('\n\n');
  return { subject: clean(subject, 180), html, text };
}

// ── Sending with an idempotent claim ──────────────────────────────────────

function orderRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
}

async function claimNotification(db, orderRef, key, nowMs, { force = false } = {}) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists) return { ok: false, reason: 'order_not_found' };
    const order = snapshot.data() || {};
    const current = order.notifications?.[key] || null;
    if (current?.status === 'sent' || current?.status === 'ambiguous') {
      return { ok: false, reason: `already_${current.status}`, order };
    }
    const claimedAt = timestampMillis(current?.claimedAt);
    if (!force && current?.status === 'sending' && claimedAt && nowMs - claimedAt < CLAIM_TTL_MS) {
      return { ok: false, reason: 'in_flight', order };
    }
    transaction.set(orderRef, {
      notifications: {
        [key]: {
          status: 'sending',
          claimedAt: new Date(nowMs),
          attempts: Number(current?.attempts || 0) + 1,
        },
      },
    }, { merge: true });
    return { ok: true, order };
  });
}

async function markNotification(orderRef, key, fields) {
  await orderRef.set({ notifications: { [key]: fields } }, { merge: true });
}

async function ensureEmailProviders() {
  await bridgeEmailCascadeCredentialsToEnv();
  return PROVIDERS.some((provider) => isProviderConfigured(provider.id));
}

/**
 * Send one keyed message for one order, at most once.
 *
 * @param {object} args
 * @param {FirebaseFirestore.Firestore} args.db
 * @param {string} args.orderId
 * @param {string} args.key  one of NOTIFICATION_KEYS
 * @param {(order: object) => {subject:string, html:string, text:string}} args.build
 * @param {string} [args.recipientOverride] send to this address instead (test mode:
 *   nothing is recorded on the order, so the real send stays possible)
 * @param {object} [args.meta] extra fields recorded next to the send (e.g. variant)
 * @param {number} [args.nowMs]
 */
export async function sendOrderNotification({ db, orderId, key, build, recipientOverride = '', meta = {}, nowMs = Date.now() }) {
  const orderRef = orderRefFor(db, orderId);
  const testMode = Boolean(recipientOverride);

  let order;
  if (testMode) {
    const snapshot = await orderRef.get();
    if (!snapshot.exists) return { ok: false, key, reason: 'order_not_found' };
    order = snapshot.data() || {};
  } else {
    const claim = await claimNotification(db, orderRef, key, nowMs);
    if (!claim.ok) return { ok: false, key, skipped: true, reason: claim.reason };
    order = claim.order;
  }

  const to = testMode
    ? recipientOverride
    : (CUSTOMER_KEYS.has(key) ? customerEmailFor(order) : ASSISTED_APPLICATION_OWNER_EMAIL);
  if (!to) {
    if (!testMode) {
      await markNotification(orderRef, key, { status: 'failed', lastError: 'no_recipient', failedAt: new Date(nowMs) });
    }
    return { ok: false, key, reason: 'no_recipient' };
  }

  if (!(await ensureEmailProviders())) {
    if (!testMode) {
      await markNotification(orderRef, key, { status: 'failed', lastError: 'no_email_provider_configured', failedAt: new Date(nowMs) });
    }
    return { ok: false, key, reason: 'no_email_provider_configured' };
  }

  const message = build(order);
  const isCustomer = CUSTOMER_KEYS.has(key);
  const customerEmail = customerEmailFor(order);
  const payload = {
    from: isCustomer ? ASSISTED_APPLICATION_SENDER : INTERNAL_SENDER,
    to: [to],
    subject: testMode ? `[TEST] ${message.subject}` : message.subject,
    html: message.html,
    text: message.text,
    tracking: false,
    ...(isCustomer ? {} : (customerEmail ? { replyTo: customerEmail } : {})),
  };

  const { failed, ambiguous, sent } = await sendEmailCascade(
    [{ payload, recipient: { email: to }, meta: { orderId: String(orderId), key } }],
    { delayMs: 0 },
  );

  if (testMode) {
    return failed.length > 0
      ? { ok: false, key, reason: `send_failed:${failed[0].error || 'unknown'}` }
      : { ok: true, key, test: true, to, provider: sent[0]?.provider || null };
  }

  if (failed.length > 0) {
    const status = failed[0].ambiguousDelivery ? 'ambiguous' : 'failed';
    await markNotification(orderRef, key, {
      status,
      lastError: String(failed[0].error || 'unknown').slice(0, 300),
      failedAt: new Date(nowMs),
    });
    return { ok: false, key, reason: `send_${status}:${failed[0].error || 'unknown'}` };
  }

  const outcome = sent[0] || {};
  await markNotification(orderRef, key, {
    status: ambiguous.length > 0 ? 'ambiguous' : 'sent',
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    provider: outcome.provider || null,
    messageId: outcome.messageId || null,
    to,
    ...meta,
  });
  return { ok: true, key, to, provider: outcome.provider || null };
}

// ── Lifecycle wiring ─────────────────────────────────────────────────────

/** Never delivered, failed, or claimed by a process that died mid-send. */
export function notificationNeedsRetry(entry, nowMs = Date.now()) {
  if (!entry || entry.status === 'failed') return true;
  return entry.status === 'sending' && nowMs - (timestampMillis(entry.claimedAt) || 0) >= CLAIM_TTL_MS;
}

export function isPaid(order) {
  return order?.paymentStatus === 'paid';
}

/** Send the payment-time pair: customer intro (or recovery copy) + owner notice. */
export async function sendPaidOrderNotifications(
  db,
  orderId,
  { variant = 'intro', recipientOverride = '', orderPatch = null, nowMs = Date.now() } = {},
) {
  // `orderPatch` only changes what the email shows (e.g. the locale recovered
  // from Stripe for a test send); it is never written by this function.
  const view = (order) => (orderPatch ? { ...order, ...orderPatch } : order);
  const results = [];
  results.push(await sendOrderNotification({
    db,
    orderId,
    key: NOTIFICATION_KEYS.customerIntro,
    build: (order) => buildCustomerEmail(variant, view(order), orderId, { nowMs }),
    recipientOverride,
    meta: { variant },
    nowMs,
  }));
  results.push(await sendOrderNotification({
    db,
    orderId,
    key: NOTIFICATION_KEYS.ownerNewOrder,
    build: (order) => buildOwnerEmail('new_order', view(order), orderId, { nowMs, customerKey: variant }),
    recipientOverride,
    meta: { variant },
    nowMs,
  }));
  return results;
}

/**
 * Firestore onDocumentWritten handler for assisted_applications/{orderId}.
 * Only reacts to lifecycle transitions, so its own `notifications.*` writes
 * never re-trigger a send.
 */
export async function handleAssistedApplicationOrderWritten(
  before,
  after,
  orderId,
  { db, nowMs = Date.now(), checkCv = checkAssistedApplicationCv } = {},
) {
  if (!after) return { ok: true, skipped: 'deleted' };
  const results = [];

  // A new CV reference: verify the stored bytes before anyone opens the file.
  if (after.cvStorageKey && after.cvStorageKey !== before?.cvStorageKey) {
    try {
      const check = await checkCv({ orderId, key: after.cvStorageKey, db });
      results.push({ ok: true, key: 'cv_file_check', verdict: check?.verdict || null });
    } catch (error) {
      results.push({ ok: false, key: 'cv_file_check', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (isPaid(after) && !isPaid(before)) {
    results.push(...await sendPaidOrderNotifications(db, orderId, { nowMs }));
  }

  const fromStatus = before?.submissionStatus || null;
  const toStatus = after.submissionStatus || null;
  if (isPaid(after) && fromStatus !== toStatus) {
    if (toStatus === 'ready_for_manual_submission' && fromStatus === 'awaiting_upload') {
      results.push(await sendOrderNotification({
        db,
        orderId,
        key: NOTIFICATION_KEYS.customerMaterialsReceived,
        build: (order) => buildCustomerEmail('received', order, orderId, { nowMs }),
        nowMs,
      }));
      results.push(await sendOrderNotification({
        db,
        orderId,
        key: NOTIFICATION_KEYS.ownerMaterialsUploaded,
        build: (order) => buildOwnerEmail('materials_uploaded', order, orderId, { nowMs }),
        nowMs,
      }));
    }
    if (toStatus === 'submitted') {
      results.push(await sendOrderNotification({
        db,
        orderId,
        key: NOTIFICATION_KEYS.customerSubmitted,
        build: (order) => buildCustomerEmail('submitted', order, orderId, { nowMs }),
        nowMs,
      }));
    }
  }

  if (results.length === 0) return { ok: true, skipped: 'no_transition' };
  const errors = results.filter((result) => !result.ok && !result.skipped);
  return errors.length > 0
    ? { ok: false, error: errors.map((result) => `${result.key}:${result.reason}`).join(',') , results }
    : { ok: true, results };
}

/**
 * Hourly backstop: re-send a payment intro that the trigger missed (provider
 * outage, cold-start crash) and send the single 48 h materials reminder.
 * Both are bounded in time, so orders that predate this concierge (paid
 * before it shipped) are never contacted automatically — they go through the
 * owner-run recovery script instead.
 */
export async function runAssistedApplicationNotificationSweep({ db, nowMs = Date.now() } = {}) {
  const snapshot = await db.collection(ASSISTED_APPLICATIONS_COLLECTION)
    .where('paymentStatus', '==', 'paid')
    .get();
  const summary = { intros: 0, reminders: 0, failed: 0, skipped: 0 };

  for (const doc of snapshot.docs || []) {
    const order = doc.data() || {};
    const notifications = order.notifications || {};
    const paidAtMs = timestampMillis(order.paidAt);
    const intro = notifications[NOTIFICATION_KEYS.customerIntro];

    const introMissing = notificationNeedsRetry(intro, nowMs);
    // Valerie's notice is retried on its own: a delivered customer intro must
    // not leave the owner without the order (sendPaidOrderNotifications skips
    // whichever of the two is already sent).
    const ownerMissing = notificationNeedsRetry(notifications[NOTIFICATION_KEYS.ownerNewOrder], nowMs);
    let acted = false;
    if ((introMissing || ownerMissing) && paidAtMs && nowMs - paidAtMs <= INTRO_BACKSTOP_WINDOW_MS) {
      const results = await sendPaidOrderNotifications(db, doc.id, { nowMs });
      if (results.some((result) => !result.ok && !result.skipped)) summary.failed += 1;
      else summary.intros += 1;
      acted = true;
      // An intro sent just now is not 48 h old: no reminder in this pass.
      if (introMissing) continue;
    }

    const introSentMs = intro?.status === 'sent' ? timestampMillis(intro.sentAt) : null;
    const reminder = notifications[NOTIFICATION_KEYS.customerReminder];
    const waitingForMaterials = order.submissionStatus === 'awaiting_upload' && !order.cvStorageKey;
    if (
      waitingForMaterials
      && introSentMs
      && nowMs - introSentMs >= MATERIALS_REMINDER_DELAY_MS
      && nowMs - introSentMs <= MATERIALS_REMINDER_WINDOW_MS
      && (!reminder || reminder.status === 'failed')
    ) {
      const result = await sendOrderNotification({
        db,
        orderId: doc.id,
        key: NOTIFICATION_KEYS.customerReminder,
        build: (current) => buildCustomerEmail('reminder', current, doc.id, { nowMs }),
        nowMs,
      });
      if (result.ok) summary.reminders += 1;
      else if (result.skipped) summary.skipped += 1;
      else summary.failed += 1;
      continue;
    }
    if (!acted) summary.skipped += 1;
  }
  return summary;
}
