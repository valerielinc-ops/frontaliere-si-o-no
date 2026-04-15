import React, { useState, Suspense } from 'react';
import Callout from '@/components/shared/Callout';
import { Home, TrendingDown, TrendingUp, MapPin, Train, Zap, Wifi, Utensils, Heart, DollarSign, BarChart3, ArrowRight, ExternalLink, Info, RefreshCw } from 'lucide-react';
import { lazyRetry } from '@/services/lazyRetry';

const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useExchangeRate } from '@/services/exchangeRateService';
import DataFreshness from '@/components/shared/DataFreshness';

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
 { key: 'rent1bed', icon: <Home size={14} />, colorIT: 'bg-success-strong', colorCH: 'bg-danger-strong' },
 { key: 'rent3bed', icon: <Home size={14} />, colorIT: 'bg-success-strong', colorCH: 'bg-danger-strong' },
 { key: 'utilities', icon: <Zap size={14} />, colorIT: 'bg-success-strong', colorCH: 'bg-danger-strong' },
 { key: 'internet', icon: <Wifi size={14} />, colorIT: 'bg-success-strong', colorCH: 'bg-danger-strong' },
 { key: 'groceries', icon: <Utensils size={14} />, colorIT: 'bg-success-strong', colorCH: 'bg-danger-strong' },
 { key: 'restaurant', icon: <Utensils size={14} />, colorIT: 'bg-success-strong', colorCH: 'bg-danger-strong' },
 { key: 'transport', icon: <Train size={14} />, colorIT: 'bg-success-strong', colorCH: 'bg-danger-strong' },
 { key: 'health', icon: <Heart size={14} />, colorIT: 'bg-success-strong', colorCH: 'bg-danger-strong' },
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
 <div className="pb-6 border-b-2 border-warning-border">
 <div className="flex items-center gap-3 mb-3">
 <BarChart3 size={28} className="text-warning" />
 <h3 className="text-3xl sm:text-4xl font-bold font-display text-heading">{t('costOfLiving.title')}</h3>
 </div>
 <p className="text-lg text-muted">{t('costOfLiving.subtitle')}</p>
 <div className="mt-3"><DataFreshness lastUpdated="2026-01" source="Numbeo / UST" sourceUrl="https://www.numbeo.com" variant="badge" /></div>
 </div>

 {/* City Selectors + Exchange Rate */}
 <div className="grid md:grid-cols-3 gap-4">
 {/* CH City */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <label htmlFor="col-ch-city" className="text-xs font-bold text-danger uppercase tracking-wide flex items-center gap-1">
 🇨🇭 {t('costOfLiving.swissCity')}
 </label>
 <select
 id="col-ch-city"
 value={selectedCityCH}
 onChange={e => handleCityChange('CH', e.target.value)}
 className="w-full mt-1 px-3 py-2 rounded-lg border border-edge bg-surface-alt font-bold"
 >
 {citiesCH.map(c => (
 <option key={c.name} value={c.name}>{c.name} ({c.region})</option>
 ))}
 </select>
 </div>

 {/* IT City */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <label htmlFor="col-it-city" className="text-xs font-bold text-success uppercase tracking-wide flex items-center gap-1">
 🇮🇹 {t('costOfLiving.italianCity')}
 </label>
 <select
 id="col-it-city"
 value={selectedCityIT}
 onChange={e => handleCityChange('IT', e.target.value)}
 className="w-full mt-1 px-3 py-2 rounded-lg border border-edge bg-surface-alt font-bold"
 >
 {citiesIT.map(c => (
 <option key={c.name} value={c.name}>{c.name} ({c.region})</option>
 ))}
 </select>
 </div>

 {/* Exchange Rate */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <label htmlFor="col-exchange-rate" className="text-xs font-bold text-muted uppercase tracking-wide flex items-center gap-2">
 {t('costOfLiving.exchangeRate')}
 {rateLoading && <RefreshCw size={12} className="animate-spin text-warning" />}
 </label>
 <input
 id="col-exchange-rate"
 type="number"
 inputMode="decimal"
 step="0.01"
 value={exchangeRate}
 onChange={e => setExchangeRateOverride(parseFloat(e.target.value) || null)}
 className="w-full mt-1 px-3 py-2 rounded-lg border border-edge bg-surface-alt font-bold"
 />
 <p className="text-sm text-muted mt-1">1 CHF = {exchangeRate.toFixed(4)} EUR · <span className="text-link">TwelveData</span></p>
 </div>
 </div>

 {/* Toggle Monthly/Annual */}
 <div className="flex justify-center">
 <div className="bg-surface rounded-xl border border-edge p-1 inline-flex">
 <button
 onClick={() => setShowAnnual(false)}
 className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${!showAnnual ? 'bg-warning-strong-hover text-on-accent' : 'text-muted hover:bg-surface-raised'}`}
 >
 {t('costOfLiving.monthly')}
 </button>
 <button
 onClick={() => setShowAnnual(true)}
 className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${showAnnual ? 'bg-warning-strong-hover text-on-accent' : 'text-muted hover:bg-surface-raised'}`}
 >
 {t('costOfLiving.annual')}
 </button>
 </div>
 </div>

 {/* Summary Stats */}
 <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
 <div><span className="text-muted">🇨🇭 {cityCH.name}:</span>{' '}<span className="font-semibold text-heading">€ {totalCH_EUR.toFixed(0)}</span>{' '}<span className="text-muted">{showAnnual ? t('costOfLiving.perYear') : t('costOfLiving.perMonth')}</span></div>
 <div><span className="text-muted">🇮🇹 {cityIT.name}:</span>{' '}<span className="font-semibold text-heading">€ {totalIT_EUR.toFixed(0)}</span>{' '}<span className="text-muted">{showAnnual ? t('costOfLiving.perYear') : t('costOfLiving.perMonth')}</span></div>
 <div className="flex items-center gap-1">
 <span className="text-muted">{t('costOfLiving.savings')}:</span>{' '}
 {totalSavings > 0 ? <TrendingDown size={16} className="text-success" /> : <TrendingUp size={16} className="text-danger" />}
 <span className={`font-semibold ${totalSavings > 0 ? 'text-success' : 'text-danger'}`}>€ {Math.abs(totalSavings).toFixed(0)}</span>{' '}
 <span className="text-muted">({savingsPercent.toFixed(0)}% {totalSavings > 0 ? t('costOfLiving.cheaperInItaly') : t('costOfLiving.cheaperInSwitzerland')})</span>
 </div>
 </div>

 {/* Detailed Comparison */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <div className="p-4 bg-surface-alt border-b border-edge">
 <div className="hidden sm:grid grid-cols-4 text-xs font-bold text-muted uppercase tracking-wider">
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
 <div key={cat.key} className="p-4 border-b border-edge/50 last:border-b-0 hover:bg-surface-raised transition-colors">
 <div className="grid grid-cols-2 sm:grid-cols-4 items-center gap-2">
 <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
 <span className="text-warning">{cat.icon}</span>
 <span className="font-bold text-sm text-strong">{cat.label}</span>
 </div>
 <div className="text-center">
 <div className="font-bold text-sm">{valCH.toFixed(0)} CHF</div>
 <div className="text-xs text-muted">≈ € {valCH_EUR.toFixed(0)}</div>
 </div>
 <div className="text-center">
 <div className="font-bold text-sm">€ {valIT_EUR.toFixed(0)}</div>
 {cat.key === 'health' && valIT === 0 && (
 <div className="text-xs text-success font-bold">SSN</div>
 )}
 </div>
 <div className="text-right">
 {diff !== 0 ? (
 <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
 diff > 0 ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'
 }`}>
 {diff > 0 ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
 {Math.abs(diffPercent).toFixed(0)}%
 </span>
 ) : (
 <span className="text-sm text-muted">=</span>
 )}
 </div>
 </div>

 {/* Bar Chart */}
 <div className="mt-2 space-y-1">
 <div className="flex items-center gap-2">
 <span className="text-xs w-4 text-center">🇨🇭</span>
 <div className="flex-1 bg-surface-raised rounded-full h-3 overflow-hidden">
 <div
 className="bg-danger-strong h-full rounded-full transition-transform duration-500 origin-left"
 style={{ transform: `scaleX(${maxVal > 0 ? (valCH_EUR / maxVal) : 0})` }}
 />
 </div>
 </div>
 <div className="flex items-center gap-2">
 <span className="text-xs w-4 text-center">🇮🇹</span>
 <div className="flex-1 bg-surface-raised rounded-full h-3 overflow-hidden">
 <div
 className="bg-success-strong h-full rounded-full transition-transform duration-500 origin-left"
 style={{ transform: `scaleX(${maxVal > 0 ? (valIT_EUR / maxVal) : 0})` }}
 />
 </div>
 </div>
 </div>
 </div>
 );
 })}
 </div>

 {/* Frontaliere Tip */}
 <Callout status="warning" icon={<DollarSign size={20} />}>
 <div className="text-sm text-warning">
 <p className="font-bold mb-1">{t('costOfLiving.frontaliereTipTitle')}</p>
 <p>{t('costOfLiving.frontaliereTip')}</p>
 </div>
 </Callout>

 {/* Sources */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <h4 className="font-bold text-sm text-body mb-3 flex items-center gap-2">
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
 className="px-3 py-1.5 bg-surface-raised rounded-lg hover:bg-warning-subtle transition-colors font-bold text-body flex items-center gap-1">
 {source.flag} {source.name} <ExternalLink size={10} />
 </a>
 ))}
 </div>
 <p className="text-xs text-muted mt-2">{t('costOfLiving.disclaimer')}</p>
 </div>
 <Suspense fallback={null}><RelatedTools context="comparison" /></Suspense>
 </div>
 );
};

export default CostOfLiving;
