/**
 * communicationsPagePlugin — `/comunicazioni/` and its three locale twins.
 *
 * WHY IT IS GENERATED AND NOT WRITTEN (#5712)
 * ------------------------------------------
 * The consent formula in `services/consentTexts.ts` states no frequency, on
 * purpose: "newsletter settimanale" is the wording that made the switch to a
 * daily brief contestable (#5679), and a frequency baked into a consent
 * formula cannot change without collecting consent again. The frequency
 * therefore has to be published somewhere else — and if that somewhere else
 * were hand-written prose it would be a SECOND description of what we send,
 * free to drift from the first the moment a cron changes.
 *
 * So every row on this page comes from `services/communicationChannels.ts`,
 * which also names the sender script and the workflow of each channel.
 * `tests/consent-shown-at-signup.test.ts` reads those workflow files and fails
 * when a cron no longer matches the registry, and fails again when a sender
 * exists that the registry does not list. The page cannot quietly under-report
 * what leaves this repo.
 *
 * A CADENCE IS A PROMISE, SO A DEAD CHANNEL MAY NOT SHOW ONE (#5745)
 * ------------------------------------------------------------------
 * The daily brief was disabled on 2026-08-12 at the Actions API level, which
 * changes no file — its cron is still written out, so every check this page
 * relies on stayed green while the page went on saying "ogni giorno, in due
 * finestre di invio". Rows therefore render `status` from the registry: a
 * suspended channel keeps its place under its category and is labelled as not
 * being sent, rather than dropped (dropping it would deny a capability that is
 * one click from returning) or left looking live.
 *
 * ROUTING. Emitted outside `#root` by `buildSeoPageHtml`, so `services/router.ts`
 * carries a `staticOverlay` branch for these four paths — without it the SPA
 * treats the URL as unknown on hydrate, hides `main.seo-static-content` and
 * renders NotFoundSuggestions over a page that exists. Same mechanism, and the
 * same failure mode, as `/moduli/autocertificazione-candidatura/`.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import {
  esc,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  H3_STYLE,
} from './shared/seoContentTokens';
import {
  COMMUNICATION_CHANNELS,
  COMMUNICATIONS_PAGE_PATH,
  COMMUNICATIONS_PAGE_VERSION,
  CONSENT_CATEGORIES,
  PREFERENCES_PATH,
  PRIVACY_PATH,
  isUncoveredChannel,
  type CommunicationChannel,
  type NamedConsentCategory,
} from '../services/communicationChannels';
// Relative into functions/src/lib/ for the same reason every mail template
// reaches it that way: it is the single source of the controller identity and
// firebase.json's deploy boundary keeps it out of services/.
import { DATA_CONTROLLER_FOOTER_LINE } from '../functions/src/lib/dataControllerIdentity.js';

type PageLocale = 'it' | 'en' | 'de' | 'fr';
const LOCALES: readonly PageLocale[] = ['it', 'en', 'de', 'fr'];

/** Home-crumb label, per locale — matches build-plugins/shared/bridgeBreadcrumb.ts. */
const HOME_LABEL: Record<PageLocale, string> = {
  it: 'Home',
  en: 'Home',
  de: 'Startseite',
  fr: 'Accueil',
};

const TITLE: Record<PageLocale, string> = {
  it: 'Le comunicazioni che inviamo, con la frequenza di ciascuna | Frontaliere Ticino',
  en: 'The communications we send, and how often | Frontaliere Ticino',
  de: 'Unsere Mitteilungen und ihre Häufigkeit | Frontaliere Ticino',
  fr: 'Les communications que nous envoyons, et à quelle fréquence | Frontaliere Ticino',
};

const H1: Record<PageLocale, string> = {
  it: 'Le comunicazioni di Frontaliere Ticino',
  en: 'Frontaliere Ticino communications',
  de: 'Die Mitteilungen von Frontaliere Ticino',
  fr: 'Les communications de Frontaliere Ticino',
};

const DESCRIPTION: Record<PageLocale, string> = {
  it: 'Ogni email che Frontaliere Ticino può inviarti, con la frequenza reale di ciascuna e il modo per disattivarla. L’elenco è generato dalla configurazione degli invii, non scritto a mano.',
  en: 'Every email Frontaliere Ticino can send you, with its real cadence and how to turn it off. The list is generated from the send configuration, not written by hand.',
  de: 'Jede E-Mail, die Frontaliere Ticino Ihnen senden kann, mit ihrer tatsächlichen Häufigkeit und dem Weg zur Abmeldung. Die Liste wird aus der Versandkonfiguration erzeugt, nicht von Hand geschrieben.',
  fr: 'Chaque e-mail que Frontaliere Ticino peut vous envoyer, avec sa fréquence réelle et la façon de le désactiver. La liste est générée depuis la configuration des envois, non rédigée à la main.',
};

const LEDE: Record<PageLocale, string> = {
  it: 'Questa pagina è l’elenco completo. È generata dalla configurazione degli invii: se un canale non compare qui, non parte; se una frequenza cambia, cambia qui. I canali sospesi restano elencati e segnalati come tali, così si vede anche ciò che per ora non ricevi.',
  en: 'This page is the complete list. It is generated from the send configuration: a channel that is not here does not go out, and a cadence that changes, changes here. Suspended channels stay listed and are marked as such, so you can also see what you are not receiving for now.',
  de: 'Diese Seite ist die vollständige Liste. Sie wird aus der Versandkonfiguration erzeugt: Ein Kanal, der hier fehlt, wird nicht versendet, und eine geänderte Häufigkeit ändert sich hier. Ausgesetzte Kanäle bleiben aufgeführt und sind als solche gekennzeichnet, damit auch sichtbar ist, was Sie derzeit nicht erhalten.',
  fr: 'Cette page est la liste complète. Elle est générée depuis la configuration des envois : un canal absent d’ici ne part pas, et une fréquence qui change, change ici. Les canaux suspendus restent listés et sont signalés comme tels, afin que vous voyiez aussi ce que vous ne recevez pas pour l’instant.',
};

const CATEGORY_HEADING: Record<NamedConsentCategory, Record<PageLocale, string>> = {
  editorial: {
    it: 'Aggiornamenti redazionali',
    en: 'Editorial updates',
    de: 'Redaktionelle Updates',
    fr: 'Mises à jour éditoriales',
  },
  jobs: {
    it: 'Avvisi di lavoro',
    en: 'Job alerts',
    de: 'Stellenbenachrichtigungen',
    fr: 'Alertes d’emploi',
  },
  service: {
    it: 'Messaggi di servizio',
    en: 'Service messages',
    de: 'Servicenachrichten',
    fr: 'Messages de service',
  },
  /**
   * WHERE THIRD-PARTY ADVERTISING IS NAMED (#5759).
   *
   * #5765 moved every category off the consent formula and onto this page, and
   * left the formula one line pointing here. So "name advertising in the
   * consent text" means naming it HERE — this heading, in the reader's own
   * language, is the disclosure the stored `consent_text` refers to. Putting it
   * back into the sentence would undo the shortening the owner asked for and
   * change nothing about what the reader is told.
   *
   * A category, never an advertiser: the whole point of the page being generic
   * is that a second advertising channel needs no new text and no re-collected
   * consent.
   */
  advertising: {
    it: 'Pubblicità di terzi',
    en: 'Third-party advertising',
    de: 'Werbung Dritter',
    fr: 'Publicité de tiers',
  },
};

/**
 * What a category needs said about it beyond its channel rows.
 *
 * Only `advertising` has one, and it is not decoration: it is where the page
 * explains that the category belongs to the base registration while keeping a
 * separate preference-centre switch for withdrawal. A reader who wants to
 * contest the reach is entitled to find, on the page their proof names, the
 * category, recipients and opt-out route.
 */
const CATEGORY_NOTE: Partial<Record<NamedConsentCategory, Record<PageLocale, string>>> = {
  advertising: {
    it: 'Questa categoria fa parte dell’attivazione base delle comunicazioni ed è attiva per impostazione predefinita dopo la conferma dell’indirizzo. La mostriamo come interruttore separato nelle preferenze per permetterti di disattivarla senza toccare newsletter, bollettino o avvisi di lavoro. Se il canale verrà riattivato, potrà raggiungere chi non l’ha disattivato.',
    en: 'This category is part of the base communications activation and is on by default after the address is confirmed. We show it as a separate preference switch so you can turn it off without changing the newsletter, daily brief or job alerts. If the channel is switched back on, it may reach people who have not switched it off.',
    de: 'Diese Kategorie gehört zur Basisaktivierung der Mitteilungen und ist nach der Bestätigung der Adresse standardmässig aktiv. Wir führen sie als eigenen Schalter in den Einstellungen, damit Sie sie ausschalten können, ohne Newsletter, Tagesbulletin oder Stellenbenachrichtigungen zu ändern. Wird der Kanal wieder eingeschaltet, kann er Personen erreichen, die ihn nicht deaktiviert haben.',
    fr: 'Cette catégorie fait partie de l’activation de base des communications et est active par défaut après la confirmation de l’adresse. Nous l’affichons comme un interrupteur distinct dans les préférences afin que vous puissiez la désactiver sans modifier la newsletter, le bulletin quotidien ni les alertes emploi. Si le canal est réactivé, il pourra atteindre les personnes qui ne l’ont pas désactivé.',
  },
};

/**
 * The residual section, and why it stays although it is EMPTY today (#5759).
 *
 * `publisher-blast` was its only occupant until the owner gave advertising its
 * own category. Deleting the section with its occupant would remove the one
 * place a channel outside every category can surface — and `isUncoveredChannel`
 * treats an absent field, a `null` and an unrecognised value alike, so the next
 * channel that arrives with no category lands here instead of vanishing from
 * the page. The wording is therefore generic now: it describes the situation,
 * not the advertising channel that used to be in it.
 */
const UNCONSENTED_HEADING: Record<PageLocale, string> = {
  it: 'Non coperto da nessun consenso raccolto',
  en: 'Covered by no consent we collect',
  de: 'Von keiner erhobenen Einwilligung abgedeckt',
  fr: 'Couvert par aucun consentement recueilli',
};

const UNCONSENTED_NOTE: Record<PageLocale, string> = {
  it: 'Un canale elencato qui persegue uno scopo che nessuna delle categorie sopra comprende. Finché non è nominato esplicitamente in una categoria di consenso, non deve raggiungere chi si è iscritto sotto quelle formule.',
  en: 'A channel listed here serves a purpose none of the categories above covers. Until it is named explicitly in a consent category, it must not reach people who subscribed under those formulas.',
  de: 'Ein hier aufgeführter Kanal verfolgt einen Zweck, den keine der Kategorien oben abdeckt. Solange er nicht ausdrücklich in einer Einwilligungskategorie genannt wird, darf er die unter jenen Formeln angemeldeten Personen nicht erreichen.',
  fr: 'Un canal listé ici poursuit une finalité qu’aucune des catégories ci-dessus ne couvre. Tant qu’il n’est pas nommé explicitement dans une catégorie de consentement, il ne doit pas atteindre les personnes inscrites sous ces formules.',
};

const CADENCE_LABEL: Record<PageLocale, string> = {
  it: 'Frequenza',
  en: 'Cadence',
  de: 'Häufigkeit',
  fr: 'Fréquence',
};

/**
 * The badge on a channel that is switched off (#5745).
 *
 * A suspended channel stays listed, and stays listed under its own category,
 * for two reasons. Removing it would tell a reader the capability does not
 * exist when it is one API click away; and the sender script would still be on
 * disk, so the exhaustiveness check would fail — correctly. What changes is
 * that the row states plainly that nothing is being sent, instead of a cadence
 * the reader would take as a promise.
 */
const SUSPENDED_LABEL: Record<PageLocale, string> = {
  it: 'Sospeso — non viene inviato',
  en: 'Suspended — not being sent',
  de: 'Ausgesetzt — wird nicht versendet',
  fr: 'Suspendu — n’est pas envoyé',
};

const OPT_OUT_LABEL: Record<PageLocale, string> = {
  it: 'Per disattivarlo',
  en: 'To turn it off',
  de: 'Zum Abschalten',
  fr: 'Pour le désactiver',
};

const OPT_OUT_TEXT: Record<PageLocale, string> = {
  it: 'dalle tue preferenze, oppure dal link di disiscrizione in fondo a ogni email.',
  en: 'from your preferences, or from the unsubscribe link at the bottom of every email.',
  de: 'in Ihren Einstellungen oder über den Abmeldelink am Ende jeder E-Mail.',
  fr: 'depuis vos préférences, ou via le lien de désinscription en bas de chaque e-mail.',
};

const PREFERENCES_CTA: Record<PageLocale, string> = {
  it: 'Apri le tue preferenze',
  en: 'Open your preferences',
  de: 'Einstellungen öffnen',
  fr: 'Ouvrir vos préférences',
};

/**
 * WHO PROCESSES THE DATA — moved here from inside the consent formula (#5765).
 *
 * The formula used to end with the controller's name and address, because art.
 * 19 nLPD wants the controller identifiable AT COLLECTION and #5675 found the
 * privacy notice naming nobody at all. #5765 shortened the formula to one line,
 * and the disclosure has to land somewhere: the line now says "chi tratta i
 * dati" and points here, so this section is the other half of that sentence,
 * not an optional extra. Removing it would put the notice back to naming no
 * controller anywhere a subscriber is asked to agree.
 *
 * The identity itself comes from the single source every lifecycle email uses,
 * so the page and the mail footers cannot disagree.
 */
const CONTROLLER_HEADING: Record<PageLocale, string> = {
  it: 'Chi tratta i tuoi dati',
  en: 'Who processes your data',
  de: 'Wer Ihre Daten bearbeitet',
  fr: 'Qui traite vos données',
};

const CONTROLLER_NOTE: Record<PageLocale, string> = {
  it: 'Il tuo indirizzo email serve a inviarti le comunicazioni elencate qui sopra e a farti riconoscere quando accedi. Puoi chiedere in qualsiasi momento quali dati abbiamo, farli correggere o farli cancellare, scrivendo all’indirizzo qui sotto.',
  en: 'Your email address is used to send you the communications listed above and to recognise you when you sign in. You can ask at any time what data we hold, have it corrected, or have it deleted, by writing to the address below.',
  de: 'Ihre E-Mail-Adresse dient dazu, Ihnen die oben aufgeführten Mitteilungen zuzustellen und Sie beim Anmelden wiederzuerkennen. Sie können jederzeit erfragen, welche Daten wir haben, sie berichtigen oder löschen lassen — schreiben Sie an die untenstehende Adresse.',
  fr: 'Votre adresse e-mail sert à vous envoyer les communications listées ci-dessus et à vous reconnaître lorsque vous vous connectez. Vous pouvez à tout moment demander quelles données nous détenons, les faire corriger ou les faire supprimer, en écrivant à l’adresse ci-dessous.',
};

const PRIVACY_CTA: Record<PageLocale, string> = {
  it: 'Informativa completa sul trattamento dei dati',
  en: 'Full privacy notice',
  de: 'Vollständige Datenschutzerklärung',
  fr: 'Politique de confidentialité complète',
};

/**
 * WHAT THE CONSENT HAS TO COVER FOR THE OWNER TO BE ABLE TO DO IT AT ALL.
 *
 * Owner's decision of 2026-08-14, second half: they want to be able to
 * communicate subscriber data to third parties for advertising and commercial
 * purposes, and to transfer the data together with the business if the site is
 * sold. Under the nLPD a consent covers the purposes it NAMES, so a purpose
 * nobody has been told about is not consented to however the sentence is
 * phrased — which is why this is text and not a flag somewhere.
 *
 * CATEGORIES, NEVER COMPANY NAMES. That is the property that makes the same
 * text valid for a partner who does not exist yet, and it is the same property
 * the channel rows above are built on: a new advertiser tomorrow is covered by
 * "partner pubblicitari e commerciali" without a re-collection. Naming an
 * advertiser would buy nothing and would have to be maintained.
 *
 * AND NO OMNIBUS CLAUSE. There is deliberately no "and for any other future
 * purpose": a catch-all does not extend the consent — the purposes have to be
 * determinate, so the clause is inoperative on exactly the things it did not
 * name — while making the text read as if everything were covered. It is the
 * one addition that would look like protection and be the opposite.
 *
 * NOTHING HERE IS COPIED FROM ANOTHER SITE'S POLICY. Each item describes what
 * THIS repo does, checked against it: `services/publisherBlastMatch.mjs` scores
 * subscribers against one paid ad, `functions/src/lib/engagementScore.js` and
 * `services/newsletter-priority.mjs` rank the list by open/click behaviour,
 * `services/jobMatchProfile.ts` re-ranks the job board per person. What the
 * repo does NOT do is stated as not done, and the list stops there: a borrowed
 * paragraph describes somebody else's processing and is worthless as proof of
 * our own.
 */
const SHARING_HEADING: Record<PageLocale, string> = {
  it: 'A chi possono essere comunicati i tuoi dati, e per quali finalità',
  en: 'Who your data may be shared with, and for what purposes',
  de: 'An wen Ihre Daten weitergegeben werden können, und zu welchen Zwecken',
  fr: 'À qui vos données peuvent être communiquées, et à quelles fins',
};

const SHARING_INTRO: Record<PageLocale, string> = {
  it: 'Qui sotto trovi le categorie di destinatari e le finalità, non i nomi delle singole aziende. Possiamo cambiare un fornitore tecnico per la stessa finalità già descritta, rispettando le garanzie applicabili; per la pubblicità di terzi la registrazione base copre la comunicazione o il trasferimento dei dati agli inserzionisti e ai partner pubblicitari per le finalità commerciali descritte qui sotto. Quello che non è nominato non è coperto.',
  en: 'Below are the categories of recipient and the purposes, not the names of individual companies. We may change a technical supplier for the same purpose already described, subject to the applicable safeguards; for third-party advertising, the base registration covers communicating or transferring data to advertisers and advertising partners for the commercial purposes described below. What is not named is not covered.',
  de: 'Nachstehend finden Sie die Kategorien von Empfängern und die Zwecke, nicht die Namen einzelner Unternehmen. Wir können einen technischen Dienstleister für denselben bereits beschriebenen Zweck wechseln, unter Einhaltung der anwendbaren Garantien; für Werbung Dritter umfasst die Basisregistrierung die Übermittlung oder Übertragung von Daten an Inserenten und Werbepartner für die unten beschriebenen kommerziellen Zwecke. Was nicht genannt ist, ist nicht abgedeckt.',
  fr: 'Vous trouverez ci-dessous les catégories de destinataires et les finalités, et non les noms des entreprises. Nous pouvons changer de prestataire technique pour la même finalité déjà décrite, dans le respect des garanties applicables ; pour la publicité de tiers, l’inscription de base couvre la communication ou le transfert de données aux annonceurs et partenaires publicitaires pour les finalités commerciales décrites ci-dessous. Ce qui n’est pas nommé n’est pas couvert.',
};

const SHARING_ITEMS: Record<PageLocale, readonly { lead: string; body: string }[]> = {
  it: [
    {
      lead: 'Annunci di terzi.',
      body: 'Il canale email degli annunci di terzi è oggi sospeso. Se verrà riattivato, potremo inviare messaggi promozionali di terzi agli iscritti del rapporto base che non avranno disattivato questa categoria e potremo comunicare, mettere a disposizione o cedere il loro indirizzo email e le informazioni dichiarate o derivate dalle interazioni agli inserzionisti e ai partner pubblicitari per le loro finalità commerciali. I circuiti pubblicitari presenti sulle pagine del sito possono raccogliere identificativi del browser e dati di navigazione secondo il consenso cookie e sono descritti nell’informativa completa.',
    },
    {
      lead: 'Profilazione a fini commerciali.',
      body: 'Usiamo ciò che ci hai indicato tu — professione cercata, settore, luogo, annunci salvati, aziende seguite — e il modo in cui interagisci con le nostre email e con il sito — se le apri, su quali link clicchi, da quanto tempo non le apri — per scegliere contenuti, annunci di lavoro e messaggi promozionali pertinenti. Queste informazioni possono essere messe a disposizione dei partner pubblicitari per selezionare messaggi commerciali, salvo la disattivazione della categoria. Nessuna di queste elaborazioni produce decisioni automatizzate con effetti giuridici o economici nei tuoi confronti.',
    },
    {
      lead: 'Cambio di titolare.',
      body: 'Un’eventuale cessione, fusione o vendita dell’attività può trasferire al successore il rapporto base e i dati necessari, compresa la possibilità di proseguire le finalità commerciali qui descritte. In caso di cambio di titolare o di finalità, ti forniremo l’informativa richiesta e raccoglieremo un nuovo consenso quando necessario prima di usare i dati per lo scopo modificato.',
    },
    {
      lead: 'Fornitori che lavorano per noi.',
      body: 'Servizi di invio e recapito delle email, hosting e infrastruttura, misurazione del traffico e strumenti di generazione dei testi trattano i dati per nostro conto e secondo le nostre istruzioni, non per finalità proprie. L’elenco per categoria e i Paesi coinvolti sono nell’informativa completa.',
    },
  ],
  en: [
    {
      lead: 'Third-party advertising.',
      body: 'The third-party email-ad channel is currently suspended. If it is reactivated, we may send promotional messages from third parties to base subscribers who have not switched this category off, and may communicate, make available or transfer their email address and declared or interaction-derived information to advertisers and advertising partners for their own commercial purposes. Advertising networks on site pages may collect browser identifiers and browsing data under the cookie consent choice; they are described in the full privacy notice.',
    },
    {
      lead: 'Profiling for relevant content.',
      body: 'We use what you told us — the role you searched for, sector, place, saved listings and followed employers — and how you interact with our emails and the site — whether you open them and which links you click — to choose relevant content, job listings and promotional messages. This information may be made available to advertising partners to select commercial messages, unless you switch the category off. None of this produces automated decisions with legal or economic effects on you.',
    },
    {
      lead: 'Change of controller.',
      body: 'A sale, merger or transfer of the business may transfer the base relationship and the necessary data to the successor, including the commercial purposes described here. If the controller or purposes change, we will provide the information required and obtain fresh consent where necessary before using the data for the changed purpose.',
    },
    {
      lead: 'Suppliers working for us.',
      body: 'Email sending and delivery services, hosting and infrastructure, traffic measurement and text-generation tools process the data on our behalf and on our instructions, not for purposes of their own. The list by category and the countries involved are in the full privacy notice.',
    },
  ],
  de: [
    {
      lead: 'Werbung Dritter.',
      body: 'Der E-Mail-Kanal für Werbung Dritter ist derzeit ausgesetzt. Bei einer Reaktivierung können wir Werbenachrichten von Dritten an Basis-Abonnenten senden, die diese Kategorie nicht deaktiviert haben, und ihre E-Mail-Adresse sowie angegebene oder aus Interaktionen abgeleitete Informationen Inserenten und Werbepartnern für deren eigene kommerzielle Zwecke mitteilen, zur Verfügung stellen oder übertragen. Werbenetzwerke auf den Seiten der Website können unter der Cookie-Einwilligung Browser-Kennungen und Nutzungsdaten erheben; sie sind in der vollständigen Datenschutzerklärung beschrieben.',
    },
    {
      lead: 'Profilbildung für relevante Inhalte.',
      body: 'Wir verwenden Ihre eigenen Angaben — gesuchter Beruf, Branche, Ort, gespeicherte Inserate und gefolgte Arbeitgeber — und die Art, wie Sie mit unseren E-Mails und der Website umgehen — ob Sie sie öffnen und welche Links Sie anklicken — um relevante Inhalte, Stelleninserate und Werbenachrichten auszuwählen. Diese Informationen können Werbepartnern zur Auswahl kommerzieller Nachrichten zur Verfügung gestellt werden, sofern Sie die Kategorie nicht deaktivieren. Nichts davon führt zu automatisierten Entscheidungen mit rechtlichen oder wirtschaftlichen Folgen für Sie.',
    },
    {
      lead: 'Änderung des Verantwortlichen.',
      body: 'Ein Verkauf, eine Fusion oder eine Übertragung des Unternehmens kann die Basisbeziehung und die erforderlichen Daten auf den Nachfolger übertragen, einschliesslich der hier beschriebenen kommerziellen Zwecke. Wenn sich der Verantwortliche oder die Zwecke ändern, informieren wir Sie und holen, soweit erforderlich, eine neue Einwilligung ein, bevor wir die Daten für den geänderten Zweck verwenden.',
    },
    {
      lead: 'Dienstleister, die für uns arbeiten.',
      body: 'Dienste für Versand und Zustellung von E-Mails, Hosting und Infrastruktur, Reichweitenmessung sowie Werkzeuge zur Texterstellung bearbeiten die Daten in unserem Auftrag und nach unseren Weisungen, nicht zu eigenen Zwecken. Die Liste nach Kategorien und die beteiligten Länder stehen in der vollständigen Datenschutzerklärung.',
    },
  ],
  fr: [
    {
      lead: 'Publicité de tiers.',
      body: 'Le canal d’e-mails publicitaires de tiers est actuellement suspendu. S’il est réactivé, nous pourrons envoyer des messages promotionnels de tiers aux abonnés de base qui n’auront pas désactivé cette catégorie, et communiquer, mettre à disposition ou transférer leur adresse e-mail ainsi que les informations déclarées ou déduites des interactions aux annonceurs et partenaires publicitaires pour leurs propres finalités commerciales. Les régies publicitaires présentes sur les pages du site peuvent collecter des identifiants de navigateur et des données de navigation selon le choix de consentement aux cookies ; elles sont décrites dans la politique complète.',
    },
    {
      lead: 'Profilage pour des contenus pertinents.',
      body: 'Nous utilisons ce que vous nous avez indiqué — métier recherché, secteur, lieu, offres enregistrées et entreprises suivies — et la manière dont vous interagissez avec nos e-mails et avec le site — si vous les ouvrez et sur quels liens vous cliquez — pour choisir des contenus, offres d’emploi et messages promotionnels pertinents. Ces informations peuvent être mises à disposition des partenaires publicitaires pour sélectionner des messages commerciaux, sauf si vous désactivez la catégorie. Rien de tout cela ne produit de décision automatisée ayant des effets juridiques ou économiques à votre égard.',
    },
    {
      lead: 'Changement de responsable.',
      body: 'Une cession, une fusion ou un transfert de l’activité peut transférer au successeur la relation de base et les données nécessaires, y compris les finalités commerciales décrites ici. Si le responsable ou les finalités changent, nous vous fournirons les informations requises et recueillerons un nouveau consentement lorsque cela est nécessaire avant d’utiliser les données pour la finalité modifiée.',
    },
    {
      lead: 'Prestataires qui travaillent pour nous.',
      body: 'Les services d’envoi et de remise des e-mails, l’hébergement et l’infrastructure, la mesure d’audience et les outils de génération de textes traitent les données pour notre compte et sur nos instructions, non à leurs propres fins. La liste par catégorie et les pays concernés figurent dans la politique de confidentialité complète.',
    },
  ],
};

/**
 * The revocation half, which a consent text is not a consent text without.
 *
 * It has to say HOW, and the how has to be a route that exists: the preference
 * centre linked from every channel row above, the unsubscribe link, or a
 * message to the controller named in this same section. It also says what
 * revoking does NOT do — undo what already happened — because the alternative
 * is a reader who believes withdrawing erases the past and finds out otherwise.
 */
const REVOCATION_TEXT: Record<PageLocale, string> = {
  it: 'Puoi revocare il consenso in qualsiasi momento e senza motivare la richiesta: dalle tue preferenze, dal link di disiscrizione in fondo a ogni email, oppure scrivendo al titolare all’indirizzo qui sopra. Puoi anche revocarne una parte sola, spegnendo un singolo canale invece di tutti. La revoca vale per il futuro: non rende illecito quello che è stato fatto prima.',
  en: 'You can withdraw your consent at any time and without giving a reason: from your preferences, from the unsubscribe link at the bottom of every email, or by writing to the controller at the address above. You can also withdraw part of it, switching off a single channel instead of all of them. Withdrawal applies going forward: it does not make unlawful what was done before.',
  de: 'Sie können Ihre Einwilligung jederzeit und ohne Begründung widerrufen: in Ihren Einstellungen, über den Abmeldelink am Ende jeder E-Mail oder mit einer Nachricht an die oben genannte verantwortliche Person. Sie können auch nur einen Teil widerrufen und einen einzelnen Kanal statt aller abschalten. Der Widerruf wirkt für die Zukunft: Er macht das zuvor Geschehene nicht widerrechtlich.',
  fr: 'Vous pouvez retirer votre consentement à tout moment et sans motiver votre demande : depuis vos préférences, via le lien de désinscription en bas de chaque e-mail, ou en écrivant au responsable du traitement à l’adresse ci-dessus. Vous pouvez aussi n’en retirer qu’une partie, en désactivant un seul canal plutôt que tous. Le retrait vaut pour l’avenir : il ne rend pas illicite ce qui a été fait auparavant.',
};

/**
 * The version stamp, printed so a person can compare it with the one inside the
 * sentence they agreed to.
 *
 * A stored `consent_text` names a version of this page; without the version
 * ON the page the reader has no way to tell whether what they are looking at is
 * what they were pointed at. That is the difference between a reference and a
 * receipt.
 */
const VERSION_LABEL: Record<PageLocale, string> = {
  it: 'Versione di questa pagina',
  en: 'Version of this page',
  de: 'Version dieser Seite',
  fr: 'Version de cette page',
};

function renderChannel(channel: CommunicationChannel, locale: PageLocale): string {
  const suspended =
    channel.status === 'suspended'
      ? `\n        <p style="${BODY_STYLE}"><strong>${esc(SUSPENDED_LABEL[locale])}</strong></p>`
      : '';
  return `
      <article id="${esc(channel.id)}">
        <h3 style="${H3_STYLE}">${esc(channel.name[locale])}</h3>${suspended}
        <p style="${BODY_STYLE}">${esc(channel.what[locale])}</p>
        <p style="${BODY_STYLE}"><strong>${esc(CADENCE_LABEL[locale])}:</strong> ${esc(channel.cadence[locale])}</p>
        <p style="${BODY_STYLE}"><strong>${esc(OPT_OUT_LABEL[locale])}:</strong> <a href="${esc(PREFERENCES_PATH[locale])}">${esc(PREFERENCES_CTA[locale])}</a> — ${esc(OPT_OUT_TEXT[locale])}</p>
      </article>`;
}

function renderBody(locale: PageLocale): string {
  const sections = CONSENT_CATEGORIES
    .map((cat) => {
      const rows = COMMUNICATION_CHANNELS.filter((c) => c.consentCategory === cat);
      if (rows.length === 0) return '';
      const note = CATEGORY_NOTE[cat];
      return `
    <section>
      <h2 style="${H2_STYLE}">${esc(CATEGORY_HEADING[cat][locale])}</h2>${
        note ? `\n      <p style="${BODY_STYLE}">${esc(note[locale])}</p>` : ''
      }
      ${rows.map((c) => renderChannel(c, locale)).join('')}
    </section>`;
    })
    .join('');

  const unconsented = COMMUNICATION_CHANNELS.filter(isUncoveredChannel);
  const unconsentedSection = unconsented.length
    ? `
    <section>
      <h2 style="${H2_STYLE}">${esc(UNCONSENTED_HEADING[locale])}</h2>
      <p style="${BODY_STYLE}">${esc(UNCONSENTED_NOTE[locale])}</p>
      ${unconsented.map((c) => renderChannel(c, locale)).join('')}
    </section>`
    : '';

  return `
    <header>
      <h1 style="${H1_STYLE}">${esc(H1[locale])}</h1>
      <p style="${LEDE_STYLE}">${esc(LEDE[locale])}</p>
    </header>${sections}${unconsentedSection}
    <section id="titolare">
      <h2 style="${H2_STYLE}">${esc(CONTROLLER_HEADING[locale])}</h2>
      <p style="${BODY_STYLE}">${esc(CONTROLLER_NOTE[locale])}</p>
      <p style="${BODY_STYLE}">${esc(DATA_CONTROLLER_FOOTER_LINE[locale])}</p>
      <h3 style="${H3_STYLE}">${esc(SHARING_HEADING[locale])}</h3>
      <p style="${BODY_STYLE}">${esc(SHARING_INTRO[locale])}</p>${SHARING_ITEMS[locale]
        .map(
          (item) =>
            `\n      <p style="${BODY_STYLE}"><strong>${esc(item.lead)}</strong> ${esc(item.body)}</p>`,
        )
        .join('')}
      <p style="${BODY_STYLE}">${esc(REVOCATION_TEXT[locale])}</p>
      <p style="${BODY_STYLE}"><a href="${esc(PRIVACY_PATH[locale])}">${esc(PRIVACY_CTA[locale])}</a></p>
    </section>
    <section>
      <p style="${BODY_STYLE}"><a href="${esc(PREFERENCES_PATH[locale])}">${esc(PREFERENCES_CTA[locale])}</a></p>
      <p style="${BODY_STYLE}"><strong>${esc(VERSION_LABEL[locale])}:</strong> ${esc(COMMUNICATIONS_PAGE_VERSION)}</p>
    </section>`;
}

function homeUrl(locale: PageLocale): string {
  return locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
}

/**
 * BreadcrumbList JSON-LD — Home > this page (2-level: the communications page
 * has no section parent, unlike the 3-level bridge/holidays chains). Same
 * gate as everywhere else: `tests/seo/breadcrumb-coverage.test.ts` (D.2)
 * requires every indexable dist/ page to carry one (#5760).
 */
function breadcrumbLd(locale: PageLocale): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: HOME_LABEL[locale], item: homeUrl(locale) },
      {
        '@type': 'ListItem',
        position: 2,
        name: H1[locale],
        item: `${BASE_URL}${COMMUNICATIONS_PAGE_PATH[locale]}`,
      },
    ],
  });
}

function hreflangHtml(): string {
  return [
    ...LOCALES.map(
      (l) =>
        `<link rel="alternate" hreflang="${l}" href="${BASE_URL}${COMMUNICATIONS_PAGE_PATH[l]}" />`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${BASE_URL}${COMMUNICATIONS_PAGE_PATH.it}" />`,
  ].join('\n');
}

/** Exported for the test, which asserts the four pages are indexable without running a build. */
export function buildCommunicationsPage(locale: PageLocale, distDir?: string): { html: string; wordCount: number } {
  const body = renderBody(locale);
  const bodyHtml = `<main class="seo-static-content">${body}</main>`;
  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title: TITLE[locale],
    description: DESCRIPTION[locale],
    canonicalUrl: `${BASE_URL}${COMMUNICATIONS_PAGE_PATH[locale]}`,
    hreflangHtml: hreflangHtml(),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    jsonLdScripts: [breadcrumbLd(locale)],
    bodyHtml,
    skipMainWrap: true,
    distDir,
  });

  return { html, wordCount };
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const masterSitemap = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(masterSitemap)) return;
  try {
    let idx = fs.readFileSync(masterSitemap, 'utf-8');
    if (!idx.includes('sitemap-comunicazioni.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-comunicazioni.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-comunicazioni\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(masterSitemap, idx, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[communications-page]\x1b[0m sitemap-index patch failed:', err);
  }
}

export function communicationsPagePlugin(rootDir: string): Plugin {
  return {
    name: 'communications-page',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const collector = new WriteCollector({ distDir, pluginName: 'communicationsPagePlugin' });
      const dateStamp = new Date().toISOString().slice(0, 10);

      for (const locale of LOCALES) {
        const { html } = buildCommunicationsPage(locale, distDir);
        const urlPath = COMMUNICATIONS_PAGE_PATH[locale].replace(/\/+$/, '');
        collector.add(path.join(distDir, `${urlPath}/index.html`), html);
      }

      const sitemapXml =
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        LOCALES.map(
          (l) =>
            `  <url>\n    <loc>${BASE_URL}${COMMUNICATIONS_PAGE_PATH[l]}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>\n`,
        ).join('') +
        `</urlset>\n`;
      try {
        fs.writeFileSync(path.join(distDir, 'sitemap-comunicazioni.xml'), sitemapXml, 'utf-8');
      } catch (err) {
        console.warn('\x1b[33m[communications-page]\x1b[0m sitemap write failed:', err);
      }

      const written = await collector.flush();
      console.log(`\x1b[36m[communications-page]\x1b[0m Emitted ${written} pages from ${COMMUNICATION_CHANNELS.length} channels`);

      if (fs.existsSync(path.join(distDir, 'sitemap-comunicazioni.xml'))) {
        patchSitemapIndex(distDir, dateStamp);
      }
    },
  };
}
