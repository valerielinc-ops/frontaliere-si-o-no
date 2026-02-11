import React, { useState } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, 
  PieChart, Pie, AreaChart, Area, Legend 
} from 'recharts';
import { SimulationResult, TaxResult } from '../types';
import { BarChart3, PieChart as PieIcon, TrendingUp, Wallet, Percent, ArrowUpRight, Info } from 'lucide-react';

interface Props {
  result: SimulationResult;
  isDarkMode?: boolean;
  isFocusMode?: boolean;
}

// Custom Tooltip for Charts
const CustomTooltip = ({ active, payload, label, isDarkMode, currency = "CHF" }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className={`p-4 border rounded-2xl shadow-xl min-w-[180px] z-50 pointer-events-none backdrop-blur-md ${isDarkMode ? 'bg-slate-900/95 border-slate-700 shadow-slate-950/50' : 'bg-white/95 border-slate-100 shadow-slate-200/50'}`}>
        {label && <p className={`font-bold mb-3 text-xs uppercase tracking-wider border-b pb-2 ${isDarkMode ? 'text-slate-400 border-slate-700' : 'text-slate-500 border-slate-100'}`}>{label}</p>}
        <div className="space-y-2">
          {payload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-2">
                 <div className="w-2.5 h-2.5 rounded-full shadow-sm" style={{ backgroundColor: entry.color || entry.fill }} />
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
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color || entry.fill }} />
          <span className={`text-[10px] font-bold uppercase tracking-wide ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
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
       <p className="text-[10px] font-bold uppercase text-slate-400 tracking-wider mb-1">{title}</p>
       <p className={`text-xl font-mono font-bold ${colorClass}`}>{value}</p>
       {subtext && <p className="text-[10px] text-slate-500 mt-1">{subtext}</p>}
     </div>
     <div className={`p-2 rounded-xl bg-white dark:bg-slate-800 shadow-sm ${colorClass.replace('text-', 'text-opacity-80 text-')}`}>
       <Icon size={18} />
     </div>
  </div>
);

export const ComparisonChart: React.FC<Props> = ({ result, isDarkMode, isFocusMode }) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'breakdown' | 'projection'>('overview');

  const { chResident, itResident, savingsCHF } = result;
  
  // Data for Bar Chart (Overview)
  const barData = [
    { name: 'Svizzera', Netto: chResident.netIncomeAnnual, Tasse: chResident.taxes, Sociali: chResident.socialContributions + chResident.healthInsurance },
    { name: 'Frontaliere', Netto: itResident.netIncomeAnnual, Tasse: itResident.taxes, Sociali: itResident.socialContributions },
  ];

  // --- Data for Detailed Composition Chart ---
  const getDetailedPieData = (res: TaxResult) => {
      // Extract from breakdown array but skip totals/net
      // Breakdown items are: Income, Allowance, Social, Pension, Tax, Health, Expenses, Net
      return res.breakdown
        .filter(item => !item.label.includes('Reddito Lordo') && !item.label.includes('Assegni') && !item.label.includes('Reddito Netto'))
        .map(item => {
           let color = '#cbd5e1'; // Default
           const l = item.label.toLowerCase();
           if(l.includes('sociali') || l.includes('avs')) color = '#8b5cf6'; // Violet
           if(l.includes('pensione') || l.includes('lpp')) color = '#a78bfa'; // Lighter Violet
           if(l.includes('imposte') || l.includes('fonte') || l.includes('irpef')) color = '#64748b'; // Slate
           if(l.includes('malati') || l.includes('salute')) color = '#f43f5e'; // Rose
           if(l.includes('spese')) color = '#f59e0b'; // Amber
           
           return {
               name: item.label,
               value: Math.abs(item.amount), // Pie chart needs positive
               color: color
           };
        })
        .concat([{ name: 'Netto Residuo', value: res.netIncomeAnnual, color: '#10b981' }]); // Emerald
  };

  const pieDataCH = getDetailedPieData(chResident);
  const pieDataIT = getDetailedPieData(itResident);

  // Data for Projection (Area Chart)
  const projectionYears = 5;
  const projectionData = Array.from({ length: projectionYears + 1 }, (_, i) => {
    return {
      year: `Anno ${i}`,
      'Accumulo Differenza': Math.abs(savingsCHF) * i,
      beneficiary: savingsCHF > 0 ? 'Frontaliere' : 'Residente'
    };
  });

  // KPI Calculations
  const effectiveTaxRateCH = ((chResident.taxes / chResident.grossIncome) * 100).toFixed(1);
  const effectiveTaxRateIT = ((itResident.taxes / itResident.grossIncome) * 100).toFixed(1);
  const diffPercent = ((Math.abs(savingsCHF) / Math.min(chResident.netIncomeAnnual, itResident.netIncomeAnnual)) * 100).toFixed(1);

  return (
    <div className="space-y-6">
      
      {/* KPI Section */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
         <KpiCard 
            title="Aliquota Reale CH" 
            value={`${effectiveTaxRateCH}%`} 
            subtext="Incidenza imposte"
            icon={Percent} 
            colorClass="text-blue-600 dark:text-blue-400"
         />
         <KpiCard 
            title="Aliquota Reale IT" 
            value={`${effectiveTaxRateIT}%`} 
            subtext="Incidenza imposte"
            icon={Percent} 
            colorClass="text-red-600 dark:text-red-400"
         />
         <KpiCard 
            title="Differenza Netta" 
            value={`${diffPercent}%`} 
            subtext="Delta potere d'acquisto"
            icon={ArrowUpRight} 
            colorClass="text-emerald-600 dark:text-emerald-400"
         />
         <KpiCard 
            title="Accumulo 5 Anni" 
            value={`${(Math.abs(savingsCHF) * 5 / 1000).toFixed(1)}k`} 
            subtext="Potenziale risparmio"
            icon={Wallet} 
            colorClass="text-indigo-600 dark:text-indigo-400"
         />
      </div>

      {/* Main Chart Container */}
      <div className="bg-white dark:bg-slate-800 rounded-3xl p-1 shadow-sm border border-slate-100 dark:border-slate-700">
         {/* MOBILE IMPROVEMENT: Changed from flex + overflow-x-auto to grid grid-cols-3 for better touch targets and no scrolling needed */}
         <div className="grid grid-cols-3 gap-1 p-1 bg-slate-50 dark:bg-slate-900/50 rounded-2xl">
            {[
              { id: 'overview', label: 'Confronto', icon: BarChart3 },
              { id: 'breakdown', label: 'Composizione', icon: PieIcon },
              { id: 'projection', label: 'Proiezione', icon: TrendingUp },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex flex-col sm:flex-row items-center justify-center gap-1.5 py-3 px-2 rounded-xl text-[10px] sm:text-xs font-bold uppercase tracking-wide transition-all ${
                  activeTab === tab.id 
                  ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm scale-[0.98]' 
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                }`}
              >
                <tab.icon size={16} className={activeTab === tab.id ? 'stroke-[2.5px]' : ''} />
                <span className="truncate">{tab.label}</span>
              </button>
            ))}
         </div>

         {/* Chart Area */}
         <div className="p-4 sm:p-6 min-h-[320px] bg-white dark:bg-slate-800 rounded-b-3xl">
            {activeTab === 'projection' && (
                <div className="mb-6 bg-indigo-50/50 dark:bg-indigo-900/20 p-4 rounded-xl border border-indigo-100 dark:border-indigo-800/50 flex gap-3 animate-fade-in">
                    <Info size={18} className="text-indigo-500 shrink-0 mt-0.5" />
                    <div className="text-xs text-indigo-900 dark:text-indigo-300 leading-relaxed">
                        <strong className="block mb-1 font-bold">Come viene calcolata la proiezione?</strong>
                        Questo grafico mostra il risparmio cumulativo (la differenza netta tra le due opzioni) accumulato anno per anno.
                        Il calcolo è puramente matematico (Cash Flow) e non include l'inflazione, gli aumenti salariali o il rendimento di eventuali investimenti finanziari del capitale risparmiato.
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
                     <Bar dataKey="Sociali" stackId="a" fill="#8b5cf6" radius={[0,0,4,4]} />
                     <Bar dataKey="Tasse" stackId="a" fill="#64748b" />
                     <Bar dataKey="Netto" stackId="a" fill="#10b981" radius={[4,4,0,0]} />
                  </BarChart>
               ) : activeTab === 'breakdown' ? (
                  <div className="w-full h-full flex flex-col md:flex-row gap-4">
                      <div className="flex-1 flex flex-col items-center relative">
                          <h4 className="text-xs font-bold uppercase text-slate-400 mb-2">Residente CH</h4>
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
                               <span className="text-xs font-bold text-slate-400">CH</span>
                            </div>
                          </div>
                      </div>
                      <div className="flex-1 flex flex-col items-center relative border-t md:border-t-0 md:border-l border-dashed border-slate-100 dark:border-slate-700 pt-4 md:pt-0">
                          <h4 className="text-xs font-bold uppercase text-slate-400 mb-2">Frontaliere</h4>
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
                                 <span className="text-xs font-bold text-slate-400">IT</span>
                              </div>
                           </div>
                      </div>
                  </div>
               ) : (
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
                        dataKey="Accumulo Differenza" 
                        stroke="#10b981" 
                        strokeWidth={3} 
                        fillOpacity={1} 
                        fill="url(#colorSavings)" 
                        activeDot={{ r: 6, strokeWidth: 0 }}
                     />
                     <Legend content={<FixedLegend isDarkMode={isDarkMode} />} />
                  </AreaChart>
               )}
            </ResponsiveContainer>
         </div>
      </div>
    </div>
  );
};