import React, { useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { Sliders, Baby, MapPin, Home, TrendingUp, TrendingDown, DollarSign, Heart, HeartCrack, RotateCcw, Zap, Info, ArrowLeftRight, Sparkles, AlertTriangle, Clock, Share2, Check, Copy, MessageCircle } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { calculateSimulation } from '@/services/calculationService';
import { Analytics } from '@/services/analytics';
import { SimulationInputs, SimulationResult } from '@/types';
import { DEFAULT_INPUTS } from '@/constants';
import { useTranslation } from '@/services/i18n';
import type { UserProfileData } from '@/components/pages/UserProfile';

interface WhatIfScenario {
 id: string;
 icon: React.ReactNode;
 title: string;
 description: string;
 storyPrompt: string;
 color: string;
 fields: Array<{
 key: keyof SimulationInputs;
 label: string;
 type: 'slider' | 'select' | 'toggle';
 min?: number;
 max?: number;
 step?: number;
 options?: Array<{ value: any; label: string }>;
 }>;
}

interface WhatIfSimulatorProps {
 baseInputs: SimulationInputs;
 baseResult: SimulationResult;
 userProfile?: UserProfileData | null;
}

const getScenarios = (t: (key: string) => string, profile?: UserProfileData | null, currentExchangeRate?: number, baseInputsRef?: number): WhatIfScenario[] => {
 const rate = currentExchangeRate ?? 1.06;
 const exchangeMin = Math.max(0.50, Math.round((rate - 0.20) * 100) / 100);
 const exchangeMax = Math.round((rate + 0.20) * 100) / 100;
 // Contextual scenario titles based on profile
 const isMarried = profile?.familySituation === 'married';
 const hasChildren = parseInt(profile?.children || '0') > 0;

 return [
 {
 id: 'child',
 icon: <Baby size={24} />,
 title: hasChildren ? t('whatif.scenario.child.hasKids') : t('whatif.scenario.child'),
 description: hasChildren ? t('whatif.scenario.child.hasKids.desc') : t('whatif.scenario.child.desc'),
 storyPrompt: hasChildren ? t('whatif.story.child.hasKids') : t('whatif.story.child'),
 color: 'pink',
 fields: [
 { key: 'children', label: t('whatif.field.children'), type: 'slider', min: 0, max: 5, step: 1 },
 { key: 'familyMembers', label: t('whatif.field.familyMembers'), type: 'slider', min: 1, max: 6, step: 1 },
 ],
 },
 {
 id: 'salary',
 icon: <DollarSign size={24} />,
 title: t('whatif.scenario.salary'),
 description: t('whatif.scenario.salary.desc'),
 storyPrompt: t('whatif.story.salary'),
 color: 'emerald',
 fields: [
 { key: 'annualIncomeCHF', label: t('whatif.field.salary'), type: 'slider', min: 40000, max: 250000, step: 5000 },
 ],
 },
 {
 id: 'residence',
 icon: <Home size={24} />,
 title: t('whatif.scenario.residence'),
 description: t('whatif.scenario.residence.desc'),
 storyPrompt: t('whatif.story.residence'),
 color: 'blue',
 fields: [
 { key: 'frontierWorkerType', label: t('whatif.field.frontierType'), type: 'select', options: [
 { value: 'NEW', label: t('whatif.field.frontierNew') },
 { value: 'OLD', label: t('whatif.field.frontierOld') },
 ]},
 { key: 'distanceZone', label: t('whatif.field.distanceZone'), type: 'select', options: [
 { value: 'WITHIN_20KM', label: t('whatif.field.within20km') },
 { value: 'OVER_20KM', label: t('whatif.field.over20km') },
 ]},
 ],
 },
 {
 id: 'marital',
 icon: <Heart size={24} />,
 title: isMarried ? t('whatif.scenario.marital.ifSingle') : t('whatif.scenario.marital'),
 description: isMarried ? t('whatif.scenario.marital.ifSingle.desc') : t('whatif.scenario.marital.desc'),
 storyPrompt: isMarried ? t('whatif.story.marital.ifSingle') : t('whatif.story.marital'),
 color: 'rose',
 fields: [
 { key: 'maritalStatus', label: t('whatif.field.maritalStatus'), type: 'select', options: [
 { value: 'SINGLE', label: t('input.single') },
 { value: 'MARRIED', label: t('input.married') },
 { value: 'DIVORCED', label: t('input.divorced') },
 { value: 'WIDOWED', label: t('input.widowed') },
 ]},
 { key: 'spouseWorks', label: t('whatif.field.spouseWorks'), type: 'toggle' },
 ],
 },
 {
 id: 'age',
 icon: <Zap size={24} />,
 title: t('whatif.scenario.age'),
 description: t('whatif.scenario.age.desc'),
 storyPrompt: t('whatif.story.age'),
 color: 'amber',
 fields: [
 { key: 'age', label: t('input.age'), type: 'slider', min: 18, max: 65, step: 1 },
 ],
 },
 {
 id: 'exchange',
 icon: <ArrowLeftRight size={24} />,
 title: t('whatif.scenario.exchange'),
 description: t('whatif.scenario.exchange.desc'),
 storyPrompt: t('whatif.story.exchange'),
 color: 'teal',
 fields: [
 { key: 'customExchangeRate', label: t('whatif.field.exchangeRate'), type: 'slider', min: exchangeMin, max: exchangeMax, step: 0.01 },
 ],
 },
 {
 id: 'parttime',
 icon: <Clock size={24} />,
 title: t('whatif.scenario.parttime'),
 description: t('whatif.scenario.parttime.desc'),
 storyPrompt: t('whatif.story.parttime'),
 color: 'teal',
 fields: [
 { key: 'annualIncomeCHF', label: t('whatif.field.partTimePercent'), type: 'slider', min: Math.round(baseInputsRef * 0.4), max: baseInputsRef, step: Math.round(baseInputsRef * 0.05) || 1000 },
 ],
 },
 {
 id: 'divorce',
 icon: <HeartCrack size={24} />,
 title: t('whatif.scenario.divorce'),
 description: t('whatif.scenario.divorce.desc'),
 storyPrompt: t('whatif.story.divorce'),
 color: 'orange',
 fields: [
 { key: 'maritalStatus', label: t('whatif.field.maritalStatus'), type: 'select', options: [
 { value: 'DIVORCED', label: t('input.divorced') },
 { value: 'SINGLE', label: t('input.single') },
 { value: 'MARRIED', label: t('input.married') },
 ]},
 { key: 'children', label: t('whatif.field.childrenCustody'), type: 'slider', min: 0, max: 5, step: 1 },
 { key: 'spouseWorks', label: t('whatif.field.spouseWorks'), type: 'toggle' },
 ],
 },
]; };

const colorMap: Record<string, { bg: string; text: string; border: string; light: string }> = {
 pink: { bg: 'bg-danger-strong', text: 'text-danger', border: 'border-danger-border', light: 'bg-danger-subtle' },
 emerald: { bg: 'bg-success-strong', text: 'text-success', border: 'border-success-border', light: 'bg-success-subtle' },
 blue: { bg: 'bg-accent-strong', text: 'text-link', border: 'border-accent-border', light: 'bg-accent-subtle' },
 rose: { bg: 'bg-danger-strong', text: 'text-danger', border: 'border-danger-border', light: 'bg-danger-subtle' },
 amber: { bg: 'bg-warning-strong', text: 'text-warning', border: 'border-warning-border', light: 'bg-warning-subtle' },
 teal: { bg: 'bg-info-strong', text: 'text-info', border: 'border-info-border', light: 'bg-info-subtle' },
 orange: { bg: 'bg-warning-strong', text: 'text-warning', border: 'border-warning-border', light: 'bg-warning-subtle' },
};

const WhatIfSimulator: React.FC<WhatIfSimulatorProps> = ({ baseInputs, baseResult, userProfile }) => {
 const { t } = useTranslation();
 const [modifiedInputs, setModifiedInputs] = useState<Partial<SimulationInputs>>({});
 const [activeScenario, setActiveScenario] = useState<string>('child');
 const [shareState, setShareState] = useState<'idle' | 'copied'>('idle');

 const whatIfInputs = useMemo(() => ({
 ...baseInputs,
 ...modifiedInputs,
 }), [baseInputs, modifiedInputs]);

 const whatIfResult = useMemo(() => {
 return calculateSimulation(whatIfInputs as SimulationInputs);
 }, [whatIfInputs]);

 const handleFieldChange = (key: keyof SimulationInputs, value: any) => {
 setModifiedInputs(prev => ({ ...prev, [key]: value }));
 Analytics.trackWhatIf(activeScenario, 'change_param', `${key}:${value}`);
 };

 const handleReset = () => {
 setModifiedInputs({});
 Analytics.trackWhatIf(activeScenario, 'select', 'reset');
 };

 const handleScenarioChange = (id: string) => {
 setActiveScenario(id);
 setModifiedInputs({});
 Analytics.trackWhatIf(id, 'select');
 };

 // Calculate differences — IT net is in CHF internally, convert to EUR for display
 const baseNetIT = baseResult.itResident.netIncomeMonthly * baseResult.exchangeRate;
 const baseNetCH = baseResult.chResident.netIncomeMonthly;
 const newNetIT = whatIfResult.itResident.netIncomeMonthly * whatIfResult.exchangeRate;
 const newNetCH = whatIfResult.chResident.netIncomeMonthly;
 const diffIT = newNetIT - baseNetIT;
 const diffCH = newNetCH - baseNetCH;
 
 //"Savings" is really IT-vs-CH differential. Positive = living in IT is better
 const baseDifferential = baseResult.savingsEUR;
 const newDifferential = whatIfResult.savingsEUR;
 const diffDifferential = newDifferential - baseDifferential;
 
 // Best option for the user
 const bestOptionNow = newDifferential >= 0 ? 'IT' : 'CH';
 const bestNetNow = bestOptionNow === 'IT' ? newNetIT : newNetCH;
 const bestNetBase = bestOptionNow === 'IT' ? baseNetIT : baseNetCH;
 const bestNetDiff = bestNetNow - bestNetBase;

 const hasChanges = Object.keys(modifiedInputs).length > 0;

 // Part-time scenario percentage display
 const partTimePercent = activeScenario === 'parttime' && hasChanges
 ? Math.round(((modifiedInputs.annualIncomeCHF ?? baseInputs.annualIncomeCHF) / baseInputs.annualIncomeCHF) * 100)
 : 100;

 // Share functionality — 3-tier fallback
 const handleShare = useCallback(async () => {
 const scenarioName = currentScenarioRef?.title || '';
 const text = [
 `${t('whatif.share.header')}"${scenarioName}"`,
 '',
 `🇮🇹 ${t('whatif.netIT')}: € ${Math.round(newNetIT).toLocaleString('it-IT')}${hasChanges ? ` (${diffIT >= 0 ? '+' : ''}${Math.round(diffIT)} €)` : ''}`,
 `🇨🇭 ${t('whatif.netCH')}: CHF ${Math.round(newNetCH).toLocaleString('it-IT')}${hasChanges ? ` (${diffCH >= 0 ? '+' : ''}${Math.round(diffCH)} CHF)` : ''}`,
 '',
 bestOptionNow === 'IT'
 ? `${t('whatif.italyBetterBy')} € ${Math.abs(Math.round(newDifferential)).toLocaleString('it-IT')}/${t('whatif.perYear')}`
 : `${t('whatif.swissBetterBy')} € ${Math.abs(Math.round(newDifferential)).toLocaleString('it-IT')}/${t('whatif.perYear')}`,
 '',
 `${t('whatif.share.cta')} https://frontaliereticino.ch/calcola-stipendio/cosa-cambia-se`,
 ].join('\n');

 try {
 if (navigator.share) {
 await navigator.share({ title: t('whatif.share.header'), text });
 } else if (navigator.clipboard?.writeText) {
 await navigator.clipboard.writeText(text);
 setShareState('copied');
 setTimeout(() => setShareState('idle'), 2500);
 } else {
 const ta = document.createElement('textarea');
 ta.value = text;
 ta.style.position = 'fixed';
 ta.style.left = '-9999px';
 document.body.appendChild(ta);
 ta.select();
 document.execCommand('copy');
 document.body.removeChild(ta);
 setShareState('copied');
 setTimeout(() => setShareState('idle'), 2500);
 }
 Analytics.trackWhatIf(activeScenario, 'view_result', 'share');
 } catch { /* user cancelled share */ }
 }, [t, newNetIT, newNetCH, diffIT, diffCH, bestOptionNow, newDifferential, hasChanges, activeScenario]);

 const scenarios = getScenarios(t, userProfile, baseInputs.customExchangeRate, baseInputs.annualIncomeCHF);
 const currentScenario = scenarios.find(s => s.id === activeScenario) ?? scenarios[0];
 const currentScenarioRef = currentScenario;
 const defaultColor = { bg: 'bg-surface-alt0', text: 'text-subtle', border: 'border-edge', light: 'bg-surface-alt/30' };
 const colors = colorMap[currentScenario.color] ?? defaultColor;

 return (
 <div className="w-full space-y-6 animate-fade-in">
 {/* Header — Fun/Playful */}
 <div className="bg-warning-subtle/80 rounded-2xl p-5 sm:p-8 border border-warning-border relative overflow-hidden">
 <div className="relative z-10">
 <div className="flex items-center gap-4 mb-4">
 <Sparkles size={32} className="text-warning" />
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-3 flex-wrap">
 <h1 className="text-2xl sm:text-3xl font-extrabold font-display text-heading">{t('whatif.title')}</h1>
 <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold uppercase tracking-wider bg-warning-subtle text-warning border border-warning-border rounded-full">
 ✨ {t('whatif.experimentalBadge')}
 </span>
 </div>
 <p className="text-muted mt-1 text-sm">{t('whatif.subtitle')}</p>
 </div>
 </div>
 {/* Fun hint bar */}
 <div className="mt-4 bg-warning-subtle rounded-xl p-3 text-xs text-muted">
 <div className="flex items-center gap-2">
 <Sliders size={14} className="text-warning" />
 <span>{t('whatif.terminalHint')}</span>
 </div>
 </div>
 </div>
 </div>

 {/* Scenario Tabs */}
 <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
 {scenarios.map(scenario => {
 const sc = colorMap[scenario.color] ?? defaultColor;
 return (
 <button
 key={scenario.id}
 onClick={() => handleScenarioChange(scenario.id)}
 className={`flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl font-bold text-xs sm:text-sm transition-[color,background-color,border-color,box-shadow] ${
 activeScenario === scenario.id
 ? `${sc.bg} text-on-accent shadow-lg scale-105`
 : 'bg-surface text-subtle border border-edge hover:shadow-md'
 }`}
 >
 {scenario.icon}
 <span className="hidden sm:inline">{scenario.title}</span>
 </button>
 );
 })}
 </div>

 <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
 {/* Controls */}
 <div className={`rounded-2xl border-2 ${colors.border} p-4 sm:p-6 ${colors.light}`}>
 <div className="flex items-center justify-between mb-4">
 <h3 className="text-lg font-bold text-strong flex items-center gap-2">
 {currentScenario.icon}
 {currentScenario.title}
 </h3>
 {hasChanges && (
 <button
 onClick={handleReset}
 className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-muted hover:text-body bg-surface rounded-lg border border-edge transition-colors"
 >
 <RotateCcw size={12} />
 {t('whatif.reset')}
 </button>
 )}
 </div>
 <p className="text-sm text-muted mb-4">{currentScenario.description}</p>

 {/* Story Card — emotional prompt */}
 <div className={`mb-6 p-3 rounded-xl border ${colors.border} ${colors.light} relative`}>
 <div className="flex items-start gap-2">
 <MessageCircle size={14} className={`${colors.text} mt-0.5 shrink-0`} />
 <p className="text-sm italic text-subtle leading-relaxed">
"{currentScenario.storyPrompt}"
 </p>
 </div>
 </div>

 <div className="space-y-6">
 {currentScenario.fields.map(field => {
 const currentVal = whatIfInputs[field.key as keyof SimulationInputs];
 const baseVal = baseInputs[field.key as keyof SimulationInputs];
 const isChanged = currentVal !== baseVal;

 return (
 <div key={String(field.key)} className="space-y-2">
 <div className="flex items-center justify-between">
 <label className="text-sm font-bold text-body">
 {field.label}
 </label>
 {isChanged && (
 <span className="text-xs font-bold text-warning bg-warning-subtle px-2 py-0.5 rounded-full">
 {t('whatif.modified')}
 </span>
 )}
 </div>

 {field.type === 'slider' && (
 <div className="space-y-2">
 <input
 type="range"
 min={field.min}
 max={field.max}
 step={field.step}
 value={currentVal as number}
 onChange={(e) => handleFieldChange(field.key, Number(e.target.value))}
 aria-label={field.label}
 className="w-full h-2 bg-surface-raised rounded-full appearance-none cursor-pointer accent-warning"
 />
 <div className="flex justify-between text-xs text-muted">
 <span>{field.min?.toLocaleString('it-IT')}</span>
 <span className={`font-bold text-base ${isChanged ? 'text-warning' : 'text-strong'}`}>
 {field.key === 'customExchangeRate'
 ? `1 CHF = ${(currentVal as number).toFixed(2)} EUR`
 : (currentVal as number).toLocaleString('it-IT')}
 {field.key === 'annualIncomeCHF' && activeScenario === 'parttime' ? ` CHF (${partTimePercent}%)` : field.key === 'annualIncomeCHF' ? ' CHF' : ''}
 </span>
 <span>{field.max?.toLocaleString('it-IT')}</span>
 </div>
 </div>
 )}

 {field.type === 'select' && (
 <select
 value={currentVal as string}
 onChange={(e) => handleFieldChange(field.key, e.target.value)}
 aria-label={field.label}
 className="w-full px-4 py-2.5 bg-surface border border-edge rounded-xl text-strong font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-warning"
 >
 {field.options?.map(opt => (
 <option key={opt.value} value={opt.value}>{opt.label}</option>
 ))}
 </select>
 )}

 {field.type === 'toggle' && (
 <button
 onClick={() => handleFieldChange(field.key, !(currentVal as boolean))}
 className={`relative w-14 h-7 rounded-full transition-colors ${
 currentVal ? 'bg-warning-strong' : 'bg-surface-raised'
 }`}
 role="switch"
 aria-checked={!!currentVal}
 aria-label={field.label}
 >
 <div className={`absolute top-0.5 left-0.5 w-6 h-6 bg-surface rounded-full shadow transition-transform ${
 currentVal ? 'translate-x-7' : ''
 }`} />
 </button>
 )}
 </div>
 );
 })}
 </div>
 </div>

 {/* Impact Cards */}
 <div className="lg:col-span-2 space-y-4">
 {/* Difference Summary */}
 {/* Share button */}
 {hasChanges && (
 <div className="flex justify-end">
 <button
 onClick={handleShare}
 className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-warning bg-warning-subtle hover:bg-warning-subtle rounded-xl transition-colors"
 aria-label={t('whatif.share.button')}
 >
 {shareState === 'copied' ? <Check size={16} /> : <Share2 size={16} />}
 {shareState === 'copied' ? t('whatif.share.copied') : t('whatif.share.button')}
 </button>
 </div>
 )}

 <div className={`grid grid-cols-1 sm:grid-cols-3 gap-4 ${!hasChanges ? 'opacity-40' : ''}`}>
 <div className="bg-surface rounded-2xl border border-edge p-5 shadow-sm">
 <div className="text-xs font-bold text-muted uppercase mb-1">
 🇮🇹 {t('whatif.netIT')}
 </div>
 <div className="text-2xl font-bold text-strong">
 € {Math.round(newNetIT).toLocaleString('it-IT')}
 </div>
 {hasChanges && (
 <div className={`flex items-center gap-1 mt-1 text-sm font-bold ${diffIT >= 0 ? 'text-success' : 'text-danger'}`}>
 {diffIT >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
 {diffIT >= 0 ? '+' : ''}{Math.round(diffIT).toLocaleString('it-IT')} €
 </div>
 )}
 </div>

 <div className="bg-surface rounded-2xl border border-edge p-5 shadow-sm">
 <div className="text-xs font-bold text-muted uppercase mb-1">
 🇨🇭 {t('whatif.netCH')}
 </div>
 <div className="text-2xl font-bold text-strong">
 CHF {Math.round(newNetCH).toLocaleString('it-IT')}
 </div>
 {hasChanges && (
 <div className={`flex items-center gap-1 mt-1 text-sm font-bold ${diffCH >= 0 ? 'text-success' : 'text-danger'}`}>
 {diffCH >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
 {diffCH >= 0 ? '+' : ''}{Math.round(diffCH).toLocaleString('it-IT')} CHF
 </div>
 )}
 </div>

 <div className={`rounded-2xl border-2 p-5 shadow-sm ${bestOptionNow === 'IT' ? 'bg-success-subtle border-success-border' : 'bg-accent-subtle border-accent-border'}`}>
 <div className="text-xs font-bold text-muted uppercase mb-1 flex items-center gap-1">
 <ArrowLeftRight size={12} />
 {t('whatif.bestOption')}
 </div>
 <div className={`text-lg font-bold ${bestOptionNow === 'IT' ? 'text-success' : 'text-accent'}`}>
 {bestOptionNow === 'IT' ? '🇮🇹 ' + t('whatif.liveInItaly') : '🇨🇭 ' + t('whatif.liveInSwiss')}
 </div>
 <div className="text-xs text-muted mt-1">
 {t('whatif.diffPerYear')}: <span className={`font-bold ${newDifferential >= 0 ? 'text-success' : 'text-accent'}`}>
 € {Math.abs(Math.round(newDifferential)).toLocaleString('it-IT')}
 </span>
 </div>
 </div>
 </div>

 {/* Detailed Comparison */}
 {hasChanges && (
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm animate-fade-in">
 <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
 <Info size={20} className="text-warning" />
 {t('whatif.impactDetail')}
 </h3>
 <div className="space-y-3">
 {/* IT Breakdown */}
 <div className="space-y-2">
 <div className="text-sm font-bold text-subtle">🇮🇹 {t('whatif.residenceItaly')}</div>
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
 <div className="p-3 bg-surface-alt rounded-lg">
 <div className="text-xs text-muted">{t('whatif.grossAnnual')}</div>
 <div className="font-bold text-strong">
 € {Math.round(whatIfResult.itResident.grossIncome * whatIfResult.exchangeRate).toLocaleString('it-IT')}
 </div>
 </div>
 <div className="p-3 bg-surface-alt rounded-lg">
 <div className="text-xs text-muted">{t('whatif.totalTaxes')}</div>
 <div className="font-bold text-danger">
 € {Math.round(whatIfResult.itResident.taxes * whatIfResult.exchangeRate).toLocaleString('it-IT')}
 </div>
 </div>
 <div className="p-3 bg-success-subtle rounded-lg">
 <div className="text-xs text-muted">{t('whatif.netMonthly')}</div>
 <div className="font-bold text-success">
 € {Math.round(newNetIT).toLocaleString('it-IT')}
 </div>
 {diffIT !== 0 && (
 <div className={`text-xs font-bold ${diffIT >= 0 ? 'text-success' : 'text-danger'}`}>
 {diffIT >= 0 ? '↑' : '↓'} {diffIT >= 0 ? '+' : ''}{Math.round(diffIT)} €
 </div>
 )}
 </div>
 </div>
 </div>

 {/* CH Breakdown */}
 <div className="space-y-2">
 <div className="text-sm font-bold text-subtle">🇨🇭 {t('whatif.residenceSwiss')}</div>
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
 <div className="p-3 bg-surface-alt rounded-lg">
 <div className="text-xs text-muted">{t('whatif.grossAnnual')}</div>
 <div className="font-bold text-strong">
 CHF {Math.round(whatIfResult.chResident.grossIncome).toLocaleString('it-IT')}
 </div>
 </div>
 <div className="p-3 bg-surface-alt rounded-lg">
 <div className="text-xs text-muted">{t('whatif.totalTaxes')}</div>
 <div className="font-bold text-danger">
 CHF {Math.round(whatIfResult.chResident.taxes).toLocaleString('it-IT')}
 </div>
 </div>
 <div className="p-3 bg-accent-subtle rounded-lg">
 <div className="text-xs text-muted">{t('whatif.netMonthly')}</div>
 <div className="font-bold text-accent">
 CHF {Math.round(newNetCH).toLocaleString('it-IT')}
 </div>
 {diffCH !== 0 && (
 <div className={`text-xs font-bold ${diffCH >= 0 ? 'text-success' : 'text-danger'}`}>
 {diffCH >= 0 ? '↑' : '↓'} {diffCH >= 0 ? '+' : ''}{Math.round(diffCH)} CHF
 </div>
 )}
 </div>
 </div>
 </div>

 {/* Summary — clearer explanation */}
 <div className="border-t border-edge pt-3">
 <div className={`p-4 rounded-xl ${bestOptionNow === 'IT' ? 'bg-success-subtle' : 'bg-accent-subtle'}`}>
 <div className="text-sm font-bold text-body mb-2">
 📊 {t('whatif.scenarioSummary')}
 </div>
 
 {/* Show what actually happens with this scenario change */}
 <div className="grid grid-cols-2 gap-3 mb-3">
 <div className="bg-surface/70 rounded-lg p-3">
 <div className="text-xs font-bold text-muted uppercase">{t('whatif.yourNetChange')}</div>
 <div className={`text-xl font-bold ${diffIT >= 0 ? 'text-success' : 'text-danger'}`}>
 {diffIT >= 0 ? '+' : ''}{Math.round(diffIT).toLocaleString('it-IT')} €/{t('common.months')}
 </div>
 <div className="text-xs text-muted">
 = {diffIT >= 0 ? '+' : ''}{Math.round(diffIT * 12).toLocaleString('it-IT')} €/{t('whatif.perYear')}
 </div>
 <div className="text-xs text-muted mt-0.5">({t('whatif.asItalyFrontier')})</div>
 </div>
 <div className="bg-surface/70 rounded-lg p-3">
 <div className="text-xs font-bold text-muted uppercase">{t('whatif.chComparison')}</div>
 <div className={`text-xl font-bold ${diffCH >= 0 ? 'text-success' : 'text-danger'}`}>
 {diffCH >= 0 ? '+' : ''}{Math.round(diffCH).toLocaleString('it-IT')} CHF/{t('common.months')}
 </div>
 <div className="text-xs text-muted">
 = {diffCH >= 0 ? '+' : ''}{Math.round(diffCH * 12).toLocaleString('it-IT')} CHF/{t('whatif.perYear')}
 </div>
 <div className="text-xs text-muted mt-0.5">({t('whatif.asSwissResident')})</div>
 </div>
 </div>

 {/* IT vs CH advantage explanation */}
 <div className="bg-surface/50 rounded-lg p-3 border border-edge/50">
 <div className="flex items-center gap-2 text-sm">
 <ArrowLeftRight size={14} className="text-warning" />
 <span className="text-subtle">{t('whatif.comparisonLabel')}:</span>
 </div>
 <div className={`text-lg font-bold mt-1 ${newDifferential >= 0 ? 'text-success' : 'text-accent'}`}>
 {newDifferential >= 0 
 ? `🇮🇹 ${t('whatif.italyBetterBy')} € ${Math.abs(Math.round(newDifferential)).toLocaleString('it-IT')}/${t('whatif.perYear')}`
 : `🇨🇭 ${t('whatif.swissBetterBy')} € ${Math.abs(Math.round(newDifferential)).toLocaleString('it-IT')}/${t('whatif.perYear')}`
 }
 </div>
 {hasChanges && diffDifferential !== 0 && (
 <div className="text-xs text-muted mt-1">
 {t('whatif.vsCurrentScenario')}: <span className={`font-bold ${diffDifferential >= 0 ? 'text-success' : 'text-danger'}`}>
 {diffDifferential >= 0 ? '+' : ''}{Math.round(diffDifferential).toLocaleString('it-IT')} €
 </span>
 </div>
 )}
 </div>
 </div>
 </div>
 </div>
 </div>
 )}

 {!hasChanges && (
 <div className="bg-gradient-to-br from-warning-subtle to-warning-subtle rounded-2xl border-2 border-dashed border-warning-border p-5 sm:p-8 text-center">
 <div className="relative inline-block">
 <Sparkles size={48} className="text-warning mx-auto mb-4" />
 </div>
 <p className="text-lg font-bold text-body">{t('whatif.modifyParams')}</p>
 <p className="text-sm text-warning/70 mt-1">{t('whatif.resultsRealtime')}</p>
 <p className="text-xs text-muted mt-3 italic">{t('whatif.nerdDisclaimer')}</p>
 </div>
 )}
 </div>
 </div>
 <Suspense fallback={null}><RelatedTools context="salary" /></Suspense>
 </div>
 );
};

export default WhatIfSimulator;
