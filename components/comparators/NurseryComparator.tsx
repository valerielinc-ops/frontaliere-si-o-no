import React, { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import type { UserProfileData } from '@/components/pages/UserProfile';
import { useTranslation } from '@/services/i18n';
import { Baby, MapPin, Euro, Clock, Phone, Globe, Star, Filter, Search, ChevronDown, ChevronUp, ExternalLink, ArrowRight } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { useNavigationOptional } from '@/services/NavigationContext';

interface Nursery {
 name: string;
 type: 'public' | 'private' | 'aziendali';
 canton: string;
 city: string;
 monthlyMin: number;
 monthlyMax: number;
 ageMin: number; // months
 ageMax: number; // months
 hours: string;
 subsidized: boolean;
 website?: string;
 waitList: 'short' | 'medium' | 'long';
}

const NURSERIES: Nursery[] = [
 { name: 'Nido Comunale Lugano', type: 'public', canton: 'TI', city: 'Lugano', monthlyMin: 400, monthlyMax: 2200, ageMin: 3, ageMax: 48, hours: '6:30-18:30', subsidized: true, waitList: 'long' },
 { name: 'Nido Comunale Bellinzona', type: 'public', canton: 'TI', city: 'Bellinzona', monthlyMin: 350, monthlyMax: 2000, ageMin: 3, ageMax: 48, hours: '6:45-18:30', subsidized: true, waitList: 'medium' },
 { name: 'Nido Comunale Locarno', type: 'public', canton: 'TI', city: 'Locarno', monthlyMin: 380, monthlyMax: 2100, ageMin: 3, ageMax: 48, hours: '7:00-18:00', subsidized: true, waitList: 'medium' },
 { name: 'Nido Comunale Mendrisio', type: 'public', canton: 'TI', city: 'Mendrisio', monthlyMin: 350, monthlyMax: 1900, ageMin: 3, ageMax: 48, hours: '6:30-18:30', subsidized: true, waitList: 'short' },
 { name: 'Nido Comunale Chiasso', type: 'public', canton: 'TI', city: 'Chiasso', monthlyMin: 300, monthlyMax: 1800, ageMin: 3, ageMax: 48, hours: '7:00-18:00', subsidized: true, waitList: 'short' },
 { name: 'Asilo Nido Piccoli Passi', type: 'private', canton: 'TI', city: 'Lugano', monthlyMin: 1800, monthlyMax: 2800, ageMin: 3, ageMax: 48, hours: '7:00-19:00', subsidized: false, waitList: 'short' },
 { name: 'Centro Infanzia Girotondo', type: 'private', canton: 'TI', city: 'Manno', monthlyMin: 1600, monthlyMax: 2500, ageMin: 3, ageMax: 48, hours: '7:00-18:30', subsidized: false, waitList: 'short' },
 { name: 'Nido Aziendale USI/SUPSI', type: 'aziendali', canton: 'TI', city: 'Lugano', monthlyMin: 800, monthlyMax: 1800, ageMin: 3, ageMax: 48, hours: '7:30-18:00', subsidized: true, waitList: 'medium' },
 { name: 'Micro-nido Il Sole', type: 'private', canton: 'TI', city: 'Bellinzona', monthlyMin: 1500, monthlyMax: 2300, ageMin: 3, ageMax: 36, hours: '7:00-18:00', subsidized: false, waitList: 'short' },
 { name: 'Nido Familiare Le Stelle', type: 'private', canton: 'TI', city: 'Locarno', monthlyMin: 1400, monthlyMax: 2200, ageMin: 3, ageMax: 36, hours: '7:30-18:00', subsidized: false, waitList: 'short' },
];

// Assegni familiari (CAF) rates Ticino 2026
const CHILD_BENEFITS_CH = {
 under16: 200, // CHF/month per child
 over16Student: 250, // CHF/month per child in education
};

// Italian deductions for asilo nido
const IT_NURSERY_DEDUCTION_MAX = 632; // EUR/year per child under 3
const IT_BONUS_NIDO_MAX = 3000; // EUR/year (ISEE < 25k)

const NurseryComparator: React.FC<{ userProfile?: UserProfileData | null }> = ({ userProfile }) => {
 const { t } = useTranslation();
 const nav = useNavigationOptional();
 const [grossSalaryCHF, setGrossSalaryCHF] = useState(8333);

 // Prefill from user profile (convert annual to monthly)
 useEffect(() => {
 if (userProfile?.grossSalary) {
 const s = parseFloat(userProfile.grossSalary);
 if (!isNaN(s) && s > 0) setGrossSalaryCHF(Math.round(s / 12));
 }
 }, [userProfile]);
 const [numChildren, setNumChildren] = useState(1);
 const [childAge, setChildAge] = useState(12); // months
 const [cityFilter, setCityFilter] = useState('all');
 const [typeFilter, setTypeFilter] = useState<'all' | 'public' | 'private' | 'aziendali'>('all');
 const [searchTerm, setSearchTerm] = useState('');
 const [showCalculator, setShowCalculator] = useState(true);

 const cities = useMemo(() => [...new Set(NURSERIES.map(n => n.city))].sort(), []);

 const filteredNurseries = useMemo(() => {
 return NURSERIES.filter(n => {
 if (cityFilter !== 'all' && n.city !== cityFilter) return false;
 if (typeFilter !== 'all' && n.type !== typeFilter) return false;
 if (childAge < n.ageMin || childAge > n.ageMax) return false;
 if (searchTerm && !n.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
 return true;
 });
 }, [cityFilter, typeFilter, childAge, searchTerm]);

 // Estimate subsidized cost based on salary (simplified Ticino model)
 const estimateSubsidizedCost = (nursery: Nursery): number => {
 if (!nursery.subsidized) return nursery.monthlyMax;
 // Ticino communes use income-based sliding scale
 const annualGross = grossSalaryCHF * 12;
 const ratio = Math.min(1, Math.max(0, (annualGross - 40000) / (140000 - 40000)));
 return Math.round(nursery.monthlyMin + ratio * (nursery.monthlyMax - nursery.monthlyMin));
 };

 const monthlyBenefitCH = numChildren * CHILD_BENEFITS_CH.under16;
 const yearlyNetCostEstimate = useMemo(() => {
 if (filteredNurseries.length === 0) return null;
 const avgCost = filteredNurseries.reduce((sum, n) => sum + estimateSubsidizedCost(n), 0) / filteredNurseries.length;
 return Math.round((avgCost - monthlyBenefitCH) * 12);
 }, [filteredNurseries, grossSalaryCHF, monthlyBenefitCH]);

 const waitListLabel = (wl: string) => {
 const colors: Record<string, string> = {
 short: 'bg-success-subtle text-success',
 medium: 'bg-warning-subtle text-warning',
 long: 'bg-danger-subtle text-danger',
 };
 return colors[wl] || colors.medium;
 };

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="bg-gradient-to-r from-warning-strong to-warning-strong rounded-2xl p-4 sm:p-6 text-on-accent">
 <div className="flex items-center gap-3 mb-2">
 <Baby size={28} />
 <h2 className="text-2xl font-bold">{t('nursery.title')}</h2>
 </div>
 <p className="text-warning text-sm">{t('nursery.subtitle')}</p>
 </div>

 {/* Cost Calculator */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <button
 onClick={() => setShowCalculator(!showCalculator)}
 className="w-full flex items-center justify-between p-4"
 >
 <h3 className="font-bold text-strong flex items-center gap-2">
 <Euro size={18} className="text-success" />
 {t('nursery.calculator')}
 </h3>
 {showCalculator ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
 </button>
 {showCalculator && (
 <div className="px-4 pb-4 space-y-4 border-t border-edge pt-4">
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
 <div>
 <label htmlFor="nursery-salary" className="block text-xs font-semibold text-subtle mb-1">
 {t('nursery.monthlySalary')}
 </label>
 <input
 id="nursery-salary"
 type="number"
 inputMode="numeric"
 value={grossSalaryCHF}
 onChange={e => setGrossSalaryCHF(Number(e.target.value))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 />
 </div>
 <div>
 <label htmlFor="nursery-children" className="block text-xs font-semibold text-subtle mb-1">
 {t('nursery.numChildren')}
 </label>
 <select
 id="nursery-children"
 value={numChildren}
 onChange={e => setNumChildren(Number(e.target.value))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 >
 {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
 </select>
 </div>
 <div>
 <label htmlFor="nursery-age" className="block text-xs font-semibold text-subtle mb-1">
 {t('nursery.childAge')}
 </label>
 <input
 id="nursery-age"
 type="number"
 inputMode="numeric"
 min={0}
 max={60}
 value={childAge}
 onChange={e => setChildAge(Number(e.target.value))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 />
 </div>
 </div>
 {/* Summary cards */}
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
 <div className="bg-success-subtle rounded-xl p-3 text-center">
 <p className="text-sm text-success font-semibold">{t('nursery.monthlyBenefit')}</p>
 <p className="text-lg font-bold text-success">CHF {monthlyBenefitCH}</p>
 </div>
 <div className="bg-neutral-subtle rounded-xl p-3 text-center border border-neutral-border">
 <p className="text-xs text-neutral font-semibold">{t('nursery.itDeduction')}</p>
 <p className="text-lg font-bold text-neutral">€{IT_NURSERY_DEDUCTION_MAX}/anno</p>
 </div>
 <div className="bg-accent-subtle rounded-xl p-3 text-center">
 <p className="text-xs text-accent font-semibold">{t('nursery.bonusNido')}</p>
 <p className="text-lg font-bold text-accent">€{IT_BONUS_NIDO_MAX.toLocaleString()}/anno</p>
 </div>
 </div>
 </div>
 )}
 </div>

 {/* Filters */}
 <div className="flex flex-wrap gap-3 items-center">
 <div className="relative flex-1 min-w-[200px]">
 <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
 <input
 type="text"
 value={searchTerm}
 onChange={e => setSearchTerm(e.target.value)}
 placeholder={t('nursery.searchPlaceholder')}
 className="w-full pl-9 pr-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 aria-label={t('nursery.searchPlaceholder')}
 />
 </div>
 <select
 value={cityFilter}
 onChange={e => setCityFilter(e.target.value)}
 className="px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 aria-label={t('nursery.filterCity')}
 >
 <option value="all">{t('nursery.allCities')}</option>
 {cities.map(c => <option key={c} value={c}>{c}</option>)}
 </select>
 <select
 value={typeFilter}
 onChange={e => setTypeFilter(e.target.value as any)}
 className="px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 aria-label={t('nursery.filterType')}
 >
 <option value="all">{t('nursery.allTypes')}</option>
 <option value="public">{t('nursery.typePublic')}</option>
 <option value="private">{t('nursery.typePrivate')}</option>
 <option value="aziendali">{t('nursery.typeCorporate')}</option>
 </select>
 </div>

 {/* Results */}
 <div className="space-y-3">
 {filteredNurseries.length === 0 ? (
 <div className="text-center py-12 text-muted">
 <Baby size={48} className="mx-auto mb-3 opacity-30" />
 <p className="font-semibold">{t('nursery.noResults')}</p>
 </div>
 ) : (
 filteredNurseries.map(nursery => {
 const estimatedCost = estimateSubsidizedCost(nursery);
 return (
 <div
 key={nursery.name}
 className="bg-surface rounded-xl border border-edge p-4 hover:shadow-md transition-shadow"
 >
 <div className="flex items-start justify-between gap-3">
 <div className="flex-1">
 <div className="flex items-center gap-2 mb-1">
 <h4 className="font-bold text-sm text-strong">{nursery.name}</h4>
 <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
 nursery.type === 'public'
 ? 'bg-accent-subtle text-accent'
 : nursery.type === 'aziendali'
 ? 'bg-accent-subtle text-accent'
 : 'bg-surface-raised text-subtle'
 }`}>
 {t(`nursery.type${nursery.type.charAt(0).toUpperCase() + nursery.type.slice(1)}`)}
 </span>
 </div>
 <div className="flex flex-wrap gap-3 text-xs text-muted">
 <span className="flex items-center gap-1"><MapPin size={12} />{nursery.city}</span>
 <span className="flex items-center gap-1"><Clock size={12} />{nursery.hours}</span>
 <span className="flex items-center gap-1"><Baby size={12} />{nursery.ageMin}-{nursery.ageMax} {t('nursery.months')}</span>
 </div>
 </div>
 <div className="text-right shrink-0">
 <p className="text-lg font-bold text-success">
 CHF {estimatedCost.toLocaleString()}
 </p>
 <p className="text-sm text-muted">{t('nursery.perMonth')}</p>
 </div>
 </div>
 <div className="flex items-center gap-2 mt-2">
 <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${waitListLabel(nursery.waitList)}`}>
 {t(`nursery.waitList.${nursery.waitList}`)}
 </span>
 {nursery.subsidized && (
 <span className="text-xs font-bold px-1.5 py-0.5 rounded-full bg-success-subtle text-success">
 {t('nursery.subsidized')}
 </span>
 )}
 </div>
 </div>
 );
 })
 )}
 </div>

 {/* Info about Italian bonus nido */}
 <div className="bg-warning-subtle rounded-xl p-4 border border-warning-border">
 <h4 className="font-bold text-sm text-warning mb-2">{t('nursery.bonusNidoInfo')}</h4>
 <p className="text-xs text-warning">{t('nursery.bonusNidoDesc')}</p>
 </div>

 {/* Cross-link to full school directory */}
 {nav && (
 <button
 onClick={() => { nav.setActiveTab('vita' as any); nav.setVitaSubTab('schools' as any); }}
 className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-accent-subtle border border-accent-border rounded-xl text-sm font-medium text-accent hover:bg-accent-subtle transition"
 aria-label={t('guide.schools.title')}
 >
 <ArrowRight size={16} />
 {t('guide.schools.title')}
 </button>
 )}
 <Suspense fallback={null}><RelatedTools context="comparison" /></Suspense>
 </div>
 );
};

export default NurseryComparator;
