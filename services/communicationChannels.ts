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
 * WHAT IS DELIBERATELY LISTED BUT NOT CONSENTED
 * ---------------------------------------------
 * `publisher-blast` carries `consentCategory: null`. It is third-party
 * advertising — a different PURPOSE, not another format of the editorial
 * category — and no formula in the consent register admits it. Listing it with
 * a null category is not an oversight to be tidied away by picking the nearest
 * one: that choice belongs to the owner (see `ADVERTISING_NOT_COVERED` in
 * services/consentTexts.ts), and quietly filing it under "editorial" is the
 * shortcut that produced 6.308 unrequested job alerts (#5705).
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
      it: 'Ogni giorno, in due finestre di invio (06:33 e 09:33 UTC).',
      en: 'Every day, in two send windows (06:33 and 09:33 UTC).',
      de: 'Täglich, in zwei Versandfenstern (06:33 und 09:33 UTC).',
      fr: 'Chaque jour, en deux fenêtres d’envoi (06:33 et 09:33 UTC).',
    },
  }),
  Object.freeze({
    id: 'weekly-newsletter',
    sender: 'scripts/send-newsletter.mjs',
    workflow: '.github/workflows/send-newsletter.yml',
    cron: '33 3 * * *',
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
      it: 'Nessun consenso raccolto copre questo canale: finché la scelta non è presa, non deve partire. Il workflow esiste ed è schedulato alle 07:17 UTC.',
      en: 'No consent we collect covers this channel: until that decision is made it must not go out. The workflow exists and is scheduled at 07:17 UTC.',
      de: 'Keine erhobene Einwilligung deckt diesen Kanal: bis zur Entscheidung darf er nicht versendet werden. Der Workflow existiert und ist auf 07:17 UTC geplant.',
      fr: 'Aucun consentement recueilli ne couvre ce canal : tant que la décision n’est pas prise, il ne doit pas partir. Le workflow existe et est planifié à 07:17 UTC.',
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

/** Channels grouped by the consent sentence that authorises them, page order preserved. */
export function channelsByCategory(category: ConsentCategory): CommunicationChannel[] {
  return COMMUNICATION_CHANNELS.filter((c) => c.consentCategory === category);
}
