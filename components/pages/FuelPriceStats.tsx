import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Fuel, Loader2, MapPin, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { fetchFuelPrices, type FuelPricesDataset, type MunicipalityFuelRow } from '@/services/fuelPricesService';

type SortKey = 'saving' | 'delta' | 'italy' | 'swiss' | 'name';

function formatMoney(value: number | null, currency: string, locale: string, digits = 3) {
  if (value == null) return '—';
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : locale, {
    style: 'currency',
    currency,
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
  if (row.comparison.cheaperCountry === 'IT') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (row.comparison.cheaperCountry === 'CH') return 'text-blue-700 bg-blue-50 border-blue-200';
  if (row.comparison.cheaperCountry === 'SAME') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-slate-600 bg-slate-50 border-slate-200';
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

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (data?.municipalities || []).filter((row) => {
      if (province !== 'ALL' && row.province !== province) return false;
      if (!q) return true;
      return `${row.municipality} ${row.province}`.toLowerCase().includes(q);
    });
    const sorted = [...list].sort((a, b) => {
      if (sortKey === 'name') return `${a.municipality} ${a.province}`.localeCompare(`${b.municipality} ${b.province}`);
      if (sortKey === 'italy') return (a.italy.minPriceEur ?? 99) - (b.italy.minPriceEur ?? 99);
      if (sortKey === 'swiss') return (a.swiss.minPriceEur ?? 99) - (b.swiss.minPriceEur ?? 99);
      if (sortKey === 'delta') return Math.abs(a.comparison.priceDeltaEur ?? 0) < Math.abs(b.comparison.priceDeltaEur ?? 0) ? 1 : -1;
      return (b.comparison.saving50LEur ?? -1) - (a.comparison.saving50LEur ?? -1);
    });
    return sorted;
  }, [data, province, search, sortKey]);

  const selected = useMemo(() => {
    const key = selectedKey || (rows[0] ? `${rows[0].municipality}|${rows[0].province}` : null);
    return rows.find((row) => `${row.municipality}|${row.province}` === key) || rows[0] || null;
  }, [rows, selectedKey]);

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
      <div className="rounded-3xl border border-red-200 bg-red-50 p-6 text-red-800">
        <h2 className="font-bold text-lg">{tt('fuelPrices.errorTitle', 'Impossibile caricare i dati carburanti')}</h2>
        <p className="text-sm mt-2">{error || tt('fuelPrices.errorBody', 'Il dataset non e disponibile al momento.')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-orange-200/70 bg-gradient-to-br from-orange-50 via-white to-blue-50 p-6 sm:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-orange-700 ring-1 ring-orange-200">
              <Fuel size={14} />
              {tt('fuelPrices.badge', 'Osservatorio carburanti')}
            </div>
            <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-900 dark:text-white">
              {tt('fuelPrices.title', 'Prezzi carburanti Italia-Svizzera')}
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {tt('fuelPrices.subtitle', 'Confronta i prezzi della benzina nei comuni di confine italiani con le stazioni svizzere vicine e scopri dove conviene fare rifornimento oggi.')}
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="rounded-2xl border border-white bg-white/80 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tt('fuelPrices.italySnapshot', 'Snapshot Italia')}</div>
              <div className="mt-1 font-bold text-slate-900">{formatDate(data.sources.italy.priceSnapshotDate, locale)}</div>
            </div>
            <div className="rounded-2xl border border-white bg-white/80 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tt('fuelPrices.exchangeRate', 'Cambio CHF/EUR')}</div>
              <div className="mt-1 font-bold text-slate-900">1 CHF = {formatMoney(data.sources.exchangeRate.eurPerChf, 'EUR', locale, 4)}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white p-5">
          <div className="text-xs font-semibold uppercase text-slate-500">{tt('fuelPrices.cheaperItalyCount', 'Comuni dove conviene IT')}</div>
          <div className="mt-2 text-3xl font-black text-emerald-600">{data.summary.cheaperItalyCount}</div>
          <p className="mt-2 text-xs text-slate-500">{tt('fuelPrices.cheaperItalyHint', 'Confronti in cui il prezzo italiano e piu basso del migliore prezzo svizzero vicino.')}</p>
        </div>
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white p-5">
          <div className="text-xs font-semibold uppercase text-slate-500">{tt('fuelPrices.cheaperSwissCount', 'Comuni dove conviene CH')}</div>
          <div className="mt-2 text-3xl font-black text-blue-600">{data.summary.cheaperSwissCount}</div>
          <p className="mt-2 text-xs text-slate-500">{tt('fuelPrices.cheaperSwissHint', 'Confronti in cui la stazione svizzera piu conveniente batte il miglior prezzo locale italiano.')}</p>
        </div>
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white p-5">
          <div className="text-xs font-semibold uppercase text-slate-500">{tt('fuelPrices.bestItalyToday', 'Miglior prezzo Italia')}</div>
          <div className="mt-2 text-xl font-black text-slate-900">
            {data.summary.cheapestItalyMunicipality ? `${data.summary.cheapestItalyMunicipality.municipality} (${data.summary.cheapestItalyMunicipality.province})` : '—'}
          </div>
          <p className="mt-2 text-sm text-slate-500">
            {data.summary.cheapestItalyMunicipality ? formatMoney(data.summary.cheapestItalyMunicipality.minPriceEur, 'EUR', locale) : '—'}
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white p-5">
          <div className="text-xs font-semibold uppercase text-slate-500">{tt('fuelPrices.bestSwissToday', 'Miglior prezzo Svizzera')}</div>
          <div className="mt-2 text-xl font-black text-slate-900">
            {data.summary.cheapestSwissStation ? data.summary.cheapestSwissStation.name : '—'}
          </div>
          <p className="mt-2 text-sm text-slate-500">
            {data.summary.cheapestSwissStation ? `${formatMoney(data.summary.cheapestSwissStation.sp95PriceChf, 'CHF', locale)} / ${formatMoney(data.summary.cheapestSwissStation.sp95PriceEur, 'EUR', locale)}` : '—'}
          </p>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.4fr,0.9fr]">
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-black text-slate-900">{tt('fuelPrices.compareByMunicipality', 'Confronto per comune')}</h2>
              <p className="text-sm text-slate-500">{tt('fuelPrices.compareHint', 'Seleziona un comune di confine e confronta la benzina italiana con le opzioni svizzere vicine.')}</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={tt('fuelPrices.searchPlaceholder', 'Cerca comune o provincia')}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm outline-none focus:border-orange-300"
                />
              </label>
              <select
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-orange-300"
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
                className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-orange-300"
              >
                <option value="saving">{tt('fuelPrices.sortSaving', 'Ordina per risparmio')}</option>
                <option value="delta">{tt('fuelPrices.sortDelta', 'Ordina per delta')}</option>
                <option value="italy">{tt('fuelPrices.sortItaly', 'Ordina per prezzo IT')}</option>
                <option value="swiss">{tt('fuelPrices.sortSwiss', 'Ordina per prezzo CH')}</option>
                <option value="name">{tt('fuelPrices.sortName', 'Ordina per nome')}</option>
              </select>
            </div>
          </div>

          <div className="mt-4 overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-3">{tt('fuelPrices.tableMunicipality', 'Comune')}</th>
                  <th className="px-3 py-3">{tt('fuelPrices.tableItaly', 'Italia')}</th>
                  <th className="px-3 py-3">{tt('fuelPrices.tableSwiss', 'Svizzera')}</th>
                  <th className="px-3 py-3">{tt('fuelPrices.tableCheaper', 'Conviene')}</th>
                  <th className="px-3 py-3">{tt('fuelPrices.tableSaving', 'Risparmio 50L')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 120).map((row) => {
                  const isSelected = selected?.municipality === row.municipality && selected?.province === row.province;
                  return (
                    <tr
                      key={`${row.municipality}-${row.province}`}
                      className={`border-b border-slate-100 cursor-pointer ${isSelected ? 'bg-orange-50/70' : 'hover:bg-slate-50'}`}
                      onClick={() => {
                        setSelectedKey(`${row.municipality}|${row.province}`);
                        Analytics.trackUIInteraction('statistiche', 'carburanti', 'select_municipality', 'click', `${row.municipality}-${row.province}`);
                      }}
                    >
                      <td className="px-3 py-3">
                        <div className="font-semibold text-slate-900">{row.municipality}</div>
                        <div className="text-xs text-slate-500">{row.province} · {row.distanceKm} km {tt('fuelPrices.fromBorder', 'dal confine')}</div>
                      </td>
                      <td className="px-3 py-3 text-slate-700">{formatMoney(row.italy.minPriceEur, 'EUR', locale)}</td>
                      <td className="px-3 py-3 text-slate-700">
                        {row.swiss.minPriceChf != null
                          ? `${formatMoney(row.swiss.minPriceChf, 'CHF', locale)} · ${formatMoney(row.swiss.minPriceEur, 'EUR', locale)}`
                          : '—'}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${recommendationTone(row)}`}>
                          {tt(`fuelPrices.recommendation.${row.comparison.cheaperCountry.toLowerCase()}`, recommendationLabel(row.comparison.cheaperCountry))}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-semibold text-slate-900">{formatMoney(row.comparison.saving50LEur, 'EUR', locale, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white p-5">
            <h2 className="text-lg font-black text-slate-900">{tt('fuelPrices.bestDeals', 'Dove si risparmia di piu')}</h2>
            <div className="mt-4 space-y-3">
              {data.rankings.bestCrossBorderSavings.slice(0, 6).map((item) => (
                <div key={`${item.municipality}-${item.province}`} className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900">{item.municipality} ({item.province})</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {item.cheaperCountry === 'IT'
                            ? tt('fuelPrices.bestDealItaly', 'Meglio fare il pieno in Italia')
                            : item.cheaperCountry === 'CH'
                            ? tt('fuelPrices.bestDealSwiss', 'Meglio fare il pieno in Svizzera')
                            : tt('fuelPrices.bestDealTie', 'Prezzo quasi uguale')}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-black text-slate-900">{formatMoney(item.saving50LEur, 'EUR', locale, 2)}</div>
                      <div className="text-xs text-slate-500">50L</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white p-5">
            <h2 className="text-lg font-black text-slate-900">{tt('fuelPrices.sourceNotes', 'Fonti e metodo')}</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-600">
              <li>{tt('fuelPrices.noteItaly', 'Italia: dati ufficiali MIMIT del file prezzi alle 8 e anagrafica impianti attivi.')}</li>
              <li>{tt('fuelPrices.noteSwiss', 'Svizzera: dati SP95 ricavati dal feed pubblico TCS delle stazioni nell area di frontiera.')}</li>
              <li>{tt('fuelPrices.noteExchange', 'Il confronto IT-CH converte i prezzi svizzeri in EUR usando il tasso ECB del giorno del dataset.')}</li>
            </ul>
            <div className="mt-4 flex flex-wrap gap-3">
              <a href={data.sources.italy.pricesUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 no-underline">
                {tt('fuelPrices.sourceItalyLink', 'Fonte Italia')}
                <ExternalLink size={14} />
              </a>
              <a href={data.sources.switzerland.providerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 no-underline">
                {tt('fuelPrices.sourceSwissLink', 'Fonte Svizzera')}
                <ExternalLink size={14} />
              </a>
            </div>
          </div>
        </div>
      </section>

      {selected && (
        <section className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white p-5 sm:p-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <MapPin size={14} />
                {selected.municipality} ({selected.province})
              </div>
              <h2 className="mt-2 text-2xl font-black text-slate-900">{tt('fuelPrices.detailTitle', 'Dettaglio comune')}</h2>
              <p className="mt-2 text-sm text-slate-500">{tt('fuelPrices.detailSubtitle', 'Qui trovi tutte le stazioni italiane rilevate e le migliori alternative svizzere nel raggio di confronto.')}</p>
            </div>
            <div className={`inline-flex rounded-2xl border px-4 py-3 text-sm font-semibold ${recommendationTone(selected)}`}>
              {selected.comparison.cheaperCountry === 'IT' ? <TrendingDown size={18} /> : <TrendingUp size={18} />}
              <span className="ml-2">{tt(`fuelPrices.recommendationLong.${selected.comparison.cheaperCountry.toLowerCase()}`, recommendationLabel(selected.comparison.cheaperCountry))}</span>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase text-slate-500">{tt('fuelPrices.detailItalyBest', 'Miglior prezzo Italia')}</div>
              <div className="mt-2 text-2xl font-black text-slate-900">{formatMoney(selected.italy.minPriceEur, 'EUR', locale)}</div>
              <p className="mt-2 text-xs text-slate-500">{selected.italy.cheapestStation?.stationName || '—'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase text-slate-500">{tt('fuelPrices.detailSwissBest', 'Miglior prezzo Svizzera')}</div>
              <div className="mt-2 text-2xl font-black text-slate-900">
                {selected.swiss.minPriceChf != null
                  ? `${formatMoney(selected.swiss.minPriceChf, 'CHF', locale)}`
                  : '—'}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {selected.swiss.minPriceEur != null ? `${formatMoney(selected.swiss.minPriceEur, 'EUR', locale)} ${tt('fuelPrices.eurEquivalent', 'equivalente')}` : '—'}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase text-slate-500">{tt('fuelPrices.detailSaving50L', 'Risparmio su 50 litri')}</div>
              <div className="mt-2 text-2xl font-black text-slate-900">{formatMoney(selected.comparison.saving50LEur, 'EUR', locale, 2)}</div>
              <p className="mt-2 text-xs text-slate-500">{tt('fuelPrices.detailSavingHint', 'Stima teorica basata sul miglior prezzo italiano locale e sulla migliore opzione svizzera vicina.')}</p>
            </div>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <div>
              <h3 className="text-base font-black text-slate-900">{tt('fuelPrices.detailItalyStations', 'Stazioni italiane rilevate')}</h3>
              <div className="mt-3 overflow-auto rounded-2xl border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-3">{tt('fuelPrices.station', 'Stazione')}</th>
                      <th className="px-3 py-3">{tt('fuelPrices.price', 'Prezzo')}</th>
                      <th className="px-3 py-3">{tt('fuelPrices.mode', 'Modalita')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.italy.stations.slice(0, 20).map((station) => (
                      <tr key={`${station.id}-${station.priceEur}-${station.isSelf ? 'self' : 'served'}`} className="border-t border-slate-100">
                        <td className="px-3 py-3">
                          <div className="font-medium text-slate-900">{station.stationName}</div>
                          <div className="text-xs text-slate-500">{station.address}</div>
                        </td>
                        <td className="px-3 py-3 font-semibold text-slate-900">{formatMoney(station.priceEur, 'EUR', locale)}</td>
                        <td className="px-3 py-3 text-slate-600">{station.isSelf ? tt('fuelPrices.self', 'Self') : tt('fuelPrices.served', 'Servito')}</td>
                      </tr>
                    ))}
                    {!selected.italy.stations.length && (
                      <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-500">{tt('fuelPrices.noItalyStations', 'Nessuna stazione italiana trovata per questo comune.')}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 className="text-base font-black text-slate-900">{tt('fuelPrices.detailSwissStations', 'Migliori opzioni svizzere vicine')}</h3>
              <div className="mt-3 overflow-auto rounded-2xl border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-3">{tt('fuelPrices.station', 'Stazione')}</th>
                      <th className="px-3 py-3">{tt('fuelPrices.price', 'Prezzo')}</th>
                      <th className="px-3 py-3">{tt('fuelPrices.distance', 'Distanza')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.swiss.nearbyStations.map((station) => (
                      <tr key={station.id} className="border-t border-slate-100">
                        <td className="px-3 py-3">
                          <div className="font-medium text-slate-900">{station.name}</div>
                          <div className="text-xs text-slate-500">{station.address}</div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-semibold text-slate-900">{formatMoney(station.sp95PriceChf, 'CHF', locale)}</div>
                          <div className="text-xs text-slate-500">{formatMoney(station.sp95PriceEur, 'EUR', locale)}</div>
                        </td>
                        <td className="px-3 py-3 text-slate-600">{station.distanceKm != null ? `${station.distanceKm} km` : '—'}</td>
                      </tr>
                    ))}
                    {!selected.swiss.nearbyStations.length && (
                      <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-500">{tt('fuelPrices.noSwissStations', 'Nessuna stazione svizzera utile nel raggio di confronto.')}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
