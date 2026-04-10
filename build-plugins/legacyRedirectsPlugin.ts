/**
 * Generate static redirect pages for high-traffic legacy paths.
 * This prevents avoidable 404s and consolidates crawl signals to canonicals.
 */

import path from 'path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { BASE_URL, buildCanonicalBridgePage, SPA_ACTION_REDIRECT_SCRIPT, GTAG_SNIPPET } from './constants';
import { resolveSearchConsoleCompatTarget } from './searchConsoleCompat';

/** Hreflang entry extracted from sitemap XML. */
interface HreflangEntry {
  hreflang: string;
  href: string;
}

/**
 * Parse all sitemap XML files under public/ and build a lookup from
 * canonical URL (with trailing slash) → array of hreflang <link> entries.
 * This lets legacy redirect pages point to the correct locale variants of
 * their target canonical URL.
 */
function buildHreflangMap(rootDir: string): Map<string, HreflangEntry[]> {
  const publicDir = path.resolve(rootDir, 'public');
  const sitemapFiles = [
    'sitemap-pages.xml',
    'sitemap-blog.xml',
    'sitemap-glossario.xml',
    'sitemap-news.xml',
  ];

  const map = new Map<string, HreflangEntry[]>();

  for (const file of sitemapFiles) {
    const filePath = path.join(publicDir, file);
    if (!fs.existsSync(filePath)) continue;

    const xml = fs.readFileSync(filePath, 'utf-8');

    // Extract each <url> block
    const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g);
    if (!urlBlocks) continue;

    for (const block of urlBlocks) {
      // Get <loc>
      const locMatch = block.match(/<loc>([^<]+)<\/loc>/);
      if (!locMatch) continue;
      const loc = locMatch[1].trim();

      // Get all xhtml:link hreflang entries
      const hreflangs: HreflangEntry[] = [];
      const linkRegex = /<xhtml:link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"\s*\/>/g;
      let linkMatch;
      while ((linkMatch = linkRegex.exec(block)) !== null) {
        hreflangs.push({ hreflang: linkMatch[1], href: linkMatch[2] });
      }

      if (hreflangs.length > 0) {
        map.set(loc, hreflangs);
      }
    }
  }

  return map;
}

/** Generate hreflang <link> tags string from entries. */
function hreflangLinksHtml(entries: HreflangEntry[]): string {
  return entries
    .map(e => `    <link rel="alternate" hreflang="${e.hreflang}" href="${e.href}">`)
    .join('\n');
}

export function legacyRedirectsPlugin(rootDir: string): Plugin {
  const redirects: Record<string, string> = {
    '/guida-frontalieri/': '/guida-frontaliere/',
    '/guida-frontalieri/calendario-fiscale/': '/tasse-e-pensione/scadenze-fiscali/',
    '/pianificatore-pensione/': '/tasse-e-pensione/calcola-previdenza/',
    '/simulatore-what-if/': '/calcola-stipendio/cosa-cambia-se/',
    '/calculator/': '/calcola-stipendio/',
    '/stats/': '/statistiche/',
    '/comparatori/': '/compara-servizi/',
    '/comparatori/cambio-valuta/': '/compara-servizi/cambio-franco-euro/',
    '/comparatori/traffico-valichi/': '/statistiche/traffico-dogane/',
    '/comparatori/banche/': '/compara-servizi/confronta-banche/',
    '/comparatori/operatori-mobili/': '/compara-servizi/confronta-operatori-mobili/',
    '/comparatori/mappa-comuni/': '/guida-frontaliere/mappa-confine/',
    // Blog articles with changed slugs (old → new canonical)
    '/articoli-frontaliere/elezioni-comunali-ticino-2026/': '/articoli-frontaliere/elezioni-comunali-ticino/',
    '/en/cross-border-articles/ticino-elections-2026/': '/en/cross-border-articles/municipal-elections-ticino/',
    '/de/grenzgaenger-artikel/gemeindewahlen-tessin-2026/': '/de/grenzgaenger-artikel/gemeindewahlen-tessin/',
    '/fr/articles-frontaliers/elections-communales-tessin-2026/': '/fr/articles-frontalier/elections-municipales-tessin/',
    '/articoli-frontaliere/a9-chiusure-notturne-chiasso-como/': '/articoli-frontaliere/chiasso-como-autostrada-a9-chiusure-notturne-cantieri/',
    '/en/cross-border-articles/speed-controls-ticino-2026/': '/en/cross-border-articles/ticino-speed-controls-2026/',
    // Consolidated Q4 2025 frontalieri duplicates → canonical: frontalieri-ticino-dati-q4-2025
    // ex frontalieri-ticino-calo-2025
    '/articoli-frontaliere/frontalieri-ticino-calo-dati-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/',
    '/en/cross-border-articles/cross-border-workers-ticino-decline-2025-data/': '/en/cross-border-articles/cross-border-workers-ticino-data-decline-end-2025/',
    '/de/grenzgaenger-artikel/grenzgaenger-tessin-rueckgang-daten-2025/': '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-ende-2025/',
    '/fr/articles-frontaliers/frontaliers-tessin-baisse-donnees-2025/': '/fr/articles-frontaliers/frontaliers-tessin-donnees-baisse-fin-2025/',
    // ex frontalieri-ticino-controtendenza-2026
    '/articoli-frontaliere/frontalieri-ticino-dati-calo-q4-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/',
    '/en/cross-border-articles/cross-border-workers-ticino-data-decline-q4-2025/': '/en/cross-border-articles/cross-border-workers-ticino-data-decline-end-2025/',
    '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-q4-2025/': '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-ende-2025/',
    '/fr/articles-frontaliers/frontaliers-tessin-donnees-baisse-q4-2025/': '/fr/articles-frontaliers/frontaliers-tessin-donnees-baisse-fin-2025/',
    // ex frontalieri-ticino-calo-q4-2025
    '/articoli-frontaliere/frontalieri-ticino-calo-dati-q4-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/',
    '/en/cross-border-articles/cross-border-workers-ticino-decline-q4-2025-data/': '/en/cross-border-articles/cross-border-workers-ticino-data-decline-end-2025/',
    '/de/grenzgaenger-artikel/grenzgaenger-tessin-rueckgang-q4-2025-daten/': '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-ende-2025/',
    '/fr/articles-frontaliers/frontaliers-tessin-baisse-donnees-q4-2025/': '/fr/articles-frontaliers/frontaliers-tessin-donnees-baisse-fin-2025/',
    // FR articles-frontalier (without trailing 's') — Google indexed both variants
    '/fr/articles-frontalier/frontaliers-tessin-baisse-donnees-2025/': '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-fin-2025/',
    '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-q4-2025/': '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-fin-2025/',
    '/fr/articles-frontalier/frontaliers-tessin-baisse-donnees-q4-2025/': '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-fin-2025/',
    // ── Bing blocked URLs (2026-03-27) — old slugs → current canonical ──
    // IT: category or slug renames
    '/compara-servizi/cambio-valuta/': '/compara-servizi/cambio-franco-euro/',
    '/vivere-in-ticino/aziende-ticino/': '/vivere-in-ticino/aziende-svizzera-italiana/',
    '/vivere-in-ticino/asili-nido-ticino/': '/vivere-in-ticino/confronta-asili-nido/',
    '/vivere-in-ticino/dialetto-ticinese/': '/dialetto-ticinese/',
    '/vivere-in-ticino/prezzi-benzina-confine/': '/statistiche/prezzi-benzina-confine/',
    '/vivere-in-ticino/permessi-lavoro-svizzera/': '/guida-frontaliere/permessi-di-lavoro/',
    '/statistiche/osservatorio-stipendi-ticino/': '/statistiche/osservatorio-stipendi-lavori-ticino/',
    '/statistiche/panoramica-mercato-lavoro/': '/statistiche/',
    '/statistiche/tasso-disoccupazione/': '/statistiche/disoccupazione-svizzera/',
    '/tasse-e-pensione/aliquote-imposta-fonte/': '/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026/',
    '/tasse-e-pensione/pianificazione-pensionistica/': '/tasse-e-pensione/calcola-previdenza/',
    '/tasse-e-pensione/calendario-fiscale/': '/tasse-e-pensione/scadenze-fiscali/',
    '/calcola-stipendio/simulazione-busta-paga/': '/calcola-stipendio/simula-busta-paga/',
    '/calcola-stipendio/what-if-scenario/': '/calcola-stipendio/cosa-cambia-se/',
    '/guida-frontaliere/comuni-confine/': '/vivere-in-ticino/comuni-di-frontiera/',
    '/contatti/': '/chi-siamo/',
    // EN: old slugs
    '/en/salary-calculator/': '/en/calculate-salary/',
    '/en/job-search-ticino/': '/en/find-jobs-ticino/',
    '/en/compare-services/health-insurance/': '/en/service-comparison/compare-health-insurance/',
    // DE: old slugs
    '/de/gehaltsrechner/': '/de/gehalt-berechnen/',
    '/de/stellensuche-tessin/': '/de/jobs-im-tessin/',
    // FR: old slugs
    '/fr/calculateur-salaire/': '/fr/calculer-salaire/',

    // Job slugs migrated from German to Italian
    '/cerca-lavoro-ticino/detailhandelsfachfrau-mann-efz-gestalten-von-einkaufserlebnissen-coop-grigioni/': '/cerca-lavoro-ticino/specialista-del-commercio-al-dettaglio-afc-creazione-di-esperienze-di-acquisto-coop-grigioni/',
    '/cerca-lavoro-ticino/detailhandelsfachfrau-mann-efz-gestalten-von-einkaufserlebnissen-interdiscount-grigioni/': '/cerca-lavoro-ticino/specialista-del-commercio-al-dettaglio-afc-creazione-di-esperienze-di-acquisto-interdiscount-grigioni/',
    '/cerca-lavoro-ticino/logistiker-in-efz-coop-grigioni/': '/cerca-lavoro-ticino/operatore-logistico-in-afc-coop-grigioni/',
    '/cerca-lavoro-ticino/detailhandelsfachfrau-mann-efz-gestalten-von-einkaufserlebnissen-jumbo-grigioni/': '/cerca-lavoro-ticino/specialista-del-commercio-al-dettaglio-afc-creazione-di-esperienze-di-acquisto-jumbo-grigioni/',
    '/cerca-lavoro-ticino/nachwuchskader-verkauf-coop-grigioni/': '/cerca-lavoro-ticino/vendita-quadri-junior-coop-grigioni/',
    '/cerca-lavoro-ticino/galenica-amavita-pharma-assistent-w-m-d-ascona/': '/cerca-lavoro-ticino/assistente-farmaceutico-f-m-d-amavita-galenica-ascona/',
    '/cerca-lavoro-ticino/kundenbetreuer-in-customer-center-mit-begeisterungsfahigkeit-und-noch-viel-mehr-pioniergei/': '/cerca-lavoro-ticino/responsabile-dell-assistenza-clienti-nel-customer-center-con-entusiasmo-e-molto-piu-spirit/',
  };

  const normalize = (p: string): string => {
    if (!p.startsWith('/')) return `/${p.replace(/^\/+/, '')}`;
    return p;
  };
  const withSlash = (p: string): string => {
    const n = normalize(p);
    return n === '/' ? n : (n.endsWith('/') ? n : `${n}/`);
  };

  return {
    name: 'legacy-redirects',
    apply: 'build',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      let count = 0;
      let compatCount = 0;

      // Build hreflang lookup from sitemaps so legacy pages can point to locale variants
      const hreflangMap = buildHreflangMap(rootDir);

      const getHreflangHtml = (targetPath: string): string => {
        const targetUrl = `${BASE_URL}${targetPath}`;
        const entries = hreflangMap.get(targetUrl);
        if (!entries || entries.length === 0) return '';
        return '\n' + hreflangLinksHtml(entries);
      };

      const buildCompatHtml = (from: string, to: string, kind: string) => buildCanonicalBridgePage({
        canonicalUrl: `${BASE_URL}${to}`,
        pathLabel: to,
        title: 'Pagina archiviata | Frontaliere Ticino',
        description: `URL legacy o non piu disponibile collegata a ${to}.`,
        body: `Questa URL ${kind === 'company' ? 'azienda' : kind === 'search' ? 'di ricerca' : 'dell annuncio'} non e piu la versione corretta. Abbiamo mantenuto una pagina compatibile per evitare un errore e aiutare Google a consolidare la canonical.`,
        ctaLabel: 'Apri la pagina corretta',
        noindex: true,
        hreflangEntries: hreflangMap.get(`${BASE_URL}${to}`),
      });

      for (const [fromRaw, toRaw] of Object.entries(redirects)) {
        const from = withSlash(fromRaw);
        const to = withSlash(toRaw);
        if (from === to || from === '/') continue;

        const outDir = path.join(distDir, from.slice(1));
        fs.mkdirSync(outDir, { recursive: true });
        // Skip if a higher-priority plugin already generated this page (e.g. active job or soft-landing)
        if (fs.existsSync(path.join(outDir, 'index.html'))) continue;
        const fromUrl = `${BASE_URL}${from}`;
        const toUrl = `${BASE_URL}${to}`;
        const hreflangTags = getHreflangHtml(to);
        const redirectLd = JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'WebPage',
          name: `Redirect ${from} → ${to}`,
          url: fromUrl,
          isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: BASE_URL },
          mainEntityOfPage: toUrl,
          description: `Pagina legacy reindirizzata verso ${to}`,
          inLanguage: 'it',
        });
        const html = `<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Pagina spostata | Frontaliere Ticino</title>
    <meta name="description" content="Questa URL legacy ha una pagina canonica aggiornata su Frontaliere Ticino.">
    <meta name="robots" content="noindex,follow">
    <link rel="canonical" href="${BASE_URL}${to}">${hreflangTags}
    <script type="application/ld+json">${redirectLd}</script>
    ${GTAG_SNIPPET}
    ${SPA_ACTION_REDIRECT_SCRIPT}
  </head>
  <body>
    <main style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6;color:#0f172a">
      <h1 style="font-size:28px;line-height:1.2;margin:0 0 12px">Pagina spostata</h1>
      <p style="margin:0 0 14px">Questa URL legacy punta a una pagina aggiornata. Apri la destinazione canonica qui sotto.</p>
      <p style="margin:0 0 14px"><a href="${to}" style="color:#1d4ed8;font-weight:700;text-decoration:none">${to}</a></p>
    </main>
  </body>
</html>`;

        fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
        // Also write flat .html to avoid GitHub Pages 301 redirect
        // Flat files must NOT contain location.replace (Google classifies as redirect)
        const flatPath = from.replace(/\/+$/, '');
        if (flatPath) {
          const flatFile = path.join(distDir, flatPath.slice(1) + '.html');
          fs.mkdirSync(path.dirname(flatFile), { recursive: true });
          const flatHtml = html.replace(SPA_ACTION_REDIRECT_SCRIPT, '');
          fs.writeFileSync(flatFile, flatHtml, 'utf-8');
        }
        count++;
      }

      const compatPathsPath = path.resolve(rootDir, 'data/seo-404-compat-paths.json');
      // Job URL patterns handled exclusively by jobsSeoPagesPlugin (active + bridge + soft-landing + self-healing).
      // Writing thin compat pages for job paths is harmful: if jobsSeoPagesPlugin's flush fails,
      // the thin compat page survives and Google indexes it instead of enriched content.
      const JOB_SECTION_PREFIXES = [
        '/cerca-lavoro-ticino/', '/en/find-jobs-ticino/', '/de/stellenangebote-tessin/', '/fr/trouver-emploi-tessin/',
        '/en/find-jobs-ticino/', '/de/jobs-im-tessin/', '/fr/emplois-tessin/',
      ];
      const isJobPath = (p: string): boolean => JOB_SECTION_PREFIXES.some(prefix => p.startsWith(prefix));
      let skippedJobPaths = 0;
      if (fs.existsSync(compatPathsPath)) {
        const compatPathsRaw = JSON.parse(fs.readFileSync(compatPathsPath, 'utf-8'));
        const compatPaths = Array.isArray(compatPathsRaw?.paths) ? compatPathsRaw.paths : [];
        for (const compatPathRaw of compatPaths) {
          const resolution = resolveSearchConsoleCompatTarget(String(compatPathRaw || ''));
          if (!resolution) continue;
          const from = normalize(String(compatPathRaw || ''));
          // Skip self-references (normalize strips trailing slash, canonicalPath may have it)
          const fromNorm = from.replace(/\/+$/, '');
          const toNorm = resolution.canonicalPath.replace(/\/+$/, '');
          if (from === '/' || fromNorm === toNorm) continue;
          // Skip job paths — handled by jobsSeoPagesPlugin with enriched content
          if (isJobPath(from)) { skippedJobPaths++; continue; }
          const outDir = path.join(distDir, from.slice(1));
          fs.mkdirSync(outDir, { recursive: true });
          // Skip if a higher-priority plugin (e.g. soft-landing pages) already generated this page
          if (fs.existsSync(path.join(outDir, 'index.html'))) continue;
          const html = buildCompatHtml(from, resolution.canonicalPath, resolution.kind);
          fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
          const flatPath = from.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = path.join(distDir, flatPath.slice(1) + '.html');
            fs.mkdirSync(path.dirname(flatFile), { recursive: true });
            if (!fs.existsSync(flatFile)) {
              const flatHtml = html.replace(SPA_ACTION_REDIRECT_SCRIPT, '');
              fs.writeFileSync(flatFile, flatHtml, 'utf-8');
            }
          }
          compatCount++;
        }
      }

      if (count > 0) {
        console.log(`\x1b[36m[legacy-redirects]\x1b[0m Generated ${count} legacy redirect pages`);
      }
      if (compatCount > 0) {
        console.log(`\x1b[36m[legacy-redirects]\x1b[0m Generated ${compatCount} Search Console compatibility pages${skippedJobPaths > 0 ? ` (skipped ${skippedJobPaths} job paths → handled by jobs plugin)` : ''}`);
      }
    },
  };
}
