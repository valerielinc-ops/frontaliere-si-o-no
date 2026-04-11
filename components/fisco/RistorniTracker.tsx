import React, { useState, useMemo, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { Coins, MapPin, TrendingUp, Info, Calculator, ChevronDown, ChevronUp, AlertCircle, CheckCircle2 } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));

// Ristorni rates by province and year (% of Swiss tax returned to Italy)
interface RistorniRate {
  year: number;
  rate: number; // percentage
  totalMillions: number; // EUR millions distributed
}

// Historical ristorni data (simplified)
const HISTORICAL_RATES: RistorniRate[] = [
  { year: 2019, rate: 38.8, totalMillions: 90 },
  { year: 2020, rate: 38.8, totalMillions: 85 },
  { year: 2021, rate: 38.8, totalMillions: 92 },
  { year: 2022, rate: 38.8, totalMillions: 98 },
  { year: 2023, rate: 38.8, totalMillions: 101 },
  { year: 2024, rate: 38.8, totalMillions: 105 },
  { year: 2025, rate: 38.8, totalMillions: 108 },
];

// Top municipalities by ristorni received
interface MunicipalityRistorni {
  name: string;
  province: string;
  frontalieri: number;
  estimatedRistorni: number; // EUR per year
  perCapita: number; // EUR per resident
}

const TOP_MUNICIPALITIES: MunicipalityRistorni[] = [
  { name: 'Como', province: 'CO', frontalieri: 8500, estimatedRistorni: 12500000, perCapita: 150 },
  { name: 'Varese', province: 'VA', frontalieri: 7200, estimatedRistorni: 10800000, perCapita: 135 },
  { name: 'Lavena Ponte Tresa', province: 'VA', frontalieri: 800, estimatedRistorni: 2400000, perCapita: 420 },
  { name: 'Valsolda', province: 'CO', frontalieri: 450, estimatedRistorni: 1800000, perCapita: 1200 },
  { name: 'Campione d\'Italia', province: 'CO', frontalieri: 350, estimatedRistorni: 1500000, perCapita: 750 },
  { name: 'Clivio', province: 'VA', frontalieri: 600, estimatedRistorni: 1200000, perCapita: 580 },
  { name: 'Cantello', province: 'VA', frontalieri: 550, estimatedRistorni: 1100000, perCapita: 250 },
  { name: 'Saltrio', province: 'VA', frontalieri: 520, estimatedRistorni: 980000, perCapita: 310 },
  { name: 'Viggiù', province: 'VA', frontalieri: 480, estimatedRistorni: 920000, perCapita: 180 },
  { name: 'Luino', province: 'VA', frontalieri: 1200, estimatedRistorni: 2800000, perCapita: 200 },
  { name: 'Chiasso-bordering', province: 'CO', frontalieri: 400, estimatedRistorni: 800000, perCapita: 160 },
  { name: 'Ponte Chiasso', province: 'CO', frontalieri: 300, estimatedRistorni: 600000, perCapita: 140 },
];

const RistorniTracker: React.FC = () => {
  const { t } = useTranslation();
  const [grossMonthlyCHF, setGrossMonthlyCHF] = useState(6000);
  const [municipality, setMunicipality] = useState('Como');
  const [expandedSection, setExpandedSection] = useState<string | null>('calculator');

  // Estimate personal ristorni contribution
  const estimate = useMemo(() => {
    const annualGross = grossMonthlyCHF * 12;
    // Approximate Swiss withholding (7% average for a typical frontaliere)
    const estimatedSwissTax = annualGross * 0.07;
    // 38.8% of Swiss tax is returned to Italian municipalities
    const ristorniContribution = estimatedSwissTax * 0.388;
    // Under new agreement (post-2024 hires): no ristorni, full Italian taxation
    const isNewAgreement = false; // user could toggle this
    return {
      annualSwissTax: Math.round(estimatedSwissTax),
      ristorniToItaly: Math.round(ristorniContribution),
      monthlyEquivalent: Math.round(ristorniContribution / 12),
      isNewAgreement,
    };
  }, [grossMonthlyCHF]);

  const selectedMunicipality = TOP_MUNICIPALITIES.find(m => m.name === municipality);

  const toggleSection = (key: string) => {
    setExpandedSection(expandedSection === key ? null : key);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-teal-600 to-emerald-700 rounded-2xl p-4 sm:p-6 text-white">
        <div className="flex items-center gap-3 mb-2">
          <Coins size={28} />
          <h2 className="text-2xl font-bold">{t('ristorni.title')}</h2>
        </div>
        <p className="text-teal-100 text-sm">{t('ristorni.subtitle')}</p>
      </div>

      {/* What are ristorni */}
      <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge">
        <h3 className="font-bold text-strong mb-3 flex items-center gap-2">
          <Info size={18} className="text-teal-600" /> {t('ristorni.whatAre')}
        </h3>
        <p className="text-sm text-subtle mb-4">{t('ristorni.explanation')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-warm-50 dark:bg-warm-950 rounded-xl p-3 border border-warm-200 dark:border-warm-800">
            <h4 className="font-bold text-xs text-warm-700 dark:text-warm-300 mb-1">{t('ristorni.oldAgreement')}</h4>
            <p className="text-xs text-warm-700 dark:text-warm-400">{t('ristorni.oldAgreementDesc')}</p>
          </div>
          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3">
            <h4 className="font-bold text-sm text-amber-700 dark:text-amber-300 mb-1">{t('ristorni.newAgreement')}</h4>
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('ristorni.newAgreementDesc')}</p>
          </div>
        </div>
      </div>

      {/* Personal calculator */}
      <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
        <button onClick={() => toggleSection('calculator')} className="w-full flex items-center justify-between p-4" aria-expanded={expandedSection === 'calculator'}>
          <h3 className="font-bold text-strong flex items-center gap-2">
            <Calculator size={18} className="text-teal-600" /> {t('ristorni.yourContribution')}
          </h3>
          {expandedSection === 'calculator' ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
        </button>
        {expandedSection === 'calculator' && (
          <div className="px-4 pb-4 space-y-4 border-t border-slate-100 dark:border-slate-700 pt-4 animate-fade-in">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="ristorni-salary" className="block text-xs font-semibold text-subtle mb-1">
                  {t('ristorni.monthlySalary')} (CHF)
                </label>
                <input
                  id="ristorni-salary"
                  type="number"
                  inputMode="numeric"
                  value={grossMonthlyCHF}
                  onChange={e => setGrossMonthlyCHF(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
                />
              </div>
              <div>
                <label htmlFor="ristorni-municipality" className="block text-xs font-semibold text-subtle mb-1">
                  {t('ristorni.municipality')}
                </label>
                <select
                  id="ristorni-municipality"
                  value={municipality}
                  onChange={e => setMunicipality(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
                >
                  {TOP_MUNICIPALITIES.map(m => (
                    <option key={m.name} value={m.name}>{m.name} ({m.province})</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-stripe-50 dark:bg-stripe-900/20 rounded-xl p-3 text-center">
                <p className="text-xs text-link font-semibold">{t('ristorni.annualSwissTax')}</p>
                <p className="text-lg font-bold text-stripe-700 dark:text-stripe-300">CHF {estimate.annualSwissTax.toLocaleString()}</p>
              </div>
              <div className="bg-teal-50 dark:bg-teal-900/20 rounded-xl p-3 text-center">
                <p className="text-xs text-teal-600 dark:text-teal-400 font-semibold">{t('ristorni.ristorniToMunicipality')}</p>
                <p className="text-lg font-bold text-teal-700 dark:text-teal-300">CHF {estimate.ristorniToItaly.toLocaleString()}</p>
              </div>
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-3 text-center">
                <p className="text-sm text-emerald-700 dark:text-emerald-400 font-semibold">{t('ristorni.monthlyEquivalent')}</p>
                <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300">CHF {estimate.monthlyEquivalent.toLocaleString()}/{t('ristorni.month')}</p>
              </div>
            </div>
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-2">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <p>{t('ristorni.disclaimer')}</p>
            </div>
          </div>
        )}
      </div>

      {/* Municipality ranking */}
      <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
        <button onClick={() => toggleSection('ranking')} className="w-full flex items-center justify-between p-4" aria-expanded={expandedSection === 'ranking'}>
          <h3 className="font-bold text-strong flex items-center gap-2">
            <TrendingUp size={18} className="text-emerald-700" /> {t('ristorni.ranking')}
          </h3>
          {expandedSection === 'ranking' ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
        </button>
        {expandedSection === 'ranking' && (
          <div className="px-4 pb-4 space-y-2 border-t border-slate-100 dark:border-slate-700 pt-4 animate-fade-in">
            {TOP_MUNICIPALITIES
              .sort((a, b) => b.estimatedRistorni - a.estimatedRistorni)
              .map((m, i) => (
              <div
                key={m.name}
                className={`flex items-center gap-3 p-3 rounded-xl ${
                  m.name === municipality
                    ? 'bg-teal-50 dark:bg-teal-900/20 border border-teal-300 dark:border-teal-700'
                    : 'bg-slate-50 dark:bg-slate-700/50'
                }`}
              >
                <span className="text-sm font-bold text-muted w-6 text-center">{i + 1}</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-strong">{m.name}</span>
                    <span className="text-sm text-muted">({m.province})</span>
                  </div>
                  <div className="flex gap-3 text-xs text-muted">
                    <span>{m.frontalieri.toLocaleString()} {t('ristorni.frontalieri')}</span>
                    <span>€{m.perCapita}/{t('ristorni.perCapita')}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-emerald-700 dark:text-emerald-300">
                    €{(m.estimatedRistorni / 1000000).toFixed(1)}M
                  </p>
                  <p className="text-sm text-muted">/{t('ristorni.year')}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Historical trend */}
      <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
        <button onClick={() => toggleSection('history')} className="w-full flex items-center justify-between p-4" aria-expanded={expandedSection === 'history'}>
          <h3 className="font-bold text-strong flex items-center gap-2">
            <TrendingUp size={18} className="text-stripe-600" /> {t('ristorni.historicalTrend')}
          </h3>
          {expandedSection === 'history' ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
        </button>
        {expandedSection === 'history' && (
          <div className="px-4 pb-4 border-t border-slate-100 dark:border-slate-700 pt-4 animate-fade-in">
            <div className="space-y-2">
              {HISTORICAL_RATES.map(rate => (
                <div key={rate.year} className="flex items-center gap-3">
                  <span className="text-sm font-bold text-subtle w-12">{rate.year}</span>
                  <div className="flex-1 bg-surface-raised rounded-full h-6 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-teal-500 to-emerald-600 rounded-full flex items-center justify-end pr-2"
                      style={{ width: `${Math.min(100, (rate.totalMillions / 120) * 100)}%` }}
                    >
                      <span className="text-xs font-bold text-white">€{rate.totalMillions}M</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-sm text-muted mt-3">
              {t('ristorni.historicalNote')}
            </p>
          </div>
        )}
      </div>
      <Suspense fallback={null}><RelatedTools context="tax" /></Suspense>
    </div>
  );
};

export default RistorniTracker;
