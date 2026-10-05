/**
 * Copy and paths of the CANTON article sections (piano «sezioni articoli per
 * cantone», P7a): the localized labels every corpus-rendered surface of a
 * canton section shares — landing, `/tutti/` archive, topic hubs, article
 * breadcrumb and RSS channel.
 *
 * Why one module. The same "Articoli Ticino" label is the landing H1, the
 * archive breadcrumb, the article breadcrumb and the RSS channel title; if
 * each surface spelled it, the anchor text pointing at a page and that page's
 * own heading would drift apart (AGENTS.md #6). Everything here is derived
 * from the section core (`indexSlug`, `topicHubs`, `canton`) plus the canton
 * display names, so a canton is a data row, never a new string literal.
 *
 * Pure, `.mjs`, no I/O: `rssFeeds.mjs` runs under plain `node` (corpus
 * build-api) and imports it next to the TypeScript renderers.
 *
 * @typedef {'it' | 'en' | 'de' | 'fr'} CantonSectionLocale
 */

import { articleSectionEntry, isCantonSection } from './articleSectionCore.mjs';
import { CANTON_HUB_TOPIC_KEYS } from './cantonArticleSectionCore.generated.mjs';
import { CANTON_DISPLAY_NAMES } from './cantonDisplayNames.mjs';

/** Locales of every canton section page, in hreflang order. */
export const CANTON_SECTION_LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Per-locale trailing "all" slug of the archive. Same values as
 * `ARCHIVE_ALL_SLUG` in `articleHubPagesPlugin.ts` (the archive emitter);
 * `tests/canton-section-pages.test.ts` pins the two equal.
 */
export const CANTON_ARCHIVE_ALL_SLUG = { it: 'tutti', en: 'all', de: 'alle', fr: 'tous' };

/** Localized label of each of the 6 topic hubs (D2), by theme id. */
export const CANTON_HUB_TOPIC_LABELS = {
  carburanti: { it: 'Carburanti', en: 'Fuel', de: 'Treibstoff', fr: 'Carburants' },
  fisco: { it: 'Fisco', en: 'Tax', de: 'Steuern', fr: 'Fiscalité' },
  mobilita: { it: 'Mobilità', en: 'Mobility', de: 'Mobilität', fr: 'Mobilité' },
  eventi: { it: 'Eventi', en: 'Events', de: 'Veranstaltungen', fr: 'Événements' },
  pensioni: { it: 'Pensioni', en: 'Pensions', de: 'Renten', fr: 'Retraites' },
  servizi: { it: 'Servizi', en: 'Services', de: 'Dienstleistungen', fr: 'Services' },
};

/**
 * Which `TOPIC_CLUSTERS` keys (`topicTaxonomy.ts`) feed each canton hub —
 * the mapping D17 relies on to promote a canton's news on a theme. `eventi`
 * and `servizi` have no cluster (the taxonomy rejected `cultura-eventi`, see
 * its header): those hubs live on their dataset and curated links only, and
 * an article page never links them as "its" topic.
 */
export const CANTON_HUB_TOPIC_CLUSTERS = {
  carburanti: ['energia-carburanti'],
  fisco: ['fiscalita'],
  mobilita: ['trasporti', 'confine-dogana'],
  eventi: [],
  pensioni: ['pensioni'],
  servizi: [],
};

/**
 * The canton hub a `TOPIC_CLUSTERS` key belongs to, or null.
 * @param {string} clusterKey
 * @returns {string | null}
 */
export function cantonHubTopicForCluster(clusterKey) {
  for (const topic of CANTON_HUB_TOPIC_KEYS) {
    if (CANTON_HUB_TOPIC_CLUSTERS[topic].includes(clusterKey)) return topic;
  }
  return null;
}

/**
 * Core entry of a canton section; throws for any other id, so a canton-only
 * renderer can never silently fall back to svizzera's copy.
 * @param {string} section
 */
export function cantonSectionEntry(section) {
  if (!isCantonSection(section)) throw new Error(`"${section}" non e' una sezione cantonale`);
  return articleSectionEntry(section);
}

/**
 * @param {string} locale
 * @returns {CantonSectionLocale}
 */
function checkLocale(locale) {
  if (!CANTON_SECTION_LOCALES.includes(locale)) throw new Error(`locale non supportata: "${locale}"`);
  return /** @type {CantonSectionLocale} */ (locale);
}

/**
 * Display name of a canton section's canton (`Ticino`, `Tessin`, `Bâle`).
 * @param {string} section
 * @param {string} locale
 */
export function cantonDisplayName(section, locale) {
  const entry = cantonSectionEntry(section);
  const names = CANTON_DISPLAY_NAMES[entry.canton];
  const name = names?.[checkLocale(locale)];
  if (!name) throw new Error(`nome del cantone ${entry.canton} mancante in ${locale}`);
  return name;
}

/**
 * The section's own name: landing H1, breadcrumb label, RSS channel suffix.
 * «Articoli Ticino» / «Ticino articles» / «Tessin-Artikel» / «Articles Tessin».
 * @param {string} section
 * @param {string} locale
 */
export function cantonSectionLabel(section, locale) {
  const name = cantonDisplayName(section, locale);
  switch (checkLocale(locale)) {
    case 'it': return `Articoli ${name}`;
    case 'en': return `${name} articles`;
    case 'de': return `${name}-Artikel`;
    case 'fr': return `Articles ${name}`;
    default: throw new Error(`locale non gestita: ${locale}`);
  }
}

/** `''` for IT (served at the apex), `/<locale>` otherwise. */
function localePrefix(locale) {
  return locale === 'it' ? '' : `/${locale}`;
}

/**
 * Root-relative landing path: `/articoli-ticino/`, `/en/ticino-articles/`.
 * @param {string} section
 * @param {string} locale
 */
export function cantonSectionLandingPath(section, locale) {
  const entry = cantonSectionEntry(section);
  return `${localePrefix(checkLocale(locale))}/${entry.indexSlug[locale]}/`;
}

/**
 * Root-relative archive path, page 1: `/articoli-ticino/tutti/`.
 * @param {string} section
 * @param {string} locale
 */
export function cantonSectionArchivePath(section, locale) {
  return `${cantonSectionLandingPath(section, locale)}${CANTON_ARCHIVE_ALL_SLUG[checkLocale(locale)]}/`;
}

/**
 * Root-relative topic-hub path: `/articoli-ticino/carburanti/`,
 * `/de/tessin-artikel/treibstoff/` (D2: direct children of the section).
 * @param {string} section
 * @param {string} topic theme id (`carburanti`, …)
 * @param {string} locale
 */
export function cantonTopicHubPath(section, topic, locale) {
  const entry = cantonSectionEntry(section);
  const slug = entry.topicHubs?.[topic]?.[checkLocale(locale)];
  if (typeof slug !== 'string') throw new Error(`tema sconosciuto per ${section}: "${topic}"`);
  return `${cantonSectionLandingPath(section, locale)}${slug}/`;
}

/**
 * Localized name of one topic hub: «Carburanti Ticino», «Ticino fuel»,
 * «Treibstoff Tessin», «Carburants Tessin».
 * @param {string} section
 * @param {string} topic
 * @param {string} locale
 */
export function cantonTopicHubLabel(section, topic, locale) {
  const labels = CANTON_HUB_TOPIC_LABELS[topic];
  if (!labels) throw new Error(`tema sconosciuto: "${topic}"`);
  const name = cantonDisplayName(section, locale);
  return locale === 'en' ? `${name} ${labels.en.toLowerCase()}` : `${labels[locale]} ${name}`;
}

/**
 * Copy of the `/tutti/` archive of a canton section (the counterpart of
 * `SVIZZERA_ARTICLES_COPY` in `articleHubPagesPlugin.ts`). The canton name
 * always comes first or after a label, never after a preposition: Italian and
 * German attach articles to canton names (nei Grigioni, im Aargau) and a
 * template cannot get them right for 24 groups.
 * @param {string} section
 * @param {string} locale
 * @returns {{ sectionLabel: string; title: string; h1: string; description: string }}
 */
export function cantonArchiveCopy(section, locale) {
  const name = cantonDisplayName(section, locale);
  const sectionLabel = cantonSectionLabel(section, locale);
  switch (checkLocale(locale)) {
    case 'it': return {
      sectionLabel,
      title: `Tutti gli articoli ${name}`,
      h1: `Archivio articoli ${name}`,
      description: `${name}: archivio completo di notizie e guide su lavoro, fisco, mobilità, eventi, pensioni e servizi.`,
    };
    case 'en': return {
      sectionLabel,
      title: `All ${name} articles`,
      h1: `${name} articles archive`,
      description: `${name}: full archive of news and guides on work, taxes, mobility, events, pensions and services.`,
    };
    case 'de': return {
      sectionLabel,
      title: `Alle ${name}-Artikel`,
      h1: `Archiv der ${name}-Artikel`,
      description: `${name}: vollständiges Archiv mit Nachrichten und Ratgebern zu Arbeit, Steuern, Mobilität, Veranstaltungen, Renten und Dienstleistungen.`,
    };
    case 'fr': return {
      sectionLabel,
      title: `Tous les articles ${name}`,
      h1: `Archives des articles ${name}`,
      description: `${name} : archive complète d’actualités et de guides sur le travail, la fiscalité, la mobilité, les événements, les retraites et les services.`,
    };
    default: throw new Error(`locale non gestita: ${locale}`);
  }
}

/**
 * RSS channel copy of a canton section (title + description per locale).
 * @param {string} section
 * @returns {Record<CantonSectionLocale, { title: string; description: string }>}
 */
export function cantonRssChannel(section) {
  const out = /** @type {Record<CantonSectionLocale, { title: string; description: string }>} */ ({});
  for (const locale of CANTON_SECTION_LOCALES) {
    const name = cantonDisplayName(section, locale);
    const description = {
      it: `${name}: notizie e guide su lavoro, fisco, mobilità, eventi, pensioni e servizi`,
      en: `${name}: news and guides on work, taxes, mobility, events, pensions and services`,
      de: `${name}: Nachrichten und Ratgeber zu Arbeit, Steuern, Mobilität, Veranstaltungen, Renten und Dienstleistungen`,
      fr: `${name} : actualités et guides sur le travail, la fiscalité, la mobilité, les événements, les retraites et les services`,
    }[locale];
    out[locale] = { title: `Frontaliere Ticino — ${cantonSectionLabel(section, locale)}`, description };
  }
  return out;
}

/**
 * Short methodology prose of a canton archive / landing — what the section
 * collects and how. Replaces, for canton sections only, the frontaliere
 * methodology accordion of the historical archives, whose copy speaks of the
 * Italian cross-border worker in Ticino and would be wrong on `/articoli-zurigo/`.
 * @param {string} section
 * @param {string} locale
 * @returns {{ summary: string; paragraphs: string[] }}
 */
export function cantonSectionMethodology(section, locale) {
  switch (checkLocale(locale)) {
    case 'it': return {
      summary: 'Come nasce questa sezione',
      paragraphs: [
        `La sezione ${cantonSectionLabel(section, 'it')} raccoglie le notizie e le guide dedicate a questo cantone, scritte dalla redazione a partire da fonti pubbliche verificate: amministrazione cantonale e comunale, enti di servizio, trasporti, previdenza e media locali che consentono la ripresa.`,
        'Ogni articolo cita le fonti con link diretti. Le pagine tematiche (carburanti, fisco, mobilità, eventi, pensioni, servizi) riuniscono gli articoli più utili su ciascun tema insieme ai dati aggiornati delle rispettive categorie.',
      ],
    };
    case 'en': return {
      summary: 'How this section is built',
      paragraphs: [
        `The ${cantonSectionLabel(section, 'en')} section collects news and guides about this canton, written by the editorial team from verified public sources: cantonal and municipal administrations, public services, transport, pension bodies and local media that allow reuse.`,
        'Every article cites its sources with direct links. The topic pages (fuel, tax, mobility, events, pensions, services) bring together the most useful articles on each theme with the latest data of that category.',
      ],
    };
    case 'de': return {
      summary: 'So entsteht diese Rubrik',
      paragraphs: [
        `Die Rubrik ${cantonSectionLabel(section, 'de')} sammelt Nachrichten und Ratgeber zu diesem Kanton, verfasst von der Redaktion auf Grundlage geprüfter öffentlicher Quellen: Kantons- und Gemeindeverwaltungen, öffentliche Dienste, Verkehr, Vorsorgeeinrichtungen und lokale Medien, die eine Weiterverwendung erlauben.`,
        'Jeder Artikel nennt seine Quellen mit direkten Links. Die Themenseiten (Treibstoff, Steuern, Mobilität, Veranstaltungen, Renten, Dienstleistungen) bündeln die nützlichsten Artikel zu jedem Thema mit den aktuellen Daten der jeweiligen Kategorie.',
      ],
    };
    case 'fr': return {
      summary: 'Comment cette rubrique est construite',
      paragraphs: [
        `La rubrique ${cantonSectionLabel(section, 'fr')} rassemble les actualités et les guides consacrés à ce canton, rédigés par la rédaction à partir de sources publiques vérifiées : administrations cantonales et communales, services publics, transports, institutions de prévoyance et médias locaux qui autorisent la reprise.`,
        'Chaque article cite ses sources avec des liens directs. Les pages thématiques (carburants, fiscalité, mobilité, événements, retraites, services) réunissent les articles les plus utiles sur chaque thème avec les données à jour de la catégorie.',
      ],
    };
    default: throw new Error(`locale non gestita: ${locale}`);
  }
}
