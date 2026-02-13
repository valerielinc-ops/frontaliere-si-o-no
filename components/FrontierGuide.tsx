import React, { useState } from 'react';
import { MapPin, Clock, TrendingUp, Home, Car, ShoppingCart, FileText, AlertCircle, CheckCircle2, Info, ArrowRight, Building2, Landmark, Shield, Users, Navigation, Timer, BarChart3, Euro, Heart, Briefcase, Calendar } from 'lucide-react';

const InfoCard = ({ icon: Icon, title, children, color = "blue" }: any) => {
  const colorClasses = {
    blue: "from-blue-500 to-indigo-600 border-blue-200 dark:border-blue-800",
    green: "from-emerald-500 to-teal-600 border-emerald-200 dark:border-emerald-800",
    purple: "from-purple-500 to-pink-600 border-purple-200 dark:border-purple-800",
    orange: "from-orange-500 to-red-600 border-orange-200 dark:border-orange-800",
    teal: "from-teal-500 to-cyan-600 border-teal-200 dark:border-teal-800"
  };

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-center gap-3 mb-4">
        <div className={`p-2.5 bg-gradient-to-br ${colorClasses[color as keyof typeof colorClasses]} rounded-xl`}>
          <Icon className="text-white" size={20} />
        </div>
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{title}</h3>
      </div>
      <div className="space-y-3 text-sm text-slate-600 dark:text-slate-400">
        {children}
      </div>
    </div>
  );
};

const SectionHeader = ({ icon: Icon, title, subtitle }: any) => (
  <div className="flex items-center gap-4 mb-6">
    <div className="p-3 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl shadow-lg">
      <Icon className="text-white" size={28} />
    </div>
    <div>
      <h2 className="text-3xl font-extrabold text-slate-800 dark:text-slate-100">{title}</h2>
      {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>}
    </div>
  </div>
);

const FrontierGuide: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'municipalities' | 'living-ch' | 'living-it' | 'border' | 'costs'>('municipalities');

  // Comuni frontalieri Vecchio Ordinamento (pre 17/07/2023) - Solo Fascia 1
  // Totale: 180 comuni nelle province di Como, Varese, Lecco, Sondrio, Verbano-Cusio-Ossola, Aosta, Bergamo, Brescia, Bolzano, Trento
  const oldFrontierMunicipalities = [
    "ALAGNA VALSESIA", "ANDALO VALTELLINO", "APRICA", "BARLASSINA", "BERBENNO DI VALTELLINA", 
    "BIANZONE", "BORMIO", "BREBBIA", "BRIOSCO", "BULCIAGO", "CAMPODOLCINO", "CASPOGGIO", 
    "CHIAVENNA", "CHIESA IN VALMALENCO", "CHIURO", "COGLIATE", "COLORINA", "CORTENO GOLGI", 
    "COSIO VALTELLINO", "CRAVAGLIANA", "CURON VENOSTA", "DAZIO", "DELEBIO", "DRUOGNO", "DUBINO", 
    "EDOLO", "FAEDO VALTELLINO", "FOBELLO", "FORCOLA", "FORMAZZA", "FUSINE", "GERENZANO", 
    "GIUSSANO", "GLORENZA", "GORDONA", "GROSIO", "GROSOTTO", "INCUDINE", "LANZADA", "LASA", 
    "LENTATE SUL SEVESO", "LIVIGNO", "LOVERO", "MADESIMO", "MALONNO", "MANTELLO", "MARTELLO", 
    "MAZZO DI VALTELLINA", "MELLO", "MESE", "MOLLIA", "MOLTENO", "MONNO", "MONTAGNA IN VALTELLINA",
    "E 130+ altri comuni oltre i 20 km dal confine"
  ];

  // Comuni frontalieri Nuovo Ordinamento (entro 20 km dal confine) - Fascia 1A
  // Totale: 338 comuni principalmente in province di Como e Varese
  const newFrontierMunicipalities = [
    "ABBADIA LARIANA", "AGRA", "ALBAVILLA", "ALBESE CON CASSANO", "ALBIOLO", "ALBIZZATE", 
    "ALSERIO", "ALTA VALLE INTELVI", "ALZATE BRIANZA", "ANZANO DEL PARCO", "APPIANO GENTILE", 
    "ARCISATE", "ARGEGNO", "ARIZZANO", "AROSIO", "ARSAGO SEPRIO", "ASSO", "AZZATE", "AZZIO", 
    "BARASSO", "BARDELLO CON MALGESSO E BREGANO", "BARNI", "BEDERO VALCUVIA", "BEE", "BELLAGIO", 
    "BELLANO", "BENE LARIO", "BESANO", "BESNATE", "BESOZZO", "BIANDRONNO", "BINAGO", "BISUSCHIO", 
    "BIZZARONE", "BLESSAGNO", "BLEVIO", "BODIO LOMNAGO", "BOSISIO PARINI", "BREGNANO", "BRENNA", 
    "BRENTA", "BREZZO DI BEDERO", "BRIENNO", "BRINZIO", "BRISSAGO-VALTRAVAGLIA", "BRUNATE", 
    "BRUNELLO", "BRUSIMPIANO", "BUGUGGIATE", "BULGAROGRASSO", "CABIATE", "CADEGLIANO-VICONAGO", 
    "CADORAGO", "CADREZZATE CON OSMATE", "CAGLIO", "CAIRATE", "CAMPIONE D'ITALIA", "CANNERO RIVIERA", 
    "CANNOBIO", "CANTELLO", "CANTÙ", "CANZO", "CAPIAGO INTIMIANO", "CARATE URIO", "CARAVATE",
    "E 288+ altri comuni entro 20 km dal confine (vedi www.ti.ch/fonte per lista completa)"
  ];

  const borderCrossings = [
    { name: "Chiasso-Como", avgWaitMorning: "15-30 min", avgWaitEvening: "20-40 min", peak: "7:00-8:30, 17:00-18:30", tips: "Usa Brogeda se molto traffico" },
    { name: "Gaggiolo-Stabio", avgWaitMorning: "10-20 min", avgWaitEvening: "15-30 min", peak: "7:00-8:30, 17:00-18:30", tips: "Alternativa a Chiasso" },
    { name: "Ponte Tresa", avgWaitMorning: "5-15 min", avgWaitEvening: "10-20 min", peak: "7:30-8:30, 17:30-18:30", tips: "Generalmente più veloce" },
    { name: "Brogeda (Chiasso 2)", avgWaitMorning: "8-15 min", avgWaitEvening: "12-25 min", peak: "7:00-8:30, 17:00-18:30", tips: "Usa quando Chiasso è bloccato" }
  ];

  const costComparison = [
    { category: "Affitto 3.5 locali", switzerland: "1800-2500 CHF", italy: "700-1200 €", note: "Lugano/Mendrisio vs Como/Varese" },
    { category: "Spesa mensile (2 persone)", switzerland: "600-800 CHF", italy: "350-500 €", note: "Supermercati standard" },
    { category: "Benzina (litro)", switzerland: "1.85 CHF", italy: "1.75 €", note: "Prezzi medi 2026" },
    { category: "Ristorante (menù)", switzerland: "25-40 CHF", italy: "15-25 €", note: "Pranzo medio" },
    { category: "Assicurazione auto", switzerland: "800-1200 CHF/anno", italy: "600-1000 €/anno", note: "Casco completo" },
    { category: "Elettricità (kWh)", switzerland: "0.20 CHF", italy: "0.25 €", note: "Tariffa media" },
    { category: "Internet", switzerland: "50-80 CHF", italy: "25-40 €", note: "Fibra 1 Gbps" }
  ];

  return (
    <div className="space-y-8 pb-12">
      {/* Header */}
      <div className="text-center space-y-3 mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl shadow-lg mb-4">
          <MapPin size={32} className="text-white" />
        </div>
        <h1 className="text-4xl font-extrabold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
          Guida Completa al Frontalierato
        </h1>
        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
          Tutte le informazioni essenziali per chi lavora in Svizzera e vive in Italia: comuni frontalieri, 
          costi, tempi di percorrenza e consigli pratici.
        </p>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap gap-2 justify-center mb-8">
        <button
          onClick={() => setActiveSection('municipalities')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'municipalities'
              ? 'bg-indigo-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <MapPin size={16} />
          Comuni Frontalieri
        </button>
        <button
          onClick={() => setActiveSection('border')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'border'
              ? 'bg-orange-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Timer size={16} />
          Dogane & Tempi
        </button>
        <button
          onClick={() => setActiveSection('costs')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'costs'
              ? 'bg-emerald-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Euro size={16} />
          Costi & Consumi
        </button>
        <button
          onClick={() => setActiveSection('living-ch')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'living-ch'
              ? 'bg-red-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Home size={16} />
          Vivere in CH
        </button>
        <button
          onClick={() => setActiveSection('living-it')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'living-it'
              ? 'bg-green-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Users size={16} />
          Vivere in IT
        </button>
      </div>

      {/* Content Sections */}
      {activeSection === 'municipalities' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={MapPin} 
            title="Comuni Frontalieri" 
            subtitle="Elenco aggiornato secondo nuovo e vecchio ordinamento fiscale"
          />

          <div className="grid md:grid-cols-2 gap-6">
            {/* Nuovo Ordinamento */}
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl border-2 border-blue-200 dark:border-blue-800 p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-blue-600 rounded-lg">
                  <Calendar className="text-white" size={20} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">Nuovo Ordinamento</h3>
                  <p className="text-xs text-blue-600 dark:text-blue-400 font-semibold">Dal 17/07/2023 - Entro 20 km dal confine</p>
                </div>
              </div>

              <div className="space-y-1 max-h-96 overflow-y-auto pr-2">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {newFrontierMunicipalities.slice(0, 60).map((name, idx) => (
                    <div key={idx} className="bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-slate-700 transition-colors flex items-center gap-2">
                      <CheckCircle2 size={12} className="text-blue-600 flex-shrink-0" />
                      <span className="truncate">{name}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 p-2 bg-blue-50 dark:bg-blue-900/20 rounded text-xs text-blue-700 dark:text-blue-300 text-center">
                  {newFrontierMunicipalities.length > 60 && `+ altri ${newFrontierMunicipalities.length - 60} comuni`}
                  <br />
                  <a href="https://www.ti.ch/fonte" target="_blank" rel="noopener noreferrer" className="underline font-semibold">
                    Lista completa su www.ti.ch/fonte
                  </a>
                </div>
              </div>

              <div className="mt-4 p-3 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-xs text-blue-800 dark:text-blue-300">
                <strong>Totale: {newFrontierMunicipalities.length} comuni</strong> • Criterio: Residenza entro 20 km dal confine svizzero più vicino (in linea d'aria)
              </div>
            </div>

            {/* Vecchio Ordinamento */}
            <div className="bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-950/30 dark:to-pink-950/30 rounded-2xl border-2 border-purple-200 dark:border-purple-800 p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-purple-600 rounded-lg">
                  <Clock className="text-white" size={20} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">Vecchio Ordinamento</h3>
                  <p className="text-xs text-purple-600 dark:text-purple-400 font-semibold">Fino al 17/07/2023 - Zona fascia 20 km</p>
                </div>
              </div>

              <div className="space-y-1 max-h-96 overflow-y-auto pr-2">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {oldFrontierMunicipalities.slice(0, 54).map((name, idx) => (
                    <div key={idx} className="bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-purple-50 dark:hover:bg-slate-700 transition-colors flex items-center gap-2">
                      <CheckCircle2 size={12} className="text-purple-600 flex-shrink-0" />
                      <span className="truncate">{name}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 p-2 bg-purple-50 dark:bg-purple-900/20 rounded text-xs text-purple-700 dark:text-purple-300 text-center">
                  {oldFrontierMunicipalities.length > 54 && `+ ${oldFrontierMunicipalities[54]}`}
                  <br />
                  <a href="https://www.ti.ch/fonte" target="_blank" rel="noopener noreferrer" className="underline font-semibold">
                    Lista completa su www.ti.ch/fonte
                  </a>
                </div>
              </div>

              <div className="mt-4 p-3 bg-purple-100 dark:bg-purple-900/30 rounded-lg text-xs text-purple-800 dark:text-purple-300">
                <strong>Totale: 180 comuni</strong> • Criterio: Comuni specificati nell'Accordo 1974, vale per chi lavorava già in CH prima del 17/07/2023 (clausola di salvaguardia)
              </div>
            </div>
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-200 dark:border-amber-800 rounded-2xl p-6">
            <div className="flex items-start gap-3">
              <AlertCircle size={24} className="text-amber-600 flex-shrink-0" />
              <div className="text-sm text-amber-800 dark:text-amber-200 space-y-2">
                <p className="font-bold">⚠️ Nota Importante</p>
                <ul className="space-y-1 text-xs">
                  <li>• <strong>Nuovo Ordinamento:</strong> Si applica a chi ha iniziato a lavorare in CH dal 17/07/2023 in poi</li>
                  <li>• <strong>Vecchio Ordinamento:</strong> Vale per chi lavorava già in CH prima del 17/07/2023 (grandfathering clause)</li>
                  <li>• La distanza di 20 km è calcolata in linea d'aria dal comune di residenza al confine svizzero più vicino</li>
                  <li>• Verifica sempre con il tuo datore di lavoro e CAF la tua situazione specifica</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeSection === 'border' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={Timer} 
            title="Dogane & Tempi di Percorrenza" 
            subtitle="Attese medie e consigli per attraversare il confine"
          />

          <div className="grid md:grid-cols-2 gap-6">
            {borderCrossings.map((border, idx) => (
              <div key={idx} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 hover:shadow-lg transition-shadow">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 bg-orange-500 rounded-lg">
                    <Navigation className="text-white" size={20} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{border.name}</h3>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600 dark:text-slate-400">Attesa Mattina (🌅 7-9)</span>
                    <span className="text-sm font-bold text-orange-600">{border.avgWaitMorning}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600 dark:text-slate-400">Attesa Sera (🌆 17-19)</span>
                    <span className="text-sm font-bold text-red-600">{border.avgWaitEvening}</span>
                  </div>
                  <div className="pt-3 border-t border-slate-200 dark:border-slate-700">
                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">⏰ Orari di Punta</div>
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{border.peak}</div>
                  </div>
                  <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                    <div className="text-xs text-blue-700 dark:text-blue-300">
                      <strong>💡 Consiglio:</strong> {border.tips}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <InfoCard icon={Clock} title="Tempi di Percorrenza Medi" color="blue">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Como → Lugano</div>
                <div className="text-lg font-bold text-blue-600">25-40 min</div>
              </div>
              <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Varese → Mendrisio</div>
                <div className="text-lg font-bold text-blue-600">20-35 min</div>
              </div>
              <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Varese → Lugano</div>
                <div className="text-lg font-bold text-blue-600">30-45 min</div>
              </div>
              <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Milano → Lugano</div>
                <div className="text-lg font-bold text-blue-600">60-90 min</div>
              </div>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
              * Tempi variabili in base a traffico e code alla dogana. Considera +10/15 min nei giorni di pioggia o neve.
            </p>
          </InfoCard>

          <InfoCard icon={Car} title="Consigli per il Pendolarismo" color="purple">
            <ul className="space-y-2">
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>Parti presto:</strong> Evita l'orario 7:30-8:30 se possibile</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>App traffico:</strong> Usa Google Maps o Waze per monitorare code in tempo reale</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>Documenti:</strong> Tieni sempre permesso G, carta d'identità e libretto auto a portata di mano</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>Vignetta autostradale:</strong> Obbligatoria CHF 40/anno (valida 14 mesi)</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>Carpool:</strong> Considera car sharing con colleghi per risparmiare benzina</span>
              </li>
            </ul>
          </InfoCard>
        </div>
      )}

      {activeSection === 'costs' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={BarChart3} 
            title="Confronto Costi Svizzera-Italia" 
            subtitle="Confronto dettagliato del costo della vita tra Ticino e Italia"
          />

          <div className="overflow-x-auto">
            <table className="w-full bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <thead className="bg-gradient-to-r from-emerald-500 to-teal-600 text-white">
                <tr>
                  <th className="px-6 py-4 text-left font-bold">Categoria</th>
                  <th className="px-6 py-4 text-left font-bold">🇨🇭 Svizzera</th>
                  <th className="px-6 py-4 text-left font-bold">🇮🇹 Italia</th>
                  <th className="px-6 py-4 text-left font-bold">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {costComparison.map((item, idx) => (
                  <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                    <td className="px-6 py-4 font-semibold text-slate-800 dark:text-slate-100">{item.category}</td>
                    <td className="px-6 py-4 text-red-600 dark:text-red-400 font-bold">{item.switzerland}</td>
                    <td className="px-6 py-4 text-emerald-600 dark:text-emerald-400 font-bold">{item.italy}</td>
                    <td className="px-6 py-4 text-xs text-slate-500 dark:text-slate-400">{item.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <InfoCard icon={ShoppingCart} title="Spesa Alimentare" color="green">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span>Pane (1 kg)</span>
                  <div className="text-right">
                    <div className="text-sm font-bold text-red-600">CHF 5-6</div>
                    <div className="text-xs text-emerald-600">€ 2-3</div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span>Latte (1L)</span>
                  <div className="text-right">
                    <div className="text-sm font-bold text-red-600">CHF 1.5-2</div>
                    <div className="text-xs text-emerald-600">€ 1.2-1.5</div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span>Pasta (500g)</span>
                  <div className="text-right">
                    <div className="text-sm font-bold text-red-600">CHF 2-3</div>
                    <div className="text-xs text-emerald-600">€ 0.8-1.5</div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span>Carne (1 kg)</span>
                  <div className="text-right">
                    <div className="text-sm font-bold text-red-600">CHF 25-35</div>
                    <div className="text-xs text-emerald-600">€ 12-18</div>
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                💡 <strong>Consiglio:</strong> Molti frontalieri fanno spesa in Italia per risparmiare 30-40%
              </p>
            </InfoCard>

            <InfoCard icon={Home} title="Costi Abitazione" color="orange">
              <div className="space-y-3">
                <div>
                  <div className="font-semibold text-slate-800 dark:text-slate-100 mb-2">Affitto Mensile (3.5 locali)</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg text-center">
                      <div className="text-xs text-slate-600 dark:text-slate-400">Lugano/Mendrisio</div>
                      <div className="text-lg font-bold text-red-600">1800-2500 CHF</div>
                    </div>
                    <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg text-center">
                      <div className="text-xs text-slate-600 dark:text-slate-400">Como/Varese</div>
                      <div className="text-lg font-bold text-emerald-600">700-1200 €</div>
                    </div>
                  </div>
                </div>
                <div>
                  <div className="font-semibold text-slate-800 dark:text-slate-100 mb-2">Acquisto Casa (prezzo/m²)</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg text-center">
                      <div className="text-xs text-slate-600 dark:text-slate-400">Canton Ticino</div>
                      <div className="text-lg font-bold text-red-600">6000-9000 CHF</div>
                    </div>
                    <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg text-center">
                      <div className="text-xs text-slate-600 dark:text-slate-400">Como/Varese</div>
                      <div className="text-lg font-bold text-emerald-600">2000-3500 €</div>
                    </div>
                  </div>
                </div>
              </div>
            </InfoCard>
          </div>
        </div>
      )}

      {activeSection === 'living-ch' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={Home} 
            title="Vivere in Svizzera (Permesso B)" 
            subtitle="Cosa sapere se decidi di trasferirti in Canton Ticino"
          />

          <div className="grid md:grid-cols-2 gap-6">
            <InfoCard icon={FileText} title="Documenti Necessari" color="blue">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Contratto di lavoro:</strong> Indispensabile per permesso B</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Contratto affitto:</strong> Prova di residenza in Svizzera</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Certificato penale:</strong> Richiesto dal Comune italiano</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Foto tessera:</strong> 2 foto formato passaporto</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Passaporto/CI:</strong> Documento d'identità valido</span>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={Shield} title="Assicurazioni Obbligatorie" color="purple">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>LAMal (Cassa Malati):</strong>
                    <div className="text-xs mt-1">Obbligatoria entro 3 mesi. Costo: CHF 300-500/mese</div>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>Responsabilità Civile:</strong>
                    <div className="text-xs mt-1">Consigliata (non obbligatoria). Costo: ~CHF 100/anno</div>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>Mobilia/Economia domestica:</strong>
                    <div className="text-xs mt-1">Spesso richiesta dal proprietario. Costo: ~CHF 150/anno</div>
                  </div>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={Briefcase} title="Vantaggi Residenza CH" color="green">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Tassazione alla fonte:</strong> Aliquota più bassa (~12-18%)</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Niente dichiarazione IT:</strong> Non sei residente fiscale italiano</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Sanità svizzera:</strong> Sistema sanitario di alta qualità</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Mobilità libera:</strong> Nessun obbligo di rientro settimanale</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Ricongiungimento:</strong> Famiglia può trasferirsi facilmente</span>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={AlertCircle} title="Svantaggi/Criticità" color="orange">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Costo vita alto:</strong> Affitti e spese molto più elevati</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Cassa malati:</strong> CHF 300-500/mese per adulto (obbligatoria)</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Distanza familiari:</strong> Se la famiglia rimane in Italia</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Prelievo LPP:</strong> Vincoli maggiori su 2° pilastro</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Integrazione:</strong> Possibile barriera linguistica (tedesco/dialetto)</span>
                </li>
              </ul>
            </InfoCard>
          </div>
        </div>
      )}

      {activeSection === 'living-it' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={Users} 
            title="Vivere in Italia (Permesso G)" 
            subtitle="La vita da frontaliere: cosa comporta risiedere in Italia"
          />

          <div className="grid md:grid-cols-2 gap-6">
            <InfoCard icon={FileText} title="Documenti da Presentare" color="blue">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Permesso G:</strong> Rilasciato dal Comune CH entro 8 giorni dall'assunzione</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Certificato residenza:</strong> Estratto dal Comune italiano</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Contratto lavoro:</strong> Copia del contratto svizzero</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Carta identità:</strong> Sempre valida e aggiornata</span>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={Heart} title="Sanità & Assicurazioni" color="purple">
              <div className="space-y-3">
                <div>
                  <strong className="text-purple-600">Opzione 1: LAMal Svizzera</strong>
                  <div className="text-xs mt-1">CHF 300-500/mese, copre tutto in CH e urgenze IT</div>
                </div>
                <div>
                  <strong className="text-emerald-600">Opzione 2: SSN Italia + Integrativa</strong>
                  <div className="text-xs mt-1">Gratis SSN + ~€50-100/mese integrativa, valida in CH con TEAM</div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-xs text-blue-700 dark:text-blue-300">
                  💡 Molti frontalieri scelgono SSN per risparmiare, ma valuta coperture e tempi d'attesa
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={Briefcase} title="Vantaggi da Frontaliere" color="green">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Costo vita basso:</strong> Affitto e spese molto più economici</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Vicinanza famiglia:</strong> Mantieni legami sociali in Italia</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Opzione SSN:</strong> Sanità gratuita se scegli sistema italiano</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Potere d'acquisto:</strong> Stipendio CH con costi IT = risparmio alto</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Flessibilità:</strong> Puoi cambiare lavoro senza vincoli residenza</span>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={AlertCircle} title="Criticità da Considerare" color="orange">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Pendolarismo:</strong> 1-2 ore/giorno in macchina (stress, costi benzina)</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Rientri obbligatori:</strong> Vecchi frontalieri devono rientrare settimanalmente</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Dichiarazione IRPEF:</strong> Obbligo dichiarazione annuale italiana</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Complessità fiscale:</strong> Sistema misto CH-IT più complesso</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>Traffico:</strong> Code quotidiane alle dogane (15-40 min)</span>
                </li>
              </ul>
            </InfoCard>
          </div>

          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30 rounded-2xl border-2 border-indigo-200 dark:border-indigo-800 p-6">
            <div className="flex items-start gap-3">
              <Info size={24} className="text-indigo-600 flex-shrink-0" />
              <div className="space-y-3 text-sm text-indigo-800 dark:text-indigo-200">
                <p className="font-bold">📋 Checklist Frontaliere Perfetto</p>
                <div className="grid sm:grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>Permesso G sempre valido</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>Vignetta autostradale CH aggiornata</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>Assicurazione auto valida in CH</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>Immatricolazione auto entro 60 giorni</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>Dichiarazione redditi IT entro scadenza</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>Rispetto rientri settimanali (vecchi)</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FrontierGuide;
