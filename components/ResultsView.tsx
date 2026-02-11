import React from 'react';
import { ScrollText, Check, ArrowLeftRight, Trophy, Armchair, Info, PartyPopper, Tag } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { SimulationResult, TaxResult, TaxBreakdownItem } from '../types';
import { ComparisonChart } from './ComparisonChart';

interface Props {
  result: SimulationResult;
  isDarkMode?: boolean;
}

const formatCurrency = (value: number) => {
  return Math.abs(Math.round(value)).toLocaleString('it-IT');
};

const CurrencyValue: React.FC<{ value: number; currency: string; className?: string; smallCurrency?: boolean }> = ({ value, currency, className = "", smallCurrency }) => (
  <span className={`font-mono font-bold tracking-tight whitespace-nowrap ${className}`}>
    {!smallCurrency && (currency === 'EUR' ? '€ ' : 'CHF ')}
    {formatCurrency(value)}
    {smallCurrency && <span className="text-[0.7em] ml-1 font-sans font-normal text-slate-500 dark:text-slate-400">{currency}</span>}
  </span>
);

const getBreakdownColor = (label: string): string => {
  const l = label.toLowerCase();
  if (l.includes('sociali') || l.includes('pensione') || l.includes('contributi')) return 'bg-violet-500'; // Matches Chart Social
  if (l.includes('malati')) return 'bg-amber-500'; // Matches Chart Health
  if (l.includes('imposte') || l.includes('fonte') || l.includes('irpef')) return 'bg-slate-500'; // Matches Chart Tax
  if (l.includes('reddito') || l.includes('netto')) return 'bg-emerald-500'; 
  return 'bg-slate-200 dark:bg-slate-700';
};

const BreakdownTable: React.FC<{ data: TaxBreakdownItem[]; currency: string; showEUR?: boolean }> = ({ data, currency, showEUR }) => (
  <div className="w-full text-sm">
    {data.map((item, idx) => {
      const isTotal = idx === 0;
      const isNegative = item.amount < 0;
      const dotColor = getBreakdownColor(item.label);
      
      return (
        <div key={idx} className={`flex items-center justify-between py-2.5 border-b border-dashed border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50/80 dark:hover:bg-slate-800/80 px-3 rounded-lg transition-colors group cursor-default`}>
          <div className="flex-1 pr-2 flex items-center gap-2">
            {!isTotal && <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}></div>}
            <div>
              <div className={`font-medium transition-colors ${isTotal ? 'text-slate-900 dark:text-slate-100 text-base' : 'text-slate-600 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-slate-200'}`}>
                {item.label}
              </div>
              {item.description && <div className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-wide group-hover:text-slate-500 dark:group-hover:text-slate-400">{item.description}</div>}
            </div>
          </div>
          
          <div className="text-right flex items-center gap-3">
             {item.percentage !== 0 && (
                <div className="w-12 text-[10px] font-bold text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 group-hover:bg-slate-200/70 dark:group-hover:bg-slate-700/70 rounded px-1 py-0.5 text-center flex-shrink-0 transition-colors">
                  {Math.abs(item.percentage).toFixed(1)}%
                </div>
             )}
             <div className="flex flex-col items-end">
                <div className={`text-right font-mono font-bold whitespace-nowrap ${isNegative ? 'text-red-500 dark:text-red-400' : 'text-slate-800 dark:text-slate-100'}`}>
                    {isNegative ? '-' : ''} <CurrencyValue value={item.amount} currency={currency} />
                </div>
                {showEUR && item.amountEUR !== undefined && item.amountEUR !== 0 && (
                    <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 font-medium">
                        ≈ € {formatCurrency(Math.abs(item.amountEUR))}
                    </div>
                )}
             </div>
          </div>
        </div>
      );
    })}
  </div>
);

export const ResultsView: React.FC<Props> = ({ result, isDarkMode }) => {
  const { chResident, itResident, savingsCHF, savingsEUR, exchangeRate, monthsBasis } = result;
  const isBetterFrontaliere = savingsCHF > 0;
  
  // Logic to show "Equal" message if Old Frontier or franchigia makes taxes 0
  const isIdentical = Math.abs(itResident.netIncomeAnnual - (itResident.swissNetIncomeMonthlyCHF! * monthsBasis)) < 50;

  const exportPDF = () => {
    try {
      // Using explicit instantiation which works better with esm.sh imports
      const doc = new jsPDF();
      
      // Title
      doc.setFontSize(18);
      doc.text("Analisi Frontaliere vs Residente 2026", 14, 20);
      
      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text(`Tasso di cambio: 1 CHF = ${exchangeRate} EUR | Generato il: ${new Date().toLocaleDateString()}`, 14, 28);
      
      // Summary
      doc.setFontSize(12);
      doc.setTextColor(0);
      doc.text("Riepilogo Annuale", 14, 40);
      
      autoTable(doc, {
          startY: 45,
          head: [['Voce', 'Svizzera (Residente)', 'Italia (Frontaliere)']],
          body: [
              ['Reddito Lordo', `CHF ${formatCurrency(chResident.grossIncome)}`, `CHF ${formatCurrency(itResident.grossIncome)}`],
              ['Imposte Totali', `CHF ${formatCurrency(chResident.taxes)}`, `CHF ${formatCurrency(itResident.taxes)}`],
              ['Deduzioni Sociali', `CHF ${formatCurrency(chResident.socialContributions)}`, `CHF ${formatCurrency(itResident.socialContributions)}`],
              ['Cassa Malati', `CHF ${formatCurrency(chResident.healthInsurance)}`, `-`],
              ['Reddito Netto', `CHF ${formatCurrency(chResident.netIncomeAnnual)}`, `CHF ${formatCurrency(itResident.netIncomeAnnual)}`]
          ],
          theme: 'striped',
          headStyles: { fillColor: [59, 130, 246] }
      });

      const finalY = (doc as any).lastAutoTable.finalY + 15;
      
      doc.setFontSize(12);
      
      if (isBetterFrontaliere) {
          doc.text("Risultato: Conviene il Frontaliere", 14, finalY);
          doc.setTextColor(16, 185, 129); // Emerald 500
      } else {
          doc.text("Risultato: Conviene la Residenza", 14, finalY);
          doc.setTextColor(59, 130, 246); // Blue 500
      }

      doc.setFontSize(14);
      doc.text(`Risparmio Stimato: CHF ${formatCurrency(savingsCHF)} (EUR ${formatCurrency(savingsEUR)})`, 14, finalY + 8);
      
      doc.save('analisi_fiscale_2026.pdf');
    } catch (error) {
      console.error("PDF Export failed:", error);
      alert("Si è verificato un errore durante il download del PDF. Riprova più tardi.");
    }
  };

  return (
    <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-3xl shadow-xl shadow-slate-200/50 dark:shadow-slate-900/50 border border-white/60 dark:border-slate-800 overflow-hidden flex flex-col h-full animate-fade-in-up transition-colors duration-300">
      <div className="p-5 bg-white/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center sticky top-0 z-10 backdrop-blur-md">
        <div>
           <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">Analisi Comparativa</h2>
           <p className="text-xs text-slate-400 dark:text-slate-500">Tutti gli importi sono in <span className="font-bold text-slate-600 dark:text-slate-400">CHF</span> (Conversione EUR indicativa)</p>
        </div>
        <button onClick={exportPDF} className="p-2.5 text-slate-400 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-xl transition-all" title="Scarica PDF">
          <ScrollText size={20} />
        </button>
      </div>

      <div className="p-4 sm:p-6 flex-grow flex flex-col overflow-y-auto custom-scrollbar bg-slate-50/30 dark:bg-slate-950/30">

        {/* Banner */}
        <div className={`p-4 sm:p-6 rounded-3xl text-white shadow-lg mb-8 relative overflow-hidden transition-all duration-500 ${
            isBetterFrontaliere 
            ? 'bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600' 
            : 'bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-700'
        }`}>
           <div className="flex items-center gap-4 sm:gap-6 relative z-10">
              <div className="bg-white/20 p-3 sm:p-4 rounded-2xl backdrop-blur-md shrink-0">
                {isBetterFrontaliere ? <Trophy size={28} className="text-yellow-300" /> : <Armchair size={28} className="text-indigo-200" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                   <h3 className="text-xl sm:text-2xl font-bold tracking-tight truncate">
                     {isBetterFrontaliere ? "Vince il Frontaliere!" : "Vince la Residenza!"}
                   </h3>
                   {isBetterFrontaliere && <PartyPopper size={24} className="animate-bounce text-yellow-300" />}
                </div>
                <div className="text-white/90 font-medium flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span>Vantaggio netto:</span>
                  <span className="font-bold font-mono text-base sm:text-lg bg-white/20 px-2 py-0.5 rounded-lg border border-white/10">
                      CHF {formatCurrency(savingsCHF)}
                  </span>
                  <span className="text-xs opacity-80 pl-1">(≈ € {formatCurrency(savingsEUR)})</span>
                </div>
              </div>
           </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          
          {/* SWITZERLAND */}
          <div className="bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-sm border border-slate-100 dark:border-slate-700 relative group transition-all hover:shadow-md">
            <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
            <div className="flex justify-between items-start mb-6">
               <div>
                 <div className="text-[10px] font-bold text-blue-500 dark:text-blue-400 uppercase tracking-widest mb-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-full inline-block">Residenza</div>
                 <div className="text-xl font-bold text-slate-800 dark:text-slate-100">Svizzera</div>
               </div>
               <img src="https://flagcdn.com/w80/ch.png" className="w-8 rounded opacity-90" alt="CH" />
            </div>

            <div className="space-y-4">
              <div className="bg-blue-50/50 dark:bg-blue-900/20 p-4 rounded-2xl border border-blue-100 dark:border-blue-800/50">
                <div className="text-[10px] text-blue-500 dark:text-blue-400 font-bold uppercase mb-1">Netto Mensile (x{monthsBasis})</div>
                <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                  <CurrencyValue value={chResident.netIncomeMonthly} currency="CHF" />
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-700">
                <div className="flex justify-between items-center mb-3">
                    <span className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase">Netto Annuo</span>
                    <CurrencyValue value={chResident.netIncomeAnnual} currency="CHF" className="text-xl text-slate-800 dark:text-slate-100" />
                </div>
                
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800">
                    <span className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500">
                        Controvalore in Euro
                    </span>
                    <span className="font-mono font-bold text-sm text-slate-500 dark:text-slate-400">
                        ≈ € {formatCurrency(chResident.netIncomeAnnual * exchangeRate)}
                    </span>
                </div>
              </div>
            </div>
          </div>

          {/* ITALY */}
          <div className="bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-sm border border-slate-100 dark:border-slate-700 relative group transition-all hover:shadow-md">
            <div className="absolute top-0 left-0 w-1 h-full bg-red-500"></div>
            <div className="flex justify-between items-start mb-6">
               <div>
                 <div className="text-[10px] font-bold text-red-500 dark:text-red-400 uppercase tracking-widest mb-1 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full inline-block">Frontaliere</div>
                 <div className="text-xl font-bold text-slate-800 dark:text-slate-100">Italia</div>
               </div>
               <img src="https://flagcdn.com/w80/it.png" className="w-8 rounded opacity-90" alt="IT" />
            </div>

            <div className="space-y-4">
              <div className="bg-red-50/50 dark:bg-red-900/20 p-4 rounded-2xl border border-red-100 dark:border-red-800/50">
                <div className="text-[10px] text-red-500 dark:text-red-400 font-bold uppercase mb-1">Netto Finale Mensile (x{monthsBasis})</div>
                <div className="text-2xl font-bold text-red-700 dark:text-red-300">
                    <CurrencyValue value={itResident.netIncomeMonthly} currency="CHF" />
                </div>
                {/* Secondary Info Block */}
                <div className="mt-3 pt-3 border-t border-red-100/60 dark:border-red-800/30 flex flex-col gap-2">
                     <div className="flex justify-between items-center text-[10px] font-medium text-slate-500 dark:text-slate-400">
                        <span className="uppercase tracking-wide opacity-70">Controvalore in Euro</span>
                        <span className="font-mono">
                           ≈ € {formatCurrency(itResident.netIncomeMonthly * exchangeRate)}
                        </span>
                    </div>
                </div>
              </div>

              {/* Redesigned Footer Section */}
              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-700">
                <div className="flex justify-between items-center mb-3">
                    <span className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase">Netto Annuo</span>
                    <CurrencyValue value={itResident.netIncomeAnnual} currency="CHF" className="text-xl text-slate-800 dark:text-slate-100" />
                </div>
                
                <div className={`flex items-center justify-between p-2.5 rounded-xl border ${savingsCHF > 0 ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-800/50' : 'bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-800/50'}`}>
                    <span className={`text-[10px] font-bold uppercase ${savingsCHF > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                        {savingsCHF > 0 ? 'Risparmio vs Svizzera' : 'Perdita vs Svizzera'}
                    </span>
                    <span className={`font-mono font-bold text-sm ${savingsCHF > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
                        {savingsCHF > 0 ? '+' : ''} CHF {formatCurrency(savingsCHF)}
                    </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Details Breakdown Tables */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
           <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 overflow-hidden flex flex-col shadow-sm">
              <div className="bg-blue-50/30 dark:bg-blue-900/20 p-4 border-b border-blue-100/50 dark:border-blue-800/30">
                <h3 className="font-bold text-slate-800 dark:text-slate-100 text-sm flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                    Dettaglio Svizzera (CHF)
                </h3>
              </div>
              <div className="p-4">
                <BreakdownTable data={chResident.breakdown} currency="CHF" />
                <div className="mt-3 pt-3 border-t border-slate-50 dark:border-slate-800 space-y-2">
                  <div className="flex justify-between items-center px-3 py-1 bg-slate-50 dark:bg-slate-900 rounded">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Netto Annuo</span>
                      <span className="font-mono font-bold text-slate-800 dark:text-slate-200 text-sm">CHF {formatCurrency(chResident.netIncomeAnnual)}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 px-3 flex justify-between font-bold items-center mb-2">
                      <span className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-300">Netto Mensile (Stima)</span>
                      <span className="font-mono text-slate-800 dark:text-slate-300">CHF {formatCurrency(chResident.netIncomeMonthly)}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {chResident.details.notes.map((note, i) => (
                        <p key={i} className="text-[10px] text-slate-400 dark:text-slate-500 px-3 italic leading-relaxed">• {note}</p>
                    ))}
                  </div>
                </div>
              </div>
           </div>

           <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 overflow-hidden flex flex-col shadow-sm">
              <div className="bg-red-50/30 dark:bg-red-900/20 p-4 border-b border-red-100/50 dark:border-red-800/30">
                <h3 className="font-bold text-slate-800 dark:text-slate-100 text-sm flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500"></span>
                    Dettaglio Italia (CHF)
                </h3>
              </div>
              <div className="p-4">
                <BreakdownTable data={itResident.breakdown} currency="CHF" showEUR={true} />
                <div className="mt-3 pt-3 border-t border-slate-50 dark:border-slate-800 space-y-2">
                    
                    {/* VISIBLE BONUS BADGE */}
                    {itResident.details.franchigiaEUR && itResident.details.franchigiaEUR > 0 && (
                        <div className="mx-3 mb-2 px-3 py-1.5 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg text-green-700 dark:text-green-300 text-xs font-bold flex items-center gap-2">
                           <Tag size={14} className="fill-green-100 dark:fill-green-900" />
                           Franchigia Frontalieri € 10.000 Applicata
                        </div>
                    )}

                    <div className="flex justify-between items-center px-3 py-1 bg-slate-50 dark:bg-slate-900 rounded">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Netto Annuo Finale</span>
                      <span className="font-mono font-bold text-slate-800 dark:text-slate-200 text-sm">CHF {formatCurrency(itResident.netIncomeAnnual)}</span>
                    </div>
                    {/* Added Consistent Net Monthly */}
                    <div className="flex justify-between items-center px-3 py-1">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Netto Finale Mensile (x{monthsBasis})</span>
                      <span className="font-mono font-bold text-slate-800 dark:text-slate-200 text-sm">CHF {formatCurrency(itResident.netIncomeMonthly)}</span>
                    </div>

                    <div className="text-[10px] text-slate-500 dark:text-slate-400 px-3 flex justify-between font-bold items-center mb-2 mt-2 pt-2 border-t border-slate-100 dark:border-slate-700">
                        <span className="text-slate-400 dark:text-slate-500">Netto Busta Paga Svizzera (Pre-Tasse IT)</span>
                        <span className="font-mono text-slate-400 dark:text-slate-500">CHF {formatCurrency(itResident.swissNetIncomeMonthlyCHF || 0)}</span>
                    </div>
                    {isIdentical && (
                         <div className="px-3 py-1 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800 rounded text-[10px] text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-2">
                             <Check size={12} /> Nessuna imposta italiana dovuta (Vecchio Frontaliere o franchigia)
                         </div>
                    )}
                    <div className="flex flex-col gap-1">
                      {itResident.details.notes.map((note, i) => (
                          <p key={i} className="text-[10px] text-slate-400 dark:text-slate-500 px-3 italic leading-relaxed">• {note}</p>
                      ))}
                    </div>
                </div>
              </div>
           </div>
        </div>

        <div className="bg-white dark:bg-slate-800 p-4 sm:p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
           <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-6 flex items-center gap-2">
               <ArrowLeftRight size={18} className="text-slate-400 dark:text-slate-500" />
               Confronto Carico Fiscale Annuale (CHF)
           </h3>
           <ComparisonChart result={result} isDarkMode={isDarkMode} />
        </div>

      </div>
    </div>
  );
};