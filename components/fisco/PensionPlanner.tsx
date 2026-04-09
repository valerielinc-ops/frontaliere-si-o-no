import React, { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import type { UserProfileData } from '@/components/pages/UserProfile';
import { Analytics } from '@/services/analytics';
import { TrendingUp, PiggyBank, Calendar, Info, AlertCircle, CheckCircle2, Users, Home, Banknote, Calculator, Clock, Globe, Percent, Shield, Share2, Check } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import DataFreshness from '@/components/shared/DataFreshness';
const LeadMagnetCTA = lazy(() => import('@/components/shared/LeadMagnetCTA'));
const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));

interface PensionInputs {
  currentAge: number;
  retirementAge: number;
  currentSalaryCHF: number;
  yearsWorkedCH: number;
  yearsWorkedIT: number;
  plannedYearsCH: number;
  hasItalianContributions: boolean;
  contributionRatePercent: number; // LPP rate based on age
  currentLPPCapital: number;
  expectedReturnRate: number;
  repatriationPlan: 'stay_ch' | 'return_it' | 'undecided';
}

interface PensionResult {
  lppAccumulated: number;
  lppMonthlyPension: number;
  avsPensionCHF: number;
  italianPensionEUR: number;
  totalMonthlyPensionCHF: number;
  capitalAtRetirement: number;
  yearsOfContributions: {
    switzerland: number;
    italy: number;
  };
}

const InfoTooltip = ({ text }: { text: string }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('touchstart', close); };
  }, [open]);
  return (
    <button ref={ref} type="button" onClick={() => setOpen(v => !v)} aria-label="Info" className="group relative inline-flex items-center ml-1.5 cursor-help">
      <Info size={14} className="text-slate-500 dark:text-slate-400 hover:text-teal-600 transition-colors" />
      <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-slate-800 dark:bg-slate-700 text-white text-xs leading-relaxed rounded-xl shadow-2xl z-50 border border-slate-600 ${open ? 'block' : 'hidden group-hover:block'}`}>
        {text}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800 dark:border-t-slate-700"></div>
      </div>
    </button>
  );
};

const PensionPlanner: React.FC<{ userProfile?: UserProfileData | null }> = ({ userProfile }) => {
  const { t } = useTranslation();
  const [inputs, setInputs] = useState<PensionInputs>({
    currentAge: 35,
    retirementAge: 65,
    currentSalaryCHF: 100000,
    yearsWorkedCH: 5,
    yearsWorkedIT: 3,
    plannedYearsCH: 25,
    hasItalianContributions: true,
    contributionRatePercent: 7, // Default LPP rate 35-44 years
    currentLPPCapital: 25000,
    expectedReturnRate: 1.5,
    repatriationPlan: 'undecided'
  });

  // Prefill salary from user profile
  useEffect(() => {
    if (userProfile?.grossSalary) {
      const s = parseFloat(userProfile.grossSalary);
      if (!isNaN(s) && s > 0) setInputs(prev => ({ ...prev, currentSalaryCHF: s }));
    }
  }, [userProfile]);

  const handleChange = (field: keyof PensionInputs, value: any) => {
    setInputs(prev => ({ ...prev, [field]: value }));
    if (field === 'retirementAge' || field === 'currentSalaryCHF') {
      Analytics.trackPensionPlanner('change_param', inputs.retirementAge - inputs.currentAge, inputs.currentSalaryCHF);
    }
  };

  // Calculate LPP contribution rate based on age
  const getLPPRate = (age: number): number => {
    if (age < 25) return 0;
    if (age >= 25 && age <= 34) return 7;
    if (age >= 35 && age <= 44) return 10;
    if (age >= 45 && age <= 54) return 15;
    return 18; // 55+
  };

  // Calculate pension results
  const calculatePension = (): PensionResult => {
    const yearsUntilRetirement = inputs.retirementAge - inputs.currentAge;
    const avgYearlyContribution = (inputs.currentSalaryCHF * inputs.contributionRatePercent) / 100;
    
    // LPP accumulation with compound interest
    let lppTotal = inputs.currentLPPCapital;
    for (let year = 0; year < yearsUntilRetirement; year++) {
      const currentAge = inputs.currentAge + year;
      const rate = getLPPRate(currentAge);
      const contribution = (inputs.currentSalaryCHF * rate) / 100;
      lppTotal = lppTotal * (1 + inputs.expectedReturnRate / 100) + contribution;
    }

    // LPP monthly pension (conversion rate ~6.8% for 65 years old)
    const conversionRate = 0.068;
    const lppMonthlyPension = (lppTotal * conversionRate) / 12;

    // AVS calculation (simplified: full pension ~2450 CHF, proportional to years)
    const totalWorkYears = inputs.yearsWorkedCH + inputs.plannedYearsCH;
    const requiredYears = 44; // Full AVS requires 44 years
    const avsPensionCHF = Math.min((totalWorkYears / requiredYears) * 2450, 2450);

    // Italian pension (simplified: ~70% of last salary, proportional to years)
    const italianYears = inputs.yearsWorkedIT;
    const italianPensionEUR = inputs.hasItalianContributions 
      ? (italianYears / 35) * (inputs.currentSalaryCHF * 1.06 * 0.7) / 12
      : 0;

    const totalMonthlyPensionCHF = lppMonthlyPension + avsPensionCHF + (italianPensionEUR / 1.06);

    return {
      lppAccumulated: lppTotal,
      lppMonthlyPension,
      avsPensionCHF,
      italianPensionEUR,
      totalMonthlyPensionCHF,
      capitalAtRetirement: lppTotal,
      yearsOfContributions: {
        switzerland: totalWorkYears,
        italy: italianYears
      }
    };
  };

  const result = useMemo(() => calculatePension(), [inputs]);
  const yearsUntilRetirement = inputs.retirementAge - inputs.currentAge;

  const [shareState, setShareState] = useState<'idle' | 'copied'>('idle');
  const handleShare = async () => {
    const url = window.location.href;
    const title = t('pension.title');
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setShareState('copied');
        setTimeout(() => setShareState('idle'), 2500);
      }
      Analytics.trackShare('link', 'pension');
    } catch { /* user cancelled */ }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="text-center space-y-3 mb-8">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-emerald-700 dark:text-emerald-400 flex items-center justify-center gap-3">
          <PiggyBank size={28} className="text-emerald-500" />
          {t('pension.title')}
        </h1>
        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
          {t('pension.subtitle')}
        </p>
      </div>

      {/* Quick Summary — visible immediately on mobile */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm lg:hidden">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-bold text-slate-700 dark:text-slate-300">{t('pension.totalMonthlyPension')}</span>
          <span className="text-2xl font-bold text-emerald-700">
            CHF {Math.round(result.totalMonthlyPensionCHF).toLocaleString('it-IT')}
          </span>
        </div>
        <div className="flex rounded-full h-3 overflow-hidden bg-slate-100 dark:bg-slate-700">
          {result.totalMonthlyPensionCHF > 0 && (
            <>
              <div className="bg-blue-500 h-full transition-transform duration-500" style={{ width: '100%', transform: `scaleX(${result.lppMonthlyPension / result.totalMonthlyPensionCHF})`, transformOrigin: 'left' }} title="LPP" />
              <div className="bg-red-500 h-full transition-transform duration-500" style={{ width: '100%', transform: `scaleX(${result.avsPensionCHF / result.totalMonthlyPensionCHF})`, transformOrigin: 'left' }} title="AVS" />
              {inputs.hasItalianContributions && (
                <div className="bg-green-500 h-full transition-transform duration-500" style={{ width: '100%', transform: `scaleX(${(result.italianPensionEUR / 1.06) / result.totalMonthlyPensionCHF})`, transformOrigin: 'left' }} title="INPS" />
              )}
            </>
          )}
        </div>
        <div className="flex gap-4 mt-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> LPP</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> AVS</span>
          {inputs.hasItalianContributions && (
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> INPS</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Inputs */}
        <div className="space-y-4">
          {/* Personal Info */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Users className="text-emerald-700" size={20} />
              <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('pension.personalData')}</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="pp-age" className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('pension.currentAge')}
                  <InfoTooltip text={t('pension.currentAgeTooltip')} />
                </label>
                <input
                  id="pp-age"
                  type="number"
                  inputMode="numeric"
                  value={inputs.currentAge}
                  onChange={(e) => handleChange('currentAge', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  min="18"
                  max="70"
                />
              </div>

              <div>
                <label htmlFor="pp-retire" className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('pension.retirementAge')}
                  <InfoTooltip text={t('pension.retirementAgeTooltip')} />
                </label>
                <input
                  id="pp-retire"
                  type="number"
                  inputMode="numeric"
                  value={inputs.retirementAge}
                  onChange={(e) => handleChange('retirementAge', parseInt(e.target.value) || 65)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  min="55"
                  max="70"
                />
              </div>

              <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                  <Clock size={16} />
                  <span className="text-sm font-bold">
                    {yearsUntilRetirement} {t('pension.yearsToRetirement')}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Work History */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Calendar className="text-blue-600" size={20} />
              <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('pension.workHistory')}</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="pp-years-ch" className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('pension.yearsWorkedCH')}
                  <InfoTooltip text={t('pension.yearsWorkedCHTooltip')} />
                </label>
                <input
                  id="pp-years-ch"
                  type="number"
                  inputMode="numeric"
                  value={inputs.yearsWorkedCH}
                  onChange={(e) => handleChange('yearsWorkedCH', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  max="50"
                />
              </div>

              <div>
                <label htmlFor="pp-planned-ch" className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('pension.plannedYearsCH')}
                  <InfoTooltip text={t('pension.plannedYearsCHTooltip')} />
                </label>
                <input
                  id="pp-planned-ch"
                  type="number"
                  inputMode="numeric"
                  value={inputs.plannedYearsCH}
                  onChange={(e) => handleChange('plannedYearsCH', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  max="50"
                />
              </div>

              <div>
                <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  <input
                    type="checkbox"
                    checked={inputs.hasItalianContributions}
                    onChange={(e) => handleChange('hasItalianContributions', e.target.checked)}
                    className="mr-2 w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                    aria-label={t('pension.hasItalianContributions') || 'Contributi italiani'}
                  />
                  {t('pension.hasItalianContributions')}
                  <InfoTooltip text={t('pension.hasItalianContributionsTooltip')} />
                </label>
              </div>

              {inputs.hasItalianContributions && (
                <div>
                  <label htmlFor="pp-years-it" className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                    {t('pension.yearsWorkedIT')}
                    <InfoTooltip text={t('pension.yearsWorkedITTooltip')} />
                  </label>
                  <input
                    id="pp-years-it"
                    type="number"
                    inputMode="numeric"
                    value={inputs.yearsWorkedIT}
                    onChange={(e) => handleChange('yearsWorkedIT', parseInt(e.target.value) || 0)}
                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="0"
                    max="50"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Financial Info */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Banknote className="text-purple-600" size={20} />
              <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('pension.financialData')}</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="pp-salary" className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('pension.grossSalary')}
                  <InfoTooltip text={t('pension.grossSalaryTooltip')} />
                </label>
                <input
                  id="pp-salary"
                  type="number"
                  inputMode="numeric"
                  value={inputs.currentSalaryCHF}
                  onChange={(e) => handleChange('currentSalaryCHF', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-purple-500"
                  min="0"
                  step="1000"
                />
              </div>

              <div>
                <label htmlFor="pp-lpp" className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('pension.currentLPP')}
                  <InfoTooltip text={t('pension.currentLPPTooltip')} />
                </label>
                <input
                  id="pp-lpp"
                  type="number"
                  inputMode="numeric"
                  value={inputs.currentLPPCapital}
                  onChange={(e) => handleChange('currentLPPCapital', parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-purple-500"
                  min="0"
                  step="5000"
                />
              </div>

              <div>
                <label htmlFor="pp-return" className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('pension.returnRate')}
                  <InfoTooltip text={t('pension.returnRateTooltip')} />
                </label>
                <input
                  id="pp-return"
                  type="number"
                  inputMode="decimal"
                  value={inputs.expectedReturnRate}
                  onChange={(e) => handleChange('expectedReturnRate', parseFloat(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 font-semibold focus:outline-none focus:ring-2 focus:ring-purple-500"
                  min="0"
                  max="5"
                  step="0.1"
                />
              </div>
            </div>
          </div>

          {/* Repatriation Plan */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Globe className="text-orange-600" size={20} />
              <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('pension.repatriationPlan')}</h2>
            </div>

            <div className="space-y-3">
              <label className="flex items-center text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                {t('pension.whereRetire')}
                <InfoTooltip text={t('pension.whereRetireTooltip')} />
              </label>

              {(['stay_ch', 'return_it', 'undecided'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => handleChange('repatriationPlan', option)}
                  className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                    inputs.repatriationPlan === option
                      ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20'
                      : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {inputs.repatriationPlan === option && (
                      <CheckCircle2 size={20} className="text-emerald-700 flex-shrink-0" />
                    )}
                    <div className="flex-1">
                      <div className="font-bold text-slate-800 dark:text-slate-100">
                        {option === 'stay_ch' && `🇨🇭 ${t('pension.stayCH')}`}
                        {option === 'return_it' && `🇮🇹 ${t('pension.returnIT')}`}
                        {option === 'undecided' && `🤔 ${t('pension.undecided')}`}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        {option === 'stay_ch' && t('pension.stayCHDesc')}
                        {option === 'return_it' && t('pension.returnITDesc')}
                        {option === 'undecided' && t('pension.undecidedDesc')}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Results */}
        <div className="space-y-4">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 gap-4">
            {/* Total Monthly Pension */}
            <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-4 sm:p-6 shadow-lg text-white">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="text-emerald-100 text-sm font-semibold uppercase tracking-wide mb-1">
                    {t('pension.totalMonthlyPension')}
                  </div>
                  <div className="text-3xl sm:text-4xl font-bold">
                    CHF {Math.round(result.totalMonthlyPensionCHF).toLocaleString('it-IT')}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={handleShare} aria-label={t('common.share')} className="p-2 rounded-xl bg-white/20 hover:bg-white/30 transition-colors">
                    {shareState === 'copied' ? <Check size={18} className="text-white" /> : <Share2 size={18} className="text-white" />}
                  </button>
                  <TrendingUp size={32} className="text-emerald-200" />
                </div>
              </div>
              <div className="text-emerald-100 text-xs">
                {t('pension.estimateBased')} {yearsUntilRetirement} {t('pension.yearsOfFutureContributions')}
              </div>
            </div>

            {/* LPP Capital */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                  <PiggyBank className="text-blue-600" size={20} />
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide">
                    {t('pension.lppCapital')}
                  </div>
                  <div className="text-2xl font-bold text-slate-800 dark:text-slate-100">
                    CHF {Math.round(result.lppAccumulated).toLocaleString('it-IT')}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-700">
                <span className="text-sm text-slate-600 dark:text-slate-400">{t('pension.monthlyAnnuity')}:</span>
                <span className="text-lg font-bold text-blue-600">
                  CHF {Math.round(result.lppMonthlyPension).toLocaleString('it-IT')}
                </span>
              </div>
              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                <InfoTooltip text="Tasso conversione 6.8% - Capitale può essere prelevato in parte o totalmente" />
                {t('pension.conversionRate')}
              </div>
            </div>

            {/* AVS Pension */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-lg">
                  <Home className="text-red-600" size={20} />
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide">
                    {t('pension.avsPension')}
                  </div>
                  <div className="text-2xl font-bold text-slate-800 dark:text-slate-100">
                    CHF {Math.round(result.avsPensionCHF).toLocaleString('it-IT')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <Calculator size={12} />
                <span>
                  {result.yearsOfContributions.switzerland} {t('pension.contributionsOf44')}
                </span>
              </div>
              <div className="mt-2 w-full bg-slate-100 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
                <div 
                  className="bg-red-500 h-full rounded-full transition-transform duration-500 origin-left"
                  style={{ transform: `scaleX(${Math.min(result.yearsOfContributions.switzerland / 44, 1)})` }}
                />
              </div>
            </div>

            {/* Italian Pension */}
            {inputs.hasItalianContributions && (
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg">
                    <Globe className="text-green-700" size={20} />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide">
                      {t('pension.inpsPension')}
                    </div>
                    <div className="text-2xl font-bold text-slate-800 dark:text-slate-100">
                      € {Math.round(result.italianPensionEUR).toLocaleString('it-IT')}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <Calculator size={12} />
                  <span>
                    {inputs.yearsWorkedIT} {t('pension.italianContributionYears')}
                  </span>
                </div>
                <div className="mt-3 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-xs text-blue-700 dark:text-blue-400">
                  <strong>{t('pension.note')}:</strong> {t('pension.proportionalPension')}
                </div>
              </div>
            )}
          </div>

          {/* Breakdown Table */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
              <Calculator size={20} className="text-emerald-700" />
              {t('pension.monthlyBreakdown')}
            </h2>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pension.lppAnnuity')}</span>
                <span className="text-lg font-bold text-blue-600">
                  CHF {Math.round(result.lppMonthlyPension).toLocaleString('it-IT')}
                </span>
              </div>

              <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pension.avsFirstPillar')}</span>
                <span className="text-lg font-bold text-red-600">
                  CHF {Math.round(result.avsPensionCHF).toLocaleString('it-IT')}
                </span>
              </div>

              {inputs.hasItalianContributions && result.italianPensionEUR > 0 && (
                <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pension.inpsPension')}</span>
                  <span className="text-lg font-bold text-green-700">
                    € {Math.round(result.italianPensionEUR).toLocaleString('it-IT')}
                  </span>
                </div>
              )}

              <div className="border-t-2 border-emerald-500 pt-3 mt-3">
                <div className="flex items-center justify-between p-4 bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl">
                  <span className="text-base font-bold text-slate-800 dark:text-slate-100">{t('pension.monthlyTotal')}</span>
                  <span className="text-2xl font-bold text-emerald-700">
                    CHF {Math.round(result.totalMonthlyPensionCHF).toLocaleString('it-IT')}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Repatriation Info */}
          {inputs.repatriationPlan !== 'undecided' && (
            <div className={`rounded-2xl border-2 p-4 sm:p-6 ${
              inputs.repatriationPlan === 'stay_ch'
                ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
                : 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800'
            }`}>
              <div className="flex items-start gap-3 mb-3">
                <AlertCircle 
                  size={24} 
                  className={inputs.repatriationPlan === 'stay_ch' ? 'text-blue-600' : 'text-orange-600'} 
                />
                <div>
                  <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-2">
                    {inputs.repatriationPlan === 'stay_ch' ? `🇨🇭 ${t('pension.scenarioStayCH')}` : `🇮🇹 ${t('pension.scenarioReturnIT')}`}
                  </h3>
                  <ul className="text-sm space-y-1 text-slate-600 dark:text-slate-400">
                    {inputs.repatriationPlan === 'stay_ch' ? (
                      <>
                        <li>✓ {t('pension.stayCH1')}</li>
                        <li>✓ {t('pension.stayCH2')}</li>
                        <li>✓ {t('pension.stayCH3')}</li>
                        <li>✓ {t('pension.stayCH4')}</li>
                      </>
                    ) : (
                      <>
                        <li>⚠️ {t('pension.returnIT1')}</li>
                        <li>✓ {t('pension.returnIT2')}</li>
                        <li>⚠️ {t('pension.returnIT3')}</li>
                        <li>⚠️ {t('pension.returnIT4')}</li>
                      </>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Important Notes */}
          <div className="bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-200 dark:border-amber-800 rounded-2xl p-6">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-amber-700 flex-shrink-0 mt-0.5" />
              <div className="space-y-2 text-sm text-amber-800 dark:text-amber-200">
                <p className="font-bold">⚠️ {t('pension.disclaimer')}</p>
                <ul className="space-y-1 text-xs">
                  <li>• {t('pension.disclaimer1')}</li>
                  <li>• {t('pension.disclaimer2')}</li>
                  <li>• {t('pension.disclaimer3')}</li>
                  <li>• {t('pension.disclaimer4')}</li>
                  <li>• {t('pension.disclaimer5')}</li>
                </ul>
              </div>
              <div className="flex items-center gap-1.5 mt-3 text-xs text-emerald-700 dark:text-emerald-400">
                <Shield size={12} className="flex-shrink-0" />
                <span>{t('pension.dataPrivacy')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Source methodology — AI SEO citability */}
      <div className="mt-6 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-700">
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          <strong>{t('pension.methodology.title')}</strong>{' '}
          {t('pension.methodology.description')}
        </p>
      </div>

      <Suspense fallback={null}>
        <LeadMagnetCTA variant="pension" delay={5000} />
      </Suspense>
      <Suspense fallback={null}>
        <RelatedTools context="pension" />
      </Suspense>
    </div>
  );
};

export default React.memo(PensionPlanner);
