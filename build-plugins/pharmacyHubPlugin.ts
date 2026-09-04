/**
 * pharmacyHubPlugin — `/farmacie/` national coverage hub and its three
 * locale twins (#6399, sub-issue of #6173 Fase 1 MVP).
 *
 * WHAT THIS PAGE IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------
 * `services/pharmacies/types.ts` defines `Pharmacy`/`PharmacyDuty` — the
 * shape a future per-canton connector will populate — but no connector
 * exists yet: `data/pharmacy-sources-registry.json` only carries SOURCE
 * CONFIGURATION (which canton, which official URL, whether that URL has been
 * verified as scrapeable). This page renders that registry, one card per
 * canton, and nothing else. It never lists a pharmacy name or an on-duty
 * schedule, because the repo has none to show — inventing one to make the
 * page feel more complete would be exactly the "dati farmacie/turni
 * inventati" the parent issue (#6173) rules out. When Ticino moved to
 * `active` after the #6398 network verification, the honest addition was
 * "the source is confirmed scrapeable", not a fabricated duty listing.
 *
 * The visible promise to the reader is therefore: link to the OFFICIAL
 * source they can check right now, and be plain about which cantons that
 * link exists for yet.
 *
 * ROUTING. Emitted outside `#root` by `buildSeoPageHtml`, so
 * `services/router.ts` carries a `staticOverlay` branch for
 * `PHARMACY_HUB_PATH` — same mechanism as `/comunicazioni/`
 * (`communicationsPagePlugin.ts`): without it the SPA treats the URL as
 * unknown on hydrate and replaces the static content with
 * `NotFoundSuggestions`.
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
  CARD_CLASS,
} from './shared/seoContentTokens';
import {
  PHARMACY_HUB_PATH,
  type PharmacySourceEntry,
  type PharmacySourceStatus,
  type PharmacySourcesRegistry,
} from '../services/pharmacies/types';
import registryJson from '../data/pharmacy-sources-registry.json';

const registry = registryJson as PharmacySourcesRegistry;

type PageLocale = 'it' | 'en' | 'de' | 'fr';
const LOCALES: readonly PageLocale[] = ['it', 'en', 'de', 'fr'];

const HOME_LABEL: Record<PageLocale, string> = {
  it: 'Home',
  en: 'Home',
  de: 'Startseite',
  fr: 'Accueil',
};

const TITLE: Record<PageLocale, string> = {
  it: 'Farmacie di turno in Svizzera: la copertura per cantone | Frontaliere Ticino',
  en: 'On-duty pharmacies in Switzerland: coverage by canton | Frontaliere Ticino',
  de: 'Notfall-Apotheken in der Schweiz: Abdeckung nach Kanton | Frontaliere Ticino',
  fr: 'Pharmacies de garde en Suisse : couverture par canton | Frontaliere Ticino',
};

const H1: Record<PageLocale, string> = {
  it: 'Farmacie di turno in Svizzera, cantone per cantone',
  en: 'On-duty pharmacies in Switzerland, canton by canton',
  de: 'Notfall-Apotheken in der Schweiz, Kanton für Kanton',
  fr: 'Pharmacies de garde en Suisse, canton par canton',
};

const DESCRIPTION: Record<PageLocale, string> = {
  it: 'Lo stato della copertura, cantone per cantone, delle fonti ufficiali sulle farmacie di turno in Svizzera: quali sono verificate e dove trovare l’informazione oggi stesso.',
  en: 'Canton-by-canton coverage status of the official sources for on-duty pharmacies in Switzerland: which are verified, and where to find the information today.',
  de: 'Der kantonale Abdeckungsstatus der offiziellen Quellen für Notfall-Apotheken in der Schweiz: welche verifiziert sind und wo Sie die Information schon heute finden.',
  fr: 'L’état de la couverture, canton par canton, des sources officielles sur les pharmacies de garde en Suisse : lesquelles sont vérifiées et où trouver l’information dès aujourd’hui.',
};

const LEDE: Record<PageLocale, string> = {
  it: 'Questa pagina non pubblica turni: elenca, per ogni cantone, se abbiamo verificato una fonte ufficiale da cui in futuro leggere le farmacie di turno, e nel frattempo il link diretto per controllare adesso.',
  en: 'This page does not publish duty schedules: for every canton it lists whether we have verified an official source to read on-duty pharmacies from in the future, and in the meantime the direct link to check right now.',
  de: 'Diese Seite veröffentlicht keine Dienstpläne: Sie zeigt für jeden Kanton, ob wir eine offizielle Quelle verifiziert haben, aus der künftig Notfall-Apotheken gelesen werden, und in der Zwischenzeit den direkten Link zur sofortigen Prüfung.',
  fr: 'Cette page ne publie pas de plannings de garde : elle indique, pour chaque canton, si nous avons vérifié une source officielle permettant à l’avenir de lire les pharmacies de garde, et en attendant, le lien direct pour vérifier dès maintenant.',
};

const STATUS_LABEL: Record<PharmacySourceStatus, Record<PageLocale, string>> = {
  active: {
    it: 'Fonte verificata',
    en: 'Source verified',
    de: 'Quelle verifiziert',
    fr: 'Source vérifiée',
  },
  unverified: {
    it: 'Verifica in corso',
    en: 'Verification in progress',
    de: 'Verifizierung läuft',
    fr: 'Vérification en cours',
  },
  degraded: {
    it: 'Fonte instabile',
    en: 'Source unstable',
    de: 'Quelle instabil',
    fr: 'Source instable',
  },
  blocked: {
    it: 'Accesso bloccato',
    en: 'Access blocked',
    de: 'Zugriff blockiert',
    fr: 'Accès bloqué',
  },
};

const COVERAGE_ACTIVE_HEADING: Record<PageLocale, string> = {
  it: 'Copertura attiva',
  en: 'Active coverage',
  de: 'Aktive Abdeckung',
  fr: 'Couverture active',
};

const COVERAGE_IN_PROGRESS_HEADING: Record<PageLocale, string> = {
  it: 'Copertura in corso',
  en: 'Coverage in progress',
  de: 'Abdeckung im Aufbau',
  fr: 'Couverture en cours',
};

function coverageIntro(count: number, total: number, locale: PageLocale): string {
  if (count === 0) {
    return {
      it: `Nessun cantone ha ancora una fonte verificata: sotto trovi comunque il link ufficiale per ogni cantone che stiamo esaminando (${total} finora), da consultare direttamente.`,
      en: `No canton has a verified source yet: below you still find the official link for every canton we are examining (${total} so far), to check directly.`,
      de: `Noch kein Kanton hat eine verifizierte Quelle: unten finden Sie dennoch den offiziellen Link für jeden von uns geprüften Kanton (${total} bisher), zur direkten Kontrolle.`,
      fr: `Aucun canton n’a encore de source vérifiée : vous trouverez ci-dessous le lien officiel pour chaque canton examiné jusqu’ici (${total}), à consulter directement.`,
    }[locale];
  }
  return {
    it: `${count} su ${total} cantoni esaminati ha una fonte ufficiale verificata come leggibile in modo automatico. Gli altri restano elencati con lo stato della verifica e il link ufficiale.`,
    en: `${count} of ${total} examined cantons has an official source verified as machine-readable. The others remain listed with their verification status and official link.`,
    de: `${count} von ${total} geprüften Kantonen verfügt über eine offizielle Quelle, die als maschinenlesbar verifiziert wurde. Die übrigen bleiben mit ihrem Verifizierungsstatus und dem offiziellen Link aufgeführt.`,
    fr: `${count} canton(s) sur ${total} examinés dispose(nt) d’une source officielle vérifiée comme lisible automatiquement. Les autres restent listés avec leur statut de vérification et leur lien officiel.`,
  }[locale];
}

const NOT_YET_LIVE_NOTE: Record<PageLocale, string> = {
  it: 'Anche per un cantone con fonte verificata, questa pagina non pubblica ancora l’elenco delle farmacie di turno: la verifica riguarda solo l’affidabilità della fonte, non un servizio di ricerca già collegato.',
  en: 'Even for a canton with a verified source, this page does not yet publish the on-duty pharmacy listing: the verification covers only the reliability of the source, not a search service already wired up.',
  de: 'Auch bei einem Kanton mit verifizierter Quelle veröffentlicht diese Seite die Liste der Notfall-Apotheken noch nicht: Die Verifizierung betrifft nur die Zuverlässigkeit der Quelle, nicht einen bereits angebundenen Suchdienst.',
  fr: 'Même pour un canton à la source vérifiée, cette page ne publie pas encore la liste des pharmacies de garde : la vérification ne porte que sur la fiabilité de la source, pas sur un service de recherche déjà connecté.',
};

const DISCLAIMER_HEADING: Record<PageLocale, string> = {
  it: 'Verifica sempre telefonicamente',
  en: 'Always verify by phone',
  de: 'Immer telefonisch nachprüfen',
  fr: 'Vérifiez toujours par téléphone',
};

const DISCLAIMER_TEXT: Record<PageLocale, string> = {
  it: 'Verifica sempre telefonicamente con la farmacia o con la fonte ufficiale del cantone prima di spostarti: gli orari di turno possono cambiare all’ultimo momento e questa pagina, come le fonti che collega, non sostituisce una chiamata di conferma in caso di urgenza.',
  en: 'Always verify by phone with the pharmacy or the canton’s official source before travelling: duty hours can change at the last minute, and this page, like the sources it links to, is no substitute for a confirmation call in an emergency.',
  de: 'Bitte immer telefonisch bei der Apotheke oder der offiziellen Quelle des Kantons nachprüfen, bevor Sie losfahren: Dienstzeiten können sich kurzfristig ändern, und diese Seite ersetzt, wie die verlinkten Quellen, im Notfall keinen Bestätigungsanruf.',
  fr: 'Vérifiez toujours par téléphone auprès de la pharmacie ou de la source officielle du canton avant de vous déplacer : les horaires de garde peuvent changer à la dernière minute, et cette page, comme les sources qu’elle relie, ne remplace pas un appel de confirmation en cas d’urgence.',
};

const SOURCE_LINK_LABEL: Record<PageLocale, string> = {
  it: 'Fonte ufficiale',
  en: 'Official source',
  de: 'Offizielle Quelle',
  fr: 'Source officielle',
};

const VERIFIED_ON_LABEL: Record<PageLocale, string> = {
  it: 'Verificata il',
  en: 'Verified on',
  de: 'Verifiziert am',
  fr: 'Vérifiée le',
};

function homeUrl(locale: PageLocale): string {
  return locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
}

function formatDate(iso: string, locale: PageLocale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale === 'it' ? 'it-CH' : locale, { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderCantonCard(entry: PharmacySourceEntry, locale: PageLocale): string {
  const statusLabel = STATUS_LABEL[entry.status]?.[locale] ?? entry.status;
  const verified = entry.lastVerifiedAt
    ? `<p style="${BODY_STYLE}"><strong>${esc(VERIFIED_ON_LABEL[locale])}:</strong> ${esc(formatDate(entry.lastVerifiedAt, locale))}</p>`
    : '';
  const fetched = entry.sourceFetchedAt
    ? `<p style="${BODY_STYLE}"><strong>${esc(VERIFIED_ON_LABEL[locale])}:</strong> ${esc(formatDate(entry.sourceFetchedAt, locale))}</p>`
    : '';
  const notes = entry.notes ? `<p style="${BODY_STYLE}">${esc(entry.notes)}</p>` : '';
  return `
      <article class="${CARD_CLASS}">
        <h3 style="${H3_STYLE}">${esc(entry.canton)}</h3>
        <p style="${BODY_STYLE}"><strong>${esc(statusLabel)}</strong></p>
        ${verified}${fetched}
        <p style="${BODY_STYLE}"><a href="${esc(entry.officialSourceUrl)}" rel="nofollow noopener">${esc(SOURCE_LINK_LABEL[locale])} →</a></p>
        ${notes}
      </article>`;
}

function renderBody(locale: PageLocale): string {
  const entries = Object.values(registry.sources);
  const activeEntries = entries.filter((e) => e.status === 'active');
  const heading = activeEntries.length > 0 ? COVERAGE_ACTIVE_HEADING[locale] : COVERAGE_IN_PROGRESS_HEADING[locale];
  const intro = coverageIntro(activeEntries.length, entries.length, locale);
  const cards = entries.map((e) => renderCantonCard(e, locale)).join('');

  return `
    <header>
      <h1 style="${H1_STYLE}">${esc(H1[locale])}</h1>
      <p style="${LEDE_STYLE}">${esc(LEDE[locale])}</p>
    </header>
    <section>
      <h2 style="${H2_STYLE}">${esc(heading)}</h2>
      <p style="${BODY_STYLE}">${esc(intro)}</p>
      <p style="${BODY_STYLE}">${esc(NOT_YET_LIVE_NOTE[locale])}</p>
      <div class="s-XENO3U">${cards}</div>
    </section>
    <section>
      <h2 style="${H2_STYLE}">${esc(DISCLAIMER_HEADING[locale])}</h2>
      <p style="${BODY_STYLE}">${esc(DISCLAIMER_TEXT[locale])}</p>
    </section>`;
}

function breadcrumbLd(locale: PageLocale): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: HOME_LABEL[locale], item: homeUrl(locale) },
      { '@type': 'ListItem', position: 2, name: H1[locale], item: `${BASE_URL}${PHARMACY_HUB_PATH[locale]}` },
    ],
  });
}

function hreflangHtml(): string {
  return [
    ...LOCALES.map((l) => `<link rel="alternate" hreflang="${l}" href="${BASE_URL}${PHARMACY_HUB_PATH[l]}" />`),
    `<link rel="alternate" hreflang="x-default" href="${BASE_URL}${PHARMACY_HUB_PATH.it}" />`,
  ].join('\n');
}

/** Exported for tests, which assert the four pages are indexable without running a full build. */
export function buildPharmacyHubPage(locale: PageLocale, distDir?: string): { html: string; wordCount: number } {
  const body = renderBody(locale);
  const bodyHtml = `<main class="seo-static-content">${body}</main>`;
  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title: TITLE[locale],
    description: DESCRIPTION[locale],
    canonicalUrl: `${BASE_URL}${PHARMACY_HUB_PATH[locale]}`,
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
    if (!idx.includes('sitemap-farmacie.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-farmacie.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-farmacie\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(masterSitemap, idx, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[pharmacy-hub]\x1b[0m sitemap-index patch failed:', err);
  }
}

export function pharmacyHubPlugin(rootDir: string): Plugin {
  return {
    name: 'pharmacy-hub',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const collector = new WriteCollector({ distDir, pluginName: 'pharmacyHubPlugin' });
      const dateStamp = new Date().toISOString().slice(0, 10);

      for (const locale of LOCALES) {
        const { html } = buildPharmacyHubPage(locale, distDir);
        const urlPath = PHARMACY_HUB_PATH[locale].replace(/\/+$/, '');
        collector.add(path.join(distDir, `${urlPath}/index.html`), html);
      }

      const sitemapXml =
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        LOCALES.map(
          (l) =>
            `  <url>\n    <loc>${BASE_URL}${PHARMACY_HUB_PATH[l]}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n  </url>\n`,
        ).join('') +
        `</urlset>\n`;
      try {
        fs.writeFileSync(path.join(distDir, 'sitemap-farmacie.xml'), sitemapXml, 'utf-8');
      } catch (err) {
        console.warn('\x1b[33m[pharmacy-hub]\x1b[0m sitemap write failed:', err);
      }

      const written = await collector.flush();
      console.log(`\x1b[36m[pharmacy-hub]\x1b[0m Emitted ${written} pages from ${Object.keys(registry.sources).length} registry entries`);

      if (fs.existsSync(path.join(distDir, 'sitemap-farmacie.xml'))) {
        patchSitemapIndex(distDir, dateStamp);
      }
    },
  };
}
