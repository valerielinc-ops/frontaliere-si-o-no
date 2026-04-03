import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Fuel, Loader2, MapPin, Route, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { fetchFuelPrices, type FuelPricesDataset, type FuelStationItaly, type FuelStationSwitzerland, type MunicipalityFuelRow } from '@/services/fuelPricesService';

type SortKey = 'saving' | 'delta' | 'italy' | 'swiss' | 'name';

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

function recommendationTone(row: MunicipalityFuelRow) {
  if (row.comparison.cheaperCountry === 'IT') return 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/40 border-emerald-200 dark:border-emerald-700';
  if (row.comparison.cheaperCountry === 'CH') return 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/40 border-blue-200 dark:border-blue-700';
  if (row.comparison.cheaperCountry === 'SAME') return 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/40 border-amber-200 dark:border-amber-700';
  return 'text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700';
}

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

function municipalityKey(row: MunicipalityFuelRow) {
  return `${row.municipality}|${row.province}`;
}

function municipalityLabel(row: MunicipalityFuelRow) {
  return `${row.municipality} (${row.province})`;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

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
): { italy: PersonalizedOption | null; swiss: PersonalizedOption | null; best: PersonalizedOption | null; savingsEur: number | null } {
  const italy = row.italy.stations.reduce<PersonalizedOption | null>((best, station) => {
    const travelDistanceKm = getItalyStationDistanceKm(row, station);
    const litersCostEur = station.priceEur * liters;
    const travelCostEur = roundTripTravelCost(travelDistanceKm, costPerKmEur);
    const effectiveTotalEur = litersCostEur + travelCostEur;
    const current: PersonalizedOption = {
      type: 'IT',
      label: 'Italia',
      stationName: station.stationName,
      stationMeta: `${station.brand || 'Pompa'} · ${station.address}`,
      pricePerLiterEur: station.priceEur,
      litersCostEur,
      travelDistanceKm,
      travelCostEur,
      effectiveTotalEur,
    };
    if (!best || current.effectiveTotalEur < best.effectiveTotalEur) return current;
    return best;
  }, null);

  const swiss = row.swiss.nearbyStations.reduce<PersonalizedOption | null>((best, station) => {
    const travelDistanceKm = getSwissStationDistanceKm(row, station);
    const litersCostEur = station.sp95PriceEur * liters;
    const travelCostEur = roundTripTravelCost(travelDistanceKm, costPerKmEur);
    const effectiveTotalEur = litersCostEur + travelCostEur;
    const current: PersonalizedOption = {
      type: 'CH',
      label: 'Svizzera',
      stationName: station.name,
      stationMeta: `${station.brand || 'Pompa'} · ${station.address}`,
      pricePerLiterEur: station.sp95PriceEur,
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
}: {
  row: MunicipalityFuelRow;
  locale: string;
  tt: (key: string, fallback: string) => string;
}) {
  return (
    <div className="mt-4 space-y-4 rounded-[1.75rem] border border-slate-200 dark:border-slate-700 bg-white/90 dark:bg-slate-800/90 p-4 sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <MapPin size={14} />
            {municipalityLabel(row)}
          </div>
          <h3 className="mt-2 text-xl font-bold text-slate-900 dark:text-slate-100">{tt('fuelPrices.detailTitle', 'Dettaglio comune')}</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {tt('fuelPrices.detailSubtitle', 'Qui trovi tutte le stazioni italiane rilevate e le migliori alternative svizzere nel raggio di confronto.')}
          </p>
        </div>
        <div className={`inline-flex items-center rounded-2xl border px-4 py-3 text-sm font-semibold ${recommendationTone(row)}`}>
          {row.comparison.cheaperCountry === 'IT' ? <TrendingDown size={18} /> : <TrendingUp size={18} />}
          <span className="ml-2">
            {tt(`fuelPrices.recommendationLong.${row.comparison.cheaperCountry.toLowerCase()}`, recommendationLabel(row.comparison.cheaperCountry))}
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
          <div className="text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">{tt('fuelPrices.detailItalyBest', 'Miglior prezzo Italia')}</div>
          <div className="mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">{formatMoney(row.italy.minPriceEur, 'EUR', locale)}</div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{row.italy.cheapestStation?.stationName || '—'}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
          <div className="text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">{tt('fuelPrices.detailSwissBest', 'Miglior prezzo Svizzera')}</div>
          <div className="mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">
            {row.swiss.minPriceChf != null ? formatMoney(row.swiss.minPriceChf, 'CHF', locale) : '—'}
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {row.swiss.minPriceEur != null ? `${formatMoney(row.swiss.minPriceEur, 'EUR', locale)} ${tt('fuelPrices.eurEquivalent', 'equivalente')}` : '—'}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
          <div className="text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">{tt('fuelPrices.detailSaving50L', 'Risparmio su 50 litri')}</div>
          <div className="mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">{formatMoney(row.comparison.saving50LEur, 'EUR', locale, 2)}</div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{tt('fuelPrices.detailSavingHint', 'Stima teorica basata sul miglior prezzo italiano locale e sulla migliore opzione svizzera vicina.')}</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/50 p-4">
          <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">{tt('fuelPrices.detailItalyStations', 'Stazioni italiane rilevate')}</h4>
          <div className="mt-3 space-y-3">
            {row.italy.stations.slice(0, 12).map((station) => (
              <div key={`${station.id}-${station.priceEur}-${station.isSelf ? 'self' : 'served'}`} className="rounded-2xl border border-white dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">{station.stationName}</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{station.address}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-slate-900 dark:text-slate-100">{formatMoney(station.priceEur, 'EUR', locale)}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{station.isSelf ? tt('fuelPrices.self', 'Self') : tt('fuelPrices.served', 'Servito')}</div>
                  </div>
                </div>
              </div>
            ))}
            {!row.italy.stations.length && (
              <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                {tt('fuelPrices.noItalyStations', 'Nessuna stazione italiana trovata per questo comune.')}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/50 p-4">
          <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">{tt('fuelPrices.detailSwissStations', 'Migliori opzioni svizzere vicine')}</h4>
          <div className="mt-3 space-y-3">
            {row.swiss.nearbyStations.slice(0, 12).map((station) => (
              <div key={station.id} className="rounded-2xl border border-white dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">{station.name}</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{station.address}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-slate-900 dark:text-slate-100">{formatMoney(station.sp95PriceChf, 'CHF', locale)}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{formatMoney(station.sp95PriceEur, 'EUR', locale)}</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {typeof station.distanceKm === 'number' ? `${formatNumber(station.distanceKm, locale)} km` : '—'}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {!row.swiss.nearbyStations.length && (
              <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [province, setProvince] = useState('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('saving');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [homeMunicipalityKey, setHomeMunicipalityKey] = useState('');
  const [tankLiters, setTankLiters] = useState(50);
  const [costPerKmEur, setCostPerKmEur] = useState(0.18);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFuelPrices(false)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        Analytics.trackPageView('/statistiche/prezzi-benzina-confine', 'Prezzi carburanti confine');
        Analytics.trackUIInteraction('statistiche', 'carburanti', 'view_dataset', 'view');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
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
    const q = search.trim().toLowerCase();
    const list = (data?.municipalities || []).filter((row) => {
      if (province !== 'ALL' && row.province !== province) return false;
      if (!q) return true;
      return `${row.municipality} ${row.province}`.toLowerCase().includes(q);
    });

    return [...list].sort((a, b) => {
      if (sortKey === 'name') return municipalityLabel(a).localeCompare(municipalityLabel(b));
      if (sortKey === 'italy') return (a.italy.minPriceEur ?? 99) - (b.italy.minPriceEur ?? 99);
      if (sortKey === 'swiss') return (a.swiss.minPriceEur ?? 99) - (b.swiss.minPriceEur ?? 99);
      if (sortKey === 'delta') return Math.abs(b.comparison.priceDeltaEur ?? 0) - Math.abs(a.comparison.priceDeltaEur ?? 0);
      return (b.comparison.saving50LEur ?? -1) - (a.comparison.saving50LEur ?? -1);
    });
  }, [data, province, search, sortKey]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return rows.find((row) => municipalityKey(row) === selectedKey) || null;
  }, [rows, selectedKey]);

  const homeMunicipality = useMemo(() => {
    return (data?.municipalities || []).find((row) => municipalityKey(row) === homeMunicipalityKey) || null;
  }, [data, homeMunicipalityKey]);

  const personalizedRecommendation = useMemo(() => {
    if (!homeMunicipality) return null;
    return buildPersonalizedOption(homeMunicipality, tankLiters, costPerKmEur);
  }, [costPerKmEur, homeMunicipality, tankLiters]);

  if (loading) {
    return (
      <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 p-8 flex items-center justify-center gap-3 text-slate-600 dark:text-slate-300">
        <Loader2 className="animate-spin" size={20} />
        <span>{tt('fuelPrices.loading', 'Caricamento prezzi carburanti...')}</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-3xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-6 text-red-800 dark:text-red-300">
        <h2 className="font-bold text-lg">{tt('fuelPrices.errorTitle', 'Impossibile caricare i dati carburanti')}</h2>
        <p className="text-sm mt-2">{error || tt('fuelPrices.errorBody', 'Il dataset non e disponibile al momento.')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-orange-200/70 dark:border-orange-800/40 bg-gradient-to-br from-orange-50 via-white to-blue-50 dark:from-orange-950/40 dark:via-slate-900 dark:to-blue-950/40 p-5 sm:p-8">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/80 dark:bg-slate-800/80 px-3 py-1 text-xs font-semibold text-orange-700 dark:text-orange-300 ring-1 ring-orange-200 dark:ring-orange-700">
              <Fuel size={14} />
              {tt('fuelPrices.badge', 'Osservatorio carburanti')}
            </div>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-4xl">
              {tt('fuelPrices.title', 'Prezzi carburanti Italia-Svizzera')}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300 sm:text-base">
              {tt('fuelPrices.subtitle', 'Confronta i prezzi della benzina nei comuni di confine italiani con le stazioni svizzere vicine e scopri dove conviene fare rifornimento oggi.')}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white dark:border-slate-700 bg-white/85 dark:bg-slate-800/85 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.italySnapshot', 'Snapshot Italia')}</div>
              <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">{formatDate(data.sources.italy.priceSnapshotDate, locale)}</div>
            </div>
            <div className="rounded-2xl border border-white dark:border-slate-700 bg-white/85 dark:bg-slate-800/85 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.exchangeRate', 'Cambio CHF/EUR')}</div>
              <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">1 CHF = {formatMoney(data.sources.exchangeRate.eurPerChf, 'EUR', locale, 4)}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800 p-5">
          <div className="text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">{tt('fuelPrices.cheaperItalyCount', 'Comuni dove conviene IT')}</div>
          <div className="mt-2 text-3xl font-bold text-emerald-600 dark:text-emerald-400">{data.summary.cheaperItalyCount}</div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{tt('fuelPrices.cheaperItalyHint', 'Confronti in cui il prezzo italiano e piu basso del migliore prezzo svizzero vicino.')}</p>
        </div>
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800 p-5">
          <div className="text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">{tt('fuelPrices.cheaperSwissCount', 'Comuni dove conviene CH')}</div>
          <div className="mt-2 text-3xl font-bold text-blue-600 dark:text-blue-400">{data.summary.cheaperSwissCount}</div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{tt('fuelPrices.cheaperSwissHint', 'Confronti in cui la stazione svizzera piu conveniente batte il miglior prezzo locale italiano.')}</p>
        </div>
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800 p-5">
          <div className="text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">{tt('fuelPrices.bestItalyToday', 'Miglior prezzo Italia')}</div>
          <div className="mt-2 text-xl font-bold text-slate-900 dark:text-slate-100">
            {data.summary.cheapestItalyMunicipality
              ? `${data.summary.cheapestItalyMunicipality.municipality} (${data.summary.cheapestItalyMunicipality.province})`
              : '—'}
          </div>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {data.summary.cheapestItalyMunicipality ? formatMoney(data.summary.cheapestItalyMunicipality.minPriceEur, 'EUR', locale) : '—'}
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800 p-5">
          <div className="text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">{tt('fuelPrices.bestSwissToday', 'Miglior prezzo Svizzera')}</div>
          <div className="mt-2 text-xl font-bold text-slate-900 dark:text-slate-100">
            {data.summary.cheapestSwissStation ? data.summary.cheapestSwissStation.name : '—'}
          </div>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {data.summary.cheapestSwissStation ? `${formatMoney(data.summary.cheapestSwissStation.sp95PriceChf, 'CHF', locale)} / ${formatMoney(data.summary.cheapestSwissStation.sp95PriceEur, 'EUR', locale)}` : '—'}
          </p>
        </div>
      </section>

      <section className="rounded-[2rem] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 sm:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 dark:bg-slate-700 px-3 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200">
              <Route size={14} />
              {tt('fuelPrices.personalizedBadge', 'Confronto dal tuo comune')}
            </div>
            <h2 className="mt-3 text-xl font-bold text-slate-900 dark:text-slate-100 sm:text-2xl">{tt('fuelPrices.personalizedTitle', 'Dove ti conviene davvero fare benzina')}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
              {tt('fuelPrices.personalizedSubtitle', 'Inserisci il tuo comune censito, quanti litri devi fare e un costo chilometrico stimato: il confronto considera sia il prezzo alla pompa sia la distanza andata e ritorno.')}
            </p>
          </div>

          {selected && (
            <button
              type="button"
              onClick={() => setHomeMunicipalityKey(municipalityKey(selected))}
              className="inline-flex items-center justify-center rounded-2xl border border-slate-200 dark:border-slate-700 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              {tt('fuelPrices.useSelectedMunicipality', 'Usa il comune aperto nella lista')}
            </button>
          )}
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label className="sm:col-span-2 xl:col-span-2">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.homeMunicipality', 'Comune dove vivi')}</div>
              <input
                list="fuel-municipalities"
                value={homeMunicipality ? municipalityLabel(homeMunicipality) : homeMunicipalityKey}
                onChange={(e) => {
                  const value = e.target.value;
                  const match = municipalityOptions.find((option) => option.label === value);
                  setHomeMunicipalityKey(match?.key || value);
                }}
                placeholder={tt('fuelPrices.searchHomeMunicipality', 'Es. Como (CO)')}
                className="w-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 dark:text-slate-200"
              />
              <datalist id="fuel-municipalities">
                {municipalityOptions.map((option) => (
                  <option key={option.key} value={option.label} />
                ))}
              </datalist>
            </label>

            <label>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.tankLiters', 'Litri da fare')}</div>
              <input
                type="number"
                min={10}
                max={120}
                step={5}
                value={tankLiters}
                onChange={(e) => setTankLiters(Math.min(120, Math.max(10, Number(e.target.value) || 50)))}
                className="w-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 dark:text-slate-200"
              />
              <span className="text-xs text-slate-500 dark:text-slate-400 mt-1 block">10 – 120 L</span>
            </label>

            <label>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.costPerKm', 'Costo auto per km')}</div>
              <input
                type="number"
                min={0.05}
                max={1}
                step={0.01}
                value={costPerKmEur}
                onChange={(e) => setCostPerKmEur(Math.min(1, Math.max(0.05, Number(e.target.value) || 0.18)))}
                className="w-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 dark:text-slate-200"
              />
              <span className="text-xs text-slate-500 dark:text-slate-400 mt-1 block">0.05 – 1.00 €/km</span>
            </label>
          </div>

          <div className="rounded-3xl border border-slate-200 dark:border-slate-700 bg-gradient-to-br from-slate-50 to-white dark:from-slate-800 dark:to-slate-900 p-4 sm:p-5">
            {!homeMunicipality || !personalizedRecommendation?.best ? (
              <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-300 dark:border-slate-600 px-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                {tt('fuelPrices.personalizedEmpty', 'Seleziona un comune censito per ricevere il consiglio personalizzato su dove conviene fare benzina tenendo conto anche dei chilometri.')}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.personalizedResult', 'Risultato personalizzato')}</div>
                  <h3 className="mt-2 text-xl font-bold text-slate-900 dark:text-slate-100">
                    {personalizedRecommendation.best.type === 'IT'
                      ? tt('fuelPrices.personalizedItaly', 'Per te conviene fare benzina in Italia')
                      : tt('fuelPrices.personalizedSwiss', 'Per te conviene fare benzina in Svizzera')}
                  </h3>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {municipalityLabel(homeMunicipality)} · {tankLiters}L · {formatMoney(costPerKmEur, 'EUR', locale, 2)}/km
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.bestOption', 'Opzione migliore')}</div>
                      <div className="mt-2 text-lg font-bold text-slate-900 dark:text-slate-100">{personalizedRecommendation.best.stationName}</div>
                      <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{personalizedRecommendation.best.stationMeta}</div>
                    </div>
                    <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${personalizedRecommendation.best.type === 'IT' ? 'border-emerald-200 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' : 'border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'}`}>
                      {personalizedRecommendation.best.label}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.pumpCost', 'Costo carburante')}</div>
                      <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">{formatMoney(personalizedRecommendation.best.litersCostEur, 'EUR', locale, 2)}</div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.travelCost', 'Costo spostamento')}</div>
                      <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">{formatMoney(personalizedRecommendation.best.travelCostEur, 'EUR', locale, 2)}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{formatNumber(personalizedRecommendation.best.travelDistanceKm * 2, locale)} km A/R</div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.effectiveTotal', 'Totale stimato')}</div>
                      <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">{formatMoney(personalizedRecommendation.best.effectiveTotalEur, 'EUR', locale, 2)}</div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {[personalizedRecommendation.italy, personalizedRecommendation.swiss].filter(Boolean).map((option) => (
                    <div key={option!.type} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold text-slate-900 dark:text-slate-100">{option!.label}</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{option!.stationName}</div>
                        </div>
                        <div className="text-sm font-bold text-slate-900 dark:text-slate-100">{formatMoney(option!.effectiveTotalEur, 'EUR', locale, 2)}</div>
                      </div>
                      <div className="mt-3 space-y-1 text-xs text-slate-500 dark:text-slate-400">
                        <div>{tt('fuelPrices.pricePerLiter', 'Prezzo/litro')}: {formatMoney(option!.pricePerLiterEur, 'EUR', locale)}</div>
                        <div>{tt('fuelPrices.travelDistance', 'Distanza')}: {formatNumber(option!.travelDistanceKm, locale)} km</div>
                        <div>{tt('fuelPrices.travelCost', 'Costo spostamento')}: {formatMoney(option!.travelCostEur, 'EUR', locale, 2)}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {personalizedRecommendation.savingsEur != null && (
                  <div className="rounded-2xl border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/30 px-4 py-3 text-sm font-semibold text-orange-800 dark:text-orange-300">
                    {tt('fuelPrices.personalizedSavingPrefix', 'Risparmio stimato rispetto all alternativa')}: {formatMoney(personalizedRecommendation.savingsEur, 'EUR', locale, 2)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.4fr,0.9fr]">
        <div className="rounded-[2rem] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 sm:p-6">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 sm:text-xl">{tt('fuelPrices.compareByMunicipality', 'Confronto per comune')}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">{tt('fuelPrices.compareHint', 'Tocca un comune per aprire subito sotto il dettaglio completo, anche da mobile.')}</p>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr,auto,auto]">
              <label className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={tt('fuelPrices.searchPlaceholder', 'Cerca comune o provincia')}
                  className="w-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 py-3 pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 dark:text-slate-200"
                />
              </label>
              <select
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                aria-label={tt('fuelPrices.selectProvince', 'Seleziona provincia')}
                className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 dark:text-slate-200"
              >
                {provinces.map((item) => (
                  <option key={item} value={item}>
                    {item === 'ALL' ? tt('fuelPrices.allProvinces', 'Tutte le province') : item}
                  </option>
                ))}
              </select>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                aria-label={tt('fuelPrices.sortBy', 'Ordina per')}
                className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 dark:text-slate-200"
              >
                <option value="saving">{tt('fuelPrices.sortSaving', 'Ordina per risparmio')}</option>
                <option value="delta">{tt('fuelPrices.sortDelta', 'Ordina per delta')}</option>
                <option value="italy">{tt('fuelPrices.sortItaly', 'Ordina per prezzo IT')}</option>
                <option value="swiss">{tt('fuelPrices.sortSwiss', 'Ordina per prezzo CH')}</option>
                <option value="name">{tt('fuelPrices.sortName', 'Ordina per nome')}</option>
              </select>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {rows.slice(0, 120).map((row) => {
              const isSelected = municipalityKey(row) === municipalityKey(selected || row) && municipalityKey(row) === selectedKey;
              return (
                <div key={municipalityKey(row)} className="rounded-[1.5rem] border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/50">
                  <button
                    type="button"
                    onClick={() => {
                      const nextKey = municipalityKey(row);
                      setSelectedKey((current) => current === nextKey ? null : nextKey);
                      Analytics.trackUIInteraction('statistiche', 'carburanti', 'select_municipality', 'click', `${row.municipality}-${row.province}`);
                    }}
                    className="w-full rounded-[1.5rem] px-4 py-4 text-left transition hover:bg-slate-100/70 dark:hover:bg-slate-800/70 sm:px-5"
                    aria-expanded={isSelected}
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="text-base font-bold text-slate-900 dark:text-slate-100">{municipalityLabel(row)}</div>
                          <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${recommendationTone(row)}`}>
                            {tt(`fuelPrices.recommendation.${row.comparison.cheaperCountry.toLowerCase()}`, recommendationLabel(row.comparison.cheaperCountry))}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span>{formatNumber(row.distanceKm, locale)} km {tt('fuelPrices.fromBorder', 'dal confine')}</span>
                          <span>•</span>
                          <span>{row.italy.stationCount} {tt('fuelPrices.italyStationsShort', 'stazioni IT')}</span>
                          <span>•</span>
                          <span>{row.swiss.optionCount} {tt('fuelPrices.swissStationsShort', 'opzioni CH')}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[520px]">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.tableItaly', 'Italia')}</div>
                          <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">{formatMoney(row.italy.minPriceEur, 'EUR', locale)}</div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.tableSwiss', 'Svizzera')}</div>
                          <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">
                            {row.swiss.minPriceChf != null ? formatMoney(row.swiss.minPriceChf, 'CHF', locale) : '—'}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {row.swiss.minPriceEur != null ? formatMoney(row.swiss.minPriceEur, 'EUR', locale) : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{tt('fuelPrices.tableSaving', 'Risparmio 50L')}</div>
                          <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">{formatMoney(row.comparison.saving50LEur, 'EUR', locale, 2)}</div>
                        </div>
                        <div className="flex items-center justify-end lg:justify-start">
                          <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                            {isSelected ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                            {isSelected ? tt('fuelPrices.hideDetails', 'Nascondi') : tt('fuelPrices.showDetails', 'Apri dettaglio')}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>

                  {isSelected && (
                    <div className="border-t border-slate-200 dark:border-slate-700 px-3 pb-3 sm:px-4 sm:pb-4">
                      <DetailSection row={row} locale={locale} tt={tt} />
                    </div>
                  )}
                </div>
              );
            })}

            {!rows.length && (
              <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/50 px-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                {tt('fuelPrices.noMatches', 'Nessun comune trovato con i filtri attuali.')}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-[2rem] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">{tt('fuelPrices.bestDeals', 'Dove si risparmia di piu')}</h2>
            <div className="mt-4 space-y-3">
              {data.rankings.bestCrossBorderSavings.slice(0, 6).map((item) => (
                <div key={`${item.municipality}-${item.province}`} className="rounded-2xl border border-slate-100 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-900/50 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{item.municipality} ({item.province})</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {item.cheaperCountry === 'IT'
                          ? tt('fuelPrices.bestDealItaly', 'Meglio fare il pieno in Italia')
                          : item.cheaperCountry === 'CH'
                          ? tt('fuelPrices.bestDealSwiss', 'Meglio fare il pieno in Svizzera')
                          : tt('fuelPrices.bestDealTie', 'Prezzo quasi uguale')}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold text-slate-900 dark:text-slate-100">{formatMoney(item.saving50LEur, 'EUR', locale, 2)}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">50L</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[2rem] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">{tt('fuelPrices.sourceNotes', 'Fonti e metodo')}</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-600 dark:text-slate-300">
              <li>{tt('fuelPrices.noteItaly', 'Italia: dati ufficiali MIMIT del file prezzi alle 8 e anagrafica impianti attivi.')}</li>
              <li>{tt('fuelPrices.noteSwiss', 'Svizzera: dati SP95 ricavati dal feed pubblico TCS delle stazioni nell area di frontiera.')}</li>
              <li>{tt('fuelPrices.noteExchange', 'Il confronto IT-CH converte i prezzi svizzeri in EUR usando il tasso ECB del giorno del dataset.')}</li>
              <li>{tt('fuelPrices.noteDistance', 'Nel consiglio personalizzato il totale include un costo chilometrico andata e ritorno impostato da te.')}</li>
            </ul>
            <div className="mt-4 flex flex-wrap gap-3">
              <a href={data.sources.italy.pricesUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 no-underline">
                {tt('fuelPrices.sourceItalyLink', 'Fonte Italia')}
                <ExternalLink size={14} />
              </a>
              <a href={data.sources.switzerland.providerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 no-underline">
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
