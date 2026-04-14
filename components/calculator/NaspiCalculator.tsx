import { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import { useExchangeRate } from '@/services/exchangeRateService';
import { Calculator, TrendingDown, Euro, Clock, Info, ChevronDown, ChevronUp } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useTranslation } from '@/services/i18n';

const LeadMagnetCTA = lazy(() => import('@/components/shared/LeadMagnetCTA'));

// ── NASPI 2026 constants (INPS circular) ─────────────────────
const NASPI_THRESHOLD = 1_352.19; // € — soglia retribuzione mensile
const NASPI_MAX_MONTHLY = 1_550.27; // € — tetto massimo mensile
const RATE_BELOW = 0.75; // 75% fino alla soglia
const RATE_ABOVE = 0.25; // 25% sull'eccedenza
const DECALAGE_RATE = 0.03; // -3% al mese
const DECALAGE_START_NORMAL = 6; // dal 6° mese (< 55 anni)
const DECALAGE_START_SENIOR = 8; // dall'8° mese (≥ 55 anni)
const MAX_DURATION_MONTHS = 24;
const WEEKS_PER_MONTH = 4.33;
const FALLBACK_EXCHANGE_RATE = 0.95;

interface MonthRow {
 month: number;
 gross: number;
 cumulative: number;
 decalagePercent: number;
}

function calculateNaspi(
 grossMonthlyCHF: number,
 monthsWorked: number,
 age: number,
 exchangeRate: number,
): { monthlyInitial: number; duration: number; rows: MonthRow[]; totalGross: number } {
 // Convert CHF → EUR
 const grossMonthlyEUR = grossMonthlyCHF * exchangeRate;

 // Calculate initial monthly amount
 const belowThreshold = Math.min(grossMonthlyEUR, NASPI_THRESHOLD);
 const aboveThreshold = Math.max(0, grossMonthlyEUR - NASPI_THRESHOLD);
 let monthlyInitial = belowThreshold * RATE_BELOW + aboveThreshold * RATE_ABOVE;
 monthlyInitial = Math.min(monthlyInitial, NASPI_MAX_MONTHLY);

 // Duration: half the weeks contributed in last 4 years, capped at 24 months
 const weeksContributed = Math.round(monthsWorked * WEEKS_PER_MONTH);
 const durationWeeks = Math.floor(weeksContributed / 2);
 const duration = Math.min(Math.ceil(durationWeeks / WEEKS_PER_MONTH), MAX_DURATION_MONTHS);

 // Decalage start based on age
 const decalageStart = age >= 55 ? DECALAGE_START_SENIOR : DECALAGE_START_NORMAL;

 // Build month-by-month table
 const rows: MonthRow[] = [];
 let cumulative = 0;
 for (let m = 1; m <= duration; m++) {
 const decalageMonths = m >= decalageStart ? m - decalageStart : 0;
 const decalagePercent = decalageMonths * DECALAGE_RATE;
 const gross = Math.max(0, monthlyInitial * (1 - decalagePercent));
 cumulative += gross;
 rows.push({ month: m, gross: Math.round(gross * 100) / 100, cumulative: Math.round(cumulative * 100) / 100, decalagePercent: Math.round(decalagePercent * 100) });
 }

 return {
 monthlyInitial: Math.round(monthlyInitial * 100) / 100,
 duration,
 rows,
 totalGross: Math.round(cumulative * 100) / 100,
 };
}

export default function NaspiCalculator() {
 const { t } = useTranslation();
 const [salary, setSalary] = useState(5500);
 const [monthsWorked, setMonthsWorked] = useState(24);
 const [age, setAge] = useState(35);
 const { rate: _liveRate } = useExchangeRate();
 const [exchangeRate, setExchangeRate] = useState(_liveRate || FALLBACK_EXCHANGE_RATE);
 useEffect(() => { if (_liveRate > 0) setExchangeRate(_liveRate); }, [_liveRate]);
 const [showTable, setShowTable] = useState(false);
 const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

 useEffect(() => {
 const observer = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
 observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
 return () => observer.disconnect();
 }, []);

 const result = useMemo(
 () => calculateNaspi(salary, monthsWorked, age, exchangeRate),
 [salary, monthsWorked, age, exchangeRate],
 );

 const formatEUR = (v: number) =>
 v.toLocaleString('it-CH', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

 const formatEUR2 = (v: number) =>
 v.toLocaleString('it-CH', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

 return (
 <div className="bg-gradient-to-br from-success-subtle to-info-subtle rounded-2xl border border-success-border p-5 space-y-5">
 {/* Header */}
 <div className="flex items-center gap-3">
 <div className="p-2.5 bg-success-subtle rounded-xl">
 <Calculator size={22} className="text-success" />
 </div>
 <div>
 <h3 className="text-lg font-bold text-strong">
 {t('naspi.calc.title')}
 </h3>
 <p className="text-sm text-subtle">
 {t('naspi.calc.subtitle')}
 </p>
 </div>
 </div>

 {/* Info banner */}
 <div className="flex items-start gap-2.5 bg-accent-subtle rounded-xl p-3 border border-accent-border">
 <Info size={16} className="text-stripe-500 mt-0.5 shrink-0" />
 <p className="text-sm text-accent">
 {t('naspi.calc.disclaimer')}
 </p>
 </div>

 {/* Input form */}
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
 {/* Salary */}
 <div>
 <label htmlFor="naspi-salary" className="block text-sm font-medium text-body mb-1">
 {t('naspi.calc.salary')}
 </label>
 <div className="relative">
 <input
 id="naspi-salary"
 type="number"
 inputMode="numeric"
 min={1000}
 max={30000}
 step={100}
 value={salary}
 onChange={(e) => setSalary(Number(e.target.value) || 0)}
 className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-strong focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:border-emerald-500 outline-none"
 />
 <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">CHF</span>
 </div>
 <p className="text-xs text-muted mt-1">{t('naspi.calc.salaryHint')}</p>
 </div>

 {/* Months worked */}
 <div>
 <label htmlFor="naspi-months" className="block text-sm font-medium text-body mb-1">
 {t('naspi.calc.monthsWorked')}
 </label>
 <input
 id="naspi-months"
 type="number"
 inputMode="numeric"
 min={3}
 max={48}
 step={1}
 value={monthsWorked}
 onChange={(e) => setMonthsWorked(Math.min(48, Math.max(3, Number(e.target.value) || 3)))}
 className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-strong focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:border-emerald-500 outline-none"
 />
 <p className="text-xs text-muted mt-1">{t('naspi.calc.monthsHint')}</p>
 </div>

 {/* Age */}
 <div>
 <label htmlFor="naspi-age" className="block text-sm font-medium text-body mb-1">
 {t('naspi.calc.age')}
 </label>
 <input
 id="naspi-age"
 type="number"
 inputMode="numeric"
 min={18}
 max={67}
 step={1}
 value={age}
 onChange={(e) => setAge(Number(e.target.value) || 35)}
 className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-strong focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:border-emerald-500 outline-none"
 />
 <p className="text-xs text-muted mt-1">
 {t('naspi.calc.ageHint')}
 </p>
 </div>

 {/* Exchange rate */}
 <div>
 <label htmlFor="naspi-rate" className="block text-sm font-medium text-body mb-1">
 {t('naspi.calc.exchangeRate')}
 </label>
 <input
 id="naspi-rate"
 type="number"
 inputMode="decimal"
 min={0.7}
 max={1.2}
 step={0.01}
 value={exchangeRate}
 onChange={(e) => setExchangeRate(Number(e.target.value) || FALLBACK_EXCHANGE_RATE)}
 className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-strong focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:border-emerald-500 outline-none"
 />
 <p className="text-xs text-muted mt-1">{t('naspi.calc.rateHint')}</p>
 </div>
 </div>

 {/* Results KPI cards */}
 <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
 <div className="bg-surface rounded-xl p-3 border border-edge text-center">
 <Euro size={18} className="text-emerald-500 mx-auto mb-1" />
 <div className="text-lg font-bold text-success">{formatEUR(result.monthlyInitial)}</div>
 <div className="text-xs text-subtle">{t('naspi.calc.monthlyAmount')}</div>
 </div>
 <div className="bg-surface rounded-xl p-3 border border-edge text-center">
 <Clock size={18} className="text-stripe-500 mx-auto mb-1" />
 <div className="text-lg font-bold text-link">{result.duration} {t('naspi.calc.months')}</div>
 <div className="text-xs text-subtle">{t('naspi.calc.duration')}</div>
 </div>
 <div className="bg-surface rounded-xl p-3 border border-edge text-center">
 <TrendingDown size={18} className="text-orange-500 mx-auto mb-1" />
 <div className="text-lg font-bold text-warning">
 {result.rows.length > 0 ? formatEUR(result.rows[result.rows.length - 1].gross) : '—'}
 </div>
 <div className="text-xs text-subtle">{t('naspi.calc.lastMonth')}</div>
 </div>
 <div className="bg-surface rounded-xl p-3 border border-edge text-center">
 <Calculator size={18} className="text-stripe-500 mx-auto mb-1" />
 <div className="text-lg font-bold text-accent">{formatEUR(result.totalGross)}</div>
 <div className="text-xs text-subtle">{t('naspi.calc.totalGross')}</div>
 </div>
 </div>

 {/* Chart */}
 {result.rows.length > 0 && (
 <div className="bg-surface rounded-xl border border-edge p-4">
 <h4 className="text-sm font-bold text-body mb-3">{t('naspi.calc.chartTitle')}</h4>
 <ResponsiveContainer width="100%" height={220}>
 <LineChart data={result.rows} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
 <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#e2e8f0'} />
 <XAxis
 dataKey="month"
 tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }}
 label={{ value: t('naspi.calc.monthLabel'), position: 'insideBottom', offset: -2, fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }}
 />
 <YAxis
 tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }}
 tickFormatter={(v: number) => `€${v}`}
 />
 <Tooltip
 formatter={(value: number) => [formatEUR2(value), t('naspi.calc.grossAmount')]}
 labelFormatter={(label: number) => `${t('naspi.calc.monthLabel')} ${label}`}
 contentStyle={{ borderRadius: '8px', fontSize: '12px', backgroundColor: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#1e293b', border: 'none' }}
 />
 <ReferenceLine
 y={result.monthlyInitial}
 stroke={isDark ? '#64748b' : '#94a3b8'}
 strokeDasharray="4 4"
 label={{ value: t('naspi.calc.initialAmount'), position: 'right', fontSize: 10, fill: isDark ? '#64748b' : '#94a3b8' }}
 />
 <Line
 type="stepAfter"
 dataKey="gross"
 stroke="#10b981"
 strokeWidth={2.5}
 dot={{ r: 3, fill: '#10b981' }}
 activeDot={{ r: 5 }}
 />
 </LineChart>
 </ResponsiveContainer>
 </div>
 )}

 {/* Detailed table (collapsed by default) */}
 <button
 onClick={() => setShowTable(!showTable)}
 className="flex items-center gap-2 text-sm font-medium text-success hover:text-success transition-colors"
 aria-label={showTable ? t('naspi.calc.hideTable') : t('naspi.calc.showTable')}
 >
 {showTable ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
 {showTable ? t('naspi.calc.hideTable') : t('naspi.calc.showTable')}
 </button>

 {showTable && result.rows.length > 0 && (
 <div className="overflow-x-auto">
 <table className="w-full text-sm">
 <thead>
 <tr className="bg-success-subtle">
 <th className="p-2 text-left rounded-tl-lg">{t('naspi.calc.tableMonth')}</th>
 <th className="p-2 text-right">{t('naspi.calc.tableGross')}</th>
 <th className="p-2 text-right">{t('naspi.calc.tableDecalage')}</th>
 <th className="p-2 text-right rounded-tr-lg">{t('naspi.calc.tableCumulative')}</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-edge">
 {result.rows.map((r) => (
 <tr key={r.month} className={r.decalagePercent > 0 ? 'bg-warning-subtle/70' : ''}>
 <td className="p-2 font-medium text-body">{r.month}</td>
 <td className="p-2 text-right text-strong">{formatEUR2(r.gross)}</td>
 <td className="p-2 text-right text-warning">
 {r.decalagePercent > 0 ? `-${r.decalagePercent}%` : '—'}
 </td>
 <td className="p-2 text-right text-subtle">{formatEUR(r.cumulative)}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 {/* Formula explanation */}
 <div className="bg-surface-alt/50 rounded-xl p-4 border border-edge">
 <h4 className="text-sm font-bold text-body mb-2">{t('naspi.calc.howTitle')}</h4>
 <ul className="text-xs text-subtle space-y-1.5">
 <li>• <strong>{t('naspi.calc.howAmount')}</strong>: {t('naspi.calc.howAmountDesc')}</li>
 <li>• <strong>{t('naspi.calc.howCap')}</strong>: {t('naspi.calc.howCapDesc')}</li>
 <li>• <strong>{t('naspi.calc.howDuration')}</strong>: {t('naspi.calc.howDurationDesc')}</li>
 <li>• <strong>{t('naspi.calc.howDecalage')}</strong>: {t('naspi.calc.howDecalageDesc')}</li>
 <li>• <strong>{t('naspi.calc.howFrontalieri')}</strong>: {t('naspi.calc.howFrontalieriDesc')}</li>
 </ul>
 </div>

 {/* Lead Magnet CTA */}
 <Suspense fallback={null}>
 <LeadMagnetCTA variant="tax_checklist" delay={3000} />
 </Suspense>
 </div>
 );
}
