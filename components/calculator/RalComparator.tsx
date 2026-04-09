import React, { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import type { UserProfileData } from '@/components/pages/UserProfile';
import { useTranslation } from '@/services/i18n';
import { useExchangeRate } from '@/services/exchangeRateService';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { Euro, ChevronDown, ChevronUp, Info, TrendingUp, TrendingDown, Minus, ArrowLeftRight, RefreshCw } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import { calculateProgressiveWorkDeduction } from '@/services/calculationService';

// ─── Italian INPS Contribution Rates 2026 ────────────────────────────────

const INPS_EMPLOYEE_RATE = 0.0919; // 9.19% carico dipendente
const INPS_EMPLOYER_RATE = 0.2381; // 23.81% carico datore (not shown to user, but relevant for cost)
const IRPEF_SCAGLIONI_2026 = [
  { max: 28000, rate: 0.23 },
  { max: 50000, rate: 0.35 },
  { max: Infinity, rate: 0.43 },
];
const ADDIZIONALE_REGIONALE_AVG = 0.02; // ~2% media (varies by region)
const ADDIZIONALE_COMUNALE_AVG = 0.008; // ~0.8% media
// DETRAZIONI_LAVORO_DIPENDENTE: progressive per Art. 13 TUIR (via calculateProgressiveWorkDeduction)

// ─── Swiss Rates (same as calculationService) ────────────────────────────

const AVS_RATE = 0.053;
const AC_RATE = 0.011;
const LAA_RATE = 0.007;
const IJM_RATE = 0.008;
const LPP_RATES: Record<string, number> = {
  '25-34': 0.035,
  '35-44': 0.05,
  '45-54': 0.075,
  '55+': 0.09,
};

// Ticino tax table A (single, no children) — simplified interpolation
const TABLE_A: number[][] = [[0, 0], [17000, 0.20], [25000, 2.00], [30000, 3.20], [40000, 5.20], [50000, 6.00], [60000, 8.50], [80000, 11.30], [100000, 13.20], [120000, 14.90], [150000, 17.20], [200000, 19.40], [300000, 24.50], [500000, 28.30]];
const TABLE_B: number[][] = [[0, 0], [25000, 0.30], [30000, 0.70], [40000, 1.10], [50000, 1.50], [60000, 2.50], [80000, 5.10], [100000, 8.70], [120000, 10.70], [150000, 13.40], [200000, 16.50], [300000, 22.80]];

function interpolate(value: number, points: number[][]): number {
  if (value <= points[0][0]) return points[0][1];
  if (value >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (value >= x0 && value < x1) return y0 + (value - x0) * (y1 - y0) / (x1 - x0);
  }
  return 0;
}

// ─── Calculate Italian Net from RAL ──────────────────────────────────────

interface ItalianResult {
  ral: number;
  inpsEmployee: number;
  taxableIncome: number;
  irpefGross: number;
  detrazioni: number;
  irpefNet: number;
  addizionali: number;
  totalTax: number;
  netAnnual: number;
  netMonthly: number;
  effectiveRate: number;
}

function calculateItalianNet(ral: number, maritalStatus: string, children: number): ItalianResult {
  const inpsEmployee = ral * INPS_EMPLOYEE_RATE;
  const taxableIncome = ral - inpsEmployee;

  // IRPEF progressive
  let irpefGross = 0;
  let remaining = taxableIncome;
  let prevMax = 0;
  for (const { max, rate } of IRPEF_SCAGLIONI_2026) {
    const bracket = Math.min(remaining, max - prevMax);
    if (bracket <= 0) break;
    irpefGross += bracket * rate;
    remaining -= bracket;
    prevMax = max;
  }

  // Progressive work deduction per Art. 13 TUIR
  let detrazioni = calculateProgressiveWorkDeduction(taxableIncome);
  // Children bonus (ANF/assegno unico not included — separate system)
  detrazioni += children * 950;
  if (maritalStatus === 'MARRIED') detrazioni += 690;

  const irpefNet = Math.max(0, irpefGross - detrazioni);
  const addizionali = taxableIncome * (ADDIZIONALE_REGIONALE_AVG + ADDIZIONALE_COMUNALE_AVG);
  const totalTax = inpsEmployee + irpefNet + addizionali;
  const netAnnual = ral - totalTax;

  return {
    ral,
    inpsEmployee,
    taxableIncome,
    irpefGross,
    detrazioni,
    irpefNet,
    addizionali,
    totalTax,
    netAnnual,
    netMonthly: netAnnual / 13, // 13 mensilità in Italia
    effectiveRate: (totalTax / ral) * 100,
  };
}

// ─── Calculate Swiss Net from gross salary ───────────────────────────────

interface SwissResult {
  grossCHF: number;
  avs: number;
  ac: number;
  laa: number;
  ijm: number;
  lpp: number;
  totalSocial: number;
  taxRate: number;
  taxes: number;
  healthInsurance: number;
  netAnnual: number;
  netMonthly: number;
  effectiveRate: number;
}

function calculateSwissNet(grossCHF: number, ageGroup: string, maritalStatus: string, healthInsurance: number): SwissResult {
  const avs = grossCHF * AVS_RATE;
  const ac = Math.min(grossCHF, 148200) * AC_RATE;
  const laa = grossCHF * LAA_RATE;
  const ijm = grossCHF * IJM_RATE;
  const lpp = grossCHF * (LPP_RATES[ageGroup] || 0.05);
  const totalSocial = avs + ac + laa + ijm + lpp;

  const tablePoints = maritalStatus === 'MARRIED' ? TABLE_B : TABLE_A;
  const taxRate = interpolate(grossCHF, tablePoints) / 100;
  const taxes = grossCHF * taxRate;
  const healthAnnual = healthInsurance * 12;

  const netAnnual = grossCHF - totalSocial - taxes - healthAnnual;

  return {
    grossCHF,
    avs, ac, laa, ijm, lpp,
    totalSocial,
    taxRate,
    taxes,
    healthInsurance: healthAnnual,
    netAnnual,
    netMonthly: netAnnual / 12,
    effectiveRate: ((totalSocial + taxes + healthAnnual) / grossCHF) * 100,
  };
}

// ─── Component ───────────────────────────────────────────────────────────

const RalComparator: React.FC<{ userProfile?: UserProfileData | null }> = ({ userProfile }) => {
  const { t } = useTranslation();
  const { rate: chfEurRate, loading: rateLoading } = useExchangeRate();
  const [grossSalary, setGrossSalary] = useState(75000);

  // Prefill salary from user profile
  useEffect(() => {
    Analytics.trackPageView('/simulatori/ral-comparator', 'RAL Comparator');
    Analytics.trackUIInteraction('ral_comparator', 'screen', 'view', 'open');
  }, []);

  useEffect(() => {
    if (userProfile?.grossSalary) {
      const s = parseFloat(userProfile.grossSalary);
      if (!isNaN(s) && s > 0) setGrossSalary(s);
    }
  }, [userProfile]);
  const [maritalStatus, setMaritalStatus] = useState<'SINGLE' | 'MARRIED'>('SINGLE');
  const [children, setChildren] = useState(0);
  const [ageGroup, setAgeGroup] = useState('25-34');
  const [healthInsurance, setHealthInsurance] = useState(450);
  const [showDetails, setShowDetails] = useState(false);

  // CHF/EUR rate from API (e.g. 0.94 = 1 CHF → 0.94 EUR)
  // EUR/CHF = 1/chfEurRate (e.g. 1.064 = 1 EUR → 1.064 CHF)
  const eurChfRate = chfEurRate > 0 ? 1 / chfEurRate : 1.06;

  // Same gross in EUR → compare IT job vs CH job
  const itResult = useMemo(() => calculateItalianNet(grossSalary, maritalStatus, children), [grossSalary, maritalStatus, children]);
  
  // Convert EUR gross to CHF for Swiss calculation
  const grossCHF = grossSalary * eurChfRate;
  const chResult = useMemo(() => calculateSwissNet(grossCHF, ageGroup, maritalStatus, healthInsurance), [grossCHF, ageGroup, maritalStatus, healthInsurance]);

  // Compare: monthly net in EUR
  const itNetMonthlyEUR = itResult.netMonthly;
  const chNetMonthlyEUR = chResult.netMonthly * chfEurRate;
  const diff = chNetMonthlyEUR - itNetMonthlyEUR;
  const diffPercent = itNetMonthlyEUR > 0 ? ((diff / itNetMonthlyEUR) * 100) : 0;

  const formatCurrency = (amount: number, currency: string = '€') => {
    return `${currency} ${Math.round(amount).toLocaleString('it-IT')}`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 rounded-2xl p-4 sm:p-6 border border-green-200 dark:border-green-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-green-100 dark:bg-green-900/50 rounded-xl">
            <ArrowLeftRight className="w-6 h-6 text-green-600 dark:text-green-400" />
          </div>
          <h2 className="text-2xl font-bold text-green-900 dark:text-green-100">{t('ral.title')}</h2>
        </div>
        <p className="text-green-700 dark:text-green-300 text-sm">{t('ral.subtitle')}</p>
      </div>

      {/* Input Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="bg-surface rounded-xl p-4 border border-edge">
          <label className="block text-sm font-bold text-body mb-2">{t('ral.grossSalary')}</label>
          <div className="relative">
            <Euro className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <input
              type="number"
              inputMode="numeric"
              value={grossSalary}
              onChange={(e) => {
                const value = Number(e.target.value) || 0;
                setGrossSalary(value);
                Analytics.trackInputChange('ral_gross_salary', value);
              }}
              className="w-full pl-9 pr-4 py-2.5 rounded-lg border border-edge bg-surface-alt text-strong font-bold"
              min={15000}
              max={500000}
              step={1000}
              aria-label="RAL lorda annuale in euro"
            />
          </div>
          <input
            type="range"
            min={15000}
            max={250000}
            step={1000}
            value={grossSalary}
            onChange={(e) => {
              const value = Number(e.target.value);
              setGrossSalary(value);
              Analytics.trackInputChange('ral_gross_salary_slider', value);
            }}
            className="w-full mt-2 accent-green-600"
            aria-label="Regola RAL lorda annuale"
          />
          <div className="flex justify-between text-xs text-muted mt-1">
            <span>€15k</span>
            <span>€250k</span>
          </div>
        </div>

        <div className="bg-surface rounded-xl p-4 border border-edge">
          <label className="block text-sm font-bold text-body mb-2">{t('ral.exchangeRate')}</label>
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-edge bg-surface-alt">
            <span className="font-bold text-strong">1 EUR = {eurChfRate.toFixed(4)} CHF</span>
            {rateLoading && <RefreshCw size={14} className="animate-spin text-muted" />}
          </div>
          <p className="text-xs text-muted mt-1">{t('exchange.liveRate') || 'Tasso di cambio live CHF/EUR'}</p>
        </div>

        <div className="bg-surface rounded-xl p-4 border border-edge">
          <label className="block text-sm font-bold text-body mb-2">{t('ral.maritalStatus')}</label>
          <select
            value={maritalStatus}
            onChange={(e) => {
              const value = e.target.value as 'SINGLE' | 'MARRIED';
              setMaritalStatus(value);
              Analytics.trackInputChange('ral_marital_status', value);
            }}
            className="w-full px-4 py-2.5 rounded-lg border border-edge bg-surface-alt text-strong font-bold"
            aria-label="Stato civile"
          >
            <option value="SINGLE">{t('ral.single')}</option>
            <option value="MARRIED">{t('ral.married')}</option>
          </select>
        </div>

        <div className="bg-surface rounded-xl p-4 border border-edge">
          <label className="block text-sm font-bold text-body mb-2">{t('ral.children')}</label>
          <select
            value={children}
            onChange={(e) => {
              const value = Number(e.target.value);
              setChildren(value);
              Analytics.trackInputChange('ral_children', value);
            }}
            className="w-full px-4 py-2.5 rounded-lg border border-edge bg-surface-alt text-strong font-bold"
            aria-label="Numero di figli a carico"
          >
            {[0, 1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <div className="bg-surface rounded-xl p-4 border border-edge">
          <label className="block text-sm font-bold text-body mb-2">{t('ral.ageGroup')}</label>
          <select
            value={ageGroup}
            onChange={(e) => {
              setAgeGroup(e.target.value);
              Analytics.trackInputChange('ral_age_group', e.target.value);
            }}
            className="w-full px-4 py-2.5 rounded-lg border border-edge bg-surface-alt text-strong font-bold"
            aria-label="Fascia di età"
          >
            <option value="25-34">25-34</option>
            <option value="35-44">35-44</option>
            <option value="45-54">45-54</option>
            <option value="55+">55+</option>
          </select>
        </div>

        <div className="bg-surface rounded-xl p-4 border border-edge">
          <label className="block text-sm font-bold text-body mb-2">{t('ral.healthInsurance')}</label>
          <input
            type="number"
            inputMode="numeric"
            value={healthInsurance}
            onChange={(e) => {
              const value = Number(e.target.value) || 0;
              setHealthInsurance(value);
              Analytics.trackInputChange('ral_health_insurance', value);
            }}
            className="w-full px-4 py-2.5 rounded-lg border border-edge bg-surface-alt text-strong font-bold"
            min={0}
            max={1500}
            step={10}
            aria-label="Costo assicurazione sanitaria mensile in CHF"
          />
          <p className="text-xs text-muted mt-1">{t('ral.healthInsuranceNote')}</p>
        </div>
      </div>

      {/* Big Result Card */}
      <div className={`rounded-2xl p-4 sm:p-6 border-2 ${diff > 0 ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-700' : diff < 0 ? 'bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-700' : 'bg-surface-alt border-slate-300 dark:border-slate-700'}`}>
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2">
            {diff > 0 ? <TrendingUp className="w-6 h-6 text-emerald-700 dark:text-emerald-400" /> : diff < 0 ? <TrendingDown className="w-6 h-6 text-red-600 dark:text-red-400" /> : <Minus className="w-6 h-6 text-slate-600 dark:text-slate-300" />}
            <p className="text-sm font-bold text-subtle">{t('ral.monthlyDifference')}</p>
          </div>
          <p className={`text-4xl font-bold ${diff > 0 ? 'text-emerald-700 dark:text-emerald-400' : diff < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300'}`}>
            {diff > 0 ? '+' : ''}{formatCurrency(diff)} /mese
          </p>
          <p className="text-sm text-muted">
            {t('ral.swissAdvantage')}: {diff > 0 ? '+' : ''}{diffPercent.toFixed(1)}%
          </p>
        </div>
      </div>

      {/* Side-by-Side Comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Italy Card */}
        <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
          <div className="bg-gradient-to-r from-green-600 via-white to-red-600 h-1.5" />
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-2xl">🇮🇹</span>
              <h3 className="text-lg font-bold text-strong">{t('ral.italyTitle')}</h3>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-subtle">RAL</span>
                <span className="font-bold">{formatCurrency(itResult.ral)}</span>
              </div>
              <div className="flex justify-between text-red-600 dark:text-red-400">
                <span className="text-sm">INPS ({(INPS_EMPLOYEE_RATE * 100).toFixed(1)}%)</span>
                <span className="font-bold">-{formatCurrency(itResult.inpsEmployee)}</span>
              </div>
              <div className="flex justify-between text-red-600 dark:text-red-400">
                <span className="text-sm">IRPEF</span>
                <span className="font-bold">-{formatCurrency(itResult.irpefNet)}</span>
              </div>
              <div className="flex justify-between text-red-600 dark:text-red-400">
                <span className="text-sm">{t('ral.addizionali')}</span>
                <span className="font-bold">-{formatCurrency(itResult.addizionali)}</span>
              </div>
              <hr className="border-edge" />
              <div className="flex justify-between">
                <span className="font-bold text-strong">{t('ral.netAnnual')}</span>
                <span className="font-bold text-lg text-green-700 dark:text-green-400">{formatCurrency(itResult.netAnnual)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted">{t('ral.netMonthly')} (×13)</span>
                <span className="font-bold text-green-600 dark:text-green-400">{formatCurrency(itResult.netMonthly)}</span>
              </div>
              <div className="mt-2 p-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                <span className="text-sm text-muted">{t('ral.effectiveRate')}: <b>{itResult.effectiveRate.toFixed(1)}%</b></span>
              </div>
            </div>
          </div>
        </div>

        {/* Switzerland Card */}
        <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
          <div className="bg-gradient-to-r from-red-600 via-red-600 to-red-600 h-1.5 relative">
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-3 h-3 bg-white" style={{ clipPath: 'polygon(35% 0, 65% 0, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0 65%, 0 35%, 35% 35%)' }} />
            </div>
          </div>
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-2xl">🇨🇭</span>
              <h3 className="text-lg font-bold text-strong">{t('ral.swissTitle')}</h3>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-subtle">{t('ral.grossCHF')}</span>
                <span className="font-bold">{formatCurrency(chResult.grossCHF, 'CHF')}</span>
              </div>
              <div className="flex justify-between text-sm text-muted">
                <span>({t('ral.equivalentEUR')})</span>
                <span>{formatCurrency(grossSalary)}</span>
              </div>
              <div className="flex justify-between text-red-600 dark:text-red-400">
                <span className="text-sm">AVS/AC/LAA/IJM</span>
                <span className="font-bold">-{formatCurrency(chResult.totalSocial - chResult.lpp, 'CHF')}</span>
              </div>
              <div className="flex justify-between text-red-600 dark:text-red-400">
                <span className="text-sm">LPP ({ageGroup})</span>
                <span className="font-bold">-{formatCurrency(chResult.lpp, 'CHF')}</span>
              </div>
              <div className="flex justify-between text-red-600 dark:text-red-400">
                <span className="text-sm">{t('ral.withholdingTax')} ({(chResult.taxRate * 100).toFixed(1)}%)</span>
                <span className="font-bold">-{formatCurrency(chResult.taxes, 'CHF')}</span>
              </div>
              <div className="flex justify-between text-red-600 dark:text-red-400">
                <span className="text-sm">{t('ral.healthIns')}</span>
                <span className="font-bold">-{formatCurrency(chResult.healthInsurance, 'CHF')}</span>
              </div>
              <hr className="border-edge" />
              <div className="flex justify-between">
                <span className="font-bold text-strong">{t('ral.netAnnual')}</span>
                <span className="font-bold text-lg text-green-700 dark:text-green-400">{formatCurrency(chResult.netAnnual, 'CHF')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted">{t('ral.netMonthly')} (×12)</span>
                <span className="font-bold text-green-600 dark:text-green-400">{formatCurrency(chResult.netMonthly, 'CHF')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted">{t('ral.inEUR')}</span>
                <span className="font-bold text-green-600 dark:text-green-400">{formatCurrency(chResult.netMonthly * chfEurRate)}</span>
              </div>
              <div className="mt-2 p-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                <span className="text-sm text-muted">{t('ral.effectiveRate')}: <b>{chResult.effectiveRate.toFixed(1)}%</b></span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Details toggle */}
      <button
        onClick={() => {
          const next = !showDetails;
          setShowDetails(next);
          Analytics.trackUIInteraction('ral_comparator', 'details', 'toggle', next ? 'open' : 'close');
        }}
        className="flex items-center gap-2 text-sm font-bold text-muted hover:text-slate-700 dark:hover:text-slate-300 transition-colors mx-auto"
      >
        {showDetails ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        {t('ral.showDetails')}
      </button>

      {showDetails && (
        <div className="bg-surface rounded-2xl border border-edge p-5 space-y-4">
          <div className="flex items-center gap-2 mb-3">
            <Info className="w-5 h-5 text-blue-500" />
            <h4 className="font-bold text-strong">{t('ral.detailsTitle')}</h4>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
            <div>
              <h5 className="font-bold text-body mb-2">🇮🇹 {t('ral.italyDetails')}</h5>
              <table className="w-full">
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  <tr><td className="py-1 text-muted">{t('ral.taxableIncome')}</td><td className="py-1 text-right font-mono">{formatCurrency(itResult.taxableIncome)}</td></tr>
                  <tr><td className="py-1 text-muted">IRPEF lorda</td><td className="py-1 text-right font-mono">{formatCurrency(itResult.irpefGross)}</td></tr>
                  <tr><td className="py-1 text-muted">{t('ral.deductions')}</td><td className="py-1 text-right font-mono text-green-600 dark:text-green-400">-{formatCurrency(itResult.detrazioni)}</td></tr>
                  <tr><td className="py-1 text-muted">IRPEF netta</td><td className="py-1 text-right font-mono">{formatCurrency(itResult.irpefNet)}</td></tr>
                  <tr><td className="py-1 text-muted">{t('ral.addizionali')}</td><td className="py-1 text-right font-mono">{formatCurrency(itResult.addizionali)}</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h5 className="font-bold text-body mb-2">🇨🇭 {t('ral.swissDetails')}</h5>
              <table className="w-full">
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  <tr><td className="py-1 text-muted">AVS (5.3%)</td><td className="py-1 text-right font-mono">{formatCurrency(chResult.avs, 'CHF')}</td></tr>
                  <tr><td className="py-1 text-muted">AC (1.1%)</td><td className="py-1 text-right font-mono">{formatCurrency(chResult.ac, 'CHF')}</td></tr>
                  <tr><td className="py-1 text-muted">LAA (0.7%)</td><td className="py-1 text-right font-mono">{formatCurrency(chResult.laa, 'CHF')}</td></tr>
                  <tr><td className="py-1 text-muted">IJM (0.8%)</td><td className="py-1 text-right font-mono">{formatCurrency(chResult.ijm, 'CHF')}</td></tr>
                  <tr><td className="py-1 text-muted">LPP ({ageGroup})</td><td className="py-1 text-right font-mono">{formatCurrency(chResult.lpp, 'CHF')}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-800">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              <Info className="inline w-3 h-3 mr-1" />
              {t('ral.disclaimer')}
            </p>
          </div>
        </div>
      )}
      <Suspense fallback={null}><RelatedTools context="salary" /></Suspense>
    </div>
  );
};

export default RalComparator;
