import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend } from 'recharts';
import { SimulationResult } from '../types';

interface Props {
  result: SimulationResult;
  isDarkMode?: boolean;
}

const CustomTooltip = ({ active, payload, label, isDarkMode }: any) => {
  if (active && payload && payload.length) {
    // Show items in reverse order (Top of stack first - usually Net Income)
    const reversedPayload = [...payload].reverse();
    const total = reversedPayload.reduce((acc: number, curr: any) => acc + (curr.value || 0), 0);

    return (
      <div className={`p-4 border rounded-2xl shadow-xl min-w-[200px] z-50 pointer-events-none ${isDarkMode ? 'bg-slate-800/95 border-slate-700 shadow-slate-900/50' : 'bg-white/95 border-slate-100 shadow-slate-200/50'}`}>
        <p className={`font-bold mb-3 text-sm border-b pb-2 ${isDarkMode ? 'text-slate-200 border-slate-700' : 'text-slate-800 border-slate-100'}`}>{label}</p>
        <div className="space-y-2.5">
          {reversedPayload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-2">
                 <div 
                    className="w-3 h-3 rounded-full shadow-sm" 
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className={`font-bold uppercase tracking-wider text-[10px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {entry.name}
                  </span>
              </div>
              <span className={`font-mono font-bold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                CHF {entry.value.toLocaleString('it-IT', {maximumFractionDigits: 0})}
              </span>
            </div>
          ))}
          <div className={`pt-2 mt-2 border-t flex justify-between items-center ${isDarkMode ? 'border-slate-700' : 'border-slate-100'}`}>
             <span className={`font-bold text-[10px] uppercase ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>Totale Lordo</span>
             <span className={`font-mono font-bold text-sm ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>
                CHF {total.toLocaleString('it-IT', {maximumFractionDigits: 0})}
             </span>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

export const ComparisonChart: React.FC<Props> = ({ result, isDarkMode }) => {
  const [viewType, setViewType] = useState<'compact' | 'detail'>('compact');

  const chNet = result.chResident.netIncomeAnnual;
  const chTax = result.chResident.taxes;
  const chSocial = result.chResident.socialContributions;
  const chHealth = result.chResident.healthInsurance;

  const itNet = result.itResident.netIncomeAnnual; // Already normalized to CHF
  const itTax = result.itResident.taxes; // Already normalized to CHF
  const itSocial = result.itResident.socialContributions; // Already CHF

  // Chart Data Preparation
  const data = [
    {
      name: 'Svizzera',
      net: chNet,
      tax: chTax,
      social: viewType === 'detail' ? chSocial : (chSocial + chHealth),
      health: viewType === 'detail' ? chHealth : 0,
    },
    {
      name: 'Frontaliere',
      net: itNet,
      tax: itTax,
      social: itSocial,
      health: 0, 
    },
  ];

  return (
    <div className="w-full">
      <div className="flex justify-end mb-4">
         <div className="bg-slate-100 dark:bg-slate-800 p-1 rounded-xl flex gap-1">
            <button 
               onClick={() => setViewType('compact')}
               className={`px-3 py-1.5 text-[10px] font-bold uppercase rounded-lg transition-all ${viewType === 'compact' ? 'bg-white dark:bg-slate-700 shadow-sm text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}`}
            >
               Compatti
            </button>
            <button 
               onClick={() => setViewType('detail')}
               className={`px-3 py-1.5 text-[10px] font-bold uppercase rounded-lg transition-all ${viewType === 'detail' ? 'bg-white dark:bg-slate-700 shadow-sm text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}`}
            >
               Dettagliati
            </button>
         </div>
      </div>

      <div className="h-80 w-full bg-white dark:bg-slate-800 rounded-xl transition-colors duration-300">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
            barSize={60}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? "#334155" : "#f1f5f9"} />
            <XAxis 
              dataKey="name" 
              axisLine={false} 
              tickLine={false} 
              tick={{fill: isDarkMode ? '#94a3b8' : '#64748b', fontWeight: 700, fontSize: 12}} 
              dy={10}
            />
            <YAxis hide domain={[0, 'auto']} />
            <Tooltip 
              content={<CustomTooltip isDarkMode={isDarkMode} />} 
              cursor={{fill: isDarkMode ? '#1e293b' : '#f8fafc'}} 
            />
            <Legend 
              verticalAlign="bottom" 
              height={36} 
              iconType="circle"
              wrapperStyle={{ 
                paddingTop: '20px', 
                fontSize: '11px', 
                fontWeight: 600, 
                color: isDarkMode ? '#94a3b8' : '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.025em'
              }} 
            />
            
            {viewType === 'detail' ? (
              <>
                 <Bar dataKey="social" name="Sociali (AVS/LPP)" stackId="a" fill="#8b5cf6" radius={[0,0,4,4]} />
                 <Bar dataKey="health" name="Cassa Malati" stackId="a" fill="#f59e0b" />
                 <Bar dataKey="tax" name="Imposte" stackId="a" fill="#64748b" />
              </>
            ) : (
                 <>
                  <Bar dataKey="social" name="Deduzioni Totali" stackId="a" fill="#8b5cf6" radius={[0,0,4,4]} />
                  <Bar dataKey="tax" name="Imposte" stackId="a" fill="#64748b" />
                 </>
            )}
            
            <Bar dataKey="net" name="Reddito Netto" stackId="a" radius={[4, 4, 0, 0]}>
              {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={index === 0 ? '#3b82f6' : '#ef4444'} />
                ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};