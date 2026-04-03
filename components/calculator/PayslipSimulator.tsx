import React, { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { FileText, Download, Info, ChevronDown, ChevronUp, Shield, Coins, User, Heart, Baby, Plus, Minus, AlertTriangle } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { DEFAULT_TECH_PARAMS, DEFAULT_INPUTS } from '@/constants';
import type { UserProfileData } from '@/components/pages/UserProfile';

// Swiss social deduction rates from shared constants
const AVS_RATE = DEFAULT_TECH_PARAMS.avsRate;
const AD_RATE = DEFAULT_TECH_PARAMS.acRate;
const AD_CAP = 148200;    // AD salary cap
const AINF_RATE = DEFAULT_TECH_PARAMS.laaRate;
const IJM_RATE = DEFAULT_TECH_PARAMS.ijmRate;

// LPP age-bracketed contribution rates (employee share) from shared constants
const LPP_RATES: { minAge: number; maxAge: number; rate: number }[] = [
  { minAge: 25, maxAge: 34, rate: DEFAULT_TECH_PARAMS.lppRate25_34 },
  { minAge: 35, maxAge: 44, rate: DEFAULT_TECH_PARAMS.lppRate35_44 },
  { minAge: 45, maxAge: 54, rate: DEFAULT_TECH_PARAMS.lppRate45_54 },
  { minAge: 55, maxAge: 65, rate: DEFAULT_TECH_PARAMS.lppRate55_plus },
];

// LPP coordination deduction & entry threshold (2025)
const LPP_COORD_DEDUCTION = 25725;
const LPP_ENTRY_THRESHOLD = 22050;

// Simplified Ticino withholding tax tables (A=single, B=married)
// Rates interpolated from cantonal barème for common salary ranges
function getWithholdingRate(annualGross: number, maritalStatus: 'single' | 'married', children: number): number {
  const monthly = annualGross / 12;
  let baseRate: number;

  if (maritalStatus === 'single') {
    // Barème A (single)
    if (monthly <= 3000) baseRate = 0.02;
    else if (monthly <= 4000) baseRate = 0.04;
    else if (monthly <= 5000) baseRate = 0.06;
    else if (monthly <= 6000) baseRate = 0.08;
    else if (monthly <= 7000) baseRate = 0.10;
    else if (monthly <= 8000) baseRate = 0.11;
    else if (monthly <= 9000) baseRate = 0.12;
    else if (monthly <= 10000) baseRate = 0.13;
    else if (monthly <= 12000) baseRate = 0.14;
    else if (monthly <= 15000) baseRate = 0.15;
    else baseRate = 0.16;
  } else {
    // Barème B (married)
    if (monthly <= 5000) baseRate = 0.02;
    else if (monthly <= 6000) baseRate = 0.04;
    else if (monthly <= 7000) baseRate = 0.06;
    else if (monthly <= 8000) baseRate = 0.07;
    else if (monthly <= 9000) baseRate = 0.08;
    else if (monthly <= 10000) baseRate = 0.09;
    else if (monthly <= 12000) baseRate = 0.10;
    else if (monthly <= 15000) baseRate = 0.12;
    else baseRate = 0.14;
  }

  // Per-child reduction (approx. 1% per child)
  const childReduction = Math.min(children * 0.01, baseRate * 0.5);
  return Math.max(baseRate - childReduction, 0);
}

function getLppRate(age: number): number {
  if (age < 25) return 0;
  const bracket = LPP_RATES.find(b => age >= b.minAge && age <= b.maxAge);
  return bracket ? bracket.rate : 0;
}

interface PayslipResult {
  grossMonthly: number;
  avs: number;
  ad: number;
  ainf: number;
  ijm: number;
  lpp: number;
  taxSource: number;
  totalDeductions: number;
  netMonthly: number;
}

function calculatePayslip(grossAnnual: number, age: number, maritalStatus: 'single' | 'married', children: number): PayslipResult {
  const grossMonthly = grossAnnual / 12;

  // Social deductions (monthly)
  const avs = grossMonthly * AVS_RATE;
  const adBase = Math.min(grossAnnual, AD_CAP);
  const ad = (adBase * AD_RATE) / 12;
  const ainf = grossMonthly * AINF_RATE;
  const ijm = grossMonthly * IJM_RATE;

  // LPP (coordinated salary)
  const lppRate = getLppRate(age);
  let lpp = 0;
  if (grossAnnual > LPP_ENTRY_THRESHOLD && lppRate > 0) {
    const coordinatedSalary = Math.max(grossAnnual - LPP_COORD_DEDUCTION, 0);
    lpp = (coordinatedSalary * lppRate) / 12;
  }

  // Withholding tax
  const taxRate = getWithholdingRate(grossAnnual, maritalStatus, children);
  const taxSource = grossMonthly * taxRate;

  const totalDeductions = avs + ad + ainf + ijm + lpp + taxSource;
  const netMonthly = grossMonthly - totalDeductions;

  return { grossMonthly, avs, ad, ainf, ijm, lpp, taxSource, totalDeductions, netMonthly };
}

// --- Reusable UI Components (matching InputCard style) ---

const InfoTooltip = ({ text }: { text: string }) => (
  <div className="group relative inline-flex items-center ml-1.5 cursor-help z-50">
    <Info size={12} className="text-slate-500 dark:text-slate-400 hover:text-indigo-500 transition-colors" />
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-48 p-2.5 bg-slate-800 dark:bg-slate-700 text-white text-xs font-medium leading-relaxed rounded-xl shadow-xl border border-slate-600 pointer-events-none text-center">
      {text}
      <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800 dark:border-t-slate-700"></div>
    </div>
  </div>
);

const StepperInput = ({ value, onChange, min = 0, max, label, icon: Icon, iconColor = "text-slate-500", tooltip, inputId, ariaLabel }: any) => (
  <div className="space-y-2">
    {label && <label htmlFor={inputId} className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1.5 h-4">{Icon && <Icon size={12} className={iconColor}/>} {label} {tooltip && <InfoTooltip text={tooltip} />}</label>}
    <div className="flex items-center bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden h-12 shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:border-indigo-500 transition-all">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        className="min-w-[48px] w-12 h-full flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-all border-r border-slate-100 dark:border-slate-800"
        aria-label={`${ariaLabel || label || 'Valore'}: diminuisci`}
        type="button"
      >
        <Minus size={16} strokeWidth={2.5} />
      </button>
      <div className="flex-1 h-full relative flex items-center justify-center bg-white/50 dark:bg-slate-900/50">
        <input
          id={inputId}
          type="number"
          value={value}
          onChange={(e) => {
            let v = parseInt(e.target.value);
            if (isNaN(v)) v = min;
            v = Math.max(min, v);
            if (max !== undefined) v = Math.min(max, v);
            onChange(v);
          }}
          min={min}
          max={max}
          className="w-full h-full min-h-[48px] min-w-[48px] bg-transparent text-center font-bold text-base text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-blue-500 appearance-none px-2 py-3"
          aria-label={ariaLabel || label || 'Valore numerico'}
        />
      </div>
      <button
        onClick={() => onChange(max ? Math.min(max, value + 1) : value + 1)}
        className="min-w-[48px] w-12 h-full flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-all border-l border-slate-100 dark:border-slate-800"
        aria-label={`${ariaLabel || label || 'Valore'}: aumenta`}
        type="button"
      >
        <Plus size={16} strokeWidth={2.5} />
      </button>
    </div>
  </div>
);

const SALARY_MIN = 0;
const SALARY_MAX = 500_000;

interface PayslipProps {
  userProfile?: UserProfileData | null;
}

const PayslipSimulator: React.FC<PayslipProps> = ({ userProfile }) => {
  const { t } = useTranslation();
  const [grossAnnual, setGrossAnnual] = useState(DEFAULT_INPUTS.annualIncomeCHF);
  const [age, setAge] = useState(DEFAULT_INPUTS.age);
  const [maritalStatus, setMaritalStatus] = useState<'single' | 'married'>(DEFAULT_INPUTS.maritalStatus === 'SINGLE' ? 'single' : 'married');
  const [children, setChildren] = useState(DEFAULT_INPUTS.children);
  const [showInfo, setShowInfo] = useState(false);
  const [salaryError, setSalaryError] = useState<string | null>(null);

  // Number formatting helpers (matching InputCard)
  const formatNumber = (n: number) => n.toLocaleString('it-IT');
  const parseNumber = (s: string) => parseInt(s.replace(/\D/g, ''), 10) || 0;

  const handleSalaryChange = (val: number) => {
    if (val < SALARY_MIN) { setSalaryError(t('input.salaryErrorNegative')); return; }
    if (val > SALARY_MAX) { setSalaryError(t('input.salaryErrorMax')); return; }
    setSalaryError(null);
    setGrossAnnual(val);
  };

  // Prefill from user profile when available
  useEffect(() => {
    if (!userProfile) return;
    if (userProfile.grossSalary) {
      const salary = parseFloat(userProfile.grossSalary);
      if (!isNaN(salary) && salary > 0) setGrossAnnual(salary);
    }
    if (userProfile.age) {
      const midpoints: Record<string, number> = { '18-25': 22, '26-35': 30, '36-45': 40, '46-55': 50, '56-65': 60, '65+': 67 };
      if (midpoints[userProfile.age]) setAge(midpoints[userProfile.age]);
    }
    if (userProfile.familySituation) {
      setMaritalStatus(userProfile.familySituation === 'married' ? 'married' : 'single');
    }
    if (userProfile.children) {
      const n = parseInt(userProfile.children, 10);
      if (!isNaN(n)) setChildren(n);
    }
  }, [userProfile]);

  const result = useMemo(() => calculatePayslip(grossAnnual, age, maritalStatus, children), [grossAnnual, age, maritalStatus, children]);
  const lppRate = getLppRate(age);
  const taxRate = getWithholdingRate(grossAnnual, maritalStatus, children);

  const deductions = [
    { key: 'avs', label: t('payslip.avs'), desc: t('payslip.avsDesc'), rate: AVS_RATE, amount: result.avs },
    { key: 'ad', label: t('payslip.ad'), desc: t('payslip.adDesc'), rate: AD_RATE, amount: result.ad },
    { key: 'ainf', label: t('payslip.ainf'), desc: t('payslip.ainfDesc'), rate: AINF_RATE, amount: result.ainf },
    { key: 'ijm', label: t('payslip.ijm'), desc: t('payslip.ijmDesc'), rate: IJM_RATE, amount: result.ijm },
    { key: 'lpp', label: t('payslip.lpp'), desc: t('payslip.lppDesc'), rate: lppRate, amount: result.lpp },
    { key: 'tax', label: t('payslip.taxSource'), desc: t('payslip.taxSourceDesc'), rate: taxRate, amount: result.taxSource },
  ];

  const fmt = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (n: number) => (n * 100).toFixed(1) + '%';

  const renderAliquoteCard = (extraClassName = '') => (
    <div className={`bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm overflow-hidden ${extraClassName}`}>
      <button
        onClick={() => setShowInfo(!showInfo)}
        className="w-full flex items-center justify-between p-4 rounded-xl transition-all duration-300 group cursor-pointer hover:bg-white/50 dark:hover:bg-slate-800/50"
        aria-label={t('payslip.lppAgeRates')}
      >
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg transition-colors ${showInfo ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}>
            <Info size={18} />
          </div>
          <span className={`text-sm font-bold transition-colors ${showInfo ? 'text-slate-800 dark:text-slate-100' : 'text-slate-600 dark:text-slate-400'}`}>
            {t('payslip.lppAgeRates')}
          </span>
        </div>
        <div className={`transition-transform duration-300 ${showInfo ? 'rotate-180 text-indigo-500' : 'text-slate-500 dark:text-slate-400'}`}>
          <ChevronDown size={18} />
        </div>
      </button>
      {showInfo && (
        <div className="px-5 pb-4 text-xs text-slate-600 dark:text-slate-400 bg-amber-50/50 dark:bg-amber-900/10 border-t border-slate-50 dark:border-slate-800/50 space-y-1 pt-3">
          {LPP_RATES.map(r => (
            <div key={r.minAge} className={`flex items-center justify-between py-1 px-2 rounded-lg ${age >= r.minAge && age <= r.maxAge ? 'font-bold text-amber-700 dark:text-amber-300 bg-amber-100/50 dark:bg-amber-900/30' : ''}`}>
              <span>{r.minAge}-{r.maxAge} {t('payslip.age').toLowerCase()}</span>
              <span>{(r.rate * 100).toFixed(1)}%</span>
            </div>
          ))}
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t('payslip.anniFiglio')}</p>
        </div>
      )}
    </div>
  );

  const handleExportPdf = async () => {
    const { default: jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(t('payslip.title'), 14, 20);
    doc.setFontSize(10);
    doc.text(`${t('payslip.grossSalary')}: CHF ${fmt(grossAnnual)}`, 14, 30);
    doc.text(`${t('payslip.age')}: ${age} | ${t('payslip.maritalStatus')}: ${maritalStatus === 'single' ? t('payslip.single') : t('payslip.married')} | ${t('payslip.children')}: ${children}`, 14, 36);

    autoTable(doc, {
      startY: 44,
      head: [[t('payslip.deduction'), t('payslip.rate'), t('payslip.amount') + ' (CHF)']],
      body: [
        ...deductions.map(d => [d.label, pct(d.rate), fmt(d.amount)]),
        [{ content: t('payslip.totalDeductions'), styles: { fontStyle: 'bold' } }, '', { content: fmt(result.totalDeductions), styles: { fontStyle: 'bold' } }],
        [{ content: t('payslip.netSalary'), styles: { fontStyle: 'bold', textColor: [22, 163, 74] } }, '', { content: 'CHF ' + fmt(result.netMonthly), styles: { fontStyle: 'bold', textColor: [22, 163, 74] } }],
      ],
    });

    doc.setFontSize(8);
    doc.setTextColor(128);
    doc.text(t('payslip.disclaimer'), 14, (doc as any).lastAutoTable.finalY + 10, { maxWidth: 180 });
    doc.save('busta-paga-svizzera.pdf');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-sm font-semibold mb-3">
          <FileText size={16} />
          {t('strumenti.payslip')}
        </div>
        <h2 className="text-2xl sm:text-3xl font-bold text-slate-800 dark:text-slate-100">{t('payslip.title')}</h2>
        <p className="text-slate-600 dark:text-slate-400 mt-2 max-w-2xl mx-auto">{t('payslip.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Input Panel — styled like InputCard */}
        <div className="lg:col-span-2 space-y-3">
          {/* Section 1: Income & Demographics */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-5 space-y-6">
            {/* Income Input — Prominent (matching InputCard) */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
                <Coins size={14} className="text-amber-500"/> {t('payslip.grossSalary')}
                <InfoTooltip text={t('payslip.grossMonthly') + ': CHF ' + fmt(grossAnnual / 12)} />
              </label>
              <div className="relative group transition-transform duration-200 focus-within:scale-[1.01]">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="text-slate-500 dark:text-slate-400 font-bold text-lg">CHF</span>
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  value={formatNumber(grossAnnual)}
                  onChange={(e) => {
                    const val = parseNumber(e.target.value);
                    handleSalaryChange(Math.max(SALARY_MIN, Math.min(SALARY_MAX, val)));
                  }}
                  className={`w-full pl-14 pr-4 py-4 bg-slate-50 dark:bg-slate-900 border-2 rounded-2xl focus:ring-4 outline-none transition-all font-bold text-slate-800 dark:text-slate-100 text-2xl tracking-tight ${salaryError ? 'border-red-400 focus:border-red-500 focus:ring-red-500/10' : 'border-slate-100 dark:border-slate-700 focus:border-indigo-500 focus:ring-indigo-500/10'}`}
                  placeholder="0"
                />
              </div>
              {salaryError && (
                <p className="text-xs text-red-600 dark:text-red-400 font-semibold mt-1 flex items-center gap-1">
                  <AlertTriangle size={12} /> {salaryError}
                </p>
              )}
            </div>

            {/* Demographics Grid */}
            <div className="grid grid-cols-[2fr_3fr] sm:grid-cols-2 gap-3 sm:gap-4">
              <StepperInput inputId="payslip-age" label={t('payslip.age')} value={age} onChange={setAge} min={18} max={65} icon={User} iconColor="text-blue-500" tooltip={t('payslip.lppAgeRates')} />
              {/* Marital Status */}
              <div className="space-y-1.5">
                <label htmlFor="payslip-status" className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1.5 h-4">
                  <Heart size={12} className="text-rose-500"/> {t('payslip.maritalStatus')}
                </label>
                <div className="relative">
                  <select
                    id="payslip-status"
                    value={maritalStatus}
                    onChange={e => setMaritalStatus(e.target.value as 'single' | 'married')}
                    className="w-full h-11 pl-2.5 sm:pl-3 pr-8 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-semibold sm:font-bold appearance-none outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 transition-all cursor-pointer text-slate-700 dark:text-slate-200"
                  >
                    <option value="single">{t('payslip.single')}</option>
                    <option value="married">{t('payslip.married')}</option>
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-3.5 text-slate-500 dark:text-slate-400 pointer-events-none"/>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Family */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 shadow-sm p-5 space-y-5">
            <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <Baby size={14} className="text-pink-500"/> {t('payslip.children')}
            </h3>
            <StepperInput
              inputId="payslip-children"
              label={null}
              ariaLabel={t('input.dependentChildren')}
              value={children}
              onChange={setChildren}
              min={0}
              max={10}
              icon={Baby}
              iconColor="text-pink-500"
            />
          </div>

          {/* Section 3: LPP Rates Info */}
          {renderAliquoteCard('hidden lg:block')}
        </div>

        {/* Results Panel */}
        <div className="lg:col-span-3 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('payslip.resultTitle')}</h3>
            <button
              onClick={handleExportPdf}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-sm font-semibold hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
              aria-label={t('payslip.exportPdf')}
            >
              <Download size={14} />
              {t('payslip.exportPdf')}
            </button>
          </div>

          {/* Gross salary header */}
          <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 mb-4">
            <div className="flex justify-between items-center">
              <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">{t('payslip.grossMonthly')}</span>
              <span className="text-xl font-bold text-slate-800 dark:text-slate-100">CHF {fmt(result.grossMonthly)}</span>
            </div>
          </div>

          {/* Deductions table */}
          <div className="space-y-2">
            {deductions.map(d => (
              <div key={d.key} className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors group">
                <div className="flex-1">
                  <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">{d.label}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{d.desc}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-500 dark:text-slate-400">{pct(d.rate)}</div>
                  <div className="text-sm font-semibold text-red-600 dark:text-red-400">-{fmt(d.amount)}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Separator */}
          <div className="border-t border-slate-200 dark:border-slate-700 my-4" />

          {/* Total deductions */}
          <div className="flex items-center justify-between py-2 px-3">
            <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{t('payslip.totalDeductions')}</span>
            <span className="text-lg font-bold text-red-600 dark:text-red-400">-CHF {fmt(result.totalDeductions)}</span>
          </div>

          {/* Net salary */}
          <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 mt-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-emerald-700 dark:text-emerald-300">{t('payslip.netSalary')}</div>
                <div className="text-xs text-emerald-700 dark:text-emerald-400">{t('payslip.netAnnual')}: CHF {fmt(result.netMonthly * 12)}</div>
              </div>
              <span className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">CHF {fmt(result.netMonthly)}</span>
            </div>
          </div>

          {/* Visual bar chart */}
          <div className="mt-6 space-y-2">
            {deductions.map(d => {
              const widthPct = (d.amount / result.grossMonthly) * 100;
              return (
                <div key={d.key + '-bar'} className="flex items-center gap-2">
                  <span className="text-xs text-slate-600 dark:text-slate-400 w-28 truncate">{d.label}</span>
                  <div className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                    <div
                      className="h-full bg-red-400 dark:bg-red-500 rounded-full transition-all duration-500"
                      style={{ width: `${Math.max(widthPct, 1)}%` }}
                    />
                  </div>
                  <span className="text-xs text-slate-500 dark:text-slate-400 w-12 text-right">{pct(d.rate)}</span>
                </div>
              );
            })}
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 w-28 truncate">{t('payslip.netSalary')}</span>
              <div className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 dark:bg-emerald-400 rounded-full transition-all duration-500"
                  style={{ width: `${(result.netMonthly / result.grossMonthly) * 100}%` }}
                />
              </div>
              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 w-12 text-right">{((result.netMonthly / result.grossMonthly) * 100).toFixed(1)}%</span>
            </div>
          </div>

          {/* Mobile: aliquote sotto il dettaglio busta paga */}
          {renderAliquoteCard('lg:hidden mt-6')}

          {/* Disclaimer */}
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-4 leading-relaxed">
            ⚠️ {t('payslip.disclaimer')}
          </p>
          <div className="flex items-center gap-1.5 mt-2 text-xs text-emerald-700 dark:text-emerald-400">
            <Shield size={12} className="flex-shrink-0" />
            <span>{t('payslip.dataPrivacy')}</span>
          </div>
        </div>
      </div>
      <Suspense fallback={null}><RelatedTools context="payslip" /></Suspense>
    </div>
  );
};

export default PayslipSimulator;
