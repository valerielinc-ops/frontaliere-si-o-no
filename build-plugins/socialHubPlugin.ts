/**
 * Social profile landing pages.
 *
 * The four static pages give Instagram/TikTok bio traffic and clickable social
 * posts one fast, locale-aware place to reach jobs, salary tools, guides,
 * border updates, and the weekly digest. The static HTML is the page source;
 * the SPA hydrates only the shared site chrome.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderHreflangTags, renderSitemapHreflangTags } from './shared/hreflang';
import { differentiateH1FromTitle, esc } from './shared/seoContentTokensPure';
import { buildRootHubPath } from './borderWaitData';
import { WriteCollector } from './batchWrite';
import { SLUG_TABLES } from '../services/routeSlugs.data';
import type { Locale } from '../services/i18n';

const LOCALES = ['it', 'en', 'de', 'fr'] as const satisfies readonly Locale[];
const SITEMAP_FILE = 'sitemap-social-hub.xml';

interface SocialHubCard {
  readonly title: string;
  readonly description: string;
  readonly href: string;
}

interface SocialHubCopy {
  readonly title: string;
  readonly description: string;
  readonly h1: string;
  readonly intro: string;
  readonly sectionTitle: string;
  readonly featuredAction: string;
  readonly cards: readonly Omit<SocialHubCard, 'href'>[];
  readonly noteTitle: string;
  readonly note: string;
  readonly homeLabel: string;
  readonly breadcrumbLabel: string;
  readonly breadcrumbCurrent: string;
}

const COPY: Readonly<Record<Locale, SocialHubCopy>> = {
  it: {
    title: 'Lavoro e strumenti per frontalieri | Frontaliere Ticino',
    description: 'Dai social alle risorse utili: offerte di lavoro in Ticino, calcolo dello stipendio netto, traffico ai valichi, guide e riepilogo settimanale.',
    h1: 'Le risorse per il tuo percorso da frontaliere',
    intro: 'Se ci hai trovato sui social, da qui puoi passare direttamente alle informazioni e agli strumenti di Frontaliere Ticino. Scegli ciò che ti serve oggi: una nuova opportunità di lavoro, una stima del netto, un aggiornamento sul tragitto o una guida pratica.',
    sectionTitle: 'Da dove vuoi iniziare?',
    featuredAction: 'Esplora le offerte',
    cards: [
      { title: 'Offerte di lavoro in Ticino', description: 'Consulta gli annunci e cerca opportunità adatte alla tua esperienza.' },
      { title: 'Calcola lo stipendio netto', description: 'Confronta salario, imposte e contributi con i dati della tua situazione.' },
      { title: 'Traffico e attese ai valichi', description: 'Apri gli aggiornamenti sui principali passaggi di frontiera.' },
      { title: 'Guide e articoli', description: 'Approfondisci fisco, permessi, assicurazione, lavoro e vita oltreconfine.' },
      { title: 'Riepilogo settimanale', description: 'Ricevi via email una selezione di novità e strumenti per frontalieri.' },
    ],
    noteTitle: 'Un progetto indipendente per la vita oltreconfine',
    note: 'Le pagine raccolgono strumenti, offerte e informazioni editoriali per chi vive in Italia e lavora in Svizzera. Le regole possono cambiare: per decisioni fiscali, previdenziali o sui permessi verifica sempre le fonti ufficiali indicate nelle guide.',
    homeLabel: 'Home',
    breadcrumbLabel: 'Percorso di navigazione',
    breadcrumbCurrent: 'Social',
  },
  en: {
    title: 'Jobs and tools for cross-border workers | Frontaliere Ticino',
    description: 'From social posts to useful resources: Ticino jobs, net salary tools, border traffic, practical guides and a weekly email digest.',
    h1: 'Useful resources for your cross-border work',
    intro: 'If you found us on social media, use this page to reach Frontaliere Ticino information and tools directly. Choose what you need today: a new job opportunity, a net salary estimate, a border update, or a practical guide for working across the border.',
    sectionTitle: 'Where would you like to start?',
    featuredAction: 'Browse jobs',
    cards: [
      { title: 'Jobs in Ticino', description: 'Browse current listings and look for opportunities that fit your experience.' },
      { title: 'Estimate your net salary', description: 'Compare salary, taxes and contributions using your own situation.' },
      { title: 'Border traffic and waiting times', description: 'Open updates for the main border crossings.' },
      { title: 'Guides and articles', description: 'Explore taxes, permits, insurance, work and life across the border.' },
      { title: 'Weekly email digest', description: 'Get a selection of news and practical tools for cross-border workers.' },
    ],
    noteTitle: 'An independent project for cross-border life',
    note: 'These pages bring together tools, job listings and editorial information for people who live in Italy and work in Switzerland. Rules can change: check the official sources linked in each guide before making tax, pension or permit decisions.',
    homeLabel: 'Home',
    breadcrumbLabel: 'Breadcrumb',
    breadcrumbCurrent: 'Social',
  },
  de: {
    title: 'Jobs und Tools für Grenzgänger | Frontaliere Ticino',
    description: 'Von Social Media zu nützlichen Ressourcen: Stellen im Tessin, Nettolohn-Rechner, Grenzverkehr, Ratgeber und wöchentlicher Überblick.',
    h1: 'Nützliche Ressourcen für deine Arbeit als Grenzgänger',
    intro: 'Wenn du uns über soziale Medien gefunden hast, gelangst du hier direkt zu den Informationen und Werkzeugen von Frontaliere Ticino. Wähle, was du heute brauchst: eine neue Stelle, eine Nettolohn-Schätzung, aktuelle Hinweise zum Grenzverkehr oder einen praktischen Ratgeber.',
    sectionTitle: 'Womit möchtest du beginnen?',
    featuredAction: 'Stellen durchsuchen',
    cards: [
      { title: 'Stellen im Tessin', description: 'Durchsuche aktuelle Anzeigen und finde passende Möglichkeiten.' },
      { title: 'Nettolohn berechnen', description: 'Vergleiche Lohn, Steuern und Beiträge anhand deiner Situation.' },
      { title: 'Grenzverkehr und Wartezeiten', description: 'Öffne aktuelle Informationen zu den wichtigsten Übergängen.' },
      { title: 'Ratgeber und Artikel', description: 'Informiere dich über Steuern, Bewilligungen, Versicherung, Arbeit und Alltag.' },
      { title: 'Wöchentlicher Überblick', description: 'Erhalte ausgewählte Neuigkeiten und Werkzeuge per E-Mail.' },
    ],
    noteTitle: 'Ein unabhängiges Projekt für das Leben über die Grenze',
    note: 'Hier findest du Werkzeuge, Stellenanzeigen und redaktionelle Informationen für Menschen, die in Italien wohnen und in der Schweiz arbeiten. Regeln können sich ändern: Prüfe vor Steuer-, Vorsorge- oder Bewilligungsentscheidungen immer die offiziellen Quellen in den Ratgebern.',
    homeLabel: 'Startseite',
    breadcrumbLabel: 'Brotkrumennavigation',
    breadcrumbCurrent: 'Social Media',
  },
  fr: {
    title: 'Emploi et outils pour frontaliers | Frontaliere Ticino',
    description: 'Des réseaux sociaux aux ressources utiles : emplois au Tessin, salaire net, trafic frontalier, guides pratiques et résumé hebdomadaire.',
    h1: 'Les ressources utiles pour votre parcours de frontalier',
    intro: 'Si vous nous avez découvert sur les réseaux sociaux, cette page vous mène directement aux informations et outils de Frontaliere Ticino. Choisissez votre besoin du jour : une nouvelle offre d’emploi, une estimation du salaire net, une mise à jour du trafic ou un guide pratique.',
    sectionTitle: 'Par quoi souhaitez-vous commencer ?',
    featuredAction: 'Voir les offres',
    cards: [
      { title: 'Emplois au Tessin', description: 'Consultez les annonces et recherchez des opportunités adaptées à votre expérience.' },
      { title: 'Estimer le salaire net', description: 'Comparez salaire, impôts et cotisations selon votre situation.' },
      { title: 'Trafic et attentes à la frontière', description: 'Consultez les mises à jour des principaux passages frontaliers.' },
      { title: 'Guides et articles', description: 'Approfondissez fiscalité, permis, assurance, emploi et vie transfrontalière.' },
      { title: 'Résumé hebdomadaire', description: 'Recevez par e-mail une sélection d’actualités et d’outils pour frontaliers.' },
    ],
    noteTitle: 'Un projet indépendant pour la vie transfrontalière',
    note: 'Ces pages rassemblent des outils, des offres d’emploi et des informations éditoriales pour les personnes qui vivent en Italie et travaillent en Suisse. Les règles évoluent : avant toute décision fiscale, de prévoyance ou de permis, vérifiez les sources officielles citées dans les guides.',
    homeLabel: 'Accueil',
    breadcrumbLabel: 'Fil d’Ariane',
    breadcrumbCurrent: 'Réseaux sociaux',
  },
};

function localePrefix(locale: Locale): string {
  return locale === 'it' ? '' : `/${locale}`;
}

function socialHubPath(locale: Locale): string {
  return `${localePrefix(locale)}/${SLUG_TABLES[locale].socialHub}/`;
}

function pagePaths(): Readonly<Record<Locale, string>> {
  return Object.fromEntries(LOCALES.map((locale) => [locale, socialHubPath(locale)])) as Record<Locale, string>;
}

function cardHrefs(locale: Locale): readonly string[] {
  const prefix = localePrefix(locale);
  const table = SLUG_TABLES[locale];
  return [
    `${prefix}/${table.jobBoard}/`,
    `${prefix}/${table.calcolatore}/`,
    buildRootHubPath(locale),
    `${prefix}/${table.blog}/`,
    `${prefix}/${table.weeklyDigest}/`,
  ];
}

function renderPage(locale: Locale, distDir: string) {
  const copy = COPY[locale];
  const paths = pagePaths();
  const canonicalPath = socialHubPath(locale);
  const title = copy.title;
  const h1 = differentiateH1FromTitle(copy.h1, title, locale);
  const hrefs = cardHrefs(locale);
  const cards = copy.cards.map((card, index) => ({ ...card, href: hrefs[index] }));
  const [featuredCard, ...secondaryCards] = cards;
  const bodyHtml = `
<main class="seo-static-content sh-main mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-10">
  <nav class="flex flex-wrap items-center gap-2 text-sm text-subtle" aria-label="${esc(copy.breadcrumbLabel)}">
    <a class="text-accent underline-offset-2 hover:underline" href="${locale === 'it' ? '/' : `/${locale}/`}">${esc(copy.homeLabel)}</a>
    <span aria-hidden="true">/</span><span aria-current="page">${esc(copy.breadcrumbCurrent)}</span>
  </nav>
  <header class="mt-6 max-w-3xl">
    <h1 class="text-3xl font-bold tracking-tight text-strong sm:text-4xl">${esc(h1)}</h1>
    <p class="mt-4 text-base leading-7 text-subtle">${esc(copy.intro)}</p>
  </header>
  <section class="mt-8 max-w-3xl" aria-labelledby="social-hub-links">
    <h2 id="social-hub-links" class="text-xl font-bold text-strong">${esc(copy.sectionTitle)}</h2>
    <a class="mt-4 flex flex-col gap-2 rounded-xl border border-accent-border bg-accent-subtle px-5 py-4 no-underline transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 sm:flex-row sm:items-center sm:justify-between" href="${esc(featuredCard.href)}">
      <span class="min-w-0">
        <span class="block text-lg font-semibold text-accent">${esc(featuredCard.title)}</span>
        <span class="mt-1 block text-sm leading-6 text-subtle">${esc(featuredCard.description)}</span>
      </span>
      <span class="shrink-0 text-sm font-semibold text-accent">${esc(copy.featuredAction)}</span>
    </a>
    <ul class="mt-4 divide-y divide-edge border-y border-edge">
${secondaryCards.map((card) => `      <li>
        <a class="group block py-4 no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href="${esc(card.href)}">
          <span class="block font-semibold text-strong group-hover:text-accent group-hover:underline">${esc(card.title)}</span>
          <span class="mt-1 block text-sm leading-6 text-subtle">${esc(card.description)}</span>
        </a>
      </li>`).join('\n')}
    </ul>
  </section>
  <section class="mt-8 max-w-3xl rounded-2xl bg-surface-alt p-5" aria-labelledby="social-hub-context">
    <h2 id="social-hub-context" class="text-lg font-bold text-strong">${esc(copy.noteTitle)}</h2>
    <p class="mt-2 text-sm leading-6 text-subtle">${esc(copy.note)}</p>
  </section>
</main>`;
  const structuredData = [
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: copy.title,
      description: copy.description,
      url: `${BASE_URL}${canonicalPath}`,
      inLanguage: locale,
      isPartOf: { '@id': `${BASE_URL}/#website` },
    }),
  ];
  const html = buildSeoPageHtml({
    locale,
    title,
    description: copy.description,
    canonicalUrl: `${BASE_URL}${canonicalPath}`,
    hreflangHtml: renderHreflangTags(paths),
    bodyHtml,
    jsonLdScripts: structuredData,
    robots: 'index,follow',
    ogLocale: { it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH' }[locale],
    ogType: 'website',
    distDir,
    seoContentOutsideRoot: true,
    seoMainClass: 'seo-static-content sh-main',
  });
  const wordCount = countHtmlBodyWords(html);
  if (wordCount < MIN_INDEXABLE_WORDS) {
    throw new Error(`[social-hub] ${locale} rendered ${wordCount} words; expected at least ${MIN_INDEXABLE_WORDS}`);
  }
  return { canonicalPath, html, wordCount };
}

function buildSitemap(paths: Readonly<Record<Locale, string>>): string {
  const entries = LOCALES.map((locale) => `  <url>\n    <loc>${BASE_URL}${paths[locale]}</loc>\n${renderSitemapHreflangTags(paths)}\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries}\n</urlset>\n`;
}

export function socialHubPlugin(rootDir: string): Plugin {
  return {
    name: 'social-hub',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;
      const collector = new WriteCollector({ distDir, pluginName: 'socialHub' });
      const paths = pagePaths();
      const emitted: Array<ReturnType<typeof renderPage>> = [];
      for (const locale of LOCALES) {
        const page = renderPage(locale, distDir);
        const relativePath = page.canonicalPath.replace(/^\/+|\/+$/gu, '');
        collector.add(np.join(distDir, relativePath, 'index.html'), page.html);
        collector.add(np.join(distDir, `${relativePath}.html`), page.html);
        emitted.push(page);
      }
      await collector.flush();
      fs.writeFileSync(np.join(distDir, SITEMAP_FILE), buildSitemap(paths), 'utf8');
      console.log(`[social-hub] Generated ${emitted.length} localized pages (${emitted.map((page) => page.wordCount).join('/')} words) and ${SITEMAP_FILE}`);
    },
  };
}

export const __renderSocialHubPageForTest = renderPage;
export const __socialHubPathsForTest = pagePaths;
