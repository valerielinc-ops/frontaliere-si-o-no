import React, { useState } from 'react';
import { Home, TrendingDown, TrendingUp, MapPin, Train, Zap, Wifi, Utensils, Heart, DollarSign, BarChart3, ArrowRight, ExternalLink, Info, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useExchangeRate } from '@/services/exchangeRateService';

interface CityData {
  name: string;
  country: 'IT' | 'CH';
  region: string;
  rent1bed: number; // monthly, local currency
  rent3bed: number;
  utilities: number;
  internet: number;
  groceries: number; // monthly average for one person
  restaurant: number; // avg meal out
  transport: number; // monthly pass
  health: number; // monthly health insurance
  currency: string;
}

const CITIES: CityData[] = [
  // Swiss cities near Italian border
  {
    name: 'Lugano',
    country: 'CH',
    region: 'Ticino',
    rent1bed: 1450,
    rent3bed: 2400,
    utilities: 180,
    internet: 55,
    groceries: 650,
    restaurant: 30,
    transport: 100,
    health: 380,
    currency: 'CHF',
  },
  {
    name: 'Mendrisio',
    country: 'CH',
    region: 'Ticino',
    rent1bed: 1200,
    rent3bed: 1950,
    utilities: 160,
    internet: 55,
    groceries: 600,
    restaurant: 28,
    transport: 85,
    health: 370,
    currency: 'CHF',
  },
  {
    name: 'Chiasso',
    country: 'CH',
    region: 'Ticino',
    rent1bed: 1100,
    rent3bed: 1750,
    utilities: 155,
    internet: 55,
    groceries: 580,
    restaurant: 26,
    transport: 80,
    health: 365,
    currency: 'CHF',
  },
  {
    name: 'Bellinzona',
    country: 'CH',
    region: 'Ticino',
    rent1bed: 1300,
    rent3bed: 2100,
    utilities: 170,
    internet: 55,
    groceries: 620,
    restaurant: 28,
    transport: 90,
    health: 375,
    currency: 'CHF',
  },
  {
    name: 'Locarno',
    country: 'CH',
    region: 'Ticino',
    rent1bed: 1350,
    rent3bed: 2200,
    utilities: 175,
    internet: 55,
    groceries: 640,
    restaurant: 30,
    transport: 90,
    health: 378,
    currency: 'CHF',
  },
  // Italian cities near Swiss border
  {
    name: 'Como',
    country: 'IT',
    region: 'Lombardia',
    rent1bed: 750,
    rent3bed: 1200,
    utilities: 160,
    internet: 30,
    groceries: 380,
    restaurant: 18,
    transport: 39,
    health: 0, // SSN
    currency: 'EUR',
  },
  {
    name: 'Varese',
    country: 'IT',
    region: 'Lombardia',
    rent1bed: 650,
    rent3bed: 1050,
    utilities: 150,
    internet: 28,
    groceries: 360,
    restaurant: 16,
    transport: 39,
    health: 0,
    currency: 'EUR',
  },
  {
    name: 'Verbania',
    country: 'IT',
    region: 'Piemonte',
    rent1bed: 550,
    rent3bed: 900,
    utilities: 140,
    internet: 28,
    groceries: 340,
    restaurant: 15,
    transport: 35,
    health: 0,
    currency: 'EUR',
  },
  {
    name: 'Lecco',
    country: 'IT',
    region: 'Lombardia',
    rent1bed: 620,
    rent3bed: 1000,
    utilities: 145,
    internet: 28,
    groceries: 365,
    restaurant: 16,
    transport: 39,
    health: 0,
    currency: 'EUR',
  },
  {
    name: 'Sondrio',
    country: 'IT',
    region: 'Lombardia',
    rent1bed: 480,
    rent3bed: 780,
    utilities: 135,
    internet: 27,
    groceries: 330,
    restaurant: 14,
    transport: 35,
    health: 0,
    currency: 'EUR',
  },
];

type CompareCategory = 'rent1bed' | 'rent3bed' | 'utilities' | 'internet' | 'groceries' | 'restaurant' | 'transport' | 'health';

const CATEGORY_CONFIG: { key: CompareCategory; icon: React.ReactNode; colorIT: string; colorCH: string }[] = [
  { key: 'rent1bed', icon: <Home size={14} />, colorIT: 'bg-emerald-500', colorCH: 'bg-red-500' },
  { key: 'rent3bed', icon: <Home size={14} />, colorIT: 'bg-emerald-500', colorCH: 'bg-red-500' },
  { key: 'utilities', icon: <Zap size={14} />, colorIT: 'bg-emerald-500', colorCH: 'bg-red-500' },
  { key: 'internet', icon: <Wifi size={14} />, colorIT: 'bg-emerald-500', colorCH: 'bg-red-500' },
  { key: 'groceries', icon: <Utensils size={14} />, colorIT: 'bg-emerald-500', colorCH: 'bg-red-500' },
  { key: 'restaurant', icon: <Utensils size={14} />, colorIT: 'bg-emerald-500', colorCH: 'bg-red-500' },
  { key: 'transport', icon: <Train size={14} />, colorIT: 'bg-emerald-500', colorCH: 'bg-red-500' },
  { key: 'health', icon: <Heart size={14} />, colorIT: 'bg-emerald-500', colorCH: 'bg-red-500' },
];

const CostOfLiving: React.FC = () => {
  const { t } = useTranslation();
  const { rate: liveRate, loading: rateLoading } = useExchangeRate();
  const [exchangeRateOverride, setExchangeRateOverride] = useState<number | null>(null);
  const exchangeRate = exchangeRateOverride ?? liveRate;
  const [selectedCityCH, setSelectedCityCH] = useState('Lugano');
  const [selectedCityIT, setSelectedCityIT] = useState('Como');
  const [showAnnual, setShowAnnual] = useState(false);

  const citiesCH = CITIES.filter(c => c.country === 'CH');
  const citiesIT = CITIES.filter(c => c.country === 'IT');
  const cityCH = citiesCH.find(c => c.name === selectedCityCH)!;
  const cityIT = citiesIT.find(c => c.name === selectedCityIT)!;

  const getValueInEUR = (value: number, currency: string) => {
    return currency === 'CHF' ? value * exchangeRate : value;
  };

  const multiplier = showAnnual ? 12 : 1;

  const categories: { key: CompareCategory; label: string; icon: React.ReactNode }[] = [
    { key: 'rent1bed', label: t('costOfLiving.rent1bed'), icon: <Home size={16} /> },
    { key: 'rent3bed', label: t('costOfLiving.rent3bed'), icon: <Home size={16} /> },
    { key: 'utilities', label: t('costOfLiving.utilities'), icon: <Zap size={16} /> },
    { key: 'internet', label: t('costOfLiving.internet'), icon: <Wifi size={16} /> },
    { key: 'groceries', label: t('costOfLiving.groceries'), icon: <Utensils size={16} /> },
    { key: 'restaurant', label: t('costOfLiving.restaurant'), icon: <Utensils size={16} /> },
    { key: 'transport', label: t('costOfLiving.transport'), icon: <Train size={16} /> },
    { key: 'health', label: t('costOfLiving.health'), icon: <Heart size={16} /> },
  ];

  // Total monthly costs
  const totalCH_EUR = categories.reduce((sum, cat) => sum + getValueInEUR(cityCH[cat.key], cityCH.currency), 0) * multiplier;
  const totalIT_EUR = categories.reduce((sum, cat) => sum + getValueInEUR(cityIT[cat.key], cityIT.currency), 0) * multiplier;
  const totalSavings = totalCH_EUR - totalIT_EUR;
  const savingsPercent = totalCH_EUR > 0 ? (totalSavings / totalCH_EUR) * 100 : 0;

  const handleCityChange = (country: 'CH' | 'IT', city: string) => {
    if (country === 'CH') setSelectedCityCH(city);
    else setSelectedCityIT(city);
    Analytics.trackUIInteraction('guida', 'costo_vita', 'selettore_citta', 'cambio', `${country}:${city}`);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-violet-600 to-indigo-700 rounded-2xl p-6 text-white">
        <div className="flex items-center gap-3 mb-3">
          <BarChart3 size={28} />
          <h3 className="text-2xl font-extrabold">{t('costOfLiving.title')}</h3>
        </div>
        <p className="text-violet-200">{t('costOfLiving.subtitle')}</p>
      </div>

      {/* City Selectors + Exchange Rate */}
      <div className="grid md:grid-cols-3 gap-4">
        {/* CH City */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <label className="text-xs font-bold text-red-600 uppercase tracking-wide flex items-center gap-1">
            🇨🇭 {t('costOfLiving.swissCity')}
          </label>
          <select
            value={selectedCityCH}
            onChange={e => handleCityChange('CH', e.target.value)}
            className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 font-bold"
          >
            {citiesCH.map(c => (
              <option key={c.name} value={c.name}>{c.name} ({c.region})</option>
            ))}
          </select>
        </div>

        {/* IT City */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <label className="text-xs font-bold text-green-600 uppercase tracking-wide flex items-center gap-1">
            🇮🇹 {t('costOfLiving.italianCity')}
          </label>
          <select
            value={selectedCityIT}
            onChange={e => handleCityChange('IT', e.target.value)}
            className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 font-bold"
          >
            {citiesIT.map(c => (
              <option key={c.name} value={c.name}>{c.name} ({c.region})</option>
            ))}
          </select>
        </div>

        {/* Exchange Rate */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <label className="text-xs font-bold text-slate-500 uppercase tracking-wide flex items-center gap-2">
            {t('costOfLiving.exchangeRate')}
            {rateLoading && <RefreshCw size={12} className="animate-spin text-violet-500" />}
          </label>
          <input
            type="number"
            step="0.01"
            value={exchangeRate}
            onChange={e => setExchangeRateOverride(parseFloat(e.target.value) || null)}
            className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 font-bold"
          />
          <p className="text-xs text-slate-500 mt-1">1 CHF = {exchangeRate.toFixed(4)} EUR · <span className="text-violet-500">frankfurter.app</span></p>
        </div>
      </div>

      {/* Toggle Monthly/Annual */}
      <div className="flex justify-center">
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-1 inline-flex">
          <button
            onClick={() => setShowAnnual(false)}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${!showAnnual ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
          >
            {t('costOfLiving.monthly')}
          </button>
          <button
            onClick={() => setShowAnnual(true)}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${showAnnual ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
          >
            {t('costOfLiving.annual')}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="bg-gradient-to-br from-red-500 to-red-700 rounded-xl p-5 text-white">
          <div className="text-xs font-bold uppercase tracking-wider text-white/70">🇨🇭 {cityCH.name}</div>
          <div className="text-3xl font-black mt-1">€ {totalCH_EUR.toFixed(0)}</div>
          <div className="text-xs text-white/60">{showAnnual ? t('costOfLiving.perYear') : t('costOfLiving.perMonth')}</div>
        </div>
        <div className="bg-gradient-to-br from-green-500 to-emerald-700 rounded-xl p-5 text-white">
          <div className="text-xs font-bold uppercase tracking-wider text-white/70">🇮🇹 {cityIT.name}</div>
          <div className="text-3xl font-black mt-1">€ {totalIT_EUR.toFixed(0)}</div>
          <div className="text-xs text-white/60">{showAnnual ? t('costOfLiving.perYear') : t('costOfLiving.perMonth')}</div>
        </div>
        <div className={`rounded-xl p-5 text-white ${totalSavings > 0 ? 'bg-gradient-to-br from-emerald-500 to-teal-700' : 'bg-gradient-to-br from-amber-500 to-orange-700'}`}>
          <div className="text-xs font-bold uppercase tracking-wider text-white/70">{t('costOfLiving.savings')}</div>
          <div className="text-3xl font-black mt-1 flex items-center gap-2">
            {totalSavings > 0 ? <TrendingDown size={24} /> : <TrendingUp size={24} />}
            € {Math.abs(totalSavings).toFixed(0)}
          </div>
          <div className="text-xs text-white/80">
            {savingsPercent.toFixed(0)}% {totalSavings > 0 ? t('costOfLiving.cheaperInItaly') : t('costOfLiving.cheaperInSwitzerland')}
          </div>
        </div>
      </div>

      {/* Detailed Comparison */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="p-4 bg-slate-50 dark:bg-slate-750 border-b border-slate-200 dark:border-slate-700">
          <div className="grid grid-cols-4 text-xs font-bold text-slate-500 uppercase tracking-wider">
            <div>{t('costOfLiving.category')}</div>
            <div className="text-center">🇨🇭 {cityCH.name}</div>
            <div className="text-center">🇮🇹 {cityIT.name}</div>
            <div className="text-right">{t('costOfLiving.difference')}</div>
          </div>
        </div>

        {categories.map(cat => {
          const valCH = cityCH[cat.key] * multiplier;
          const valIT = cityIT[cat.key] * multiplier;
          const valCH_EUR = getValueInEUR(valCH, cityCH.currency);
          const valIT_EUR = getValueInEUR(valIT, cityIT.currency);
          const diff = valCH_EUR - valIT_EUR;
          const diffPercent = valCH_EUR > 0 ? (diff / valCH_EUR) * 100 : 0;
          const maxVal = Math.max(valCH_EUR, valIT_EUR);

          return (
            <div key={cat.key} className="p-4 border-b border-slate-100 dark:border-slate-700/50 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-750 transition-colors">
              <div className="grid grid-cols-4 items-center gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-violet-500">{cat.icon}</span>
                  <span className="font-bold text-sm text-slate-800 dark:text-slate-200">{cat.label}</span>
                </div>
                <div className="text-center">
                  <div className="font-black text-sm">{valCH.toFixed(0)} CHF</div>
                  <div className="text-[10px] text-slate-500">≈ € {valCH_EUR.toFixed(0)}</div>
                </div>
                <div className="text-center">
                  <div className="font-black text-sm">€ {valIT_EUR.toFixed(0)}</div>
                  {cat.key === 'health' && valIT === 0 && (
                    <div className="text-[10px] text-emerald-500 font-bold">SSN</div>
                  )}
                </div>
                <div className="text-right">
                  {diff !== 0 ? (
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
                      diff > 0 ? 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400' : 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-400'
                    }`}>
                      {diff > 0 ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
                      {Math.abs(diffPercent).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-xs text-slate-500">=</span>
                  )}
                </div>
              </div>

              {/* Bar Chart */}
              <div className="mt-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] w-4 text-center">🇨🇭</span>
                  <div className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                    <div
                      className="bg-red-500 h-full rounded-full transition-all duration-500"
                      style={{ width: `${maxVal > 0 ? (valCH_EUR / maxVal) * 100 : 0}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] w-4 text-center">🇮🇹</span>
                  <div className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                    <div
                      className="bg-emerald-500 h-full rounded-full transition-all duration-500"
                      style={{ width: `${maxVal > 0 ? (valIT_EUR / maxVal) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Frontaliere Tip */}
      <div className="bg-violet-50 dark:bg-violet-950/30 border-l-4 border-violet-500 p-4 rounded-lg">
        <div className="flex items-start gap-3">
          <DollarSign className="text-violet-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-violet-900 dark:text-violet-200">
            <p className="font-bold mb-1">{t('costOfLiving.frontaliereTipTitle')}</p>
            <p>{t('costOfLiving.frontaliereTip')}</p>
          </div>
        </div>
      </div>

      {/* Sources */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <h4 className="font-bold text-sm text-slate-700 dark:text-slate-300 mb-3 flex items-center gap-2">
          <Info size={14} /> {t('costOfLiving.sourcesTitle')}
        </h4>
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            { name: 'ImmoScout24', url: 'https://www.immoscout24.ch', flag: '🇨🇭' },
            { name: 'Homegate', url: 'https://www.homegate.ch', flag: '🇨🇭' },
            { name: 'Immobiliare.it', url: 'https://www.immobiliare.it', flag: '🇮🇹' },
            { name: 'Idealista', url: 'https://www.idealista.it', flag: '🇮🇹' },
            { name: 'Numbeo', url: 'https://www.numbeo.com', flag: '🌍' },
          ].map(source => (
            <a key={source.name} href={source.url} target="_blank" rel="noopener noreferrer"
              className="px-3 py-1.5 bg-slate-100 dark:bg-slate-700 rounded-lg hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-colors font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1">
              {source.flag} {source.name} <ExternalLink size={10} />
            </a>
          ))}
        </div>
        <p className="text-[10px] text-slate-500 mt-2">{t('costOfLiving.disclaimer')}</p>
      </div>
    </div>
  );
};

export default CostOfLiving;
