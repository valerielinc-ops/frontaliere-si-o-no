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
 * CLOSING THAT GAP (#5712 / #5718)
 * --------------------------------
 * The sentence above was true of every entry until this change. It is now
 * true of the entries that describe paths nobody can render a notice into
 * (the auth listener in App.tsx, Google One Tap, an emailed link) and FALSE
 * — deliberately, verifiably — of the two entries added below.
 *
 * `communicationsOptIn` and `communicationsSignIn` are `displayed: true`
 * because a component renders them: `components/shared/ConsentNotice.tsx`
 * prints `consentDisplayText(key, locale)`, the SAME function the stored
 * value comes from, so the sentence on screen and the sentence in the
 * document cannot drift. `tests/consent-shown-at-signup.test.ts` refuses a
 * `displayed: true` entry whose call sites do not also render it — which is
 * what stops the flag from becoming the flattering assumption it exists to
 * prevent.
 *
 * WHY ONE FORMULA REPLACED THIRTEEN GATE-SPECIFIC ONES AT THE RENDERED GATES
 * -------------------------------------------------------------------------
 * The per-gate formulas below each named ONE channel (usually "la newsletter
 * per frontalieri"). Measured 2026-08-12: eight channels ship from this repo
 * — daily brief, weekly newsletter, job alerts, saved-jobs digest, onboarding
 * drip, dormant win-back, sunset, publisher blast — so a person who read one
 * of those formulas was told about a fraction of what they would receive.
 * The replacement names CATEGORIES (editorial / job alerts / service), never
 * products, and never a FREQUENCY: "settimanale" in the old popup formula is
 * exactly what made the move to a daily brief contestable (#5679). Frequency
 * lives on `CONSENT_PAGE_PATH`, generated from `services/communicationChannels.ts`,
 * where it can change without invalidating consent already collected.
 *
 * WHAT THIS DOES NOT COVER, said plainly. Third-party advertising
 * (`publisher-blast.yml`) is a different PURPOSE, not a different format, and
 * no wording below admits it. That is an owner decision, not a code one, and
 * `ADVERTISING_NOT_COVERED` records it where a call site would look.
 *
 * A NOTE ON LOCALES. `text` stays the Italian string and stays pinned; `texts`
 * carries all four. The stored value is the one the person's own locale
 * rendered — for en/de/fr the popup and the CTA used to SHOW a translated
 * label and STORE the Italian literal, so the document recorded a sentence
 * that visitor had never seen.
 *
 * `act` records what the person actually DID. It is the field that separates
 * an authentication from a subscription, and the reason the sign-in formulas
 * below say, in so many words, that no consent box was offered. A record that
 * overstated the act would be worth less than no record: a fabricated consent
 * is a worse position in front of an authority than an admitted gap.
 *
 * NOT SET HERE — `consentGiven`
 * -----------------------------
 * `consent_given: true` asserts an affirmative opt-in, which is a different
 * fact from `displayed` and stays a different field. Nothing in this module
 * sets it: a formula being on screen proves a disclosure, never a decision.
 *
 * Only a CALL SITE with a real checkbox the visitor has to tick before the
 * form submits may add it, and after #5712 exactly four do — NewsletterPopup,
 * SubscriptionCTA, PdfDownloadGate, OfferwallNewsletterGate. Four others
 * (SaveSignInPromptModal, CompanyFollowButton, both PublisherPublishPage
 * gates) asserted it with no checkbox anywhere in the file and no longer do:
 * the claim was dropped, not the notice. Documents that already carry it keep
 * it — `captureNewsletterSubscriber` falls back to the stored value.
 *
 * The stake is concrete. `hasAffirmativeJobAlertConsent`
 * (functions/src/jobAlertBackfillCore.js, PR #5722) requires
 * `consent_given` AND `consent_text_displayed` AND a text naming the alert
 * channel: a checkbox-less gate asserting the first would re-open job-alert
 * creation for people who never asked, which is exactly the #5705 shape that
 * produced 6.308 unrequested alerts.
 * `tests/consent-shown-at-signup.test.ts` enforces the checkbox rule per file.
 */

import {
  DATA_CONTROLLER_NAME,
  DATA_CONTROLLER_EMAIL,
} from '../functions/src/lib/dataControllerIdentity.js';

/**
 * The four locales this codebase ships everywhere else. A consent notice in a
 * language the reader does not speak is not a notice, so a formula that claims
 * `displayed: true` has to exist in all four.
 */
export const CONSENT_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type ConsentLocale = (typeof CONSENT_LOCALES)[number];

/**
 * The page that lists every live channel with its real cadence, generated from
 * `services/communicationChannels.ts`. Named INSIDE the consent formula: it is
 * what lets the formula stay silent about frequency without leaving the reader
 * unable to find it.
 */
export const CONSENT_PAGE_PATH = '/comunicazioni/';
/** How that page is written inside the formula — bare host, no scheme, as a person would read it aloud. */
export const CONSENT_PAGE_LABEL = 'frontaliereticino.ch/comunicazioni';

/**
 * Third-party advertising is NOT in any formula below, and this constant is
 * here so the next person to wire `blast-publisher-ads.mjs` to a consent check
 * finds the reason instead of an absence.
 *
 * An advertiser's message is a different PURPOSE, not another format of the
 * editorial category — "un consenso per qualunque email decideremo di mandare"
 * is not a valid consent. Two ways out, and only the owner may pick: name
 * advertising in the formula and accept that some people refuse it, or do not
 * send it to people whose consent does not cover it. Slipping it under
 * "aggiornamenti redazionali" is the shortcut that produced the 6.308
 * unrequested job alerts (#5705).
 */
export const ADVERTISING_NOT_COVERED =
  'blocked: owner decision — third-party advertising (publisher-blast.yml) is a different purpose and no formula in this register admits it (#5712)';

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
  /** Bump on ANY edit to `text` OR to any string in `texts`. Older documents keep the version they were given. */
  readonly version: string;
  /** The exact disclosure in force at this gate, in Italian. Stored verbatim. */
  readonly text: string;
  /**
   * The same disclosure in all four locales, when it exists in all four.
   * `texts.it` must equal `text` — asserted in tests/newsletter-consent-proof.test.ts.
   * Absent on the legacy entries: they were only ever written in Italian, which
   * is precisely why none of them may claim `displayed: true`.
   */
  readonly texts?: Readonly<Record<ConsentLocale, string>>;
  /**
   * Was this exact string rendered to the person?
   *
   * `true` requires BOTH halves: a `texts` table (so every visitor sees it in
   * their own language) and a call site that renders it through
   * `components/shared/ConsentNotice.tsx`. Nothing here can verify the second
   * half; `tests/consent-shown-at-signup.test.ts` does, per call site.
   */
  readonly displayed: boolean;
  /** What the person actually did at this gate. */
  readonly act: ConsentAct;
};

const entry = (e: ConsentProofEntry): ConsentProofEntry =>
  Object.freeze({ ...e, texts: e.texts ? Object.freeze({ ...e.texts }) : undefined });

/**
 * The three categories, spelled out once per locale and reused by both
 * displayed formulas below.
 *
 * `avvisi di lavoro` / `job alerts` / `Stellenbenachrichtigungen` /
 * `alertes d'emploi` are load-bearing, not stylistic: `consentNamesJobAlerts`
 * (functions/src/jobAlertBackfillCore.js) matches on exactly those phrases and
 * deliberately refuses "offerte di lavoro", which names the CONTENT of a page
 * rather than a mailing. Naming the channel is what lets an opt-in collected
 * here create a job alert without any change to that fail-closed guard — and
 * why an edit that softened these words back to "offerte" would silently shut
 * the channel again.
 *
 * WHY THE EDITORIAL CLAUSE LOST TWO ITEMS AT `2026-08-12.3` (#5745)
 * ----------------------------------------------------------------
 * It used to read "cambio CHF/EUR, traffico ai valichi, fisco, previdenza e
 * novità normative". The first two were carried by ONE channel — the daily
 * brief — and the owner disabled it on 2026-08-12. What remains live under
 * `editorial` is the weekly newsletter, whose contents are tax and pension
 * explainers, a featured article and a tool: no live rate, no border traffic.
 *
 * So the formula was promising, at the moment of the act, mail that no longer
 * comes. That is the same defect as an undisclosed channel pointing the other
 * way, and it does not become harmless for pointing that way: a notice is
 * evidence of what the person was led to expect, and one that oversells is
 * still one that misdescribes. The clause now names only what a live channel
 * delivers.
 *
 * It stays a CATEGORY and not a product list — that is what makes a future
 * feature inside it covered without re-collecting anything. What it may not do
 * is name a specific thing nothing sends. Turning the daily brief back on
 * therefore takes a bump, which is the correct price: today's subscribers
 * agreed to today's sentence.
 */
const CATEGORIES: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: 'aggiornamenti redazionali — fisco, previdenza, novità normative e approfondimenti per chi lavora oltre confine; avvisi di lavoro — offerte in Ticino e in Svizzera, secondo i criteri che imposto io; messaggi di servizio sul mio account, sulle mie preferenze e sulle offerte che ho salvato.',
  en: 'editorial updates — tax, pensions, regulatory news and explainers for people who work across the border; job alerts — openings in Ticino and across Switzerland, matching the criteria I set myself; service messages about my account, my preferences and the jobs I saved.',
  de: 'redaktionelle Updates — Steuern, Vorsorge, Neuerungen der Rechtslage und Hintergrundberichte für Grenzgängerinnen und Grenzgänger; Stellenbenachrichtigungen — Stellen im Tessin und in der ganzen Schweiz, nach den Kriterien, die ich selbst festlege; Servicenachrichten zu meinem Konto, meinen Einstellungen und den von mir gespeicherten Stellen.',
  fr: 'mises à jour éditoriales — fiscalité, prévoyance, nouveautés réglementaires et analyses pour celles et ceux qui travaillent de l’autre côté de la frontière ; alertes d’emploi — postes au Tessin et dans toute la Suisse, selon les critères que je définis moi-même ; messages de service concernant mon compte, mes préférences et les offres que j’ai enregistrées.',
});

/**
 * The closing half: where the live list lives, how to leave, and who the
 * controller is. No frequency word appears in it — that is the whole point.
 * The controller is named AT COLLECTION, not only in the privacy notice
 * (art. 19 nLPD, #5675), and through the canonical constants so it cannot
 * drift from `/privacy/` the way the hardcoded literals did before #5702.
 */
const CLOSING: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: `L’elenco completo e aggiornato di tutte le comunicazioni, con la frequenza di ciascuna, è su ${CONSENT_PAGE_LABEL}. Posso scegliere quali ricevere e con che frequenza, o disdirle tutte, in qualsiasi momento e senza motivazione, dalle mie preferenze o dal link in fondo a ogni email. Titolare del trattamento: ${DATA_CONTROLLER_NAME} — ${DATA_CONTROLLER_EMAIL}`,
  en: `The complete, up-to-date list of every communication, with how often each one is sent, is at ${CONSENT_PAGE_LABEL}. I can choose which ones to receive and how often, or stop them all, at any time and without giving a reason, from my preferences or the link at the bottom of every email. Data controller: ${DATA_CONTROLLER_NAME} — ${DATA_CONTROLLER_EMAIL}`,
  de: `Die vollständige und aktuelle Liste aller Mitteilungen, mit der Häufigkeit jeder einzelnen, steht auf ${CONSENT_PAGE_LABEL}. Ich kann jederzeit und ohne Begründung wählen, welche ich erhalte und wie oft, oder alle abbestellen — in meinen Einstellungen oder über den Link am Ende jeder E-Mail. Verantwortliche Person: ${DATA_CONTROLLER_NAME} — ${DATA_CONTROLLER_EMAIL}`,
  fr: `La liste complète et à jour de toutes les communications, avec la fréquence de chacune, se trouve sur ${CONSENT_PAGE_LABEL}. Je peux à tout moment et sans motif choisir lesquelles recevoir et à quelle fréquence, ou toutes les résilier, depuis mes préférences ou le lien en bas de chaque e-mail. Responsable du traitement : ${DATA_CONTROLLER_NAME} — ${DATA_CONTROLLER_EMAIL}`,
});

const OPT_IN_OPENING: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: 'Comunicazioni di Frontaliere Ticino. Accetto di ricevere via email le comunicazioni di Frontaliere Ticino dedicate a chi lavora oltre confine:',
  en: 'Frontaliere Ticino communications. I agree to receive by email the Frontaliere Ticino communications for people who work across the border:',
  de: 'Mitteilungen von Frontaliere Ticino. Ich stimme zu, die E-Mail-Mitteilungen von Frontaliere Ticino für Grenzgängerinnen und Grenzgänger zu erhalten:',
  fr: 'Communications de Frontaliere Ticino. J’accepte de recevoir par e-mail les communications de Frontaliere Ticino destinées à celles et ceux qui travaillent de l’autre côté de la frontière :',
});

/**
 * The sign-in opening. Same categories, different first sentence, because the
 * ACT is different and a formula that hid that would be the fabrication the
 * whole register exists to refuse: signing in is not ticking a box.
 */
const SIGN_IN_OPENING: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: 'Comunicazioni di Frontaliere Ticino. Accedendo, l’indirizzo email del mio account viene iscritto alle comunicazioni di Frontaliere Ticino: nessuna casella di consenso separata mi è stata proposta, l’accesso è l’unico gesto che compio. Ricevo:',
  en: 'Frontaliere Ticino communications. By signing in, my account email address is subscribed to the Frontaliere Ticino communications: no separate consent box was offered to me, signing in is the only thing I do. I receive:',
  de: 'Mitteilungen von Frontaliere Ticino. Mit der Anmeldung wird die E-Mail-Adresse meines Kontos für die Mitteilungen von Frontaliere Ticino registriert: es wurde mir kein separates Einwilligungskästchen angeboten, die Anmeldung ist die einzige Handlung, die ich vornehme. Ich erhalte:',
  fr: 'Communications de Frontaliere Ticino. En me connectant, l’adresse e-mail de mon compte est inscrite aux communications de Frontaliere Ticino : aucune case de consentement distincte ne m’a été proposée, la connexion est le seul geste que j’accomplis. Je reçois :',
});

const compose = (
  opening: Readonly<Record<ConsentLocale, string>>,
): Readonly<Record<ConsentLocale, string>> =>
  Object.freeze(
    Object.fromEntries(
      CONSENT_LOCALES.map((l) => [l, `${opening[l]} ${CATEGORIES[l]} ${CLOSING[l]}`]),
    ) as Record<ConsentLocale, string>,
  );

const COMMUNICATIONS_OPT_IN = compose(OPT_IN_OPENING);
const COMMUNICATIONS_SIGN_IN = compose(SIGN_IN_OPENING);

export const CONSENT_TEXTS = Object.freeze({
  /**
   * THE ONE FORMULA THAT IS ACTUALLY SHOWN — typed-address and checkbox gates.
   *
   * Replaces the per-gate newsletter-only formulas at every gate that renders
   * `<ConsentNotice consentKey="communicationsOptIn">`. Which gate it was is
   * not lost: `consent_source_url` and `source_channel` still carry it, and
   * they are facts about the request rather than a sentence somebody wrote.
   *
   * `act: 'typed_email_submit'` is the only value in
   * `AFFIRMATIVE_CONSENT_ACTS`, so this entry — combined with a `consentGiven:
   * true` the CALL SITE sets when it really has a ticked box — is what can
   * re-open job-alert creation after PR #5722 closed it fail-closed. Nothing
   * here sets `consentGiven`: a gate with no checkbox stays at `false` and
   * creates no alert, which is the correct answer for it.
   */
  communicationsOptIn: entry({
    id: 'communications_opt_in',
    version: '2026-08-12.3',
    text: COMMUNICATIONS_OPT_IN.it,
    texts: COMMUNICATIONS_OPT_IN,
    displayed: true,
    act: 'typed_email_submit',
  }),

  /**
   * The same disclosure at a SIGN-IN gate, shown before the provider buttons.
   *
   * Deliberately still `act: 'authentication'`, which is NOT in
   * `AFFIRMATIVE_CONSENT_ACTS`: showing somebody a notice does not turn their
   * Google login into an opt-in. What it does buy is the art. 19 nLPD half —
   * the person was told, at collection time, what they were being subscribed
   * to and by whom — which is the half that was missing everywhere.
   */
  communicationsSignIn: entry({
    id: 'communications_sign_in',
    version: '2026-08-12.3',
    text: COMMUNICATIONS_SIGN_IN.it,
    texts: COMMUNICATIONS_SIGN_IN,
    displayed: true,
    act: 'authentication',
  }),

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
  /**
   * The locale the visitor is reading the site in. Optional so the paths that
   * cannot render a notice keep working unchanged; supplied by every gate that
   * renders one, because storing a sentence in a language the person does not
   * read is the defect this argument exists to remove — the popup used to SHOW
   * `newsletter.consentLabel` in German and STORE the Italian literal.
   */
  locale?: string,
): ConsentProofInput {
  const proof = CONSENT_TEXTS[key];
  return {
    consentText: consentDisplayText(key, locale),
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

/**
 * Narrow anything the UI calls a locale down to one this register has.
 * `it` is the fallback for the same reason every other i18n table in this
 * codebase falls back to it: it is the primary locale, and a formula in the
 * wrong language beats no formula.
 */
export function consentLocale(locale?: string | null): ConsentLocale {
  const key = String(locale || 'it').slice(0, 2).toLowerCase() as ConsentLocale;
  return (CONSENT_LOCALES as readonly string[]).includes(key) ? key : 'it';
}

/**
 * The exact string to SHOW, which is by construction the exact string that
 * gets STORED — `consentProof` calls this function and nothing else.
 *
 * One function, so the two halves cannot drift. A component that rendered its
 * own translation while the upsert stored `proof.text` would rebuild the very
 * gap `displayed` was invented to report.
 */
export function consentDisplayText(key: ConsentTextKey, locale?: string | null): string {
  const proof = CONSENT_TEXTS[key];
  return proof.texts ? proof.texts[consentLocale(locale)] : proof.text;
}

/** OAuth provider id (`google.com`, `facebook.com`, …) → `consent_method`. */
export function oauthConsentMethod(providerId?: string | null): ConsentMethod {
  const id = String(providerId || '').toLowerCase();
  if (id.includes('facebook')) return 'facebook_oauth';
  if (id.includes('linkedin')) return 'linkedin_oauth';
  return 'google_oauth';
}
