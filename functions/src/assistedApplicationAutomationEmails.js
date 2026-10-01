/**
 * E-mails of the automated assisted-application flow.
 *
 * Owner (Valerie, Italian): the review notice with the automatic approval
 * time, or the reason the flow is held; the takeover notice.
 * Candidate (it/de/fr/en, same register as the concierge e-mails: "tu" in
 * Italian and German, "vous" in French): the draft to review with the EXACT
 * time of the automatic approval (owner decision 2026-09-30: the e-mail must
 * say it), the reminder, the portal handoff, the extra questions, the closed
 * ad and its refund.
 */

import {
  brandButton,
  brandCallout,
  brandChecklist,
  brandFinePrint,
  brandInfoCard,
  brandJobCard,
  brandParagraph,
  brandSectionLabel,
  brandSignature,
  renderBrandedEmail,
} from './assistedApplicationEmailLayout.js';
import { isTransientRunError } from './assistedApplicationFlow.js';
import { ADMIN_QUEUE_URL } from './assistedApplicationNotifications.js';


const INTL = { it: 'it-CH', de: 'de-CH', fr: 'fr-CH', en: 'en-GB' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clean(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] ?? ''));
}

/** "mercoledì 30 settembre alle 21:30" in the reader's language, Swiss time. */
export function formatDeadline(ms, locale = 'it') {
  if (!ms) return '';
  const date = new Date(ms);
  try {
    const day = new Intl.DateTimeFormat(INTL[locale] || INTL.it, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Zurich' }).format(date);
    const time = new Intl.DateTimeFormat(INTL[locale] || INTL.it, { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' }).format(date);
    const joiner = { it: 'alle', de: 'um', fr: 'à', en: 'at' }[locale] || 'alle';
    return `${day} ${joiner} ${time}`;
  } catch {
    return date.toISOString();
  }
}

const CANDIDATE_COPY = {
  it: {
    greeting: (name) => (name ? `Ciao ${name},` : 'Ciao,'),
    badge: 'Candidatura assistita',
    signature: 'Valerie',
    signatureRole: 'Frontaliere Ticino · candidatura assistita',
    jobLink: "Vedi l'annuncio",
    reviewCta: 'Rivedi e approva',
    openCta: 'Apri la tua candidatura',
    review: {
      subject: 'Controlla la tua candidatura per {job} prima dell’invio',
      hero: 'La tua candidatura è pronta',
      preheader: 'Approvala o chiedi modifiche: se non rispondi entro 12 ore parte da sola.',
      lead: 'ho preparato la tua candidatura per {job} presso {company}: la lettera di presentazione, i testi per l’azienda e i documenti da allegare. Rivedila e approvala con un clic, oppure dimmi cosa cambiare.',
      auto: 'Se non rispondi entro {deadline}, la candidatura partirà automaticamente così com’è.',
      held: 'Prima dell’invio mi servono alcune informazioni che solo tu puoi darmi ({count}). Finché non rispondi, la candidatura non parte.',
      feedbackNote: 'Se qualcosa non ti convince, scrivimelo nella pagina: preparo una nuova versione e te la rimando.',
    },
    reminder: {
      subject: 'Tra poche ore parte la tua candidatura per {job}',
      hero: 'Ultime ore per le modifiche',
      preheader: 'Se va bene così non devi fare nulla.',
      lead: 'la tua candidatura per {job} presso {company} partirà automaticamente {deadline}. Se va bene così non devi fare nulla; se vuoi modificare qualcosa, fallo prima di quell’ora.',
    },
    handoff: {
      subject: 'Ultimo passaggio per inviare la candidatura a {job}',
      hero: 'Manca solo il tuo clic finale',
      preheader: 'Tutto è pronto: ti servono 2 minuti.',
      lead: 'il portale di {company} richiede un passaggio che deve fare una persona ({reason}). Ho preparato tutto: link diretto, risposte da copiare nell’ordine giusto e documenti da allegare.',
      steps: ['apri la pagina della tua candidatura;', 'segui il link al portale e incolla le risposte nell’ordine indicato;', 'allega i documenti e invia;', 'torna sulla pagina e premi «Ho inviato la candidatura».'],
      after: 'La candidatura risulta inviata solo quando lo confermi tu: così sappiamo che il portale l’ha davvero ricevuta.',
    },
    handoffReminder: {
      subject: 'Promemoria: la tua candidatura a {job} aspetta l’ultimo passaggio',
      hero: 'La candidatura non è ancora partita',
      preheader: 'Ti servono 2 minuti: è già tutto pronto.',
      lead: 'la tua candidatura per {job} presso {company} è pronta ma non è ancora stata inviata: il portale richiede il tuo passaggio finale.',
    },
    action: {
      subject: 'Il portale di {company} chiede un’informazione in più',
      hero: 'Ci serve una tua risposta',
      preheader: 'Rispondi e l’invio riprende da solo.',
      lead: 'durante l’invio della candidatura per {job} il portale di {company} ha chiesto informazioni che solo tu puoi darmi. Rispondi dalla pagina della candidatura e l’invio riprende automaticamente.',
    },
    closed: {
      subject: 'L’annuncio {job} è stato chiuso: ti abbiamo rimborsato',
      hero: 'Annuncio chiuso prima dell’invio',
      preheader: 'Il rimborso è già partito.',
      lead: 'l’annuncio per {job} presso {company} è stato chiuso prima che riuscissimo a inviare la candidatura. Come promesso ti abbiamo rimborsato {price}: lo vedrai sulla carta nei prossimi giorni.',
    },
    followup: {
      subject: 'Sollecito per {job}: parte tra 12 ore',
      hero: 'Un breve sollecito all’azienda',
      preheader: 'Se va bene così non devi fare nulla.',
      lead: 'sono passati {days} giorni da quando abbiamo inviato la tua candidatura per {job} presso {company} e non ha ancora risposto nessuno. Ho preparato un breve messaggio di sollecito, qui sotto.',
      auto: 'Se non rispondi entro {deadline}, il sollecito partirà così com’è, a tuo nome come la candidatura. Dalla pagina puoi anche inviarlo subito o fermarlo.',
      cta: 'Invia o ferma il sollecito',
    },
    reasons: { captcha: 'una verifica anti-robot', account: 'la creazione o la verifica di un account', rejected: 'un controllo del sito sull’invio automatico', portal_needs_candidate: 'un controllo del sito' },
  },
  de: {
    greeting: (name) => (name ? `Hallo ${name},` : 'Hallo,'),
    badge: 'Begleitete Bewerbung',
    signature: 'Valerie',
    signatureRole: 'Frontaliere Ticino · begleitete Bewerbung',
    jobLink: 'Inserat ansehen',
    reviewCta: 'Prüfen und freigeben',
    openCta: 'Bewerbung öffnen',
    review: {
      subject: 'Prüfe deine Bewerbung für {job} vor dem Versand',
      hero: 'Deine Bewerbung ist bereit',
      preheader: 'Freigeben oder Änderungen wünschen: ohne Antwort geht sie nach 12 Stunden raus.',
      lead: 'ich habe deine Bewerbung für {job} bei {company} vorbereitet: Motivationsschreiben, Texte für das Unternehmen und die Unterlagen. Prüfe sie und gib sie mit einem Klick frei, oder sag mir, was ich ändern soll.',
      auto: 'Antwortest du nicht bis {deadline}, wird die Bewerbung automatisch so versendet.',
      held: 'Vor dem Versand brauche ich noch Angaben, die nur du machen kannst ({count}). Solange du nicht antwortest, geht die Bewerbung nicht raus.',
      feedbackNote: 'Wenn dir etwas nicht passt, schreib es mir auf der Seite: Ich bereite eine neue Version vor und schicke sie dir.',
    },
    reminder: {
      subject: 'In wenigen Stunden geht deine Bewerbung für {job} raus',
      hero: 'Letzte Stunden für Änderungen',
      preheader: 'Wenn alles passt, musst du nichts tun.',
      lead: 'deine Bewerbung für {job} bei {company} wird {deadline} automatisch versendet. Wenn alles passt, musst du nichts tun; Änderungen bitte vorher.',
    },
    handoff: {
      subject: 'Letzter Schritt für deine Bewerbung auf {job}',
      hero: 'Es fehlt nur dein letzter Klick',
      preheader: 'Alles ist vorbereitet: du brauchst 2 Minuten.',
      lead: 'das Portal von {company} verlangt einen Schritt, den ein Mensch machen muss ({reason}). Ich habe alles vorbereitet: direkter Link, Antworten zum Kopieren in der richtigen Reihenfolge und die Unterlagen.',
      steps: ['öffne die Seite deiner Bewerbung;', 'folge dem Link zum Portal und füge die Antworten in der angegebenen Reihenfolge ein;', 'lade die Unterlagen hoch und sende ab;', 'klicke danach auf der Seite auf «Ich habe die Bewerbung gesendet».'],
      after: 'Die Bewerbung gilt erst als gesendet, wenn du es bestätigst: So wissen wir, dass das Portal sie wirklich erhalten hat.',
    },
    handoffReminder: {
      subject: 'Erinnerung: deine Bewerbung auf {job} wartet auf den letzten Schritt',
      hero: 'Die Bewerbung ist noch nicht raus',
      preheader: 'Du brauchst 2 Minuten, alles ist bereit.',
      lead: 'deine Bewerbung für {job} bei {company} ist bereit, aber noch nicht gesendet: das Portal verlangt deinen letzten Schritt.',
    },
    action: {
      subject: 'Das Portal von {company} braucht eine weitere Angabe',
      hero: 'Wir brauchen deine Antwort',
      preheader: 'Antworte und der Versand läuft automatisch weiter.',
      lead: 'beim Versand deiner Bewerbung für {job} hat das Portal von {company} Angaben verlangt, die nur du machen kannst. Antworte auf der Seite deiner Bewerbung, dann läuft der Versand automatisch weiter.',
    },
    closed: {
      subject: 'Das Inserat {job} wurde geschlossen: Rückerstattung veranlasst',
      hero: 'Inserat vor dem Versand geschlossen',
      preheader: 'Die Rückerstattung ist bereits unterwegs.',
      lead: 'das Inserat für {job} bei {company} wurde geschlossen, bevor wir die Bewerbung senden konnten. Wie versprochen haben wir dir {price} zurückerstattet; der Betrag erscheint in den nächsten Tagen auf deiner Karte.',
    },
    followup: {
      subject: 'Nachfrage zu {job}: sie geht in 12 Stunden raus',
      hero: 'Eine kurze Nachfrage beim Arbeitgeber',
      preheader: 'Wenn es so passt, musst du nichts tun.',
      lead: 'vor {days} Tagen haben wir deine Bewerbung für {job} bei {company} gesendet, und bisher hat niemand geantwortet. Ich habe eine kurze Nachfrage vorbereitet, siehe unten.',
      auto: 'Wenn du bis {deadline} nicht antwortest, geht die Nachfrage so in deinem Namen raus, wie die Bewerbung. Auf der Seite kannst du sie auch sofort senden oder stoppen.',
      cta: 'Nachfrage senden oder stoppen',
    },
    reasons: { captcha: 'eine Anti-Roboter-Prüfung', account: 'das Erstellen oder Bestätigen eines Kontos', rejected: 'eine Prüfung der Website beim automatischen Versand', portal_needs_candidate: 'eine Prüfung der Website' },
  },
  fr: {
    greeting: (name) => (name ? `Bonjour ${name},` : 'Bonjour,'),
    badge: 'Candidature assistée',
    signature: 'Valerie',
    signatureRole: 'Frontaliere Ticino · candidature assistée',
    jobLink: "Voir l'annonce",
    reviewCta: 'Relire et approuver',
    openCta: 'Ouvrir votre candidature',
    review: {
      subject: 'Relisez votre candidature pour {job} avant l’envoi',
      hero: 'Votre candidature est prête',
      preheader: 'Approuvez-la ou demandez des modifications : sans réponse, elle part après 12 heures.',
      lead: 'j’ai préparé votre candidature pour {job} chez {company} : la lettre de motivation, les textes pour l’entreprise et les documents à joindre. Relisez-la et approuvez-la d’un clic, ou dites-moi quoi modifier.',
      auto: 'Sans réponse de votre part d’ici {deadline}, la candidature partira automatiquement telle quelle.',
      held: 'Avant l’envoi, j’ai besoin d’informations que vous seul pouvez me donner ({count}). Tant que vous n’avez pas répondu, la candidature ne part pas.',
      feedbackNote: 'Si quelque chose ne vous convient pas, écrivez-le sur la page : je prépare une nouvelle version et vous la renvoie.',
    },
    reminder: {
      subject: 'Votre candidature pour {job} part dans quelques heures',
      hero: 'Dernières heures pour modifier',
      preheader: 'Si tout vous convient, vous n’avez rien à faire.',
      lead: 'votre candidature pour {job} chez {company} partira automatiquement {deadline}. Si tout vous convient, vous n’avez rien à faire ; pour modifier quelque chose, faites-le avant.',
    },
    handoff: {
      subject: 'Dernière étape pour envoyer votre candidature à {job}',
      hero: 'Il ne manque que votre dernier clic',
      preheader: 'Tout est prêt : il vous faut 2 minutes.',
      lead: 'le portail de {company} demande une étape qui doit être faite par une personne ({reason}). J’ai tout préparé : lien direct, réponses à copier dans le bon ordre et documents à joindre.',
      steps: ['ouvrez la page de votre candidature ;', 'suivez le lien vers le portail et collez les réponses dans l’ordre indiqué ;', 'joignez les documents et envoyez ;', 'revenez sur la page et cliquez sur « J’ai envoyé la candidature ».'],
      after: 'La candidature n’est considérée comme envoyée que lorsque vous le confirmez : ainsi nous savons que le portail l’a bien reçue.',
    },
    handoffReminder: {
      subject: 'Rappel : votre candidature à {job} attend la dernière étape',
      hero: 'La candidature n’est pas encore partie',
      preheader: 'Il vous faut 2 minutes, tout est prêt.',
      lead: 'votre candidature pour {job} chez {company} est prête mais pas encore envoyée : le portail demande votre dernière étape.',
    },
    action: {
      subject: 'Le portail de {company} demande une information supplémentaire',
      hero: 'Nous avons besoin de votre réponse',
      preheader: 'Répondez et l’envoi reprend automatiquement.',
      lead: 'pendant l’envoi de votre candidature pour {job}, le portail de {company} a demandé des informations que vous seul pouvez donner. Répondez depuis la page de votre candidature et l’envoi reprend automatiquement.',
    },
    closed: {
      subject: 'L’annonce {job} a été fermée : vous êtes remboursé',
      hero: 'Annonce fermée avant l’envoi',
      preheader: 'Le remboursement est déjà en cours.',
      lead: 'l’annonce pour {job} chez {company} a été fermée avant que nous puissions envoyer la candidature. Comme promis, nous vous avons remboursé {price} ; le montant apparaîtra sur votre carte dans les prochains jours.',
    },
    followup: {
      subject: 'Relance pour {job} : elle part dans 12 heures',
      hero: 'Une courte relance à l’employeur',
      preheader: 'Si cela vous convient, vous n’avez rien à faire.',
      lead: 'il y a {days} jours, nous avons envoyé votre candidature pour {job} chez {company}, et personne n’a encore répondu. J’ai préparé un court message de relance, ci-dessous.',
      auto: 'Sans réponse de votre part avant {deadline}, la relance partira telle quelle, en votre nom comme la candidature. Depuis la page, vous pouvez aussi l’envoyer tout de suite ou l’arrêter.',
      cta: 'Envoyer ou arrêter la relance',
    },
    reasons: { captcha: 'une vérification anti-robot', account: 'la création ou la vérification d’un compte', rejected: 'un contrôle du site sur l’envoi automatique', portal_needs_candidate: 'un contrôle du site' },
  },
  en: {
    greeting: (name) => (name ? `Hi ${name},` : 'Hi,'),
    badge: 'Assisted application',
    signature: 'Valerie',
    signatureRole: 'Frontaliere Ticino · assisted application',
    jobLink: 'See the ad',
    reviewCta: 'Review and approve',
    openCta: 'Open your application',
    review: {
      subject: 'Check your application for {job} before it is sent',
      hero: 'Your application is ready',
      preheader: 'Approve it or ask for changes: without a reply it goes out after 12 hours.',
      lead: 'I have prepared your application for {job} at {company}: the cover letter, the texts for the company and the documents to attach. Review it and approve it with one click, or tell me what to change.',
      auto: 'If you do not reply by {deadline}, the application will be sent automatically as it is.',
      held: 'Before sending I need some information only you can give me ({count}). Until you reply, the application does not go out.',
      feedbackNote: 'If something is not right, write it on the page: I will prepare a new version and send it back to you.',
    },
    reminder: {
      subject: 'Your application for {job} goes out in a few hours',
      hero: 'Last hours for changes',
      preheader: 'If it is fine as it is, you do not need to do anything.',
      lead: 'your application for {job} at {company} will be sent automatically {deadline}. If it is fine as it is, you do not need to do anything; to change something, do it before then.',
    },
    handoff: {
      subject: 'One last step to send your application to {job}',
      hero: 'Only your final click is missing',
      preheader: 'Everything is ready: it takes 2 minutes.',
      lead: 'the {company} portal asks for a step that a person must do ({reason}). I have prepared everything: direct link, answers to paste in the right order and the documents to attach.',
      steps: ['open your application page;', 'follow the link to the portal and paste the answers in the order shown;', 'attach the documents and submit;', 'come back to the page and press “I have sent the application”.'],
      after: 'The application counts as sent only when you confirm it: that is how we know the portal really received it.',
    },
    handoffReminder: {
      subject: 'Reminder: your application to {job} is waiting for the last step',
      hero: 'The application has not gone out yet',
      preheader: 'It takes 2 minutes, everything is ready.',
      lead: 'your application for {job} at {company} is ready but not sent yet: the portal needs your final step.',
    },
    action: {
      subject: 'The {company} portal needs one more answer',
      hero: 'We need your answer',
      preheader: 'Answer and the submission resumes on its own.',
      lead: 'while sending your application for {job}, the {company} portal asked for information only you can give. Answer on your application page and the submission resumes automatically.',
    },
    closed: {
      subject: 'The {job} ad was closed: you have been refunded',
      hero: 'Ad closed before sending',
      preheader: 'The refund is already on its way.',
      lead: 'the ad for {job} at {company} was closed before we could send the application. As promised we refunded your {price}; you will see it on your card in the next few days.',
    },
    followup: {
      subject: 'Follow-up for {job}: it goes out in 12 hours',
      hero: 'A short follow-up to the employer',
      preheader: 'If it looks right, you don’t need to do anything.',
      lead: 'it has been {days} days since we sent your application for {job} at {company}, and nobody has replied yet. I prepared a short follow-up message, below.',
      auto: 'If you don’t reply by {deadline}, the follow-up goes out as it is, in your name like the application. From the page you can also send it now or stop it.',
      cta: 'Send or stop the follow-up',
    },
    reasons: { captcha: 'an anti-robot check', account: 'creating or verifying an account', rejected: 'a site check on automated submissions', portal_needs_candidate: 'a site check' },
  },
};

const OWNER_FLAG_LABELS = {
  fact_check: 'nei testi ci sono numeri, date o contatti che non compaiono nel CV o nell’annuncio',
  knock_out: 'il CV non soddisfa un requisito indispensabile dell’annuncio (verdetto «scarso»)',
  no_posting: 'il testo dell’annuncio non è stato recuperato',
  channel_unknown: 'non è chiaro come candidarsi (nessun link o indirizzo valido)',
  legitimacy: 'l’annuncio ha più segnali di posizione fantasma (vecchio, generico o contraddittorio): verifica prima di inviare',
};

const TAKEOVER_REASONS = {
  draft_failed: 'la bozza non è stata generata (errore del runner o di Codex)',
  runner_timeout: 'il runner non ha dato notizie per due volte di seguito',
  max_rounds: 'il candidato ha rifiutato la bozza per 3 volte',
  posting_closed: 'l’annuncio risulta chiuso: rimborso automatico avviato (se non riesce ricevi un secondo avviso)',
  refund_failed: 'il rimborso automatico non è riuscito: va fatto a mano dalla coda (il candidato non ha ancora ricevuto l’email di rimborso)',
  submit_failed: 'l’invio non è riuscito',
};

// The runner's error codes (scripts/assisted-application), in words.
const RUNNER_ERRORS = [
  [/^cv_unavailable/, 'il CV non si scarica dallo Storage'],
  [/^cv_unreadable/, 'dal CV non si ricava testo leggibile'],
  [/^documents_empty$/, 'Codex ha restituito una lettera o un’email vuota'],
  [/^draft_missing_for_round$/, 'manca la bozza del round approvato'],
  [/^fact_check_not_acknowledged$/, 'nei testi restano fatti non verificati senza la tua conferma'],
  [/^email_failed$/, 'nessun provider ha accettato l’email al datore'],
  [/^email_ambiguous$/, 'non è certo che l’email al datore sia partita: controlla prima di reinviarla'],
  [/^portal_ambiguous$/, 'non è certo che il portale abbia ricevuto la candidatura: controlla prima di reinviarla'],
  // JOIN run 36846326334: the portal's own message after the final click.
  [/^portal_refused$/, 'il portale ha risposto che non è riuscito a inviare la candidatura (spesso per il suo controllo anti-robot): NON è partita'],
  // JOIN, giro di prova 2026-10-01: the page stayed on the send button, invisible reCAPTCHA v3 on the portal.
  [/^portal_antibot_ambiguous$/,'dopo il clic finale la pagina del portale non è cambiata e il portale usa un controllo anti-robot invisibile (reCAPTCHA): molto probabilmente la candidatura NON è arrivata. Controlla sul portale e, se manca, completala tu: il robot non la reinvia'],
  [/^portal_validation$/, 'il portale ha rifiutato i dati del modulo'],
];
const STAGE_LABELS = { draft: 'la bozza non è stata generata', submit: 'l’invio non è riuscito' };
// Why the portal runner stopped (scripts/assisted-application/lib/portal/portal.mjs).
const PORTAL_STOPS = {
  captcha: 'il portale ha chiesto un controllo anti-robot (CAPTCHA), che il robot non aggira',
  account: 'il portale chiede di creare o verificare un account e il robot non ci è riuscito',
  rejected: 'il portale ha rifiutato l’invio automatico',
  portal_needs_candidate: 'il robot non è riuscito a completare una pagina del portale',
  posting_mismatch: 'il modulo aperto dal link non nomina né l’azienda né il ruolo dell’annuncio: il robot non compila un modulo che potrebbe essere di un altro posto (se lo screenshot mostra quello giusto, «Riprova l’invio automatico» va avanti)',
};
const PORTAL_HINT = 'Il candidato non deve fare nulla. Dalla coda completa tu l’invio sul portale (link, risposte e documenti sono nel pannello) e segnala la candidatura come inviata, oppure premi «Riprova l’invio automatico».';
const STAGE_HINTS = {
  draft: 'Dalla coda «Rigenera» o «Riprendi automazione» rifà la bozza nello stesso giro: il candidato non perde nessuno dei suoi giri.',
  submit: 'Controlla dalla coda se la candidatura è arrivata al datore prima di inviarla di nuovo.',
};
// What to do next when the runner's error says more than its stage. A refusal
// in words is not ambiguous: nothing to check, and on an anti-robot portal a
// new automatic send is refused again (JOIN, runs 36846326334 and 36859479435).
const RUNNER_HINTS = {
  portal_refused: 'Non serve controllare il portale. Su un portale con controllo anti-robot (come JOIN) un nuovo invio automatico di solito viene rifiutato di nuovo: dalla coda premi «Affida al candidato» (riceve link, risposte e documenti e invia dal suo browser) oppure completala tu sul portale.',
};

/**
 * Why the flow stopped, for Valerie: the step, the cause in words, how many
 * runs were tried; the runner's own message only as a technical detail.
 * @param {{reason?:string, stage?:string, attempts?:number}} vars
 * @returns {{reason:string, hint:string, detail:string}}
 */
export function describeTakeover({ reason, stage, attempts }) {
  const raw = String(reason || '').trim();
  if (TAKEOVER_REASONS[raw]) return { reason: TAKEOVER_REASONS[raw], hint: '', detail: '' };
  if (raw.startsWith('portal:')) {
    const code = raw.slice('portal:'.length);
    return { reason: `l’invio sul portale si è fermato: ${PORTAL_STOPS[code] || PORTAL_STOPS.portal_needs_candidate}`, hint: PORTAL_HINT, detail: '' };
  }
  const step = STAGE_LABELS[stage] || 'il flusso automatico si è fermato';
  const known = RUNNER_ERRORS.find(([pattern]) => pattern.test(raw));
  let cause = known?.[1] || '';
  if (!cause && isTransientRunError(raw)) {
    cause = stage === 'submit'
      ? 'Codex, la rete o il portale non hanno risposto in tempo'
      : 'Codex non ha risposto in tempo o non era raggiungibile';
  }
  const runs = Number(attempts) > 1 ? `, anche dopo ${Number(attempts)} tentativi automatici` : '';
  return {
    reason: cause ? `${step}: ${cause}${runs}` : `${step}${runs}`,
    hint: RUNNER_HINTS[raw] || STAGE_HINTS[stage] || '',
    detail: known ? '' : clean(raw, 300),
  };
}

/**
 * @param {string} kind candidate_review | candidate_reminder | candidate_handoff |
 *   candidate_handoff_reminder | candidate_action_needed | candidate_posting_closed |
 *   candidate_followup_review (vars.followupText, vars.days)
 * @param {{locale:string, name:string, job:string, company:string, jobUrl:string, reviewUrl:string,
 *   deadlineAt?:number, held?:boolean, openQuestions?:number, reason?:string, price?:string, orderId:string}} vars
 */
export function buildCandidateAutomationEmail(kind, vars) {
  const locale = CANDIDATE_COPY[vars.locale] ? vars.locale : 'it';
  const copy = CANDIDATE_COPY[locale];
  const section = {
    candidate_review: copy.review,
    candidate_reminder: copy.reminder,
    candidate_handoff: copy.handoff,
    candidate_handoff_reminder: copy.handoffReminder,
    candidate_action_needed: copy.action,
    candidate_posting_closed: copy.closed,
    candidate_followup_review: copy.followup,
  }[kind];
  if (!section) throw new Error(`unknown_automation_email:${kind}`);
  const values = {
    job: clean(vars.job, 200) || '—',
    company: clean(vars.company, 200) || '—',
    deadline: formatDeadline(vars.deadlineAt, locale),
    count: String(vars.openQuestions || 0),
    reason: copy.reasons[vars.reason] || copy.reasons.portal_needs_candidate,
    price: vars.price || '0,99 €',
    days: String(vars.days || 7),
  };
  const greeting = copy.greeting(clean(vars.name, 80).split(' ')[0] || '');
  const html = [brandParagraph(esc(greeting)), brandParagraph(esc(fill(section.lead, values)))];
  const text = [greeting, fill(section.lead, values)];
  if (vars.job && kind !== 'candidate_posting_closed') {
    html.push(brandJobCard({ title: values.job, company: values.company, url: vars.jobUrl || '', linkLabel: copy.jobLink }));
  }
  if (kind === 'candidate_review') {
    const clock = vars.held ? fill(section.held, values) : fill(section.auto, values);
    html.push(brandCallout(`<strong>${esc(clock)}</strong>`), brandButton(vars.reviewUrl, copy.reviewCta), brandParagraph(esc(section.feedbackNote)));
    text.push(clock, `${copy.reviewCta}: ${vars.reviewUrl}`, section.feedbackNote);
  } else if (kind === 'candidate_followup_review') {
    // The follow-up as the employer will read it, then the 12-hour clock.
    const followupText = String(vars.followupText || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
    const quoted = esc(followupText).replace(/\n/g, '<br>');
    const clock = fill(section.auto, values);
    html.push(brandCallout(quoted), brandParagraph(`<strong>${esc(clock)}</strong>`), brandButton(vars.reviewUrl, section.cta));
    text.push(followupText, clock, `${section.cta}: ${vars.reviewUrl}`);
  } else if (kind === 'candidate_handoff') {
    html.push(brandChecklist(section.steps), brandButton(vars.reviewUrl, copy.openCta), brandFinePrint(esc(section.after)));
    text.push(section.steps.map((step, index) => `${index + 1}. ${step}`).join('\n'), `${copy.openCta}: ${vars.reviewUrl}`, section.after);
  } else if (kind !== 'candidate_posting_closed') {
    html.push(brandButton(vars.reviewUrl, kind === 'candidate_reminder' ? copy.reviewCta : copy.openCta));
    text.push(`${kind === 'candidate_reminder' ? copy.reviewCta : copy.openCta}: ${vars.reviewUrl}`);
  }
  html.push(brandSignature(copy.signature, copy.signatureRole));
  text.push(copy.signature);
  return {
    subject: clean(fill(section.subject, values), 180),
    html: renderBrandedEmail({
      locale,
      preheader: section.preheader,
      badge: copy.badge,
      heroTitle: section.hero,
      heroSubtitle: `${values.job} — ${values.company}`,
      bodyHtml: html.join(''),
      footerLines: [`Ordine / Order: ${vars.orderId}`],
    }),
    text: text.join('\n\n'),
  };
}

/**
 * @param {'owner_review'|'owner_takeover'} kind
 * @param {{job:string, company:string, orderId:string, deadlineAt?:number, flags?:string[], reason?:string,
 *   verdict?:string, summary?:string, channel?:string, candidateEmail?:string}} vars
 */
export function buildOwnerAutomationEmail(kind, vars) {
  const job = clean(vars.job, 200) || '—';
  const company = clean(vars.company, 200) || '—';
  const html = [];
  const text = [];
  let subject;
  let hero;
  if (kind === 'owner_review') {
    const held = (vars.flags || []).length > 0;
    subject = held ? `[Candidatura] Serve il tuo intervento: ${job} — ${company}` : `[Candidatura] Bozza pronta: ${job} — ${company}`;
    hero = held ? 'Bozza ferma: serve il tuo intervento' : 'Bozza pronta per la tua revisione';
    const lead = held
      ? 'La bozza AI è pronta ma NON parte da sola finché non intervieni:'
      : `La bozza AI è pronta. Se non intervieni, si approva da sola ${formatDeadline(vars.deadlineAt, 'it')} e passa al candidato per la sua approvazione (12 ore).`;
    html.push(brandParagraph(esc(lead)));
    text.push(lead);
    if (held) {
      const items = (vars.flags || []).map((flag) => OWNER_FLAG_LABELS[flag] || flag);
      html.push(brandChecklist(items));
      text.push(items.map((item) => `- ${item}`).join('\n'));
    }
    const facts = [`Verdetto: ${vars.verdict || '—'}`, `Canale: ${vars.channel || '—'}`];
    html.push(brandInfoCard('Sintesi', esc(vars.summary || '—')), brandParagraph(esc(facts.join(' · '))));
    text.push(`Sintesi: ${vars.summary || '—'}`, facts.join(' · '));
  } else if (kind === 'owner_takeover') {
    subject = `[Candidatura] Presa in carico necessaria: ${job} — ${company}`;
    hero = 'Il flusso automatico si è fermato';
    const { reason, hint, detail } = describeTakeover(vars);
    html.push(brandParagraph(esc(`Motivo: ${reason}.`)));
    text.push(`Motivo: ${reason}.`);
    if (hint) {
      html.push(brandParagraph(esc(hint)));
      text.push(hint);
    }
    if (detail) {
      html.push(brandFinePrint(esc(`Dettaglio tecnico: ${detail}`)));
      text.push(`Dettaglio tecnico: ${detail}`);
    }
  } else {
    throw new Error(`unknown_owner_automation_email:${kind}`);
  }
  html.push(brandJobCard({ title: job, company, url: '', linkLabel: '' }), brandSectionLabel('Coda candidature'), brandButton(ADMIN_QUEUE_URL, 'Apri la coda'));
  text.push(`${job} — ${company}`, `Coda: ${ADMIN_QUEUE_URL}`);
  if (vars.candidateEmail) text.push(`Candidato: ${vars.candidateEmail}`);
  return {
    subject: clean(subject, 180),
    html: renderBrandedEmail({
      locale: 'it',
      preheader: hero,
      badge: 'Candidatura assistita · automazione',
      heroTitle: hero,
      heroSubtitle: `${job} — ${company}`,
      bodyHtml: html.join(''),
      footerLines: [`Ordine: ${vars.orderId}`],
    }),
    text: text.join('\n\n'),
  };
}
