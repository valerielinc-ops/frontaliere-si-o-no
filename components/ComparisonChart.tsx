import React, { useState, useMemo } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, 
  PieChart, Pie, AreaChart, Area, Legend, LineChart, Line
} from 'recharts';
import { SimulationResult, TaxResult, SimulationInputs } from '../types';
import { BarChart3, PieChart as PieIcon, TrendingUp, Wallet, Percent, ArrowUpRight, Info, LineChart as LineIcon, Layers } from 'lucide-react';
import { calculateSimulation } from '../services/calculationService';
import { Analytics } from '../services/analytics';
import { useTranslation } from '../services/i18n';

interface Props {
  result: SimulationResult;
  inputs: SimulationInputs;
  isDarkMode?: boolean;
  isFocusMode?: boolean;
}

// Custom Tooltip for Charts
const CustomTooltip = ({ active, payload, label, isDarkMode, currency = "CHF" }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className={`p-4 border rounded-2xl shadow-xl min-w-[180px] z-50 pointer-events-none backdrop-blur-md ${isDarkMode ? 'bg-slate-900/95 border-slate-700 shadow-slate-950/50' : 'bg-white/95 border-slate-100 shadow-slate-200/50'}`}>
        {label && <p className={`font-bold mb-3 text-xs uppercase tracking-wider border-b pb-2 ${isDarkMode ? 'text-slate-500 border-slate-700' : 'text-slate-500 border-slate-100'}`}>{label}</p>}
        <div className="space-y-2">
          {payload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-2">
                 <div className="w-2.5 h-2.5 rounded-full shadow-sm" style={{ backgroundColor: entry.color || entry.fill || entry.stroke }} />
                 <span className={`font-bold ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>{entry.name}</span>
              </div>
              <span className={`font-mono font-bold ${isDarkMode ? 'text-slate-100' : 'text-slate-800'}`}>
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
          <span className={`text-[10px] font-bold uppercase tracking-wide ${isDarkMode ? 'text-slate-500' : 'text-slate-600'}`}>
            {entry.value}
          </span>
        </div>
      ))}
    </div>
  );
};

// KPI Card Component
const KpiCard = ({ title, value, subtext, icon: Icon, colorClass }: any) => (
  <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-4 border border-slate-100 dark:border-slate-700 flex items-start justify-between group hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
     <div>
       <p className="text-[10px] font-bold uppercase text-slate-500 tracking-wider mb-1">{title}</p>
       <p className={`text-xl font-mono font-bold ${colorClass}`}>{value}</p>
       {subtext && <p className="text-[10px] text-slate-500 mt-1">{subtext}</p>}
     </div>
     <div className={`p-2 rounded-xl bg-white dark:bg-slate-800 shadow-sm ${colorClass.replace('text-', 'text-opacity-80 text-')}`}>
       <Icon size={18} />
     </div>
  </div>
);

export const ComparisonChart: React.FC<Props> = ({ result, inputs, isDarkMode, isFocusMode }) => {
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
           let color = '#cbd5e1'; 
           const l = item.label.toLowerCase();
           if(l.includes('social') || l.includes('avs')) color = '#8b5cf6'; 
           if(l.includes('pension') || l.includes('lpp')) color = '#a78bfa'; 
           if(l.includes('tax') || l.includes('source') || l.includes('irpef')) color = '#64748b'; 
           if(l.includes('health') || l.includes('ssn')) color = '#f43f5e'; 
           if(l.includes('expense')) color = '#f59e0b'; 
           
           return {
               name: t(item.label.split('|')[0]),
               value: Math.abs(item.amount), 
               color: color
           };
        })
        .concat([{ name: t('chart.net_residual'), value: res.netIncomeAnnual, color: '#10b981' }]);
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
      // Note: "Tasse" in this context usually means the burden.
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
            colorClass="text-blue-600 dark:text-blue-400"
         />
         <KpiCard 
            title={t('chart.effective_rate_it')} 
            value={`${effectiveTaxRateIT}%`} 
            subtext={t('chart.tax_incidence')}
            icon={Percent} 
            colorClass="text-red-600 dark:text-red-400"
         />
         <KpiCard 
            title={t('chart.net_difference')} 
            value={`${diffPercent}%`} 
            subtext={t('chart.purchasing_power_delta')}
            icon={ArrowUpRight} 
            colorClass="text-emerald-600 dark:text-emerald-400"
         />
         <KpiCard 
            title={t('chart.accumulation_5y')} 
            value={`${(Math.abs(savingsCHF) * 5 / 1000).toFixed(1)}k`} 
            subtext={t('chart.potential_savings')}
            icon={Wallet} 
            colorClass="text-indigo-600 dark:text-indigo-400"
         />
      </div>

      {/* Main Chart Container */}
      <div className="bg-white dark:bg-slate-800 rounded-3xl p-1 shadow-sm border border-slate-100 dark:border-slate-700">
         <div className="grid grid-cols-4 gap-1 p-1 bg-slate-50 dark:bg-slate-900/50 rounded-2xl">
            {[
              { id: 'overview', label: t('chart.tab_comparison'), icon: BarChart3 },
              { id: 'breakdown', label: t('chart.tab_details'), icon: PieIcon },
              { id: 'projection', label: t('chart.tab_projection'), icon: TrendingUp },
              { id: 'breakeven', label: t('chart.tab_salary_analysis'), icon: LineIcon },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id as any)}
                className={`flex flex-col sm:flex-row items-center justify-center gap-1.5 py-3 px-1 rounded-xl text-[9px] sm:text-xs font-bold uppercase tracking-wide transition-all ${
                  activeTab === tab.id 
                  ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm scale-[0.98]' 
                  : 'text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
                }`}
              >
                <tab.icon size={16} className={activeTab === tab.id ? 'stroke-[2.5px]' : ''} />
                <span className="truncate">{tab.label}</span>
              </button>
            ))}
         </div>

         {/* Chart Area */}
         <div className="p-4 sm:p-6 min-h-[320px] bg-white dark:bg-slate-800 rounded-b-3xl relative">
            {activeTab === 'projection' && (
                <div className="mb-6 bg-indigo-50/50 dark:bg-indigo-900/20 p-4 rounded-xl border border-indigo-100 dark:border-indigo-800/50 flex gap-3 animate-fade-in">
                    <Info size={18} className="text-indigo-500 shrink-0 mt-0.5" />
                    <div className="text-xs text-indigo-900 dark:text-indigo-300 leading-relaxed">
                        <strong className="block mb-1 font-bold">{t('chart.projection_title')}</strong>
                        {t('chart.projection_description')}
                    </div>
                </div>
            )}
            
            {activeTab === 'breakeven' && (
                <div className="mb-4 animate-fade-in">
                    <div className="flex justify-between items-center mb-4">
                       <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">
                          {analysisMode === 'NET' ? t('chart.net_income_comparison') : t('chart.tax_burden_comparison')}
                       </h3>
                       
                       {/* Toggle for Net/Tax Analysis */}
                       <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-lg">
                          <button 
                            onClick={() => setAnalysisMode('NET')}
                            className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase transition-all ${analysisMode === 'NET' ? 'bg-white dark:bg-slate-700 text-emerald-600 shadow-sm' : 'text-slate-500 hover:text-slate-600'}`}
                          >
                            {t('chart.net')}
                          </button>
                          <button 
                            onClick={() => setAnalysisMode('TAX')}
                            className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase transition-all ${analysisMode === 'TAX' ? 'bg-white dark:bg-slate-700 text-red-500 shadow-sm' : 'text-slate-500 hover:text-slate-600'}`}
                          >
                            {t('chart.taxes_charges')}
                          </button>
                       </div>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-900/50 p-3 rounded-xl border border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-500 mb-4">
                       {t('chart.salary_simulation_desc')}
                       {analysisMode === 'NET' ? ` ${t('chart.shows_net_residual')}` : ` ${t('chart.shows_total_taxes')}`}
                    </div>
                </div>
            )}

            <ResponsiveContainer width="100%" height={320}>
               {activeTab === 'overview' ? (
                  <BarChart data={barData} barGap={0} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? "#334155" : "#f1f5f9"} />
                     <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 12, fontWeight: 700}} dy={10} />
                     <YAxis hide />
                     <Tooltip content={<CustomTooltip isDarkMode={isDarkMode} />} cursor={{fill: isDarkMode ? '#1e293b' : '#f8fafc'}} />
                     <Legend content={<FixedLegend isDarkMode={isDarkMode} />} />
                     <Bar dataKey={socialLabel} stackId="a" fill="#8b5cf6" radius={[0,0,4,4]} />
                     <Bar dataKey={taxLabel} stackId="a" fill="#64748b" />
                     <Bar dataKey={netLabel} stackId="a" fill="#10b981" radius={[4,4,0,0]} />
                  </BarChart>
               ) : activeTab === 'breakdown' ? (
                  <div className="w-full h-full flex flex-col md:flex-row gap-4">
                      <div className="flex-1 flex flex-col items-center relative">
                          <h4 className="text-xs font-bold uppercase text-slate-500 mb-2">{t('chart.resident_ch')}</h4>
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
                               <span className="text-xs font-bold text-slate-500">CH</span>
                            </div>
                          </div>
                      </div>
                      <div className="flex-1 flex flex-col items-center relative border-t md:border-t-0 md:border-l border-dashed border-slate-100 dark:border-slate-700 pt-4 md:pt-0">
                          <h4 className="text-xs font-bold uppercase text-slate-500 mb-2">{t('chart.frontier_worker')}</h4>
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
                                 <span className="text-xs font-bold text-slate-500">IT</span>
                              </div>
                           </div>
                      </div>
                  </div>
               ) : activeTab === 'projection' ? (
                  <AreaChart data={projectionData} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
                     <defs>
                        <linearGradient id="colorSavings" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                        </linearGradient>
                     </defs>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? "#334155" : "#f1f5f9"} />
                     <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{fill: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 12, fontWeight: 700}} />
                     <YAxis hide />
                     <Tooltip content={<CustomTooltip isDarkMode={isDarkMode} />} />
                     <Area 
                        type="monotone" 
                        dataKey={t('chart.accumulated_difference')} 
                        stroke="#10b981" 
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
                     <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? "#334155" : "#f1f5f9"} />
                     <XAxis dataKey="ral" axisLine={false} tickLine={false} tick={{fill: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 10, fontWeight: 700}} />
                     <YAxis hide domain={['auto', 'auto']} />
                     <Tooltip content={<CustomTooltip isDarkMode={isDarkMode} />} />
                     
                     <Line type="monotone" dataKey={t('chart.resident_ch')} stroke="#3b82f6" strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
                     <Line type="monotone" dataKey={t('chart.new_less_20km')} stroke="#6366f1" strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
                     <Line type="monotone" dataKey={t('chart.new_more_20km')} stroke="#f97316" strokeWidth={3} strokeDasharray="5 5" dot={false} activeDot={{ r: 6 }} />
                     <Line type="monotone" dataKey={t('chart.old_frontier')} stroke="#10b981" strokeWidth={2} strokeDasharray="3 3" dot={false} activeDot={{ r: 4 }} opacity={0.6} />
                     
                     <Legend content={<FixedLegend isDarkMode={isDarkMode} />} />
                  </LineChart>
               )}
            </ResponsiveContainer>
         </div>
      </div>
    </div>
  );
};