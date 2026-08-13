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
 * Only `advertising` has one, and it is not decoration: it is where the shape
 * of that consent is stated to the person it applies to — no separate box was
 * ticked, the switch is per-channel, and the disclosure only reaches forward.
 * A reader who wants to contest "I never agreed to advertising" is entitled to
 * find, on the page their proof names, exactly what they were and were not
 * asked.
 */
const CATEGORY_NOTE: Partial<Record<NamedConsentCategory, Record<PageLocale, string>>> = {
  advertising: {
    it: 'Questa categoria è compresa nelle comunicazioni a cui ti sei iscritto: non ti è stata proposta una casella separata e il numero di spunte all’iscrizione non è cambiato. In cambio puoi disattivare solo questo canale, dalle tue preferenze, senza toccare nulla del resto. Chi si è iscritto prima del 13 agosto 2026 non lo riceve: il testo che ha letto non nominava la pubblicità di terzi, e quel testo è ciò che vale.',
    en: 'This category is included in the communications you signed up for: no separate box was offered to you and the number of ticks at signup did not change. In exchange you can switch off this channel alone, from your preferences, without touching any of the rest. People who subscribed before 13 August 2026 do not receive it: the text they read did not name third-party advertising, and that text is what counts.',
    de: 'Diese Kategorie ist in den Mitteilungen enthalten, für die Sie sich angemeldet haben: Es wurde Ihnen kein separates Kästchen angeboten, und die Anzahl der Häkchen bei der Anmeldung hat sich nicht geändert. Dafür können Sie allein diesen Kanal in Ihren Einstellungen abschalten, ohne am Rest etwas zu ändern. Wer sich vor dem 13. August 2026 angemeldet hat, erhält ihn nicht: Der gelesene Text nannte Werbung Dritter nicht, und dieser Text ist massgebend.',
    fr: 'Cette catégorie est comprise dans les communications auxquelles vous vous êtes inscrit : aucune case distincte ne vous a été proposée et le nombre de cases à cocher à l’inscription n’a pas changé. En contrepartie, vous pouvez désactiver ce seul canal, depuis vos préférences, sans toucher au reste. Les personnes inscrites avant le 13 août 2026 ne le reçoivent pas : le texte qu’elles ont lu ne nommait pas la publicité de tiers, et c’est ce texte qui fait foi.',
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
      <p style="${BODY_STYLE}"><a href="${esc(PRIVACY_PATH[locale])}">${esc(PRIVACY_CTA[locale])}</a></p>
    </section>
    <section>
      <p style="${BODY_STYLE}"><a href="${esc(PREFERENCES_PATH[locale])}">${esc(PREFERENCES_CTA[locale])}</a></p>
      <p style="${BODY_STYLE}"><strong>${esc(VERSION_LABEL[locale])}:</strong> ${esc(COMMUNICATIONS_PAGE_VERSION)}</p>
    </section>`;
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
