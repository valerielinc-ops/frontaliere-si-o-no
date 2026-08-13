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
 * `communicationsOptIn`, `communicationsSignIn` and `communicationsSignInEmail`
 * are `displayed: true` because a component renders that sentence:
 * `components/shared/ConsentNotice.tsx` prints `consentDisplayText(key,
 * locale)`, the SAME function the stored value comes from, so the sentence on
 * screen and the sentence in the document cannot drift.
 * `tests/consent-shown-at-signup.test.tsx` refuses a `displayed: true` entry
 * whose call sites do not put its exact sentence on screen — which is what
 * stops the flag from becoming the flattering assumption it exists to prevent.
 * It compares SENTENCES and not keys, because at an access gate one notice
 * covers two acts and therefore two entries.
 *
 * WHY ONE FORMULA REPLACED THIRTEEN GATE-SPECIFIC ONES AT THE RENDERED GATES
 * -------------------------------------------------------------------------
 * The per-gate formulas below each named ONE channel (usually "la newsletter
 * per frontalieri"). Measured 2026-08-12: eight channels ship from this repo
 * — daily brief, weekly newsletter, job alerts, saved-jobs digest, onboarding
 * drip, dormant win-back, sunset, publisher blast — so a person who read one
 * of those formulas was told about a fraction of what they would receive.
 * The replacement named CATEGORIES (editorial / job alerts / service), never
 * products, and never a FREQUENCY: "settimanale" in the old popup formula is
 * exactly what made the move to a daily brief contestable (#5679). Frequency
 * lives on `CONSENT_PAGE_PATH`, generated from `services/communicationChannels.ts`,
 * where it can change without invalidating consent already collected.
 *
 * AND WHY THAT ONE FORMULA IS NOW ONE LINE (#5765)
 * ------------------------------------------------
 * The categories, the opt-out route and the controller identity made it a
 * ~700-character paragraph, printed at the moment a person is deciding whether
 * to proceed. Worse, the sign-in gates printed TWO of them at once — the
 * sign-in variant above the provider buttons and the opt-in variant under the
 * email form — so the screen made two different statements about what was
 * being agreed to while the document kept one of them. `JobBoard.tsx` did it
 * twice, once per gate surface: four notices in one file.
 *
 * The formula is therefore one sentence plus the link, and everything it used
 * to enumerate lives on the page it names. Two consequences worth stating,
 * because neither is free:
 *
 *  - the page has to CARRY what left, controller included, or shortening the
 *    formula would delete a disclosure instead of relocating it. It does:
 *    `build-plugins/communicationsPagePlugin.ts` prints the categories, the
 *    cadences, the opt-out route, the controller and the privacy notice.
 *  - a sentence that points at a page is only as good as the page's stability,
 *    so the formula embeds `COMMUNICATIONS_PAGE_VERSION` and the stored
 *    `consent_text` carries it. The page cannot change without that identifier
 *    changing — see the header of `services/communicationChannels.ts` for the
 *    mechanism that forces it — and a changed identifier is a changed formula,
 *    which is a `version` bump here.
 *
 * WHAT THAT COST, MEASURED AND NOT HIDDEN. `consentNamesJobAlerts`
 * (functions/src/jobAlertBackfillCore.js) requires the job-alert CHANNEL to be
 * named in the stored text before a newsletter opt-in may create a job alert.
 * Moving the categories to the page means no displayed formula names it any
 * more, so that path is fail-closed again — the four checkbox gates stop being
 * able to open a job alert. That is a product decision, recorded in
 * `tests/backfill-jobalerts-from-newsletter.test.ts` where the guard is
 * asserted, not a side effect to be discovered in a funnel report.
 *
 * WHAT THAT PAGE NOW ALSO CARRIES (#5759). Third-party advertising
 * (`publisher-blast.yml`) is a different PURPOSE, not a different format, and
 * for that reason it spent #5712–#5765 in no category at all. The owner ruled
 * on 2026-08-13: it is named as its own category ON THE PAGE — not in the line
 * below, which stays short — collected as an OPT-OUT with no extra checkbox,
 * and switchable off on its own. `ADVERTISING_CONSENT_BASIS` records the whole
 * shape where a call site would look for it.
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

/**
 * Value import, not type-only: the formula interpolates the version, which is
 * the whole point of #5765. `communicationChannels.ts` imports only a TYPE back
 * from this module, so the cycle erases at compile time and there is no runtime
 * import loop.
 */
import { COMMUNICATIONS_PAGE_VERSION } from './communicationChannels';

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
 * HOW THIRD-PARTY ADVERTISING IS CONSENTED TO, now that the owner has decided.
 *
 * This constant used to be called `ADVERTISING_NOT_COVERED` and it described a
 * fork: name advertising in the formula and accept that some people refuse it,
 * or do not send it to people whose consent does not cover it — "and only the
 * owner may pick". The owner picked on 2026-08-13 (#5764 §3, implemented in
 * #5759), so that sentence had to go: a comment describing an open choice that
 * has been closed is worse than no comment, because it invites the next reader
 * to re-open it and to treat the shipped behaviour as an accident.
 *
 * What was chosen, in full, because each half is load-bearing:
 *
 *  - advertising is NAMED, as its own consent category, on `/comunicazioni/` —
 *    which is where #5765 moved every category. The formulas below stay ONE
 *    line and point at that page; naming it here instead would re-inflate the
 *    sentence the owner deliberately shortened, and tell the reader nothing
 *    extra, since the page is what the sentence sends them to;
 *  - NO extra checkbox at the signup gates. The number of ticks is unchanged,
 *    so this is an OPT-OUT. That is weaker than a dedicated box and the owner
 *    recorded it as a deliberate trade: the residual risk is a recipient who
 *    says they never agreed to advertising, and the answer to them is the
 *    sentence that names it plus the switch that stops it;
 *  - that switch is `ADVERTISING_OPT_OUT_FIELD`
 *    (services/communicationChannels.ts), rendered in the preference centre
 *    beside the other channels and read by services/publisherBlastMatch.mjs.
 *
 * And what it still does NOT cover, which is not a leftover of the old fork but
 * a consequence of this one: a subscriber whose stored `consent_text` names a
 * page version older than `ADVERTISING_NAMED_FROM_PAGE_VERSION` read a page
 * that did not mention advertising. The owner's defence does not exist for
 * them, so the blast may not reach them, and the matcher enforces it.
 *
 * Slipping the channel under "aggiornamenti redazionali" is still the shortcut
 * that produced the 6.308 unrequested job alerts (#5705). It has a category of
 * its own precisely so nobody needs to.
 */
export const ADVERTISING_CONSENT_BASIS =
  'owner decision 2026-08-13 (#5764 §3, #5759) — third-party advertising (publisher-blast.yml) is its own consent category, named on /comunicazioni/ and collected as an OPT-OUT: no extra checkbox, a per-channel switch in the preference centre, and no send to a subscriber whose stored consent_text predates the page version that named it';

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
 * The second half of both displayed formulas: what the page answers, and which
 * version of it the person was pointed at.
 *
 * Four questions, in the order somebody actually asks them, and then the
 * address. Nothing here states a cadence — the words are "con che frequenza",
 * a pointer to the answer rather than the answer — for the same reason as
 * before (#5679): a frequency inside a consent formula cannot change without
 * collecting consent again.
 *
 * `COMMUNICATIONS_PAGE_VERSION` is inside the sentence, not beside it, so that
 * it survives into `consent_text` without any call site remembering to attach
 * it. A proof that named a page but not its revision would point at content
 * free to change afterwards, which is the specific way this shortening could
 * have made the register weaker instead of clearer.
 */
const POINTER: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: `Cosa ricevo, con che frequenza, come disdire e chi tratta i dati: ${CONSENT_PAGE_LABEL} (versione ${COMMUNICATIONS_PAGE_VERSION}).`,
  en: `What I receive, how often, how to stop it and who processes the data: ${CONSENT_PAGE_LABEL} (version ${COMMUNICATIONS_PAGE_VERSION}).`,
  de: `Was ich erhalte, wie oft, wie ich abbestelle und wer die Daten bearbeitet: ${CONSENT_PAGE_LABEL} (Version ${COMMUNICATIONS_PAGE_VERSION}).`,
  fr: `Ce que je reçois, à quelle fréquence, comment me désinscrire et qui traite les données : ${CONSENT_PAGE_LABEL} (version ${COMMUNICATIONS_PAGE_VERSION}).`,
});

/**
 * The opening at an ACCESS gate — a modal or panel offering provider buttons
 * and a "continue with email" button for the same purpose.
 *
 * "Accedendo" covers both branches of such a gate on purpose, and that is what
 * lets one notice stand under the email button for the whole gate instead of
 * one notice per branch. It is also load-bearing for
 * `tests/newsletter-consent-proof.test.ts`, which refuses an `authentication`
 * entry whose text does not describe the sign-in.
 */
const ACCESS_OPENING: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: 'Accedendo iscrivo il mio indirizzo alle comunicazioni di Frontaliere Ticino.',
  en: 'By signing in I subscribe my address to the Frontaliere Ticino communications.',
  de: 'Mit der Anmeldung trage ich meine Adresse in die Mitteilungen von Frontaliere Ticino ein.',
  fr: 'En me connectant, j’inscris mon adresse aux communications de Frontaliere Ticino.',
});

/**
 * The opening at a form whose only control is an address field — a newsletter
 * box, a guide-for-address form, an unlock form.
 *
 * It deliberately does NOT say "accedendo": there is no sign-in at those gates
 * and a formula that described one would misdescribe the act, which is the
 * fabrication this whole register exists to refuse. That is the only difference
 * between the two sentences.
 */
const SUBSCRIBE_OPENING: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: 'Iscrivo il mio indirizzo alle comunicazioni di Frontaliere Ticino.',
  en: 'I subscribe my address to the Frontaliere Ticino communications.',
  de: 'Ich trage meine Adresse in die Mitteilungen von Frontaliere Ticino ein.',
  fr: 'J’inscris mon adresse aux communications de Frontaliere Ticino.',
});

const compose = (
  opening: Readonly<Record<ConsentLocale, string>>,
): Readonly<Record<ConsentLocale, string>> =>
  Object.freeze(
    Object.fromEntries(
      CONSENT_LOCALES.map((l) => [l, `${opening[l]} ${POINTER[l]}`]),
    ) as Record<ConsentLocale, string>,
  );

const COMMUNICATIONS_OPT_IN = compose(SUBSCRIBE_OPENING);
const COMMUNICATIONS_SIGN_IN = compose(ACCESS_OPENING);

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
    version: '2026-08-13.2',
    text: COMMUNICATIONS_OPT_IN.it,
    texts: COMMUNICATIONS_OPT_IN,
    displayed: true,
    act: 'typed_email_submit',
  }),

  /**
   * The disclosure at an ACCESS gate, taken by somebody who used a provider
   * button.
   *
   * Deliberately still `act: 'authentication'`, which is NOT in
   * `AFFIRMATIVE_CONSENT_ACTS`: showing somebody a notice does not turn their
   * Google login into an opt-in. What it does buy is the art. 19 nLPD half —
   * the person was told, at collection time, what they were being subscribed
   * to and where to find the rest — which is the half that was missing
   * everywhere.
   *
   * SHOWN ONCE, UNDER THE EMAIL BUTTON (#5765). It used to be printed above
   * the provider buttons while `communicationsOptIn` was printed under the
   * email form of the SAME gate: two sentences, one screen, one of them stored.
   * There is now one notice for the whole gate, and the entry below is what
   * lets the other branch of that gate store the very sentence it displayed.
   */
  communicationsSignIn: entry({
    id: 'communications_sign_in',
    version: '2026-08-13.2',
    text: COMMUNICATIONS_SIGN_IN.it,
    texts: COMMUNICATIONS_SIGN_IN,
    displayed: true,
    act: 'authentication',
  }),

  /**
   * The email branch of an ACCESS gate: same notice, different act.
   *
   * WHY A THIRD ENTRY AND NOT A REUSE OF `communicationsOptIn` (#5765)
   * ------------------------------------------------------------------
   * An access gate offers two ways through one door, and only one notice may
   * stand at it. Whoever takes the other way must still store the bytes that
   * were on screen — otherwise the single notice would have re-created, in the
   * document instead of on the screen, exactly the divergence it was put there
   * to remove.
   *
   * `act` cannot be shared to solve it: typing an address IS a different thing
   * from signing in, it is the only value in `AFFIRMATIVE_CONSENT_ACTS`, and
   * recording either one as the other misdescribes what the person did. So the
   * TEXT is shared and the ACT is not — byte-identical to
   * `communicationsSignIn`, asserted in tests/newsletter-consent-proof.test.ts,
   * the same shape `publisherGateSocial`/`publisherGateEmail` already use.
   *
   * `displayed: true` without any JSX naming this key is therefore correct and
   * is checked as such: `tests/consent-shown-at-signup.test.tsx` compares the
   * stored SENTENCE against the rendered one, in all four locales, rather than
   * comparing keys — which is the claim `displayed` actually makes.
   */
  communicationsSignInEmail: entry({
    id: 'communications_sign_in_email',
    version: '2026-08-13.2',
    text: COMMUNICATIONS_SIGN_IN.it,
    texts: COMMUNICATIONS_SIGN_IN,
    displayed: true,
    act: 'typed_email_submit',
  }),

  /**
   * App.tsx / hooks/useUserState.ts / authService One Tap: sign-in auto-subscribe.
   *
   * REWRITTEN AT `2026-08-12.2`, AND WHY THIS ONE AND NOT THE OTHERS (#5745)
   * -----------------------------------------------------------------------
   * It used to promise "la newsletter per frontalieri (cambio CHF/EUR,
   * traffico di frontiera e novità fiscali)" — the same two items the
   * displayed formulas' category clause lost at `2026-08-12.3`, for the same
   * reason: only the daily brief carried them and the owner disabled it on
   * 2026-08-12. (That clause itself is gone at `2026-08-13.1`: #5765 moved the
   * categories onto `/comunicazioni/`. This entry keeps its own wording, since
   * nothing renders it — see below.)
   *
   * The register's standing rule is that a formula is NOT re-worded, because
   * doing so changes what future subscribers are recorded as having been told
   * for reasons unconnected to the fix — `saveJobSignIn`, `companyFollow` and
   * the two publisher gates are kept byte-identical on exactly that ground.
   * The distinguishing fact here is measurable, and was measured: of the
   * fifteen `displayed: false` entries, only THIS one and `chatbotSignIn` are
   * still reachable from code (3 call sites and 1; the other thirteen have
   * zero and are historical records of what past subscribers were told).
   *
   * So these two are not history, they are the disclosure IN FORCE at a gate
   * that still fires today — and a disclosure in force may not promise mail
   * that no live channel sends. History stays frozen; what is still being
   * handed out gets corrected, and the version bump is what keeps the two
   * facts distinguishable on the stored documents.
   */
  signInAutoSubscribe: entry({
    id: 'signin_auto_subscribe',
    version: '2026-08-12.2',
    text: `Accedendo con Google, Facebook o LinkedIn a Frontaliere Ticino, l’indirizzo email dell’account viene iscritto alle comunicazioni di Frontaliere Ticino: aggiornamenti redazionali (fisco, previdenza, novità normative e approfondimenti per chi lavora oltre confine) e messaggi di servizio sul mio account. L’accesso al sito è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. L’elenco completo, con la frequenza di ciascuna comunicazione, è su ${CONSENT_PAGE_LABEL}. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.`,
    displayed: false,
    act: 'authentication',
  }),

  /** App.tsx chatbot sign-in (chatbot_google / chatbot_facebook / chatbot_email). See `signInAutoSubscribe` for why this one was rewritten. */
  chatbotSignIn: entry({
    id: 'chatbot_signin',
    version: '2026-08-12.2',
    text: `Accedendo dall’assistente di Frontaliere Ticino per continuare la conversazione, l’indirizzo email viene iscritto alle comunicazioni di Frontaliere Ticino: aggiornamenti redazionali (fisco, previdenza, novità normative e approfondimenti per chi lavora oltre confine) e messaggi di servizio sul mio account. Proseguire con l’assistente è l’unico gesto compiuto: nessuna casella di consenso è stata proposta. L’elenco completo, con la frequenza di ciascuna comunicazione, è su ${CONSENT_PAGE_LABEL}. Posso disiscrivermi in qualsiasi momento dal link in fondo a ogni email.`,
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
