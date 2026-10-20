import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import type { JobBoardLocale } from './jobBoardSeoPure';
import type { SectorHubPublication } from '../data/sector-hub-publications';
import {
  countAutoSectorHubEmployers,
  readAutoSectorHubInventory,
  type AutoSectorJob,
} from './shared/autoSectorHubPublicationData';
import { autoSectorHubUsesExistingCategoryPath, buildAutoSectorHubPath } from './shared/autoSectorHubPaths';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { buildLocaleAlternateBlock } from './shared/localeAlternateBlock';
import { renderJobCardListHtml, type JobCardJob, type JobCardListItem } from './shared/jobCardHtml';
import { renderStatGrid, HERO_EYEBROW_STYLE, H1_STYLE, LEDE_STYLE } from './shared/seoContentTokens';
import { WriteCollector } from './batchWrite';
import { BASE_URL, BUILD_DATE_STAMP, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SECTOR_HUB_LOCALE_PREFIX, SECTOR_HUB_SECTION } from './shared/jobSectorPaths';
import { isIndexableSectorHubPublication, type SectorPublicationLocale } from '../data/sector-hub-publications';
import { clampMetaDescription, TITLE_MAX_CHARS, truncateHeadline } from './shared/titleSuffix';

const LOCALES: readonly JobBoardLocale[] = ['it', 'en', 'de', 'fr'];
const PAGE_SIZE = 75;

interface AutoHubCopy {
  title: (label: string) => string;
  h1: (label: string) => string;
  description: (label: string, jobs: number, employers: number) => string;
  eyebrow: string;
  jobsHeading: string;
  methodHeading: string;
  methodText: (label: string, jobs: number, employers: number, shown: number) => string;
  emptyText: (label: string) => string;
  bridgeText: (label: string) => string;
  allJobs: string;
  inventory: string;
  employers: string;
  currentOpenings: string;
  updated: string;
  breadcrumbHome: string;
  breadcrumbJobs: string;
}

const COPY: Record<JobBoardLocale, AutoHubCopy> = {
  it: {
    title: (label) => `Lavoro ${label} in Ticino: annunci attivi`,
    h1: (label) => `Offerte di lavoro in ${label} in Ticino`,
    description: (label, jobs, employers) => `${jobs} offerte attive in ${label} in Ticino, pubblicate da ${employers} datori di lavoro. Consulta gli annunci e i dettagli dichiarati dalle aziende.`,
    eyebrow: 'Annunci attivi in Ticino',
    jobsHeading: 'Annunci di lavoro',
    methodHeading: 'Come viene costruito questo elenco',
    methodText: (label, jobs, employers, shown) => `Questa pagina raccoglie ${jobs} annunci attivi la cui categoria o settore, dichiarati dalla fonte dell’offerta, corrispondono a “${label}”. Gli annunci arrivano da ${employers} datori di lavoro distinti. ${shown < jobs ? `Mostriamo i ${shown} annunci più recenti; il totale attuale è ${jobs}.` : 'L’elenco mostra tutte le offerte attive rilevate per questa categoria.'} Le schede riportano solo le informazioni presenti nell’annuncio originale, come sede, contratto e retribuzione. Verifica sempre requisiti e condizioni sulla pagina del datore di lavoro prima di candidarti. La disponibilità può cambiare quando un’offerta viene chiusa o aggiornata.`,
    emptyText: (label) => `Al momento non risultano annunci attivi in ${label}. La pagina resta disponibile e verrà aggiornata se nuove offerte supereranno i criteri di pubblicazione.`,
    bridgeText: (label) => `La pagina di settore ${label} è temporaneamente sotto i criteri minimi di inventario o domanda. Consulta tutte le offerte attive in Ticino; questa pagina tornerà disponibile nell’indice quando i criteri saranno raggiunti.`,
    allJobs: 'Tutte le offerte in Ticino',
    inventory: 'Offerte attive',
    employers: 'Datori distinti',
    currentOpenings: 'Risultati attuali',
    updated: 'Pagina generata',
    breadcrumbHome: 'Home',
    breadcrumbJobs: 'Offerte in Ticino',
  },
  en: {
    title: (label) => `${label} jobs in Ticino: current openings`,
    h1: (label) => `${label} jobs in Ticino`,
    description: (label, jobs, employers) => `${jobs} active ${label} openings in Ticino from ${employers} employers. Browse current listings and the details supplied by each employer.`,
    eyebrow: 'Active job listings in Ticino',
    jobsHeading: 'Current job listings',
    methodHeading: 'How this list is built',
    methodText: (label, jobs, employers, shown) => `This page groups ${jobs} active listings whose source-published category or sector matches “${label}”. The openings come from ${employers} distinct employers. ${shown < jobs ? `We show the ${shown} most recent listings; the current total is ${jobs}.` : 'The list shows every active opening currently detected for this category.'} Cards include only details present in the original listing, such as location, contract and salary. Check requirements and terms on the employer’s own page before applying. Availability can change when an opening closes or is updated.`,
    emptyText: (label) => `There are no active ${label} listings at the moment. This page remains available and will update when new openings meet the publication criteria.`,
    bridgeText: (label) => `The ${label} sector page is temporarily below its minimum inventory or demand criteria. Browse all active jobs in Ticino; this page will return to the index when it meets the publication criteria again.`,
    allJobs: 'All jobs in Ticino',
    inventory: 'Active openings',
    employers: 'Distinct employers',
    currentOpenings: 'Current results',
    updated: 'Page generated',
    breadcrumbHome: 'Home',
    breadcrumbJobs: 'Jobs in Ticino',
  },
  de: {
    title: (label) => `${label}-Jobs im Tessin: aktuelle Stellen`,
    h1: (label) => `${label}-Stellen im Tessin`,
    description: (label, jobs, employers) => `${jobs} aktive Stellen im Bereich ${label} im Tessin, ausgeschrieben von ${employers} Arbeitgebern. Durchsuchen Sie die Anzeigen und die Angaben der Arbeitgeber.`,
    eyebrow: 'Aktive Stellen im Tessin',
    jobsHeading: 'Aktuelle Stellenanzeigen',
    methodHeading: 'So entsteht diese Übersicht',
    methodText: (label, jobs, employers, shown) => `Diese Seite bündelt ${jobs} aktive Anzeigen, deren von der Quelle angegebene Kategorie oder Branche „${label}“ entspricht. Die Stellen stammen von ${employers} verschiedenen Arbeitgebern. ${shown < jobs ? `Angezeigt werden die ${shown} neuesten Anzeigen; aktuell gibt es insgesamt ${jobs}.` : 'Die Liste zeigt alle aktuell erkannten Stellen dieser Kategorie.'} Die Karten enthalten nur Angaben aus der ursprünglichen Anzeige, etwa Arbeitsort, Vertrag und Lohn. Prüfen Sie Anforderungen und Bedingungen vor der Bewerbung auf der Seite des Arbeitgebers. Die Verfügbarkeit kann sich ändern, wenn eine Stelle geschlossen oder aktualisiert wird.`,
    emptyText: (label) => `Zurzeit sind keine aktiven Stellen im Bereich ${label} erfasst. Die Seite bleibt bestehen und wird aktualisiert, sobald neue Stellen die Veröffentlichungskriterien erfüllen.`,
    bridgeText: (label) => `Die Branchenseite ${label} liegt vorübergehend unter den Mindestkriterien für Stellenbestand oder Nachfrage. Alle aktiven Stellen im Tessin finden Sie in der Gesamtübersicht. Sobald die Kriterien wieder erfüllt sind, erscheint diese Seite erneut im Branchenindex.`,
    allJobs: 'Alle Stellen im Tessin',
    inventory: 'Aktive Stellen',
    employers: 'Arbeitgeber',
    currentOpenings: 'Aktuelle Treffer',
    updated: 'Seite erstellt',
    breadcrumbHome: 'Startseite',
    breadcrumbJobs: 'Stellen im Tessin',
  },
  fr: {
    title: (label) => `Emplois ${label} au Tessin : annonces actuelles`,
    h1: (label) => `Offres d’emploi ${label} au Tessin`,
    description: (label, jobs, employers) => `${jobs} offres actives dans le domaine ${label} au Tessin, publiées par ${employers} employeurs. Consultez les annonces et les informations fournies par chaque employeur.`,
    eyebrow: 'Annonces actives au Tessin',
    jobsHeading: 'Offres d’emploi actuelles',
    methodHeading: 'Comment cette liste est constituée',
    methodText: (label, jobs, employers, shown) => `Cette page regroupe ${jobs} annonces actives dont la catégorie ou le secteur déclaré par la source correspond à « ${label} ». Les offres proviennent de ${employers} employeurs distincts. ${shown < jobs ? `Nous affichons les ${shown} annonces les plus récentes ; le total actuel est de ${jobs}.` : 'La liste présente toutes les offres actuellement détectées pour cette catégorie.'} Les fiches reprennent uniquement les informations de l’annonce d’origine, comme le lieu, le contrat et le salaire. Vérifiez les exigences et les conditions sur la page de l’employeur avant de postuler. La disponibilité peut changer si une offre est clôturée ou mise à jour.`,
    emptyText: (label) => `Aucune annonce active dans le domaine ${label} n’est recensée pour le moment. Cette page reste disponible et sera mise à jour lorsque de nouvelles offres rempliront les critères de publication.`,
    bridgeText: (label) => `La page du secteur ${label} est temporairement sous les critères minimaux d’inventaire ou de demande. Consultez toutes les offres actives au Tessin ; cette page réintégrera l’index lorsque les critères seront à nouveau remplis.`,
    allJobs: 'Toutes les offres au Tessin',
    inventory: 'Offres actives',
    employers: 'Employeurs distincts',
    currentOpenings: 'Résultats actuels',
    updated: 'Page générée',
    breadcrumbHome: 'Accueil',
    breadcrumbJobs: 'Emplois au Tessin',
  },
};

const LOCALE_OG: Record<JobBoardLocale, string> = { it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH' };

function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function slugify(value: unknown): string {
  return String(value || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}

function localizedJobSlug(job: AutoSectorJob, locale: JobBoardLocale): string {
  const map = job.slugByLocale as Record<string, unknown> | undefined;
  const rawLocalized = map?.[locale];
  const localized = typeof rawLocalized === 'string' ? rawLocalized.trim() : '';
  if (localized) return localized;
  if (typeof job.slug === 'string' && job.slug.trim()) return job.slug.trim();
  const title = typeof job.titleByLocale?.[locale] === 'string' ? job.titleByLocale[locale] : job.title;
  return slugify(`${title || ''}-${job.company || ''}-${job.location || job.addressLocality || ''}`);
}

function jobHref(job: AutoSectorJob, locale: JobBoardLocale): string | null {
  const slug = localizedJobSlug(job, locale);
  if (!slug) return null;
  return `${SECTOR_HUB_LOCALE_PREFIX[locale]}/${SECTOR_HUB_SECTION[locale]}/${slug}/`.replace(/\/+/g, '/');
}

function dateMs(job: AutoSectorJob): number {
  const values = [job.postedDate, job.datePosted, job.firstSeenAt, job.crawledAt];
  for (const value of values) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toCardItem(job: AutoSectorJob, locale: JobBoardLocale): JobCardListItem | null {
  const href = jobHref(job, locale);
  if (!href) return null;
  return {
    href: `${BASE_URL}${href}`,
    job: {
      title: typeof job.title === 'string' ? job.title : undefined,
      titleByLocale: job.titleByLocale as JobCardJob['titleByLocale'],
      company: typeof job.company === 'string' ? job.company : undefined,
      companyKey: typeof job.companyKey === 'string' ? job.companyKey : undefined,
      companyDomain: typeof job.companyDomain === 'string' ? job.companyDomain : undefined,
      location: typeof job.location === 'string' ? job.location : undefined,
      addressLocality: typeof job.addressLocality === 'string' ? job.addressLocality : undefined,
      canton: typeof job.canton === 'string' ? job.canton : undefined,
      contract: typeof job.contract === 'string' ? job.contract : undefined,
      postingDateSource: typeof job.postingDateSource === 'string' ? job.postingDateSource : undefined,
      postedDate: typeof job.postedDate === 'string' ? job.postedDate : undefined,
      datePosted: typeof job.datePosted === 'string' ? job.datePosted : undefined,
      salaryMin: typeof job.salaryMin === 'string' || typeof job.salaryMin === 'number' ? job.salaryMin : undefined,
      salaryMax: typeof job.salaryMax === 'string' || typeof job.salaryMax === 'number' ? job.salaryMax : undefined,
      salarySource: typeof job.salarySource === 'string' ? job.salarySource : undefined,
      currency: typeof job.currency === 'string' ? job.currency : undefined,
      url: typeof job.url === 'string' ? job.url : undefined,
    },
  };
}

function buildPage(
  distDir: string,
  locale: JobBoardLocale,
  publication: SectorHubPublication,
  jobs: readonly AutoSectorJob[],
  dateStamp: string,
): { html: string; indexable: boolean; wordCount: number } {
  const copy = COPY[locale];
  const label = publication.labelByLocale[locale];
  if (!label) throw new Error(`Automatic sector hub ${publication.slug} lacks a ${locale} label.`);
  const employers = countAutoSectorHubEmployers(jobs);
  const indexable = isIndexableSectorHubPublication(publication, jobs.length, employers, locale);
  const description = clampMetaDescription(copy.description(label, jobs.length, employers), undefined, locale);
  const canonicalPath = buildAutoSectorHubPath(locale, publication.slug, publication.routeKind);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const hrefFor = (alt: SectorPublicationLocale) => `${BASE_URL}${buildAutoSectorHubPath(alt, publication.slug, publication.routeKind)}`;
  const hreflangHtml = buildLocaleAlternateBlock({
    eligibleLocales: LOCALES.filter((candidateLocale) => Boolean(publication.labelByLocale[candidateLocale])),
    hrefFor,
  });
  if (!indexable) {
    const sectionRoot = `${SECTOR_HUB_LOCALE_PREFIX[locale]}/${SECTOR_HUB_SECTION[locale]}/`.replace(/\/+/g, '/');
    const bodyHtml = `<nav class="s-bcr" aria-label="Breadcrumb">
      <a href="/" class="s-bcl">${esc(copy.breadcrumbHome)}</a><span> / </span>
      <a href="${esc(sectionRoot)}" class="s-bcl">${esc(copy.breadcrumbJobs)}</a><span> / </span>
      <span>${esc(label)}</span>
    </nav>
    <header class="max-w-3xl mx-auto px-4 py-6">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.eyebrow)} · ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1(label))}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.bridgeText(label))}</p>
    </header>
    ${renderStatGrid([
      { label: copy.inventory, value: jobs.length.toLocaleString(locale), tone: 'base' },
      { label: copy.employers, value: employers.toLocaleString(locale), tone: 'base' },
      { label: copy.updated, value: dateStamp, tone: 'base' },
    ])}
    <section class="max-w-3xl mx-auto px-4 py-6">
      <a href="${esc(sectionRoot)}" style="font-weight:700;display:inline-flex;min-height:44px;align-items:center">${esc(copy.allJobs)} →</a>
    </section>`;
    const html = buildSeoPageHtml({
      locale,
      title: truncateHeadline(copy.title(label), TITLE_MAX_CHARS),
      description,
      canonicalUrl,
      hreflangHtml,
      bodyHtml,
      robots: 'noindex,follow',
      ogLocale: LOCALE_OG[locale],
      distDir,
      seoMainClass: 'seo-static-content',
    });
    return { html, indexable: false, wordCount: countHtmlBodyWords(html) };
  }
  const sorted = [...jobs].sort((a, b) => dateMs(b) - dateMs(a)
    || String(a.company || '').localeCompare(String(b.company || ''))
    || String(a.title || '').localeCompare(String(b.title || '')));
  const shown = sorted.slice(0, PAGE_SIZE);
  const cards = shown.map((job) => toCardItem(job, locale)).filter((item): item is JobCardListItem => item !== null);
  const empty = `<p class="s-card" style="color:var(--color-subtle);font-size:14px;margin:0">${esc(copy.emptyText(label))}</p>`;
  const jobsHtml = renderJobCardListHtml(cards, { locale, emptyStateHtml: empty });
  const sectionRoot = `${SECTOR_HUB_LOCALE_PREFIX[locale]}/${SECTOR_HUB_SECTION[locale]}/`.replace(/\/+/g, '/');
  const methodText = copy.methodText(label, jobs.length, employers, cards.length);
  const bodyHtml = `<nav class="s-bcr" aria-label="Breadcrumb">
      <a href="/" class="s-bcl">${esc(copy.breadcrumbHome)}</a><span> / </span>
      <a href="${esc(sectionRoot)}" class="s-bcl">${esc(copy.breadcrumbJobs)}</a><span> / </span>
      <span>${esc(label)}</span>
    </nav>
    <header class="max-w-3xl mx-auto px-4 py-6">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.eyebrow)} · ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1(label))}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.description(label, jobs.length, employers))}</p>
    </header>
    ${renderStatGrid([
      { label: copy.inventory, value: jobs.length.toLocaleString(locale), tone: 'success' },
      { label: copy.employers, value: employers.toLocaleString(locale), tone: 'accent' },
      { label: copy.currentOpenings, value: cards.length.toLocaleString(locale), tone: 'base' },
    ])}
    <section class="max-w-3xl mx-auto px-4 py-6">
      <h2 class="s-CqexyJ">${esc(copy.jobsHeading)}</h2>
      ${jobsHtml}
      <h2 class="s-CqexyJ" style="margin-top:28px">${esc(copy.methodHeading)}</h2>
      <p>${esc(methodText)}</p>
      <a href="${esc(sectionRoot)}" style="font-weight:700;display:inline-flex;min-height:44px;align-items:center">${esc(copy.allJobs)} →</a>
    </section>`;
  const jsonLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: copy.h1(label),
    description,
    url: canonicalUrl,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: jobs.length,
      itemListElement: cards.slice(0, 20).map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: { '@type': 'Thing', name: item.job.title, url: item.href },
      })),
    },
  });
  const html = buildSeoPageHtml({
    locale,
    title: truncateHeadline(copy.title(label), TITLE_MAX_CHARS),
    description,
    canonicalUrl,
    hreflangHtml,
    bodyHtml,
    jsonLdScripts: [jsonLd],
    robots: indexable ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    distDir,
    seoMainClass: 'seo-static-content',
  });
  const wordCount = countHtmlBodyWords(html);
  if (indexable && wordCount < MIN_INDEXABLE_WORDS) {
    throw new Error(`Automatic sector hub ${canonicalPath} has only ${wordCount} words (floor ${MIN_INDEXABLE_WORDS}).`);
  }
  return { html, indexable, wordCount };
}

export function autoSectorHubPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'auto-sector-hub-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;
      const { registry, jobsBySlug } = readAutoSectorHubInventory(rootDir);
      if (registry.hubs.length === 0) return;
      const dateStamp = BUILD_DATE_STAMP;
      const collector = new WriteCollector({ distDir, pluginName: 'autoSectorHubPagesPlugin' });
      const sitemapEntries: string[] = [];
      let emitted = 0;
      let indexable = 0;

      for (const publication of registry.hubs) {
        // Existing static category pages already own these canonical URLs.
        // They may be auto-promoted into the sector index, but their HTML and
        // sitemap entries remain owned by jobsSeoPagesPlugin.
        if (autoSectorHubUsesExistingCategoryPath(publication.routeKind)) continue;
        const jobs = jobsBySlug.get(publication.slug) || [];
        for (const locale of LOCALES) {
          if (!shouldEmitLocale(locale)) continue;
          if (!publication.labelByLocale[locale]) continue;
          const page = buildPage(distDir, locale, publication, jobs, dateStamp);
          const file = np.join(distDir, buildAutoSectorHubPath(locale, publication.slug, publication.routeKind).slice(1), 'index.html');
          collector.add(file, page.html);
          emitted += 1;
          if (locale === 'it' && page.indexable) indexable += 1;
        }

        const allIndexedLocales = LOCALES.filter((locale) => isIndexableSectorHubPublication(
          publication, jobs.length, countAutoSectorHubEmployers(jobs), locale,
        ));
        if (!allIndexedLocales.length) continue;
        const alternates = allIndexedLocales.map((locale) =>
          `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${buildAutoSectorHubPath(locale, publication.slug, publication.routeKind)}" />`,
        ).join('\n');
        // A locale-shard build writes only one locale's HTML, but the final
        // sitemap must retain every localized URL and reciprocal alternate.
        for (const locale of allIndexedLocales) {
          sitemapEntries.push(`  <url>\n    <loc>${BASE_URL}${buildAutoSectorHubPath(locale, publication.slug, publication.routeKind)}</loc>\n${alternates}\n    <changefreq>daily</changefreq>\n    <priority>0.65</priority>\n  </url>`);
        }
      }

      await collector.flush();
      const sitemapFile = np.join(distDir, 'sitemap-auto-sector-hubs.xml');
      if (sitemapEntries.length === 0) {
        fs.rmSync(sitemapFile, { force: true });
        console.log(`[auto-sector-hubs] emitted ${emitted} locale pages for ${registry.hubs.length} publications; ${indexable} currently indexable; no separate sitemap needed.`);
        return;
      }
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
      fs.writeFileSync(sitemapFile, sitemap, 'utf-8');
      console.log(`[auto-sector-hubs] emitted ${emitted} locale pages for ${registry.hubs.length} publications; ${indexable} currently indexable; ${sitemapEntries.length} sitemap URLs.`);
    },
  };
}
