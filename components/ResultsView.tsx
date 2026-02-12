import React, { useState } from 'react';
import { ScrollText, Trophy, Armchair, Info, PartyPopper, Calculator, ChevronRight, Home, Briefcase, Heart, AlertCircle, ShoppingBag, ShieldCheck, User, Coins, Baby, TrainFront } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { SimulationResult, TaxResult, TaxBreakdownItem, SimulationInputs } from '../types';
import { ComparisonChart } from './ComparisonChart';
import { Analytics } from '../services/analytics';

interface Props {
  result: SimulationResult;
  inputs: SimulationInputs;
  isDarkMode?: boolean;
  isFocusMode?: boolean;
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
  if (l.includes('netto')) return 'bg-emerald-500'; 
  if (l.includes('sociali') || l.includes('pensione') || l.includes('contributi')) return 'bg-violet-500'; 
  if (l.includes('malati')) return 'bg-amber-500'; 
  if (l.includes('imposte') || l.includes('fonte') || l.includes('irpef')) return 'bg-slate-500'; 
  if (l.includes('spese')) return 'bg-orange-400';
  if (l.includes('reddito')) return 'bg-blue-500'; 
  return 'bg-slate-200 dark:bg-slate-700';
};

const BreakdownTable: React.FC<{ data: TaxBreakdownItem[]; currency: string; showEUR?: boolean }> = ({ data, currency, showEUR }) => (
  <div className="w-full text-sm">
    {data.map((item, idx) => {
      const isTotal = idx === 0;
      const isNet = item.label.toLowerCase().includes('netto annuo');
      const isNegative = item.amount < 0;
      const dotColor = getBreakdownColor(item.label);
      
      return (
        <div key={idx} className={`flex items-center justify-between py-3 border-b border-dashed border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50/80 dark:hover:bg-slate-800/80 px-3 rounded-lg transition-colors group cursor-default relative ${isNet ? 'bg-emerald-50/50 dark:bg-emerald-900/10 mt-2 rounded-xl border-none' : ''}`}>
          {/* Label Section */}
          <div className="flex-1 pr-3 flex items-center gap-2 min-w-0">
            {!isTotal && !isNet && <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}></div>}
            <div className="flex items-center gap-1.5 min-w-0">
              <div className={`truncate transition-colors ${isTotal || isNet ? 'font-bold text-base text-slate-900 dark:text-slate-100' : 'font-medium text-slate-600 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-slate-200'}`}>
                {item.label}
              </div>
              
              {!isTotal && item.description && (
                <div className="group/tooltip relative inline-flex items-center flex-shrink-0">
                  <Info size={12} className="text-slate-300 dark:text-slate-600 cursor-help group-hover/tooltip:text-indigo-500 transition-colors" />
                  <div className="absolute bottom-full left-0 mb-2 hidden group-hover/tooltip:block w-56 p-3 bg-slate-900 dark:bg-slate-800 text-white text-[11px] font-medium rounded-xl shadow-2xl z-50 animate-fade-in border border-slate-700">
                    {item.description}
                    <div className="absolute top-full left-2 -translate-x-1/2 border-8 border-transparent border-t-slate-900 dark:border-t-slate-800"></div>
                  </div>
                </div>
              )}
            </div>
          </div>
          
          {/* Value Section */}
          <div className="text-right flex items-center justify-end gap-3 flex-shrink-0">
             {item.percentage !== 0 && !isNet && (
                <div className="w-10 sm:w-12 text-[9px] sm:text-[10px] font-bold text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 group-hover:bg-slate-200/70 rounded px-1 py-0.5 text-center flex-shrink-0 transition-colors hidden sm:block">
                  {Math.abs(item.percentage).toFixed(1)}%
                </div>
             )}
             <div className="flex flex-col items-end w-[110px]">
                <div className={`text-right font-mono font-bold whitespace-nowrap ${isNet ? 'text-lg text-emerald-600 dark:text-emerald-400' : (isNegative ? 'text-red-500 dark:text-red-400' : 'text-slate-800 dark:text-slate-100')}`}>
                    {isNegative ? '-' : ''} <CurrencyValue value={item.amount} currency={currency} />
                </div>
                {showEUR && (
                    <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 font-medium whitespace-nowrap h-4">
                       {item.amountEUR !== undefined && item.amountEUR !== 0 ? `≈ € ${formatCurrency(Math.abs(item.amountEUR))}` : ''}
                    </div>
                )}
             </div>
          </div>
        </div>
      );
    })}
  </div>
);

export const ResultsView: React.FC<Props> = ({ result, inputs, isDarkMode, isFocusMode }) => {
  const { chResident, itResident, savingsCHF, savingsEUR, exchangeRate, monthsBasis } = result;
  const isBetterFrontaliere = savingsCHF > 0;

  // --- Profile Tag Generator ---
  const getProfileTags = () => {
    const tags = [];

    // Tag 1: Gender & Age
    const genderLabel = inputs.sex === 'M' ? 'Uomo' : 'Donna';
    tags.push({ label: `${genderLabel}, ${inputs.age} anni`, icon: User, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-900/20' });

    // Tag 2: Marital Status & Spouse
    let statusLabel = '';
    if (inputs.maritalStatus === 'SINGLE') statusLabel = 'Celibe/Nubile';
    else if (inputs.maritalStatus === 'MARRIED') statusLabel = inputs.spouseWorks ? 'Sposato/a (Coniuge lavora)' : 'Sposato/a (Coniuge a carico)';
    else if (inputs.maritalStatus === 'DIVORCED') statusLabel = 'Divorziato/a';
    else statusLabel = 'Vedovo/a';
    tags.push({ label: statusLabel, icon: Heart, color: 'text-rose-500', bg: 'bg-rose-50 dark:bg-rose-900/20' });

    // Tag 3: Children
    if (inputs.children > 0) {
      tags.push({ label: `${inputs.children} ${inputs.children === 1 ? 'Figlio' : 'Figli'}`, icon: Baby, color: 'text-pink-500', bg: 'bg-pink-50 dark:bg-pink-900/20' });
    } else {
        tags.push({ label: 'No Figli', icon: Baby, color: 'text-slate-400', bg: 'bg-slate-100 dark:bg-slate-800' });
    }

    // Tag 4: Work Type
    const workLabel = inputs.frontierWorkerType === 'NEW' 
        ? `Nuovo Frontaliere (${inputs.distanceZone === 'WITHIN_20KM' ? '<20km' : '>20km'})` 
        : 'Vecchio Frontaliere';
    tags.push({ label: workLabel, icon: TrainFront, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-900/20' });

    // Tag 5: Income
    tags.push({ label: `RAL: CHF ${formatCurrency(inputs.annualIncomeCHF)}`, icon: Coins, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/20' });

    return tags;
  };
  
  const profileTags = getProfileTags();

  const exportPDF = () => {
    // Analytics tracking
    Analytics.trackEvent('Conversion', 'Download PDF', 'Report Comparison');
    
    try {
      const doc = new jsPDF();
      
      // -- Header --
      doc.setFillColor(30, 41, 59); // Slate 800
      doc.rect(0, 0, 210, 40, 'F');
      
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(22);
      doc.setFont('helvetica', 'bold');
      doc.text("Frontaliere Si o No?", 14, 18);
      
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(148, 163, 184); // Slate 400
      doc.text("Simulazione Fiscale 2026", 14, 24);

      doc.setFontSize(10);
      doc.setTextColor(255, 255, 255);
      doc.text(`Generato il: ${new Date().toLocaleDateString('it-IT')}`, 150, 18);

      // -- Summary Box --
      doc.setFillColor(241, 245, 249); // Slate 100
      doc.setDrawColor(226, 232, 240); // Slate 200
      doc.roundedRect(14, 45, 182, 18, 2, 2, 'FD');
      
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105); // Slate 600
      doc.setFont('helvetica', 'bold');
      doc.text("PROFILO:", 18, 56);
      doc.setFont('helvetica', 'normal');
      // Create a simplified text string for PDF
      const pdfSummary = profileTags.map(t => t.label).join(' • ');
      doc.text(pdfSummary, 40, 56);

      // -- Comparison Table Data Prep --
      const bodyData = [
          ['Reddito Lordo Annuo', `CHF ${formatCurrency(chResident.grossIncome)}`, `CHF ${formatCurrency(itResident.grossIncome)}`],
          ['Assegni Familiari', `+ CHF ${formatCurrency(chResident.familyAllowance)}`, `+ CHF ${formatCurrency(itResident.familyAllowance)}`],
          ['Deduzioni Sociali (AVS/LPP)', `- CHF ${formatCurrency(Math.abs(chResident.socialContributions))}`, `- CHF ${formatCurrency(Math.abs(itResident.socialContributions))}`],
          ['Imposte Totali', `- CHF ${formatCurrency(Math.abs(chResident.taxes))}`, `- CHF ${formatCurrency(Math.abs(itResident.taxes))}`],
          ['Cassa Malati (Stimata)', `- CHF ${formatCurrency(Math.abs(chResident.healthInsurance))}`, `(Non detratta in busta)`],
          ['Spese Personali', `- CHF ${formatCurrency(Math.abs(chResident.customExpensesTotal))}`, `- CHF ${formatCurrency(Math.abs(itResident.customExpensesTotal))}`],
          ['REDDITO NETTO ANNUO', `CHF ${formatCurrency(chResident.netIncomeAnnual)}`, `CHF ${formatCurrency(itResident.netIncomeAnnual)}`]
      ];

      // Add Pre-Tax Row for Italy if exists
      if (itResident.swissNetIncomeMonthlyCHF) {
          // Insert before Net Income (last index)
          bodyData.splice(6, 0, ['Netto Svizzero (Pre-Tasse IT)', '-', `CHF ${formatCurrency(itResident.swissNetIncomeMonthlyCHF * inputs.monthsBasis)}`]);
      }

      // -- Main Table --
      autoTable(doc, {
          startY: 70,
          head: [['VOCE', 'RESIDENTE SVIZZERA', 'FRONTALIERE ITALIA']],
          body: bodyData,
          theme: 'grid',
          headStyles: { 
              fillColor: [59, 130, 246], // Blue 500
              fontSize: 10,
              fontStyle: 'bold',
              halign: 'center'
          },
          columnStyles: {
              0: { cellWidth: 70, fontStyle: 'bold', textColor: [51, 65, 85] },
              1: { halign: 'right', textColor: [30, 58, 138] }, // Dark Blue
              2: { halign: 'right', textColor: [185, 28, 28] }  // Dark Red
          },
          styles: {
              fontSize: 10,
              cellPadding: 6,
              lineColor: [226, 232, 240],
              lineWidth: 0.1
          },
          didParseCell: function(data) {
              // Style the Net Income Row
              if (data.row.index === bodyData.length - 1) {
                  data.cell.styles.fontStyle = 'bold';
                  data.cell.styles.fillColor = [236, 253, 245]; // Emerald 50
                  data.cell.styles.textColor = [5, 150, 105];   // Emerald 600
                  data.cell.styles.fontSize = 12;
              }
              // Style Pre-Tax Row
              if (data.row.cells[0].raw === 'Netto Svizzero (Pre-Tasse IT)') {
                   data.cell.styles.fillColor = [248, 250, 252];
                   data.cell.styles.fontStyle = 'italic';
              }
          }
      });

      // -- Footer Notes --
      const finalY = (doc as any).lastAutoTable.finalY + 15;
      
      doc.setFontSize(12);
      doc.setTextColor(30, 41, 59);
      doc.setFont('helvetica', 'bold');
      
      // Winner Badge logic equivalent
      const winnerText = isBetterFrontaliere ? "CONVIENE IL FRONTALIERE" : "CONVIENE LA RESIDENZA";
      const winnerColor = isBetterFrontaliere ? [22, 163, 74] : [37, 99, 235]; // Green or Blue
      
      doc.setTextColor(winnerColor[0], winnerColor[1], winnerColor[2]);
      doc.text(winnerText, 14, finalY);
      
      doc.setFontSize(10);
      doc.setTextColor(71, 85, 105);
      doc.setFont('helvetica', 'normal');
      doc.text(`Differenza netta stimata: CHF ${formatCurrency(savingsCHF)} / anno`, 14, finalY + 6);

      // Specific Notes Block
      let noteY = finalY + 20;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text("Dettagli Fiscali:", 14, noteY);
      
      doc.setFont('helvetica', 'normal');
      noteY += 6;
      const notes = [
          `Cambio applicato: 1 CHF = ${inputs.customExchangeRate} EUR`,
          `Regime Italia: ${itResident.details.regime}`,
          ...itResident.details.notes
      ];
      
      notes.forEach(note => {
          doc.text(`• ${note}`, 14, noteY);
          noteY += 5;
      });

      // Legal Disclaimer
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text("Disclaimer: Questo documento è una simulazione a scopo indicativo e non costituisce consulenza fiscale ufficiale.", 105, 285, { align: 'center' });

      doc.save('Analisi_Fiscale_Frontaliere_2026.pdf');
    } catch (error) {
      console.error("PDF Export failed:", error);
      Analytics.trackError('PDF Export Failed');
    }
  };

  return (
    <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-3xl shadow-xl shadow-slate-200/50 border border-white/60 dark:border-slate-800 overflow-hidden flex flex-col h-full animate-fade-in-up transition-colors duration-300">
      <div className="p-5 bg-white/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800 flex justify-between items-start sm:items-center sticky top-0 z-10 backdrop-blur-md gap-4 flex-col sm:flex-row">
        <div className="flex-1 w-full">
           <div className="flex justify-between items-center mb-2">
             <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">Analisi Comparativa</h2>
             <button onClick={exportPDF} className="p-2 text-slate-400 hover:text-blue-600 transition-all flex-shrink-0 sm:hidden" title="Scarica PDF">
               <ScrollText size={20} />
             </button>
           </div>
           
           {/* MODERN PROFILE TAGS */}
           <div className="flex flex-wrap gap-2">
              {profileTags.map((tag, idx) => (
                <div key={idx} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] sm:text-xs font-bold uppercase tracking-wide border border-transparent ${tag.bg} ${tag.color}`}>
                  <tag.icon size={12} strokeWidth={2.5} />
                  <span className="truncate max-w-[150px] sm:max-w-none">{tag.label}</span>
                </div>
              ))}
           </div>
        </div>
        <button onClick={exportPDF} className="hidden sm:block p-2.5 text-slate-400 hover:text-blue-600 transition-all flex-shrink-0" title="Scarica PDF">
          <ScrollText size={20} />
        </button>
      </div>

      <div className="p-4 sm:p-6 flex-grow overflow-y-auto custom-scrollbar bg-slate-50/30 dark:bg-slate-950/30">
        {/* Banner with Fun Animation */}
        <div className={`p-4 sm:p-6 rounded-3xl text-white shadow-lg mb-8 relative overflow-hidden transition-all duration-500 group ${
            isBetterFrontaliere 
            ? 'bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600' 
            : 'bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-700'
        }`}>
           {/* Confetti / Particle Background Effect */}
           <div className="absolute inset-0 opacity-10 pointer-events-none overflow-hidden">
              <div className="absolute top-[-10%] left-[10%] w-4 h-4 bg-white rounded-full animate-bounce [animation-duration:3s]"></div>
              <div className="absolute top-[-5%] left-[30%] w-3 h-3 bg-yellow-300 rounded-full animate-bounce [animation-duration:2.5s] [animation-delay:0.5s]"></div>
              <div className="absolute top-[-15%] left-[60%] w-5 h-5 bg-white rounded-full animate-bounce [animation-duration:3.2s] [animation-delay:1s]"></div>
              <div className="absolute top-[-8%] left-[80%] w-2 h-2 bg-yellow-300 rounded-full animate-bounce [animation-duration:2.8s] [animation-delay:0.2s]"></div>
              <div className="absolute top-[20%] right-[-5%] w-6 h-6 bg-white/30 rounded-full animate-ping [animation-duration:4s]"></div>
           </div>
           
           <div className="flex items-center gap-4 sm:gap-6 relative z-10">
              <div className="bg-white/20 p-3 sm:p-4 rounded-2xl backdrop-blur-md shrink-0 transition-transform group-hover:scale-110 duration-300">
                {isBetterFrontaliere ? <Trophy size={28} className="text-yellow-300" /> : <Armchair size={28} className="text-indigo-200" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                   {/* Improved Wording */}
                   <h3 className="text-xl sm:text-2xl font-bold tracking-tight truncate">
                     {isBetterFrontaliere ? "Meglio fare il Frontaliere!" : "Meglio Vivere in Svizzera!"}
                   </h3>
                   {isBetterFrontaliere && <PartyPopper size={24} className="animate-bounce text-yellow-300" />}
                </div>
                <div className="text-white/90 font-medium flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span>Vantaggio netto finale (Annuo):</span>
                  <span className="font-bold font-mono text-base sm:text-lg bg-white/20 px-2 py-0.5 rounded-lg border border-white/10 animate-pulse">
                      CHF {formatCurrency(savingsCHF)}
                  </span>
                </div>
              </div>
           </div>
        </div>
        
        {/* Comparison Grid: Changed from md:grid-cols-2 to xl:grid-cols-2 to allow full width on iPad/Tablets */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8">
          {/* SWITZERLAND COLUMN */}
          <div className="bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-sm border border-slate-100 dark:border-slate-700 relative group transition-all hover:shadow-md">
            <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
            <div className="flex justify-between items-start mb-6">
               <div>
                 <div className="text-[10px] font-bold text-blue-500 dark:text-blue-400 uppercase tracking-widest mb-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-full inline-block">Vivere in Ticino</div>
                 <div className="text-xl font-bold text-slate-800 dark:text-slate-100">Svizzera</div>
               </div>
               <img src="https://flagcdn.com/w80/ch.png" className="w-8 rounded opacity-90" alt="CH" />
            </div>

            <div className="space-y-4">
              <div className="bg-blue-50/50 dark:bg-blue-900/20 p-4 rounded-2xl border border-blue-100 dark:border-blue-800/50">
                <div className="text-[10px] text-blue-500 dark:text-blue-400 font-bold uppercase mb-1">Netto Mensile Residuo</div>
                <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                  <CurrencyValue value={chResident.netIncomeMonthly} currency="CHF" />
                </div>
              </div>
              <BreakdownTable data={chResident.breakdown} currency="CHF" />
              {chResident.details.notes.length > 0 && (
                <div className="mt-4 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
                    <p className="text-[10px] font-bold uppercase text-slate-400 mb-1">Note:</p>
                    <ul className="text-xs text-slate-500 dark:text-slate-400 list-disc list-inside">
                        {chResident.details.notes.map((note, i) => <li key={i}>{note}</li>)}
                    </ul>
                </div>
              )}
            </div>
          </div>

          {/* ITALY COLUMN */}
          <div className="bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-sm border border-slate-100 dark:border-slate-700 relative group transition-all hover:shadow-md">
            <div className="absolute top-0 left-0 w-1 h-full bg-red-500"></div>
            <div className="flex justify-between items-start mb-6">
               <div>
                 <div className="text-[10px] font-bold text-red-500 dark:text-red-400 uppercase tracking-widest mb-1 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full inline-block">Vivere in Italia</div>
                 <div className="text-xl font-bold text-slate-800 dark:text-slate-100">Italia</div>
               </div>
               <img src="https://flagcdn.com/w80/it.png" className="w-8 rounded opacity-90" alt="IT" />
            </div>

            <div className="space-y-4">
              <div className="bg-red-50/50 dark:bg-red-900/20 p-4 rounded-2xl border border-red-100 dark:border-red-800/50">
                <div className="text-[10px] text-red-500 dark:text-red-400 font-bold uppercase mb-1">Netto Mensile Residuo</div>
                <div className="text-2xl font-bold text-red-700 dark:text-red-300">
                  <CurrencyValue value={itResident.netIncomeMonthly} currency="CHF" />
                </div>
              </div>

              <BreakdownTable data={itResident.breakdown} currency="CHF" showEUR />

              {/* MOVED BLOCK: Swiss Net Salary (Pre-Italian Tax) */}
              {itResident.swissNetIncomeMonthlyCHF && (
                <div className="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 mt-2 relative overflow-hidden">
                   <div className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase mb-1 relative z-10">
                      Netto Busta Paga Svizzera (Pre-Tasse IT)
                   </div>
                   <div className="text-xl font-bold text-slate-700 dark:text-slate-200 relative z-10">
                      <CurrencyValue value={itResident.swissNetIncomeMonthlyCHF} currency="CHF" />
                   </div>
                   <ul className="mt-3 space-y-1.5 relative z-10">
                      {itResident.details.regime === "Nuovo Frontaliere" ? (
                          <>
                            <li className="text-[10px] text-slate-400 dark:text-slate-500 font-medium flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div> Tassazione concorrente (Accordo 2023)</li>
                            {itResident.details.franchigiaEUR ? (
                              <li className="text-[10px] text-slate-400 dark:text-slate-500 font-medium flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div> Franchigia {formatCurrency(itResident.details.franchigiaEUR)}€ applicata</li>
                            ) : null}
                          </>
                      ) : (
                          <li className="text-[10px] text-slate-400 dark:text-slate-500 font-medium flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div> Tassazione esclusiva Svizzera</li>
                      )}
                   </ul>
                </div>
              )}

              {itResident.details.notes.length > 0 && (
                <div className="mt-4 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
                    <p className="text-[10px] font-bold uppercase text-slate-400 mb-1">Note:</p>
                    <ul className="text-xs text-slate-500 dark:text-slate-400 list-disc list-inside">
                        {itResident.details.notes.map((note, i) => <li key={i}>{note}</li>)}
                    </ul>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* WHY CHOOSE ONE OR THE OTHER? */}
        <div className="mb-8">
           <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">
              <Heart size={14} className="text-rose-500" /> Perché conviene? (Analisi Stile di Vita)
           </h3>
           
           <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Pros Svizzera */}
              <div className="bg-gradient-to-br from-blue-50 to-white dark:from-blue-900/10 dark:to-slate-900 p-6 rounded-3xl border border-blue-100 dark:border-blue-800 shadow-sm">
                 <h4 className="flex items-center gap-2 text-blue-700 dark:text-blue-400 font-bold mb-4">
                    <ShieldCheck size={18} className="text-blue-500" /> Scelgo la Svizzera se:
                 </h4>
                 <ul className="space-y-3 text-xs text-slate-600 dark:text-slate-400 font-medium">
                    <li className="flex gap-3"><ChevronRight size={14} className="text-blue-500 shrink-0" /> <span><b>Qualità della vita:</b> Cerco servizi pubblici d'eccellenza, sicurezza e pulizia ai massimi livelli mondiali.</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-blue-500 shrink-0" /> <span><b>Carriera locale:</b> Voglio integrarmi nel tessuto sociale svizzero per future promozioni che richiedono la residenza.</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-blue-500 shrink-0" /> <span><b>Tempo libero:</b> Voglio azzerare i tempi di commuting (frontiera) e godermi la natura ticinese.</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-blue-500 shrink-0" /> <span><b>Potere d'acquisto:</b> Anche se il costo della vita è alto, i beni tecnologici e i viaggi pesano meno sul salario CH.</span></li>
                 </ul>
              </div>

              {/* Pros Italia */}
              <div className="bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-900/10 dark:to-slate-900 p-6 rounded-3xl border border-emerald-100 dark:border-emerald-800 shadow-sm">
                 <h4 className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-bold mb-4">
                    <ShoppingBag size={18} className="text-emerald-500" /> Scelgo l'Italia se:
                 </h4>
                 <ul className="space-y-3 text-xs text-slate-600 dark:text-slate-400 font-medium">
                    <li className="flex gap-3"><ChevronRight size={14} className="text-emerald-500 shrink-0" /> <span><b>Costo della vita:</b> Voglio godermi ristoranti, servizi e svaghi a una frazione del prezzo svizzero.</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-emerald-500 shrink-0" /> <span><b>Patrimonio:</b> Ho già una casa di proprietà in Italia o voglio costruirne una con costi molto inferiori.</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-emerald-500 shrink-0" /> <span><b>Socialità:</b> Preferisco lo stile di vita italiano, il cibo e la vicinanza a famiglia e amici.</span></li>
                    <li className="flex gap-3"><ChevronRight size={14} className="text-emerald-500 shrink-0" /> <span><b>Tassazione (Vecchi):</b> Se rientro nei "Vecchi Frontalieri", il risparmio fiscale è imbattibile.</span></li>
                 </ul>
              </div>
           </div>
           
           {/* Critical Warning */}
           <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl flex gap-3">
              <AlertCircle size={20} className="text-amber-500 shrink-0" />
              <div className="text-[10px] text-amber-700 dark:text-amber-400 leading-relaxed font-medium">
                 <b>Nota bene:</b> Il simulatore non considera le variazioni di prezzo degli immobili tra le due nazioni, che spesso è il fattore decisivo. In Ticino l'affitto può costare dal 50% al 150% in più rispetto alle zone di confine italiane.
              </div>
           </div>
        </div>

        <div className="mb-8">
           <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Calculator size={14} className="text-indigo-500" /> Grafico delle Riserve Mensili
           </h3>
           <ComparisonChart result={result} inputs={inputs} isDarkMode={isDarkMode} isFocusMode={isFocusMode} />
        </div>
      </div>
    </div>
  );
};