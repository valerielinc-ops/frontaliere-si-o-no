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
  pink: { bg: 'bg-pink-500', text: 'text-pink-600 dark:text-pink-400', border: 'border-pink-200 dark:border-pink-800', light: 'bg-pink-50 dark:bg-pink-950/30' },
  emerald: { bg: 'bg-emerald-700', text: 'text-emerald-700 dark:text-emerald-400', border: 'border-emerald-200 dark:border-emerald-800', light: 'bg-emerald-50 dark:bg-emerald-950/30' },
  blue: { bg: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-200 dark:border-blue-800', light: 'bg-blue-50 dark:bg-blue-950/30' },
  rose: { bg: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400', border: 'border-rose-200 dark:border-rose-800', light: 'bg-rose-50 dark:bg-rose-950/30' },
  amber: { bg: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', border: 'border-amber-200 dark:border-amber-800', light: 'bg-amber-50 dark:bg-amber-950/30' },
  teal: { bg: 'bg-teal-500', text: 'text-teal-600 dark:text-teal-400', border: 'border-teal-200 dark:border-teal-800', light: 'bg-teal-50 dark:bg-teal-950/30' },
  orange: { bg: 'bg-orange-500', text: 'text-orange-600 dark:text-orange-400', border: 'border-orange-200 dark:border-orange-800', light: 'bg-orange-50 dark:bg-orange-950/30' },
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
  
  // "Savings" is really IT-vs-CH differential. Positive = living in IT is better
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
      `${t('whatif.share.header')} "${scenarioName}"`,
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
  const defaultColor = { bg: 'bg-slate-500', text: 'text-slate-600 dark:text-slate-400', border: 'border-slate-200 dark:border-slate-700', light: 'bg-slate-50 dark:bg-slate-900/30' };
  const colors = colorMap[currentScenario.color] ?? defaultColor;

  return (
    <div className="w-full space-y-6 animate-fade-in">
      {/* Header — Fun/Playful */}
      <div className="bg-amber-50/80 dark:bg-amber-950/20 rounded-2xl p-5 sm:p-8 border border-amber-200/60 dark:border-amber-800/40 relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-4">
            <Sparkles size={32} className="text-amber-700 dark:text-amber-400" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl sm:text-3xl font-extrabold text-stone-800 dark:text-stone-100">{t('whatif.title')}</h1>
                <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold uppercase tracking-wider bg-amber-200/60 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 border border-amber-300/60 dark:border-amber-700/40 rounded-full">
                  ✨ {t('whatif.experimentalBadge')}
                </span>
              </div>
              <p className="text-stone-500 dark:text-stone-400 mt-1 text-sm">{t('whatif.subtitle')}</p>
            </div>
          </div>
          {/* Fun hint bar */}
          <div className="mt-4 bg-amber-100/60 dark:bg-amber-900/20 rounded-xl p-3 text-sm text-stone-500 dark:text-stone-400">
            <div className="flex items-center gap-2">
              <Sliders size={14} className="text-amber-700 dark:text-amber-400" />
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
                  ? `${sc.bg} text-white shadow-lg scale-105`
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:shadow-md'
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
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              {currentScenario.icon}
              {currentScenario.title}
            </h3>
            {hasChanges && (
              <button
                onClick={handleReset}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 transition-colors"
              >
                <RotateCcw size={12} />
                {t('whatif.reset')}
              </button>
            )}
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{currentScenario.description}</p>

          {/* Story Card — emotional prompt */}
          <div className={`mb-6 p-3 rounded-xl border ${colors.border} ${colors.light} relative`}>
            <div className="flex items-start gap-2">
              <MessageCircle size={14} className={`${colors.text} mt-0.5 shrink-0`} />
              <p className="text-sm italic text-slate-600 dark:text-slate-400 leading-relaxed">
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
                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">
                      {field.label}
                    </label>
                    {isChanged && (
                      <span className="text-xs font-bold text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 rounded-full">
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
                        className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full appearance-none cursor-pointer accent-amber-500"
                      />
                      <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
                        <span>{field.min?.toLocaleString('it-IT')}</span>
                        <span className={`font-bold text-base ${isChanged ? 'text-amber-600' : 'text-slate-800 dark:text-slate-200'}`}>
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
                      className="w-full px-4 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
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
                        currentVal ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600'
                      }`}
                      role="switch"
                      aria-checked={!!currentVal}
                      aria-label={field.label}
                    >
                      <div className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
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
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-900/50 rounded-xl transition-colors"
                aria-label={t('whatif.share.button')}
              >
                {shareState === 'copied' ? <Check size={16} /> : <Share2 size={16} />}
                {shareState === 'copied' ? t('whatif.share.copied') : t('whatif.share.button')}
              </button>
            </div>
          )}

          <div className={`grid grid-cols-1 sm:grid-cols-3 gap-4 ${!hasChanges ? 'opacity-40' : ''}`}>
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm">
              <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">
                🇮🇹 {t('whatif.netIT')}
              </div>
              <div className="text-2xl font-bold text-slate-800 dark:text-slate-100">
                € {Math.round(newNetIT).toLocaleString('it-IT')}
              </div>
              {hasChanges && (
                <div className={`flex items-center gap-1 mt-1 text-sm font-bold ${diffIT >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                  {diffIT >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                  {diffIT >= 0 ? '+' : ''}{Math.round(diffIT).toLocaleString('it-IT')} €
                </div>
              )}
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm">
              <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">
                🇨🇭 {t('whatif.netCH')}
              </div>
              <div className="text-2xl font-bold text-slate-800 dark:text-slate-100">
                CHF {Math.round(newNetCH).toLocaleString('it-IT')}
              </div>
              {hasChanges && (
                <div className={`flex items-center gap-1 mt-1 text-sm font-bold ${diffCH >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                  {diffCH >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                  {diffCH >= 0 ? '+' : ''}{Math.round(diffCH).toLocaleString('it-IT')} CHF
                </div>
              )}
            </div>

            <div className={`rounded-2xl border-2 p-5 shadow-sm ${bestOptionNow === 'IT' ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800' : 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800'}`}>
              <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 flex items-center gap-1">
                <ArrowLeftRight size={12} />
                {t('whatif.bestOption')}
              </div>
              <div className={`text-lg font-bold ${bestOptionNow === 'IT' ? 'text-emerald-700' : 'text-blue-600'}`}>
                {bestOptionNow === 'IT' ? '🇮🇹 ' + t('whatif.liveInItaly') : '🇨🇭 ' + t('whatif.liveInSwiss')}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {t('whatif.diffPerYear')}: <span className={`font-bold ${newDifferential >= 0 ? 'text-emerald-700' : 'text-blue-600'}`}>
                  € {Math.abs(Math.round(newDifferential)).toLocaleString('it-IT')}
                </span>
              </div>
            </div>
          </div>

          {/* Detailed Comparison */}
          {hasChanges && (
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm animate-fade-in">
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
                <Info size={20} className="text-amber-600" />
                {t('whatif.impactDetail')}
              </h3>
              <div className="space-y-3">
                {/* IT Breakdown */}
                <div className="space-y-2">
                  <div className="text-sm font-bold text-slate-600 dark:text-slate-400">🇮🇹 {t('whatif.residenceItaly')}</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <div className="text-xs text-slate-500 dark:text-slate-400">{t('whatif.grossAnnual')}</div>
                      <div className="font-bold text-slate-800 dark:text-slate-100">
                        € {Math.round(whatIfResult.itResident.grossIncome * whatIfResult.exchangeRate).toLocaleString('it-IT')}
                      </div>
                    </div>
                    <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <div className="text-xs text-slate-500 dark:text-slate-400">{t('whatif.totalTaxes')}</div>
                      <div className="font-bold text-red-600">
                        € {Math.round(whatIfResult.itResident.taxes * whatIfResult.exchangeRate).toLocaleString('it-IT')}
                      </div>
                    </div>
                    <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                      <div className="text-xs text-slate-500 dark:text-slate-400">{t('whatif.netMonthly')}</div>
                      <div className="font-bold text-emerald-700 dark:text-emerald-400">
                        € {Math.round(newNetIT).toLocaleString('it-IT')}
                      </div>
                      {diffIT !== 0 && (
                        <div className={`text-xs font-bold ${diffIT >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {diffIT >= 0 ? '↑' : '↓'} {diffIT >= 0 ? '+' : ''}{Math.round(diffIT)} €
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* CH Breakdown */}
                <div className="space-y-2">
                  <div className="text-sm font-bold text-slate-600 dark:text-slate-400">🇨🇭 {t('whatif.residenceSwiss')}</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <div className="text-xs text-slate-500 dark:text-slate-400">{t('whatif.grossAnnual')}</div>
                      <div className="font-bold text-slate-800 dark:text-slate-100">
                        CHF {Math.round(whatIfResult.chResident.grossIncome).toLocaleString('it-IT')}
                      </div>
                    </div>
                    <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <div className="text-xs text-slate-500 dark:text-slate-400">{t('whatif.totalTaxes')}</div>
                      <div className="font-bold text-red-600">
                        CHF {Math.round(whatIfResult.chResident.taxes).toLocaleString('it-IT')}
                      </div>
                    </div>
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                      <div className="text-xs text-slate-500 dark:text-slate-400">{t('whatif.netMonthly')}</div>
                      <div className="font-bold text-blue-700 dark:text-blue-400">
                        CHF {Math.round(newNetCH).toLocaleString('it-IT')}
                      </div>
                      {diffCH !== 0 && (
                        <div className={`text-xs font-bold ${diffCH >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {diffCH >= 0 ? '↑' : '↓'} {diffCH >= 0 ? '+' : ''}{Math.round(diffCH)} CHF
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Summary — clearer explanation */}
                <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
                  <div className={`p-4 rounded-xl ${bestOptionNow === 'IT' ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-blue-50 dark:bg-blue-900/20'}`}>
                    <div className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                      📊 {t('whatif.scenarioSummary')}
                    </div>
                    
                    {/* Show what actually happens with this scenario change */}
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div className="bg-white/70 dark:bg-slate-800/70 rounded-lg p-3">
                        <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('whatif.yourNetChange')}</div>
                        <div className={`text-xl font-bold ${diffIT >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {diffIT >= 0 ? '+' : ''}{Math.round(diffIT).toLocaleString('it-IT')} €/{t('common.months')}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          = {diffIT >= 0 ? '+' : ''}{Math.round(diffIT * 12).toLocaleString('it-IT')} €/{t('whatif.perYear')}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">({t('whatif.asItalyFrontier')})</div>
                      </div>
                      <div className="bg-white/70 dark:bg-slate-800/70 rounded-lg p-3">
                        <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('whatif.chComparison')}</div>
                        <div className={`text-xl font-bold ${diffCH >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {diffCH >= 0 ? '+' : ''}{Math.round(diffCH).toLocaleString('it-IT')} CHF/{t('common.months')}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          = {diffCH >= 0 ? '+' : ''}{Math.round(diffCH * 12).toLocaleString('it-IT')} CHF/{t('whatif.perYear')}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">({t('whatif.asSwissResident')})</div>
                      </div>
                    </div>

                    {/* IT vs CH advantage explanation */}
                    <div className="bg-white/50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-200/50 dark:border-slate-700/50">
                      <div className="flex items-center gap-2 text-sm">
                        <ArrowLeftRight size={14} className="text-amber-600" />
                        <span className="text-slate-600 dark:text-slate-400">{t('whatif.comparisonLabel')}:</span>
                      </div>
                      <div className={`text-lg font-bold mt-1 ${newDifferential >= 0 ? 'text-emerald-700' : 'text-blue-600'}`}>
                        {newDifferential >= 0 
                          ? `🇮🇹 ${t('whatif.italyBetterBy')} € ${Math.abs(Math.round(newDifferential)).toLocaleString('it-IT')}/${t('whatif.perYear')}`
                          : `🇨🇭 ${t('whatif.swissBetterBy')} € ${Math.abs(Math.round(newDifferential)).toLocaleString('it-IT')}/${t('whatif.perYear')}`
                        }
                      </div>
                      {hasChanges && diffDifferential !== 0 && (
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                          {t('whatif.vsCurrentScenario')}: <span className={`font-bold ${diffDifferential >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
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
            <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 rounded-2xl border-2 border-dashed border-amber-300/60 dark:border-amber-600/40 p-5 sm:p-8 text-center">
              <div className="relative inline-block">
                <Sparkles size={48} className="text-amber-400 mx-auto mb-4" />
              </div>
              <p className="text-lg font-bold text-slate-700 dark:text-slate-300">{t('whatif.modifyParams')}</p>
              <p className="text-sm text-amber-500/70 dark:text-amber-400/60 mt-1">{t('whatif.resultsRealtime')}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-3 italic">{t('whatif.nerdDisclaimer')}</p>
            </div>
          )}
        </div>
      </div>
      <Suspense fallback={null}><RelatedTools context="salary" /></Suspense>
    </div>
  );
};

export default WhatIfSimulator;
