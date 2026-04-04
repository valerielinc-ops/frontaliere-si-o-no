import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from '@/services/i18n';
import { borderCrossings } from '@/data/borderCrossings';
import { MUNICIPALITIES, findMunicipality, type Municipality } from '@/data/municipalities';
import { calculateMunicipalityTaxImpact, type MunicipalityTaxResult } from '@/services/calculationService';
import { useExchangeRate } from '@/services/exchangeRateService';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import { MapPin, Filter, Info, AlertTriangle, TrendingDown, TrendingUp, ArrowUpDown, Award, DollarSign, Building2, Navigation, ChevronUp, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { MAP_COLORS } from '@/services/mapColors';
import 'leaflet/dist/leaflet.css';

import type { UserProfileData } from '@/components/pages/UserProfile';

type ColorMode = 'irpef' | 'distance' | 'rent';
type SortField = 'name' | 'tax' | 'addizionale' | 'distance';
type SortDir = 'asc' | 'desc';

interface MunicipalityWithTax extends Municipality {
  taxResult: MunicipalityTaxResult;
}

interface Props {
  userProfile?: UserProfileData | null;
}

// ─── Component ───────────────────────────────────────────────
const BorderMunicipalitiesMap: React.FC<Props> = ({ userProfile }) => {
  const { t } = useTranslation();
  const [colorMode, setColorMode] = useState<ColorMode>('irpef');
  const [selectedMunicipality, setSelectedMunicipality] = useState<Municipality | null>(null);
  const [filterProvince, setFilterProvince] = useState<string>('all');
  const [salary, setSalary] = useState<number>(100000);
  const [sortField, setSortField] = useState<SortField>('tax');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [compareMunicipality, setCompareMunicipality] = useState<string>('');
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  // Prefill salary from user profile
  useEffect(() => {
    if (userProfile?.grossSalary) {
      const s = parseFloat(userProfile.grossSalary);
      if (!isNaN(s) && s > 0) setSalary(s);
    }
  }, [userProfile]);
  const provinces = useMemo(() => {
    const set = new Set(MUNICIPALITIES.map(m => m.province));
    return ['all', ...Array.from(set).sort()];
  }, []);

  const { rate: exchangeRate } = useExchangeRate();

  const filtered = useMemo(() => {
    return filterProvince === 'all' ? MUNICIPALITIES : MUNICIPALITIES.filter(m => m.province === filterProvince);
  }, [filterProvince]);

  // Calculate tax for all municipalities
  const municipalitiesWithTax = useMemo<MunicipalityWithTax[]>(() => {
    return filtered.map(m => ({
      ...m,
      taxResult: calculateMunicipalityTaxImpact(salary, exchangeRate, m.irpefAddizionale, m.fascia),
    }));
  }, [filtered, salary, exchangeRate]);

  // Sort municipalities
  const sortedMunicipalities = useMemo(() => {
    return [...municipalitiesWithTax].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name': cmp = a.name.localeCompare(b.name, 'it'); break;
        case 'tax': cmp = a.taxResult.finalItalianTaxEUR - b.taxResult.finalItalianTaxEUR; break;
        case 'addizionale': cmp = a.irpefAddizionale - b.irpefAddizionale; break;
        case 'distance': cmp = a.distanceKm - b.distanceKm; break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [municipalitiesWithTax, sortField, sortDir]);

  // User's municipality from profile
  const userMunicipality = useMemo(() => {
    if (userProfile?.municipality) return findMunicipality(userProfile.municipality) || null;
    return null;
  }, [userProfile]);

  // Compare municipality (either from profile or manual selection)
  const compareWith = useMemo(() => {
    if (compareMunicipality) return findMunicipality(compareMunicipality) || null;
    return userMunicipality;
  }, [compareMunicipality, userMunicipality]);

  const compareTaxResult = useMemo(() => {
    if (!compareWith) return null;
    return calculateMunicipalityTaxImpact(salary, exchangeRate, compareWith.irpefAddizionale, compareWith.fascia);
  }, [compareWith, salary, exchangeRate]);

  // Cheapest municipality
  const cheapest = useMemo(() => {
    if (municipalitiesWithTax.length === 0) return null;
    return municipalitiesWithTax.reduce((min, m) =>
      m.taxResult.finalItalianTaxEUR < min.taxResult.finalItalianTaxEUR ? m : min
    );
  }, [municipalitiesWithTax]);

  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  }, [sortField]);

  // Color functions
  const getColor = (m: Municipality): string => {
    switch (colorMode) {
      case 'irpef': {
        if (m.irpefAddizionale <= 0.5) return MAP_COLORS.success;
        if (m.irpefAddizionale <= 0.65) return MAP_COLORS.warning;
        return MAP_COLORS.danger;
      }
      case 'distance': {
        if (m.distanceKm <= 5) return MAP_COLORS.success;
        if (m.distanceKm <= 15) return MAP_COLORS.warning;
        return MAP_COLORS.danger;
      }
      case 'rent': {
        if (m.avgRentMonthly <= 500) return MAP_COLORS.success;
        if (m.avgRentMonthly <= 650) return MAP_COLORS.warning;
        return MAP_COLORS.danger;
      }
    }
  };

  const getRadius = (m: Municipality): number => {
    const pop = m.population;
    if (pop > 50000) return 12;
    if (pop > 20000) return 9;
    if (pop > 10000) return 7;
    return 5;
  };

  const center: [number, number] = [46.05, 9.20];

  const formatEUR = (n: number) => Math.round(n).toLocaleString('it-IT');

  return (
    <div className="space-y-4 lg:space-y-6">

      {/* ─── Mobile: compact header + inline filters + map first ── */}
      <div className="lg:hidden space-y-3">
        {/* Compact header */}
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-blue-100 dark:bg-blue-900/50 rounded-lg">
            <MapPin className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <h2 className="text-lg font-bold text-blue-900 dark:text-blue-100">{t('bordermap.title')}</h2>
        </div>

        {/* Inline filter pills + province dropdown */}
        <div className="flex flex-wrap gap-2 items-center">
          {([
            { mode: 'irpef' as const, label: t('bordermap.mode.irpef') },
            { mode: 'distance' as const, label: t('bordermap.mode.distance') },
            { mode: 'rent' as const, label: t('bordermap.mode.rent') },
          ]).map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => setColorMode(mode)}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
                colorMode === mode
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
          <label htmlFor="province-filter-mobile" className="sr-only">{t('bordermap.allProvinces')}</label>
          <select
            id="province-filter-mobile"
            value={filterProvince}
            onChange={(e) => setFilterProvince(e.target.value)}
            className="px-2.5 py-1 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-0"
          >
            {provinces.map(p => (
              <option key={p} value={p}>{p === 'all' ? t('bordermap.allProvinces') : p}</option>
            ))}
          </select>
        </div>

        {/* Compact legend */}
        <div className="flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> {colorMode === 'irpef' ? '≤0.5%' : colorMode === 'distance' ? '≤5km' : '≤€500'}</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-yellow-500 inline-block" /> {colorMode === 'irpef' ? '0.5–0.65%' : colorMode === 'distance' ? '5–15km' : '€500–650'}</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> {colorMode === 'irpef' ? '>0.65%' : colorMode === 'distance' ? '>15km' : '>€650'}</span>
        </div>

        {/* MAP — immediately visible on mobile */}
        <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 h-[55vh] min-h-[320px]">
          <MapContainer center={center} zoom={8} style={{ height: '100%', width: '100%' }} scrollWheelZoom={true}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {borderCrossings.map((bc, i) => (
              <CircleMarker
                key={`bc-${i}`}
                center={[bc.lat, bc.lng]}
                radius={4}
                pathOptions={{ color: MAP_COLORS.primaryStroke, fillColor: MAP_COLORS.primary, fillOpacity: 0.9, weight: 2 }}
              >
                <Popup>
                  <div className="text-xs">
                    <p className="font-bold">{bc.name}</p>
                    <p>{bc.type} — {bc.hours}</p>
                    <p>⏱ AM: {bc.avgWaitMorning}</p>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
            {filtered.map((m, i) => (
              <CircleMarker
                key={`m-${i}`}
                center={[m.lat, m.lng]}
                radius={getRadius(m)}
                pathOptions={{ color: getColor(m), fillColor: getColor(m), fillOpacity: 0.6, weight: 2 }}
                eventHandlers={{ click: () => setSelectedMunicipality(m) }}
              >
                <Popup>
                  <div className="text-xs space-y-1 min-w-[180px]">
                    <p className="font-bold text-sm">{m.name}</p>
                    <p className="text-slate-500 dark:text-slate-400">{m.province} — {t('bordermap.fascia')} {m.fascia}</p>
                    <hr />
                    <p>📊 IRPEF add.: <b>{m.irpefAddizionale}%</b></p>
                    <p>📏 {t('bordermap.distCrossing')}: <b>{m.distanceKm} km</b></p>
                    <p>🏠 {t('bordermap.avgRent')}: <b>€{m.avgRentMonthly}/mese</b></p>
                    <p>👥 {t('bordermap.pop')}: <b>{m.population.toLocaleString('it-IT')}</b></p>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>

        {/* Selected municipality card (mobile) */}
        {selectedMunicipality && (
          <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-bold text-slate-800 dark:text-slate-200">{selectedMunicipality.name}</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-bold">
                {t('bordermap.fascia')} {selectedMunicipality.fascia}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="p-2 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.mode.irpef')}</p>
                <p className="text-lg font-bold text-slate-800 dark:text-slate-200">{selectedMunicipality.irpefAddizionale}%</p>
              </div>
              <div className="p-2 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.distCrossing')}</p>
                <p className="text-lg font-bold text-slate-800 dark:text-slate-200">{selectedMunicipality.distanceKm} km</p>
              </div>
              <div className="p-2 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.avgRent')}</p>
                <p className="text-lg font-bold text-slate-800 dark:text-slate-200">€{selectedMunicipality.avgRentMonthly}</p>
              </div>
              <div className="p-2 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.pop')}</p>
                <p className="text-lg font-bold text-slate-800 dark:text-slate-200">{selectedMunicipality.population.toLocaleString('it-IT')}</p>
              </div>
            </div>
          </div>
        )}

        {/* Collapsible settings panel */}
        <button
          type="button"
          onClick={() => setMobileSettingsOpen(v => !v)}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 text-sm font-bold text-indigo-700 dark:text-indigo-300"
          aria-expanded={mobileSettingsOpen}
        >
          <span className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4" />
            {t('bordermap.taxImpact')} &amp; {t('bordermap.selectCompare')}
          </span>
          {mobileSettingsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {mobileSettingsOpen && (
          <div className="space-y-3">
            {/* Salary input */}
            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <label htmlFor="salary-input-mobile" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                {t('bordermap.salary')}
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={30000}
                  max={250000}
                  step={5000}
                  value={salary}
                  onChange={e => setSalary(Number(e.target.value))}
                  className="flex-1 h-2 accent-indigo-600"
                  aria-label={t('bordermap.salary')}
                />
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    id="salary-input-mobile"
                    value={salary}
                    onChange={e => {
                      const v = Number(e.target.value);
                      if (v >= 0 && v <= 500000) setSalary(v);
                    }}
                    className="w-24 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-right font-bold text-slate-800 dark:text-slate-200 text-sm"
                    min={0}
                    max={500000}
                    step={1000}
                  />
                  <span className="text-xs font-bold text-slate-600 dark:text-slate-400">CHF</span>
                </div>
              </div>
            </div>

            {/* Comparison */}
            <div className={`rounded-xl p-4 border ${compareWith && compareTaxResult ? 'bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800' : 'bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700'}`}>
              <div className="mb-3">
                <label htmlFor="compare-select-mobile" className="flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-400 mb-2">
                  <Building2 className="w-4 h-4" />
                  {t('bordermap.selectCompare')}
                </label>
                <select
                  id="compare-select-mobile"
                  value={compareMunicipality || compareWith?.name || ''}
                  onChange={e => setCompareMunicipality(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-300"
                >
                  <option value="">—</option>
                  {MUNICIPALITIES.map(m => (
                    <option key={m.name} value={m.name}>{m.name} ({m.province})</option>
                  ))}
                </select>
              </div>
              {compareWith && compareTaxResult && (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-bold text-indigo-800 dark:text-indigo-200">
                      {t('bordermap.comparison', { municipality: compareWith.name })}
                    </span>
                    {userMunicipality?.name === compareWith.name && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-200 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-300 font-bold">
                        {t('bordermap.yourMunicipality')}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-center">
                    <div className="p-2 bg-white dark:bg-slate-800 rounded-lg">
                      <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.annualTax')}</p>
                      <p className="text-lg font-bold text-indigo-700 dark:text-indigo-300">€{formatEUR(compareTaxResult.finalItalianTaxEUR)}</p>
                    </div>
                    <div className="p-2 bg-white dark:bg-slate-800 rounded-lg">
                      <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.addComunale')}</p>
                      <p className="text-lg font-bold text-slate-700 dark:text-slate-300">{compareWith.irpefAddizionale}%</p>
                    </div>
                    <div className="p-2 bg-white dark:bg-slate-800 rounded-lg">
                      <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.addRegionale')}</p>
                      <p className="text-lg font-bold text-slate-700 dark:text-slate-300">€{formatEUR(compareTaxResult.addizionaleRegionale)}</p>
                    </div>
                    <div className="p-2 bg-white dark:bg-slate-800 rounded-lg">
                      <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.fascia')}</p>
                      <p className="text-lg font-bold text-slate-700 dark:text-slate-300">{compareWith.fascia}</p>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Disclaimer */}
            <div className="bg-amber-50 dark:bg-amber-950/20 rounded-xl p-3 border border-amber-200 dark:border-amber-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700 dark:text-amber-300">{t('bordermap.disclaimer')}</p>
            </div>
          </div>
        )}
      </div>

      {/* ─── Desktop: original 2-column layout ─────────────────── */}
      <div className="hidden lg:grid grid-cols-2 gap-6">
        {/* Left column: settings & info */}
        <div className="space-y-4">
          {/* Header */}
          <div className="bg-gradient-to-br from-blue-50 to-blue-50 dark:from-blue-950/30 dark:to-blue-950/30 rounded-2xl p-6 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-blue-100 dark:bg-blue-900/50 rounded-xl">
                <MapPin className="w-6 h-6 text-blue-600 dark:text-blue-400" />
              </div>
              <h2 className="text-2xl font-bold text-blue-900 dark:text-blue-100">{t('bordermap.title')}</h2>
            </div>
            <p className="text-blue-700 dark:text-blue-300 text-sm">{t('bordermap.subtitle')}</p>
          </div>

          {/* Controls */}
          <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700 flex flex-wrap gap-3 items-center">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-slate-500" />
              <span className="text-sm font-bold text-slate-600 dark:text-slate-300">{t('bordermap.colorBy')}:</span>
            </div>
            {([
              { mode: 'irpef' as const, label: t('bordermap.mode.irpef') },
              { mode: 'distance' as const, label: t('bordermap.mode.distance') },
              { mode: 'rent' as const, label: t('bordermap.mode.rent') },
            ]).map(({ mode, label }) => (
              <button
                key={mode}
                onClick={() => setColorMode(mode)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  colorMode === mode
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                }`}
              >
                {label}
              </button>
            ))}

            <span className="text-slate-300 dark:text-slate-600">|</span>

            <label htmlFor="province-filter" className="sr-only">{t('bordermap.allProvinces')}</label>
            <select
              id="province-filter"
              value={filterProvince}
              onChange={(e) => setFilterProvince(e.target.value)}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-0"
            >
              {provinces.map(p => (
                <option key={p} value={p}>{p === 'all' ? t('bordermap.allProvinces') : p}</option>
              ))}
            </select>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-4 text-xs">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-green-500" />
              <span className="text-slate-600 dark:text-slate-300">
                {colorMode === 'irpef' ? '≤ 0.5%' : colorMode === 'distance' ? '≤ 5 km' : '≤ €500'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-yellow-500" />
              <span className="text-slate-600 dark:text-slate-300">
                {colorMode === 'irpef' ? '0.5–0.65%' : colorMode === 'distance' ? '5–15 km' : '€500–650'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <span className="text-slate-600 dark:text-slate-300">
                {colorMode === 'irpef' ? '> 0.65%' : colorMode === 'distance' ? '> 15 km' : '> €650'}
              </span>
            </div>
            <div className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
              <Info className="w-3 h-3" />
              {t('bordermap.sizeByPop')}
            </div>
          </div>

          {/* ─── Tax Impact Section ─────────────────────────────── */}
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 rounded-2xl p-6 border border-amber-200 dark:border-amber-800">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-amber-100 dark:bg-amber-900/50 rounded-xl">
                <DollarSign className="w-6 h-6 text-amber-600 dark:text-amber-400" />
              </div>
              <h2 className="text-2xl font-bold text-amber-900 dark:text-amber-100">{t('bordermap.taxImpact')}</h2>
            </div>
            <p className="text-amber-700 dark:text-amber-300 text-sm">{t('bordermap.taxImpactDesc')}</p>
          </div>

          {/* Salary input */}
          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <label htmlFor="salary-input" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">
              {t('bordermap.salary')}
            </label>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={30000}
                max={250000}
                step={5000}
                value={salary}
                onChange={e => setSalary(Number(e.target.value))}
                className="flex-1 h-2 accent-indigo-600"
                aria-label={t('bordermap.salary')}
              />
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  id="salary-input"
                  value={salary}
                  onChange={e => {
                    const v = Number(e.target.value);
                    if (v >= 0 && v <= 500000) setSalary(v);
                  }}
                  className="w-32 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-right font-bold text-slate-800 dark:text-slate-200 text-sm"
                  min={0}
                  max={500000}
                  step={1000}
                />
                <span className="text-sm font-bold text-slate-600 dark:text-slate-400">CHF</span>
              </div>
            </div>
            <div className="flex justify-between text-xs text-slate-500 mt-1 px-1">
              <span>30k</span>
              <span>100k</span>
              <span>150k</span>
              <span>200k</span>
              <span>250k</span>
            </div>
          </div>

          {/* Comparison banner */}
          <div className={`rounded-xl p-4 border ${compareWith && compareTaxResult ? 'bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800' : 'bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700'}`}>
            <div className="mb-3">
              <label htmlFor="compare-select" className="flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-400 mb-2">
                <Building2 className="w-4 h-4" />
                {t('bordermap.selectCompare')}
              </label>
              <select
                id="compare-select"
                value={compareMunicipality || compareWith?.name || ''}
                onChange={e => setCompareMunicipality(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-300"
              >
                <option value="">—</option>
                {MUNICIPALITIES.map(m => (
                  <option key={m.name} value={m.name}>{m.name} ({m.province})</option>
                ))}
              </select>
            </div>
            {compareWith && compareTaxResult && (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-bold text-indigo-800 dark:text-indigo-200">
                    {t('bordermap.comparison', { municipality: compareWith.name })}
                  </span>
                  {userMunicipality?.name === compareWith.name && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-200 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-300 font-bold">
                      {t('bordermap.yourMunicipality')}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div className="p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.annualTax')}</p>
                    <p className="text-lg font-bold text-indigo-700 dark:text-indigo-300">€{formatEUR(compareTaxResult.finalItalianTaxEUR)}</p>
                  </div>
                  <div className="p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.addComunale')}</p>
                    <p className="text-lg font-bold text-slate-700 dark:text-slate-300">{compareWith.irpefAddizionale}%</p>
                  </div>
                  <div className="p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.addRegionale')}</p>
                    <p className="text-lg font-bold text-slate-700 dark:text-slate-300">€{formatEUR(compareTaxResult.addizionaleRegionale)}</p>
                  </div>
                  <div className="p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.fascia')}</p>
                    <p className="text-lg font-bold text-slate-700 dark:text-slate-300">{compareWith.fascia}</p>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Info box */}
          <div className="bg-amber-50 dark:bg-amber-950/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-300">{t('bordermap.disclaimer')}</p>
          </div>
        </div>

        {/* Right column: map & selected detail */}
        <div className="space-y-4">
          {/* Map */}
          <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 h-full min-h-[500px]">
            <MapContainer center={center} zoom={8} style={{ height: '100%', width: '100%' }} scrollWheelZoom={true}>
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {borderCrossings.map((bc, i) => (
                <CircleMarker
                  key={`bc-${i}`}
                  center={[bc.lat, bc.lng]}
                  radius={4}
                  pathOptions={{ color: MAP_COLORS.primaryStroke, fillColor: MAP_COLORS.primary, fillOpacity: 0.9, weight: 2 }}
                >
                  <Popup>
                    <div className="text-xs">
                      <p className="font-bold">{bc.name}</p>
                      <p>{bc.type} — {bc.hours}</p>
                      <p>⏱ AM: {bc.avgWaitMorning}</p>
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
              {filtered.map((m, i) => (
                <CircleMarker
                  key={`m-${i}`}
                  center={[m.lat, m.lng]}
                  radius={getRadius(m)}
                  pathOptions={{ color: getColor(m), fillColor: getColor(m), fillOpacity: 0.6, weight: 2 }}
                  eventHandlers={{ click: () => setSelectedMunicipality(m) }}
                >
                  <Popup>
                    <div className="text-xs space-y-1 min-w-[180px]">
                      <p className="font-bold text-sm">{m.name}</p>
                      <p className="text-slate-500 dark:text-slate-400">{m.province} — {t('bordermap.fascia')} {m.fascia}</p>
                      <hr />
                      <p>📊 IRPEF add.: <b>{m.irpefAddizionale}%</b></p>
                      <p>📏 {t('bordermap.distCrossing')}: <b>{m.distanceKm} km</b></p>
                      <p>🏠 {t('bordermap.avgRent')}: <b>€{m.avgRentMonthly}/mese</b></p>
                      <p>👥 {t('bordermap.pop')}: <b>{m.population.toLocaleString('it-IT')}</b></p>
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>

          {/* Selected municipality detail card */}
          {selectedMunicipality && (
            <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200">{selectedMunicipality.name}</h3>
                <span className="text-xs px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-bold">
                  {t('bordermap.fascia')} {selectedMunicipality.fascia}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.mode.irpef')}</p>
                  <p className="text-xl font-bold text-slate-800 dark:text-slate-200">{selectedMunicipality.irpefAddizionale}%</p>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.distCrossing')}</p>
                  <p className="text-xl font-bold text-slate-800 dark:text-slate-200">{selectedMunicipality.distanceKm} km</p>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.avgRent')}</p>
                  <p className="text-xl font-bold text-slate-800 dark:text-slate-200">€{selectedMunicipality.avgRentMonthly}</p>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.pop')}</p>
                  <p className="text-xl font-bold text-slate-800 dark:text-slate-200">{selectedMunicipality.population.toLocaleString('it-IT')}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Bottom section: full-width, 3 columns ───────── */}

      {/* Sort controls + count */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <ArrowUpDown className="w-4 h-4 text-slate-500" />
          <span className="text-sm font-bold text-slate-600 dark:text-slate-300">{t('bordermap.sortBy')}:</span>
          {([
            { field: 'name' as const, label: t('bordermap.sortName') },
            { field: 'tax' as const, label: t('bordermap.sortTax') },
            { field: 'addizionale' as const, label: t('bordermap.sortAddizionale') },
            { field: 'distance' as const, label: t('bordermap.sortDistance') },
          ]).map(({ field, label }) => (
            <button
              key={field}
              onClick={() => toggleSort(field)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors inline-flex items-center gap-1 ${
                sortField === field
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
              }`}
            >
              {label}
              {sortField === field && (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.municipalities', { count: String(sortedMunicipalities.length) })}</span>
      </div>

      {/* Municipality cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {sortedMunicipalities.map(m => {
          const delta = compareTaxResult ? m.taxResult.finalItalianTaxEUR - compareTaxResult.finalItalianTaxEUR : null;
          const isCheapest = cheapest && m.name === cheapest.name;
          const isCampione = m.name === "Campione d'Italia";

          return (
            <div
              key={m.name}
              className={`bg-white dark:bg-slate-800 rounded-xl p-4 border transition-shadow hover:shadow-md ${
                isCheapest
                  ? 'border-green-300 dark:border-green-700 ring-1 ring-green-200 dark:ring-green-800'
                  : compareWith?.name === m.name
                    ? 'border-indigo-300 dark:border-indigo-700 ring-1 ring-indigo-200 dark:ring-indigo-800'
                    : 'border-slate-200 dark:border-slate-700'
              }`}
            >
              {/* Card header */}
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h4 className="font-bold text-slate-800 dark:text-slate-200">{m.name}</h4>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 font-bold">{m.province}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${
                      m.fascia === '2'
                        ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'
                        : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    }`}>
                      {t('bordermap.fascia')} {m.fascia}
                    </span>
                    {isCheapest && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 font-bold inline-flex items-center gap-0.5">
                        <Award className="w-3 h-3" /> {t('bordermap.cheapest')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-2xl font-bold text-indigo-700 dark:text-indigo-300">€{formatEUR(m.taxResult.finalItalianTaxEUR)}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.annualTax')}</p>
                </div>
              </div>

              {/* Tax details */}
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="p-2 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.addComunale')}</p>
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-300">{m.irpefAddizionale}% <span className="text-xs font-normal text-slate-500 dark:text-slate-400">(€{formatEUR(m.taxResult.addizionaleComunale)})</span></p>
                </div>
                <div className="p-2 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('bordermap.addRegionale')}</p>
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-300">€{formatEUR(m.taxResult.addizionaleRegionale)}</p>
                </div>
              </div>

              {/* Extra info row */}
              <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 mb-3">
                <span className="inline-flex items-center gap-1"><Navigation className="w-3 h-3" /> {m.distanceKm} km</span>
                <span>🏠 €{m.avgRentMonthly}/m</span>
                <span>👥 {m.population.toLocaleString('it-IT')}</span>
              </div>

              {/* Fascia note — franchigia applies to all fascia (Art. 1 c.175 L.147/2013) */}
              <p className="text-xs text-blue-600 dark:text-blue-400 mb-2">✓ {t('bordermap.withFranchigia', { fascia: m.fascia })}</p>

              {/* Campione special note */}
              {isCampione && (
                <p className="text-xs text-blue-600 dark:text-blue-400 italic mb-2">ℹ️ {t('bordermap.campione')}</p>
              )}

              {/* Delta vs comparison municipality */}
              {delta !== null && compareWith?.name !== m.name && (
                <div className={`flex items-center gap-1 text-sm font-bold rounded-lg px-3 py-2 ${
                  delta < 0
                    ? 'bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300'
                    : delta > 0
                      ? 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                      : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-400'
                }`}>
                  {delta < 0 ? (
                    <><TrendingDown className="w-4 h-4" /> {t('bordermap.saving')}: €{formatEUR(Math.abs(delta))}{t('bordermap.perYear')}</>
                  ) : delta > 0 ? (
                    <><TrendingUp className="w-4 h-4" /> {t('bordermap.extraCost')}: +€{formatEUR(delta)}{t('bordermap.perYear')}</>
                  ) : (
                    <span>=</span>
                  )}
                  <span className="text-xs font-normal ml-1">{t('bordermap.vsMunicipality', { name: compareWith?.name || '' })}</span>
                </div>
              )}
              {compareWith?.name === m.name && (
                <div className="flex items-center gap-1 text-sm font-bold rounded-lg px-3 py-2 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300">
                  <Building2 className="w-4 h-4" /> {t('bordermap.yourMunicipality')}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default React.memo(BorderMunicipalitiesMap);
