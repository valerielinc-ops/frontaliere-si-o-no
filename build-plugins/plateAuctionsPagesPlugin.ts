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
import { adSlotHtml } from './lib/adSlotHtml';
import { shouldPlaceInfeedAd } from '../services/adsenseSlots';
import { buildSitemapIndexXml, discoverSitemapFiles } from './sitemapAliasPlugin';
import { SITEMAP_SHARD_CAP, padShardIndex } from '../scripts/lib/sitemap-limits.mjs';
import { buildPlateAuctionPath, allPlateAuctionCantonCodes } from '../services/plateAuctions/paths';
import type {
  PlateAuctionSourceStatus,
  PlateAuctionSourcesRegistry,
  PlateVehicleType,
} from '../services/plateAuctions/types';

type PlateLocale = 'it' | 'en' | 'de' | 'fr';
const LOCALES: readonly PlateLocale[] = ['it', 'en', 'de', 'fr'];
// A canton feed can contain a large historical/current catalogue (BS crossed
// 16k rows). Keep the static index useful to crawlers without serialising the
// whole data set into one HTML document; every detail page remains emitted and
// listed in the plate-auction sitemap below.
const CANTON_INDEX_MAX_ROWS = 24;
const CANTON_INDEX_MAX_DETAIL_LINKS = 48;
const OG_LOCALE: Record<PlateLocale, string> = { it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH' };
const CANTON_NAMES: Record<string, Record<PlateLocale, string>> = {
  AG: { it: 'Argovia', en: 'Aargau', de: 'Aargau', fr: 'Argovie' }, AI: { it: 'Appenzello Interno', en: 'Appenzell Innerrhoden', de: 'Appenzell Innerrhoden', fr: 'Appenzell Rhodes-Intérieures' }, AR: { it: 'Appenzello Esterno', en: 'Appenzell Ausserrhoden', de: 'Appenzell Ausserrhoden', fr: 'Appenzell Rhodes-Extérieures' }, BE: { it: 'Berna', en: 'Bern', de: 'Bern', fr: 'Berne' }, BL: { it: 'Basilea Campagna', en: 'Basel-Landschaft', de: 'Basel-Landschaft', fr: 'Bâle-Campagne' }, BS: { it: 'Basilea Città', en: 'Basel-Stadt', de: 'Basel-Stadt', fr: 'Bâle-Ville' }, FR: { it: 'Friburgo', en: 'Fribourg', de: 'Freiburg', fr: 'Fribourg' }, GE: { it: 'Ginevra', en: 'Geneva', de: 'Genf', fr: 'Genève' }, GL: { it: 'Glarona', en: 'Glarus', de: 'Glarus', fr: 'Glaris' }, GR: { it: 'Grigioni', en: 'Graubünden', de: 'Graubünden', fr: 'Grisons' }, JU: { it: 'Giura', en: 'Jura', de: 'Jura', fr: 'Jura' }, LU: { it: 'Lucerna', en: 'Lucerne', de: 'Luzern', fr: 'Lucerne' }, NE: { it: 'Neuchâtel', en: 'Neuchâtel', de: 'Neuenburg', fr: 'Neuchâtel' }, NW: { it: 'Nidvaldo', en: 'Nidwalden', de: 'Nidwalden', fr: 'Nidwald' }, OW: { it: 'Obvaldo', en: 'Obwalden', de: 'Obwalden', fr: 'Obwald' }, SG: { it: 'San Gallo', en: 'St. Gallen', de: 'St. Gallen', fr: 'Saint-Gall' }, SH: { it: 'Sciaffusa', en: 'Schaffhausen', de: 'Schaffhausen', fr: 'Schaffhouse' }, SO: { it: 'Soletta', en: 'Solothurn', de: 'Solothurn', fr: 'Soleure' }, SZ: { it: 'Svitto', en: 'Schwyz', de: 'Schwyz', fr: 'Schwytz' }, TG: { it: 'Turgovia', en: 'Thurgau', de: 'Thurgau', fr: 'Thurgovie' }, TI: { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' }, UR: { it: 'Uri', en: 'Uri', de: 'Uri', fr: 'Uri' }, VD: { it: 'Vaud', en: 'Vaud', de: 'Waadt', fr: 'Vaud' }, VS: { it: 'Vallese', en: 'Valais', de: 'Wallis', fr: 'Valais' }, ZG: { it: 'Zugo', en: 'Zug', de: 'Zug', fr: 'Zoug' }, ZH: { it: 'Zurigo', en: 'Zurich', de: 'Zürich', fr: 'Zurich' },
};
const COPY: Record<PlateLocale, { title: string; intro: string; context: string; sources: string; current: string; rankings: string; allListings: string; noData: string; notDiscovered: string; method: string; detail: string; coverage: string; coverageInProgress: string; coverageIntro: string; coverageInProgressIntro: string; status: string; lastUpdated: string; official: string; registryUpdated: string; coverageUnavailable: string }> = {
  it: { title: 'Aste targhe svizzere', intro: 'Aste pubbliche di targhe svizzere: prezzi correnti, scadenze e risultati finali verificati.', context: 'Questa pagina raccoglie i cataloghi cantonali esposti pubblicamente. Un prezzo corrente indica l’ultima offerta visibile, non una vendita conclusa. I risultati finali entrano nello storico soltanto quando una fonte ufficiale li rende verificabili. I nomi degli offerenti non vengono raccolti né pubblicati.', sources: 'Fonti cantonali', current: 'Aste in corso', rankings: 'Classifiche', allListings: 'Altre aste pubblicate', noData: 'Nessuna riga pubblica disponibile in questo momento.', notDiscovered: 'La fonte d’asta pubblica di questo cantone non è ancora stata verificata: la pagina resta visibile per documentare la copertura, senza inventare valori.', method: 'Metodo e limiti dei dati', detail: 'Dettaglio', coverage: 'Copertura per cantone', coverageInProgress: 'Copertura in corso', coverageIntro: 'Il registro mostra, cantone per cantone, quale fonte ufficiale è stata verificata e quale stato ha il connettore. Le aste vengono mostrate solo per le fonti con stato attivo.', coverageInProgressIntro: 'Nessun cantone ha ancora una fonte con stato attivo. Mostriamo quindi soltanto lo stato di verifica e i link ufficiali: non pubblichiamo prezzi, offerte o nuove aste non verificati.', status: 'Stato', lastUpdated: 'Ultimo aggiornamento', official: 'Sito ufficiale', registryUpdated: 'Registro aggiornato', coverageUnavailable: 'Il registro delle fonti cantonali non è disponibile: la copertura resta esplicitamente non verificata e i dati d’asta non vengono mostrati.', },
  en: { title: 'Swiss plate auctions', intro: 'Public Swiss plate auctions: current prices, closing times and verified final results.', context: 'This page collects cantonal catalogues that are publicly exposed. A current price is the latest visible bid, not a completed sale. Final results enter the history only when an official source makes them verifiable. Bidder names are not collected or published.', sources: 'Cantonal sources', current: 'Live auctions', rankings: 'Rankings', allListings: 'More published auctions', noData: 'No public row is available right now.', notDiscovered: 'The public auction source for this canton has not been verified yet. We keep the coverage page visible without inventing values.', method: 'Data method and limits', detail: 'Details', coverage: 'Coverage by canton', coverageInProgress: 'Coverage in progress', coverageIntro: 'The registry shows which official source is verified for each canton and the current connector status. Auction rows are shown only for sources marked active.', coverageInProgressIntro: 'No canton has an active source yet. We therefore show only verification status and official links, without publishing unverified prices, bids or new auctions.', status: 'Status', lastUpdated: 'Last updated', official: 'Official website', registryUpdated: 'Registry updated', coverageUnavailable: 'The cantonal source registry is unavailable: coverage remains explicitly unverified and auction data is hidden.', },
  de: { title: 'Schweizer Kontrollschildauktionen', intro: 'Öffentliche Schweizer Kontrollschildauktionen: aktuelle Preise und verifizierte Ergebnisse.', context: 'Diese Seite sammelt öffentlich zugängliche kantonale Kataloge. Ein aktueller Preis ist das letzte sichtbare Gebot und kein abgeschlossener Verkauf. Ergebnisse werden erst in die Historie übernommen, wenn eine offizielle Quelle sie überprüfbar macht. Bieternamen werden weder gesammelt noch veröffentlicht.', sources: 'Kantonale Quellen', current: 'Laufende Auktionen', rankings: 'Ranglisten', allListings: 'Weitere veröffentlichte Auktionen', noData: 'Zurzeit ist keine öffentliche Zeile verfügbar.', notDiscovered: 'Die öffentliche Auktionsquelle dieses Kantons ist noch nicht verifiziert. Die Abdeckungsseite bleibt sichtbar, ohne Werte zu erfinden.', method: 'Methode und Grenzen', detail: 'Details', coverage: 'Abdeckung nach Kanton', coverageInProgress: 'Abdeckung im Aufbau', coverageIntro: 'Das Register zeigt für jeden Kanton die geprüfte offizielle Quelle und den Status des Konnektors. Auktionen werden nur für Quellen mit aktivem Status angezeigt.', coverageInProgressIntro: 'Noch kein Kanton hat eine aktive Quelle. Deshalb zeigen wir nur Prüfstatus und offizielle Links und veröffentlichen keine ungeprüften Preise, Gebote oder neuen Auktionen.', status: 'Status', lastUpdated: 'Letzte Aktualisierung', official: 'Offizielle Website', registryUpdated: 'Register aktualisiert', coverageUnavailable: 'Das Register der kantonalen Quellen ist nicht verfügbar: Die Abdeckung bleibt ausdrücklich ungeprüft und Auktionsdaten werden ausgeblendet.', },
  fr: { title: 'Ventes aux enchères de plaques suisses', intro: 'Enchères publiques de plaques suisses: prix actuels et résultats finaux vérifiés.', context: 'Cette page rassemble les catalogues cantonaux publics. Un prix actuel est la dernière offre visible, pas une vente conclue. Les résultats finaux ne sont ajoutés à l’historique que lorsqu’une source officielle les rend vérifiables. Les noms des enchérisseurs ne sont ni collectés ni publiés.', sources: 'Sources cantonales', current: 'Enchères en cours', rankings: 'Classements', allListings: 'Autres enchères publiées', noData: 'Aucune ligne publique n’est disponible pour le moment.', notDiscovered: 'La source publique d’enchères de ce canton n’est pas encore vérifiée. La page de couverture reste visible sans inventer de valeurs.', method: 'Méthode et limites', detail: 'Détails', coverage: 'Couverture par canton', coverageInProgress: 'Couverture en cours', coverageIntro: 'Le registre indique, pour chaque canton, la source officielle vérifiée et le statut du connecteur. Les enchères ne sont affichées que pour les sources actives.', coverageInProgressIntro: 'Aucun canton ne dispose encore d’une source active. Nous affichons donc uniquement le statut de vérification et les liens officiels, sans publier de prix, d’offres ou de nouvelles enchères non vérifiés.', status: 'Statut', lastUpdated: 'Dernière mise à jour', official: 'Site officiel', registryUpdated: 'Registre mis à jour', coverageUnavailable: 'Le registre des sources cantonales est indisponible : la couverture reste explicitement non vérifiée et les données d’enchères sont masquées.', },
};

const STATUS_LABELS: Record<PlateLocale, Record<PlateAuctionSourceStatus, string>> = {
  it: { active: 'Attivo', blocked: 'Bloccato', degraded: 'Degradato', unverified: 'Da verificare', 'not-discovered': 'Fonte non individuata', 'no-public-auction': 'Nessuna asta pubblica' },
  en: { active: 'Active', blocked: 'Blocked', degraded: 'Degraded', unverified: 'Unverified', 'not-discovered': 'Source not discovered', 'no-public-auction': 'No public auction' },
  de: { active: 'Aktiv', blocked: 'Blockiert', degraded: 'Eingeschränkt', unverified: 'Ungeprüft', 'not-discovered': 'Quelle nicht gefunden', 'no-public-auction': 'Keine öffentliche Auktion' },
  fr: { active: 'Actif', blocked: 'Bloqué', degraded: 'Dégradé', unverified: 'Non vérifié', 'not-discovered': 'Source non trouvée', 'no-public-auction': 'Aucune enchère publique' },
};

interface SnapshotRow { id: string; sourceKey?: string; canton?: string; platePrefix: string; normalizedPlate: string; listingType?: string; vehicleType?: PlateVehicleType; currentBidChf?: number; startingPriceChf?: number; finalPriceChf?: number; finalPriceVerifiedAt?: string; bidCount?: number; endsAt?: string; closedAt?: string; sourceFetchedAt?: string; auctionStatus: string; dataConfidence: string; officialDetailUrl?: string; officialAuctionUrl: string; }
interface Snapshot { generatedAt?: string; sources?: Record<string, { canton: string; plateCode: string; officialUrl: string; status: string; rowCount?: number; lastFetchedAt?: string }>; auctions?: SnapshotRow[]; history?: SnapshotRow[]; }
interface SourceCoverageEntry {
  canton: string;
  plateCode: string;
  officialUrl: string;
  status: PlateAuctionSourceStatus;
  lastUpdatedAt?: string;
}

function readSnapshot(rootDir: string): Snapshot {
  try { return JSON.parse(fs.readFileSync(np.join(rootDir, 'public', 'data', 'plate-auctions.json'), 'utf8')) as Snapshot; } catch { return {}; }
}
function readSourceRegistry(rootDir: string): PlateAuctionSourcesRegistry | null {
  try {
    const registry = JSON.parse(fs.readFileSync(np.join(rootDir, 'data', 'plate-auction-sources-registry.json'), 'utf8')) as PlateAuctionSourcesRegistry;
    return registry && typeof registry.sources === 'object' ? registry : null;
  } catch {
    return null;
  }
}
function readSourceCoverage(rootDir: string, snapshot: Snapshot): { registry: PlateAuctionSourcesRegistry | null; entries: SourceCoverageEntry[] } {
  const registry = readSourceRegistry(rootDir);
  if (!registry) return { registry: null, entries: [] };
  const snapshotSources = Object.values(snapshot.sources || {});
  const entries = Object.values(registry.sources)
    .map((entry) => {
      const snapshotSource = snapshotSources.find((source) => source.plateCode.toUpperCase() === entry.plateCode.toUpperCase());
      return {
        canton: entry.canton,
        plateCode: entry.plateCode,
        officialUrl: entry.officialUrl,
        status: entry.status,
        lastUpdatedAt: entry.lastVerifiedAt || entry.sourceFetchedAt || snapshotSource?.lastFetchedAt,
      };
    })
    .sort((a, b) => a.canton.localeCompare(b.canton, 'it'));
  return { registry, entries };
}
function formatMoney(value: number | undefined, locale: PlateLocale): string { return typeof value === 'number' ? new Intl.NumberFormat(locale === 'it' ? 'it-CH' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(value) : '—'; }
function formatDate(value: string | undefined, locale: PlateLocale): string { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-CH', { dateStyle: 'medium', timeZone: 'Europe/Zurich' }).format(date); }
function sourceStatusLabel(status: PlateAuctionSourceStatus, locale: PlateLocale): string { return STATUS_LABELS[locale][status] || status; }
function renderCoverageSection(registry: PlateAuctionSourcesRegistry | null, entries: SourceCoverageEntry[], locale: PlateLocale, copy: typeof COPY.it): string {
  const hasActiveSource = entries.some((entry) => entry.status === 'active');
  const title = hasActiveSource ? copy.coverage : copy.coverageInProgress;
  const intro = hasActiveSource ? copy.coverageIntro : copy.coverageInProgressIntro;
  const registryStamp = registry?.generatedAt ? `<p>${esc(copy.registryUpdated)}: ${esc(formatDate(registry.generatedAt, locale))}</p>` : '';
  const rows = entries.map((entry) => {
    const updated = entry.lastUpdatedAt ? ` <span>${esc(copy.lastUpdated)}: ${esc(formatDate(entry.lastUpdatedAt, locale))}</span>` : '';
    const cantonName = CANTON_NAMES[entry.plateCode]?.[locale] || entry.canton;
    return `<li data-canton-status="${esc(entry.status)}"><strong>${esc(cantonName)} (${esc(entry.plateCode)})</strong> — ${esc(copy.status)}: ${esc(sourceStatusLabel(entry.status, locale))}.${updated} <a href="${esc(entry.officialUrl)}" style="${LINK_ACCENT_STYLE}" rel="noopener noreferrer" target="_blank">${esc(copy.official)}</a></li>`;
  }).join('');
  const content = entries.length > 0
    ? `<ul>${rows}</ul>`
    : `<p>${esc(copy.coverageUnavailable)}</p>`;
  return `<section aria-labelledby="plate-auction-coverage-title"><h2 id="plate-auction-coverage-title" style="${H2_STYLE}">${esc(title)}</h2><p>${esc(intro)}</p>${registryStamp}${content}</section>`;
}
function listingTypeLabel(value: string | undefined, locale: PlateLocale): string { if (value === 'fixed-price') return locale === 'it' ? 'Prezzo fisso' : locale === 'de' ? 'Festpreis' : locale === 'fr' ? 'Prix fixe' : 'Fixed price'; if (value === 'wanted') return locale === 'it' ? 'Ricerca' : locale === 'de' ? 'Gesucht' : locale === 'fr' ? 'Recherche' : 'Wanted'; return locale === 'it' ? 'Asta' : locale === 'de' ? 'Auktion' : locale === 'fr' ? 'Enchère' : 'Auction'; }
function vehicleTypeLabel(value: PlateVehicleType | undefined, locale: PlateLocale): string { if (value === 'motorcycle') return locale === 'it' ? 'Moto' : locale === 'de' ? 'Motorrad' : locale === 'fr' ? 'Moto' : 'Motorcycle'; if (value === 'trailer') return locale === 'it' ? 'Rimorchio' : locale === 'de' ? 'Anhänger' : locale === 'fr' ? 'Remorque' : 'Trailer'; if (value === 'other') return locale === 'it' ? 'Altro' : locale === 'de' ? 'Andere' : locale === 'fr' ? 'Autre' : 'Other'; return locale === 'it' ? 'Auto' : locale === 'de' ? 'Auto' : locale === 'fr' ? 'Auto' : 'Car'; }
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
function detailRowsForSnapshot(snapshot: Snapshot, currentRows: SnapshotRow[]): SnapshotRow[] {
  const rowsByPath = new Map<string, SnapshotRow>();
  for (const row of [...currentRows, ...(snapshot.history || []).map(normalizeExpiredRow)]) {
    if (row.dataConfidence === 'conflicting' || !row.normalizedPlate) continue;
    const path = detailPathForRow(row, 'it');
    if (!rowsByPath.has(path)) rowsByPath.set(path, row);
  }
  return [...rowsByPath.values()];
}
function tableRows(rows: SnapshotRow[], locale: PlateLocale, copy: typeof COPY.it): string {
  if (rows.length === 0) return `<p>${esc(copy.noData)}</p>`;
  const headers = {
    plate: locale === 'it' ? 'Targa' : locale === 'de' ? 'Kontrollschild' : locale === 'fr' ? 'Plaque' : 'Plate',
    vehicle: locale === 'it' ? 'Veicolo' : locale === 'de' ? 'Fahrzeug' : locale === 'fr' ? 'Véhicule' : 'Vehicle',
    type: locale === 'it' ? 'Tipo' : locale === 'de' ? 'Typ' : locale === 'fr' ? 'Type' : 'Type',
    price: locale === 'it' ? 'Prezzo' : locale === 'de' ? 'Preis' : locale === 'fr' ? 'Prix' : 'Price',
    bids: locale === 'it' ? 'Offerte' : locale === 'de' ? 'Gebote' : locale === 'fr' ? 'Offres' : 'Bids',
    ends: locale === 'it' ? 'Scadenza' : locale === 'de' ? 'Ende' : locale === 'fr' ? 'Fin' : 'Ends',
  };
  const body = rows.map((row, index) => {
    const href = detailPathForRow(row, locale);
    const adRow = index + 1 < rows.length && shouldPlaceInfeedAd(index + 1)
      ? `<tr class="ft-infeed-ad" role="presentation"><td colspan="6">${adSlotHtml('JOBLIST_INFEED_DESKTOP')}</td></tr>`
      : '';
    return `<tr><td><a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(row.normalizedPlate)}</a></td><td>${esc(vehicleTypeLabel(row.vehicleType, locale))}</td><td>${esc(listingTypeLabel(row.listingType, locale))}</td><td>${esc(formatMoney(row.finalPriceChf ?? row.currentBidChf ?? row.startingPriceChf, locale))}</td><td>${row.bidCount ?? '—'}</td><td>${esc(formatDate(row.endsAt || row.closedAt, locale))}</td></tr>${adRow}`;
  }).join('');
  return `<table><thead><tr><th>${esc(headers.plate)}</th><th>${esc(headers.vehicle)}</th><th>${esc(headers.type)}</th><th>${esc(headers.price)}</th><th>${esc(headers.bids)}</th><th>${esc(headers.ends)}</th></tr></thead><tbody>${body}</tbody></table>`;
}
function unlistedDetailLinks(rows: SnapshotRow[], locale: PlateLocale, listedRows: SnapshotRow[], maxLinks: number): string {
  const listedPaths = new Set(listedRows.map((row) => detailPathForRow(row, locale)));
  const links: string[] = [];
  for (const row of rows) {
    if (links.length >= maxLinks) break;
    if (row.dataConfidence === 'conflicting') continue;
    const href = detailPathForRow(row, locale);
    if (listedPaths.has(href)) continue;
    listedPaths.add(href);
    links.push(`<li><a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(row.normalizedPlate)}</a></li>`);
  }
  return links.join('');
}

export function renderPlateAuctionPage({ locale, view, canton, plate, vehicleType, rootDir, distDir }: { locale: PlateLocale; view: 'hub' | 'rankings' | 'canton' | 'detail'; canton?: string; plate?: string; vehicleType?: PlateVehicleType; rootDir: string; distDir?: string }): { urlPath: string; html: string } {
  const copy = COPY[locale];
  const snapshot = readSnapshot(rootDir);
  const coverage = readSourceCoverage(rootDir, snapshot);
  const activeSourceCodes = new Set(coverage.entries.filter((entry) => entry.status === 'active').map((entry) => entry.plateCode.toUpperCase()));
  const auctionRows = (snapshot.auctions || [])
    .map(normalizeExpiredRow)
    .filter((row) => activeSourceCodes.has(String(row.sourceKey || row.platePrefix).toUpperCase()));
  const activeHistoryRows = (snapshot.history || [])
    .filter((row) => activeSourceCodes.has(String(row.sourceKey || row.platePrefix).toUpperCase()));
  const detailRows = detailRowsForSnapshot({ ...snapshot, history: activeHistoryRows }, auctionRows);
  const detailRow = view === 'detail'
    ? detailRows.find((row) => row.normalizedPlate.toLowerCase() === String(plate || '').toLowerCase() && (!canton || row.sourceKey === canton || row.platePrefix === canton) && (vehicleType ? (row.vehicleType || 'car') === vehicleType : (row.vehicleType || 'car') === 'car'))
    : undefined;
  const rankingRows = latestVerifiedFinalRows(activeHistoryRows.length ? activeHistoryRows : auctionRows);
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
        ? candidateRows.slice(0, CANTON_INDEX_MAX_ROWS)
        : candidateRows.slice(0, 24);
  const name = canton ? (CANTON_NAMES[canton]?.[locale] || canton) : undefined;
  const title = view === 'detail' ? `${detailRow?.normalizedPlate || plate || copy.detail} — ${name || detailRow?.canton || copy.title}` : view === 'rankings' ? `${copy.title} — ${copy.rankings}` : name ? `${copy.title}: ${name}` : copy.title;
  const description = view === 'detail' ? `${copy.intro} ${detailRow?.normalizedPlate || plate || copy.detail}, ${name || detailRow?.canton || copy.title}.` : name ? `${copy.intro} ${name}.` : copy.intro;
  const urlPath = pathFor(locale, view, canton, detailRow?.normalizedPlate || plate, detailRow?.vehicleType || vehicleType);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const links = allPlateAuctionCantonCodes().map((code) => `<li><a href="${esc(pathFor(locale, 'canton', code))}" style="${LINK_ACCENT_STYLE}">${esc(code)} — ${esc(CANTON_NAMES[code]?.[locale] || code)}</a></li>`).join('');
  const cantonAuctionRows = canton ? auctionRows.filter((row) => row.sourceKey === canton || row.platePrefix === canton) : [];
  const detailLinks = view === 'canton'
    ? unlistedDetailLinks(cantonAuctionRows, locale, rows, CANTON_INDEX_MAX_DETAIL_LINKS)
    : '';
  const parentPath = canton ? pathFor(locale, 'canton', canton) : view === 'rankings' ? pathFor(locale, 'rankings') : pathFor(locale, 'hub');
  const parentLabel = canton ? name : view === 'rankings' ? copy.rankings : copy.current;
  // Keep the visible heading distinct from the shell title. The audit compares
  // the emitted `<title>` with the first `<h1>` after removing the optional
  // brand suffix; using the shared helper here fixes every generated auction
  // page without changing the canonical title or structured-data name.
  const h1 = differentiateH1FromTitle(title, title, locale);
  const breadcrumbParent = view === 'hub' ? '' : ` / <a href="${esc(parentPath)}" style="${LINK_ACCENT_STYLE}">${esc(parentLabel || copy.current)}</a>`;
  const topAdHtml = `<section class="ft-plate-auction-top-ad" aria-label="advertisement">${adSlotHtml('JOBDETAIL_TOP_BANNER')}</section>`;
  const coverageSection = view === 'hub' ? renderCoverageSection(coverage.registry, coverage.entries, locale, copy) : '';
  const hasActiveSource = coverage.entries.some((entry) => entry.status === 'active');
  const listingSection = view === 'hub' && !hasActiveSource
    ? ''
    : `<section><h2 style="${H2_STYLE}">${esc(view === 'rankings' ? copy.rankings : view === 'detail' ? copy.detail : copy.current)}</h2>${tableRows(rows, locale, copy)}${detailLinks ? `<h3 style="${H2_STYLE}">${esc(copy.allListings)}</h3><ul>${detailLinks}</ul>` : ''}</section>`;
  const coverageSource = coverage.entries.find((source) => source.plateCode.toUpperCase() === String(canton || '').toUpperCase());
  const sourceSection = `<section><h2 style="${H2_STYLE}">${esc(canton ? copy.method : copy.sources)}</h2><p>${esc(canton && coverageSource?.status !== 'active' ? copy.notDiscovered : copy.context)}</p>${canton || view === 'detail' ? '' : `<ul>${links}</ul>`}</section>`;
  const body = `<main><nav aria-label="breadcrumb"><a href="${esc(pathFor(locale, 'hub'))}" style="${LINK_ACCENT_STYLE}">Home</a>${breadcrumbParent} / <span>${esc(title)}</span></nav><div data-plate-auctions-static="true" data-generated-at="${esc(snapshot.generatedAt || '')}"><h1 style="${H1_STYLE}">${esc(h1)}</h1><p style="${LEDE_STYLE}">${esc(description)}</p><p>${esc(copy.context)}</p>${topAdHtml}<p><a href="${esc(pathFor(locale, 'hub'))}" style="${LINK_ACCENT_STYLE}">${esc(copy.current)}</a> · <a href="${esc(pathFor(locale, 'rankings'))}" style="${LINK_ACCENT_STYLE}">${esc(copy.rankings)}</a></p>${coverageSection}${listingSection}${sourceSection}</div></main>`;
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
  const robots = 'index,follow';
  return { urlPath: urlPath.replace(/^\//, '').replace(/\/$/, ''), html: buildSeoPageHtml({ locale, title, description, canonicalUrl, hreflangHtml: alternates(view, canton, detailRow?.normalizedPlate || plate, detailRow?.vehicleType || vehicleType), bodyHtml: staticBody, jsonLdScripts: [jsonLd, breadcrumbJsonLd], robots, distDir, seoContentOutsideRoot: true, seoMainClass: 'seo-static-content plate-auction-static' }) };
}

export function plateAuctionsPagesPlugin(rootDir: string): Plugin {
  return { name: 'plate-auction-pages', apply: 'build', enforce: 'post', async closeBundle() {
    if (process.env.SKIP_PLATE_AUCTION_PAGES === '1') return;
    const distDir = np.join(rootDir, 'dist');
    if (!fs.existsSync(distDir)) return;
    const snapshot = readSnapshot(rootDir);
    const coverage = readSourceCoverage(rootDir, snapshot);
    const activeSourceCodes = new Set(coverage.entries.filter((entry) => entry.status === 'active').map((entry) => entry.plateCode.toUpperCase()));
    const auctionRows = (snapshot.auctions || [])
      .map(normalizeExpiredRow)
      .filter((row) => activeSourceCodes.has(String(row.sourceKey || row.platePrefix).toUpperCase()));
    const activeHistoryRows = (snapshot.history || [])
      .filter((row) => activeSourceCodes.has(String(row.sourceKey || row.platePrefix).toUpperCase()));
    const detailRows = detailRowsForSnapshot({ ...snapshot, history: activeHistoryRows }, auctionRows);
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
      for (const row of detailRows) {
        const rendered = renderPlateAuctionPage({ locale, view: 'detail', canton: row.sourceKey || row.platePrefix, plate: row.normalizedPlate, vehicleType: row.vehicleType, rootDir, distDir });
        const out = np.join(distDir, rendered.urlPath, 'index.html'); fs.mkdirSync(np.dirname(out), { recursive: true }); fs.writeFileSync(out, rendered.html, 'utf8'); written++;
      }
    }
    const sitemapUrls = LOCALES.flatMap((locale) => [pathFor(locale, 'hub'), pathFor(locale, 'rankings'), ...allPlateAuctionCantonCodes().map((code) => pathFor(locale, 'canton', code)), ...detailRows.map((row) => detailPathForRow(row, locale))]);
    const sitemapShardCount = Math.max(1, Math.ceil(sitemapUrls.length / SITEMAP_SHARD_CAP));
    for (let shardIndex = 0; shardIndex < sitemapShardCount; shardIndex++) {
      const shardUrls = sitemapUrls.slice(shardIndex * SITEMAP_SHARD_CAP, (shardIndex + 1) * SITEMAP_SHARD_CAP);
      const shardBody = shardUrls.map((url) => `<url><loc>${BASE_URL}${esc(url)}</loc><changefreq>daily</changefreq></url>`).join('');
      const fileName = sitemapShardCount === 1 ? 'sitemap-plate-auctions.xml' : `sitemap-plate-auctions-${padShardIndex(shardIndex + 1)}.xml`;
      fs.writeFileSync(np.join(distDir, fileName), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${shardBody}</urlset>\n`, 'utf8');
    }
    // sitemapAliasPlugin is a core post-hook and this emitter lives in the
    // later SEO list. Refresh the index here as well so the new shard is not
    // omitted when Rollup orders two post closeBundle hooks by declaration.
    const discovered = await discoverSitemapFiles(distDir);
    fs.writeFileSync(np.join(distDir, 'sitemap.xml'), buildSitemapIndexXml(discovered, BASE_URL), 'utf8');
    console.log(`[plate-auction-pages] Generated ${written} pages`);
  } };
}
