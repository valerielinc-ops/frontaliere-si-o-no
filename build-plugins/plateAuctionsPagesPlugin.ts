/**
 * Static first-paint pages for the plate-auction vertical.
 *
 * The data table is still hydrated from the public function/static snapshot,
 * but these pages give crawlers a useful, truthful body before JavaScript:
 * source coverage, current listings when available, and an explicit note when
 * a canton has not yet exposed a verified public catalogue.
 */
import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { differentiateH1FromTitle, esc, H1_STYLE, H2_STYLE, LEDE_STYLE, LINK_ACCENT_STYLE } from './shared/seoContentTokens';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { buildSitemapIndexXml, discoverSitemapFiles } from './sitemapAliasPlugin';
import { buildPlateAuctionPath, allPlateAuctionCantonCodes } from '../services/plateAuctions/paths';
import type { PlateVehicleType } from '../services/plateAuctions/types';

type PlateLocale = 'it' | 'en' | 'de' | 'fr';
const LOCALES: readonly PlateLocale[] = ['it', 'en', 'de', 'fr'];
const OG_LOCALE: Record<PlateLocale, string> = { it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH' };
const CANTON_NAMES: Record<string, Record<PlateLocale, string>> = {
  AG: { it: 'Argovia', en: 'Aargau', de: 'Aargau', fr: 'Argovie' }, AI: { it: 'Appenzello Interno', en: 'Appenzell Innerrhoden', de: 'Appenzell Innerrhoden', fr: 'Appenzell Rhodes-Intérieures' }, AR: { it: 'Appenzello Esterno', en: 'Appenzell Ausserrhoden', de: 'Appenzell Ausserrhoden', fr: 'Appenzell Rhodes-Extérieures' }, BE: { it: 'Berna', en: 'Bern', de: 'Bern', fr: 'Berne' }, BL: { it: 'Basilea Campagna', en: 'Basel-Landschaft', de: 'Basel-Landschaft', fr: 'Bâle-Campagne' }, BS: { it: 'Basilea Città', en: 'Basel-Stadt', de: 'Basel-Stadt', fr: 'Bâle-Ville' }, FR: { it: 'Friburgo', en: 'Fribourg', de: 'Freiburg', fr: 'Fribourg' }, GE: { it: 'Ginevra', en: 'Geneva', de: 'Genf', fr: 'Genève' }, GL: { it: 'Glarona', en: 'Glarus', de: 'Glarus', fr: 'Glaris' }, GR: { it: 'Grigioni', en: 'Graubünden', de: 'Graubünden', fr: 'Grisons' }, JU: { it: 'Giura', en: 'Jura', de: 'Jura', fr: 'Jura' }, LU: { it: 'Lucerna', en: 'Lucerne', de: 'Luzern', fr: 'Lucerne' }, NE: { it: 'Neuchâtel', en: 'Neuchâtel', de: 'Neuenburg', fr: 'Neuchâtel' }, NW: { it: 'Nidvaldo', en: 'Nidwalden', de: 'Nidwalden', fr: 'Nidwald' }, OW: { it: 'Obvaldo', en: 'Obwalden', de: 'Obwalden', fr: 'Obwald' }, SG: { it: 'San Gallo', en: 'St. Gallen', de: 'St. Gallen', fr: 'Saint-Gall' }, SH: { it: 'Sciaffusa', en: 'Schaffhausen', de: 'Schaffhausen', fr: 'Schaffhouse' }, SO: { it: 'Soletta', en: 'Solothurn', de: 'Solothurn', fr: 'Soleure' }, SZ: { it: 'Svitto', en: 'Schwyz', de: 'Schwyz', fr: 'Schwytz' }, TG: { it: 'Turgovia', en: 'Thurgau', de: 'Thurgau', fr: 'Thurgovie' }, TI: { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' }, UR: { it: 'Uri', en: 'Uri', de: 'Uri', fr: 'Uri' }, VD: { it: 'Vaud', en: 'Vaud', de: 'Waadt', fr: 'Vaud' }, VS: { it: 'Vallese', en: 'Valais', de: 'Wallis', fr: 'Valais' }, ZG: { it: 'Zugo', en: 'Zug', de: 'Zug', fr: 'Zoug' }, ZH: { it: 'Zurigo', en: 'Zurich', de: 'Zürich', fr: 'Zurich' },
};
const COPY: Record<PlateLocale, { title: string; intro: string; context: string; sources: string; current: string; rankings: string; allListings: string; noData: string; notDiscovered: string; method: string; detail: string }> = {
  it: { title: 'Aste targhe svizzere', intro: 'Aste pubbliche di targhe svizzere: prezzi correnti, scadenze e risultati finali verificati.', context: 'Questa pagina raccoglie i cataloghi cantonali esposti pubblicamente. Un prezzo corrente indica l’ultima offerta visibile, non una vendita conclusa. I risultati finali entrano nello storico soltanto quando una fonte ufficiale li rende verificabili. I nomi degli offerenti non vengono raccolti né pubblicati.', sources: 'Fonti cantonali', current: 'Aste in corso', rankings: 'Classifiche', allListings: 'Tutte le aste pubblicate', noData: 'Nessuna riga pubblica disponibile in questo momento.', notDiscovered: 'La fonte d’asta pubblica di questo cantone non è ancora stata verificata: la pagina resta visibile per documentare la copertura, senza inventare valori.', method: 'Metodo e limiti dei dati', detail: 'Dettaglio', },
  en: { title: 'Swiss plate auctions', intro: 'Public Swiss plate auctions: current prices, closing times and verified final results.', context: 'This page collects cantonal catalogues that are publicly exposed. A current price is the latest visible bid, not a completed sale. Final results enter the history only when an official source makes them verifiable. Bidder names are not collected or published.', sources: 'Cantonal sources', current: 'Live auctions', rankings: 'Rankings', allListings: 'All published auctions', noData: 'No public row is available right now.', notDiscovered: 'The public auction source for this canton has not been verified yet. We keep the coverage page visible without inventing values.', method: 'Data method and limits', detail: 'Details', },
  de: { title: 'Schweizer Kontrollschildauktionen', intro: 'Öffentliche Schweizer Kontrollschildauktionen: aktuelle Preise und verifizierte Ergebnisse.', context: 'Diese Seite sammelt öffentlich zugängliche kantonale Kataloge. Ein aktueller Preis ist das letzte sichtbare Gebot und kein abgeschlossener Verkauf. Ergebnisse werden erst in die Historie übernommen, wenn eine offizielle Quelle sie überprüfbar macht. Bieternamen werden weder gesammelt noch veröffentlicht.', sources: 'Kantonale Quellen', current: 'Laufende Auktionen', rankings: 'Ranglisten', allListings: 'Alle veröffentlichten Auktionen', noData: 'Zurzeit ist keine öffentliche Zeile verfügbar.', notDiscovered: 'Die öffentliche Auktionsquelle dieses Kantons ist noch nicht verifiziert. Die Abdeckungsseite bleibt sichtbar, ohne Werte zu erfinden.', method: 'Methode und Grenzen', detail: 'Details', },
  fr: { title: 'Ventes aux enchères de plaques suisses', intro: 'Enchères publiques de plaques suisses: prix actuels et résultats finaux vérifiés.', context: 'Cette page rassemble les catalogues cantonaux publics. Un prix actuel est la dernière offre visible, pas une vente conclue. Les résultats finaux ne sont ajoutés à l’historique que lorsqu’une source officielle les rend vérifiables. Les noms des enchérisseurs ne sont ni collectés ni publiés.', sources: 'Sources cantonales', current: 'Enchères en cours', rankings: 'Classements', allListings: 'Toutes les enchères publiées', noData: 'Aucune ligne publique n’est disponible pour le moment.', notDiscovered: 'La source publique d’enchères de ce canton n’est pas encore vérifiée. La page de couverture reste visible sans inventer de valeurs.', method: 'Méthode et limites', detail: 'Détails', },
};

interface SnapshotRow { id: string; sourceKey?: string; canton?: string; platePrefix: string; normalizedPlate: string; listingType?: string; vehicleType?: PlateVehicleType; currentBidChf?: number; startingPriceChf?: number; finalPriceChf?: number; finalPriceVerifiedAt?: string; bidCount?: number; endsAt?: string; closedAt?: string; sourceFetchedAt?: string; auctionStatus: string; dataConfidence: string; officialDetailUrl?: string; officialAuctionUrl: string; }
interface Snapshot { generatedAt?: string; sources?: Record<string, { canton: string; plateCode: string; officialUrl: string; status: string; rowCount?: number; lastFetchedAt?: string }>; auctions?: SnapshotRow[]; history?: SnapshotRow[]; }

function readSnapshot(rootDir: string): Snapshot {
  try { return JSON.parse(fs.readFileSync(np.join(rootDir, 'public', 'data', 'plate-auctions.json'), 'utf8')) as Snapshot; } catch { return {}; }
}
function formatMoney(value: number | undefined, locale: PlateLocale): string { return typeof value === 'number' ? new Intl.NumberFormat(locale === 'it' ? 'it-CH' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(value) : '—'; }
function formatDate(value: string | undefined, locale: PlateLocale): string { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-CH', { dateStyle: 'medium', timeZone: 'Europe/Zurich' }).format(date); }
function listingTypeLabel(value: string | undefined, locale: PlateLocale): string { if (value === 'fixed-price') return locale === 'it' ? 'Prezzo fisso' : locale === 'de' ? 'Festpreis' : locale === 'fr' ? 'Prix fixe' : 'Fixed price'; if (value === 'wanted') return locale === 'it' ? 'Ricerca' : locale === 'de' ? 'Gesucht' : locale === 'fr' ? 'Recherche' : 'Wanted'; return locale === 'it' ? 'Asta' : locale === 'de' ? 'Auktion' : locale === 'fr' ? 'Enchère' : 'Auction'; }
function pathFor(locale: PlateLocale, view: 'hub' | 'rankings' | 'canton' | 'detail', canton?: string, plate?: string, vehicleType?: PlateVehicleType): string { return buildPlateAuctionPath({ locale, view, canton, plate, vehicleType }); }
function detailPathForRow(row: SnapshotRow, locale: PlateLocale): string { return pathFor(locale, 'detail', row.sourceKey || row.platePrefix, row.normalizedPlate, row.vehicleType); }
function alternates(view: 'hub' | 'rankings' | 'canton' | 'detail', canton?: string, plate?: string, vehicleType?: PlateVehicleType): string { return LOCALES.map((locale) => `<link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathFor(locale, view, canton, plate, vehicleType)}">`).concat(`<link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathFor('it', view, canton, plate, vehicleType)}">`).join('\n'); }
function normalizeExpiredRow(row: SnapshotRow): SnapshotRow {
  const endsAt = row.endsAt ? Date.parse(row.endsAt) : Number.NaN;
  if (!['active', 'upcoming'].includes(row.auctionStatus) || !Number.isFinite(endsAt) || endsAt > Date.now()) return row;
  return { ...row, auctionStatus: 'closed', closedAt: row.closedAt || row.endsAt, dataConfidence: row.dataConfidence === 'verified' ? 'partial' : row.dataConfidence };
}
function isCurrentRow(row: SnapshotRow): boolean {
  return ['active', 'upcoming'].includes(row.auctionStatus)
    && (!row.endsAt || !Number.isFinite(Date.parse(row.endsAt)) || Date.parse(row.endsAt) > Date.now());
}
function latestVerifiedFinalRows(rows: SnapshotRow[]): SnapshotRow[] {
  const latest = new Map<string, SnapshotRow>();
  for (const row of rows) {
    if (!['closed', 'sold', 'unsold'].includes(row.auctionStatus) || row.dataConfidence !== 'verified' || typeof row.finalPriceChf !== 'number' || !row.finalPriceVerifiedAt) continue;
    const previous = latest.get(row.id);
    if (!previous || Date.parse(row.finalPriceVerifiedAt || row.sourceFetchedAt || '') >= Date.parse(previous.finalPriceVerifiedAt || previous.sourceFetchedAt || '')) latest.set(row.id, row);
  }
  return [...latest.values()];
}
function tableRows(rows: SnapshotRow[], locale: PlateLocale, copy: typeof COPY.it): string {
  if (rows.length === 0) return `<p>${esc(copy.noData)}</p>`;
  return `<table><thead><tr><th>${esc(locale === 'it' ? 'Targa' : locale === 'de' ? 'Kontrollschild' : locale === 'fr' ? 'Plaque' : 'Plate')}</th><th>${esc(locale === 'it' ? 'Tipo' : locale === 'de' ? 'Typ' : locale === 'fr' ? 'Type' : 'Type')}</th><th>${esc(locale === 'it' ? 'Prezzo' : locale === 'de' ? 'Preis' : locale === 'fr' ? 'Prix' : 'Price')}</th><th>${esc(locale === 'it' ? 'Offerte' : locale === 'de' ? 'Gebote' : locale === 'fr' ? 'Offres' : 'Bids')}</th><th>${esc(locale === 'it' ? 'Scadenza' : locale === 'de' ? 'Ende' : locale === 'fr' ? 'Fin' : 'Ends')}</th></tr></thead><tbody>${rows.map((row) => { const href = detailPathForRow(row, locale); return `<tr><td><a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(row.normalizedPlate)}</a></td><td>${esc(listingTypeLabel(row.listingType, locale))}</td><td>${esc(formatMoney(row.finalPriceChf ?? row.currentBidChf ?? row.startingPriceChf, locale))}</td><td>${row.bidCount ?? '—'}</td><td>${esc(formatDate(row.endsAt || row.closedAt, locale))}</td></tr>`; }).join('')}</tbody></table>`;
}
function unlistedDetailLinks(rows: SnapshotRow[], locale: PlateLocale, listedRows: SnapshotRow[]): string {
  const listedPaths = new Set(listedRows.map((row) => detailPathForRow(row, locale)));
  return rows.map((row) => {
    const href = detailPathForRow(row, locale);
    if (listedPaths.has(href)) return '';
    listedPaths.add(href);
    return `<li><a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(row.normalizedPlate)}</a></li>`;
  }).join('');
}

export function renderPlateAuctionPage({ locale, view, canton, plate, vehicleType, rootDir, distDir }: { locale: PlateLocale; view: 'hub' | 'rankings' | 'canton' | 'detail'; canton?: string; plate?: string; vehicleType?: PlateVehicleType; rootDir: string; distDir?: string }): { urlPath: string; html: string } {
  const copy = COPY[locale];
  const snapshot = readSnapshot(rootDir);
  const auctionRows = (snapshot.auctions || []).map(normalizeExpiredRow);
  const detailRow = view === 'detail'
    ? auctionRows.find((row) => row.dataConfidence !== 'conflicting' && row.normalizedPlate.toLowerCase() === String(plate || '').toLowerCase() && (!canton || row.sourceKey === canton || row.platePrefix === canton) && (vehicleType ? row.vehicleType === vehicleType : (row.vehicleType || 'car') === 'car'))
    : undefined;
  const rankingRows = latestVerifiedFinalRows(snapshot.history?.length ? snapshot.history : snapshot.auctions || []);
  const candidateRows = (view === 'rankings' ? rankingRows : auctionRows)
    .filter((row) => (view === 'rankings'
      ? ['closed', 'sold', 'unsold'].includes(row.auctionStatus) && row.dataConfidence === 'verified' && typeof row.finalPriceChf === 'number' && Boolean(row.finalPriceVerifiedAt)
      : isCurrentRow(row))
      && row.dataConfidence !== 'conflicting'
      && (!canton || row.sourceKey === canton || row.platePrefix === canton))
    .sort((a, b) => (view === 'rankings' ? (b.finalPriceChf || 0) - (a.finalPriceChf || 0) : (b.currentBidChf ?? b.startingPriceChf ?? 0) - (a.currentBidChf ?? a.startingPriceChf ?? 0)));
  const rows = detailRow
    ? [detailRow]
    : view === 'detail'
      ? []
      : view === 'canton'
        ? candidateRows
        : candidateRows.slice(0, 24);
  const name = canton ? (CANTON_NAMES[canton]?.[locale] || canton) : undefined;
  const title = view === 'detail' ? `${detailRow?.normalizedPlate || plate || copy.detail} — ${name || detailRow?.canton || copy.title}` : view === 'rankings' ? `${copy.title} — ${copy.rankings}` : name ? `${copy.title}: ${name}` : copy.title;
  const description = view === 'detail' ? `${copy.intro} ${detailRow?.normalizedPlate || plate || copy.detail}, ${name || detailRow?.canton || copy.title}.` : name ? `${copy.intro} ${name}.` : copy.intro;
  const urlPath = pathFor(locale, view, canton, detailRow?.normalizedPlate || plate, detailRow?.vehicleType || vehicleType);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const sourceRows = Object.values(snapshot.sources || {}).sort((a, b) => a.plateCode.localeCompare(b.plateCode));
  const links = allPlateAuctionCantonCodes().map((code) => `<li><a href="${esc(pathFor(locale, 'canton', code))}" style="${LINK_ACCENT_STYLE}">${esc(code)} — ${esc(CANTON_NAMES[code]?.[locale] || code)}</a></li>`).join('');
  const cantonAuctionRows = canton ? auctionRows.filter((row) => row.sourceKey === canton || row.platePrefix === canton) : [];
  const detailLinks = view === 'canton' ? unlistedDetailLinks(cantonAuctionRows, locale, rows) : '';
  const parentPath = canton ? pathFor(locale, 'canton', canton) : view === 'rankings' ? pathFor(locale, 'rankings') : pathFor(locale, 'hub');
  const parentLabel = canton ? name : view === 'rankings' ? copy.rankings : copy.current;
  // Keep the visible heading distinct from the shell title. The audit compares
  // the emitted `<title>` with the first `<h1>` after removing the optional
  // brand suffix; using the shared helper here fixes every generated auction
  // page without changing the canonical title or structured-data name.
  const h1 = differentiateH1FromTitle(title, title, locale);
  const breadcrumbParent = view === 'hub' ? '' : ` / <a href="${esc(parentPath)}" style="${LINK_ACCENT_STYLE}">${esc(parentLabel || copy.current)}</a>`;
  const body = `<main><nav aria-label="breadcrumb"><a href="${esc(pathFor(locale, 'hub'))}" style="${LINK_ACCENT_STYLE}">Home</a>${breadcrumbParent} / <span>${esc(title)}</span></nav><div data-plate-auctions-static="true" data-generated-at="${esc(snapshot.generatedAt || '')}"><h1 style="${H1_STYLE}">${esc(h1)}</h1><p style="${LEDE_STYLE}">${esc(description)}</p><p>${esc(copy.context)}</p><p><a href="${esc(pathFor(locale, 'hub'))}" style="${LINK_ACCENT_STYLE}">${esc(copy.current)}</a> · <a href="${esc(pathFor(locale, 'rankings'))}" style="${LINK_ACCENT_STYLE}">${esc(copy.rankings)}</a></p><section><h2 style="${H2_STYLE}">${esc(view === 'rankings' ? copy.rankings : view === 'detail' ? copy.detail : copy.current)}</h2>${tableRows(rows, locale, copy)}${detailLinks ? `<h3 style="${H2_STYLE}">${esc(copy.allListings)}</h3><ul>${detailLinks}</ul>` : ''}</section><section><h2 style="${H2_STYLE}">${esc(canton ? copy.method : copy.sources)}</h2><p>${esc(canton && sourceRows.find((source) => source.plateCode === canton)?.status === 'not-discovered' ? copy.notDiscovered : copy.context)}</p>${canton || view === 'detail' ? '' : `<ul>${links}</ul>`}</section></div></main>`;
  // buildSeoPageHtml owns the single outer <main> in outside-root mode. Keep
  // this page-specific string as inner content so React mounts only its lite
  // chrome in #root and cannot replace the crawler-facing table.
  const staticBody = body.replace(/^<main>/, '').replace(/<\/main>$/, '');
  const itemList = rows.map((row, index) => ({ '@type': 'ListItem', position: index + 1, name: row.normalizedPlate, url: `${BASE_URL}${detailPathForRow(row, locale)}` }));
  const jsonLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': view === 'detail' ? 'WebPage' : 'CollectionPage', name: title, url: canonicalUrl, description, inLanguage: locale, ...(snapshot.generatedAt ? { dateModified: snapshot.generatedAt } : {}), ...(view === 'detail' ? { about: { '@type': 'Thing', name: detailRow?.normalizedPlate || plate } } : { mainEntity: { '@type': 'ItemList', itemListElement: itemList } }) });
  const breadcrumbItems: Array<Record<string, unknown>> = [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` }];
  if (view !== 'hub') {
    breadcrumbItems.push({ '@type': 'ListItem', position: 2, name: copy.title, item: `${BASE_URL}${pathFor(locale, 'hub')}` });
  }
  // The ranking/canton page is the current page, so it belongs only in the
  // final item below. A canton crumb is a parent only for a detail page;
  // otherwise adding it here would repeat the canonical URL and invalidate
  // the breadcrumb chain for every index page.
  if (view === 'detail' && canton) {
    breadcrumbItems.push({ '@type': 'ListItem', position: breadcrumbItems.length + 1, name: name || canton, item: `${BASE_URL}${pathFor(locale, 'canton', canton)}` });
  }
  breadcrumbItems.push({ '@type': 'ListItem', position: breadcrumbItems.length + 1, name: title, item: canonicalUrl });
  const breadcrumbJsonLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: breadcrumbItems });
  // Individual auction records are ephemeral data pages. The hub and canton
  // catalogues are the indexable landing pages; detail records remain linked
  // and crawlable for users, but must not dilute the index with near-identical
  // numeric variants that the information-gain audit correctly treats as
  // mail-merge pages.
  const robots = view === 'detail' ? 'noindex,follow' : 'index,follow';
  return { urlPath: urlPath.replace(/^\//, '').replace(/\/$/, ''), html: buildSeoPageHtml({ locale, title, description, canonicalUrl, hreflangHtml: alternates(view, canton, detailRow?.normalizedPlate || plate, detailRow?.vehicleType || vehicleType), bodyHtml: staticBody, jsonLdScripts: [jsonLd, breadcrumbJsonLd], robots, distDir, seoContentOutsideRoot: true, seoMainClass: 'seo-static-content plate-auction-static' }) };
}

export function plateAuctionsPagesPlugin(rootDir: string): Plugin {
  return { name: 'plate-auction-pages', apply: 'build', enforce: 'post', async closeBundle() {
    if (process.env.SKIP_PLATE_AUCTION_PAGES === '1') return;
    const distDir = np.join(rootDir, 'dist');
    if (!fs.existsSync(distDir)) return;
    let written = 0;
    for (const locale of LOCALES) {
      for (const view of ['hub', 'rankings'] as const) {
        const rendered = renderPlateAuctionPage({ locale, view, rootDir, distDir });
        const out = np.join(distDir, rendered.urlPath, 'index.html'); fs.mkdirSync(np.dirname(out), { recursive: true }); fs.writeFileSync(out, rendered.html, 'utf8'); written++;
      }
      for (const canton of allPlateAuctionCantonCodes()) {
        const rendered = renderPlateAuctionPage({ locale, view: 'canton', canton, rootDir, distDir });
        const out = np.join(distDir, rendered.urlPath, 'index.html'); fs.mkdirSync(np.dirname(out), { recursive: true }); fs.writeFileSync(out, rendered.html, 'utf8'); written++;
      }
    }
    // Detail records are deliberately noindex and are not in the sitemap. Do
    // not materialize one HTML file per ephemeral catalogue row: the live SPA
    // resolves those URLs from the same public snapshot, while hub/canton
    // landing pages above remain static for crawlers and first paint.
    const sitemap = LOCALES.flatMap((locale) => [pathFor(locale, 'hub'), pathFor(locale, 'rankings'), ...allPlateAuctionCantonCodes().map((code) => pathFor(locale, 'canton', code))]).map((url) => `<url><loc>${BASE_URL}${esc(url)}</loc><changefreq>daily</changefreq></url>`).join('');
    fs.writeFileSync(np.join(distDir, 'sitemap-plate-auctions.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemap}</urlset>\n`, 'utf8');
    // sitemapAliasPlugin is a core post-hook and this emitter lives in the
    // later SEO list. Refresh the index here as well so the new shard is not
    // omitted when Rollup orders two post closeBundle hooks by declaration.
    const discovered = await discoverSitemapFiles(distDir);
    fs.writeFileSync(np.join(distDir, 'sitemap.xml'), buildSitemapIndexXml(discovered, BASE_URL), 'utf8');
    console.log(`[plate-auction-pages] Generated ${written} pages`);
  } };
}
