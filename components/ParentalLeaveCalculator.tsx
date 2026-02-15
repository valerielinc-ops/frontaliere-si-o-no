import React, { useState, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { useExchangeRate } from '@/services/exchangeRateService';
import { Baby, Info, Calendar, ChevronDown, ChevronUp, FileText, CheckCircle2, RefreshCw } from 'lucide-react';

// ─── Swiss IPG (Maternity/Paternity Insurance) ──────────────────────────

// Switzerland: Mutterschaftsentschädigung (MSE)
// - 14 weeks (98 days) maternity leave, 80% of insured salary (max CHF 220/day = CHF 6'720/month)
// - Paternity: 2 weeks (10 working days), 80% of salary (max CHF 220/day)
const IPG_DAILY_MAX_CHF = 220;
const IPG_RATE = 0.80;
const MATERNITY_WEEKS_CH = 14;
const PATERNITY_WEEKS_CH = 2;
const WORKING_DAYS_PER_WEEK = 5;

// Italy: INPS Maternità obbligatoria
// - 5 months (2 before + 3 after OR 1 before + 4 after), 80% of salary
// - Paternity: 10 days at 100%
// - Congedo parentale: 6 months additional at 30%
const MATERNITY_MONTHS_IT = 5;
const MATERNITY_RATE_IT = 0.80;
const PATERNITY_DAYS_IT = 10;
const PATERNITY_RATE_IT = 1.0;
const PARENTAL_MONTHS_IT = 6;
const PARENTAL_RATE_IT = 0.30;

interface LeaveResult {
  dailyAllowance: number;
  totalAllowance: number;
  duration: string;
  rate: number;
  maxMonthly: number;
  notes: string[];
}

function calculateSwissLeave(grossMonthlyCHF: number, type: 'maternity' | 'paternity'): LeaveResult {
  const dailySalary = (grossMonthlyCHF * 12) / 260; // 260 working days/year
  const dailyAllowance = Math.min(dailySalary * IPG_RATE, IPG_DAILY_MAX_CHF);
  const weeks = type === 'maternity' ? MATERNITY_WEEKS_CH : PATERNITY_WEEKS_CH;
  const days = weeks * WORKING_DAYS_PER_WEEK;
  const totalAllowance = dailyAllowance * days;

  return {
    dailyAllowance,
    totalAllowance,
    duration: type === 'maternity' ? '14 settimane (98 giorni)' : '2 settimane (10 giorni lavorativi)',
    rate: IPG_RATE,
    maxMonthly: IPG_DAILY_MAX_CHF * 21.7,
    notes: type === 'maternity'
      ? ['leave.ch.maternity.note1', 'leave.ch.maternity.note2', 'leave.ch.maternity.note3']
      : ['leave.ch.paternity.note1', 'leave.ch.paternity.note2'],
  };
}

function calculateItalianLeave(grossMonthlyEUR: number, type: 'maternity' | 'paternity'): LeaveResult {
  if (type === 'paternity') {
    const dailySalary = grossMonthlyEUR / 21.7;
    return {
      dailyAllowance: dailySalary * PATERNITY_RATE_IT,
      totalAllowance: dailySalary * PATERNITY_RATE_IT * PATERNITY_DAYS_IT,
      duration: '10 giorni lavorativi',
      rate: PATERNITY_RATE_IT,
      maxMonthly: grossMonthlyEUR,
      notes: ['leave.it.paternity.note1', 'leave.it.paternity.note2'],
    };
  }
  // Maternity
  const monthlyAllowance = grossMonthlyEUR * MATERNITY_RATE_IT;
  return {
    dailyAllowance: monthlyAllowance / 21.7,
    totalAllowance: monthlyAllowance * MATERNITY_MONTHS_IT,
    duration: '5 mesi (2+3 o 1+4)',
    rate: MATERNITY_RATE_IT,
    maxMonthly: monthlyAllowance,
    notes: ['leave.it.maternity.note1', 'leave.it.maternity.note2', 'leave.it.maternity.note3'],
  };
}

// ─── Documents Checklist ─────────────────────────────────────────────────

interface DocumentItem {
  key: string;
  country: 'CH' | 'IT' | 'both';
}

const MATERNITY_DOCS: DocumentItem[] = [
  { key: 'leave.doc.medCertificate', country: 'both' },
  { key: 'leave.doc.ipgForm', country: 'CH' },
  { key: 'leave.doc.inpsDomanda', country: 'IT' },
  { key: 'leave.doc.birthCertificate', country: 'both' },
  { key: 'leave.doc.employerNotice', country: 'both' },
  { key: 'leave.doc.e104Form', country: 'both' },
];

const PATERNITY_DOCS: DocumentItem[] = [
  { key: 'leave.doc.birthCertificate', country: 'both' },
  { key: 'leave.doc.ipgFormPat', country: 'CH' },
  { key: 'leave.doc.inpsDomandaPat', country: 'IT' },
  { key: 'leave.doc.employerNotice', country: 'both' },
];

// ─── Component ───────────────────────────────────────────────────────────

const ParentalLeaveCalculator: React.FC = () => {
  const { t } = useTranslation();
  const { rate: chfEurRate, loading: rateLoading } = useExchangeRate();
  const [grossMonthlyCHF, setGrossMonthlyCHF] = useState(7000);
  const [leaveType, setLeaveType] = useState<'maternity' | 'paternity'>('maternity');
  const [showDocs, setShowDocs] = useState(false);
  const [showParental, setShowParental] = useState(false);

  // CHF→EUR rate from API (e.g. 0.94)
  const grossMonthlyEUR = grossMonthlyCHF * chfEurRate;

  const chResult = useMemo(() => calculateSwissLeave(grossMonthlyCHF, leaveType), [grossMonthlyCHF, leaveType]);
  const itResult = useMemo(() => calculateItalianLeave(grossMonthlyEUR, leaveType), [grossMonthlyEUR, leaveType]);

  // Frontalieri: get BOTH — CH IPG + IT integration if applicable
  const totalFrontaliereEUR = (chResult.totalAllowance * chfEurRate);
  
  // Parental leave (congedo parentale) — only available in Italy after maternity
  const parentalMonthlyEUR = grossMonthlyEUR * PARENTAL_RATE_IT;
  const parentalTotalEUR = parentalMonthlyEUR * PARENTAL_MONTHS_IT;

  const fmt = (n: number, c: string = '€') => `${c} ${Math.round(n).toLocaleString('it-IT')}`;
  const docs = leaveType === 'maternity' ? MATERNITY_DOCS : PATERNITY_DOCS;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-pink-50 to-rose-50 dark:from-pink-950/30 dark:to-rose-950/30 rounded-2xl p-6 border border-pink-200 dark:border-pink-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-pink-100 dark:bg-pink-900/50 rounded-xl">
            <Baby className="w-6 h-6 text-pink-600 dark:text-pink-400" />
          </div>
          <h2 className="text-2xl font-bold text-pink-900 dark:text-pink-100">{t('leave.title')}</h2>
        </div>
        <p className="text-pink-700 dark:text-pink-300 text-sm">{t('leave.subtitle')}</p>
      </div>

      {/* Type Selector */}
      <div className="flex gap-2 bg-white dark:bg-slate-800 rounded-xl p-1.5 border border-slate-200 dark:border-slate-700 max-w-md">
        <button
          onClick={() => setLeaveType('maternity')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold rounded-lg transition-colors ${
            leaveType === 'maternity' ? 'bg-pink-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
          }`}
        >
          <Baby size={16} />
          {t('leave.maternity')}
        </button>
        <button
          onClick={() => setLeaveType('paternity')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold rounded-lg transition-colors ${
            leaveType === 'paternity' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
          }`}
        >
          <Baby size={16} />
          {t('leave.paternity')}
        </button>
      </div>

      {/* Inputs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">{t('leave.grossMonthlyCHF')}</label>
          <input
            type="number"
            value={grossMonthlyCHF}
            onChange={(e) => setGrossMonthlyCHF(Number(e.target.value) || 0)}
            className="w-full px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 font-bold"
            min={3000}
            max={25000}
            step={100}
          />
          <input type="range" min={3000} max={15000} step={100} value={grossMonthlyCHF}
            onChange={(e) => setGrossMonthlyCHF(Number(e.target.value))}
            className="w-full mt-2 accent-pink-600"
          />
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">{t('leave.exchangeRate')}</label>
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
            <span className="font-bold text-slate-800 dark:text-slate-200">1 CHF = {chfEurRate.toFixed(4)} EUR</span>
            {rateLoading && <RefreshCw size={14} className="animate-spin text-slate-500" />}
          </div>
          <p className="text-[10px] text-slate-500 mt-1">{t('exchange.liveRate') || 'Tasso live da frankfurter.app'}</p>
        </div>
      </div>

      {/* Results */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Swiss IPG */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="bg-red-600 h-1.5" />
          <div className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">🇨🇭</span>
              <h3 className="font-bold text-slate-800 dark:text-slate-200">{t('leave.chTitle')}</h3>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">{t('leave.duration')}</span>
                <span className="font-bold">{chResult.duration}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{t('leave.rate')}</span>
                <span className="font-bold">{(chResult.rate * 100).toFixed(0)}% {t('leave.ofSalary')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{t('leave.dailyAllowance')}</span>
                <span className="font-bold">{fmt(chResult.dailyAllowance, 'CHF')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{t('leave.maxDaily')}</span>
                <span className="text-xs text-slate-500">CHF {IPG_DAILY_MAX_CHF}/giorno</span>
              </div>
              <hr className="border-slate-200 dark:border-slate-600" />
              <div className="flex justify-between">
                <span className="font-bold">{t('leave.totalAllowance')}</span>
                <span className="font-black text-lg text-emerald-600 dark:text-emerald-400">{fmt(chResult.totalAllowance, 'CHF')}</span>
              </div>
              <div className="flex justify-between text-slate-500">
                <span>{t('leave.inEUR')}</span>
                <span className="font-bold">{fmt(chResult.totalAllowance * chfEurRate)}</span>
              </div>
            </div>

            <div className="space-y-1 mt-3">
              {chResult.notes.map((note, i) => (
                <p key={i} className="text-xs text-slate-500 flex items-start gap-1">
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  {t(note)}
                </p>
              ))}
            </div>
          </div>
        </div>

        {/* Italian INPS */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="bg-gradient-to-r from-green-600 via-white to-red-600 h-1.5" />
          <div className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">🇮🇹</span>
              <h3 className="font-bold text-slate-800 dark:text-slate-200">{t('leave.itTitle')}</h3>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">{t('leave.duration')}</span>
                <span className="font-bold">{itResult.duration}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{t('leave.rate')}</span>
                <span className="font-bold">{(itResult.rate * 100).toFixed(0)}% {t('leave.ofSalary')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{t('leave.dailyAllowance')}</span>
                <span className="font-bold">{fmt(itResult.dailyAllowance)}</span>
              </div>
              <hr className="border-slate-200 dark:border-slate-600" />
              <div className="flex justify-between">
                <span className="font-bold">{t('leave.totalAllowance')}</span>
                <span className="font-black text-lg text-emerald-600 dark:text-emerald-400">{fmt(itResult.totalAllowance)}</span>
              </div>
            </div>

            <div className="space-y-1 mt-3">
              {itResult.notes.map((note, i) => (
                <p key={i} className="text-xs text-slate-500 flex items-start gap-1">
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  {t(note)}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Frontaliere Summary */}
      <div className="bg-gradient-to-r from-indigo-50 to-violet-50 dark:from-indigo-950/30 dark:to-violet-950/30 rounded-2xl p-5 border border-indigo-200 dark:border-indigo-800">
        <h4 className="font-bold text-indigo-800 dark:text-indigo-200 mb-3 flex items-center gap-2">
          <Calendar className="w-5 h-5" />
          {t('leave.frontaliereTitle')}
        </h4>
        <p className="text-sm text-indigo-700 dark:text-indigo-300 mb-3">{t('leave.frontaliereDesc')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="bg-white/60 dark:bg-slate-800/60 rounded-lg p-3">
            <p className="text-slate-500">{t('leave.chIPG')}</p>
            <p className="font-black text-lg">{fmt(chResult.totalAllowance, 'CHF')}</p>
            <p className="text-xs text-slate-500">≈ {fmt(totalFrontaliereEUR)}</p>
          </div>
          <div className="bg-white/60 dark:bg-slate-800/60 rounded-lg p-3">
            <p className="text-slate-500">{t('leave.monthlySalaryLoss')}</p>
            <p className="font-black text-lg text-amber-600">-{fmt(grossMonthlyCHF - chResult.maxMonthly / (leaveType === 'maternity' ? 3.5 : 1), 'CHF')}</p>
            <p className="text-xs text-slate-500">{t('leave.vsFullSalary')}</p>
          </div>
        </div>
      </div>

      {/* Congedo Parentale (after maternity) */}
      {leaveType === 'maternity' && (
        <>
          <button
            onClick={() => setShowParental(!showParental)}
            className="flex items-center gap-2 text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 transition-colors"
          >
            {showParental ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {t('leave.parentalTitle')}
          </button>

          {showParental && (
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 space-y-3">
              <h4 className="font-bold text-slate-800 dark:text-slate-200">{t('leave.parentalTitle')}</h4>
              <p className="text-sm text-slate-500">{t('leave.parentalDesc')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3">
                  <p className="text-slate-500">{t('leave.duration')}</p>
                  <p className="font-bold">6 {t('leave.months')}</p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3">
                  <p className="text-slate-500">{t('leave.rate')}</p>
                  <p className="font-bold">30% {t('leave.ofSalary')}</p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3">
                  <p className="text-slate-500">{t('leave.total')}</p>
                  <p className="font-bold text-emerald-600">{fmt(parentalTotalEUR)}</p>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Documents Checklist */}
      <button
        onClick={() => setShowDocs(!showDocs)}
        className="flex items-center gap-2 text-sm font-bold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
      >
        <FileText size={16} />
        {showDocs ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        {t('leave.docsTitle')}
      </button>

      {showDocs && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
          <div className="space-y-2">
            {docs.map((doc, i) => (
              <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                <CheckCircle2 className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
                <span className="text-sm text-slate-700 dark:text-slate-300 flex-1">{t(doc.key)}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  doc.country === 'CH' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                  doc.country === 'IT' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                }`}>
                  {doc.country === 'both' ? 'CH + IT' : doc.country}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-800">
        <p className="text-xs text-amber-700 dark:text-amber-300">
          <Info className="inline w-3 h-3 mr-1" />
          {t('leave.disclaimer')}
        </p>
      </div>
    </div>
  );
};

export default ParentalLeaveCalculator;
