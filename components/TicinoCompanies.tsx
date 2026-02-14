import React, { useState, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Building2, Users, Search, SlidersHorizontal, ArrowUpDown, MapPin, ExternalLink, Filter, ChevronDown, Globe, Briefcase, Map, List } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

interface Company {
  name: string;
  sector: string;
  employees: number;
  city: string;
  coordinates: [number, number];
  website?: string;
  description: string;
  logo?: string;
}

const SECTORS = [
  'Tutti',
  'Finanza & Banking',
  'Tecnologia & IT',
  'Farmaceutico & Chimico',
  'Lusso & Moda',
  'Alimentare',
  'Assicurazioni',
  'Consulenza',
  'Logistica',
  'Energia',
  'Altro',
] as const;

const companies: Company[] = [
  // Finanza
  { name: 'UBS', sector: 'Finanza & Banking', employees: 2500, city: 'Lugano', coordinates: [46.0037, 8.9511], website: 'https://www.ubs.com', description: 'Banca globale, sede regionale Ticino' },
  { name: 'Banca dello Stato del Canton Ticino', sector: 'Finanza & Banking', employees: 850, city: 'Bellinzona', coordinates: [46.1946, 9.0236], website: 'https://www.bancastato.ch', description: 'Banca cantonale ticinese' },
  { name: 'BSI (ora EFG)', sector: 'Finanza & Banking', employees: 600, city: 'Lugano', coordinates: [46.0050, 8.9480], website: 'https://www.efginternational.com', description: 'Private banking e gestione patrimoniale' },
  { name: 'Cornèr Banca', sector: 'Finanza & Banking', employees: 500, city: 'Lugano', coordinates: [46.0020, 8.9530], website: 'https://www.corner.ch', description: 'Banca privata, carte di credito, trading' },
  { name: 'Banca Raiffeisen', sector: 'Finanza & Banking', employees: 400, city: 'Lugano', coordinates: [46.0055, 8.9550], description: 'Banca cooperativa, rete capillare' },

  // Tecnologia
  { name: 'Swiss IT Security', sector: 'Tecnologia & IT', employees: 200, city: 'Manno', coordinates: [46.0340, 8.9210], description: 'Cybersecurity e servizi IT' },
  { name: 'Doodle (parte)', sector: 'Tecnologia & IT', employees: 80, city: 'Lugano', coordinates: [46.0045, 8.9520], website: 'https://doodle.com', description: 'Pianificazione meeting e scheduling' },
  { name: 'Novalung / USI Hub', sector: 'Tecnologia & IT', employees: 150, city: 'Lugano', coordinates: [46.0100, 8.9600], description: 'Startup e innovazione tech USI campus' },
  { name: 'TIO SA', sector: 'Tecnologia & IT', employees: 120, city: 'Muzzano', coordinates: [45.9920, 8.9220], website: 'https://www.tio.ch', description: 'Media digitale, notizie online' },

  // Farmaceutico
  { name: 'Helsinn', sector: 'Farmaceutico & Chimico', employees: 700, city: 'Lugano', coordinates: [46.0180, 8.9480], website: 'https://www.helsinn.com', description: 'Farmaceutica, oncologia e cure palliative' },
  { name: 'Ibsa', sector: 'Farmaceutico & Chimico', employees: 500, city: 'Lugano', coordinates: [46.0150, 8.9420], website: 'https://www.ibsa.ch', description: 'Farmaceutica, dermatologia, endocrinologia' },
  { name: 'Zambon', sector: 'Farmaceutico & Chimico', employees: 200, city: 'Cadempino', coordinates: [46.0380, 8.9350], website: 'https://www.zambon.com', description: 'Farmaceutica, prodotti respiratori' },
  { name: 'Humabs BioMed (Vir)', sector: 'Farmaceutico & Chimico', employees: 150, city: 'Bellinzona', coordinates: [46.1900, 9.0200], description: 'Biotech, anticorpi monoclonali' },

  // Lusso & Moda
  { name: 'VF International (The North Face, Timberland)', sector: 'Lusso & Moda', employees: 1200, city: 'Stabio', coordinates: [45.8520, 8.9350], website: 'https://www.vfc.com', description: 'Abbigliamento sportivo e outdoor, sede EMEA' },
  { name: 'Hugo Boss Ticino', sector: 'Lusso & Moda', employees: 350, city: 'Coldrerio', coordinates: [45.8490, 9.0050], website: 'https://www.hugoboss.com', description: 'Moda di lusso, logistica regionale' },
  { name: 'Guess Europe', sector: 'Lusso & Moda', employees: 300, city: 'Lugano', coordinates: [46.0060, 8.9490], website: 'https://www.guess.eu', description: 'Moda, sede europea' },

  // Alimentare
  { name: 'Rapelli', sector: 'Alimentare', employees: 400, city: 'Stabio', coordinates: [45.8540, 8.9310], website: 'https://www.rapelli.ch', description: 'Salumi e prodotti carnei svizzeri' },
  { name: 'Mikron Group', sector: 'Altro', employees: 300, city: 'Agno', coordinates: [45.9950, 8.9010], website: 'https://www.mikron.com', description: 'Automazione industriale e precision manufacturing' },

  // Assicurazioni
  { name: 'Generali Svizzera', sector: 'Assicurazioni', employees: 350, city: 'Lugano', coordinates: [46.0030, 8.9560], website: 'https://www.generali.ch', description: 'Assicurazioni vita e danni' },

  // Logistica
  { name: 'Planzer', sector: 'Logistica', employees: 250, city: 'Cadenazzo', coordinates: [46.1500, 8.9480], website: 'https://www.planzer.ch', description: 'Trasporti e logistica' },
  { name: 'Posta Svizzera Centro Regionale', sector: 'Logistica', employees: 600, city: 'Cadenazzo', coordinates: [46.1520, 8.9500], description: 'Centro pacchi e logistica' },

  // Consulenza
  { name: 'Deloitte Ticino', sector: 'Consulenza', employees: 150, city: 'Lugano', coordinates: [46.0070, 8.9530], website: 'https://www.deloitte.ch', description: 'Audit, consulenza, tax' },
  { name: 'KPMG Lugano', sector: 'Consulenza', employees: 100, city: 'Lugano', coordinates: [46.0040, 8.9570], website: 'https://www.kpmg.ch', description: 'Revisione e consulenza aziendale' },
];

const SECTOR_COLORS: Record<string, string> = {
  'Finanza & Banking': '#2563eb',
  'Tecnologia & IT': '#7c3aed',
  'Farmaceutico & Chimico': '#059669',
  'Lusso & Moda': '#dc2626',
  'Alimentare': '#d97706',
  'Assicurazioni': '#0891b2',
  'Consulenza': '#4f46e5',
  'Logistica': '#64748b',
  'Energia': '#16a34a',
  'Altro': '#6b7280',
};

const SECTOR_ICONS: Record<string, string> = {
  'Finanza & Banking': '🏦',
  'Tecnologia & IT': '💻',
  'Farmaceutico & Chimico': '💊',
  'Lusso & Moda': '👜',
  'Alimentare': '🍕',
  'Assicurazioni': '🛡️',
  'Consulenza': '📊',
  'Logistica': '📦',
  'Energia': '⚡',
  'Altro': '🏭',
};

const createCompanyIcon = (sector: string, employees: number) => {
  const color = SECTOR_COLORS[sector] || '#6b7280';
  const icon = SECTOR_ICONS[sector] || '🏢';
  const size = employees > 1000 ? 44 : employees > 500 ? 38 : employees > 200 ? 32 : 28;
  return L.divIcon({
    className: 'company-marker',
    html: `
      <div style="
        width: ${size}px; height: ${size}px;
        background: ${color};
        border: 3px solid white;
        border-radius: 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 0 2px ${color}30;
        display: flex; align-items: center; justify-content: center;
        font-size: ${size > 36 ? 18 : 14}px;
        font-family: system-ui;
      ">${icon}</div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2 - 4],
  });
};

type SortKey = 'employees' | 'name' | 'city';

const TicinoCompanies: React.FC = () => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSector, setSelectedSector] = useState('Tutti');
  const [sortBy, setSortBy] = useState<SortKey>('employees');
  const [sortDesc, setSortDesc] = useState(true);
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
  const [minEmployees, setMinEmployees] = useState(0);

  const filtered = useMemo(() => {
    let result = companies.filter(c => {
      const matchSearch = !searchQuery || 
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.city.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.sector.toLowerCase().includes(searchQuery.toLowerCase());
      const matchSector = selectedSector === 'Tutti' || c.sector === selectedSector;
      const matchEmployees = c.employees >= minEmployees;
      return matchSearch && matchSector && matchEmployees;
    });

    result.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'employees') cmp = a.employees - b.employees;
      else if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'city') cmp = a.city.localeCompare(b.city);
      return sortDesc ? -cmp : cmp;
    });

    return result;
  }, [searchQuery, selectedSector, sortBy, sortDesc, minEmployees]);

  const totalEmployees = useMemo(() => filtered.reduce((sum, c) => sum + c.employees, 0), [filtered]);
  const mapCenter: [number, number] = [46.02, 8.96];

  return (
    <div className="space-y-6 animate-fade-in">
      <style>{`
        .company-marker { background: none !important; border: none !important; }
      `}</style>

      {/* Header */}
      <div className="bg-gradient-to-br from-violet-600 via-purple-600 to-fuchsia-600 rounded-3xl p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-sm">
            <Building2 size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold">{t('companies.title') || 'Aziende in Ticino'}</h1>
            <p className="text-purple-100 mt-1">{t('companies.subtitle') || 'Mappa interattiva delle principali società con filtri per settore e dimensione'}</p>
          </div>
        </div>
        <div className="flex gap-4 mt-4">
          <div className="bg-white/20 backdrop-blur-sm rounded-xl px-4 py-2">
            <div className="text-purple-100 text-xs font-bold uppercase">{t('companies.totalCompanies') || 'Aziende'}</div>
            <div className="text-2xl font-extrabold">{filtered.length}</div>
          </div>
          <div className="bg-white/20 backdrop-blur-sm rounded-xl px-4 py-2">
            <div className="text-purple-100 text-xs font-bold uppercase">{t('companies.totalEmployees') || 'Dipendenti'}</div>
            <div className="text-2xl font-extrabold">{totalEmployees.toLocaleString('it-IT')}</div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('companies.search') || 'Cerca azienda, città, settore...'}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>

          {/* Sector filter */}
          <div className="relative">
            <select
              value={selectedSector}
              onChange={(e) => setSelectedSector(e.target.value)}
              className="appearance-none pl-3 pr-8 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-violet-500 cursor-pointer"
            >
              {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>

          {/* View toggle */}
          <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
            <button onClick={() => setViewMode('map')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'map' ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300'}`}>
              <Map size={14} /> {t('traffic.mapView') || 'Mappa'}
            </button>
            <button onClick={() => setViewMode('list')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'list' ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300'}`}>
              <List size={14} /> {t('traffic.listView') || 'Lista'}
            </button>
          </div>
        </div>

        {/* Employee filter + sort */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <Users size={14} className="text-slate-500" />
            <span className="text-slate-600 dark:text-slate-400 font-medium">Min. dipendenti:</span>
            <input type="range" min={0} max={1000} step={50} value={minEmployees}
              onChange={(e) => setMinEmployees(Number(e.target.value))}
              className="w-32 accent-violet-600" />
            <span className="font-bold text-violet-600 w-10">{minEmployees}</span>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <ArrowUpDown size={14} className="text-slate-500" />
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="appearance-none px-3 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium focus:outline-none">
              <option value="employees">Dipendenti</option>
              <option value="name">Nome</option>
              <option value="city">Città</option>
            </select>
            <button onClick={() => setSortDesc(!sortDesc)} className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
              {sortDesc ? '↓' : '↑'}
            </button>
          </div>
        </div>
      </div>

      {/* MAP VIEW */}
      {viewMode === 'map' && (
        <div className="rounded-2xl overflow-hidden border-2 border-slate-200 dark:border-slate-700 shadow-lg">
          <MapContainer center={mapCenter} zoom={10} style={{ height: '550px', width: '100%' }} scrollWheelZoom={true}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {filtered.map((company) => (
              <Marker key={company.name} position={company.coordinates} icon={createCompanyIcon(company.sector, company.employees)}>
                <Popup maxWidth={300}>
                  <div style={{ padding: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <span style={{ fontSize: '24px' }}>{SECTOR_ICONS[company.sector] || '🏢'}</span>
                      <div>
                        <h3 style={{ fontWeight: 800, fontSize: '16px', margin: 0, color: '#1e293b' }}>{company.name}</h3>
                        <span style={{ fontSize: '12px', color: SECTOR_COLORS[company.sector], fontWeight: 600 }}>{company.sector}</span>
                      </div>
                    </div>
                    <p style={{ fontSize: '13px', color: '#475569', margin: '0 0 8px' }}>{company.description}</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#94a3b8' }}>Dipendenti</span>
                        <span style={{ fontWeight: 700 }}>{company.employees.toLocaleString('it-IT')}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#94a3b8' }}>Città</span>
                        <span style={{ fontWeight: 700 }}>{company.city}</span>
                      </div>
                    </div>
                    {company.website && (
                      <a href={company.website} target="_blank" rel="noopener noreferrer"
                        style={{ marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', width: '100%', padding: '8px', backgroundColor: '#7c3aed', color: 'white', borderRadius: '8px', fontSize: '13px', fontWeight: 700, textDecoration: 'none' }}>
                        Visita sito web
                      </a>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>

          {/* Legend */}
          <div className="flex items-center justify-center gap-3 py-3 bg-white dark:bg-slate-800 text-xs text-slate-500 flex-wrap px-4">
            {Object.entries(SECTOR_ICONS).slice(0, 6).map(([sector, icon]) => (
              <button key={sector} onClick={() => setSelectedSector(sector === selectedSector ? 'Tutti' : sector)}
                className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${selectedSector === sector ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 font-bold' : 'hover:bg-slate-100 dark:hover:bg-slate-700'}`}>
                <span>{icon}</span> {sector.split(' ')[0]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* LIST VIEW */}
      {viewMode === 'list' && (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((company) => (
            <div key={company.name} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 hover:shadow-md transition-all">
              <div className="flex items-start gap-3 mb-3">
                <div className="text-2xl">{SECTOR_ICONS[company.sector] || '🏢'}</div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-slate-800 dark:text-slate-100 truncate">{company.name}</h3>
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: `${SECTOR_COLORS[company.sector]}15`, color: SECTOR_COLORS[company.sector] }}>
                    {company.sector}
                  </span>
                </div>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">{company.description}</p>
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-400">
                  <Users size={14} />
                  <span className="font-bold">{company.employees.toLocaleString('it-IT')}</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-500">
                  <MapPin size={14} />
                  <span>{company.city}</span>
                </div>
              </div>
              {company.website && (
                <a href={company.website} target="_blank" rel="noopener noreferrer"
                  className="mt-3 flex items-center justify-center gap-1.5 w-full py-2 bg-violet-600 text-white rounded-lg text-xs font-bold hover:bg-violet-700 transition-colors no-underline">
                  <Globe size={12} />
                  Visita sito web
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="text-center py-12 text-slate-500">
          <Building2 size={48} className="mx-auto mb-3 opacity-50" />
          <p className="font-bold">Nessuna azienda trovata</p>
          <p className="text-sm">Prova a modificare i filtri di ricerca</p>
        </div>
      )}
    </div>
  );
};

export default TicinoCompanies;
