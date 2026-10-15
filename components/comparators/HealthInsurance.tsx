import React, { useState, useMemo, useEffect, useCallback, Suspense } from 'react';
import Callout from '@/components/shared/Callout';
import { Heart, Shield, AlertCircle, Info, ChevronDown, ChevronUp, TrendingDown, ExternalLink, Filter, Award, Search, Calculator, Globe, MapPin, Trophy, FileText } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import LamalSsnBreakeven, { type CheapestPremium } from '@/components/comparators/LamalSsnBreakeven';
import ProviderLogo from '@/components/shared/ProviderLogo';
import { lazyRetry } from '@/services/lazyRetry';
import { cdnDataUrl } from '@/services/cdnDataBase';
const LeadMagnetCTA = lazyRetry(() => import('@/components/shared/LeadMagnetCTA'));
const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));

import DataFreshness from '@/components/shared/DataFreshness';
import { euMonthlyPremium, statutoryEuFranchise, isCurrentEuPremiumSnapshot, domesticMonthlyPremium, domesticAgeClass, isCurrentDomesticPremiumSnapshot, type DomesticHealthPremiumsData, type EuHealthPremiums, type HealthResidence } from '@/services/healthPremiumResidency';

type InsuranceModel = 'standard' | 'hmo' | 'hausarzt' | 'telmed' | 'praxis' | 'tel_dig' | 'pharm' | 'flex';
type AgeGroup = '0-18' | '19-25' | '26+';

interface InsurerProfile {
 id: string;
 name: string;
 website: string;
 models: InsuranceModel[];
}

// ── Types for JSON data ──
// Cantons with commune-level data
const COMMUNE_DETAIL_CANTONS = ['TI', 'GR', 'VS'];

const FRANCHISES = [300, 500, 1000, 1500, 2000, 2500];
const FRANCHISES_CHILD = [0, 100, 200, 300, 400, 500, 600];

// Legacy export retained for existing consumers; the comparator now selects exact published quotes.
const FRANCHISE_ADJUSTMENT: Record<number, number> = {
 0: 0.08, 100: 0.05, 200: 0.02, 300: 0, 400: -0.03, 500: -0.05,
 600: -0.08, 1000: -0.15, 1500: -0.22, 2000: -0.28, 2500: -0.33,
};

const insurerDomain = (website: string): string | undefined => {
 try {
   return website ? new URL(website).hostname.replace(/^www\./, '') : undefined;
 } catch {
   return undefined;
 }
};

const ALL_CANTONS = [
 { value: 'TI', label: 'Ticino (TI)' },
 { value: 'GR', label: 'Grigioni (GR)' },
 { value: 'AG', label: 'Argovia (AG)' },
 { value: 'AI', label: 'Appenzello Interno (AI)' },
 { value: 'AR', label: 'Appenzello Esterno (AR)' },
 { value: 'BE', label: 'Berna (BE)' },
 { value: 'BL', label: 'Basilea Campagna (BL)' },
 { value: 'BS', label: 'Basilea Città (BS)' },
 { value: 'FR', label: 'Friburgo (FR)' },
 { value: 'GE', label: 'Ginevra (GE)' },
 { value: 'GL', label: 'Glarona (GL)' },
 { value: 'JU', label: 'Giura (JU)' },
 { value: 'LU', label: 'Lucerna (LU)' },
 { value: 'NE', label: 'Neuchâtel (NE)' },
 { value: 'NW', label: 'Nidvaldo (NW)' },
 { value: 'OW', label: 'Obvaldo (OW)' },
 { value: 'SG', label: 'San Gallo (SG)' },
 { value: 'SH', label: 'Sciaffusa (SH)' },
 { value: 'SO', label: 'Soletta (SO)' },
 { value: 'SZ', label: 'Svitto (SZ)' },
 { value: 'TG', label: 'Turgovia (TG)' },
 { value: 'UR', label: 'Uri (UR)' },
 { value: 'VD', label: 'Vaud (VD)' },
 { value: 'VS', label: 'Vallese (VS)' },
 { value: 'ZG', label: 'Zugo (ZG)' },
 { value: 'ZH', label: 'Zurigo (ZH)' },
];

export { FRANCHISES, FRANCHISES_CHILD, FRANCHISE_ADJUSTMENT, ALL_CANTONS as CANTONS };

const MODEL_LABELS: Record<InsuranceModel, string> = {
 standard: 'Standard', hausarzt: 'Medico di famiglia',
 hmo: 'HMO (Centro medico)', telmed: 'Telmed (Telefono/Online)',
 praxis: 'PRAXIS', tel_dig: 'TEL_DIG', pharm: 'PHARM', flex: 'FLEX',
};

interface ComputedResult {
 insurer: InsurerProfile;
 premium: number;
 annualCost: number;
 annualTotal: number;
 savingsVsMax: number;
 rank: number;
 isBestPrice: boolean;
 isBestValue: boolean;
}

const HealthInsurance: React.FC = () => {
 const { t } = useTranslation();
 const [data, setData] = useState<DomesticHealthPremiumsData | null>(null);
 const [euData, setEuData] = useState<EuHealthPremiums | null>(null);
 const [residence, setResidence] = useState<HealthResidence>(() => {
   const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, ''));
   return ALL_CANTONS.some(c => c.value === params.get('canton')?.toUpperCase()) ? 'CH' : 'IT';
 });
 const isItaly = residence === 'IT';
 const premiumYear = new Date().getUTCFullYear();
 // Pre-filter from URL hash (e.g. `#canton=AG&age=56-plus`), emitted by the
 // F2 LAMal-premium SEO landings (build-plugins/healthPremiumsLandingPlugin.ts)
 // as a crawler-invisible alternative to query strings.
 const initialHashFilter = (() => {
   if (typeof window === 'undefined') return { canton: 'TI', age: 35 };
   const raw = window.location.hash.replace(/^#/, '');
   if (!raw) return { canton: 'TI', age: 35 };
   const params = new URLSearchParams(raw);
   const cantonParam = (params.get('canton') || 'TI').toUpperCase();
   const ageParam = params.get('age') || '';
   const ageBracketMidpoint: Record<string, number> = {
     '0-18': 10, '19-25': 22, '26-30': 28,
     '31-45': 38, '46-55': 50, '56-plus': 60,
   };
   const ageNum = ageBracketMidpoint[ageParam] ?? 35;
   return { canton: cantonParam, age: ageNum };
 })();
 const [age, setAge] = useState<number>(initialHashFilter.age);
 const [canton, setCanton] = useState(initialHashFilter.canton);
 const [commune, setCommune] = useState('6823-Lugano');
 const [region, setRegion] = useState('1');
 const [franchise, setFranchise] = useState(300);
 const [model, setModel] = useState<InsuranceModel>('standard');
 const [withAccident, setWithAccident] = useState(false);
 const ageGroup: AgeGroup = age < 19 ? '0-18' : age <= 25 ? '19-25' : '26+';
 const [searchTerm, setSearchTerm] = useState('');
 const [expandedCard, setExpandedCard] = useState<string | null>(null);

 // Load health premiums JSON. F2 A3 introduced multi-year storage under
 // `/data/health-premiums/{year}.json`; we prefer the current-year file and
 // fall back to the legacy flat path for older deploys still serving it.
 useEffect(() => {
 const year = new Date().getUTCFullYear();
 const primary = `/data/health-premiums/${year}.json`;
 const fallback = '/data/health-premiums.json';
 fetch(cdnDataUrl(primary))
 .then(r => r.ok ? r.json() : null)
 .then(d => {
 if (isCurrentDomesticPremiumSnapshot(d, year)) { setData(d); return; }
 return fetch(cdnDataUrl(fallback)).then(r => r.ok ? r.json() : null).then(d2 => { if (isCurrentDomesticPremiumSnapshot(d2, year)) setData(d2); });
 })
 .catch(() => {});
 }, []);

 useEffect(() => {
 let active = true;
 fetch(cdnDataUrl(`/data/health-premiums-eu/${premiumYear}.json`))
   .then(response => response.ok ? response.json() : null)
   .then(value => { if (active && isCurrentEuPremiumSnapshot(value, premiumYear)) setEuData(value); })
   .catch(() => {});
 return () => { active = false; };
 }, [premiumYear]);
 const italyInsurers = euData?.countries.IT.insurers;

 // Available communes for current canton (only TI/GR)
 const communes = useMemo(() => {
 if (!data || !COMMUNE_DETAIL_CANTONS.includes(canton)) return [];
 return (data.communes[canton] || []).sort((a, b) => a.name.localeCompare(b.name));
 }, [data, canton]);

 // Reset commune when canton changes
 useEffect(() => {
 if (!COMMUNE_DETAIL_CANTONS.includes(canton)) {
 setCommune('');
 } else if (communes.length > 0 && !communes.some(entry => `${entry.plz}-${entry.name}` === commune)) {
 // Default to first commune alphabetically
 const first = communes[0];
 setCommune(`${first.plz}-${first.name}`);
 }
 }, [canton, communes, commune]);

 const availableRegions = Object.keys(data?.quotes?.[canton] || {}).sort();
 const communeRegion = communes.find(entry => `${entry.plz}-${entry.name}` === commune)?.region;
 const effectiveRegion = COMMUNE_DETAIL_CANTONS.includes(canton) && communeRegion !== undefined
   ? String(communeRegion) : availableRegions.includes(region) ? region : availableRegions[0];
 const domesticProfiles = data?.quotes?.[canton]?.[effectiveRegion];
 const domesticModels = useCallback((insurerId: string, deductible: number) =>
   domesticProfiles?.[insurerId]?.[domesticAgeClass(ageGroup)]?.[withAccident ? 'withAccident' : 'withoutAccident']?.[deductible],
 [domesticProfiles, ageGroup, withAccident]);
 const availableFranchises = isItaly ? [statutoryEuFranchise(ageGroup)] : [...new Set(
   Object.values(domesticProfiles || {}).flatMap(profile => Object.keys(profile[domesticAgeClass(ageGroup)]?.[withAccident ? 'withAccident' : 'withoutAccident'] || {}).map(Number))
 )].sort((a, b) => a - b);
 const effectiveFranchise = availableFranchises.includes(franchise) ? franchise : availableFranchises[0] ?? statutoryEuFranchise(ageGroup);

 // Build insurer profiles from data
 const insurers: InsurerProfile[] = useMemo(() => {
 if (isItaly) return Object.values(italyInsurers || {}).map(insurer => ({ ...insurer, models: ['standard'] as InsuranceModel[] }));
 if (!data || !domesticProfiles) return [];
 return data.insurers
 .filter(ins => domesticProfiles[ins.id])
 .map(ins => {
 const models = Object.keys(domesticModels(ins.id, effectiveFranchise) || {}).filter(key => key in MODEL_LABELS) as InsuranceModel[];
 return { id: ins.id, name: ins.name, website: ins.website, models };
 });
 }, [data, domesticProfiles, domesticModels, effectiveFranchise, isItaly, italyInsurers]);

 // Cheapest standard-model premium for the LAMal-vs-SSN breakeven tool
 // (#4440) — Italy-resident UFSP data, independent of the domestic canton filter.
 const computeCheapestPremium = useCallback(
 (toolFranchise: number, toolAgeGroup: AgeGroup): CheapestPremium | null => {
 if (!italyInsurers || toolFranchise !== statutoryEuFranchise(toolAgeGroup)) return null;
 let best: CheapestPremium | null = null;
 for (const ins of Object.values(italyInsurers)) {
 const p = euMonthlyPremium(ins, toolAgeGroup, false);
 if (p !== null && (best === null || p < best.premium)) {
 best = { premium: p, insurerName: ins.name, premiumYear: euData?.year, residenceCountry: 'IT', premiumSourceUrl: euData?.sourceUrl };
 }
 }
 return best;
 },
 [italyInsurers, euData],
 );

 const effectiveModel: InsuranceModel = !isItaly && insurers.some(insurer => insurer.models.includes(model)) ? model : 'standard';
 const quoteForInsurer = useCallback((insurerId: string, deductible: number) =>
   domesticMonthlyPremium(domesticProfiles?.[insurerId], ageGroup, withAccident, deductible, effectiveModel),
 [domesticProfiles, ageGroup, withAccident, effectiveModel]);

 const results: ComputedResult[] = useMemo(() => {
 if (isItaly ? !italyInsurers : !domesticProfiles) return [];
 const computed: ComputedResult[] = [];
 for (const insurer of insurers) {
 if (!insurer.models.includes(effectiveModel)) continue;
 const premium = isItaly
 ? euMonthlyPremium(italyInsurers?.[insurer.id], ageGroup, withAccident)
 : quoteForInsurer(insurer.id, effectiveFranchise);
 if (premium === null) continue;
 const annualCost = premium * 12;
 computed.push({ insurer, premium, annualCost, annualTotal: annualCost + effectiveFranchise, savingsVsMax: 0, rank: 0, isBestPrice: false, isBestValue: false });
 }
 computed.sort((a, b) => a.premium - b.premium);
 const maxCost = computed.length > 0 ? computed[computed.length - 1].annualCost : 0;
 computed.forEach((r, i) => { r.rank = i + 1; r.savingsVsMax = maxCost - r.annualCost; });
 if (computed.length > 0) {
 computed[0].isBestPrice = true;
 computed[0].isBestValue = true;
 }
 return computed;
 }, [domesticProfiles, insurers, effectiveModel, effectiveFranchise, ageGroup, withAccident, isItaly, italyInsurers, quoteForInsurer]);

 const filtered = useMemo(() => {
 if (!searchTerm.trim()) return results;
 const term = searchTerm.toLowerCase();
 return results.filter(r => r.insurer.name.toLowerCase().includes(term));
 }, [results, searchTerm]);

 const cheapest = results[0] ?? null;
 const mostExpensive = results.length > 0 ? results[results.length - 1] : null;

 return (
 <div className="space-y-6 pb-8">
 <div className="bg-gradient-to-br from-danger-strong to-danger-strong-hover rounded-2xl p-5 sm:p-8 text-on-accent">
 <div className="flex items-center gap-3 mb-3">
 <Heart size={28} />
 <h2 className="text-2xl sm:text-3xl font-bold font-display">{t('health.title')}</h2>
 </div>
 <p className="text-on-accent text-base sm:text-lg">
 {t(isItaly ? 'health.residence.italyIntro' : 'health.residence.swissIntro')} ({isItaly ? premiumYear : data?.year ?? premiumYear})
 </p>
 <div className="mt-3"><DataFreshness lastUpdated={isItaly ? euData?.fetchedAt : data?.fetchedAt} dateKind="fetched" referenceYear={isItaly ? euData?.year : data?.year} source="UFSP / Priminfo" sourceUrl={isItaly ? "https://www.priminfo.admin.ch/it/versicherungen/eu_efta" : "https://www.priminfo.admin.ch/"} variant="badge" /></div>
 </div>

 <Callout status="warning">
 <div className="text-sm text-warning">
 <p className="font-bold mb-1">Nota per frontalieri</p>
 <p>
 <span dangerouslySetInnerHTML={{ __html: t('health.warningText') }} />{' Premi indicativi — verifica su '}
 <a href="https://www.priminfo.admin.ch/it/praemien" target="_blank" rel="noopener noreferrer" className="underline font-bold">priminfo.admin.ch</a>.
 </p>
 </div>
 </Callout>

 <div className="bg-surface rounded-2xl p-5 border border-edge shadow-sm">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-wider mb-4 flex items-center gap-2">
 <Filter size={16} /> I tuoi parametri
 </h3>
 <div className="mb-4">
 <label htmlFor="hi-residence" className="block text-xs font-bold text-body mb-1.5">{t('health.residence.label')}</label>
 <select id="hi-residence" value={residence} onChange={event => { setResidence(event.target.value as HealthResidence); setModel('standard'); setFranchise(statutoryEuFranchise(ageGroup)); }} className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm">
 <option value="IT">{t('health.residence.italy')}</option><option value="CH">{t('health.residence.switzerland')}</option>
 </select>
 <p className="text-sm text-muted mt-2">{t(isItaly ? 'health.residence.italyRules' : 'health.residence.swissRules')}</p>
 {(isItaly ? !euData : !domesticProfiles || !availableFranchises.length) && <p role="status" className="text-sm text-muted mt-2">{t(isItaly ? 'health.residence.unavailable' : 'health.residence.swissUnavailable')} <a href={isItaly ? 'https://www.priminfo.admin.ch/it/versicherungen/eu_efta' : 'https://www.priminfo.admin.ch/it/praemien'} target="_blank" rel="noopener noreferrer" className="underline">Priminfo</a></p>}
 </div>
 <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
 <div>
 <label htmlFor="hi-age" className="block text-xs font-bold text-body mb-1.5">{'Età'}</label>
 <input id="hi-age" type="number" inputMode="numeric" min={0} max={99} value={age}
 onChange={(e) => setAge(Math.max(0, Math.min(99, Number(e.target.value))))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm" />
 <span className="text-sm text-muted mt-0.5 block">
 {ageGroup === '0-18' ? 'Bambino' : ageGroup === '19-25' ? 'Giovane adulto' : 'Adulto'}
 </span>
 </div>
 <div hidden={isItaly}>
 <label htmlFor="hi-canton" className="block text-xs font-bold text-body mb-1.5">Cantone</label>
 <select id="hi-canton" value={canton} onChange={(e) => { setCanton(e.target.value); setCommune(''); Analytics.trackHealthInsurance('filter', e.target.value); }}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm">
 {ALL_CANTONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
 </select>
 </div>
 {!isItaly && !COMMUNE_DETAIL_CANTONS.includes(canton) && availableRegions.length > 0 && (
 <div><label htmlFor="hi-region" className="block text-xs font-bold text-body mb-1.5">{t('health.residence.region')}</label>
 <select id="hi-region" value={effectiveRegion} onChange={event => setRegion(event.target.value)} className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm">
 {availableRegions.map(value => <option key={value} value={value}>{value}</option>)}
 </select><a href="https://www.priminfo.admin.ch/it/praemien" target="_blank" rel="noopener noreferrer" className="text-sm underline">Priminfo</a></div>
 )}
 {!isItaly && COMMUNE_DETAIL_CANTONS.includes(canton) && communes.length > 0 && (
 <div>
 <label htmlFor="hi-commune" className="block text-xs font-bold text-body mb-1.5 flex items-center gap-1">
 <MapPin size={12} /> Comune
 </label>
 <select id="hi-commune" value={commune} onChange={(e) => { setCommune(e.target.value); Analytics.trackHealthInsurance('filter', `commune_${e.target.value}`); }}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm">
 {communes.map(c => <option key={c.bfsNr} value={`${c.plz}-${c.name}`}>{c.name} ({c.plz})</option>)}
 </select>
 </div>
 )}
 <div>
 <label htmlFor="hi-franchise" className="block text-xs font-bold text-body mb-1.5">Franchigia (CHF/anno)</label>
 <select id="hi-franchise" value={effectiveFranchise} onChange={(e) => { setFranchise(Number(e.target.value)); Analytics.trackHealthInsurance('filter', `franchise_${e.target.value}`); }}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm">
 {availableFranchises.map(f => <option key={f} value={f}>{f} CHF</option>)}
 </select>
 </div>
 <div>
 <label htmlFor="hi-model" className="block text-xs font-bold text-body mb-1.5">Modello assicurativo</label>
 <select id="hi-model" value={effectiveModel} onChange={(e) => { setModel(e.target.value as InsuranceModel); Analytics.trackHealthInsurance('filter', `model_${e.target.value}`); }}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm">
 {Object.entries(MODEL_LABELS).filter(([key]) => isItaly ? key === 'standard' : key === 'standard' || insurers.some(insurer => insurer.models.includes(key as InsuranceModel))).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
 </select>
 </div>
 <div>
 <label className="block text-sm font-bold text-body mb-1.5">Copertura infortuni</label>
 <div className="flex gap-2 mt-1" role="group" aria-label="Copertura infortuni">
 <button
 onClick={() => setWithAccident(false)}
 aria-label="Senza copertura infortuni"
 className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${!withAccident ? 'bg-danger-strong text-on-accent' : 'bg-surface-raised text-subtle'}`}
 >
 Senza
 </button>
 <button
 onClick={() => setWithAccident(true)}
 aria-label="Con copertura infortuni"
 className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${withAccident ? 'bg-danger-strong text-on-accent' : 'bg-surface-raised text-subtle'}`}
 >
 Con
 </button>
 </div>
 </div>
 </div>
 </div>

 <div className="min-h-[100px]">
 {cheapest && mostExpensive && (
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
 <div className="bg-success-subtle rounded-xl p-5 border border-success-border">
 <div className="flex items-center gap-2 text-success mb-1">
 <TrendingDown size={16} />
 <span className="text-xs font-bold uppercase tracking-wider">{'Più economica'}</span>
 </div>
 <p className="text-2xl font-bold text-strong">{cheapest.premium.toFixed(2)} CHF</p>
 <div className="flex items-center gap-1.5 mt-0.5">
 {cheapest.insurer.website && (
 <ProviderLogo
 domain={insurerDomain(cheapest.insurer.website)}
 name={cheapest.insurer.name}
 size={20}
 className="rounded object-contain"
 />
 )}
 <p className="text-sm text-muted">{cheapest.insurer.name} /mese</p>
 </div>
 </div>
 <div className="bg-accent-subtle rounded-xl p-5 border border-accent-border">
 <div className="flex items-center gap-2 text-accent mb-1">
 <Award size={16} />
 <span className="text-xs font-bold uppercase tracking-wider">Miglior rapporto</span>
 </div>
 {(() => { const bv = filtered.find(r => r.isBestValue); return bv ? (<><p className="text-2xl font-bold text-strong">{bv.premium.toFixed(2)} CHF</p><div className="flex items-center gap-1.5 mt-0.5">{bv.insurer.website && (<ProviderLogo domain={insurerDomain(bv.insurer.website)} name={bv.insurer.name} size={20} className="rounded object-contain" />)}<p className="text-sm text-muted">{bv.insurer.name}</p></div></>) : null; })()}
 </div>
 <div className="bg-surface-alt/50 rounded-xl p-5 border border-edge">
 <div className="flex items-center gap-2 text-muted mb-1">
 <Info size={16} />
 <span className="text-xs font-bold uppercase tracking-wider">Risparmio max annuo</span>
 </div>
 <p className="text-2xl font-bold text-success">
 {(mostExpensive.annualCost - cheapest.annualCost).toFixed(0)} CHF
 </p>
 <p className="text-sm text-muted">{'tra la più cara e la più economica'}</p>
 </div>
 </div>
 )}
 </div>

 <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
 <div className="relative flex-1 max-w-xs">
 <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
 <input type="text" placeholder="Cerca assicurazione..." aria-label="Cerca assicurazione"
 value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
 className="w-full pl-9 pr-3 py-2 text-base rounded-lg border border-edge bg-surface-alt text-strong" />
 </div>
 <p className="text-sm text-muted">
 {filtered.length} assicurazioni trovate
 </p>
 </div>

 <div className="space-y-3 min-h-[50vh]">
 {filtered.map((result) => {
 const isExpanded = expandedCard === result.insurer.id;
 return (
 <div key={result.insurer.id}
 className={`bg-surface rounded-xl border-2 transition-[color,background-color,border-color,box-shadow] ${
 result.isBestPrice ? 'border-success-border shadow-lg'
 : result.isBestValue ? 'border-accent-border shadow-md'
 : 'border-edge hover:border-edge'}`}>
 <div className="p-4 cursor-pointer" role="button" tabIndex={0} onClick={() => { setExpandedCard(isExpanded ? null : result.insurer.id); if (!isExpanded) Analytics.trackHealthInsurance('view_provider', result.insurer.id); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedCard(isExpanded ? null : result.insurer.id); if (!isExpanded) Analytics.trackHealthInsurance('view_provider', result.insurer.id); } }} aria-expanded={isExpanded} aria-label={`${result.insurer.name} — ${isExpanded ? 'chiudi' : 'apri'} dettagli`}>
 <div className="flex items-center gap-4">
 <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${
 result.rank === 1 ? 'bg-success-subtle text-success'
 : result.rank <= 3 ? 'bg-accent-subtle text-accent'
 : 'bg-surface-raised text-muted'}`}>
 {result.rank}
 </div>
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2 flex-wrap">
 {result.insurer.website && (
 <ProviderLogo
 domain={insurerDomain(result.insurer.website)}
 name={result.insurer.name}
 size={20}
 className="rounded object-contain flex-shrink-0"
 />
 )}
 <h3 className="font-bold text-strong">{result.insurer.name}</h3>
 {result.isBestPrice && (
 <span className="px-2 py-0.5 bg-success-subtle text-success text-xs font-bold uppercase rounded-full">Migliore prezzo</span>)}
 {result.isBestValue && !result.isBestPrice && (
 <span className="px-2 py-0.5 bg-accent-subtle text-accent text-xs font-bold uppercase rounded-full">Miglior rapporto</span>)}
 </div>
 <div className="flex items-center gap-3 mt-0.5">
 <span className="text-sm text-muted">{result.insurer.models.length} modelli disponibili</span>
 </div>
 </div>
 <div className="text-right flex-shrink-0">
 <p className="text-xl sm:text-2xl font-bold text-strong">
 {result.premium.toFixed(2)} <span className="text-sm font-bold text-muted">CHF</span></p>
 <p className="text-sm text-muted">/mese</p>
 {result.savingsVsMax > 0 && result.rank <= 5 && (
 <p className="text-sm text-success font-bold mt-0.5">
 {'risparmi ' + result.savingsVsMax.toFixed(0) + ' CHF/anno'}</p>)}
 </div>
 <div className="text-muted">
 {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
 </div>
 </div>
 </div>
 {isExpanded && (
 <div className="px-4 pb-4 border-t border-edge pt-3 animate-fade-in">
 <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
 <div className="bg-surface-alt/50 rounded-lg p-3">
 <p className="text-sm text-muted uppercase font-bold">Premio mensile</p>
 <p className="text-lg font-bold text-strong">{result.premium.toFixed(2)} CHF</p>
 </div>
 <div className="bg-surface-alt/50 rounded-lg p-3">
 <p className="text-sm text-muted uppercase font-bold">Costo annuo</p>
 <p className="text-lg font-bold text-strong">{result.annualCost.toFixed(0)} CHF</p>
 </div>
 <div className="bg-surface-alt/50 rounded-lg p-3">
 <p className="text-sm text-muted uppercase font-bold">Franchigia</p>
 <p className="text-lg font-bold text-strong">{effectiveFranchise} CHF</p>
 </div>
 <div className="bg-surface-alt/50 rounded-lg p-3">
 <p className="text-sm text-muted uppercase font-bold">{t('health.residence.premiumsAndDeductible')}</p>
 <p className="text-lg font-bold text-warning">{result.annualTotal.toFixed(0)} CHF</p>
 </div>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
 <div>
 <p className="text-xs font-bold text-subtle mb-2">Modelli disponibili</p>
 <div className="flex flex-wrap gap-1.5">
 {result.insurer.models.map(m => (
 <span key={m} className={`px-2 py-1 rounded-md text-xs font-bold ${
 m === effectiveModel ? 'bg-danger-subtle text-danger ring-1 ring-danger-border'
 : 'bg-surface-raised text-muted'}`}>
 {MODEL_LABELS[m]}</span>
 ))}
 </div>
 </div>
 <div hidden={isItaly}>
 <p className="text-xs font-bold text-subtle mb-2">Confronto franchige</p>
 <div className="space-y-1">
 {availableFranchises.map(f => {
 const p = quoteForInsurer(result.insurer.id, f);
 return p !== null ? (
 <div key={f} className="flex items-center justify-between text-xs">
 <span className={`text-muted ${f === effectiveFranchise ? 'font-bold text-strong' : ''}`}>
 {f} CHF</span>
 <span className={`font-mono ${f === effectiveFranchise ? 'font-bold text-strong' : 'text-muted'}`}>
 {p.toFixed(2)} CHF/mese</span>
 </div>) : null;
 })}
 </div>
 </div>
 </div>
 <div className="flex flex-col gap-2 pt-3 border-t border-edge">
 <p className="text-sm text-muted">{t('affiliate.conditions.health')}</p>
 <a href={result.insurer.website} target="_blank" rel="noopener noreferrer"
 onClick={() => Analytics.trackExternalLink(result.insurer.website, `quote_request_${result.insurer.id}`)}
 className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-danger-strong hover:bg-danger-strong-hover text-on-accent text-sm font-bold rounded-lg transition-colors w-full">
 <FileText size={16} /> {t('health.requestQuote')}</a>
 <p className="text-sm text-muted text-center">{t('health.requestQuoteDesc')}</p>
 <a href={result.insurer.website} target="_blank" rel="noopener noreferrer"
 onClick={() => Analytics.trackExternalLink(result.insurer.website, `visit_site_${result.insurer.id}`)}
 className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-subtle hover:text-strong text-xs font-medium rounded-lg transition-colors border border-edge hover:border-edge">
 <ExternalLink size={12} /> {t('health.visitSite')}</a>
 </div>
 </div>
 )}
 </div>
 );
 })}
 </div>

 {filtered.length === 0 && (
 <div className="text-center py-12 text-muted">
 <Shield size={48} className="mx-auto mb-3 opacity-30" />
 <p className="font-bold">Nessuna assicurazione trovata</p>
 <p className="text-sm">Modifica i parametri o il termine di ricerca</p>
 </div>
 )}

 {/* Optimal franchise calculator */}
 {!isItaly && cheapest && (
 <div className="bg-surface rounded-2xl p-5 border border-edge shadow-sm">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-wider mb-4 flex items-center gap-2">
 <Calculator size={16} /> Calcola la franchigia ottimale
 </h3>
 <p className="text-sm text-muted mb-4">
 {'La franchigia ideale dipende dalle tue spese mediche previste. Franchigia alta = premio basso ma paghi di più in caso di cure.'}
 </p>
 <div className="overflow-x-auto">
 <table className="w-full text-xs">
 <caption className="sr-only">Confronto franchige assicurazioni</caption>
 <thead>
 <tr className="border-b border-edge">
 <th scope="col" className="text-left py-2 px-2 text-subtle font-bold">Franchigia</th>
 <th scope="col" className="text-right py-2 px-2 text-subtle font-bold">Premio/mese</th>
 <th scope="col" className="text-right py-2 px-2 text-subtle font-bold">Premi/anno</th>
 <th scope="col" className="text-right py-2 px-2 text-subtle font-bold">{t('health.residence.premiumsAndDeductible')}</th>
 <th scope="col" className="text-right py-2 px-2 text-subtle font-bold">Risparmio vs 300</th>
 </tr>
 </thead>
 <tbody>
 {availableFranchises.map(f => {
 const p = quoteForInsurer(cheapest.insurer.id, f);
 if (p === null) return null;
 const annual = p * 12;
 const totalMax = annual + f;
 const base300 = quoteForInsurer(cheapest.insurer.id, availableFranchises[0]);
 const base300Total = base300 !== null ? base300 * 12 + availableFranchises[0] : totalMax;
 const saving = base300Total - totalMax;
 return (
 <tr key={f} className={`border-b border-edge/50 ${f === effectiveFranchise ? 'bg-danger-subtle font-bold' : ''}`}>
 <td className="py-2 px-2 text-body">{f} CHF {f === effectiveFranchise && <span className="text-danger text-xs">← selezionata</span>}</td>
 <td className="py-2 px-2 text-right text-body">{p.toFixed(2)}</td>
 <td className="py-2 px-2 text-right text-body">{annual.toFixed(0)}</td>
 <td className="py-2 px-2 text-right text-body">{totalMax.toFixed(0)}</td>
 <td className={`py-2 px-2 text-right ${saving > 0 ? 'text-success' : saving < 0 ? 'text-danger' : 'text-muted'}`}>
 {saving > 0 ? `-${saving.toFixed(0)}` : saving < 0 ? `+${Math.abs(saving).toFixed(0)}` : '—'}
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 <p className="text-sm text-muted mt-3">
 {'Basato sui premi pubblicati di ' + cheapest.insurer.name + ' (' + MODEL_LABELS[effectiveModel] + '). Il totale mostra premi più franchigia; eventuali aliquote percentuali e altre partecipazioni ai costi sono escluse.'}
 </p>
 </div>
 )}

 {/* The country-specific SSN comparison applies only to residents in Italy. */}
 {isItaly && <div className="bg-gradient-to-br from-danger-subtle to-warning-subtle rounded-2xl border border-danger-border p-6">
 <LamalSsnBreakeven
 defaultAge={age}
 franchisesAdult={[300]}
 franchisesChild={[0]}
 computeCheapestPremium={computeCheapestPremium}
 />
 </div>}

 <div className="bg-surface rounded-2xl p-5 border border-edge">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-wider mb-3">
 Modelli assicurativi
 </h3>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 {([
 { m: 'standard' as InsuranceModel, desc: 'Libera scelta del medico. Flessibile ma costoso.' },
 { m: 'hausarzt' as InsuranceModel, desc: 'Prima il medico di famiglia. Sconto ~7%.' },
 { m: 'hmo' as InsuranceModel, desc: 'Centro medico convenzionato. Sconto ~12%.' },
 { m: 'telmed' as InsuranceModel, desc: 'Primo contatto telefonico/online. Sconto ~10%.' },
 ]).filter(({ m }) => !isItaly || m === 'standard').map(({ m, desc }) => (
 <div key={m} className="p-3 bg-surface-alt/50 rounded-lg">
 <p className="text-xs font-bold text-danger">{MODEL_LABELS[m]}</p>
 <p className="text-sm text-subtle mt-1">{desc}</p>
 </div>
 ))}
 </div>
 </div>

 {/* Commune Rankings */}
 {!isItaly && data && data.rankings.cheapest.length > 0 && (
 <div className="bg-surface rounded-2xl p-5 border border-edge shadow-sm">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-wider mb-4 flex items-center gap-2">
 <Trophy size={16} /> Classifica comuni per premio medio
 </h3>
 <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
 <div>
 <h4 className="text-xs font-bold text-success uppercase mb-3">Top 10 più economici</h4>
 <div className="space-y-1.5">
 {data.rankings.cheapest.slice(0, 10).map((c, i) => (
 <div key={c.municipality} className="flex items-center justify-between text-xs py-1.5 px-2 rounded-lg bg-success-subtle/50">
 <span className="flex items-center gap-2">
 <span className="w-5 h-5 rounded-full bg-success-subtle text-success flex items-center justify-center text-xs font-bold">{i + 1}</span>
 <span className="text-body">{c.municipality.replace(/^\d+-/, '')} <span className="text-muted">({c.canton})</span></span>
 </span>
 <span className="font-bold text-success">{c.avgPremium.toFixed(0)} CHF</span>
 </div>
 ))}
 </div>
 </div>
 <div>
 <h4 className="text-xs font-bold text-danger uppercase mb-3">Top 10 più cari</h4>
 <div className="space-y-1.5">
 {data.rankings.mostExpensive.slice(0, 10).map((c, i) => (
 <div key={c.municipality} className="flex items-center justify-between text-xs py-1.5 px-2 rounded-lg bg-danger-subtle">
 <span className="flex items-center gap-2">
 <span className="w-5 h-5 rounded-full bg-danger-subtle text-danger flex items-center justify-center text-xs font-bold">{i + 1}</span>
 <span className="text-body">{c.municipality.replace(/^\d+-/, '')} <span className="text-muted">({c.canton})</span></span>
 </span>
 <span className="font-bold text-danger">{c.avgPremium.toFixed(0)} CHF</span>
 </div>
 ))}
 </div>
 </div>
 </div>
 <p className="text-sm text-muted mt-4">
 Premio medio mensile standard (adulti 26+, franchigia 300 CHF, senza infortuni). Dati UFSP {data.year}. Comuni TI e GR.
 </p>
 </div>
 )}

 <Suspense fallback={<div className="min-h-[200px]" />}>
 <LeadMagnetCTA variant="insurance" delay={5000} />
 </Suspense>
 <Suspense fallback={<div className="min-h-[120px]" />}>
 <RelatedTools context="insurance" />
 </Suspense>
 </div>
 );
};

export default HealthInsurance;
