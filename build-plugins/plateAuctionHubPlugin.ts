/**
 * Plate-auction national hub — `/aste-targhe-svizzera/` (#4854 → "Pagine e UX
 * → Hub nazionale", scorporata in #6359).
 *
 * IT-only, single page. Reads `data/plate-auction-sources-registry.json`
 * (#6355) and renders, per canton, name/plate code/status/last-verified
 * timestamp (when the registry entry carries one) and a link to the
 * official cantonal source. The connectors (#6356/#6357/#6358) that will
 * populate live auction data have not landed yet — every entry today is
 * `status: 'unverified'` — so this page is built to be correct in that
 * state on purpose: no widget is populated with invented data, and when no
 * canton is `active` the page shows an explicit "copertura in corso"
 * section instead of empty widgets. As connectors flip cantons to `active`
 * this same render picks it up with no further change.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { esc, renderBreadcrumb, H1_STYLE, LEDE_STYLE, BODY_STYLE, H2_STYLE, H3_STYLE, LINK_ACCENT_STYLE } from './shared/seoContentTokens';
import type { PlateAuctionSourceEntry, PlateAuctionSourcesRegistry } from '../services/plateAuctions/types';

export const PLATE_AUCTION_HUB_PATH = '/aste-targhe-svizzera/';
const CANONICAL_URL = `${BASE_URL}${PLATE_AUCTION_HUB_PATH}`;
const REGISTRY_PATH = path.resolve(__dirname, '..', 'data', 'plate-auction-sources-registry.json');

const TITLE = 'Aste targhe svizzere: copertura per cantone | Frontaliere Ticino';
const DESCRIPTION = 'Stato della copertura delle aste ufficiali di targhe cantonali svizzere, cantone per cantone: fonte ufficiale, stato del connettore e data di ultima verifica.';
const H1 = 'Aste targhe svizzere: stato della copertura per cantone';
const LEDE = 'Questa pagina raccoglie, cantone per cantone, lo stato di copertura delle aste ufficiali di targhe svizzere: quale fonte ufficiale seguiamo, se il connettore automatico è già attivo e quando i dati sono stati verificati l’ultima volta.';

const STATUS_LABEL: Record<PlateAuctionSourceEntry['status'], string> = {
  active: 'Attivo — dati aggiornati automaticamente',
  degraded: 'Degradato — verifica manuale in corso',
  blocked: 'Bloccato — fonte non raggiungibile',
  unverified: 'In fase di verifica — nessun dato d’asta pubblicato ancora',
};

function fmtDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('it-CH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderCantonRow(entry: PlateAuctionSourceEntry & { lastVerifiedAt?: string; sourceFetchedAt?: string }): string {
  const verified = fmtDate(entry.lastVerifiedAt) ?? fmtDate(entry.sourceFetchedAt);
  const verifiedLine = verified
    ? `\n      <p style="${BODY_STYLE}">Ultima verifica: ${esc(verified)}</p>`
    : '';
  return `
    <article>
      <h3 style="${H3_STYLE}">${esc(entry.canton)} (${esc(entry.plateCode)})</h3>
      <p style="${BODY_STYLE}"><strong>${esc(STATUS_LABEL[entry.status] ?? entry.status)}</strong></p>${verifiedLine}
      <p style="${BODY_STYLE}"><a href="${esc(entry.officialUrl)}" style="${LINK_ACCENT_STYLE}" rel="noopener" target="_blank">Sito ufficiale del cantone</a></p>
    </article>`;
}

function renderBody(registry: PlateAuctionSourcesRegistry): { bodyHtml: string; wordCount: number } {
  const entries = Object.values(registry.sources).sort((a, b) => a.canton.localeCompare(b.canton, 'it'));
  const anyActive = entries.some((e) => e.status === 'active');

  const coverageSection = anyActive
    ? ''
    : `
    <section>
      <h2 style="${H2_STYLE}">Copertura in corso</h2>
      <p style="${BODY_STYLE}">Nessun cantone ha ancora un connettore attivo: non pubblichiamo aste, offerte o prezzi finché non possiamo verificarli direttamente sulla fonte ufficiale. Nel frattempo puoi consultare i siti ufficiali cantonali qui sotto per le aste in corso.</p>
    </section>`;

  const body = `
    ${renderBreadcrumb([{ label: 'Home', href: `${BASE_URL}/` }, { label: H1 }])}
    <header>
      <h1 style="${H1_STYLE}">${esc(H1)}</h1>
      <p style="${LEDE_STYLE}">${esc(LEDE)}</p>
    </header>${coverageSection}
    <section>
      <h2 style="${H2_STYLE}">Copertura per cantone</h2>
      ${entries.map((e) => renderCantonRow(e)).join('')}
    </section>`;

  const bodyHtml = `<main class="seo-static-content">${body}</main>`;
  return { bodyHtml, wordCount: countHtmlBodyWords(body) };
}

function breadcrumbLd(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: H1, item: CANONICAL_URL },
    ],
  });
}

/** Exported for the test, which asserts the page is indexable without running a build. */
export function buildPlateAuctionHubPage(registry: PlateAuctionSourcesRegistry, distDir?: string): { html: string; wordCount: number } {
  const { bodyHtml, wordCount } = renderBody(registry);

  const html = buildSeoPageHtml({
    locale: 'it',
    title: TITLE,
    description: DESCRIPTION,
    canonicalUrl: CANONICAL_URL,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    jsonLdScripts: [breadcrumbLd()],
    bodyHtml,
    skipMainWrap: true,
    distDir,
  });

  return { html, wordCount };
}

export function plateAuctionHubPlugin(rootDir: string): Plugin {
  return {
    name: 'plate-auction-hub',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      let registry: PlateAuctionSourcesRegistry;
      try {
        registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
      } catch (err) {
        console.warn('\x1b[33m[plate-auction-hub]\x1b[0m registry read failed, skipping:', err);
        return;
      }

      const { html, wordCount } = buildPlateAuctionHubPage(registry, distDir);
      const collector = new WriteCollector({ distDir, pluginName: 'plateAuctionHubPlugin' });
      const urlPath = PLATE_AUCTION_HUB_PATH.replace(/\/+$/, '');
      collector.add(path.join(distDir, `${urlPath}/index.html`), html);
      const written = await collector.flush();
      console.log(`\x1b[36m[plate-auction-hub]\x1b[0m Emitted ${written} page from ${Object.keys(registry.sources).length} cantons (${wordCount} words)`);
    },
  };
}
