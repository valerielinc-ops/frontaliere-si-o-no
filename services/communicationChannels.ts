/**
 * communicationChannels.ts — every email this repo can send to a subscriber,
 * with the cadence it is ACTUALLY sent at.
 *
 * WHY IT EXISTS (#5712)
 * ---------------------
 * The consent formula in `services/consentTexts.ts` names categories and no
 * frequency, on purpose: "newsletter settimanale" is the wording that made the
 * move to a daily brief contestable (#5679), and a frequency written into a
 * consent formula cannot change without re-collecting consent. So the
 * frequency has to live somewhere a person can check — and that somewhere must
 * be generated from the send configuration rather than written by hand, or it
 * becomes a second description of the product that drifts from the first.
 *
 * This module is that source. `build-plugins/communicationsPagePlugin.ts`
 * renders `/comunicazioni/` from it; nothing on that page is prose typed
 * twice. `tests/consent-shown-at-signup.test.ts` walks `scripts/` and fails if
 * a sender exists that no entry here declares — so a tenth channel shows up on
 * the page the day it is written, not the day somebody notices the mail.
 *
 * CADENCE IS COPIED FROM THE CRON, AND THE CRON IS ASSERTED
 * --------------------------------------------------------
 * `cron` on each entry is the literal schedule expression in the workflow, and
 * the test reads the workflow file to check it still matches. That is the
 * mechanism that keeps `cadence` (the human sentence) honest: a schedule change
 * that leaves the sentence alone fails CI.
 *
 * Two of the cadences are NOT a plain reading of their cron, and saying so is
 * the point of the field being prose:
 *   - the weekly newsletter is TRIGGERED daily (`33 3 * * *`) but its campaign
 *     id is anchored to the week's Monday (`weekly_<monday>`,
 *     scripts/send-newsletter.mjs) and `fetchAlreadySent` skips whoever the
 *     campaign already reached — so a subscriber gets it once a week and the
 *     daily runs finish the list;
 *   - the followed-company alert is push-triggered on new crawler data, with
 *     an hourly cron only as a safety net.
 *
 * A CHANNEL CAN BE OFF WITHOUT A SINGLE BYTE OF THIS REPO CHANGING (#5745)
 * -----------------------------------------------------------------------
 * `Send Daily Brief Email` was disabled on 2026-08-12 — the owner's decision,
 * the daily bulletin being what the complaints were about. It was disabled the
 * way GitHub disables a workflow: `disabled_manually`, a flag on the Actions
 * API. The FILE still reads `cron: '33 6,9 * * *'`, so the cron assertion above
 * still passed, the sender still existed, and this page went on telling readers
 * they would get a bulletin "ogni giorno, in due finestre di invio".
 *
 * That is the whole reason `status` exists. Enablement is state no file in this
 * repo carries, so it has to be DECLARED here, and the declaration has to be
 * anchored to something a test can read: `send-daily-brief.yml` carries the
 * literal marker `CHANNEL-STATUS: suspended`, and
 * `tests/consent-shown-at-signup.test.ts` fails unless the marker and the
 * `status` below agree in both directions. Re-enabling the workflow therefore
 * means deleting the marker, which turns the test red until this registry — and
 * with it the page, and with it the consent formula — is brought back in line.
 *
 * `cron` stays on a suspended channel on purpose: it is still the schedule the
 * file carries, and blanking it would lose the fact that the job is one API
 * click away from running again. `cadence` is the field that must stop
 * promising, and it does.
 *
 * WHAT IS DELIBERATELY LISTED BUT NOT CONSENTED
 * ---------------------------------------------
 * `publisher-blast` carries `consentCategory: null`. It is third-party
 * advertising — a different PURPOSE, not another format of the editorial
 * category — and no formula in the consent register admits it. Listing it with
 * a null category is not an oversight to be tidied away by picking the nearest
 * one: that choice belongs to the owner (see `ADVERTISING_NOT_COVERED` in
 * services/consentTexts.ts), and quietly filing it under "editorial" is the
 * shortcut that produced 6.308 unrequested job alerts (#5705).
 *
 * The owner took that decision on 2026-08-12 and took it the safe way: the
 * channel is now `suspended` as well as uncategorised. It was the only ACTIVE
 * workflow able to mail subscribers under no consent at all, and the cost of
 * stopping it was measured first — zero paid ads in `publisher_jobs`, zero
 * blasted, zero pending. It stays listed, because a reader is entitled to know
 * the capability exists and under what condition it would return.
 */
// Relative, not `@/`: `build-plugins/communicationsPagePlugin.ts` imports this
// module and is itself reachable from vite.config.ts, which esbuild bundles
// BEFORE the `@` alias exists and without our tsconfig. A non-relative
// specifier survives into node_modules/.vite-temp/*.mjs as an external import
// and every build-locale job dies with ERR_MODULE_NOT_FOUND. Type-only erases
// today, so it would break on the day the `type` keyword is dropped —
// tests/vite-config-import-graph.test.ts refuses it now instead.
import type { ConsentLocale } from './consentTexts';

/** Which sentence of the consent formula authorises the channel. `null` = none does. */
export type ConsentCategory = 'editorial' | 'jobs' | 'service' | null;

export type LocalizedText = Readonly<Record<ConsentLocale, string>>;

/**
 * Whether the channel actually ships today.
 *
 * `suspended` means the workflow is disabled at the Actions API level — the
 * file and its cron are untouched and one click restores it. It is NOT
 * "removed": a removed channel would lose its sender and fail the
 * existence check, and a reader would stop being told the capability exists.
 */
export type ChannelStatus = 'live' | 'suspended';

/** The marker a suspended channel's workflow file must carry. See the header. */
export const SUSPENDED_WORKFLOW_MARKER = 'CHANNEL-STATUS: suspended';

export interface CommunicationChannel {
  /** Stable id, used as the anchor on the page. */
  readonly id: string;
  /** Sender script, relative to the repo root. Checked against disk. */
  readonly sender: string;
  /** Workflow that schedules it, relative to the repo root. Checked against disk. */
  readonly workflow: string;
  /**
   * The literal cron expression in that workflow, or `null` for a channel with
   * no schedule of its own (push-triggered, or manual only).
   */
  readonly cron: string | null;
  /**
   * Does it ship today? `suspended` requires the marker in the workflow file —
   * the one half of this that a test can verify from disk.
   */
  readonly status: ChannelStatus;
  /** The consent sentence that covers it, or `null` when none does. */
  readonly consentCategory: ConsentCategory;
  readonly name: LocalizedText;
  /** One line: what is inside it. */
  readonly what: LocalizedText;
  /** One line: how often it really goes out, in plain words. */
  readonly cadence: LocalizedText;
}

/**
 * The channels, in the order the page lists them: editorial, then jobs, then
 * service, then the one nobody has consented to.
 */
export const COMMUNICATION_CHANNELS: readonly CommunicationChannel[] = Object.freeze([
  Object.freeze({
    id: 'daily-brief',
    sender: 'scripts/send-daily-brief.mjs',
    workflow: '.github/workflows/send-daily-brief.yml',
    cron: '33 6,9 * * *',
    status: 'suspended',
    consentCategory: 'editorial',
    name: {
      it: 'Bollettino del Frontaliere',
      en: 'Daily brief',
      de: 'Tagesbulletin',
      fr: 'Bulletin quotidien',
    },
    what: {
      it: 'Cambio CHF/EUR, attese ai valichi, prezzi dei carburanti e le notizie del giorno per chi lavora oltre confine.',
      en: 'CHF/EUR rate, waiting times at the crossings, fuel prices and the day’s news for cross-border workers.',
      de: 'CHF/EUR-Kurs, Wartezeiten an den Grenzübergängen, Treibstoffpreise und die Nachrichten des Tages für Grenzgänger.',
      fr: 'Taux CHF/EUR, temps d’attente aux postes-frontière, prix des carburants et les nouvelles du jour pour les frontaliers.',
    },
    cadence: {
      it: 'Sospeso dal 12 agosto 2026: non viene inviato. Il workflow che lo spediva è disattivato; la pianificazione resta scritta nel file, quindi il canale può essere riattivato, ma finché questa riga non cambia non parte nulla.',
      en: 'Suspended since 12 August 2026: it is not being sent. The workflow that sent it is disabled; the schedule is still written in the file, so the channel can be switched back on, but nothing goes out until this line changes.',
      de: 'Seit dem 12. August 2026 ausgesetzt: es wird nicht versendet. Der Workflow ist deaktiviert; der Zeitplan steht weiterhin in der Datei, der Kanal kann also wieder eingeschaltet werden — bis diese Zeile sich ändert, geht nichts hinaus.',
      fr: 'Suspendu depuis le 12 août 2026 : il n’est pas envoyé. Le workflow qui l’expédiait est désactivé ; la planification reste inscrite dans le fichier, le canal peut donc être réactivé, mais tant que cette ligne ne change pas, rien ne part.',
    },
  }),
  Object.freeze({
    id: 'weekly-newsletter',
    sender: 'scripts/send-newsletter.mjs',
    workflow: '.github/workflows/send-newsletter.yml',
    cron: '33 3 * * *',
    status: 'live',
    consentCategory: 'editorial',
    name: {
      it: 'Newsletter',
      en: 'Newsletter',
      de: 'Newsletter',
      fr: 'Newsletter',
    },
    what: {
      it: 'Approfondimenti fiscali e previdenziali, un articolo in evidenza e uno strumento del sito.',
      en: 'Tax and pension explainers, a featured article and one of the site’s tools.',
      de: 'Steuer- und Vorsorgethemen, ein hervorgehobener Artikel und ein Werkzeug der Website.',
      fr: 'Analyses fiscales et de prévoyance, un article en vedette et un outil du site.',
    },
    cadence: {
      it: 'Una volta a settimana: la campagna è ancorata al lunedì e il workflow gira ogni giorno per completare gli invii rimasti.',
      en: 'Once a week: the campaign is anchored to Monday and the workflow runs daily to finish the remaining sends.',
      de: 'Einmal pro Woche: die Kampagne ist am Montag verankert, der Workflow läuft täglich, um die restlichen Sendungen abzuschliessen.',
      fr: 'Une fois par semaine : la campagne est ancrée au lundi et le workflow tourne chaque jour pour terminer les envois restants.',
    },
  }),
  Object.freeze({
    id: 'job-alerts',
    sender: 'scripts/send-job-alerts.mjs',
    workflow: '.github/workflows/send-job-alerts.yml',
    cron: '33 0 * * *',
    status: 'live',
    consentCategory: 'jobs',
    name: {
      it: 'Avvisi di lavoro',
      en: 'Job alerts',
      de: 'Stellenbenachrichtigungen',
      fr: 'Alertes d’emploi',
    },
    what: {
      it: 'Gli annunci nuovi che corrispondono ai criteri impostati: professione, cantone, tipo di contratto.',
      en: 'New listings matching the criteria you set: role, canton, contract type.',
      de: 'Neue Inserate, die den festgelegten Kriterien entsprechen: Beruf, Kanton, Vertragsart.',
      fr: 'Les nouvelles annonces correspondant aux critères définis : métier, canton, type de contrat.',
    },
    cadence: {
      it: 'Ogni giorno alle 00:33 UTC, e solo se ci sono annunci nuovi che corrispondono.',
      en: 'Every day at 00:33 UTC, and only when there are new matching listings.',
      de: 'Täglich um 00:33 UTC, und nur wenn es neue passende Inserate gibt.',
      fr: 'Chaque jour à 00:33 UTC, et seulement s’il y a de nouvelles annonces correspondantes.',
    },
  }),
  Object.freeze({
    id: 'company-alerts',
    sender: 'scripts/send-company-alerts.mjs',
    workflow: '.github/workflows/send-company-alerts.yml',
    cron: null,
    status: 'live',
    consentCategory: 'jobs',
    name: {
      it: 'Avvisi delle aziende seguite',
      en: 'Followed-employer alerts',
      de: 'Benachrichtigungen gefolgter Arbeitgeber',
      fr: 'Alertes des entreprises suivies',
    },
    what: {
      it: 'Una email quando un’azienda che segui pubblica un annuncio nuovo.',
      en: 'An email when an employer you follow posts a new listing.',
      de: 'Eine E-Mail, wenn ein Arbeitgeber, dem Sie folgen, ein neues Inserat veröffentlicht.',
      fr: 'Un e-mail lorsqu’une entreprise que vous suivez publie une nouvelle annonce.',
    },
    cadence: {
      it: 'Appena l’annuncio viene raccolto, con un controllo orario di sicurezza. Nessun invio se nessuna azienda seguita pubblica.',
      en: 'As soon as the listing is collected, with an hourly safety check. Nothing is sent if no followed employer posts.',
      de: 'Sobald das Inserat erfasst ist, mit einer stündlichen Sicherheitsprüfung. Kein Versand, wenn kein gefolgter Arbeitgeber etwas veröffentlicht.',
      fr: 'Dès que l’annonce est collectée, avec un contrôle horaire de sécurité. Aucun envoi si aucune entreprise suivie ne publie.',
    },
  }),
  Object.freeze({
    id: 'saved-jobs-digest',
    sender: 'scripts/send-saved-jobs-digest.mjs',
    workflow: '.github/workflows/send-saved-jobs-digest.yml',
    cron: '33 7 * * 1',
    status: 'live',
    consentCategory: 'jobs',
    name: {
      it: 'Digest degli annunci salvati',
      en: 'Saved-jobs digest',
      de: 'Übersicht gespeicherter Stellen',
      fr: 'Récapitulatif des offres enregistrées',
    },
    what: {
      it: 'Che fine hanno fatto gli annunci che hai salvato: ancora aperti, scaduti, o con una scadenza vicina.',
      en: 'What happened to the listings you saved: still open, expired, or closing soon.',
      de: 'Was aus den gespeicherten Inseraten geworden ist: noch offen, abgelaufen oder bald schliessend.',
      fr: 'Ce que sont devenues les offres enregistrées : encore ouvertes, expirées, ou bientôt closes.',
    },
    cadence: {
      it: 'Il lunedì alle 07:33 UTC, e solo se hai annunci salvati.',
      en: 'Mondays at 07:33 UTC, and only if you have saved listings.',
      de: 'Montags um 07:33 UTC, und nur wenn gespeicherte Inserate vorhanden sind.',
      fr: 'Le lundi à 07:33 UTC, et seulement si vous avez des offres enregistrées.',
    },
  }),
  Object.freeze({
    id: 'onboarding-drip',
    sender: 'scripts/send-onboarding-drip.mjs',
    workflow: '.github/workflows/send-onboarding-drip.yml',
    cron: '23 4 * * *',
    status: 'live',
    consentCategory: 'service',
    name: {
      it: 'Messaggi di benvenuto',
      en: 'Welcome sequence',
      de: 'Willkommensserie',
      fr: 'Séquence de bienvenue',
    },
    what: {
      it: 'Una breve serie, subito dopo l’iscrizione, su come usare il calcolatore, la bacheca annunci e le preferenze.',
      en: 'A short series, right after signup, on using the calculator, the job board and your preferences.',
      de: 'Eine kurze Serie direkt nach der Anmeldung: Rechner, Stellenbörse und Einstellungen.',
      fr: 'Une courte série, juste après l’inscription, sur le calculateur, la bourse d’emploi et vos préférences.',
    },
    cadence: {
      it: 'Solo nei primi giorni dopo l’iscrizione, un messaggio per tappa, con un controllo quotidiano alle 04:23 UTC.',
      en: 'Only in the first days after signup, one message per step, checked daily at 04:23 UTC.',
      de: 'Nur in den ersten Tagen nach der Anmeldung, eine Nachricht pro Etappe, tägliche Prüfung um 04:23 UTC.',
      fr: 'Uniquement dans les premiers jours après l’inscription, un message par étape, contrôle quotidien à 04:23 UTC.',
    },
  }),
  Object.freeze({
    id: 'dormant-winback',
    sender: 'scripts/newsletter-winback-campaign.mjs',
    workflow: '.github/workflows/newsletter-dormant-winback.yml',
    cron: '21 4 * * 4',
    status: 'live',
    consentCategory: 'service',
    name: {
      it: 'Messaggio di riattivazione',
      en: 'Win-back message',
      de: 'Reaktivierungsnachricht',
      fr: 'Message de réactivation',
    },
    what: {
      it: 'Se non apri le email da molto tempo, un messaggio che chiede se vuoi continuare a riceverle.',
      en: 'If you haven’t opened anything for a long time, a message asking whether you still want them.',
      de: 'Wenn Sie lange nichts geöffnet haben, eine Nachricht mit der Frage, ob Sie weiterhin Post wünschen.',
      fr: 'Si vous n’ouvrez plus rien depuis longtemps, un message vous demandant si vous souhaitez continuer.',
    },
    cadence: {
      it: 'Il giovedì alle 04:21 UTC, e solo per chi è inattivo da mesi.',
      en: 'Thursdays at 04:21 UTC, and only for addresses dormant for months.',
      de: 'Donnerstags um 04:21 UTC, und nur für seit Monaten inaktive Adressen.',
      fr: 'Le jeudi à 04:21 UTC, et seulement pour les adresses inactives depuis des mois.',
    },
  }),
  Object.freeze({
    id: 'sunset',
    sender: 'scripts/newsletter-sunset.mjs',
    workflow: '.github/workflows/newsletter-sunset.yml',
    cron: '11 4 * * 1',
    status: 'live',
    consentCategory: 'service',
    name: {
      it: 'Ultimo messaggio prima della chiusura',
      en: 'Final message before we stop',
      de: 'Letzte Nachricht vor dem Ende',
      fr: 'Dernier message avant l’arrêt',
    },
    what: {
      it: 'L’avviso che stiamo per smettere di scriverti, con il link per restare se lo vuoi.',
      en: 'Notice that we are about to stop writing, with a link to stay if you want to.',
      de: 'Der Hinweis, dass wir aufhören zu schreiben, mit dem Link zum Bleiben.',
      fr: 'L’avis que nous allons cesser de vous écrire, avec le lien pour rester si vous le souhaitez.',
    },
    cadence: {
      it: 'Il lunedì alle 04:11 UTC, una volta sola alla fine del percorso di riattivazione.',
      en: 'Mondays at 04:11 UTC, once only, at the end of the win-back path.',
      de: 'Montags um 04:11 UTC, nur einmal, am Ende des Reaktivierungspfads.',
      fr: 'Le lundi à 04:11 UTC, une seule fois, à la fin du parcours de réactivation.',
    },
  }),
  Object.freeze({
    id: 'publisher-blast',
    sender: 'scripts/blast-publisher-ads.mjs',
    workflow: '.github/workflows/publisher-blast.yml',
    cron: '17 7 * * *',
    status: 'suspended',
    consentCategory: null,
    name: {
      it: 'Annunci di inserzionisti',
      en: 'Advertiser announcements',
      de: 'Anzeigen von Inserenten',
      fr: 'Annonces d’annonceurs',
    },
    what: {
      it: 'Messaggi promozionali di aziende terze che pagano per raggiungere chi legge questo sito.',
      en: 'Promotional messages from third-party companies paying to reach this site’s readers.',
      de: 'Werbenachrichten von Drittfirmen, die dafür bezahlen, die Leserschaft dieser Website zu erreichen.',
      fr: 'Messages promotionnels d’entreprises tierces qui paient pour atteindre le lectorat de ce site.',
    },
    cadence: {
      it: 'Sospeso dal 12 agosto 2026: il workflow è disattivato e non parte nulla. Nessun consenso raccolto copre questo canale, ed è la ragione per cui è stato spento. Non aveva mai spedito: zero annunci a pagamento in coda al momento della sospensione.',
      en: 'Suspended since 12 August 2026: the workflow is disabled and nothing goes out. No consent we collect covers this channel, which is why it was switched off. It had never sent anything: zero paid ads queued at the time.',
      de: 'Seit dem 12. August 2026 ausgesetzt: der Workflow ist deaktiviert, es geht nichts hinaus. Keine erhobene Einwilligung deckt diesen Kanal — deshalb wurde er abgeschaltet. Er hatte nie etwas versendet: null bezahlte Anzeigen in der Warteschlange.',
      fr: 'Suspendu depuis le 12 août 2026 : le workflow est désactivé et rien ne part. Aucun consentement recueilli ne couvre ce canal, et c’est la raison de son arrêt. Il n’avait jamais rien envoyé : zéro annonce payante en attente.',
    },
  }),
]);

/**
 * Senders that exist but are NOT a channel a subscriber is on.
 *
 * Declared here rather than left out, so the exhaustiveness check in
 * `tests/consent-shown-at-signup.test.ts` can be total: every file in
 * `scripts/` that sends mail is either a channel above or a line here. An
 * omission is then a test failure instead of a page that quietly under-reports
 * what we send.
 *
 * The overlapping question — does a sender check consent before choosing a
 * recipient — lives in `tests/no-channel-mails-unconfirmed.test.ts`. Same
 * files, different question; neither list can stand in for the other.
 */
export const NON_SUBSCRIBER_SENDERS: Readonly<Record<string, string>> = Object.freeze({
  'scripts/send-cold-emails.mjs': 'employer outreach over employer_contacts — never touches a subscriber collection',
  'scripts/preview-welcome-email.mjs': 'single --target-email preview tool for the owner',
  'scripts/monitor-gsc-job-indexation.mjs': 'ops alert to the owner',
  'scripts/notify-journalist-article-live.mjs': 'internal notification to a contributor',
});

/**
 * The privacy notice, per locale. Mirrors services/routeSlugs.data.ts.
 *
 * Named here because #5765 moved the processing disclosure OFF the consent
 * formula and onto this page: the page now has to be able to point at the full
 * notice, or shortening the formula would have deleted the pointer rather than
 * relocated it.
 */
export const PRIVACY_PATH: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: '/privacy/',
  en: '/en/privacy/',
  de: '/de/datenschutz/',
  fr: '/fr/confidentialite/',
});

/** Where a person turns a channel off, per locale. Mirrors services/routeSlugs.data.ts. */
export const PREFERENCES_PATH: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: '/preferenze-newsletter/',
  en: '/en/newsletter-preferences/',
  de: '/de/newsletter-einstellungen/',
  fr: '/fr/preferences-newsletter/',
});

/** The `/comunicazioni/` URL per locale. Source of truth for the plugin and the router. */
export const COMMUNICATIONS_PAGE_PATH: Readonly<Record<ConsentLocale, string>> = Object.freeze({
  it: '/comunicazioni/',
  en: '/en/communications/',
  de: '/de/mitteilungen/',
  fr: '/fr/communications/',
});

/**
 * THE VERSION OF THIS PAGE, AND WHY A CONSENT FORMULA HAS TO NAME IT (#5765)
 * -------------------------------------------------------------------------
 * Until #5765 the consent formula carried the categories, the opt-out route
 * and the data controller inside itself, and pointed at this page only for the
 * cadences. The formula is now one line plus this link, so the disclosure a
 * person actually received is SPLIT: the sentence they read, and the page it
 * sent them to.
 *
 * That split is fine for reading and fatal for proof. A stored
 * `consent_text` that says "what I receive is on frontaliereticino.ch/comunicazioni"
 * and nothing else is evidence that points at a moving target: the page is
 * generated from the registry above, the registry changes when a cron or a
 * channel changes, and the sentence would then describe a page that no longer
 * says what it said. Producing that document in answer to an art. 25 nLPD
 * request proves nothing at all.
 *
 * So the formula embeds this identifier, the stored text therefore carries it,
 * and this constant is what an identifier has to be to be worth storing: a
 * label that CANNOT stay the same while the page changes underneath it.
 *
 * HOW THE BUMP IS FORCED, since a hand-edited constant on its own is a promise
 * -----------------------------------------------------------------------
 * `COMMUNICATIONS_PAGE_REVISIONS` maps every published version to a
 * fingerprint of the page's material content — the channel rows, the template
 * that renders them, and the controller identity printed on it.
 * `tests/consent-shown-at-signup.test.tsx` recomputes that fingerprint and
 * fails when it does not match the entry for the CURRENT version, and it also
 * pins the published revisions literally so an already-shipped version's
 * fingerprint cannot be quietly rewritten to match new content.
 *
 * The only green way through a content change is therefore: add a new version
 * with the new fingerprint, and point `COMMUNICATIONS_PAGE_VERSION` at it.
 * That edit changes the consent formula (it interpolates this constant), which
 * fails the literal pins in `tests/newsletter-consent-proof.test.ts` until the
 * formula's own `version` is bumped too. One page edit, one consent version —
 * which is the property the whole arrangement exists to buy.
 */
export const COMMUNICATIONS_PAGE_VERSION = '2026-08-13.1';

/**
 * Published version → fingerprint of the page content at that version.
 *
 * Append-only. An entry that already shipped describes what a real subscriber
 * was pointed at, so editing its fingerprint would rewrite the meaning of
 * every `consent_text` that names it.
 */
export const COMMUNICATIONS_PAGE_REVISIONS: Readonly<Record<string, string>> = Object.freeze({
  '2026-08-13.1': '28803e543beb58e2',
});

/** Channels grouped by the consent sentence that authorises them, page order preserved. */
export function channelsByCategory(category: ConsentCategory): CommunicationChannel[] {
  return COMMUNICATION_CHANNELS.filter((c) => c.consentCategory === category);
}

/** The ones that actually ship today. */
export function liveChannels(): CommunicationChannel[] {
  return COMMUNICATION_CHANNELS.filter((c) => c.status === 'live');
}

/**
 * Does anything still ship under this consent sentence?
 *
 * The invariant behind it: a category the formula asks people to agree to must
 * have at least one live channel behind it. A category with none is a promise
 * of mail that no longer comes — the same defect as an unnamed channel, facing
 * the other way, and `tests/consent-shown-at-signup.test.ts` asserts it for
 * every category the formula names.
 */
export function hasLiveChannel(category: ConsentCategory): boolean {
  return COMMUNICATION_CHANNELS.some((c) => c.consentCategory === category && c.status === 'live');
}
