import React, { useState, useMemo } from 'react';
import { 
 BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, 
 PieChart, Pie, AreaChart, Area, Legend, LineChart, Line
} from 'recharts';
import { SimulationResult, TaxResult, SimulationInputs } from '../../types';
import { BarChart3, PieChart as PieIcon, TrendingUp, Wallet, Percent, ArrowUpRight, Info, LineChart as LineIcon, Layers } from 'lucide-react';
import { calculateSimulation } from '../../services/calculationService';
import { Analytics } from '../../services/analytics';
import { useTranslation } from '../../services/i18n';
import { SegmentControl } from '../shared/SegmentControl';

interface Props {
 result: SimulationResult;
 inputs: SimulationInputs;
 isDarkMode?: boolean;
 isFocusMode?: boolean;
}

/** Centralized Recharts color palette — hex values required by Recharts (cannot use Tailwind classes) */
const CHART_COLORS = {
 // Pie / breakdown categories
 default: '#cbd5e1', // slate-300
 social: '#8b5cf6', // stripe-500
 pension: '#a78bfa', // stripe-400
 tax: '#64748b', // slate-500
 health: '#f43f5e', // rose-500
 expense: '#f59e0b', // amber-500
 netResidual: '#10b981', // emerald-500
 // Line chart series
 residentCH: '#3b82f6', // stripe-500
 newLess20km: '#6366f1', // stripe-500
 newMore20km: '#f97316', // orange-500
 oldFrontier: '#10b981', // emerald-500
 // Area chart
 savings: '#10b981', // emerald-500
 // Grid & axes
 gridDark: '#334155', // slate-700
 gridLight: '#f1f5f9', // slate-50
 tickDark: '#94a3b8', // slate-400
 tickLight: '#64748b', // slate-500
} as const;

// Custom Tooltip for Charts
const CustomTooltip = ({ active, payload, label, isDarkMode, currency ="CHF" }: any) => {
 if (active && payload && payload.length) {
 return (
 <div className={`p-4 border rounded-2xl shadow-xl min-w-[180px] z-50 pointer-events-none ${isDarkMode ? 'bg-slate-900 border-slate-700 shadow-slate-950/50' : 'bg-white border-slate-100 shadow-slate-200/50'}`}>
 {label && <p className={`font-bold mb-3 text-xs uppercase tracking-wider border-b pb-2 ${isDarkMode ? 'text-muted border-slate-700' : 'text-muted border-slate-100'}`}>{label}</p>}
 <div className="space-y-2">
 {payload.map((entry: any, index: number) => (
 <div key={index} className="flex items-center justify-between gap-4 text-xs">
 <div className="flex items-center gap-2">
 <div className="w-2.5 h-2.5 rounded-full shadow-sm" style={{ backgroundColor: entry.color || entry.fill || entry.stroke }} />
 <span className={`font-bold ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>{entry.name}</span>
 </div>
 <span className={`font-mono font-bold ${isDarkMode ? 'text-slate-100' : 'text-slate-800'} tabular-nums`}>
 {currency} {entry.value.toLocaleString('it-IT', {maximumFractionDigits: 0})}
 </span>
 </div>
 ))}
 </div>
 </div>
 );
 }
 return null;
};

// Fixed Legend Component
const FixedLegend = ({ payload, isDarkMode }: any) => {
 return (
 <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 pt-4 px-2">
 {payload.map((entry: any, index: number) => (
 <div key={`item-${index}`} className="flex items-center gap-2">
 <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color || entry.fill || entry.stroke }} />
 <span className={`text-xs font-bold uppercase tracking-wide ${isDarkMode ? 'text-muted' : 'text-subtle'}`}>
 {entry.value}
 </span>
 </div>
 ))}
 </div>
 );
};

// KPI Card Component
const KpiCard = ({ title, value, subtext, icon: Icon, colorClass }: any) => (
 <div className="bg-surface-alt/50 rounded-2xl p-4 border border-edge flex items-start justify-between group hover:border-edge transition-colors">
 <div>
 <p className="text-xs font-bold uppercase text-muted tracking-wider mb-1">{title}</p>
 <p className={`text-xl font-mono font-bold ${colorClass}`}>{value}</p>
 {subtext && <p className="text-xs text-muted mt-1">{subtext}</p>}
 </div>
 <div className={`p-2 rounded-xl bg-surface shadow-sm ${colorClass.replace('text-', 'text-opacity-80 text-')}`}>
 <Icon size={18} />
 </div>
 </div>
);

const ComparisonChartBase: React.FC<Props> = ({ result, inputs, isDarkMode, isFocusMode }) => {
 const { t } = useTranslation();
 const [activeTab, setActiveTab] = useState<'overview' | 'breakdown' | 'projection' | 'breakeven'>('overview');
 const [analysisMode, setAnalysisMode] = useState<'NET' | 'TAX'>('NET');

 const handleTabChange = (tabId: 'overview' | 'breakdown' | 'projection' | 'breakeven') => {
 setActiveTab(tabId);
 Analytics.trackChartInteraction(tabId, 'change_tab');
 };

 const { chResident, itResident, savingsCHF } = result;
 
 // Data for Bar Chart (Overview)
 const netLabel = t('chart.net');
 const taxLabel = t('chart.taxes');
 const socialLabel = t('chart.social');
 const barData = [
 { name: t('chart.switzerland'), [netLabel]: chResident.netIncomeAnnual, [taxLabel]: chResident.taxes, [socialLabel]: chResident.socialContributions + chResident.healthInsurance },
 { name: t('chart.frontier_worker'), [netLabel]: itResident.netIncomeAnnual, [taxLabel]: itResident.taxes, [socialLabel]: itResident.socialContributions },
 ];

 // --- Data for Detailed Composition Chart ---
 const getDetailedPieData = (res: TaxResult) => {
 return res.breakdown
 .filter(item => !item.label.includes('grossIncome') && !item.label.includes('Allowance') && !item.label.includes('netAnnual'))
 .map(item => {
 let color: string = CHART_COLORS.default;
 const l = item.label.toLowerCase();
 if(l.includes('social') || l.includes('avs')) color = CHART_COLORS.social;
 if(l.includes('pension') || l.includes('lpp')) color = CHART_COLORS.pension;
 if(l.includes('tax') || l.includes('source') || l.includes('irpef')) color = CHART_COLORS.tax;
 if(l.includes('health') || l.includes('ssn')) color = CHART_COLORS.health;
 if(l.includes('expense')) color = CHART_COLORS.expense;
 
 return {
 name: t(item.label.split('|')[0]),
 value: Math.abs(item.amount), 
 color: color
 };
 })
 .concat([{ name: t('chart.net_residual'), value: res.netIncomeAnnual, color: CHART_COLORS.netResidual }]);
 };

 const pieDataCH = getDetailedPieData(chResident);
 const pieDataIT = getDetailedPieData(itResident);

 // Data for Projection (Area Chart)
 const projectionYears = 5;
 const projectionData = Array.from({ length: projectionYears + 1 }, (_, i) => {
 return {
 year: `${t('chart.year')} ${i}`,
 [t('chart.accumulated_difference')]: Math.abs(savingsCHF) * i,
 beneficiary: savingsCHF > 0 ? t('chart.frontier_worker') : t('chart.resident')
 };
 });

 // Data for Break-even Analysis (Line Chart)
 const breakEvenData = useMemo(() => {
 try {
 const data = [];
 for (let income = 50000; income <= 300000; income += 10000) {
 // 1. CH Resident
 const simCH = calculateSimulation({ ...inputs, annualIncomeCHF: income });
 
 // 2. New Frontier < 20km
 const simNewLess20 = calculateSimulation({ ...inputs, annualIncomeCHF: income, frontierWorkerType: 'NEW', distanceZone: 'WITHIN_20KM' });
 
 // 3. New Frontier > 20km
 const simNewMore20 = calculateSimulation({ ...inputs, annualIncomeCHF: income, frontierWorkerType: 'NEW', distanceZone: 'OVER_20KM' });

 // 4. Old Frontier (Reference)
 const simOld = calculateSimulation({ ...inputs, annualIncomeCHF: income, frontierWorkerType: 'OLD' });

 // Calculate Taxes (Total Deductions: Social + Tax + Health for CH; Social + Tax for IT)
 // Note:"Tasse" in this context usually means the burden.
 // For CH: Tax + Social + Health
 // For IT: Tax (CH+IT) + Social (CH)
 const getBurden = (res: TaxResult) => res.grossIncome + res.familyAllowance - res.netIncomeAnnual - res.customExpensesTotal; // Pure fiscal/social burden

 if (analysisMode === 'NET') {
 data.push({
 ral: `CHF ${(income/1000).toFixed(0)}k`,
 originalIncome: income,
 [t('chart.resident_ch')]: Math.round(simCH.chResident.netIncomeAnnual),
 [t('chart.new_less_20km')]: Math.round(simNewLess20.itResident.netIncomeAnnual),
 [t('chart.new_more_20km')]: Math.round(simNewMore20.itResident.netIncomeAnnual),
 [t('chart.old_frontier')]: Math.round(simOld.itResident.netIncomeAnnual),
 });
 } else {
 data.push({
 ral: `CHF ${(income/1000).toFixed(0)}k`,
 originalIncome: income,
 [t('chart.resident_ch')]: Math.round(getBurden(simCH.chResident)),
 [t('chart.new_less_20km')]: Math.round(getBurden(simNewLess20.itResident)),
 [t('chart.new_more_20km')]: Math.round(getBurden(simNewMore20.itResident)),
 [t('chart.old_frontier')]: Math.round(getBurden(simOld.itResident)),
 });
 }
 }
 return data;
 } catch {
 return [];
 }
 }, [inputs, analysisMode]);

 // KPI Calculations
 const effectiveTaxRateCH = ((chResident.taxes / chResident.grossIncome) * 100).toFixed(1);
 const effectiveTaxRateIT = ((itResident.taxes / itResident.grossIncome) * 100).toFixed(1);
 const diffPercent = ((Math.abs(savingsCHF) / Math.min(chResident.netIncomeAnnual, itResident.netIncomeAnnual)) * 100).toFixed(1);

 return (
 <div className="space-y-6">
 
 {/* KPI Section */}
 <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
 <KpiCard 
 title={t('chart.effective_rate_ch')} 
 value={`${effectiveTaxRateCH}%`} 
 subtext={t('chart.tax_incidence')}
 icon={Percent} 
 colorClass="text-link"
 />
 <KpiCard 
 title={t('chart.effective_rate_it')} 
 value={`${effectiveTaxRateIT}%`} 
 subtext={t('chart.tax_incidence')}
 icon={Percent} 
 colorClass="text-danger"
 />
 <KpiCard 
 title={t('chart.net_difference')} 
 value={`${diffPercent}%`} 
 subtext={t('chart.purchasing_power_delta')}
 icon={ArrowUpRight} 
 colorClass="text-success"
 />
 <KpiCard 
 title={t('chart.accumulation_5y')} 
 value={`${(Math.abs(savingsCHF) * 5 / 1000).toFixed(1)}k`} 
 subtext={t('chart.potential_savings')}
 icon={Wallet} 
 colorClass="text-accent"
 />
 </div>

 {/* Main Chart Container */}
 <div className="bg-surface rounded-3xl p-1 shadow-sm border border-edge">
 <SegmentControl
 options={[
 { key: 'overview', label: t('chart.tab_comparison'), icon: BarChart3 },
 { key: 'breakdown', label: t('chart.tab_details'), icon: PieIcon },
 { key: 'projection', label: t('chart.tab_projection'), icon: TrendingUp },
 { key: 'breakeven', label: t('chart.tab_salary_analysis'), icon: LineIcon },
 ]}
 value={activeTab}
 onChange={(key) => handleTabChange(key as any)}
 activeTextClass="text-section-calculator"
 />

 {/* Chart Area */}
 <div className="p-4 sm:p-6 min-h-[320px] bg-surface rounded-b-3xl relative">
 {activeTab === 'projection' && (
 <div className="mb-6 bg-accent-subtle/50 p-4 rounded-xl border border-accent-border/50 flex gap-3 animate-fade-in">
 <Info size={18} className="text-stripe-500 shrink-0 mt-0.5" />
 <div className="text-xs text-accent leading-relaxed">
 <strong className="block mb-1 font-bold">{t('chart.projection_title')}</strong>
 {t('chart.projection_description')}
 </div>
 </div>
 )}
 
 {activeTab === 'breakeven' && (
 <div className="mb-4 animate-fade-in">
 <div className="flex justify-between items-center mb-4">
 <h3 className="text-sm font-bold text-body">
 {analysisMode === 'NET' ? t('chart.net_income_comparison') : t('chart.tax_burden_comparison')}
 </h3>
 
 {/* Toggle for Net/Tax Analysis */}
 <div className="flex bg-surface-raised p-1 rounded-lg">
 <button 
 onClick={() => setAnalysisMode('NET')}
 className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase transition-[color,background-color,border-color,box-shadow] ${analysisMode === 'NET' ? 'bg-surface text-emerald-700 shadow-sm' : 'text-muted hover:text-slate-600'}`}
 >
 {t('chart.net')}
 </button>
 <button 
 onClick={() => setAnalysisMode('TAX')}
 className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase transition-[color,background-color,border-color,box-shadow] ${analysisMode === 'TAX' ? 'bg-surface text-red-500 shadow-sm' : 'text-muted hover:text-slate-600'}`}
 >
 {t('chart.taxes_charges')}
 </button>
 </div>
 </div>
 <div className="bg-surface-alt/50 p-3 rounded-xl border border-edge text-xs text-muted mb-4">
 {t('chart.salary_simulation_desc')}
 {analysisMode === 'NET' ? ` ${t('chart.shows_net_residual')}` : ` ${t('chart.shows_total_taxes')}`}
 </div>
 </div>
 )}

 {activeTab === 'breakdown' ? (
 <div className="w-full flex flex-col md:flex-row gap-4" style={{ height: 320 }}>
 <div className="flex-1 flex flex-col items-center relative">
 <h4 className="text-xs font-bold uppercase text-muted mb-2">{t('chart.resident_ch')}</h4>
 <div className="w-full h-full relative">
 <ResponsiveContainer>
 <PieChart>
 <Pie data={pieDataCH} cx="50%" cy="50%" innerRadius={50} outerRadius={70} paddingAngle={2} dataKey="value">
 {pieDataCH.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} strokeWidth={0} />)}
 </Pie>
 <Tooltip content={<CustomTooltip isDarkMode={isDarkMode} />} />
 <Legend content={<FixedLegend isDarkMode={isDarkMode} />} />
 </PieChart>
 </ResponsiveContainer>
 <div className="absolute inset-0 flex items-center justify-center pointer-events-none mb-8">
 <span className="text-xs font-bold text-muted">CH</span>
 </div>
 </div>
 </div>
 <div className="flex-1 flex flex-col items-center relative border-t md:border-t-0 md:border-l border-dashed border-edge pt-4 md:pt-0">
 <h4 className="text-xs font-bold uppercase text-muted mb-2">{t('chart.frontier_worker')}</h4>
 <div className="w-full h-full relative">
 <ResponsiveContainer>
 <PieChart>
 <Pie data={pieDataIT} cx="50%" cy="50%" innerRadius={50} outerRadius={70} paddingAngle={2} dataKey="value">
 {pieDataIT.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} strokeWidth={0} />)}
 </Pie>
 <Tooltip content={<CustomTooltip isDarkMode={isDarkMode} />} />
 <Legend content={<FixedLegend isDarkMode={isDarkMode} />} />
 </PieChart>
 </ResponsiveContainer>
 <div className="absolute inset-0 flex items-center justify-center pointer-events-none mb-8">
 <span className="text-xs font-bold text-muted">IT</span>
 </div>
 </div>
 </div>
 </div>
 ) : (
 <ResponsiveContainer width="100%" height={320}>
 {activeTab === 'overview' ? (
 <AreaChart data={projectionData} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
 <defs>
 <linearGradient id="colorSavings" x1="0" y1="0" x2="0" y2="1">
 <stop offset="5%" stopColor={CHART_COLORS.savings} stopOpacity={0.3}/>
 <stop offset="95%" stopColor={CHART_COLORS.savings} stopOpacity={0}/>
 </linearGradient>
 </defs>
 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? CHART_COLORS.gridDark : CHART_COLORS.gridLight} />
 <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{fill: isDarkMode ? CHART_COLORS.tickDark : CHART_COLORS.tickLight, fontSize: 12, fontWeight: 700}} />
 <YAxis hide />
 <Tooltip content={<CustomTooltip isDarkMode={isDarkMode} />} />
 <Area
 type="monotone"
 dataKey={t('chart.accumulated_difference')}
 stroke={CHART_COLORS.savings}
 strokeWidth={3} 
 fillOpacity={1} 
 fill="url(#colorSavings)" 
 activeDot={{ r: 6, strokeWidth: 0 }}
 />
 <Legend content={<FixedLegend isDarkMode={isDarkMode} />} />
 </AreaChart>
 ) : (
 // ADVANCED BREAK-EVEN CHART (Multi-Line)
 <LineChart data={breakEvenData} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? CHART_COLORS.gridDark : CHART_COLORS.gridLight} />
 <XAxis dataKey="ral" axisLine={false} tickLine={false} tick={{fill: isDarkMode ? CHART_COLORS.tickDark : CHART_COLORS.tickLight, fontSize: 10, fontWeight: 700}} />
 <YAxis hide domain={['auto', 'auto']} />
 <Tooltip content={<CustomTooltip isDarkMode={isDarkMode} />} />

 <Line type="monotone" dataKey={t('chart.resident_ch')} stroke={CHART_COLORS.residentCH} strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
 <Line type="monotone" dataKey={t('chart.new_less_20km')} stroke={CHART_COLORS.newLess20km} strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
 <Line type="monotone" dataKey={t('chart.new_more_20km')} stroke={CHART_COLORS.newMore20km} strokeWidth={3} strokeDasharray="5 5" dot={false} activeDot={{ r: 6 }} />
 <Line type="monotone" dataKey={t('chart.old_frontier')} stroke={CHART_COLORS.oldFrontier} strokeWidth={2} strokeDasharray="3 3" dot={false} activeDot={{ r: 4 }} opacity={0.6} />
 
 <Legend content={<FixedLegend isDarkMode={isDarkMode} />} />
 </LineChart>
 )}
 </ResponsiveContainer>
 )}
 </div>
 </div>
 </div>
 );
};

export const ComparisonChart = React.memo(ComparisonChartBase);