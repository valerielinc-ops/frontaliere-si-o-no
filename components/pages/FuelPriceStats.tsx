import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, ExternalLink, Fuel, Loader2, MapPin, Route, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { haversineKm } from '../../scripts/lib/haversine.mjs';
import { buildSwissStationSlug, fetchFuelPrices, type FuelComparisonCountry, type FuelPricesDataset, type FuelStationItaly, type FuelStationSwitzerland, type MunicipalityFuelRow, zoneFromAddress } from '@/services/fuelPricesService';
import { cdnDataUrl } from '@/services/cdnDataBase';
import { cdnImageUrl } from '@/services/cdnImageBase';
import { FUEL_DAILY_LOCALES, buildFuelItalianStationPath, buildStationSlug, slugify, type FuelDailyLocale } from '@/build-plugins/fuelDailyData';
import { brandLogoSlug } from '@/build-plugins/shared/brandSlug';

type SortKey = 'saving' | 'delta' | 'italy' | 'swiss' | 'name';

type FuelType = 'benzina' | 'diesel';

export interface FuelViewState { fuelType: FuelType; search: string; province: string; sortKey: SortKey; selectedKey: string | null; homeMunicipalityKey: string; tankLiters: number; costPerKmEur: number; page: number; }
export interface FuelRowView {
 italy: { stationCount: number; minPriceEur: number | null; stations: FuelStationItaly[]; };
 swiss: { optionCount: number; minPriceChf: number | null; minPriceEur: number | null; cheapestStation: FuelStationSwitzerland | null; nearbyStations: FuelStationSwitzerland[]; };
 comparison: { cheaperCountry: FuelComparisonCountry; priceDeltaEur: number | null; saving50LEur: number | null; };
}
const DEFAULT_FUEL_VIEW: FuelViewState = { fuelType: 'benzina', search: '', province: 'ALL', sortKey: 'saving', selectedKey: null, homeMunicipalityKey: '', tankLiters: 50, costPerKmEur: 0.18, page: 1 };
function parseNumberParam(value: string | null, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function isSortKey(value: string | null): value is SortKey { return value === 'saving' || value === 'delta' || value === 'italy' || value === 'swiss' || value === 'name'; }
export function parseFuelViewState(search: string): FuelViewState {
 const params = new URLSearchParams(search);
 const fuelType: FuelType = params.get('fuel') === 'diesel' ? 'diesel' : 'benzina';
 const sortKey: SortKey = isSortKey(params.get('sort')) ? params.get('sort') as SortKey : 'saving';
 return { fuelType, search: params.get('q') || '', province: params.get('province') || 'ALL', sortKey, selectedKey: params.get('municipality') || null, homeMunicipalityKey: params.get('home') || '', tankLiters: parseNumberParam(params.get('liters'), 50, 10, 120), costPerKmEur: parseNumberParam(params.get('cost'), 0.18, 0.05, 1), page: Math.max(1, Math.floor(parseNumberParam(params.get('page'), 1, 1, 9999))) };
}
function readFuelViewState(): FuelViewState { return parseFuelViewState(typeof window === 'undefined' ? '' : window.location.search); }
export function buildFuelViewSearch(state: FuelViewState): string {
 const params = new URLSearchParams();
 if (state.fuelType !== DEFAULT_FUEL_VIEW.fuelType) params.set('fuel', state.fuelType);
 if (state.search.trim()) params.set('q', state.search.trim()); if (state.province !== 'ALL') params.set('province', state.province); if (state.sortKey !== 'saving') params.set('sort', state.sortKey);
 if (state.selectedKey) params.set('municipality', state.selectedKey); if (state.homeMunicipalityKey) params.set('home', state.homeMunicipalityKey);
 if (state.tankLiters !== 50) params.set('liters', String(state.tankLiters)); if (state.costPerKmEur !== 0.18) params.set('cost', String(state.costPerKmEur)); if (state.page > 1) params.set('page', String(state.page));
 return params.toString();
}
function fuelViewUrl(state: FuelViewState): string | null { if (typeof window === 'undefined') return null; const url = new URL(window.location.href); url.search = buildFuelViewSearch(state); return url.toString(); }
function isFinitePrice(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function italyStationPrice(station: FuelStationItaly, fuelType: FuelType): number | null { const value = fuelType === 'diesel' ? station.dieselPriceEur : station.priceEur; return isFinitePrice(value) ? value : null; }
function swissStationPrice(station: FuelStationSwitzerland, fuelType: FuelType, currency: 'CHF' | 'EUR'): number | null { const value = fuelType === 'diesel' ? currency === 'CHF' ? station.dieselPriceChf : station.dieselPriceEur : currency === 'CHF' ? station.sp95PriceChf : station.sp95PriceEur; return isFinitePrice(value) ? value : null; }
function compareFuelPrices(italyPrice: number | null, swissPrice: number | null): FuelRowView['comparison'] {
 if (italyPrice == null || swissPrice == null) return { cheaperCountry: 'NO_DATA', priceDeltaEur: null, saving50LEur: null };
 const priceDeltaEur = italyPrice - swissPrice; if (Math.abs(priceDeltaEur) < 0.0005) return { cheaperCountry: 'SAME', priceDeltaEur: 0, saving50LEur: 0 };
 return { cheaperCountry: priceDeltaEur < 0 ? 'IT' : 'CH', priceDeltaEur, saving50LEur: Math.abs(priceDeltaEur) * 50 };
}
function minPrice<T>(items: T[], getPrice: (item: T) => number | null): number | null {
 const prices = items.map(getPrice).filter((value): value is number => value != null);
 return prices.length ? Math.min(...prices) : null;
}
export function fuelRowView(row: MunicipalityFuelRow, fuelType: FuelType): FuelRowView {
 const italyStations = row.italy.stations.filter((station) => italyStationPrice(station, fuelType) != null);
 const swissStations = row.swiss.nearbyStations.filter((station) => swissStationPrice(station, fuelType, 'CHF') != null);
 const italyMin = fuelType === 'diesel' && isFinitePrice(row.italy.minDieselPriceEur)
  ? row.italy.minDieselPriceEur
  : fuelType === 'benzina' ? row.italy.minPriceEur : minPrice(italyStations, (station) => italyStationPrice(station, fuelType));
 const swissMinChf = fuelType === 'diesel' && isFinitePrice(row.swiss.minDieselPriceChf)
  ? row.swiss.minDieselPriceChf
  : fuelType === 'benzina' ? row.swiss.minPriceChf : minPrice(swissStations, (station) => swissStationPrice(station, fuelType, 'CHF'));
 const swissMinEur = fuelType === 'diesel' && isFinitePrice(row.swiss.minDieselPriceEur)
  ? row.swiss.minDieselPriceEur
  : fuelType === 'benzina' ? row.swiss.minPriceEur : minPrice(swissStations, (station) => swissStationPrice(station, fuelType, 'EUR'));
 const cheapestStation = fuelType === 'diesel'
  ? row.swiss.cheapestDieselStation || swissStations.reduce<FuelStationSwitzerland | null>((best, station) => { if (!best) return station; return (swissStationPrice(station, fuelType, 'CHF') ?? Infinity) < (swissStationPrice(best, fuelType, 'CHF') ?? Infinity) ? station : best; }, null)
  : row.swiss.cheapestStation || swissStations[0] || null;
 const nearbyStations = fuelType === 'diesel' && row.swiss.cheapestDieselStation
  ? [row.swiss.cheapestDieselStation, ...swissStations.filter((station) => station.id !== row.swiss.cheapestDieselStation?.id)]
  : swissStations;
 return { italy: { stationCount: fuelType === 'diesel' && typeof row.italy.dieselStationCount === 'number' ? row.italy.dieselStationCount : italyStations.length, minPriceEur: italyMin, stations: italyStations }, swiss: { optionCount: fuelType === 'diesel' && typeof row.swiss.dieselOptionCount === 'number' ? row.swiss.dieselOptionCount : swissStations.length, minPriceChf: swissMinChf, minPriceEur: swissMinEur, cheapestStation, nearbyStations }, comparison: fuelType === 'benzina' ? row.comparison : compareFuelPrices(italyMin, swissMinEur) };
}
export type FuelDataFreshness = 'current' | 'stale' | 'unknown';
export function datasetFreshness(data: FuelPricesDataset, now = Date.now()): FuelDataFreshness {
 const timestamps = [data.generatedAt, data.sources.italy.priceSnapshotDate, data.sources.switzerland.latestObservedUpdate]
  .map((value) => value ? new Date(value).getTime() : NaN).filter(Number.isFinite);
 if (!timestamps.length) return 'unknown';
 const maxAgeMs = 36 * 60 * 60 * 1000;
 return timestamps.every((timestamp) => now - timestamp >= 0 && now - timestamp <= maxAgeMs) ? 'current' : 'stale';
}
function recommendationToneForCode(code: string) { if (code === 'IT') return 'text-success bg-success-subtle border-success-border'; if (code === 'CH') return 'text-accent bg-accent-subtle border-accent-border'; if (code === 'SAME') return 'text-warning bg-warning-subtle border-warning-border'; return 'text-subtle bg-surface-alt/50 border-edge'; }

interface PersonalizedOption {
 type: 'IT' | 'CH';
 label: string;
 stationName: string;
 stationMeta: string;
 pricePerLiterEur: number;
 litersCostEur: number;
 travelDistanceKm: number;
 travelCostEur: number;
 effectiveTotalEur: number;
}

function formatMoney(value: number | null, currency: string, locale: string, digits = 3) {
 if (value == null) return '—';
 return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : locale, {
 style: 'currency',
 currency,
 minimumFractionDigits: digits,
 maximumFractionDigits: digits,
 }).format(value);
}

function formatNumber(value: number, locale: string, digits = 1) {
 return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : locale, {
 minimumFractionDigits: digits,
 maximumFractionDigits: digits,
 }).format(value);
}

function formatDate(value: string | null, locale: string) {
 if (!value) return '—';
 const date = new Date(value);
 if (Number.isNaN(date.getTime())) return value;
 return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : locale, {
 dateStyle: 'medium',
 timeStyle: value.includes('T') ? 'short' : undefined,
 }).format(date);
}

function recommendationTone(row: MunicipalityFuelRow) { return recommendationToneForCode(row.comparison.cheaperCountry); }

function recommendationLabel(code: string) {
 switch (code) {
 case 'IT':
 return 'Italia';
 case 'CH':
 return 'Svizzera';
 case 'SAME':
 return 'Parita';
 default:
 return 'N/D';
 }
}

function swissStationHref(station: FuelStationSwitzerland, fuelType: FuelType): string | null {
 const zone = zoneFromAddress(station.address);
 if (!zone) return null;
 const slug = buildSwissStationSlug({ brand: station.brand, name: station.name, address: station.address });
 if (!slug) return null;
 return `/${fuelType === 'diesel' ? 'prezzi-diesel' : 'prezzi-benzina'}/${zone}/stazioni/${slug}/`;
}

function asFuelLocale(locale: string): FuelDailyLocale {
 return (FUEL_DAILY_LOCALES as readonly string[]).includes(locale) ? (locale as FuelDailyLocale) : 'it';
}

/**
 * City slug for a municipality row. The build now emits per-station pages for
 * EVERY municipality with priced stations (not just the curated set), using
 * `slugify(municipality)` as the city slug — verified collision-free across the
 * dataset — so this mirror is exact. Returns null only for empty names.
 */
function italianCitySlugForRow(row: MunicipalityFuelRow): string | null {
 const name = row.municipality?.trim();
 if (!name) return null;
 return slugify(name) || null;
}

/**
 * Map each Italian station id to the slug of its emitted per-station detail
 * page. Mirrors `collectItalianStationContexts` in
 * build-plugins/fuelDailyPagesPlugin.ts byte-for-byte (dedupe by id keeping
 * the cheapest variant, then per-city slug disambiguation) so links resolve
 * to real `/prezzi-benzina/italia/{city}/stazioni/{slug}/` pages — never 404.
 * Benzina is used because that MIMIT cut covers every border station.
 */
function buildItalianStationSlugMap(row: MunicipalityFuelRow): Map<string, string> {
 const byId = new Map<string, FuelStationItaly>();
 for (const s of row.italy.stations) {
 if (!s.id) continue;
 if (typeof s.priceEur !== 'number' || !Number.isFinite(s.priceEur)) continue;
 const existing = byId.get(s.id);
 if (!existing || existing.priceEur > s.priceEur) byId.set(s.id, s);
 }
 const seen = new Set<string>();
 const out = new Map<string, string>();
 for (const s of byId.values()) {
 if (!s.brand && !s.stationName) continue;
 const baseSlug = buildStationSlug({ brand: s.brand, name: s.stationName, address: s.address });
 if (!baseSlug) continue;
 let slug = baseSlug;
 let suffix = 2;
 while (seen.has(slug)) slug = `${baseSlug}-${suffix++}`;
 seen.add(slug);
 out.set(s.id, slug);
 }
 return out;
}

/**
 * Brand logo for an Italian station: self-hosted SVG from
 * `/images/brands/{slug}.svg`, falling back to an initials monogram chip when
 * the brand has no logo on disk (onError) or no resolvable slug.
 */
function StationBrandLogo({ brand }: { brand: string }) {
 const slug = brandLogoSlug(brand);
 const [failed, setFailed] = useState(false);
 if (!slug || failed) {
 const initials = (brand || '?').trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
 return (
 <span aria-hidden="true" className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-accent-border bg-accent-subtle text-sm font-extrabold text-accent">
 {initials}
 </span>
 );
 }
 return (
 <img
 src={cdnImageUrl(`/images/brands/${slug}.svg`)}
 alt={brand}
 width={40}
 height={40}
 loading="lazy"
 decoding="async"
 onError={() => setFailed(true)}
 className="h-10 w-10 flex-shrink-0 rounded-xl border border-edge bg-surface-alt object-contain p-1.5"
 />
 );
}

function municipalityKey(row: MunicipalityFuelRow) {
 return `${row.municipality}|${row.province}`;
}

function municipalityLabel(row: MunicipalityFuelRow) {
 return `${row.municipality} (${row.province})`;
}

// haversineKm: ora dal modulo condiviso scripts/lib/haversine.mjs
// (era una delle sei copie byte-equivalenti della stessa formula, #5002).

function roundTripTravelCost(distanceKm: number, costPerKmEur: number) {
 return distanceKm * 2 * costPerKmEur;
}

function getItalyStationDistanceKm(row: MunicipalityFuelRow, station: FuelStationItaly) {
 if (station.lat == null || station.lng == null) return 0;
 return haversineKm(row.lat, row.lng, station.lat, station.lng);
}

function getSwissStationDistanceKm(row: MunicipalityFuelRow, station: FuelStationSwitzerland) {
 if (typeof station.distanceKm === 'number') return station.distanceKm;
 return haversineKm(row.lat, row.lng, station.lat, station.lng);
}

function buildPersonalizedOption(
 row: MunicipalityFuelRow,
 liters: number,
 costPerKmEur: number,
 fuelType: FuelType,
): { italy: PersonalizedOption | null; swiss: PersonalizedOption | null; best: PersonalizedOption | null; savingsEur: number | null } {
 const italy = row.italy.stations.reduce<PersonalizedOption | null>((best, station) => {
 const pricePerLiterEur = italyStationPrice(station, fuelType);
 if (pricePerLiterEur == null) return best;
 const travelDistanceKm = getItalyStationDistanceKm(row, station);
 const litersCostEur = pricePerLiterEur * liters;
 const travelCostEur = roundTripTravelCost(travelDistanceKm, costPerKmEur);
 const effectiveTotalEur = litersCostEur + travelCostEur;
 const current: PersonalizedOption = {
 type: 'IT',
 label: 'Italia',
 stationName: station.stationName,
 stationMeta: `${station.brand || 'Pompa'} · ${station.address}`,
 pricePerLiterEur,
 litersCostEur,
 travelDistanceKm,
 travelCostEur,
 effectiveTotalEur,
 };
 if (!best || current.effectiveTotalEur < best.effectiveTotalEur) return current;
 return best;
 }, null);

 const swiss = row.swiss.nearbyStations.reduce<PersonalizedOption | null>((best, station) => {
 const pricePerLiterEur = swissStationPrice(station, fuelType, 'EUR');
 if (pricePerLiterEur == null) return best;
 const travelDistanceKm = getSwissStationDistanceKm(row, station);
 const litersCostEur = pricePerLiterEur * liters;
 const travelCostEur = roundTripTravelCost(travelDistanceKm, costPerKmEur);
 const effectiveTotalEur = litersCostEur + travelCostEur;
 const current: PersonalizedOption = {
 type: 'CH',
 label: 'Svizzera',
 stationName: station.name,
 stationMeta: `${station.brand || 'Pompa'} · ${station.address}`,
 pricePerLiterEur,
 litersCostEur,
 travelDistanceKm,
 travelCostEur,
 effectiveTotalEur,
 };
 if (!best || current.effectiveTotalEur < best.effectiveTotalEur) return current;
 return best;
 }, null);

 const best =
 italy && swiss
 ? italy.effectiveTotalEur <= swiss.effectiveTotalEur ? italy : swiss
 : italy || swiss;
 const other =
 best?.type === 'IT' ? swiss : best?.type === 'CH' ? italy : null;
 const savingsEur = best && other ? other.effectiveTotalEur - best.effectiveTotalEur : null;

 return { italy, swiss, best, savingsEur };
}

function DetailSection({
 row,
 locale,
 tt,
 stationPages,
 fuelType,
}: {
 row: MunicipalityFuelRow;
 locale: string;
 tt: (key: string, fallback: string) => string;
 stationPages: Set<string> | null;
 fuelType: FuelType;
}) {
 const view = fuelRowView(row, fuelType);
 const italyCitySlug = italianCitySlugForRow(row);
 const fuelLocale = asFuelLocale(locale);
 const italyStationSlugs = useMemo(
 () => (italyCitySlug ? buildItalianStationSlugMap(row) : null),
 [italyCitySlug, row],
 );
 return (
 <div className="mt-4 space-y-4 rounded-[1.75rem] border border-edge bg-surface/90 p-4 sm:p-5">
 <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
 <div>
 <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
 <MapPin size={14} />
 {municipalityLabel(row)}
 </div>
 <h3 className="mt-2 text-xl font-bold font-display text-heading">{tt('fuelPrices.detailTitle', 'Dettaglio comune')}</h3>
 <p className="mt-1 text-sm text-muted">
 {tt('fuelPrices.detailSubtitle', 'Qui trovi tutte le stazioni italiane rilevate e le migliori alternative svizzere nel raggio di confronto.')}
 </p>
 </div>
 <div className={`inline-flex items-center rounded-2xl border px-4 py-3 text-sm font-semibold ${recommendationToneForCode(fuelRowView(row, fuelType).comparison.cheaperCountry)}`}>
 {view.comparison.cheaperCountry === 'IT' ? <TrendingDown size={18} /> : <TrendingUp size={18} />}
 <span className="ml-2">
 {tt(`fuelPrices.recommendationLong.${view.comparison.cheaperCountry.toLowerCase()}`, recommendationLabel(view.comparison.cheaperCountry))}
 </span>
 </div>
 </div>

 <div className="grid gap-3 sm:grid-cols-3">
 <div className="rounded-2xl border border-edge bg-surface-alt/50 p-4">
 <div className="text-xs font-semibold uppercase text-muted">{tt('fuelPrices.detailItalyBest', 'Miglior prezzo Italia')}</div>
 <div className="mt-2 text-2xl font-bold text-heading">{formatMoney(view.italy.minPriceEur, 'EUR', locale)}</div>
 <p className="mt-2 text-xs text-muted">{row.italy.cheapestStation?.stationName || '—'}</p>
 </div>
 <div className="rounded-2xl border border-edge bg-surface-alt/50 p-4">
 <div className="text-xs font-semibold uppercase text-muted">{tt('fuelPrices.detailSwissBest', 'Miglior prezzo Svizzera')}</div>
 <div className="mt-2 text-2xl font-bold text-heading">
 {view.swiss.minPriceChf != null ? formatMoney(view.swiss.minPriceChf, 'CHF', locale) : '—'}
 </div>
 <p className="mt-2 text-xs text-muted">
 {view.swiss.minPriceEur != null ? `${formatMoney(view.swiss.minPriceEur, 'EUR', locale)} ${tt('fuelPrices.eurEquivalent', 'equivalente')}` : '—'}
 </p>
 </div>
 <div className="rounded-2xl border border-edge bg-surface-alt/50 p-4">
 <div className="text-xs font-semibold uppercase text-muted">{tt('fuelPrices.detailSaving50L', 'Risparmio su 50 litri')}</div>
 <div className="mt-2 text-2xl font-bold text-heading">{formatMoney(view.comparison.saving50LEur, 'EUR', locale, 2)}</div>
 <p className="mt-2 text-xs text-muted">{tt('fuelPrices.detailSavingHint', 'Stima teorica basata sul miglior prezzo italiano locale e sulla migliore opzione svizzera vicina.')}</p>
 </div>
 </div>

 <div className="grid gap-4 xl:grid-cols-2">
 <div className="rounded-2xl border border-edge bg-surface-alt/80 p-4">
 <h4 className="text-sm font-bold text-heading">{tt('fuelPrices.detailItalyStations', 'Stazioni italiane rilevate')}</h4>
 <div className="mt-3 space-y-3">
 {view.italy.stations.slice(0, 12).map((station) => {
 const key = `${station.id}-${italyStationPrice(station, fuelType)}-${station.isSelf ? 'self' : 'served'}`;
 const slug = italyCitySlug && italyStationSlugs ? italyStationSlugs.get(station.id) : undefined;
 // Link only to a page the build actually emitted. When the manifest is
 // loaded it is authoritative (no 404s); until then fall back to optimistic.
 const pageEmitted = italyCitySlug && slug
 ? (stationPages ? stationPages.has(`${italyCitySlug}/${slug}`) : true)
 : false;
 const href = pageEmitted && italyCitySlug && slug ? buildFuelItalianStationPath(fuelLocale, fuelType, italyCitySlug, slug) : null;
 const content = (
 <div className="flex items-start justify-between gap-3">
 <div className="flex min-w-0 items-start gap-3">
 <StationBrandLogo brand={station.brand} />
 <div className="min-w-0">
 <div className={`truncate font-semibold ${href ? 'text-link' : 'text-heading'}`}>{station.stationName}</div>
 <div className="mt-1 text-xs text-muted">{station.address}</div>
 {href && (
 <div className="mt-1 inline-flex items-center gap-0.5 text-xs font-semibold text-link">
 {tt('fuelPrices.viewStationDetail', 'Vedi dettaglio stazione')}
 <ChevronRight size={13} aria-hidden="true" />
 </div>
 )}
 </div>
 </div>
 <div className="text-right">
 <div className="font-bold text-heading">{formatMoney(italyStationPrice(station, fuelType), 'EUR', locale)}</div>
 <div className="text-xs text-muted">{station.isSelf ? tt('fuelPrices.self', 'Self') : tt('fuelPrices.served', 'Servito')}</div>
 </div>
 </div>
 );
 return href ? (
 <a key={key} href={href} className="block rounded-2xl border border-edge bg-surface p-3 no-underline text-inherit hover:bg-surface-raised/70">
 {content}
 </a>
 ) : (
 <div key={key} className="rounded-2xl border border-edge bg-surface p-3">
 {content}
 </div>
 );
 })}
 {!view.italy.stations.length && (
 <div className="rounded-2xl border border-dashed border-edge bg-surface px-4 py-6 text-center text-sm text-muted">
 {tt('fuelPrices.noItalyStations', 'Nessuna stazione italiana trovata per questo comune.')}
 </div>
 )}
 </div>
 </div>

 <div className="rounded-2xl border border-edge bg-surface-alt/80 p-4">
 <h4 className="text-sm font-bold text-heading">{tt('fuelPrices.detailSwissStations', 'Migliori opzioni svizzere vicine')}</h4>
 <div className="mt-3 space-y-3">
 {view.swiss.nearbyStations.slice(0, 12).map((station) => {
 const href = swissStationHref(station, fuelType);
 const content = (
 <div className="flex items-start justify-between gap-3">
 <div>
 <div className="font-semibold text-heading">{station.name}</div>
 <div className="mt-1 text-xs text-muted">{station.address}</div>
 </div>
 <div className="text-right">
 <div className="font-bold text-heading">{formatMoney(swissStationPrice(station, fuelType, 'CHF'), 'CHF', locale)}</div>
 <div className="text-xs text-muted">{formatMoney(swissStationPrice(station, fuelType, 'EUR'), 'EUR', locale)}</div>
 <div className="mt-1 text-xs text-muted">
 {typeof station.distanceKm === 'number' ? `${formatNumber(station.distanceKm, locale)} km` : '—'}
 </div>
 </div>
 </div>
 );
 return href ? (
 <a key={station.id} href={href} className="block rounded-2xl border border-edge bg-surface p-3 no-underline text-inherit hover:bg-surface-raised/70">
 {content}
 </a>
 ) : (
 <div key={station.id} className="rounded-2xl border border-edge bg-surface p-3">
 {content}
 </div>
 );
 })}
 {!view.swiss.nearbyStations.length && (
 <div className="rounded-2xl border border-dashed border-edge bg-surface px-4 py-6 text-center text-sm text-muted">
 {tt('fuelPrices.noSwissStations', 'Nessuna stazione svizzera utile nel raggio di confronto.')}
 </div>
 )}
 </div>
 </div>
 </div>
 </div>
 );
}

export default function FuelPriceStats() {
 const { t, locale } = useTranslation();
 const tt = (key: string, fallback: string) => {
 const value = t(key);
 return value === key ? fallback : value;
 };
 const [data, setData] = useState<FuelPricesDataset | null>(null);
 const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
 const [fuelType, setFuelType] = useState<FuelType>(DEFAULT_FUEL_VIEW.fuelType); const [search, setSearch] = useState(DEFAULT_FUEL_VIEW.search); const [province, setProvince] = useState(DEFAULT_FUEL_VIEW.province);
 const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_FUEL_VIEW.sortKey); const [selectedKey, setSelectedKey] = useState<string | null>(DEFAULT_FUEL_VIEW.selectedKey);
 const [homeMunicipalityKey, setHomeMunicipalityKey] = useState(DEFAULT_FUEL_VIEW.homeMunicipalityKey); const [tankLiters, setTankLiters] = useState(DEFAULT_FUEL_VIEW.tankLiters); const [costPerKmEur, setCostPerKmEur] = useState(DEFAULT_FUEL_VIEW.costPerKmEur);
 const [page, setPage] = useState(DEFAULT_FUEL_VIEW.page); const [shareState, setShareState] = useState<'idle' | 'copied' | 'error'>('idle');
 const [urlReady, setUrlReady] = useState(false);
 // Authoritative set of emitted Italian station pages ("{citySlug}/{stationSlug}").
 // Built by the fuel build-plugin; the SPA links a station only when it appears
 // here, so a station card never points at a page the build skipped (word-gate)
 // or wrote under a disambiguated slug → no indexable 404s. null = not loaded
 // yet / fetch failed → optimistic fallback (link if a slug is derivable).
 const [stationPages, setStationPages] = useState<Set<string> | null>(null);

 useEffect(() => {
  const restoreFromUrl = () => { const next = readFuelViewState(); setFuelType(next.fuelType); setSearch(next.search); setProvince(next.province); setSortKey(next.sortKey); setSelectedKey(next.selectedKey); setHomeMunicipalityKey(next.homeMunicipalityKey); setTankLiters(next.tankLiters); setCostPerKmEur(next.costPerKmEur); setPage(next.page); setUrlReady(true); };
 restoreFromUrl(); window.addEventListener('popstate', restoreFromUrl); return () => window.removeEventListener('popstate', restoreFromUrl);
 }, []);
 useEffect(() => { if (!urlReady) return; const nextUrl = fuelViewUrl({ fuelType, search, province, sortKey, selectedKey, homeMunicipalityKey, tankLiters, costPerKmEur, page }); if (nextUrl && nextUrl !== window.location.href) window.history.replaceState(window.history.state, '', nextUrl); }, [costPerKmEur, fuelType, homeMunicipalityKey, page, province, search, selectedKey, sortKey, tankLiters, urlReady]);
 const resetView = () => { setFuelType('benzina'); setSearch(''); setProvince('ALL'); setSortKey('saving'); setSelectedKey(null); setHomeMunicipalityKey(''); setTankLiters(50); setCostPerKmEur(0.18); setPage(1); setShareState('idle'); Analytics.trackUIInteraction('statistiche', 'carburanti', 'reset_view', 'click'); };
 const shareView = async () => { const url = fuelViewUrl({ fuelType, search, province, sortKey, selectedKey, homeMunicipalityKey, tankLiters, costPerKmEur, page }); if (!url || !navigator.clipboard) { setShareState('error'); return; } try { await navigator.clipboard.writeText(url); setShareState('copied'); Analytics.trackUIInteraction('statistiche', 'carburanti', 'share_view', 'click'); } catch { setShareState('error'); } };

 useEffect(() => {
 let cancelled = false;
 setLoading(true);
 setError(null);
 fetchFuelPrices(false)
 .then((result) => {
 if (cancelled) return;
 setData(result);
 Analytics.trackPageView('/statistiche/prezzi-benzina-confine/', 'Prezzi carburanti confine');
 Analytics.trackUIInteraction('statistiche', 'carburanti', 'view_dataset', 'view');
 })
 .catch((err) => {
 if (cancelled) return;
 setError(err instanceof Error ? err.message : String(err));
 })
 .finally(() => {
 if (!cancelled) setLoading(false);
 });
 fetch(cdnDataUrl('/data/fuel-italian-station-pages.json'))
 .then((r) => (r.ok ? r.json() : null))
 .then((j: { stations?: string[] } | null) => {
 if (!cancelled && Array.isArray(j?.stations)) setStationPages(new Set(j!.stations));
 })
 .catch(() => {
 /* best-effort: keep optimistic fallback when the manifest is unavailable */
 });
 return () => {
 cancelled = true;
 };
 }, []);

 const provinces = useMemo(() => {
 const items = new Set<string>();
 for (const item of data?.municipalities || []) items.add(item.province);
 return ['ALL', ...Array.from(items).sort()];
 }, [data]);

 const municipalityOptions = useMemo(() => {
 return (data?.municipalities || [])
 .map((row) => ({
 key: municipalityKey(row),
 label: municipalityLabel(row),
 }))
 .sort((a, b) => a.label.localeCompare(b.label));
 }, [data]);

 const rows = useMemo(() => {
  const q = search.trim().toLowerCase(); const list = (data?.municipalities || []).filter((row) => { if (province !== 'ALL' && row.province !== province) return false; if (!q) return true; return `${row.municipality} ${row.province}`.toLowerCase().includes(q); });
  return [...list].sort((a, b) => { const aView = fuelRowView(a, fuelType); const bView = fuelRowView(b, fuelType); if (sortKey === 'name') return municipalityLabel(a).localeCompare(municipalityLabel(b)); if (sortKey === 'italy') return (aView.italy.minPriceEur ?? 99) - (bView.italy.minPriceEur ?? 99); if (sortKey === 'swiss') return (aView.swiss.minPriceEur ?? 99) - (bView.swiss.minPriceEur ?? 99); if (sortKey === 'delta') return Math.abs(bView.comparison.priceDeltaEur ?? 0) - Math.abs(aView.comparison.priceDeltaEur ?? 0); return (bView.comparison.saving50LEur ?? -1) - (aView.comparison.saving50LEur ?? -1); });
 }, [data, fuelType, province, search, sortKey]);
 const fuelSummary = useMemo(() => {
  const entries = (data?.municipalities || []).map((row) => ({ row, view: fuelRowView(row, fuelType) }));
  const cheapestItaly = entries.filter(({ view }) => view.italy.minPriceEur != null).sort((a, b) => (a.view.italy.minPriceEur ?? Infinity) - (b.view.italy.minPriceEur ?? Infinity))[0] || null;
  const cheapestSwiss = entries.filter(({ view }) => view.swiss.cheapestStation && view.swiss.minPriceChf != null).sort((a, b) => (a.view.swiss.minPriceChf ?? Infinity) - (b.view.swiss.minPriceChf ?? Infinity))[0] || null;
  const bestDeals = entries.filter(({ view }) => view.comparison.saving50LEur != null).sort((a, b) => (b.view.comparison.saving50LEur ?? -1) - (a.view.comparison.saving50LEur ?? -1));
  return { cheaperItalyCount: entries.filter(({ view }) => view.comparison.cheaperCountry === 'IT').length, cheaperSwissCount: entries.filter(({ view }) => view.comparison.cheaperCountry === 'CH').length, cheapestItaly, cheapestSwiss, bestDeals };
 }, [data, fuelType]);
 const selected = useMemo(() => { if (!selectedKey) return null; return rows.find((row) => municipalityKey(row) === selectedKey) || null; }, [rows, selectedKey]);
 const homeMunicipality = useMemo(() => { return (data?.municipalities || []).find((row) => municipalityKey(row) === homeMunicipalityKey) || null; }, [data, homeMunicipalityKey]);
 const personalizedRecommendation = useMemo(() => { if (!homeMunicipality) return null; return buildPersonalizedOption(homeMunicipality, tankLiters, costPerKmEur, fuelType); }, [costPerKmEur, fuelType, homeMunicipality, tankLiters]);
 const pageSize = 24; const pageCount = Math.max(1, Math.ceil(rows.length / pageSize)); const visibleRows = rows.slice((page - 1) * pageSize, page * pageSize); const freshness = data ? datasetFreshness(data) : 'unknown';
 const dataStatus = data?.fetchStatus?.source === 'memory-cache' && data.fetchStatus.lastError ? 'error' : freshness;
 const fuelLabel = fuelType === 'diesel' ? tt('fuelPrices.diesel', 'Diesel') : tt('fuelPrices.benzina', 'Benzina');
 const sourceLabel = data?.fetchStatus?.source === 'memory-cache'
  ? tt('fuelPrices.sourceMemory', 'cache locale')
  : data?.fetchStatus?.source === 'static-json'
    ? tt('fuelPrices.sourceStatic', 'snapshot statico')
    : tt('fuelPrices.sourceFirestore', 'Firestore');
 const dataStatusLabel = dataStatus === 'current'
  ? tt('fuelPrices.statusCurrent', 'Dati correnti')
  : dataStatus === 'stale'
    ? tt('fuelPrices.statusStale', 'Dati non aggiornati')
    : dataStatus === 'error'
      ? tt('fuelPrices.statusError', 'Aggiornamento non riuscito; ultimo dato disponibile')
      : tt('fuelPrices.statusUnknown', 'Stato dati non verificabile');
 const dataStatusClass = dataStatus === 'error' ? 'text-danger' : dataStatus === 'stale' ? 'text-warning' : 'text-muted';
 useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
 if (loading) { return ( <div className="rounded-3xl border border-edge bg-surface/80 p-8 flex items-center justify-center gap-3 text-subtle"> <Loader2 className="animate-spin" size={20} /> <span>{tt('fuelPrices.loading', 'Caricamento prezzi carburanti...')}</span> </div> ); } if (error || !data) { return ( <div className="rounded-3xl border border-danger-border bg-danger-subtle p-6 text-danger"> <h2 className="font-bold font-display text-lg">{tt('fuelPrices.errorTitle', 'Impossibile caricare i dati carburanti')}</h2> <p className="text-sm mt-2">{error || tt('fuelPrices.errorBody', 'Il dataset non è disponibile al momento.')}</p> </div> ); } return ( <div className="space-y-6"> <section className="rounded-[2rem] border border-warning-border bg-gradient-to-br from-warning-subtle via-surface to-accent-subtle p-5 sm:p-8"> <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between"> <div className="max-w-3xl"> <div className="inline-flex items-center gap-2 rounded-full bg-surface/80 px-3 py-1 text-xs font-semibold font-display text-warning ring-1 ring-warning-border"> <Fuel size={14} /> {tt('fuelPrices.badge', 'Osservatorio carburanti')} </div> <h1 className="mt-3 text-3xl font-bold font-display tracking-tight text-heading sm:text-4xl"> {tt('fuelPrices.title', 'Prezzi carburanti Italia-Svizzera')} · {fuelLabel} </h1> <p className="mt-3 max-w-2xl text-sm leading-6 text-subtle sm:text-base"> {fuelType === 'diesel' ? tt('fuelPrices.dieselSubtitle', 'Confronta i prezzi del diesel nei comuni di confine italiani con le stazioni svizzere vicine e scopri dove conviene fare rifornimento oggi.') : tt('fuelPrices.subtitle', 'Confronta i prezzi della benzina nei comuni di confine italiani con le stazioni svizzere vicine e scopri dove conviene fare rifornimento oggi.')} </p> </div> <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"> <div className="rounded-2xl border border-white bg-surface/85 px-4 py-3"> <div className="text-xs font-semibold font-display uppercase tracking-wide text-muted">{tt('fuelPrices.italySnapshot', 'Snapshot Italia')}</div> <div className="mt-1 font-bold font-display text-heading">{formatDate(data.sources.italy.priceSnapshotDate, locale)}</div> </div> <div className="rounded-2xl border border-edge bg-surface/85 px-4 py-3"> <div className="text-xs font-semibold font-display uppercase tracking-wide text-muted">{tt('fuelPrices.exchangeRate', 'Cambio CHF/EUR')}</div> <div className="mt-1 font-bold font-display text-heading">1 CHF = {formatMoney(data.sources.exchangeRate.eurPerChf, 'EUR', locale, 4)}</div> </div> </div> </div> </section> <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle"> <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold font-display text-success">{fuelSummary.cheaperItalyCount}</span> {tt('fuelPrices.cheaperItalyCount', 'Comuni dove conviene IT')}</span> <span className="hidden sm:inline text-edge" aria-hidden="true">·</span> <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold font-display text-link">{fuelSummary.cheaperSwissCount}</span> {tt('fuelPrices.cheaperSwissCount', 'Comuni dove conviene CH')}</span> <span className="hidden sm:inline text-edge" aria-hidden="true">·</span> <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold font-display text-heading">{fuelSummary.cheapestItaly ? `${fuelSummary.cheapestItaly.row.municipality}` : '—'}</span> {tt('fuelPrices.bestItalyToday', 'Miglior prezzo Italia')} {fuelSummary.cheapestItaly ? formatMoney(fuelSummary.cheapestItaly.view.italy.minPriceEur, 'EUR', locale) : ''}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{fuelSummary.cheapestSwiss?.view.swiss.cheapestStation ? fuelSummary.cheapestSwiss.view.swiss.cheapestStation.name : '—'}</span> {tt('fuelPrices.bestSwissToday', 'Miglior prezzo Svizzera')} {fuelSummary.cheapestSwiss?.view.swiss.cheapestStation ? `${formatMoney(fuelSummary.cheapestSwiss.view.swiss.minPriceChf, 'CHF', locale)}` : ''}</span>
 </div>
 <div className="grid gap-3 rounded-2xl border border-edge bg-surface/70 p-4 text-xs text-muted sm:grid-cols-2">
  <div><span className="font-semibold text-body">{tt('fuelPrices.sourceItaly', 'Dati Italia')}</span> · {data.sources.italy.provider} · {fuelLabel} · EUR/L · {formatDate(data.sources.italy.priceSnapshotDate, locale)}</div>
  <div><span className="font-semibold text-body">{tt('fuelPrices.sourceSwitzerland', 'Dati Svizzera')}</span> · {data.sources.switzerland.provider} · {fuelLabel} · CHF/L → EUR/L · {formatDate(data.sources.switzerland.latestObservedUpdate, locale)}</div>
 </div>

 <section className="rounded-[2rem] border border-edge bg-surface p-5 sm:p-6">
 <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
 <div className="max-w-2xl">
 <div className="inline-flex items-center gap-2 rounded-full bg-surface-raised px-3 py-1 text-xs font-semibold text-body">
 <Route size={14} />
 {tt('fuelPrices.personalizedBadge', 'Confronto dal tuo comune')}
 </div>
 <h2 className="mt-3 text-xl font-bold font-display text-heading sm:text-2xl">{tt('fuelPrices.personalizedTitle', 'Dove ti conviene davvero fare rifornimento')} · {fuelLabel}</h2>
 <p className="mt-2 text-sm leading-6 text-muted">
 {tt('fuelPrices.personalizedSubtitle', 'Inserisci il tuo comune censito, quanti litri devi fare e un costo chilometrico stimato: il confronto considera sia il prezzo alla pompa sia la distanza andata e ritorno.')}
 </p>
 </div>

 {selected && (
 <button
 type="button"
 onClick={() => setHomeMunicipalityKey(municipalityKey(selected))}
 className="inline-flex items-center justify-center rounded-2xl border border-edge px-4 py-2 text-sm font-semibold text-body hover:bg-surface-raised"
 >
 {tt('fuelPrices.useSelectedMunicipality', 'Usa il comune aperto nella lista')}
 </button>
 )}
 </div>

 <div className="mt-5 grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
 <label className="sm:col-span-2 xl:col-span-2">
 <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.homeMunicipality', 'Comune dove vivi')}</div>
 <input
 list="fuel-municipalities"
 value={homeMunicipality ? municipalityLabel(homeMunicipality) : homeMunicipalityKey}
 onChange={(e) => {
 const value = e.target.value;
 const match = municipalityOptions.find((option) => option.label === value);
 setHomeMunicipalityKey(match?.key || value);
 }}
 placeholder={tt('fuelPrices.searchHomeMunicipality', 'Es. Como (CO)')}
 aria-label={tt('fuelPrices.homeMunicipality', 'Comune dove vivi')}
 className="w-full rounded-2xl border border-edge bg-surface-alt/50 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:border-warning text-strong"
 />
 <datalist id="fuel-municipalities">
 {municipalityOptions.map((option) => (
 <option key={option.key} value={option.label} />
 ))}
 </datalist>
 </label>

 <label>
 <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.tankLiters', 'Litri da fare')}</div>
 <input
 type="number"
 inputMode="numeric"
 min={10}
 max={120}
 step={5}
 value={tankLiters}
 onChange={(e) => setTankLiters(Math.min(120, Math.max(10, Number(e.target.value) || 50)))}
 aria-label={tt('fuelPrices.tankLiters', 'Litri da fare')}
 className="w-full rounded-2xl border border-edge bg-surface-alt/50 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:border-warning text-strong"
 />
 <span className="text-sm text-muted mt-1 block">10 – 120 L</span>
 </label>

 <label>
 <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.costPerKm', 'Costo auto per km')}</div>
 <input
 type="number"
 inputMode="decimal"
 min={0.05}
 max={1}
 step={0.01}
 value={costPerKmEur}
 onChange={(e) => setCostPerKmEur(Math.min(1, Math.max(0.05, Number(e.target.value) || 0.18)))}
 aria-label={tt('fuelPrices.costPerKm', 'Costo auto per km')}
 className="w-full rounded-2xl border border-edge bg-surface-alt/50 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:border-warning text-strong"
 />
 <span className="text-sm text-muted mt-1 block">0.05 – 1.00 €/km</span>
 </label>
 </div>

 <div className="rounded-3xl border border-edge bg-gradient-to-br from-surface-alt to-surface p-4 sm:p-5">
 {!homeMunicipality || !personalizedRecommendation?.best ? (
 <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-edge px-5 py-10 text-center text-sm text-muted">
 {tt('fuelPrices.personalizedEmpty', 'Seleziona un comune censito per ricevere il consiglio personalizzato su dove conviene fare benzina tenendo conto anche dei chilometri.')}
 </div>
 ) : (
 <div className="space-y-4">
 <div>
 <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.personalizedResult', 'Risultato personalizzato')}</div>
 <h3 className="mt-2 text-xl font-bold font-display text-heading">
 {personalizedRecommendation.best.type === 'IT'
 ? tt('fuelPrices.personalizedItaly', 'Per te conviene fare rifornimento in Italia')
 : tt('fuelPrices.personalizedSwiss', 'Per te conviene fare rifornimento in Svizzera')}
 </h3>
 <p className="mt-1 text-sm text-muted">
 {municipalityLabel(homeMunicipality)} · {tankLiters}L · {formatMoney(costPerKmEur, 'EUR', locale, 2)}/km
 </p>
 </div>

 <div className="rounded-2xl border border-edge bg-surface p-4">
 <div className="flex items-start justify-between gap-3">
 <div>
 <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.bestOption', 'Opzione migliore')}</div>
 <div className="mt-2 text-lg font-bold text-heading">{personalizedRecommendation.best.stationName}</div>
 <div className="mt-1 text-sm text-muted">{personalizedRecommendation.best.stationMeta}</div>
 </div>
 <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${personalizedRecommendation.best.type === 'IT' ? 'border-success-border bg-success-subtle text-success' : 'border-accent-border bg-accent-subtle text-accent'}`}>
 {personalizedRecommendation.best.label}
 </div>
 </div>

 <div className="mt-4 grid gap-3 sm:grid-cols-3">
 <div>
 <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.pumpCost', 'Costo carburante')}</div>
 <div className="mt-1 font-bold text-heading">{formatMoney(personalizedRecommendation.best.litersCostEur, 'EUR', locale, 2)}</div>
 </div>
 <div>
 <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.travelCost', 'Costo spostamento')}</div>
 <div className="mt-1 font-bold text-heading">{formatMoney(personalizedRecommendation.best.travelCostEur, 'EUR', locale, 2)}</div>
 <div className="text-xs text-muted">{formatNumber(personalizedRecommendation.best.travelDistanceKm * 2, locale)} km A/R</div>
 </div>
 <div>
 <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.effectiveTotal', 'Totale stimato')}</div>
 <div className="mt-1 font-bold text-heading">{formatMoney(personalizedRecommendation.best.effectiveTotalEur, 'EUR', locale, 2)}</div>
 </div>
 </div>
 </div>

 <div className="grid gap-3 sm:grid-cols-2">
 {[personalizedRecommendation.italy, personalizedRecommendation.swiss].filter(Boolean).map((option) => (
 <div key={option!.type} className="rounded-2xl border border-edge bg-surface p-4">
 <div className="flex items-start justify-between gap-3">
 <div>
 <div className="font-semibold text-heading">{option!.label}</div>
 <div className="mt-1 text-xs text-muted">{option!.stationName}</div>
 </div>
 <div className="text-sm font-bold text-heading">{formatMoney(option!.effectiveTotalEur, 'EUR', locale, 2)}</div>
 </div>
 <div className="mt-3 space-y-1 text-xs text-muted">
 <div>{tt('fuelPrices.pricePerLiter', 'Prezzo/litro')}: {formatMoney(option!.pricePerLiterEur, 'EUR', locale)}</div>
 <div>{tt('fuelPrices.travelDistance', 'Distanza')}: {formatNumber(option!.travelDistanceKm, locale)} km</div>
 <div>{tt('fuelPrices.travelCost', 'Costo spostamento')}: {formatMoney(option!.travelCostEur, 'EUR', locale, 2)}</div>
 </div>
 </div>
 ))}
 </div>

 {personalizedRecommendation.savingsEur != null && (
 <div className="rounded-2xl border border-warning-border bg-warning-subtle px-4 py-3 text-xs font-semibold text-warning">
 {tt('fuelPrices.personalizedSavingPrefix', 'Risparmio stimato rispetto all alternativa')}: {formatMoney(personalizedRecommendation.savingsEur, 'EUR', locale, 2)}
 </div>
 )}
 </div>
 )}
 </div>
 </div>
 </section>

 <section className="grid gap-6 xl:grid-cols-[1.4fr,0.9fr]">
 <div className="rounded-[2rem] border border-edge bg-surface p-5 sm:p-6">
 <div className="flex flex-col gap-4">
 <div className="flex flex-col gap-2">
 <h2 className="text-lg font-bold font-display text-heading sm:text-xl">{tt('fuelPrices.compareByMunicipality', 'Confronto per comune')}</h2>
 <p className="text-xs text-muted">{tt('fuelPrices.compareHint', 'Tocca un comune per aprire subito sotto il dettaglio completo, anche da mobile.')}</p>
 </div>

 <div className="grid gap-3 lg:grid-cols-[1fr,auto,auto,auto]">
 <select value={fuelType} onChange={(e) => { const nextFuel = e.target.value as FuelType; setFuelType(nextFuel); setPage(1); Analytics.trackUIInteraction('statistiche', 'carburanti', 'select_fuel', 'change', nextFuel); }} aria-label={tt('fuelPrices.selectFuel', 'Tipo di carburante')} className="rounded-2xl border border-edge bg-surface-alt/50 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:border-warning text-strong">
 <option value="benzina">{tt('fuelPrices.benzina', 'Benzina')} · EUR/L</option>
 <option value="diesel">{tt('fuelPrices.diesel', 'Diesel')} · EUR/L</option>
 </select>
 <label className="relative">
 <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
 <input
 value={search}
 onChange={(e) => { setSearch(e.target.value); setPage(1); }}
 placeholder={tt('fuelPrices.searchPlaceholder', 'Cerca comune o provincia')}
 aria-label={tt('fuelPrices.searchPlaceholder', 'Cerca comune o provincia')}
 className="w-full rounded-2xl border border-edge bg-surface-alt/50 py-3 pl-10 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:border-warning text-strong"
 />
 </label>
 <select
 value={province}
 onChange={(e) => { setProvince(e.target.value); setPage(1); Analytics.trackUIInteraction('statistiche', 'carburanti', 'filter_province', 'change', e.target.value); }}
 aria-label={tt('fuelPrices.selectProvince', 'Seleziona provincia')}
 className="rounded-2xl border border-edge bg-surface-alt/50 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:border-warning text-strong"
 >
 {provinces.map((item) => (
 <option key={item} value={item}>
 {item === 'ALL' ? tt('fuelPrices.allProvinces', 'Tutte le province') : item}
 </option>
 ))}
 </select>
 <select
 value={sortKey}
 onChange={(e) => { setSortKey(e.target.value as SortKey); setPage(1); Analytics.trackUIInteraction('statistiche', 'carburanti', 'sort_results', 'change', e.target.value); }}
 aria-label={tt('fuelPrices.sortBy', 'Ordina per')}
 className="rounded-2xl border border-edge bg-surface-alt/50 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:border-warning text-strong"
 >
 <option value="saving">{tt('fuelPrices.sortSaving', 'Ordina per risparmio')}</option>
 <option value="delta">{tt('fuelPrices.sortDelta', 'Ordina per delta')}</option>
 <option value="italy">{tt('fuelPrices.sortItaly', 'Ordina per prezzo IT')}</option>
 <option value="swiss">{tt('fuelPrices.sortSwiss', 'Ordina per prezzo CH')}</option>
 <option value="name">{tt('fuelPrices.sortName', 'Ordina per nome')}</option>
 </select>
 </div>
 <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4">
  <div className={`text-xs ${dataStatusClass}`} role="status" aria-live="polite">{dataStatusLabel} · {sourceLabel} · {tt('fuelPrices.sourceItaly', 'Italia')} {formatDate(data.sources.italy.priceSnapshotDate, locale)} · {tt('fuelPrices.sourceSwitzerland', 'Svizzera')} {formatDate(data.sources.switzerland.latestObservedUpdate, locale)}</div>
  <div className="flex flex-wrap gap-2">
   <button type="button" onClick={shareView} className="rounded-full border border-edge px-3 py-2 text-xs font-semibold text-body hover:bg-surface-raised">{shareState === 'copied' ? tt('fuelPrices.shareCopied', 'Link copiato') : shareState === 'error' ? tt('fuelPrices.shareError', 'Copia non disponibile') : tt('fuelPrices.shareView', 'Condividi vista')}</button>
   <button type="button" onClick={resetView} className="rounded-full border border-edge px-3 py-2 text-xs font-semibold text-body hover:bg-surface-raised">{tt('fuelPrices.resetView', 'Azzera filtri')}</button>
  </div>
 </div>
 </div>

 <div className="mt-5 space-y-3">
 {visibleRows.map((row) => {
 const view = fuelRowView(row, fuelType);
 const isSelected = municipalityKey(row) === selectedKey;
 return (
 <div key={municipalityKey(row)} className="rounded-[1.5rem] border border-edge bg-surface-alt/70">
 <button
 type="button"
 onClick={() => {
 const nextKey = municipalityKey(row);
 setSelectedKey((current) => current === nextKey ? null : nextKey);
 Analytics.trackUIInteraction('statistiche', 'carburanti', 'select_municipality', 'click', `${row.municipality}-${row.province}`);
 }}
 className="w-full rounded-[1.5rem] px-4 py-4 text-left transition hover:bg-surface-raised/70 sm:px-5"
 aria-expanded={isSelected}
 >
 <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
 <div className="min-w-0">
 <div className="flex items-center gap-2">
 <div className="text-base font-bold text-heading">{municipalityLabel(row)}</div>
 <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${recommendationToneForCode(fuelRowView(row, fuelType).comparison.cheaperCountry)}`}>
 {tt(`fuelPrices.recommendation.${view.comparison.cheaperCountry.toLowerCase()}`, recommendationLabel(view.comparison.cheaperCountry))}
 </span>
 </div>
 <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
 <span>{formatNumber(row.distanceKm, locale)} km {tt('fuelPrices.fromBorder', 'dal confine')}</span>
 <span>•</span>
 <span>{view.italy.stationCount} {tt('fuelPrices.italyStationsShort', 'stazioni IT')}</span>
 <span>•</span>
 <span>{view.swiss.optionCount} {tt('fuelPrices.swissStationsShort', 'opzioni CH')}</span>
 </div>
 </div>

 <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[520px]">
 <div>
 <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.tableItaly', 'Italia')}</div>
 <div className="mt-1 font-bold text-heading">{formatMoney(view.italy.minPriceEur, 'EUR', locale)}</div>
 </div>
 <div>
 <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.tableSwiss', 'Svizzera')}</div>
 <div className="mt-1 font-bold text-heading">
 {view.swiss.minPriceChf != null ? formatMoney(view.swiss.minPriceChf, 'CHF', locale) : '—'}
 </div>
 <div className="text-xs text-muted">
 {view.swiss.minPriceEur != null ? formatMoney(view.swiss.minPriceEur, 'EUR', locale) : '—'}
 </div>
 </div>
 <div>
 <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt('fuelPrices.tableSaving', 'Risparmio 50L')}</div>
 <div className="mt-1 font-bold text-heading">{formatMoney(view.comparison.saving50LEur, 'EUR', locale, 2)}</div>
 </div>
 <div className="flex items-center justify-end lg:justify-start">
 <span className="inline-flex items-center gap-2 text-sm font-semibold text-body">
 {isSelected ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
 {isSelected ? tt('fuelPrices.hideDetails', 'Nascondi') : tt('fuelPrices.showDetails', 'Apri dettaglio')}
 </span>
 </div>
 </div>
 </div>
 </button>

 {isSelected && (
 <div className="border-t border-edge px-3 pb-3 sm:px-4 sm:pb-4">
 <DetailSection row={row} locale={locale} tt={tt} stationPages={stationPages} fuelType={fuelType} />
 </div>
 )}
 </div>
 );
 })}

 {rows.length > 0 && (
 <div className="flex items-center justify-between gap-3 border-t border-edge pt-4 text-sm">
  <span className="text-muted">{tt('fuelPrices.page', 'Pagina')} {page} {tt('fuelPrices.of', 'di')} {pageCount} · {rows.length} {tt('fuelPrices.municipalities', 'comuni')}</span>
  <div className="flex gap-2">
   <button type="button" disabled={page <= 1} onClick={() => { setPage((current) => Math.max(1, current - 1)); Analytics.trackUIInteraction('statistiche', 'carburanti', 'paginate_results', 'click', 'previous'); }} className="rounded-full border border-edge px-3 py-2 font-semibold text-body disabled:cursor-not-allowed disabled:opacity-40">{tt('fuelPrices.previous', 'Precedente')}</button>
   <button type="button" disabled={page >= pageCount} onClick={() => { setPage((current) => Math.min(pageCount, current + 1)); Analytics.trackUIInteraction('statistiche', 'carburanti', 'paginate_results', 'click', 'next'); }} className="rounded-full border border-edge px-3 py-2 font-semibold text-body disabled:cursor-not-allowed disabled:opacity-40">{tt('fuelPrices.next', 'Successiva')}</button>
  </div>
 </div>
 )}

 {!rows.length && (
 <div className="rounded-3xl border border-dashed border-edge bg-surface-alt/50 px-5 py-10 text-center text-sm text-muted">
 {tt('fuelPrices.noMatches', 'Nessun comune trovato con i filtri attuali.')}
 </div>
 )}
 </div>
 </div>

 <div className="space-y-6">
 <div className="rounded-[2rem] border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading">{tt('fuelPrices.bestDeals', 'Dove si risparmia di piu')}</h2>
 <div className="mt-4 space-y-3">
 {fuelSummary.bestDeals.slice(0, 6).map(({ row, view }) => (
 <div key={`${row.municipality}-${row.province}`} className="rounded-2xl border border-edge/50 bg-surface-alt/50 px-4 py-3">
 <div className="flex items-start justify-between gap-3">
 <div>
 <div className="font-semibold text-heading">{row.municipality} ({row.province})</div>
 <div className="mt-1 text-xs text-muted">
 {view.comparison.cheaperCountry === 'IT'
 ? tt('fuelPrices.bestDealItaly', 'Meglio fare il pieno in Italia')
 : view.comparison.cheaperCountry === 'CH'
 ? tt('fuelPrices.bestDealSwiss', 'Meglio fare il pieno in Svizzera')
 : tt('fuelPrices.bestDealTie', 'Prezzo quasi uguale')}
 </div>
 </div>
 <div className="text-right">
 <div className="text-sm font-bold text-heading">{formatMoney(view.comparison.saving50LEur, 'EUR', locale, 2)}</div>
 <div className="text-xs text-muted">50L</div>
 </div>
 </div>
 </div>
 ))}
 </div>
 </div>

 <div className="rounded-[2rem] border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading">{tt('fuelPrices.sourceNotes', 'Fonti e metodo')}</h2>
 <ul className="mt-4 space-y-3 text-sm text-subtle">
 <li>{tt('fuelPrices.noteItaly', 'Italia: dati ufficiali MIMIT del file prezzi alle 8 e anagrafica impianti attivi.')}</li>
 <li>{tt('fuelPrices.noteSwiss', 'Svizzera: dati SP95 ricavati dal feed pubblico TCS delle stazioni nell area di frontiera.')}</li>
 <li>{tt('fuelPrices.noteExchange', 'Il confronto IT-CH converte i prezzi svizzeri in EUR usando il tasso ECB del giorno del dataset.')}</li>
 <li>{tt('fuelPrices.noteDistance', 'Nel consiglio personalizzato il totale include un costo chilometrico andata e ritorno impostato da te.')}</li>
 </ul>
 <div className="mt-4 flex flex-wrap gap-3">
 <a href={data.sources.italy.pricesUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-edge px-3 py-2 text-xs font-semibold text-body hover:bg-surface-raised no-underline">
 {tt('fuelPrices.sourceItalyLink', 'Fonte Italia')}
 <ExternalLink size={14} />
 </a>
 <a href={data.sources.switzerland.providerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-edge px-3 py-2 text-xs font-semibold text-body hover:bg-surface-raised no-underline">
 {tt('fuelPrices.sourceSwissLink', 'Fonte Svizzera')}
 <ExternalLink size={14} />
 </a>
 </div>
 </div>
 </div>
 </section>
 </div>
 );
}
