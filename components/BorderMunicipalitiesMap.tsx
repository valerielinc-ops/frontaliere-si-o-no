import React, { useState, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { borderCrossings } from '@/data/borderCrossings';
import { MapContainer, TileLayer, CircleMarker, Popup, Marker } from 'react-leaflet';
import { MapPin, Filter, Info, AlertTriangle, Train, ArrowUpDown } from 'lucide-react';
import 'leaflet/dist/leaflet.css';

// ─── Municipality data (subset — key border municipalities with tax data) ───

interface Municipality {
  name: string;
  province: string;
  lat: number;
  lng: number;
  irpefAddizionale: number; // Addizionale comunale IRPEF (%)
  distanceKm: number; // Distance from nearest crossing
  avgRentMonthly: number; // Average rent €/month (bilocale)
  population: number;
  fascia: '1' | '1A' | '2'; // Frontier zone
}

// Representative border municipalities (Como, Varese, VB, SO provinces)
const MUNICIPALITIES: Municipality[] = [
  // COMO
  { name: 'Como', province: 'CO', lat: 45.8081, lng: 9.0852, irpefAddizionale: 0.8, distanceKm: 3, avgRentMonthly: 750, population: 84000, fascia: '1' },
  { name: 'Cernobbio', province: 'CO', lat: 45.8472, lng: 9.0727, irpefAddizionale: 0.6, distanceKm: 4, avgRentMonthly: 850, population: 6800, fascia: '1' },
  { name: 'Chiasso (IT - Ponte Chiasso)', province: 'CO', lat: 45.8326, lng: 9.0340, irpefAddizionale: 0.5, distanceKm: 0, avgRentMonthly: 600, population: 3200, fascia: '1' },
  { name: 'Maslianico', province: 'CO', lat: 45.8389, lng: 9.0283, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 550, population: 3300, fascia: '1' },
  { name: 'Uggiate con Ronago', province: 'CO', lat: 45.8280, lng: 8.9668, irpefAddizionale: 0.55, distanceKm: 3, avgRentMonthly: 580, population: 5500, fascia: '1' },
  { name: 'Olgiate Comasco', province: 'CO', lat: 45.7843, lng: 8.9678, irpefAddizionale: 0.7, distanceKm: 7, avgRentMonthly: 620, population: 11600, fascia: '1' },
  { name: 'Cantù', province: 'CO', lat: 45.7382, lng: 9.1271, irpefAddizionale: 0.75, distanceKm: 15, avgRentMonthly: 650, population: 40000, fascia: '1A' },
  { name: 'Erba', province: 'CO', lat: 45.8128, lng: 9.2226, irpefAddizionale: 0.7, distanceKm: 18, avgRentMonthly: 580, population: 16500, fascia: '1A' },
  { name: 'Menaggio', province: 'CO', lat: 46.0200, lng: 9.2365, irpefAddizionale: 0.5, distanceKm: 8, avgRentMonthly: 700, population: 3200, fascia: '1' },
  { name: 'Porlezza', province: 'CO', lat: 46.0360, lng: 9.1287, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 550, population: 4700, fascia: '1' },
  { name: 'Lanzo d\'Intelvi', province: 'CO', lat: 45.9748, lng: 9.0500, irpefAddizionale: 0.5, distanceKm: 5, avgRentMonthly: 480, population: 1400, fascia: '1' },
  { name: 'Campione d\'Italia', province: 'CO', lat: 45.9696, lng: 8.9708, irpefAddizionale: 0.0, distanceKm: 0, avgRentMonthly: 900, population: 1900, fascia: '1' },
  // VARESE
  { name: 'Varese', province: 'VA', lat: 45.8183, lng: 8.8249, irpefAddizionale: 0.8, distanceKm: 12, avgRentMonthly: 650, population: 80000, fascia: '1A' },
  { name: 'Lavena Ponte Tresa', province: 'VA', lat: 45.9639, lng: 8.8558, irpefAddizionale: 0.5, distanceKm: 0, avgRentMonthly: 550, population: 5500, fascia: '1' },
  { name: 'Luino', province: 'VA', lat: 46.0017, lng: 8.7467, irpefAddizionale: 0.6, distanceKm: 1, avgRentMonthly: 500, population: 14200, fascia: '1' },
  { name: 'Porto Ceresio', province: 'VA', lat: 45.9075, lng: 8.9042, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 520, population: 3000, fascia: '1' },
  { name: 'Induno Olona', province: 'VA', lat: 45.8542, lng: 8.8375, irpefAddizionale: 0.6, distanceKm: 8, avgRentMonthly: 580, population: 10200, fascia: '1' },
  { name: 'Arcisate', province: 'VA', lat: 45.8650, lng: 8.8550, irpefAddizionale: 0.6, distanceKm: 5, avgRentMonthly: 550, population: 10000, fascia: '1' },
  { name: 'Viggiù', province: 'VA', lat: 45.8700, lng: 8.8960, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 500, population: 5300, fascia: '1' },
  { name: 'Busto Arsizio', province: 'VA', lat: 45.6116, lng: 8.8506, irpefAddizionale: 0.8, distanceKm: 30, avgRentMonthly: 600, population: 84000, fascia: '2' },
  { name: 'Gallarate', province: 'VA', lat: 45.6594, lng: 8.7912, irpefAddizionale: 0.75, distanceKm: 25, avgRentMonthly: 580, population: 54000, fascia: '2' },
  // VERBANO-CUSIO-OSSOLA
  { name: 'Verbania', province: 'VB', lat: 45.9257, lng: 8.5528, irpefAddizionale: 0.7, distanceKm: 5, avgRentMonthly: 500, population: 30000, fascia: '1' },
  { name: 'Domodossola', province: 'VB', lat: 46.1140, lng: 8.2922, irpefAddizionale: 0.65, distanceKm: 3, avgRentMonthly: 450, population: 18000, fascia: '1' },
  { name: 'Cannobio', province: 'VB', lat: 46.0588, lng: 8.6917, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 480, population: 5100, fascia: '1' },
  // SONDRIO
  { name: 'Sondrio', province: 'SO', lat: 46.1700, lng: 9.8727, irpefAddizionale: 0.7, distanceKm: 15, avgRentMonthly: 420, population: 21500, fascia: '1A' },
  { name: 'Tirano', province: 'SO', lat: 46.2167, lng: 10.1667, irpefAddizionale: 0.6, distanceKm: 2, avgRentMonthly: 380, population: 9100, fascia: '1' },
  { name: 'Chiavenna', province: 'SO', lat: 46.3217, lng: 9.3997, irpefAddizionale: 0.6, distanceKm: 3, avgRentMonthly: 400, population: 7200, fascia: '1' },
  { name: 'Livigno', province: 'SO', lat: 46.5384, lng: 10.1357, irpefAddizionale: 0.4, distanceKm: 0, avgRentMonthly: 600, population: 6700, fascia: '1' },
];

type ColorMode = 'irpef' | 'distance' | 'rent';

// ─── Component ───────────────────────────────────────────────

const BorderMunicipalitiesMap: React.FC = () => {
  const { t } = useTranslation();
  const [colorMode, setColorMode] = useState<ColorMode>('irpef');
  const [selectedMunicipality, setSelectedMunicipality] = useState<Municipality | null>(null);
  const [filterProvince, setFilterProvince] = useState<string>('all');

  const provinces = useMemo(() => {
    const set = new Set(MUNICIPALITIES.map(m => m.province));
    return ['all', ...Array.from(set).sort()];
  }, []);

  const filtered = useMemo(() => {
    return filterProvince === 'all' ? MUNICIPALITIES : MUNICIPALITIES.filter(m => m.province === filterProvince);
  }, [filterProvince]);

  // Color functions
  const getColor = (m: Municipality): string => {
    switch (colorMode) {
      case 'irpef': {
        if (m.irpefAddizionale <= 0.5) return '#22c55e'; // green
        if (m.irpefAddizionale <= 0.65) return '#eab308'; // yellow
        return '#ef4444'; // red
      }
      case 'distance': {
        if (m.distanceKm <= 5) return '#22c55e';
        if (m.distanceKm <= 15) return '#eab308';
        return '#ef4444';
      }
      case 'rent': {
        if (m.avgRentMonthly <= 500) return '#22c55e';
        if (m.avgRentMonthly <= 650) return '#eab308';
        return '#ef4444';
      }
    }
  };

  const getRadius = (m: Municipality): number => {
    const pop = m.population;
    if (pop > 50000) return 12;
    if (pop > 20000) return 9;
    if (pop > 10000) return 7;
    return 5;
  };

  // Map center: roughly Como/Varese area
  const center: [number, number] = [45.92, 9.00];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-950/30 dark:to-cyan-950/30 rounded-2xl p-6 border border-teal-200 dark:border-teal-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-teal-100 dark:bg-teal-900/50 rounded-xl">
            <MapPin className="w-6 h-6 text-teal-600 dark:text-teal-400" />
          </div>
          <h2 className="text-2xl font-bold text-teal-900 dark:text-teal-100">{t('bordermap.title')}</h2>
        </div>
        <p className="text-teal-700 dark:text-teal-300 text-sm">{t('bordermap.subtitle')}</p>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700 flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-bold text-slate-600 dark:text-slate-300">{t('bordermap.colorBy')}:</span>
        </div>
        {([
          { mode: 'irpef' as const, label: t('bordermap.mode.irpef') },
          { mode: 'distance' as const, label: t('bordermap.mode.distance') },
          { mode: 'rent' as const, label: t('bordermap.mode.rent') },
        ]).map(({ mode, label }) => (
          <button
            key={mode}
            onClick={() => setColorMode(mode)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
              colorMode === mode
                ? 'bg-teal-600 text-white'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
            }`}
          >
            {label}
          </button>
        ))}

        <span className="text-slate-300 dark:text-slate-600">|</span>

        <select
          value={filterProvince}
          onChange={(e) => setFilterProvince(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-0"
        >
          {provinces.map(p => (
            <option key={p} value={p}>{p === 'all' ? t('bordermap.allProvinces') : p}</option>
          ))}
        </select>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500" />
          <span className="text-slate-600 dark:text-slate-400">
            {colorMode === 'irpef' ? '≤ 0.5%' : colorMode === 'distance' ? '≤ 5 km' : '≤ €500'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-yellow-500" />
          <span className="text-slate-600 dark:text-slate-400">
            {colorMode === 'irpef' ? '0.5–0.65%' : colorMode === 'distance' ? '5–15 km' : '€500–650'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <span className="text-slate-600 dark:text-slate-400">
            {colorMode === 'irpef' ? '> 0.65%' : colorMode === 'distance' ? '> 15 km' : '> €650'}
          </span>
        </div>
        <div className="flex items-center gap-1 text-slate-400">
          <Info className="w-3 h-3" />
          {t('bordermap.sizeByPop')}
        </div>
      </div>

      {/* Map */}
      <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 h-[500px]">
        <MapContainer center={center} zoom={10} style={{ height: '100%', width: '100%' }} scrollWheelZoom={true}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* Border crossings as markers */}
          {borderCrossings.map((bc, i) => (
            <CircleMarker
              key={`bc-${i}`}
              center={[bc.lat, bc.lng]}
              radius={4}
              pathOptions={{ color: '#1e40af', fillColor: '#3b82f6', fillOpacity: 0.9, weight: 2 }}
            >
              <Popup>
                <div className="text-xs">
                  <p className="font-bold">{bc.name}</p>
                  <p>{bc.type} — {bc.hours}</p>
                  <p>⏱ AM: {bc.avgWaitMorning}</p>
                </div>
              </Popup>
            </CircleMarker>
          ))}

          {/* Municipalities */}
          {filtered.map((m, i) => (
            <CircleMarker
              key={`m-${i}`}
              center={[m.lat, m.lng]}
              radius={getRadius(m)}
              pathOptions={{ color: getColor(m), fillColor: getColor(m), fillOpacity: 0.6, weight: 2 }}
              eventHandlers={{
                click: () => setSelectedMunicipality(m),
              }}
            >
              <Popup>
                <div className="text-xs space-y-1 min-w-[180px]">
                  <p className="font-black text-sm">{m.name}</p>
                  <p className="text-slate-500">{m.province} — {t('bordermap.fascia')} {m.fascia}</p>
                  <hr />
                  <p>📊 IRPEF add.: <b>{m.irpefAddizionale}%</b></p>
                  <p>📏 {t('bordermap.distCrossing')}: <b>{m.distanceKm} km</b></p>
                  <p>🏠 {t('bordermap.avgRent')}: <b>€{m.avgRentMonthly}/mese</b></p>
                  <p>👥 {t('bordermap.pop')}: <b>{m.population.toLocaleString('it-IT')}</b></p>
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>

      {/* Selected municipality detail card */}
      {selectedMunicipality && (
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-black text-slate-800 dark:text-slate-200">{selectedMunicipality.name}</h3>
            <span className="text-xs px-2 py-1 rounded-full bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 font-bold">
              {t('bordermap.fascia')} {selectedMunicipality.fascia}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-400">{t('bordermap.mode.irpef')}</p>
              <p className="text-xl font-black text-slate-800 dark:text-slate-200">{selectedMunicipality.irpefAddizionale}%</p>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-400">{t('bordermap.distCrossing')}</p>
              <p className="text-xl font-black text-slate-800 dark:text-slate-200">{selectedMunicipality.distanceKm} km</p>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-400">{t('bordermap.avgRent')}</p>
              <p className="text-xl font-black text-slate-800 dark:text-slate-200">€{selectedMunicipality.avgRentMonthly}</p>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-400">{t('bordermap.pop')}</p>
              <p className="text-xl font-black text-slate-800 dark:text-slate-200">{selectedMunicipality.population.toLocaleString('it-IT')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Info box */}
      <div className="bg-amber-50 dark:bg-amber-950/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('bordermap.disclaimer')}</p>
      </div>
    </div>
  );
};

export default BorderMunicipalitiesMap;
