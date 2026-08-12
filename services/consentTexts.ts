/**
 * consentTexts.ts — the versioned register of what a subscriber was told.
 *
 * WHY THIS FILE EXISTS (#5678)
 * ----------------------------
 * Measured on production 2026-08-12 over 8.605 `newsletter_subscribers`
 * documents: 100 carried a `consent_text`, 8.505 (98,8%) carried none. The
 * write was never the problem — `captureNewsletterSubscriber` has always
 * persisted `input.consentText` — the callers were. Every gate that creates a
 * subscriber without the visitor typing into a newsletter form (social
 * sign-in, One Tap, chatbot login, job unlock, calculator gate, tax-calendar
 * reminders) passed nothing, so for 98,8% of the list the question "what did
 * they agree to?" had no stored answer at all.
 *
 * An art. 25 nLPD request asks for date, time, IP and the form URL. Without
 * the text, an entry created by an authentication is indistinguishable from
 * one somebody else typed in — which is precisely the contestation being made.
 *
 * WHAT `text` IS, AND WHAT IT IS NOT
 * ----------------------------------
 * `text` is the disclosure **in force at that gate**, stored verbatim on the
 * subscriber document. It is deliberately NOT a key pointing at a copy deck:
 * revising a formula must never rewrite what earlier subscribers were told.
 * Bump `version` on ANY edit to a `text` — `tests/newsletter-consent-proof.test.ts`
 * pins every string and version literally, so an edit without a bump fails.
 *
 * `text` is NOT a claim that the string appeared on screen. Verified while
 * writing this file: NONE of the three consent constants that predate it
 * (`SAVE_SIGNIN_CONSENT_TEXT`, `COMPANY_FOLLOW_CONSENT_TEXT`,
 * `PUBLISHER_CONSENT_TEXT`, all now entries below) is referenced from any JSX
 * — they were recorded, never rendered. That is a real gap, and burying it
 * would be worse than the gap: every entry therefore carries `displayed`, and
 * every entry is `displayed: false` today. A reader of the stored document can
 * tell "this is the notice that governed the gate" from "this is the sentence
 * the person read", instead of having to assume the stronger one.
 *
 * `act` records what the person actually DID. It is the field that separates
 * an authentication from a subscription, and the reason the sign-in formulas
 * below say, in so many words, that no consent box was offered. A record that
 * overstated the act would be worth less than no record: a fabricated consent
 * is a worse position in front of an authority than an admitted gap.
 *
 * NOT SET HERE — `consentGiven`
 * -----------------------------
 * `consent_given: true` asserts an affirmative opt-in. On every path this
 * register covers there was none (see `act`), so nothing here sets it. Keeping
 * it false also keeps the 100 documents that legitimately carry it countable.
 */

/** How the address reached us, stored as `consent_method`. */
export type ConsentMethod =
  | 'email_checkbox'
  | 'email_submit'
  | 'google_oauth'
  | 'facebook_oauth'
  | 'linkedin_oauth'
  /**
   * A federated sign-in whose provider the call site genuinely does not know.
   * App.tsx's auth listener fires on `source: 'signup'` for Google AND for
   * Facebook (`getAuthEmail` reads `providerData` precisely because Facebook
   * may not set `user.email`), so naming one of them there would be a guess
   * recorded as a fact.
   */
  | 'social_signin'
  | 'email_link_click';

/**
 * What the person physically did. `authentication` is the one that must never
 * be read as consent: signing in to use a service is not an opt-in to mail.
 */
export type ConsentAct =
  | 'authentication'
  | 'typed_email_submit'
  | 'email_link_click';

export type ConsentProofEntry = {
  /** Stable grouping key. Never a substitute for `text` when answering art. 25. */
  readonly id: string;
  /** Bump on ANY edit to `text`. Older documents keep the version they were given. */
  readonly version: string;
  /** The exact disclosure in force at this gate. Stored verbatim. */
  readonly text: string;
  /** Was this exact string rendered to the person? `false` everywhere today. */
  readonly displayed: boolean;
  /** What the person actually did at this gate. */
  readonly act: ConsentAct;
};

const entry = (e: ConsentProofEntry): ConsentProofEntry => Object.freeze(e);

export const CONSENT_TEXTS = Object.freeze({
  /** App.tsx / hooks/useUserState.ts / authService One Tap: sign-in auto-subscribe. */
  signInAutoSubscribe: entry({
    id: 'signin_auto_subscribe',
    version: '2026-08-12.1',
    text: 'Accedendo con Google, Facebook o LinkedIn a Frontaliere Ticino, l’indirizzo email dell’account viene iscritto alla newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). L’accesso al sito è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    displayed: false,
    act: 'authentication',
  }),

  /** App.tsx chatbot sign-in (chatbot_google / chatbot_facebook / chatbot_email). */
  chatbotSignIn: entry({
    id: 'chatbot_signin',
    version: '2026-08-12.1',
    text: 'Accedendo dall’assistente di Frontaliere Ticino per continuare la conversazione, l’indirizzo email viene iscritto alla newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). Proseguire con l’assistente è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    displayed: false,
    act: 'authentication',
  }),

  /** JobBoard social unlock — promotes straight to confirmed/active, no double opt-in. */
  jobUnlockSocial: entry({
    id: 'job_unlock_social',
    version: '2026-08-12.1',
    text: 'Accedendo con Google o Facebook per sbloccare un annuncio di lavoro, l’indirizzo email dell’account viene iscritto alla newsletter per frontalieri e agli avvisi di lavoro. Sbloccare l’annuncio è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    displayed: false,
    act: 'authentication',
  }),

  /** JobBoard / JobOrphanView / JobBridgeView / JobExpiredView email unlock (pending). */
  jobUnlockEmail: entry({
    id: 'job_unlock_email',
    version: '2026-08-12.1',
    text: 'Inserendo il mio indirizzo email per sbloccare gli annunci di lavoro, chiedo di ricevere la newsletter per frontalieri e gli avvisi di lavoro. L’iscrizione resta in attesa finché non la confermo dal link che ricevo per email. Posso disiscrivermi in qualsiasi momento.',
    displayed: false,
    act: 'typed_email_submit',
  }),

  /** MobileCalcLayout: email gate in front of the full salary analysis. */
  analysisGate: entry({
    id: 'analysis_gate',
    version: '2026-08-12.1',
    text: 'Inserendo il mio indirizzo email per sbloccare l’analisi completa dello stipendio, chiedo di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). L’iscrizione resta in attesa finché non la confermo dal link che ricevo per email. Posso disiscrivermi in qualsiasi momento.',
    displayed: false,
    act: 'typed_email_submit',
  }),

  /** TaxCalendar reminder gate, social branch (confirmed immediately). */
  taxCalendarSocial: entry({
    id: 'tax_calendar_social',
    version: '2026-08-12.1',
    text: 'Accedendo con Google o Facebook per attivare i promemoria delle scadenze fiscali, l’indirizzo email dell’account viene iscritto alla newsletter per frontalieri e ai promemoria del calendario fiscale. Attivare i promemoria è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    displayed: false,
    act: 'authentication',
  }),

  /** TaxCalendar reminder gate, typed-address branch (pending). */
  taxCalendarEmail: entry({
    id: 'tax_calendar_email',
    version: '2026-08-12.1',
    text: 'Inserendo il mio indirizzo email per ricevere i promemoria delle scadenze fiscali, chiedo di ricevere anche la newsletter per frontalieri. L’iscrizione resta in attesa finché non la confermo dal link che ricevo per email. Posso disiscrivermi in qualsiasi momento.',
    displayed: false,
    act: 'typed_email_submit',
  }),

  /** LeadMagnetCTA: free guide in exchange for the address. */
  leadMagnet: entry({
    id: 'lead_magnet',
    version: '2026-08-12.1',
    text: 'Inserendo il mio indirizzo email per scaricare la guida gratuita, chiedo di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    displayed: false,
    act: 'typed_email_submit',
  }),

  /** Newsletter.tsx page + compact footer form (double opt-in). */
  newsletterForm: entry({
    id: 'newsletter_form',
    version: '2026-08-12.1',
    text: 'Inserendo il mio indirizzo email nel modulo della newsletter, chiedo di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). L’iscrizione resta in attesa finché non la confermo dal link che ricevo per email. Posso disiscrivermi in qualsiasi momento.',
    displayed: false,
    act: 'typed_email_submit',
  }),

  /** WeeklyDigest subscribe button. */
  weeklyDigest: entry({
    id: 'weekly_digest',
    version: '2026-08-12.1',
    text: 'Inserendo il mio indirizzo email per ricevere il riepilogo settimanale, chiedo di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico di frontiera e novità fiscali). Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.',
    displayed: false,
    act: 'typed_email_submit',
  }),

  /**
   * App.tsx `?action=resubscribe` win-back link.
   *
   * `act: 'email_link_click'` is not a formality. Measured on this domain,
   * corporate anti-phishing scanners fetch every link in a message —
   * 35 clicks on one send, 25 of them inside 7 seconds, from Microsoft ranges.
   * A click is therefore evidence of a fetch, not necessarily of a human
   * intent, and the stored record says so rather than laundering it into an
   * opt-in. The `reconsent` lift this path carries (#5672/#5690) is a separate
   * product decision; this field only refuses to overstate the proof.
   */
  resubscribeLink: entry({
    id: 'resubscribe_link',
    version: '2026-08-12.1',
    text: 'Riattivo l’iscrizione alla newsletter per frontalieri aprendo il link «riattiva» contenuto in una email ricevuta da Frontaliere Ticino. Il gesto registrato è l’apertura di quel link, non la compilazione di un modulo. Posso disiscrivermi di nuovo in qualsiasi momento.',
    displayed: false,
    act: 'email_link_click',
  }),

  /**
   * SaveSignInPromptModal — moved here VERBATIM from that file. The bytes are
   * unchanged on purpose: re-wording it would alter what future subscribers
   * are recorded as having been told, for no reason connected to this fix.
   */
  saveJobSignIn: entry({
    id: 'save_job_signin',
    version: '1',
    text: 'Accedendo per salvare un annuncio, accetto di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico e novità fiscali). Posso disiscrivermi in qualsiasi momento.',
    displayed: false,
    act: 'typed_email_submit',
  }),

  /** CompanyFollowButton — moved here VERBATIM. See `saveJobSignIn`. */
  companyFollow: entry({
    id: 'company_follow',
    version: '1',
    text: 'Seguendo un\'azienda, accetto di ricevere una email quando pubblica nuovi annunci e la newsletter per frontalieri (cambio CHF/EUR, traffico e novità fiscali). Posso disiscrivermi in qualsiasi momento.',
    displayed: false,
    act: 'typed_email_submit',
  }),

  /**
   * PublisherPublishPage social gate — text moved here VERBATIM.
   *
   * Split in two because the page used ONE constant for two different acts:
   * the social gate subscribes off an OAuth sign-in, the email gate off a
   * typed address. Same notice, different thing done — and `act` is the field
   * that has to tell them apart.
   */
  publisherGateSocial: entry({
    id: 'publisher_gate_social',
    version: '1',
    text: 'Accedendo per pubblicare un\'offerta, accetto di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico e novità fiscali). Posso disiscrivermi in qualsiasi momento.',
    displayed: false,
    act: 'authentication',
  }),

  /** PublisherPublishPage email gate — same VERBATIM text, different act. */
  publisherGateEmail: entry({
    id: 'publisher_gate_email',
    version: '1',
    text: 'Accedendo per pubblicare un\'offerta, accetto di ricevere la newsletter per frontalieri (cambio CHF/EUR, traffico e novità fiscali). Posso disiscrivermi in qualsiasi momento.',
    displayed: false,
    act: 'typed_email_submit',
  }),
});

export type ConsentTextKey = keyof typeof CONSENT_TEXTS;

/** The `consent_*` half of a `NewsletterUpsertInput`, ready to spread. */
export type ConsentProofInput = {
  consentText: string;
  consentTextVersion: string;
  consentTextDisplayed: boolean;
  consentAct: ConsentAct;
  consentMethod: string;
  consentUserAgent: string | null;
};

/**
 * Build the consent-proof fields for one capture.
 *
 * Spread into the upsert input. Note what is absent: `consentGiven`. None of
 * these gates collects an affirmative opt-in, and asserting one would fabricate
 * the single fact the record exists to establish.
 *
 * `consentSourceUrl` is not returned either — `captureNewsletterSubscriber`
 * already derives `consent_source_url` from `sourcePage` (falling back to
 * `window.location.href`), and a second source for the same field would only
 * let the two disagree.
 */
export function consentProof(
  key: ConsentTextKey,
  // `string & {}` keeps autocomplete on the union while still accepting the
  // method strings that predate it (`social_oauth` in PublisherPublishPage).
  // Widening beats rewriting values already sitting in production documents.
  method: ConsentMethod | (string & {}),
): ConsentProofInput {
  const proof = CONSENT_TEXTS[key];
  return {
    consentText: proof.text,
    consentTextVersion: proof.version,
    consentTextDisplayed: proof.displayed,
    consentAct: proof.act,
    consentMethod: method,
    consentUserAgent:
      typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : null,
  };
}

/** OAuth provider id (`google.com`, `facebook.com`, …) → `consent_method`. */
export function oauthConsentMethod(providerId?: string | null): ConsentMethod {
  const id = String(providerId || '').toLowerCase();
  if (id.includes('facebook')) return 'facebook_oauth';
  if (id.includes('linkedin')) return 'linkedin_oauth';
  return 'google_oauth';
}
