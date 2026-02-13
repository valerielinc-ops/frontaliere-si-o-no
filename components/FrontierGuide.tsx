import React, { useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Clock, TrendingUp, Home, Car, ShoppingCart, FileText, AlertCircle, CheckCircle2, Info, ArrowRight, Building2, Landmark, Shield, Users, Navigation, Timer, BarChart3, Euro, Heart, Briefcase, Calendar } from 'lucide-react';

// Fix per i marker icon di Leaflet
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Custom marker icons per tipo
const createCustomIcon = (type: 'new' | 'old' | 'both') => {
  const colors = {
    new: '#2563eb', // blue-600
    old: '#ea580c', // orange-600
    both: '#9333ea' // purple-600
  };
  
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background-color: ${colors[type]}; width: 28px; height: 28px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); border: 3px solid white; box-shadow: 0 3px 6px rgba(0,0,0,0.4);"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28]
  });
};

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

interface Municipality {
  name: string;
  province: string;
  distance: number;
  borderCrossing: string;
  population: number;
  type: 'new' | 'old' | 'both';
  lat: number;
  lng: number;
}

const FrontierGuide: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'municipalities' | 'living-ch' | 'living-it' | 'border' | 'costs'>('municipalities');
  const [sortBy, setSortBy] = useState<'distance' | 'population'>('population');
  const [filterType, setFilterType] = useState<'all' | 'new' | 'old'>('all');

  // Comuni frontalieri Lombardia con dati completi (ordinati per default per popolazione)
  const lombardyMunicipalities: Municipality[] = [
    // PROVINCIA DI COMO E VARESE - Comuni Frontalieri (fonte: CSV ufficiale ti.ch 2024)
    { name: "Como", province: "Como", distance: 6, borderCrossing: "Chiasso", population: 84000, type: 'both', lat: 45.8081, lng: 9.0852 },
    { name: "Varese", province: "Varese", distance: 10, borderCrossing: "Ponte Tresa", population: 80000, type: 'both', lat: 45.8206, lng: 8.8250 },
    { name: "Gallarate", province: "Varese", distance: 24, borderCrossing: "Gaggiolo", population: 54000, type: 'both', lat: 45.6580, lng: 8.7915 },
    { name: "Saronno", province: "Varese", distance: 22, borderCrossing: "Gaggiolo", population: 39000, type: 'old', lat: 45.6263, lng: 9.0337 },
    { name: "Tradate", province: "Varese", distance: 18, borderCrossing: "Gaggiolo", population: 18500, type: 'both', lat: 45.7089, lng: 8.9080 },
    { name: "Malnate", province: "Varese", distance: 5, borderCrossing: "Gaggiolo", population: 17000, type: 'both', lat: 45.8016, lng: 8.8759 },
    { name: "Luino", province: "Varese", distance: 15, borderCrossing: "Ponte Tresa", population: 14500, type: 'both', lat: 46.0011, lng: 8.7447 },
    { name: "Induno Olona", province: "Varese", distance: 6, borderCrossing: "Gaggiolo", population: 10500, type: 'both', lat: 45.8461, lng: 8.8403 },
    { name: "Arcisate", province: "Varese", distance: 4, borderCrossing: "Gaggiolo", population: 9800, type: 'both', lat: 45.8608, lng: 8.8513 },
    { name: "Gavirate", province: "Varese", distance: 14, borderCrossing: "Ponte Tresa", population: 9300, type: 'both', lat: 45.8475, lng: 8.7139 },
    { name: "Cernobbio", province: "Como", distance: 4, borderCrossing: "Chiasso", population: 6800, type: 'both', lat: 45.8414, lng: 9.0759 },
    { name: "Lavena Ponte Tresa", province: "Varese", distance: 0.5, borderCrossing: "Ponte Tresa", population: 5600, type: 'both', lat: 45.9595, lng: 8.8617 },
    { name: "Viggiù", province: "Varese", distance: 2.5, borderCrossing: "Gaggiolo", population: 5100, type: 'both', lat: 45.8722, lng: 8.9059 },
    { name: "Uggiate-Trevano", province: "Como", distance: 1, borderCrossing: "Chiasso", population: 4800, type: 'both', lat: 45.8234, lng: 8.9602 },
    { name: "Cantello", province: "Varese", distance: 1, borderCrossing: "Gaggiolo", population: 4700, type: 'both', lat: 45.8199, lng: 8.8947 },
    { name: "Azzate", province: "Varese", distance: 12, borderCrossing: "Ponte Tresa", population: 4600, type: 'both', lat: 45.7878, lng: 8.7681 },
    { name: "Faloppio", province: "Como", distance: 4.5, borderCrossing: "Chiasso-Brogeda", population: 4200, type: 'both', lat: 45.8089, lng: 8.9712 },
    { name: "Bisuschio", province: "Varese", distance: 2, borderCrossing: "Gaggiolo", population: 3900, type: 'both', lat: 45.8753, lng: 8.8833 },
    { name: "Maslianico", province: "Como", distance: 3, borderCrossing: "Chiasso", population: 3400, type: 'both', lat: 45.8428, lng: 9.0472 },
    { name: "Menaggio", province: "Como", distance: 15, borderCrossing: "Ponte Tresa", population: 3200, type: 'both', lat: 46.0198, lng: 9.2390 },
    { name: "Saltrio", province: "Varese", distance: 3.5, borderCrossing: "Gaggiolo", population: 3150, type: 'both', lat: 45.8739, lng: 8.9217 },
    { name: "Bellagio", province: "Como", distance: 18, borderCrossing: "Chiasso", population: 3050, type: 'both', lat: 45.9873, lng: 9.2613 },
    { name: "Porto Ceresio", province: "Varese", distance: 2, borderCrossing: "Porto Ceresio", population: 3000, type: 'both', lat: 45.9028, lng: 8.9042 },
    { name: "Grandate", province: "Como", distance: 8, borderCrossing: "Chiasso", population: 2850, type: 'both', lat: 45.7700, lng: 9.0464 },
    { name: "Valmorea", province: "Como", distance: 2, borderCrossing: "Chiasso", population: 2650, type: 'both', lat: 45.8174, lng: 8.9322 },
    { name: "Clivio", province: "Varese", distance: 3, borderCrossing: "Gaggiolo", population: 2100, type: 'both', lat: 45.8642, lng: 8.9293 },
    { name: "Campione d'Italia", province: "Como", distance: 0, borderCrossing: "Campione (enclave)", population: 2000, type: 'both', lat: 45.9681, lng: 8.9722 },
    { name: "Brunate", province: "Como", distance: 7, borderCrossing: "Chiasso", population: 1750, type: 'both', lat: 45.8244, lng: 9.0922 },
    { name: "Bizzarone", province: "Como", distance: 0.5, borderCrossing: "Chiasso", population: 1650, type: 'both', lat: 45.8433, lng: 8.9564 },
    { name: "Moltrasio", province: "Como", distance: 8, borderCrossing: "Chiasso", population: 1650, type: 'both', lat: 45.8618, lng: 9.0992 },
    { name: "Valganna", province: "Varese", distance: 8, borderCrossing: "Ponte Tresa", population: 1500, type: 'both', lat: 45.9044, lng: 8.8333 },
    { name: "Rodero", province: "Como", distance: 1.5, borderCrossing: "Chiasso", population: 1350, type: 'both', lat: 45.8240, lng: 8.9152 },
    { name: "Carate Urio", province: "Como", distance: 10, borderCrossing: "Chiasso", population: 1300, type: 'both', lat: 45.8805, lng: 9.1105 },
    { name: "Blevio", province: "Como", distance: 5, borderCrossing: "Chiasso", population: 1250, type: 'both', lat: 45.8399, lng: 9.1025 },
    { name: "Brusimpiano", province: "Varese", distance: 1.5, borderCrossing: "Porto Ceresio", population: 1200, type: 'both', lat: 45.9600, lng: 8.8783 },
    { name: "Argegno", province: "Como", distance: 12, borderCrossing: "Chiasso", population: 680, type: 'both', lat: 45.9433, lng: 9.1282 },
  ];

  const filteredMunicipalities = lombardyMunicipalities
    .filter(m => {
      if (filterType === 'all') return true;
      if (filterType === 'new') return m.type === 'new' || m.type === 'both';
      if (filterType === 'old') return m.type === 'old' || m.type === 'both';
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'distance') return a.distance - b.distance;
      return b.population - a.population;
    });

  // Dogane Canton Ticino - Italia (fonte: Wikipedia + dati frontalieri, solo Ticino)
  const borderCrossings = [
    // Como - Ticino (Principale)
    { name: "Chiasso Centro", italianSide: "Como", avgWaitMorning: "15-30 min", avgWaitEvening: "20-40 min", peak: "7:00-8:30, 17:00-18:30", hours: "24h", tips: "Principale, molto trafficato ore punta" },
    { name: "Chiasso-Brogeda", italianSide: "Como", avgWaitMorning: "8-15 min", avgWaitEvening: "12-25 min", peak: "7:00-8:30, 17:00-18:30", hours: "24h", tips: "Usa quando Chiasso Centro è bloccato" },
    { name: "Maslianico-Casteggio", italianSide: "Maslianico", avgWaitMorning: "5-10 min", avgWaitEvening: "8-15 min", peak: "7:30-8:30, 17:30-18:30", hours: "24h", tips: "Alternativa veloce a Chiasso" },
    { name: "Ronago-Novazzano", italianSide: "Ronago", avgWaitMorning: "5-12 min", avgWaitEvening: "10-18 min", peak: "7:00-8:30, 17:00-18:30", hours: "24h", tips: "Poco traffico, buona alternativa" },
    { name: "Campione d'Italia", italianSide: "Campione (enclave)", avgWaitMorning: "2-5 min", avgWaitEvening: "3-8 min", peak: "Sempre tranquillo", hours: "24h", tips: "Enclave italiana, controlli rapidi" },
    
    // Varese - Ticino
    { name: "Gaggiolo-Stabio", italianSide: "Cantello", avgWaitMorning: "10-20 min", avgWaitEvening: "15-30 min", peak: "7:00-8:30, 17:00-18:30", hours: "24h", tips: "Seconda dogana più trafficata" },
    { name: "Ponte Tresa", italianSide: "Lavena Ponte Tresa", avgWaitMorning: "5-15 min", avgWaitEvening: "10-20 min", peak: "7:30-8:30, 17:30-18:30", hours: "24h", tips: "Generalmente più veloce, zona lago" },
    { name: "Porto Ceresio-Bissone", italianSide: "Porto Ceresio", avgWaitMorning: "3-8 min", avgWaitEvening: "5-12 min", peak: "7:30-8:30, 17:30-18:30", hours: "06:00-22:00", tips: "Poco trafficato, chiusura notturna" },
    { name: "Cremenaga", italianSide: "Cremenaga", avgWaitMorning: "2-5 min", avgWaitEvening: "3-8 min", peak: "Poco traffico", hours: "06:00-20:00", tips: "Valico minore, chiusura notturna" },
    { name: "Marchirolo-Cuasso al Piano", italianSide: "Marchirolo", avgWaitMorning: "3-7 min", avgWaitEvening: "5-10 min", peak: "Poco traffico", hours: "06:00-22:00", tips: "Alternativa tranquilla" },
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
            title="Comuni Frontalieri Lombardia" 
            subtitle="Elenco principali comuni con distanze, dogane e popolazione"
          />

          {/* Filtri e Ordinamento */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
            <div className="flex flex-wrap gap-4 items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300">Ordina per:</span>
                <button
                  onClick={() => setSortBy('distance')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    sortBy === 'distance'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  📍 Distanza
                </button>
                <button
                  onClick={() => setSortBy('population')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    sortBy === 'population'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  👥 Popolazione
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300">Mostra:</span>
                <button
                  onClick={() => setFilterType('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    filterType === 'all'
                      ? 'bg-purple-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  Tutti
                </button>
                <button
                  onClick={() => setFilterType('new')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    filterType === 'new'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  Nuovo (entro 20km)
                </button>
                <button
                  onClick={() => setFilterType('old')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    filterType === 'old'
                      ? 'bg-orange-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  Vecchio (oltre 20km)
                </button>
              </div>
            </div>
          </div>

          {/* Lista Comuni */}
          <div className="grid gap-4">
            {filteredMunicipalities.map((m, idx) => (
              <div key={idx} className={`bg-gradient-to-br ${m.type === 'new' ? 'from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border-blue-200 dark:border-blue-800' : 'from-orange-50 to-red-50 dark:from-orange-950/30 dark:to-red-950/30 border-orange-200 dark:border-orange-800'} rounded-2xl border-2 p-5 hover:shadow-lg transition-all`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{m.name}</h3>
                      {m.type === 'both' ? (
                        <>
                          <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-600 text-white">
                            NUOVO
                          </span>
                          <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-orange-600 text-white">
                            VECCHIO
                          </span>
                        </>
                      ) : (
                        <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${m.type === 'new' ? 'bg-blue-600 text-white' : 'bg-orange-600 text-white'}`}>
                          {m.type === 'new' ? 'NUOVO' : 'VECCHIO'}
                        </span>
                      )}
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3 text-sm">
                      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                        <MapPin size={16} className="text-indigo-600" />
                        <span><strong>Provincia:</strong> {m.province}</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                        <Navigation size={16} className="text-emerald-600" />
                        <span><strong>Distanza:</strong> {m.distance} km dal confine</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                        <Car size={16} className="text-orange-600" />
                        <span><strong>Dogana:</strong> {m.borderCrossing}</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                        <Users size={16} className="text-purple-600" />
                        <span><strong>Popolazione:</strong> {m.population.toLocaleString('it-IT')}</span>
                      </div>
                    </div>
                  </div>
                  <CheckCircle2 size={24} className={`flex-shrink-0 ${m.type === 'new' ? 'text-blue-600' : 'text-orange-600'}`} />
                </div>
              </div>
            ))}
          </div>

          {/* Mappa Interattiva */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 overflow-hidden">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-xl">
                <MapPin className="text-white" size={20} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">Mappa Comuni Frontalieri</h3>
            </div>
            
            {/* Legenda */}
            <div className="flex gap-4 mb-4 flex-wrap text-sm">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-blue-600"></div>
                <span className="text-slate-700 dark:text-slate-300">Solo Nuovo (entro 20km)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-orange-600"></div>
                <span className="text-slate-700 dark:text-slate-300">Solo Vecchio (oltre 20km)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-purple-600"></div>
                <span className="text-slate-700 dark:text-slate-300">Entrambi gli elenchi</span>
              </div>
            </div>

            <div className="h-[500px] rounded-xl overflow-hidden border-2 border-slate-200 dark:border-slate-700">
              <MapContainer
                center={[45.88, 8.95]}
                zoom={9}
                style={{ height: '100%', width: '100%' }}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {filteredMunicipalities.map((m, idx) => (
                  <Marker
                    key={idx}
                    position={[m.lat, m.lng]}
                    icon={createCustomIcon(m.type)}
                  >
                    <Popup>
                      <div className="text-sm">
                        <h4 className="font-bold text-base mb-1">{m.name}</h4>
                        <div className="space-y-1 text-xs">
                          <p><strong>Provincia:</strong> {m.province}</p>
                          <p><strong>Distanza:</strong> {m.distance} km</p>
                          <p><strong>Popolazione:</strong> {m.population.toLocaleString('it-IT')}</p>
                          <p><strong>Dogana:</strong> {m.borderCrossing}</p>
                          <div className="flex gap-1 mt-2">
                            {m.type === 'both' ? (
                              <>
                                <span className="px-2 py-0.5 rounded bg-blue-600 text-white text-xs font-bold">NUOVO</span>
                                <span className="px-2 py-0.5 rounded bg-orange-600 text-white text-xs font-bold">VECCHIO</span>
                              </>
                            ) : (
                              <span className={`px-2 py-0.5 rounded ${m.type === 'new' ? 'bg-blue-600' : 'bg-orange-600'} text-white text-xs font-bold`}>
                                {m.type === 'new' ? 'NUOVO' : 'VECCHIO'}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-200 dark:border-amber-800 rounded-2xl p-6">
            <div className="flex items-start gap-3">
              <AlertCircle size={24} className="text-amber-600 flex-shrink-0" />
              <div className="text-sm text-amber-800 dark:text-amber-200 space-y-2">
                <p className="font-bold">⚠️ Nota Importante</p>
                <ul className="space-y-1 text-xs">
                  <li>• Questa lista mostra i <strong>principali comuni lombardi</strong> (province di Como e Varese)</li>
                  <li>• <strong>Totale Lombardia:</strong> 338 comuni entro 20 km (Nuovo), 180+ comuni oltre 20 km (Vecchio)</li>
                  <li>• Distanze calcolate in linea d'aria dal confine svizzero più vicino</li>
                  <li>• <strong>Lista completa ufficiale:</strong> <a href="https://www.ti.ch/fonte" target="_blank" rel="noopener noreferrer" className="underline font-semibold">www.ti.ch/fonte</a></li>
                  <li>• Verifica sempre con CAF/datore di lavoro la tua situazione specifica</li>
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

          <div className="grid md:grid-cols-2 gap-4">
            {borderCrossings.map((border, idx) => (
              <div key={idx} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 hover:shadow-lg transition-shadow">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 bg-orange-500 rounded-lg">
                    <Navigation className="text-white" size={18} />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{border.name}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">📍 {border.italianSide}</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-600 dark:text-slate-400">Attesa Mattina (🌅 7-9)</span>
                    <span className="text-sm font-bold text-orange-600">{border.avgWaitMorning}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-600 dark:text-slate-400">Attesa Sera (🌆 17-19)</span>
                    <span className="text-sm font-bold text-red-600">{border.avgWaitEvening}</span>
                  </div>
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">⏰ Orari Apertura</div>
                    <div className="text-sm font-semibold text-emerald-600">{border.hours}</div>
                  </div>
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">🔴 Orari di Punta</div>
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">{border.peak}</div>
                  </div>
                  <div className="p-2.5 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
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
