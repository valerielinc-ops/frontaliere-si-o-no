/**
 * Legacy-alias plugin — emits 200 HTML bridge pages for the 35 GSC
 * `Indicizzata Non trovata` URLs across 9 small misc sub-cohorts
 * (Cohort 5 of the GSC repair effort).
 *
 * Sub-cohorts (see `data/legacy-aliases.json`)
 * --------------------------------------------
 *   blogLocaleMismatch (17): article-id used as slug under non-IT locale
 *                            prefix instead of the locale-translated slug
 *                            from routerBlogData.
 *   blogITMissing (1):       /articoli-frontaliere/{slug} for a slug not
 *                            present in routerBlogData (article renamed
 *                            or removed).
 *   fuelStation (8):         per-station fuel pages for stations that
 *                            rotated out of `data/fuel-prices.json`.
 *   fuelLocaleAlias (1):     /de/dieselpreise/heute/ — DE locale alias of
 *                            the IT fuel section that was never emitted.
 *   jobLegacySection (2):    /cerca-lavoro/{slug} — old section slug
 *                            before `-ticino` was appended.
 *   legacySectionAlt (2):    /ricerca/posti-di-lavoro-ticino/,
 *                            /fr/recherche-emploi-tessin/ — obsolete
 *                            section slug variants.
 *   subSlugOnly (1):         /confronta-casse-malati/ — sub-slug without
 *                            its section prefix.
 *   localePrefixed (2):      /en/consulting/, /de/api-status/ — IT-only
 *                            utility pages linked under locale prefix.
 *   weeklyEmployersDeep (1): /aziende-che-assumono/{city}/{company}/settimana-corrente/
 *                            company×city deep F5 page that wasn't emitted.
 *
 * Approach (200, no 301) mirrors PR #85 (calculator alias), PR #88
 * (job orphans), PR #89 (location hubs), PR #90 (company hubs):
 *
 *   - All pages return 200 via `buildSeoPageHtml` (rule 14 compliant)
 *   - `robots: 'index,follow'` (never-noindex policy)
 *   - `matched` entries: `<link rel="canonical">` → target canonical +
 *     inline pre-hydration `history.replaceState` that rewrites the URL
 *     bar to the canonical (preserves search + hash). SPA boots on the
 *     canonical path → real content renders → AdSense fires.
 *   - `unmatched` entries: canonical → hub/section landing (no replaceState).
 *     User stays on the orphan URL with a brief "pagina non disponibile"
 *     body + browse-all CTA.
 *
 * Plugin contract: apply 'build', enforce 'post', emit in closeBundle.
 * Collision-safe: skips writing if dist already has real content.
 * Sitemap policy: alias pages NOT added to any sitemap.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { buildSeoPageHtml } from './shared/seoPageShell';
import type { Locale } from '../services/i18n';

const BASE_URL = 'https://frontaliereticino.ch';

const OG_LOCALE: Record<Locale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

interface AliasEntry {
  readonly orphanPath: string;
  readonly locale: Locale;
  readonly kind: 'matched' | 'unmatched';
  readonly canonicalPath: string;
  readonly cohort: string;
}

interface AliasesFile {
  readonly generatedAt: string;
  readonly counts: Record<string, number>;
  readonly aliases: AliasEntry[];
}

interface CohortCopy {
  readonly matched: {
    readonly title: string;
    readonly description: string;
    readonly h1: string;
    readonly lede: string;
  };
  readonly unmatched: {
    readonly title: string;
    readonly description: string;
    readonly h1: string;
    readonly lede: string;
  };
  readonly browseAllLabel: string;
}

/**
 * Per-locale copy bundles. Same shape used by all cohorts in this plugin —
 * SEO body is generic enough that one bundle per locale covers all 9
 * sub-cohorts. Specific titles can be customized per-cohort via the
 * `cohortOverrides` map below.
 */
const COPY: Record<Locale, CohortCopy> = {
  it: {
    matched: {
      title: 'Pagina aggiornata — apertura in corso',
      description: 'La pagina richiesta è stata aggiornata. Ti stiamo portando alla versione corrente.',
      h1: 'Pagina aggiornata',
      lede: 'L\'URL che hai cliccato corrisponde a una pagina aggiornata in un indirizzo diverso. Ti stiamo portando automaticamente alla versione corrente, dove trovi tutte le informazioni più recenti. Se la pagina non si apre, usa il link in fondo per navigare al menù principale.',
    },
    unmatched: {
      title: 'Pagina non disponibile — esplora alternative',
      description: 'Questa pagina non è più disponibile. Esplora le sezioni principali del sito per trovare informazioni aggiornate sui frontalieri italo-svizzeri.',
      h1: 'Pagina non disponibile',
      lede: 'La pagina che cercavi non è più disponibile in questo indirizzo. Sul nostro sito trovi guide aggiornate sul Nuovo Accordo bilaterale 2026, calcolatore stipendio netto Permit G/B, comparatori cassa malati e cambio valuta, oltre a oltre 2000 annunci di lavoro frontalieri attivi nel Ticino. Usa il link qui sotto per esplorare i contenuti più recenti.',
    },
    browseAllLabel: 'Esplora il menù principale',
  },
  en: {
    matched: {
      title: 'Page updated — opening the latest version',
      description: 'The page you requested has been updated. We are taking you to the current version.',
      h1: 'Page updated',
      lede: 'The URL you clicked corresponds to a page that has been updated at a new address. We are taking you to the current version with the latest content. If the page does not open, use the link below to navigate to the main menu.',
    },
    unmatched: {
      title: 'Page unavailable — explore alternatives',
      description: 'This page is no longer available. Browse the main sections of the site for up-to-date information for Italian-Swiss cross-border workers.',
      h1: 'Page unavailable',
      lede: 'The page you were looking for is no longer available at this address. Our site has updated guides on the 2026 New Bilateral Agreement, the cross-border net-salary calculator under Permit G/B, health insurance and currency exchange comparators, plus over 2000 active cross-border job listings in Ticino. Use the link below to browse the latest content.',
    },
    browseAllLabel: 'Browse the main menu',
  },
  de: {
    matched: {
      title: 'Seite aktualisiert — Sie werden weitergeleitet',
      description: 'Die angeforderte Seite wurde aktualisiert. Wir leiten Sie zur aktuellen Version weiter.',
      h1: 'Seite aktualisiert',
      lede: 'Die angeklickte URL entspricht einer Seite, die unter einer neuen Adresse aktualisiert wurde. Wir leiten Sie automatisch zur aktuellen Version weiter, wo Sie alle neuesten Informationen finden. Falls die Seite nicht öffnet, nutzen Sie den Link unten, um zum Hauptmenü zu navigieren.',
    },
    unmatched: {
      title: 'Seite nicht verfügbar — Alternativen erkunden',
      description: 'Diese Seite ist nicht mehr verfügbar. Erkunden Sie die Hauptbereiche der Website für aktuelle Informationen für italienisch-schweizerische Grenzgänger.',
      h1: 'Seite nicht verfügbar',
      lede: 'Die gesuchte Seite ist unter dieser Adresse nicht mehr verfügbar. Auf unserer Website finden Sie aktualisierte Leitfäden zum neuen bilateralen Abkommen 2026, den Grenzgänger-Nettolohnrechner unter Permit G/B, Krankenkassen- und Währungsvergleicher sowie über 2000 aktive Grenzgänger-Stellenanzeigen im Tessin. Nutzen Sie den Link unten, um die neuesten Inhalte zu erkunden.',
    },
    browseAllLabel: 'Hauptmenü erkunden',
  },
  fr: {
    matched: {
      title: 'Page mise à jour — ouverture en cours',
      description: 'La page demandée a été mise à jour. Nous vous dirigeons vers la version actuelle.',
      h1: 'Page mise à jour',
      lede: 'L\'URL que vous avez cliquée correspond à une page mise à jour à une nouvelle adresse. Nous vous dirigeons automatiquement vers la version actuelle, où vous trouverez toutes les informations les plus récentes. Si la page ne s\'ouvre pas, utilisez le lien ci-dessous pour naviguer vers le menu principal.',
    },
    unmatched: {
      title: 'Page indisponible — explorer les alternatives',
      description: 'Cette page n\'est plus disponible. Parcourez les sections principales du site pour des informations actualisées sur les frontaliers italo-suisses.',
      h1: 'Page indisponible',
      lede: 'La page que vous recherchiez n\'est plus disponible à cette adresse. Notre site propose des guides actualisés sur le nouvel Accord bilatéral 2026, le calculateur de salaire net frontalier sous Permit G/B, les comparateurs d\'assurance-maladie et de change, ainsi que plus de 2000 annonces frontalières actives au Tessin. Utilisez le lien ci-dessous pour parcourir les contenus les plus récents.',
    },
    browseAllLabel: 'Parcourir le menu principal',
  },
};

function esc(value: string): string {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildRewriteScript(orphanPath: string, canonicalPath: string): string {
  const safeOrphan = JSON.stringify(orphanPath);
  const safeCanonical = JSON.stringify(canonicalPath);
  return `<script>(function(){try{if(location.pathname===${safeOrphan}){history.replaceState(null,'',${safeCanonical}+location.search+location.hash);}}catch(e){}})();</script>`;
}

function renderPage(entry: AliasEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  const block = entry.kind === 'matched' ? copy.matched : copy.unmatched;
  const canonicalUrl = `${BASE_URL}${entry.canonicalPath}`;

  const bodyHtml = `<main class="cluster-seo-prose" style="max-width:860px;margin:0 auto;padding:24px 16px;color:var(--color-body);line-height:1.65">
    <header style="margin-bottom:16px">
      <h1 style="font-size:26px;font-weight:700;color:var(--color-heading);margin:0 0 8px;letter-spacing:-0.01em">${esc(block.h1)}</h1>
    </header>
    <p style="margin:0 0 12px;font-size:15.5px">${esc(block.lede)}</p>
    <p style="margin:12px 0 0;font-size:14.5px"><a href="${esc(canonicalUrl)}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(copy.browseAllLabel)} →</a></p>
  </main>`;

  return buildSeoPageHtml({
    locale,
    title: block.title,
    description: block.description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: '',
    jsonLdScripts: [],
    extraHeadHtml: entry.kind === 'matched' ? buildRewriteScript(entry.orphanPath, entry.canonicalPath) : '',
    bodyHtml,
    distDir,
    seoMainClass: 'cluster-seo-prose',
  });
}

export function legacyAliasPlugin(rootDir: string): Plugin {
  return {
    name: 'legacy-alias',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const dataPath = path.join(rootDir, 'data', 'legacy-aliases.json');
      if (!fs.existsSync(dataPath)) {
        console.warn('\x1b[33m[legacy-alias]\x1b[0m data/legacy-aliases.json missing — skipping');
        return;
      }
      const distDir = path.join(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      let file: AliasesFile;
      try { file = JSON.parse(fs.readFileSync(dataPath, 'utf-8')); }
      catch (err) { console.warn('\x1b[33m[legacy-alias]\x1b[0m parse failed:', err); return; }
      if (!Array.isArray(file.aliases) || file.aliases.length === 0) return;

      let emitted = 0;
      let skipped = 0;
      const start = Date.now();

      for (const entry of file.aliases) {
        const indexTarget = path.join(distDir, entry.orphanPath, 'index.html');
        const flatTarget = path.join(distDir, entry.orphanPath.replace(/\/+$/, '') + '.html');
        if (fs.existsSync(indexTarget)) { skipped++; continue; }

        const html = renderPage(entry, distDir);

        try {
          fs.mkdirSync(path.dirname(indexTarget), { recursive: true });
          fs.writeFileSync(indexTarget, html, 'utf-8');
          fs.writeFileSync(flatTarget, html, 'utf-8');
          emitted += 2;
        } catch (err) {
          console.warn(`\x1b[33m[legacy-alias]\x1b[0m failed to write ${indexTarget}:`, err);
        }
      }

      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `\x1b[36m[legacy-alias]\x1b[0m emitted ${emitted} bridge files (${file.aliases.length - skipped} pages, ${skipped} skipped) in ${dur}s`,
      );
    },
  };
}
