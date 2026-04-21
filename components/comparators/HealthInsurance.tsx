import React, { useState, useMemo, useEffect, Suspense } from 'react';
import Callout from '@/components/shared/Callout';
import { Heart, Shield, AlertCircle, Info, ChevronDown, ChevronUp, TrendingDown, ExternalLink, Filter, Award, Search, Calculator, Globe, MapPin, Trophy, FileText } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import PartnerRecommendations from '@/components/shared/PartnerRecommendations';
import { lazyRetry } from '@/services/lazyRetry';
const LeadMagnetCTA = lazyRetry(() => import('@/components/shared/LeadMagnetCTA'));
const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));

import DataFreshness from '@/components/shared/DataFreshness';

type InsuranceModel = 'standard' | 'hmo' | 'hausarzt' | 'telmed';
type AgeGroup = '0-18' | '19-25' | '26+';

interface InsurerProfile {
 id: string;
 name: string;
 website: string;
 models: InsuranceModel[];
}

// ── Types for JSON data ──
interface HealthPremiumsData {
 fetchedAt: string;
 year: number;
 insurers: { id: string; name: string; website: string }[];
 communes: Record<string, { name: string; bfsNr: number; plz: string; region: number }[]>;
 premiums: Record<string, {
 type?: 'canton';
 canton: string;
 region: number | null;
 bfsNr?: number;
 insurers: Record<string, Record<string, number>>;
 }>;
 rankings: {
 cheapest: { municipality: string; canton: string; avgPremium: number; numInsurers: number }[];
 mostExpensive: { municipality: string; canton: string; avgPremium: number; numInsurers: number }[];
 };
}

// Cantons with commune-level data
const COMMUNE_DETAIL_CANTONS = ['TI', 'GR', 'VS'];

const FRANCHISES = [300, 500, 1000, 1500, 2000, 2500];
const FRANCHISES_CHILD = [0, 100, 200, 300, 400, 500, 600];

const FRANCHISE_ADJUSTMENT: Record<number, number> = {
 0: 0.08, 100: 0.05, 200: 0.02, 300: 0, 400: -0.03, 500: -0.05,
 600: -0.08, 1000: -0.15, 1500: -0.22, 2000: -0.28, 2500: -0.33,
};

const AGE_MULTIPLIER: Record<AgeGroup, number> = {
 '0-18': 0.25, '19-25': 0.75, '26+': 1.0,
};

const ACCIDENT_ADDITION = 0.07;

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

function calculatePremiumFromData(
 insurerPremiums: Record<string, number> | undefined,
 model: InsuranceModel,
 franchise: number, ageGroup: AgeGroup, withAccident: boolean
): number | null {
 if (!insurerPremiums) return null;
 const base = insurerPremiums[model] ?? insurerPremiums['standard'];
 if (base === undefined) return null;
 let p = base * (1 + (FRANCHISE_ADJUSTMENT[franchise] ?? 0)) * AGE_MULTIPLIER[ageGroup];
 if (withAccident) p *= (1 + ACCIDENT_ADDITION);
 return Math.round(p * 100) / 100;
}

export { FRANCHISES, FRANCHISES_CHILD, FRANCHISE_ADJUSTMENT, ALL_CANTONS as CANTONS };

const MODEL_LABELS: Record<InsuranceModel, string> = {
 standard: 'Standard', hausarzt: 'Medico di famiglia',
 hmo: 'HMO (Centro medico)', telmed: 'Telmed (Telefono/Online)',
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
 const [data, setData] = useState<HealthPremiumsData | null>(null);
 const [age, setAge] = useState<number>(35);
 const [canton, setCanton] = useState('TI');
 const [commune, setCommune] = useState('6823-Lugano');
 const [franchise, setFranchise] = useState(2500);
 const [model, setModel] = useState<InsuranceModel>('standard');
 const [withAccident, setWithAccident] = useState(false);
 const [searchTerm, setSearchTerm] = useState('');
 const [expandedCard, setExpandedCard] = useState<string | null>(null);

 // Load health premiums JSON. F2 A3 introduced multi-year storage under
 // `/data/health-premiums/{year}.json`; we prefer the current-year file and
 // fall back to the legacy flat path for older deploys still serving it.
 useEffect(() => {
 const year = new Date().getUTCFullYear();
 const primary = `/data/health-premiums/${year}.json`;
 const fallback = '/data/health-premiums.json';
 fetch(primary)
 .then(r => r.ok ? r.json() : null)
 .then(d => {
 if (d) { setData(d); return; }
 return fetch(fallback).then(r => r.ok ? r.json() : null).then(d2 => { if (d2) setData(d2); });
 })
 .catch(() => {});
 }, []);

 // Available communes for current canton (only TI/GR)
 const communes = useMemo(() => {
 if (!data || !COMMUNE_DETAIL_CANTONS.includes(canton)) return [];
 return (data.communes[canton] || []).sort((a, b) => a.name.localeCompare(b.name));
 }, [data, canton]);

 // Reset commune when canton changes
 useEffect(() => {
 if (!COMMUNE_DETAIL_CANTONS.includes(canton)) {
 setCommune('');
 } else if (communes.length > 0 && !commune) {
 // Default to first commune alphabetically
 const first = communes[0];
 setCommune(`${first.plz}-${first.name}`);
 }
 }, [canton, communes, commune]);

 // Resolve premium lookup key
 const premiumKey = useMemo(() => {
 if (COMMUNE_DETAIL_CANTONS.includes(canton) && commune) return commune;
 return canton;
 }, [canton, commune]);

 // Get current premiums entry
 const currentPremiums = data?.premiums[premiumKey]?.insurers;

 // Build insurer profiles from data
 const insurers: InsurerProfile[] = useMemo(() => {
 if (!data || !currentPremiums) return [];
 return data.insurers
 .filter(ins => currentPremiums[ins.id])
 .map(ins => {
 const models = Object.keys(currentPremiums[ins.id] || {}) as InsuranceModel[];
 return { id: ins.id, name: ins.name, website: ins.website, models };
 });
 }, [data, currentPremiums]);

 const ageGroup: AgeGroup = age < 19 ? '0-18' : age <= 25 ? '19-25' : '26+';
 const availableFranchises = ageGroup === '0-18' ? FRANCHISES_CHILD : FRANCHISES;
 const effectiveFranchise = availableFranchises.includes(franchise) ? franchise : availableFranchises[0];

 const results: ComputedResult[] = useMemo(() => {
 if (!currentPremiums) return [];
 const computed: ComputedResult[] = [];
 for (const insurer of insurers) {
 const premium = calculatePremiumFromData(currentPremiums[insurer.id], model, effectiveFranchise, ageGroup, withAccident);
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
 }, [currentPremiums, insurers, model, effectiveFranchise, ageGroup, withAccident]);

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
 {'Confronta i premi di ' + (data?.insurers.length || '...') + ' assicurazioni LAMal svizzere in ' + (data ? Object.keys(data.premiums).length : '...') + ' località. Inserisci i tuoi dati per trovare l\'offerta migliore.'}
 </p>
 <div className="mt-3"><DataFreshness lastUpdated={data?.fetchedAt?.slice(0, 7) || '2026-01'} source="Premi UFSP" sourceUrl="https://www.priminfo.admin.ch" variant="badge" /></div>
 </div>

 <Callout status="warning">
 <div className="text-sm text-warning">
 <p className="font-bold mb-1">Nota per frontalieri</p>
 <p>
 {'I frontalieri possono scegliere tra LAMal svizzera o SSN italiano (diritto d\'opzione). '}
 {'La scelta va comunicata entro 3 mesi dall\'inizio dell\'attività ed è '}
 <strong>irrevocabile</strong>{'. Premi indicativi — verifica su '}
 <a href="https://www.priminfo.admin.ch/it/praemien" target="_blank" rel="noopener noreferrer" className="underline font-bold">priminfo.admin.ch</a>.
 </p>
 </div>
 </Callout>

 <div className="bg-surface rounded-2xl p-5 border border-edge shadow-sm">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-wider mb-4 flex items-center gap-2">
 <Filter size={16} /> I tuoi parametri
 </h3>
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
 <div>
 <label htmlFor="hi-canton" className="block text-xs font-bold text-body mb-1.5">Cantone</label>
 <select id="hi-canton" value={canton} onChange={(e) => { setCanton(e.target.value); setCommune(''); Analytics.trackHealthInsurance('filter', e.target.value); }}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm">
 {ALL_CANTONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
 </select>
 </div>
 {COMMUNE_DETAIL_CANTONS.includes(canton) && communes.length > 0 && (
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
 <select id="hi-model" value={model} onChange={(e) => { setModel(e.target.value as InsuranceModel); Analytics.trackHealthInsurance('filter', `model_${e.target.value}`); }}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm">
 {Object.entries(MODEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
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
 <p className="text-sm text-muted">{cheapest.insurer.name} /mese</p>
 </div>
 <div className="bg-accent-subtle rounded-xl p-5 border border-accent-border">
 <div className="flex items-center gap-2 text-accent mb-1">
 <Award size={16} />
 <span className="text-xs font-bold uppercase tracking-wider">Miglior rapporto</span>
 </div>
 {(() => { const bv = filtered.find(r => r.isBestValue); return bv ? (<><p className="text-2xl font-bold text-strong">{bv.premium.toFixed(2)} CHF</p><p className="text-sm text-muted">{bv.insurer.name}</p></>) : null; })()}
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
 <p className="text-sm text-muted uppercase font-bold">Tot. max/anno</p>
 <p className="text-lg font-bold text-warning">{result.annualTotal.toFixed(0)} CHF</p>
 </div>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
 <div>
 <p className="text-xs font-bold text-subtle mb-2">Modelli disponibili</p>
 <div className="flex flex-wrap gap-1.5">
 {result.insurer.models.map(m => (
 <span key={m} className={`px-2 py-1 rounded-md text-xs font-bold ${
 m === model ? 'bg-danger-subtle text-danger ring-1 ring-danger-border'
 : 'bg-surface-raised text-muted'}`}>
 {MODEL_LABELS[m]}</span>
 ))}
 </div>
 </div>
 <div>
 <p className="text-xs font-bold text-subtle mb-2">Confronto franchige</p>
 <div className="space-y-1">
 {(ageGroup === '0-18' ? FRANCHISES_CHILD : FRANCHISES).slice(0, 4).map(f => {
 const p = calculatePremiumFromData(currentPremiums?.[result.insurer.id], model, f, ageGroup, withAccident);
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
 {cheapest && (
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
 <th scope="col" className="text-right py-2 px-2 text-subtle font-bold">{'Costo max (premi+franchigia)'}</th>
 <th scope="col" className="text-right py-2 px-2 text-subtle font-bold">Risparmio vs 300</th>
 </tr>
 </thead>
 <tbody>
 {availableFranchises.map(f => {
 const p = calculatePremiumFromData(currentPremiums?.[cheapest.insurer.id], model, f, ageGroup, withAccident);
 if (p === null) return null;
 const annual = p * 12;
 const totalMax = annual + f;
 const base300 = calculatePremiumFromData(currentPremiums?.[cheapest.insurer.id], model, availableFranchises[0], ageGroup, withAccident);
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
 {'Basato su ' + cheapest.insurer.name + ' (' + MODEL_LABELS[model] + '). Se usi poche cure mediche, la franchigia 2500 CHF costa meno in totale.'}
 </p>
 </div>
 )}

 {/* CMU vs LAMal comparison for French border workers */}
 <div className="bg-gradient-to-br from-danger-subtle to-danger-subtle rounded-2xl border border-danger-border p-6">
 <h3 className="text-lg font-bold font-display text-strong mb-4 flex items-center gap-2">
 <Globe size={20} className="text-danger" />
 CMU francese vs LAMal
 </h3>
 <p className="text-sm text-subtle mb-4">
 {'I frontalieri in Francia possono scegliere la CMU (Couverture Maladie Universelle) anziché LAMal. La CMU costa ~8% del reddito fiscale di riferimento (RFR).'}
 </p>
 <div className="grid md:grid-cols-2 gap-4 mb-4">
 <div className="p-4 bg-surface/60 rounded-xl">
 <p className="font-bold text-danger mb-2">CMU (Francia)</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>Costo: ~8% del reddito fiscale (RFR)</li>
 <li>Rimborso: ~70% per visite, ~65% farmaci</li>
 <li>Mutuelle complementare consigliata (+50-150€/mese)</li>
 <li>Cure in Francia e UE</li>
 </ul>
 </div>
 <div className="p-4 bg-surface/60 rounded-xl">
 <p className="font-bold text-danger mb-2">LAMal (Svizzera)</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>Costo: premio fisso ({cheapest ? cheapest.premium.toFixed(0) + '-' + (mostExpensive?.premium.toFixed(0) ?? '?') : '?'} CHF/mese)</li>
 <li>Franchigia: {availableFranchises[0]}-{availableFranchises[availableFranchises.length - 1]} CHF/anno</li>
 <li>Cure in Svizzera (rimborsi parziali UE)</li>
 <li>Nessuna mutuelle necessaria per base</li>
 </ul>
 </div>
 </div>
 <div className="p-4 bg-danger-subtle rounded-xl">
 <p className="text-sm text-danger">
 <strong>Nota:</strong>{' La CMU conviene generalmente per redditi bassi (<40.000 CHF). Per redditi alti LAMal è spesso più economica. Questa comparazione è informativa — i frontalieri italiani in Ticino scelgono tra LAMal e SSN.'}
 </p>
 </div>
 </div>

 <div className="bg-gradient-to-br from-danger-subtle to-warning-subtle rounded-2xl border border-danger-border p-6">
 <h3 className="text-lg font-bold font-display text-strong mb-4 flex items-center gap-2">
 <Info size={20} className="text-accent" />
 LAMal svizzera vs SSN italiano
 </h3>
 <div className="grid md:grid-cols-2 gap-4 mb-4">
 <div className="p-4 bg-surface/60 rounded-xl">
 <p className="font-bold text-accent mb-2">Scegli LAMal se:</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>Hai bisogno di cure mediche frequenti in Svizzera</li>
 <li>Vuoi tempi di attesa brevi per specialisti</li>
 <li>Hai famiglia che vive in Svizzera</li>
 </ul>
 </div>
 <div className="p-4 bg-surface/60 rounded-xl">
 <p className="font-bold text-accent mb-2">Scegli SSN se:</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>Vuoi risparmiare sul costo sanitario (SSN gratuito)</li>
 <li>Le tue cure mediche sono principalmente in Italia</li>
 <li>Preferisci non pagare premi mensili</li>
 </ul>
 </div>
 </div>
 <div className="p-4 bg-warning-subtle rounded-xl border border-warning-border">
 <p className="text-sm text-warning">
 {'La scelta tra LAMal e SSN è '}
 <strong>definitiva</strong>
 {'. Hai 3 mesi per decidere. Premi basati su dati BAG 2026. Verifica su '}
 <a href="https://www.priminfo.admin.ch/it/praemien" target="_blank" rel="noopener noreferrer" className="underline font-bold">priminfo.admin.ch</a>.
 </p>
 </div>
 </div>

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
 ]).map(({ m, desc }) => (
 <div key={m} className="p-3 bg-surface-alt/50 rounded-lg">
 <p className="text-xs font-bold text-danger">{MODEL_LABELS[m]}</p>
 <p className="text-sm text-subtle mt-1">{desc}</p>
 </div>
 ))}
 </div>
 </div>

 {/* Commune Rankings */}
 {data && data.rankings.cheapest.length > 0 && (
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

 <PartnerRecommendations context="health" />
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
