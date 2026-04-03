import React, { useState, useMemo, useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { useExchangeRate } from '@/services/exchangeRateService';
import { ArrowLeftRight, MapPin, TrendingUp, AlertCircle, ChevronDown, ChevronUp, Clock, Euro, Home, Briefcase, RefreshCw, Star, Navigation, Car, Search, X, Filter, SlidersHorizontal } from 'lucide-react';
import { MUNICIPALITIES, type Municipality } from '@/data/municipalities';

const LeadMagnetCTA = lazy(() => import('@/components/shared/LeadMagnetCTA'));
const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));

// ─── Simulation Engine ───────────────────────────────────────

interface Location {
  id: string;
  name: string;
  country: 'IT' | 'CH';
  province?: string;
  avgRent: number;
  groceries: number;
  healthInsurance: number;
  transport: number;
  utilities: number;
  currency: 'EUR' | 'CHF';
  irpefComunale?: number;
  distanceToBorderKm?: number;
  nearestCrossing?: string;
  avgQueueMinutes?: number;
  population?: number;
  fascia?: '1' | '1A' | '2';
}

// ── Swiss Ticino municipalities ──
const SWISS_LOCATIONS: Location[] = [
  { id: 'lugano', name: 'Lugano', country: 'CH', avgRent: 1600, groceries: 700, healthInsurance: 350, transport: 100, utilities: 200, currency: 'CHF', population: 63000 },
  { id: 'bellinzona', name: 'Bellinzona', country: 'CH', avgRent: 1300, groceries: 650, healthInsurance: 340, transport: 80, utilities: 180, currency: 'CHF', population: 44000 },
  { id: 'mendrisio', name: 'Mendrisio', country: 'CH', avgRent: 1400, groceries: 670, healthInsurance: 345, transport: 90, utilities: 185, currency: 'CHF', population: 15000 },
  { id: 'locarno', name: 'Locarno', country: 'CH', avgRent: 1350, groceries: 660, healthInsurance: 342, transport: 85, utilities: 182, currency: 'CHF', population: 16000 },
  { id: 'chiasso', name: 'Chiasso', country: 'CH', avgRent: 1250, groceries: 640, healthInsurance: 338, transport: 70, utilities: 175, currency: 'CHF', population: 8400 },
  { id: 'stabio', name: 'Stabio', country: 'CH', avgRent: 1300, groceries: 650, healthInsurance: 340, transport: 80, utilities: 178, currency: 'CHF', population: 4600 },
  { id: 'biasca', name: 'Biasca', country: 'CH', avgRent: 1150, groceries: 620, healthInsurance: 335, transport: 90, utilities: 170, currency: 'CHF', population: 6200 },
  { id: 'manno', name: 'Manno', country: 'CH', avgRent: 1500, groceries: 690, healthInsurance: 348, transport: 85, utilities: 195, currency: 'CHF', population: 1500 },
  { id: 'agno', name: 'Agno', country: 'CH', avgRent: 1450, groceries: 680, healthInsurance: 346, transport: 80, utilities: 190, currency: 'CHF', population: 4400 },
  { id: 'giubiasco', name: 'Giubiasco', country: 'CH', avgRent: 1200, groceries: 640, healthInsurance: 338, transport: 75, utilities: 175, currency: 'CHF', population: 8600 },
  { id: 'minusio', name: 'Minusio', country: 'CH', avgRent: 1400, groceries: 665, healthInsurance: 344, transport: 80, utilities: 185, currency: 'CHF', population: 7700 },
  { id: 'ascona', name: 'Ascona', country: 'CH', avgRent: 1650, groceries: 720, healthInsurance: 352, transport: 90, utilities: 210, currency: 'CHF', population: 5500 },
  { id: 'balerna', name: 'Balerna', country: 'CH', avgRent: 1300, groceries: 650, healthInsurance: 340, transport: 75, utilities: 178, currency: 'CHF', population: 3800 },
  { id: 'coldrerio', name: 'Coldrerio', country: 'CH', avgRent: 1280, groceries: 645, healthInsurance: 339, transport: 78, utilities: 176, currency: 'CHF', population: 3000 },
  { id: 'morbio_inferiore', name: 'Morbio Inferiore', country: 'CH', avgRent: 1350, groceries: 655, healthInsurance: 341, transport: 76, utilities: 180, currency: 'CHF', population: 4600 },
  { id: 'paradiso', name: 'Paradiso', country: 'CH', avgRent: 1800, groceries: 730, healthInsurance: 355, transport: 70, utilities: 215, currency: 'CHF', population: 4500 },
  { id: 'massagno', name: 'Massagno', country: 'CH', avgRent: 1550, groceries: 700, healthInsurance: 350, transport: 70, utilities: 200, currency: 'CHF', population: 6400 },
  { id: 'viganello', name: 'Viganello', country: 'CH', avgRent: 1450, groceries: 685, healthInsurance: 347, transport: 70, utilities: 192, currency: 'CHF', population: 3200 },
  { id: 'camorino', name: 'Camorino', country: 'CH', avgRent: 1250, groceries: 640, healthInsurance: 338, transport: 80, utilities: 175, currency: 'CHF', population: 3200 },
  { id: 'rivera', name: 'Rivera', country: 'CH', avgRent: 1200, groceries: 630, healthInsurance: 336, transport: 85, utilities: 172, currency: 'CHF', population: 3000 },
];

// ── Convert Municipality data to Location ──
function municipalityToLocation(m: Municipality): Location {
  // Estimate nearest crossing & queue based on province and distance
  const crossings: Record<string, { name: string; queueMin: number }> = {
    CO: { name: 'Chiasso - Brogeda', queueMin: 18 },
    VA: { name: 'Gaggiolo', queueMin: 12 },
    VB: { name: 'Dirinella', queueMin: 4 },
    SO: { name: 'Castasegna', queueMin: 5 },
    LC: { name: 'Chiasso - Brogeda', queueMin: 18 },
  };
  const crossing = crossings[m.province] ?? { name: 'Chiasso', queueMin: 15 };
  // Transport cost scales with distance
  const transportCost = Math.round(120 + m.distanceKm * 5);
  // Groceries estimate based on population (larger cities slightly more expensive)
  const groceriesCost = m.population > 30000 ? 400 : m.population > 10000 ? 380 : 360;

  return {
    id: m.name.toLowerCase().replace(/[\s'()]/g, '_').replace(/__+/g, '_'),
    name: m.name,
    country: 'IT',
    province: m.province,
    avgRent: m.avgRentMonthly,
    groceries: groceriesCost,
    healthInsurance: 0,
    transport: transportCost,
    utilities: m.population > 20000 ? 150 : 130,
    currency: 'EUR',
    irpefComunale: m.irpefAddizionale,
    distanceToBorderKm: m.distanceKm,
    nearestCrossing: crossing.name,
    avgQueueMinutes: crossing.queueMin,
    population: m.population,
    fascia: m.fascia,
  };
}

// ── Build all locations ──
const IT_LOCATIONS: Location[] = MUNICIPALITIES.map(municipalityToLocation);
const ALL_LOCATIONS: Location[] = [...IT_LOCATIONS, ...SWISS_LOCATIONS];

interface OneTimeCost {
  label: string;
  amount: number;
  currency: 'EUR' | 'CHF';
}

const ONE_TIME_IT_TO_CH: OneTimeCost[] = [
  { label: 'residency.onetime.deposit', amount: 4800, currency: 'CHF' },
  { label: 'residency.onetime.moving', amount: 3000, currency: 'EUR' },
  { label: 'residency.onetime.permitB', amount: 150, currency: 'CHF' },
  { label: 'residency.onetime.adminFees', amount: 500, currency: 'CHF' },
  { label: 'residency.onetime.furniture', amount: 2000, currency: 'EUR' },
];

const ONE_TIME_CH_TO_IT: OneTimeCost[] = [
  { label: 'residency.onetime.deposit', amount: 2250, currency: 'EUR' },
  { label: 'residency.onetime.moving', amount: 2500, currency: 'EUR' },
  { label: 'residency.onetime.agency', amount: 500, currency: 'EUR' },
  { label: 'residency.onetime.adminFees', amount: 300, currency: 'EUR' },
];

// ─── Autocomplete Component ─────────────────────────────────

function LocationAutocomplete({ 
  value, 
  onChange, 
  label,
  locations 
}: { 
  value: Location | null; 
  onChange: (loc: Location) => void; 
  label: string;
  locations: Location[];
}) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return locations.slice(0, 30);
    const q = query.toLowerCase().trim();
    return locations.filter(l => {
      const searchStr = `${l.name} ${l.province ?? ''} ${l.country === 'IT' ? 'italia italy' : 'svizzera switzerland'}`.toLowerCase();
      return searchStr.includes(q);
    }).slice(0, 30);
  }, [query, locations]);

  const itFiltered = filtered.filter(l => l.country === 'IT');
  const chFiltered = filtered.filter(l => l.country === 'CH');

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectLocation = useCallback((loc: Location) => {
    onChange(loc);
    setQuery('');
    setIsOpen(false);
    setHighlightIndex(-1);
  }, [onChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const allItems = [...itFiltered, ...chFiltered];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(prev => Math.min(prev + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault();
      selectLocation(allItems[highlightIndex]);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  // Scroll highlighted into view
  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-option]');
      items[highlightIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIndex]);

  const displayValue = value ? `${value.country === 'IT' ? '\u{1F1EE}\u{1F1F9}' : '\u{1F1E8}\u{1F1ED}'} ${value.name}${value.province ? ` (${value.province})` : ''}` : '';

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">{label}</label>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={isOpen ? query : displayValue}
          onChange={(e) => { setQuery(e.target.value); setIsOpen(true); setHighlightIndex(-1); }}
          onFocus={() => { setIsOpen(true); setQuery(''); }}
          placeholder={displayValue || label}
          className="w-full pl-9 pr-8 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none"
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={label}
        />
        {value && !isOpen && (
          <button
            onClick={() => { setQuery(''); inputRef.current?.focus(); setIsOpen(true); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            aria-label="Cambia"
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      {isOpen && (
        <div
          ref={listRef}
          className="absolute z-50 w-full mt-1 max-h-64 overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl"
          role="listbox"
        >
          {filtered.length === 0 && (
            <p className="p-3 text-sm text-slate-500 dark:text-slate-400 text-center">Nessun risultato</p>
          )}
          {itFiltered.length > 0 && (
            <>
              <div className="sticky top-0 bg-slate-100 dark:bg-slate-700 px-3 py-1.5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                {'\u{1F1EE}\u{1F1F9}'} Italia ({itFiltered.length})
              </div>
              {itFiltered.map((loc, i) => (
                <button
                  key={loc.id}
                  data-option
                  onClick={() => selectLocation(loc)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors ${
                    highlightIndex === i ? 'bg-indigo-50 dark:bg-indigo-900/30' : ''
                  } ${value?.id === loc.id ? 'text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-700 dark:text-slate-300'}`}
                  role="option"
                  aria-selected={value?.id === loc.id}
                >
                  <span className="truncate">{loc.name} {loc.province ? `(${loc.province})` : ''}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 ml-2 shrink-0">
                    {loc.distanceToBorderKm != null ? `${loc.distanceToBorderKm} km` : ''}
                  </span>
                </button>
              ))}
            </>
          )}
          {chFiltered.length > 0 && (
            <>
              <div className="sticky top-0 bg-slate-100 dark:bg-slate-700 px-3 py-1.5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                {'\u{1F1E8}\u{1F1ED}'} Svizzera ({chFiltered.length})
              </div>
              {chFiltered.map((loc, j) => (
                <button
                  key={loc.id}
                  data-option
                  onClick={() => selectLocation(loc)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors ${
                    highlightIndex === itFiltered.length + j ? 'bg-indigo-50 dark:bg-indigo-900/30' : ''
                  } ${value?.id === loc.id ? 'text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-700 dark:text-slate-300'}`}
                  role="option"
                  aria-selected={value?.id === loc.id}
                >
                  <span className="truncate">{loc.name}</span>
                  {loc.population && (
                    <span className="text-xs text-slate-500 dark:text-slate-400 ml-2 shrink-0">
                      {loc.population.toLocaleString('it-IT')} ab.
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────

const ResidencySimulator: React.FC = () => {
  const { t } = useTranslation();
  const { rate: chfEurRate, loading: rateLoading } = useExchangeRate();
  
  // Default locations
  const defaultFrom = IT_LOCATIONS.find(l => l.name === 'Como') ?? IT_LOCATIONS[0];
  const defaultTo = SWISS_LOCATIONS.find(l => l.id === 'lugano') ?? SWISS_LOCATIONS[0];
  
  const [fromLoc, setFromLoc] = useState<Location>(defaultFrom);
  const [toLoc, setToLoc] = useState<Location>(defaultTo);
  const [grossMonthlyCHF, setGrossMonthlyCHF] = useState(6500);
  const [showDetails, setShowDetails] = useState(false);

  // EUR/CHF derived from API CHF→EUR rate
  const eurChfRate = chfEurRate > 0 ? 1 / chfEurRate : 1.06;

  const swapLocations = () => {
    setFromLoc(toLoc);
    setToLoc(fromLoc);
  };

  // Calculate monthly costs in EUR for comparison
  const result = useMemo(() => {
    const toEUR = (amount: number, currency: 'EUR' | 'CHF') =>
      currency === 'CHF' ? amount * chfEurRate : amount;
    const toCHF = (amount: number, currency: 'EUR' | 'CHF') =>
      currency === 'EUR' ? amount * eurChfRate : amount;

    const fromMonthly = toEUR(
      fromLoc.avgRent + fromLoc.groceries + fromLoc.healthInsurance + fromLoc.transport + fromLoc.utilities,
      fromLoc.currency
    );
    const toMonthly = toEUR(
      toLoc.avgRent + toLoc.groceries + toLoc.healthInsurance + toLoc.transport + toLoc.utilities,
      toLoc.currency
    );

    const monthlyDiff = toMonthly - fromMonthly;

    // One-time costs
    const direction = fromLoc.country === 'IT' && toLoc.country === 'CH' ? 'IT_TO_CH'
      : fromLoc.country === 'CH' && toLoc.country === 'IT' ? 'CH_TO_IT'
      : fromLoc.country === 'IT' ? 'IT_TO_IT' : 'CH_TO_CH';

    const oneTimeCosts = direction === 'IT_TO_CH' ? ONE_TIME_IT_TO_CH
      : direction === 'CH_TO_IT' ? ONE_TIME_CH_TO_IT
      : direction === 'IT_TO_IT' ? [
          { label: 'residency.onetime.deposit', amount: 2250, currency: 'EUR' as const },
          { label: 'residency.onetime.moving', amount: 1500, currency: 'EUR' as const },
        ]
      : [
          { label: 'residency.onetime.deposit', amount: 4200, currency: 'CHF' as const },
          { label: 'residency.onetime.moving', amount: 2000, currency: 'CHF' as const },
        ];

    const totalOneTime = oneTimeCosts.reduce((sum, c) => sum + toEUR(c.amount, c.currency), 0);

    // Tax impact (simplified)
    let taxNote = '';
    if (direction === 'IT_TO_CH') {
      taxNote = 'residency.tax.itToCh';
    } else if (direction === 'CH_TO_IT') {
      taxNote = 'residency.tax.chToIt';
    }

    // Break-even: if monthly costs go up, how many months until one-time costs are "absorbed"
    // (only meaningful if moving saves money monthly)
    let breakEvenMonths: number | null = null;
    if (monthlyDiff < 0) {
      // Moving saves money — break-even after one-time costs are recovered
      breakEvenMonths = Math.ceil(totalOneTime / Math.abs(monthlyDiff));
    }

    return {
      fromMonthly,
      toMonthly,
      monthlyDiff,
      totalOneTime,
      oneTimeCosts,
      breakEvenMonths,
      direction,
      taxNote,
    };
  }, [chfEurRate, eurChfRate, fromLoc, toLoc]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-indigo-50 to-violet-50 dark:from-indigo-950/30 dark:to-violet-950/30 rounded-2xl p-4 sm:p-6 border border-indigo-200 dark:border-indigo-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-indigo-100 dark:bg-indigo-900/50 rounded-xl">
            <Home className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
          </div>
          <h2 className="text-2xl font-bold text-indigo-900 dark:text-indigo-100">{t('residency.title')}</h2>
        </div>
        <p className="text-indigo-700 dark:text-indigo-300 text-sm">{t('residency.subtitle')}</p>
      </div>

      {/* Inputs */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr,auto,1fr] gap-4 items-end">
          {/* From */}
          <LocationAutocomplete
            value={fromLoc}
            onChange={setFromLoc}
            label={t('residency.from')}
            locations={ALL_LOCATIONS}
          />

          {/* Swap button */}
          <button
            onClick={swapLocations}
            className="p-2.5 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-200 dark:hover:bg-indigo-900/50 transition-colors self-end"
            aria-label={t('residency.swap') || 'Inverti'}
          >
            <ArrowLeftRight className="w-5 h-5" />
          </button>

          {/* To */}
          <LocationAutocomplete
            value={toLoc}
            onChange={setToLoc}
            label={t('residency.to')}
            locations={ALL_LOCATIONS}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">{t('residency.grossMonthly')}</label>
            <input
              type="number"
              value={grossMonthlyCHF}
              onChange={(e) => setGrossMonthlyCHF(+e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">{t('residency.exchangeRate')}</label>
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
              <span className="text-sm font-bold text-slate-800 dark:text-slate-200">1 CHF = {chfEurRate.toFixed(4)} EUR</span>
              {rateLoading && <RefreshCw size={12} className="animate-spin text-slate-500 dark:text-slate-400" />}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{t('exchange.liveRate') || 'Tasso live'}</p>
          </div>
        </div>
      </div>

      {/* Results */}
      {/* Monthly comparison */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* From card */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            <h3 className="font-bold text-sm text-slate-500 dark:text-slate-400">{fromLoc.name} ({t('residency.current')})</h3>
          </div>
          <p className="text-2xl font-bold text-slate-800 dark:text-slate-200">€{Math.round(result.fromMonthly).toLocaleString('it-IT')}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('residency.perMonth')}</p>
          <div className="mt-3 space-y-1 text-xs text-slate-500 dark:text-slate-400">
            <p>🏠 {t('residency.rent')}: {fromLoc.currency === 'CHF' ? 'CHF' : '€'}{fromLoc.avgRent}</p>
            <p>🛒 {t('residency.groceries')}: {fromLoc.currency === 'CHF' ? 'CHF' : '€'}{fromLoc.groceries}</p>
            <p>🚗 {t('residency.transport')}: {fromLoc.currency === 'CHF' ? 'CHF' : '€'}{fromLoc.transport}</p>
            <p>💡 {t('residency.utilities')}: {fromLoc.currency === 'CHF' ? 'CHF' : '€'}{fromLoc.utilities}</p>
            {fromLoc.healthInsurance > 0 && (
              <p>🏥 LAMal: CHF{fromLoc.healthInsurance}</p>
            )}
          </div>
        </div>

        {/* Difference card */}
        <div className={`rounded-xl p-5 border-2 flex flex-col items-center justify-center ${
          result.monthlyDiff > 0
            ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
            : 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
        }`}>
          <TrendingUp className={`w-6 h-6 mb-2 ${result.monthlyDiff > 0 ? 'text-red-500 rotate-0' : 'text-emerald-500 rotate-180'}`} />
          <p className={`text-3xl font-bold ${result.monthlyDiff > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
            {result.monthlyDiff > 0 ? '+' : ''}€{Math.round(result.monthlyDiff).toLocaleString('it-IT')}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{t('residency.monthlyDiff')}</p>

          {result.breakEvenMonths && (
            <div className="mt-3 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
              <Clock className="w-3 h-3" />
              <span>{t('residency.breakEven', { months: result.breakEvenMonths.toString() })}</span>
            </div>
          )}
        </div>

        {/* To card */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="w-4 h-4 text-indigo-400" />
            <h3 className="font-bold text-sm text-indigo-500">{toLoc.name} ({t('residency.new')})</h3>
          </div>
          <p className="text-2xl font-bold text-slate-800 dark:text-slate-200">€{Math.round(result.toMonthly).toLocaleString('it-IT')}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('residency.perMonth')}</p>
          <div className="mt-3 space-y-1 text-xs text-slate-500 dark:text-slate-400">
            <p>🏠 {t('residency.rent')}: {toLoc.currency === 'CHF' ? 'CHF' : '€'}{toLoc.avgRent}</p>
            <p>🛒 {t('residency.groceries')}: {toLoc.currency === 'CHF' ? 'CHF' : '€'}{toLoc.groceries}</p>
            <p>🚗 {t('residency.transport')}: {toLoc.currency === 'CHF' ? 'CHF' : '€'}{toLoc.transport}</p>
            <p>💡 {t('residency.utilities')}: {toLoc.currency === 'CHF' ? 'CHF' : '€'}{toLoc.utilities}</p>
            {toLoc.healthInsurance > 0 && (
              <p>🏥 LAMal: CHF{toLoc.healthInsurance}</p>
            )}
          </div>
        </div>
      </div>

      {/* One-time costs */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
        <button onClick={() => setShowDetails(!showDetails)} className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <Euro className="w-5 h-5 text-amber-500" />
            <h3 className="font-bold text-slate-800 dark:text-slate-200">{t('residency.oneTimeCosts')}</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-amber-600 dark:text-amber-400">€{Math.round(result.totalOneTime).toLocaleString('it-IT')}</span>
            {showDetails ? <ChevronUp size={16} className="text-slate-500 dark:text-slate-400" /> : <ChevronDown size={16} className="text-slate-500 dark:text-slate-400" />}
          </div>
        </button>

        {showDetails && (
          <div className="mt-4 space-y-2">
            {result.oneTimeCosts.map((cost, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-700 last:border-0">
                <span className="text-sm text-slate-600 dark:text-slate-300">{t(cost.label)}</span>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  {cost.currency === 'CHF' ? 'CHF' : '€'}{cost.amount.toLocaleString('it-IT')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tax note */}
      {result.taxNote && (
        <div className="bg-indigo-50 dark:bg-indigo-950/20 rounded-xl p-4 border border-indigo-200 dark:border-indigo-800 flex items-start gap-3">
          <Briefcase className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
          <p className="text-sm text-indigo-700 dark:text-indigo-300">{t(result.taxNote)}</p>
        </div>
      )}

      {/* ─── Best Municipality Recommendation ─── */}
      <BestMunicipalitySection grossMonthlyCHF={grossMonthlyCHF} chfEurRate={chfEurRate} />

      {/* Disclaimer */}
      <div className="bg-amber-50 dark:bg-amber-950/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('residency.disclaimer')}</p>
      </div>
    </div>
  );
};

export default ResidencySimulator;

/* ─── Best Municipality Recommendation Widget ─── */

function BestMunicipalitySection({ grossMonthlyCHF, chfEurRate }: { grossMonthlyCHF: number; chfEurRate: number }) {
  const { t } = useTranslation();
  const [priority, setPriority] = useState<'cost' | 'commute' | 'balanced'>('balanced');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterProvince, setFilterProvince] = useState<string>('');
  const [filterFascia, setFilterFascia] = useState<string>('');
  const [showAll, setShowAll] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const rankings = useMemo(() => {
    return IT_LOCATIONS.map(loc => {
      const monthlyCost = loc.avgRent + loc.groceries + loc.transport + loc.utilities;
      const irpefAnnual = grossMonthlyCHF * 12 * chfEurRate * (loc.irpefComunale ?? 0.6) / 100;
      const totalMonthlyCost = monthlyCost + irpefAnnual / 12;
      const commuteScore = (loc.distanceToBorderKm ?? 50) + (loc.avgQueueMinutes ?? 15) * 2;
      
      let score: number;
      if (priority === 'cost') {
        score = totalMonthlyCost;
      } else if (priority === 'commute') {
        score = commuteScore * 50;
      } else {
        score = totalMonthlyCost * 0.6 + commuteScore * 15;
      }
      
      return {
        ...loc,
        totalMonthlyCost: Math.round(totalMonthlyCost),
        irpefComunaleAnnual: Math.round(irpefAnnual),
        commuteScore,
        score,
      };
    }).sort((a, b) => a.score - b.score);
  }, [grossMonthlyCHF, chfEurRate, priority]);

  // Apply search & filters
  const filteredRankings = useMemo(() => {
    let results = rankings;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      results = results.filter(l => l.name.toLowerCase().includes(q) || (l.province ?? '').toLowerCase().includes(q));
    }
    if (filterProvince) {
      results = results.filter(l => l.province === filterProvince);
    }
    if (filterFascia) {
      results = results.filter(l => l.fascia === filterFascia);
    }
    return results;
  }, [rankings, searchQuery, filterProvince, filterFascia]);

  const displayedRankings = showAll || searchQuery || filterProvince || filterFascia 
    ? filteredRankings 
    : filteredRankings.slice(0, 10);

  const provinces = [...new Set(IT_LOCATIONS.map(l => l.province).filter(Boolean))].sort() as string[];
  const best = filteredRankings[0];
  const hasActiveFilters = searchQuery || filterProvince || filterFascia;

  return (
    <div className="bg-gradient-to-br from-violet-50 to-violet-100 dark:from-violet-950/20 dark:to-violet-900/20 rounded-2xl p-4 sm:p-6 border border-violet-200 dark:border-violet-800 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Star className="w-6 h-6 text-violet-600 dark:text-violet-400" />
          <h3 className="text-lg font-bold text-violet-900 dark:text-violet-100">{t('residency.bestMunicipality.title')}</h3>
        </div>
        <span className="text-xs text-violet-600 dark:text-violet-400 font-medium bg-violet-100 dark:bg-violet-900/40 px-2.5 py-1 rounded-full">
          {IT_LOCATIONS.length} {t('residency.bestMunicipality.municipalities') || 'comuni'}
        </span>
      </div>

      {/* Priority selector */}
      <div className="flex flex-wrap gap-2">
        {(['balanced', 'cost', 'commute'] as const).map(p => (
          <button
            key={p}
            onClick={() => setPriority(p)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-[color,background-color,border-color,box-shadow] ${
              priority === p
                ? 'bg-violet-600 text-white shadow-md'
                : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-violet-400'
            }`}
          >
            {p === 'balanced' && '\u2696\uFE0F '}{p === 'cost' && '\uD83D\uDCB0 '}{p === 'commute' && '\uD83D\uDE97 '}
            {t(`residency.bestMunicipality.priority.${p}`)}
          </button>
        ))}
      </div>

      {/* Search & Filter bar */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('residency.bestMunicipality.searchPlaceholder') || 'Cerca comune...'}
              className="w-full pl-9 pr-8 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm focus:ring-2 focus:ring-violet-400 focus:border-transparent outline-none"
              aria-label={t('residency.bestMunicipality.searchPlaceholder') || 'Cerca comune'}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-600" aria-label="Pulisci ricerca">
                <X size={14} />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
              showFilters || hasActiveFilters
                ? 'bg-violet-100 dark:bg-violet-900/40 border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-violet-400'
            }`}
            aria-label={t('residency.bestMunicipality.filters') || 'Filtri'}
          >
            <SlidersHorizontal size={14} />
            <span className="hidden sm:inline">{t('residency.bestMunicipality.filters') || 'Filtri'}</span>
            {hasActiveFilters && <span className="w-2 h-2 rounded-full bg-violet-500" />}
          </button>
        </div>

        {showFilters && (
          <div className="flex flex-wrap gap-3 p-3 bg-white/60 dark:bg-slate-800/60 rounded-lg border border-slate-200 dark:border-slate-700">
            <div>
              <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">{t('residency.bestMunicipality.province') || 'Provincia'}</label>
              <select
                value={filterProvince}
                onChange={(e) => setFilterProvince(e.target.value)}
                className="px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-medium"
                aria-label={t('residency.bestMunicipality.province') || 'Provincia'}
              >
                <option value="">{t('residency.bestMunicipality.allProvinces') || 'Tutte'}</option>
                {provinces.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">{t('residency.bestMunicipality.fascia') || 'Fascia'}</label>
              <select
                value={filterFascia}
                onChange={(e) => setFilterFascia(e.target.value)}
                className="px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-medium"
                aria-label={t('residency.bestMunicipality.fascia') || 'Fascia'}
              >
                <option value="">{t('residency.bestMunicipality.allFasce') || 'Tutte'}</option>
                <option value="1">Fascia 1</option>
                <option value="1A">Fascia 1A</option>
                <option value="2">Fascia 2</option>
              </select>
            </div>
            {hasActiveFilters && (
              <button
                onClick={() => { setSearchQuery(''); setFilterProvince(''); setFilterFascia(''); }}
                className="self-end px-3 py-1.5 text-xs font-medium text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-200 transition-colors"
              >
                {t('residency.bestMunicipality.clearFilters') || 'Rimuovi filtri'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Winner */}
      {best && (
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border-2 border-violet-300 dark:border-violet-700 shadow-lg">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-2xl">{'\uD83C\uDFC6'}</span>
            <div>
              <p className="text-xs text-violet-600 dark:text-violet-400 font-semibold">{t('residency.bestMunicipality.winner')}</p>
              <p className="text-xl font-bold text-slate-800 dark:text-slate-200">{best.name}{best.province ? ` (${best.province})` : ''}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('residency.bestMunicipality.monthlyTotal')}</p>
              <p className="text-sm font-bold text-slate-700 dark:text-slate-300">€{best.totalMonthlyCost.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('residency.bestMunicipality.irpef')}</p>
              <p className="text-sm font-bold text-slate-700 dark:text-slate-300">{best.irpefComunale}%</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('residency.bestMunicipality.distance')}</p>
              <p className="text-sm font-bold text-slate-700 dark:text-slate-300">{best.distanceToBorderKm} km</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('residency.bestMunicipality.queue')}</p>
              <p className="text-sm font-bold text-slate-700 dark:text-slate-300">{best.avgQueueMinutes}' {t('residency.bestMunicipality.avg')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Results count */}
      {hasActiveFilters && (
        <p className="text-xs text-violet-600 dark:text-violet-400 font-medium">
          {filteredRankings.length} {filteredRankings.length === 1 ? 'risultato' : 'risultati'}
          {filterProvince && ` in ${filterProvince}`}
          {filterFascia && ` (Fascia ${filterFascia})`}
        </p>
      )}

      {/* Ranking list */}
      <div className="space-y-2">
        {displayedRankings.map((loc, i) => (
          <div key={loc.id} className={`flex items-center gap-3 p-3 rounded-lg ${
            i === 0 && !hasActiveFilters ? 'bg-white dark:bg-slate-800' : 'bg-white/50 dark:bg-slate-800/50'
          } border border-slate-200 dark:border-slate-700`}>
            <span className={`text-lg font-bold w-7 text-center shrink-0 ${i === 0 ? 'text-violet-600' : i === 1 ? 'text-slate-500' : 'text-slate-500'}`}>
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300 truncate">
                {loc.name} {loc.province ? <span className="text-slate-500 dark:text-slate-400 font-normal">({loc.province})</span> : ''}
                {loc.fascia && <span className="ml-1.5 text-[9px] px-1.5 py-0.5 bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 rounded-full font-medium">F{loc.fascia}</span>}
              </p>
              <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-0.5"><Navigation size={8} /> {loc.nearestCrossing}</span>
                <span className="flex items-center gap-0.5"><Car size={8} /> {loc.distanceToBorderKm} km</span>
                <span className="flex items-center gap-0.5"><Clock size={8} /> {loc.avgQueueMinutes}'</span>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-bold text-slate-700 dark:text-slate-300">€{loc.totalMonthlyCost.toLocaleString()}/m</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">IRPEF com. {loc.irpefComunale}%</p>
            </div>
          </div>
        ))}
        
        {filteredRankings.length === 0 && (
          <p className="text-center text-sm text-slate-500 dark:text-slate-400 py-4">{t('residency.bestMunicipality.noResults') || 'Nessun comune trovato con questi filtri'}</p>
        )}
      </div>

      {/* Show all / Show less */}
      {!hasActiveFilters && filteredRankings.length > 10 && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="w-full py-2.5 text-sm font-medium text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-200 bg-white/60 dark:bg-slate-800/60 rounded-lg border border-violet-200 dark:border-violet-700 transition-colors flex items-center justify-center gap-1.5"
        >
          {showAll ? (
            <><ChevronUp size={14} /> {t('residency.bestMunicipality.showLess') || `Mostra top 10`}</>
          ) : (
            <><ChevronDown size={14} /> {t('residency.bestMunicipality.showAll', { count: String(filteredRankings.length) }) || `Mostra tutti (${filteredRankings.length})`}</>
          )}
        </button>
      )}

      {/* Lead Magnet CTA */}
      <Suspense fallback={null}>
        <LeadMagnetCTA variant="relocation" delay={3000} />
      </Suspense>
      <Suspense fallback={null}><RelatedTools context="permits" /></Suspense>
    </div>
  );
}