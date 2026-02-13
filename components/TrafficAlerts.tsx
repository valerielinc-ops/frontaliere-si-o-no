import React, { useState, useEffect } from 'react';
import { AlertTriangle, MapPin, Clock, Car, TrendingUp, RefreshCw, Navigation } from 'lucide-react';

interface BorderCrossing {
  name: string;
  canton: string;
  province: string;
  coordinates: [number, number];
  type: 'autostrada' | 'statale' | 'locale';
  open24h: boolean;
  customsPresent: boolean;
}

const borderCrossings: BorderCrossing[] = [
  { name: 'Chiasso-Brogeda', canton: 'TI', province: 'CO', coordinates: [45.8414, 9.0372], type: 'autostrada', open24h: true, customsPresent: true },
  { name: 'Stabio-Gaggiolo', canton: 'TI', province: 'VA', coordinates: [45.8536, 8.9342], type: 'statale', open24h: true, customsPresent: true },
  { name: 'Ponte Tresa', canton: 'TI', province: 'VA', coordinates: [45.9779, 8.8596], type: 'statale', open24h: true, customsPresent: false },
  { name: 'Fornasette-Lavena', canton: 'TI', province: 'VA', coordinates: [46.0089, 8.8644], type: 'locale', open24h: true, customsPresent: false },
  { name: 'Ponte Cremenaga', canton: 'TI', province: 'VA', coordinates: [46.0006, 8.8936], type: 'locale', open24h: true, customsPresent: false },
  { name: 'Gaggiolo-Mendrisio', canton: 'TI', province: 'VA', coordinates: [45.8625, 8.9572], type: 'statale', open24h: true, customsPresent: false },
  { name: 'Ligornetto-Saltrio', canton: 'TI', province: 'VA', coordinates: [45.8756, 8.9514], type: 'locale', open24h: true, customsPresent: false },
  { name: 'Maslianico-Ponte Chiasso', canton: 'TI', province: 'CO', coordinates: [45.8186, 9.0706], type: 'statale', open24h: true, customsPresent: false }
];

interface TrafficStatus {
  crossing: string;
  status: 'green' | 'yellow' | 'red';
  waitTime: number; // minuti
  lastUpdate: Date;
  direction: 'CH->IT' | 'IT->CH' | 'entrambi';
}

const TrafficAlerts: React.FC = () => {
  const [selectedCrossing, setSelectedCrossing] = useState<string>('Chiasso-Brogeda');
  const [trafficData, setTrafficData] = useState<TrafficStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // Simula traffico (in produzione andrebbero usate API reali come TomTom, Google Maps Traffic)
  const generateMockTraffic = (): TrafficStatus[] => {
    const now = new Date();
    const hour = now.getHours();
    const isPeakMorning = hour >= 7 && hour <= 9;
    const isPeakEvening = hour >= 17 && hour <= 19;
    
    return borderCrossings.map(crossing => {
      let baseWait = crossing.type === 'autostrada' ? 10 : crossing.type === 'statale' ? 5 : 2;
      
      if (isPeakMorning) {
        baseWait *= (crossing.name.includes('Chiasso') ? 3 : 2);
      }
      if (isPeakEvening) {
        baseWait *= (crossing.name.includes('Chiasso') ? 4 : 2);
      }
      
      // Aggiunge variazione random
      const waitTime = Math.max(0, baseWait + (Math.random() * 10 - 5));
      
      let status: 'green' | 'yellow' | 'red';
      if (waitTime < 5) status = 'green';
      else if (waitTime < 15) status = 'yellow';
      else status = 'red';

      return {
        crossing: crossing.name,
        status,
        waitTime: Math.round(waitTime),
        lastUpdate: now,
        direction: isPeakMorning ? 'IT->CH' : isPeakEvening ? 'CH->IT' : 'entrambi'
      };
    });
  };

  const refreshTraffic = () => {
    setLoading(true);
    setTimeout(() => {
      setTrafficData(generateMockTraffic());
      setLastRefresh(new Date());
      setLoading(false);
    }, 500);
  };

  useEffect(() => {
    refreshTraffic();
    const interval = setInterval(refreshTraffic, 120000); // aggiorna ogni 2 minuti
    return () => clearInterval(interval);
  }, []);

  const sortedTraffic = [...trafficData].sort((a, b) => a.waitTime - b.waitTime);
  const fastest = sortedTraffic[0];
  const slowest = sortedTraffic[sortedTraffic.length - 1];

  return (
    <div className="space-y-6 pb-8">
      <div className="bg-gradient-to-br from-orange-600 to-red-700 rounded-2xl p-8 text-white">
        <div className="flex items-center gap-3 mb-4">
          <Car size={32} />
          <h2 className="text-3xl font-extrabold">Traffico Valichi in Tempo Reale</h2>
        </div>
        <p className="text-orange-100 text-lg">
          Controlla i tempi di attesa ai valichi di confine CH-IT
        </p>
      </div>

      <div className="bg-blue-50 dark:bg-blue-950/30 border-l-4 border-blue-500 p-4 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertTriangle className="text-blue-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-blue-900 dark:text-blue-200">
            <p className="font-bold mb-1">⚠️ Dati simulati</p>
            <p>
              Questa è una demo. In produzione verrebbero usate API reali (TomTom, Google Maps, Waze) per dati traffico effettivi.
              Orari di punta: 7-9 (IT→CH), 17-19 (CH→IT)
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-slate-500" />
            <span className="text-sm text-slate-600 dark:text-slate-400">
              Ultimo aggiornamento: {lastRefresh.toLocaleTimeString('it-IT')}
            </span>
          </div>
          <button
            onClick={refreshTraffic}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Aggiorna
          </button>
        </div>
      </div>

      {fastest && slowest && (
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-950/30 dark:to-green-950/30 rounded-2xl border border-emerald-200 dark:border-emerald-800 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-3 bg-emerald-500 rounded-xl text-white">
                <TrendingUp size={24} />
              </div>
              <div>
                <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">Valico più veloce</p>
                <h3 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{fastest.crossing}</h3>
              </div>
            </div>
            <div className="text-3xl font-extrabold text-emerald-600 mb-2">
              {fastest.waitTime} min
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {fastest.direction === 'CH->IT' ? '🇨🇭 → 🇮🇹' : fastest.direction === 'IT->CH' ? '🇮🇹 → 🇨🇭' : 'Entrambe le direzioni'}
            </p>
          </div>

          <div className="bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-950/30 dark:to-orange-950/30 rounded-2xl border border-red-200 dark:border-red-800 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-3 bg-red-500 rounded-xl text-white">
                <AlertTriangle size={24} />
              </div>
              <div>
                <p className="text-sm font-bold text-red-700 dark:text-red-400">Valico più congestionato</p>
                <h3 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{slowest.crossing}</h3>
              </div>
            </div>
            <div className="text-3xl font-extrabold text-red-600 mb-2">
              {slowest.waitTime} min
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Considera valichi alternativi
            </p>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {sortedTraffic.map((traffic) => {
          const crossing = borderCrossings.find(c => c.name === traffic.crossing);
          if (!crossing) return null;

          const statusColor = traffic.status === 'green' ? 'emerald' : traffic.status === 'yellow' ? 'amber' : 'red';

          return (
            <div
              key={traffic.crossing}
              className={`bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 hover:shadow-lg transition-all border-${statusColor}-500 ring-2 ring-${statusColor}-500/20`}
            >
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className={`p-3 bg-${statusColor}-500 rounded-2xl text-white`}>
                    <MapPin size={24} />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{crossing.name}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {crossing.canton} - {crossing.province}
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <div className={`text-2xl font-extrabold text-${statusColor}-600`}>
                    {traffic.waitTime} min
                  </div>
                  <div className="text-xs text-slate-500">attesa</div>
                </div>
              </div>

              <div className="space-y-2 mb-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Tipo</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100 capitalize">{crossing.type}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Orario</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">{crossing.open24h ? '24/7' : 'Limitato'}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Direzione</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">
                    {traffic.direction === 'CH->IT' ? '🇨🇭→🇮🇹' : traffic.direction === 'IT->CH' ? '🇮🇹→🇨🇭' : '↔️'}
                  </span>
                </div>
              </div>

              <div className={`p-3 bg-${statusColor}-50 dark:bg-${statusColor}-950/30 rounded-lg flex items-center gap-2`}>
                <div className={`w-3 h-3 rounded-full bg-${statusColor}-500 animate-pulse`}></div>
                <span className={`text-sm font-bold text-${statusColor}-700 dark:text-${statusColor}-400`}>
                  {traffic.status === 'green' ? 'Traffico scorrevole' : traffic.status === 'yellow' ? 'Traffico moderato' : 'Code'}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-6">
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Navigation size={20} className="text-blue-600" />
          Suggerimenti per evitare code
        </h3>
        
        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">⏰ Orari migliori:</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>Mattina: partire prima delle 6:30 o dopo le 9:30</li>
              <li>Sera: partire prima delle 16:30 o dopo le 19:30</li>
              <li>Evita venerdì sera e domenica sera</li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">🛣️ Valichi alternativi:</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>Evita sempre Chiasso nelle ore di punta</li>
              <li>Prova Ponte Tresa, Fornasette (meno traffico)</li>
              <li>Valichi locali più lenti ma senza code</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TrafficAlerts;
