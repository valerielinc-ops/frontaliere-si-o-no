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
  PREFERENCES_PATH,
  type CommunicationChannel,
  type ConsentCategory,
} from '../services/communicationChannels';

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
  it: 'Questa pagina è l’elenco completo. È generata dalla configurazione degli invii: se un canale non compare qui, non parte; se una frequenza cambia, cambia qui.',
  en: 'This page is the complete list. It is generated from the send configuration: a channel that is not here does not go out, and a cadence that changes, changes here.',
  de: 'Diese Seite ist die vollständige Liste. Sie wird aus der Versandkonfiguration erzeugt: Ein Kanal, der hier fehlt, wird nicht versendet, und eine geänderte Häufigkeit ändert sich hier.',
  fr: 'Cette page est la liste complète. Elle est générée depuis la configuration des envois : un canal absent d’ici ne part pas, et une fréquence qui change, change ici.',
};

const CATEGORY_HEADING: Record<Exclude<ConsentCategory, null>, Record<PageLocale, string>> = {
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
};

const UNCONSENTED_HEADING: Record<PageLocale, string> = {
  it: 'Non coperto da nessun consenso raccolto',
  en: 'Covered by no consent we collect',
  de: 'Von keiner erhobenen Einwilligung abgedeckt',
  fr: 'Couvert par aucun consentement recueilli',
};

const UNCONSENTED_NOTE: Record<PageLocale, string> = {
  it: 'La pubblicità di terzi è uno scopo diverso dal contenuto redazionale, e nessuna delle tre categorie sopra la comprende. Finché non è nominata esplicitamente in una formula di consenso, questo canale non deve raggiungere chi si è iscritto sotto quelle formule.',
  en: 'Third-party advertising is a different purpose from editorial content, and none of the three categories above covers it. Until it is named explicitly in a consent formula, this channel must not reach people who subscribed under those formulas.',
  de: 'Werbung Dritter ist ein anderer Zweck als redaktioneller Inhalt, und keine der drei Kategorien oben deckt sie ab. Solange sie nicht ausdrücklich in einer Einwilligungsformel genannt wird, darf dieser Kanal die unter jenen Formeln angemeldeten Personen nicht erreichen.',
  fr: 'La publicité de tiers est une finalité différente du contenu éditorial, et aucune des trois catégories ci-dessus ne la couvre. Tant qu’elle n’est pas nommée explicitement dans une formule de consentement, ce canal ne doit pas atteindre les personnes inscrites sous ces formules.',
};

const CADENCE_LABEL: Record<PageLocale, string> = {
  it: 'Frequenza',
  en: 'Cadence',
  de: 'Häufigkeit',
  fr: 'Fréquence',
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

function renderChannel(channel: CommunicationChannel, locale: PageLocale): string {
  return `
      <article id="${esc(channel.id)}">
        <h3 style="${H3_STYLE}">${esc(channel.name[locale])}</h3>
        <p style="${BODY_STYLE}">${esc(channel.what[locale])}</p>
        <p style="${BODY_STYLE}"><strong>${esc(CADENCE_LABEL[locale])}:</strong> ${esc(channel.cadence[locale])}</p>
        <p style="${BODY_STYLE}"><strong>${esc(OPT_OUT_LABEL[locale])}:</strong> <a href="${esc(PREFERENCES_PATH[locale])}">${esc(PREFERENCES_CTA[locale])}</a> — ${esc(OPT_OUT_TEXT[locale])}</p>
      </article>`;
}

function renderBody(locale: PageLocale): string {
  const categories: Array<Exclude<ConsentCategory, null>> = ['editorial', 'jobs', 'service'];
  const sections = categories
    .map((cat) => {
      const rows = COMMUNICATION_CHANNELS.filter((c) => c.consentCategory === cat);
      if (rows.length === 0) return '';
      return `
    <section>
      <h2 style="${H2_STYLE}">${esc(CATEGORY_HEADING[cat][locale])}</h2>
      ${rows.map((c) => renderChannel(c, locale)).join('')}
    </section>`;
    })
    .join('');

  const unconsented = COMMUNICATION_CHANNELS.filter((c) => c.consentCategory === null);
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
    <section>
      <p style="${BODY_STYLE}"><a href="${esc(PREFERENCES_PATH[locale])}">${esc(PREFERENCES_CTA[locale])}</a></p>
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
