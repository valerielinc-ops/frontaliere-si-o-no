import React, { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { useTranslation } from '../../services/i18n';
import { requestSlot, releaseSlot, isActive, subscribe, POPUP_PRIORITY } from '@/services/popupQueue';
import NaspiCalculator from '@/components/calculator/NaspiCalculator';
// Leaflet/react-leaflet are lazy-loaded only when needed (municipalities/border tabs)
let L: typeof import('leaflet') | null = null;
let leafletCssLoaded = false;

const LazyLeafletMap = ({ children }: { children: (leaflet: { MapContainer: any, TileLayer: any, Marker: any, Popup: any, L: any }) => React.ReactNode }) => {
  const [leaflet, setLeaflet] = React.useState<any>(null);
  useEffect(() => {
    let mounted = true;
    Promise.all([
      import('react-leaflet'),
      import('leaflet'),
      import('leaflet/dist/leaflet.css'),
    ]).then(([rl, leafletLib]) => {
      if (mounted) {
        L = leafletLib;
        // Fix marker icons only once
        if (L && L.Icon && L.Icon.Default && !(L.Icon.Default as any)._patched) {
          delete (L.Icon.Default.prototype as any)._getIconUrl;
          L.Icon.Default.mergeOptions({
            iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
            iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
          });
          (L.Icon.Default as any)._patched = true;
        }
        setLeaflet({
          MapContainer: rl.MapContainer,
          TileLayer: rl.TileLayer,
          Marker: rl.Marker,
          Popup: rl.Popup,
          L,
        });
      }
    });
    return () => { mounted = false; };
  }, []);
  if (!leaflet) return <div className="flex items-center justify-center h-[500px]"><span className="text-muted text-sm">Loading map…</span></div>;
  return <>{children(leaflet)}</>;
};
import { MapPin, Clock, TrendingUp, Home, Car, ShoppingCart, FileText, AlertCircle, CheckCircle2, Info, ArrowRight, Building2, Landmark, Shield, Users, Navigation, Timer, BarChart3, Euro, Heart, Briefcase, Calendar, Mountain, GraduationCap, Baby, BookOpen, LifeBuoy, Search, Filter, Star, ExternalLink, Rocket, X, SmilePlus, Backpack } from 'lucide-react';
import { Analytics } from '../../services/analytics';

const TaxCalendar = lazy(() => import('@/components/fisco/TaxCalendar'));
const WorkPermitsGuide = lazy(() => import('./WorkPermitsGuide'));
const TicinoCompanies = lazy(() => import('@/components/vita/TicinoCompanies'));
const FirstDayGuide = lazy(() => import('./FirstDayGuide'));
const CarTransferGuide = lazy(() => import('./CarTransferGuide'));
const WeeklyQuiz = lazy(() => import('@/components/fisco/WeeklyQuiz'));
const Glossary = lazy(() => import('@/components/pages/Glossary'));
const FaqSection = lazy(() => import('@/components/pages/FaqSection'));


import { borderCrossings as centralizedBorderCrossings } from '../../data/borderCrossings';
import { MUNICIPALITIES as BORDER_MUNICIPALITIES } from '@/data/municipalities';

// Province code → full name mapping
const PROVINCE_NAMES: Record<string, string> = {
  CO: 'Como', VA: 'Varese', VB: 'Verbania', SO: 'Sondrio', LC: 'Lecco',
  AO: 'Aosta', VC: 'Vercelli', MB: 'Monza-Brianza', BG: 'Bergamo',
  BS: 'Brescia', TN: 'Trento', BZ: 'Bolzano',
};

// Determine nearest border crossing based on province and coordinates
function getBorderCrossing(province: string, lat: number, lng: number, name: string): string {
  if (name === "Campione d'Italia") return 'Campione (enclave)';
  switch (province) {
    case 'CO':
      if (lat > 46.0 && lng < 9.15) return 'Gandria';
      return 'Chiasso';
    case 'VA':
      if (name === 'Porto Ceresio' || name === 'Brusimpiano') return 'Porto Ceresio';
      if (name === 'Lavena Ponte Tresa') return 'Ponte Tresa';
      if (lat > 45.97) return 'Zenna';
      if (lat > 45.92 && lng < 8.85) return 'Ponte Tresa';
      return 'Gaggiolo';
    case 'VB':
      if (lng > 8.65) return 'Brissago';
      return 'Sempione';
    case 'SO':
      if (name === 'Livigno') return 'Livigno';
      if (name === 'Madesimo' || name === 'Campodolcino') return 'Spluga';
      if (lng > 9.8) return 'Campocologno';
      return 'Castasegna';
    case 'LC':
      return 'Chiasso (via CO)';
    case 'AO':
      if (lat > 45.85) return 'Gran San Bernardo';
      return 'Piccolo San Bernardo';
    case 'VC':
      return 'Sempione (via VB)';
    case 'MB':
      return 'Chiasso (via CO)';
    case 'BG':
      return 'Castasegna (via SO)';
    case 'BS':
      return 'Stelvio';
    case 'TN':
      return 'Stelvio';
    case 'BZ':
      if (name === 'Stelvio' || name === 'Prato Allo Stelvio') return 'Stelvio';
      return 'Resia / Brennero';
    default:
      return 'Chiasso';
  }
}

// Determine new/old agreement type based on distance from Swiss border
function getAgreementType(distanceKm: number): 'new' | 'old' | 'both' {
  return distanceKm <= 20 ? 'both' : 'old';
}


// Custom marker icons per tipo (must be inside LazyLeafletMap)
const createCustomIcon = (L: any, type: 'new' | 'old' | 'both') => {
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
    blue: "from-teal-500 to-emerald-600 border-teal-200 dark:border-teal-800",
    green: "from-emerald-500 to-teal-600 border-emerald-200 dark:border-emerald-800",
    purple: "from-emerald-500 to-amber-600 border-emerald-200 dark:border-emerald-800",
    orange: "from-orange-500 to-red-600 border-orange-200 dark:border-orange-800",
    teal: "from-teal-500 to-teal-600 border-teal-200 dark:border-teal-800"
  };

  return (
    <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-6 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-center gap-3 mb-4">
        <div className={`p-2.5 bg-gradient-to-br ${colorClasses[color as keyof typeof colorClasses]} rounded-xl`}>
          <Icon className="text-white" size={20} />
        </div>
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{title}</h3>
      </div>
      <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
        {children}
      </div>
    </div>
  );
};

const SectionHeader = ({ icon: Icon, title, subtitle }: any) => (
  <div className="flex items-center gap-4 mb-6">
    <div className="p-3 bg-gradient-to-br from-teal-500 to-warm-500 rounded-2xl shadow-lg">
      <Icon className="text-white" size={28} />
    </div>
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-800 dark:text-slate-100">{title}</h2>
      {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
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
  irpefAddizionale: number;
  fascia: '1' | '1A' | '2';
  avgRentMonthly: number;
}

interface FrontierGuideProps {
  activeSection?: string;
}

type GuideSection = 'municipalities' | 'living-ch' | 'living-it' | 'border' | 'calendar' | 'holidays' | 'permits' | 'companies' | 'places' | 'schools' | 'unemployment' | 'first-day' | 'car-transfer' | 'quiz';

interface MunicipalityDetailPanelProps {
  municipality: Municipality;
  t: (key: string) => string;
  onClose: () => void;
}

// ══════════ SCHOOL DIRECTORY DATA ══════════
const SCHOOL_TYPE_ORDER = ['nido', 'infanzia', 'elementare', 'media', 'superiore'];
interface SchoolEntry {
  name: string;
  type: 'nido' | 'infanzia' | 'elementare' | 'media' | 'superiore';
  city: string;
  address?: string;
  website?: string;
  phone?: string;
  nature: 'pubblica' | 'privata' | 'paritaria';
  rating?: number; // 1-5
  notes?: string;
}



const SCHOOL_TYPE_CONFIG: Record<SchoolEntry['type'], { label: string; Icon: React.ComponentType<{ size?: number; className?: string }>; color: string }> = {
  nido: { label: 'Nido (0-3)', Icon: Baby, color: 'purple' },
  infanzia: { label: 'Infanzia (3-6)', Icon: SmilePlus, color: 'emerald' },
  elementare: { label: 'Elementare (6-11)', Icon: BookOpen, color: 'blue' },
  media: { label: 'Media (11-15)', Icon: Backpack, color: 'amber' },
  superiore: { label: 'Superiore (15-19)', Icon: GraduationCap, color: 'teal' },
};

const SchoolDirectory: React.FC<{ t: (key: string) => string }> = ({ t }) => {
  const [schoolSearch, setSchoolSearch] = useState('');
  const [schoolTypeFilter, setSchoolTypeFilter] = useState<import('@/components/vita/TicinoSchoolsData').SchoolEntry['type'] | 'all'>('all');
  const [schoolNatureFilter, setSchoolNatureFilter] = useState<'all' | 'pubblica' | 'privata'>('all');
  const [schools, setSchools] = useState<import('@/components/vita/TicinoSchoolsData').SchoolEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    import('@/components/vita/TicinoSchoolsData').then(mod => {
      if (mounted) {
        setSchools(mod.TICINO_SCHOOLS);
        setLoading(false);
      }
    });
    return () => { mounted = false; };
  }, []);

  const filteredSchools = useMemo(() => (schools || []).filter(s => {
    const matchSearch = !schoolSearch ||
      s.name.toLowerCase().includes(schoolSearch.toLowerCase()) ||
      s.city.toLowerCase().includes(schoolSearch.toLowerCase());
    const matchType = schoolTypeFilter === 'all' || s.type === schoolTypeFilter;
    const matchNature = schoolNatureFilter === 'all' || s.nature === schoolNatureFilter;
    return matchSearch && matchType && matchNature;
  }), [schools, schoolSearch, schoolTypeFilter, schoolNatureFilter]);

  const groupedByType = useMemo(() => filteredSchools.reduce((acc, s) => {
    if (!acc[s.type]) acc[s.type] = [];
    acc[s.type].push(s);
    return acc;
  }, {} as Record<string, import('@/components/vita/TicinoSchoolsData').SchoolEntry[]>), [filteredSchools]);

  return (
    <div className="bg-surface rounded-2xl border-2 border-indigo-200 dark:border-indigo-800 overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-teal-600 via-emerald-500 to-warm-600 p-5 text-white">
        <div className="flex items-center gap-3">
          <BookOpen size={24} />
          <div>
            <h3 className="text-lg font-bold">{t('guide.schools.directoryTitle') || 'Elenco Scuole del Ticino'}</h3>
            <p className="text-teal-100 text-xs">{filteredSchools.length} {t('guide.schools.schoolsFound') || 'scuole trovate'}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="p-4 border-b border-edge space-y-3">
        {/* Search */}
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={schoolSearch}
            onChange={(e) => setSchoolSearch(e.target.value)}
            placeholder={t('guide.schools.searchPlaceholder') || 'Cerca per nome o città...'}
            aria-label={t('guide.schools.searchPlaceholder') || 'Cerca per nome o città...'}
            className="w-full pl-10 pr-4 py-2 bg-surface-alt border border-edge rounded-lg text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          />
        </div>

        {/* Type filter pills */}
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSchoolTypeFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${schoolTypeFilter === 'all' ? 'bg-indigo-600 text-white' : 'bg-surface-raised text-slate-600 dark:text-slate-300'}`}
          >
            {t('calendar.all') || 'Tutte'}
          </button>
          {(Object.entries(SCHOOL_TYPE_CONFIG) as [SchoolEntry['type'], typeof SCHOOL_TYPE_CONFIG[SchoolEntry['type']]][]).map(([key, cfg]) => (
            <button
              key={key}
              onClick={() => setSchoolTypeFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${schoolTypeFilter === key ? 'bg-indigo-600 text-white' : 'bg-surface-raised text-slate-600 dark:text-slate-300'}`}
            >
              <cfg.Icon size={14} className="shrink-0" /> {cfg.label}
            </button>
          ))}
        </div>

        {/* Nature filter */}
        <div className="flex gap-1.5">
          {(['all', 'pubblica', 'privata'] as const).map(n => (
            <button
              key={n}
              onClick={() => setSchoolNatureFilter(n)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${schoolNatureFilter === n ? 'bg-slate-800 dark:bg-slate-100 text-white dark:text-slate-900' : 'bg-surface-raised text-slate-600 dark:text-slate-300'}`}
            >
              {n === 'all' ? (t('calendar.all') || 'Tutte') : n === 'pubblica' ? '🏛️ Pubblica' : '🏫 Privata'}
            </button>
          ))}
        </div>
      </div>

      {/* School list grouped by type */}
      <div className="p-4 space-y-4 max-h-[600px] overflow-y-auto">
        {(Object.entries(groupedByType) as [string, import('@/components/vita/TicinoSchoolsData').SchoolEntry[]][])
          .sort(([a], [b]) => {
            return SCHOOL_TYPE_ORDER.indexOf(a) - SCHOOL_TYPE_ORDER.indexOf(b);
          })
          .map(([type, schools]) => {
            const cfg = SCHOOL_TYPE_CONFIG[type as SchoolEntry['type']];
            return (
              <div key={type}>
                <div className="flex items-center gap-2 mb-2">
                  <cfg.Icon size={18} className="text-slate-600 dark:text-slate-300" />
                  <h4 className="font-bold text-sm text-body">{cfg.label}</h4>
                  <span className="text-xs font-bold bg-slate-200 dark:bg-slate-700 text-body px-2 py-0.5 rounded-full">{schools.length}</span>
                </div>
                <div className="space-y-1.5">
                  {schools.map((school, i) => (
                    <div key={i} className="bg-surface-alt rounded-xl p-3 border border-edge hover:shadow-sm transition-[color,background-color,border-color,box-shadow]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h5 className="font-bold text-sm text-slate-800 dark:text-slate-100">{school.name}</h5>
                            <span className={`px-1.5 py-0.5 rounded text-xs font-bold uppercase ${school.nature === 'pubblica' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' : 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'}`}>
                              {school.nature}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                            <span className="flex items-center gap-1"><MapPin size={11} /> {school.city}</span>
                            {school.address && <span className="hidden sm:inline">{school.address}</span>}
                            {school.phone && <span className="flex items-center gap-1">📞 {school.phone}</span>}
                          </div>
                          {school.notes && (
                            <p className="text-xs text-indigo-600 dark:text-indigo-400 mt-1 font-medium">💡 {school.notes}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {school.rating && (
                            <div className="flex items-center gap-0.5">
                              {Array.from({ length: 5 }).map((_, si) => (
                                <Star key={si} size={10} className={si < school.rating! ? 'text-amber-400 fill-amber-400' : 'text-slate-300 dark:text-slate-600'} />
                              ))}
                            </div>
                          )}
                          {school.website && (
                            <a href={school.website} target="_blank" rel="noopener noreferrer" className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-200 dark:hover:bg-indigo-800/30 transition-colors" aria-label={`${school.name} website`}>
                              <ExternalLink size={12} />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

        {filteredSchools.length === 0 && (
          <div className="text-center py-8 text-muted">
            <GraduationCap size={32} className="mx-auto mb-2 opacity-30" />
            <p className="text-xs font-medium">{t('guide.schools.noSchoolsFound') || 'Nessuna scuola trovata con i filtri selezionati'}</p>
          </div>
        )}
      </div>
    </div>
  );
};

const MunicipalityDetailPanel: React.FC<MunicipalityDetailPanelProps> = ({ municipality, t, onClose }) => (
  <div className="bg-surface rounded-2xl border-2 border-indigo-500 dark:border-indigo-400 p-5 sm:p-6 shadow-lg animate-fade-in">
    <div className="flex items-start justify-between gap-4 mb-5">
      <div>
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{municipality.name}</h3>
        <p className="text-sm text-muted mt-0.5">
          {municipality.province} · {
            municipality.type === 'both'
              ? `${t('guide.new')} + ${t('guide.old')}`
              : municipality.type === 'new' ? t('guide.new') : t('guide.old')
          }
        </p>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-muted flex-shrink-0"
        aria-label={t('guide.municipalities.detail.close')}
      >
        <X size={20} />
      </button>
    </div>

    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
      <div className="bg-warm-50 dark:bg-warm-950 rounded-xl p-3">
        <p className="text-sm text-muted mb-1">{t('guide.municipalities.detail.fascia')}</p>
        <p className="font-bold text-slate-800 dark:text-slate-100">Fascia {municipality.fascia}</p>
      </div>
      <div className="bg-warm-50 dark:bg-warm-950 rounded-xl p-3">
        <p className="text-sm text-muted mb-1">{t('guide.municipalities.detail.irpef')}</p>
        <p className="font-bold text-slate-800 dark:text-slate-100">{municipality.irpefAddizionale}%</p>
      </div>
      <div className="bg-surface-alt/50 rounded-xl p-3">
        <p className="text-sm text-muted mb-1">{t('guide.municipalities.detail.avgRent')}</p>
        <p className="font-bold text-slate-800 dark:text-slate-100">€{municipality.avgRentMonthly}/{t('guide.municipalities.detail.perMonth')}</p>
      </div>
      <div className="bg-surface-alt/50 rounded-xl p-3">
        <p className="text-sm text-muted mb-1">{t('guide.municipalities.detail.distance')}</p>
        <p className="font-bold text-slate-800 dark:text-slate-100">{municipality.distance} km</p>
      </div>
      <div className="bg-surface-alt/50 rounded-xl p-3">
        <p className="text-sm text-muted mb-1">{t('guide.municipalities.detail.borderCrossing')}</p>
        <p className="font-bold text-slate-800 dark:text-slate-100 text-sm">{municipality.borderCrossing}</p>
      </div>
      <div className="bg-surface-alt/50 rounded-xl p-3">
        <p className="text-sm text-muted mb-1">{t('guide.municipalities.detail.population')}</p>
        <p className="font-bold text-slate-800 dark:text-slate-100">{municipality.population.toLocaleString('it-IT')}</p>
      </div>
    </div>

    <div className="flex flex-col sm:flex-row gap-3 mb-5">
      <button
        onClick={() => {
          Analytics.trackUIInteraction('guida', 'municipalities', 'cta_calculator', 'click', municipality.name);
          window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'calculator' } }));
        }}
        className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-4 rounded-xl transition-colors"
      >
        <Euro size={16} />
        {t('guide.municipalities.detail.ctaCalculator')}
      </button>
      <button
        onClick={() => {
          Analytics.trackUIInteraction('guida', 'municipalities', 'cta_compare', 'click', municipality.name);
          window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'guida', subTab: 'border' } }));
        }}
        className="flex-1 flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 text-white font-bold py-3 px-4 rounded-xl transition-colors"
      >
        <BarChart3 size={16} />
        {t('guide.municipalities.detail.ctaCompare')}
      </button>
      <button
        onClick={() => {
          Analytics.trackUIInteraction('guida', 'municipalities', 'cta_jobs', 'click', municipality.name);
          window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'job-board' } }));
        }}
        className="flex-1 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 px-4 rounded-xl transition-colors"
      >
        <Briefcase size={16} />
        {t('guide.municipalities.detail.ctaJobs')}
      </button>
    </div>

    <div className="border-t border-edge pt-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">{t('guide.municipalities.detail.links')}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <button
          onClick={() => { Analytics.trackUIInteraction('guida', 'municipalities', 'editorial_link', 'click', 'fisco'); window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'fisco' } })); }}
          className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
        >
          <ArrowRight size={12} />{t('guide.municipalities.detail.linkFiscal')}
        </button>
        <button
          onClick={() => { Analytics.trackUIInteraction('guida', 'municipalities', 'editorial_link', 'click', 'border'); window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'guida', subTab: 'border' } })); }}
          className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
        >
          <ArrowRight size={12} />{t('guide.municipalities.detail.linkBorder')}
        </button>
        <button
          onClick={() => { Analytics.trackUIInteraction('guida', 'municipalities', 'editorial_link', 'click', 'living-ch'); window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'vita', subTab: 'living-ch' } })); }}
          className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
        >
          <ArrowRight size={12} />{t('guide.municipalities.detail.linkLiving')}
        </button>
      </div>
    </div>
  </div>
);

const FrontierGuide: React.FC<FrontierGuideProps> = ({ activeSection: externalSection }) => {
  const { t } = useTranslation();
  const [internalSection, setInternalSection] = useState<GuideSection>((externalSection as GuideSection) || 'municipalities');

  // Sync with external section from router
  useEffect(() => {
    if (externalSection && externalSection !== internalSection) {
      setInternalSection(externalSection as GuideSection);
    }
  }, [externalSection]);

  const activeSection = internalSection;

  // Guide welcome banner — shown once, auto-dismissed after 15s
  const BANNER_KEY = 'frontaliere_guide_banner_dismissed';
  const [showBanner, setShowBanner] = useState(() => {
    try { return localStorage.getItem(BANNER_KEY) !== 'true'; } catch { return true; }
  });
  const [bannerVisible, setBannerVisible] = useState(false);
  const [bannerQueueActive, setBannerQueueActive] = useState(false);

  useEffect(() => {
    if (!showBanner) return;
    // Request popup queue slot
    requestSlot('guide-banner', POPUP_PRIORITY.GUIDE_BANNER);
    const unsub = subscribe(() => setBannerQueueActive(isActive('guide-banner')));
    setBannerQueueActive(isActive('guide-banner'));
    return () => { unsub(); };
  }, [showBanner]);

  // Only start slide-in + auto-dismiss when queue gives us the slot
  useEffect(() => {
    if (!showBanner || !bannerQueueActive) return;
    const showTimer = setTimeout(() => setBannerVisible(true), 500);
    const hideTimer = setTimeout(() => {
      setBannerVisible(false);
      setTimeout(() => {
        setShowBanner(false);
        releaseSlot('guide-banner');
        try { localStorage.setItem(BANNER_KEY, 'true'); } catch {}
      }, 500);
    }, 15000);
    return () => { clearTimeout(showTimer); clearTimeout(hideTimer); };
  }, [showBanner, bannerQueueActive]);

  const dismissBanner = () => {
    setBannerVisible(false);
    setTimeout(() => {
      setShowBanner(false);
      releaseSlot('guide-banner');
      try { localStorage.setItem(BANNER_KEY, 'true'); } catch {}
    }, 500);
  };

  const [sortBy, setSortBy] = useState<'distance' | 'population'>('population');
  const [filterType, setFilterType] = useState<'all' | 'new' | 'old'>('all');
  const [filterProvince, setFilterProvince] = useState<string>('all');
  const [borderFilter, setBorderFilter] = useState<'all' | 'low-traffic' | '24h' | 'morning' | 'evening'>('all');
  const [selectedTime, setSelectedTime] = useState<'morning' | 'evening' | 'night'>('morning');
  const [selectedMunicipality, setSelectedMunicipality] = useState<Municipality | null>(null);

  // Track municipality view + open/close detail panel
  const handleMunicipalityClick = (municipality: Municipality) => {
    const opening = selectedMunicipality?.name !== municipality.name;
    setSelectedMunicipality(opening ? municipality : null);
    Analytics.trackMunicipalityView(municipality.name, municipality.type);
    if (opening) {
      Analytics.trackUIInteraction('guida', 'municipalities', 'card', 'detail_opened', municipality.name);
    }
  };

  // Track map marker click
  const handleMapMarkerClick = (location: string, type: string) => {
    Analytics.trackMapInteraction(type === 'border' ? 'Border Crossings' : 'Municipalities', 'Click Marker', location);
  };

  // Comuni frontalieri — lista completa da data/municipalities.ts (115 comuni, 5 province)
  const lombardyMunicipalities: Municipality[] = useMemo(() => BORDER_MUNICIPALITIES.map(m => ({
    name: m.name,
    province: PROVINCE_NAMES[m.province] || m.province,
    distance: m.distanceKm,
    borderCrossing: getBorderCrossing(m.province, m.lat, m.lng, m.name),
    population: m.population,
    type: getAgreementType(m.distanceKm),
    lat: m.lat,
    lng: m.lng,
    irpefAddizionale: m.irpefAddizionale,
    fascia: m.fascia,
    avgRentMonthly: m.avgRentMonthly,
  })), []);

  const filteredMunicipalities = useMemo(() => lombardyMunicipalities
    .filter(m => {
      if (filterProvince !== 'all' && m.province !== PROVINCE_NAMES[filterProvince]) return false;
      if (filterType === 'all') return true;
      if (filterType === 'new') return m.type === 'new' || m.type === 'both';
      if (filterType === 'old') return m.type === 'old' || m.type === 'both';
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'distance') return a.distance - b.distance;
      return b.population - a.population;
    }), [lombardyMunicipalities, filterProvince, filterType, sortBy]);
  const selectedMunicipalityIndex = selectedMunicipality
    ? filteredMunicipalities.findIndex((m) => m.name === selectedMunicipality.name)
    : -1;
  const desktopDetailInsertIndex = selectedMunicipalityIndex >= 0
    ? Math.min(
        selectedMunicipalityIndex % 2 === 0 ? selectedMunicipalityIndex + 1 : selectedMunicipalityIndex,
        filteredMunicipalities.length - 1,
      )
    : -1;

  // Dogane Canton Ticino - Italia (fonte centralizzata: data/borderCrossings.ts)
  const borderCrossings = useMemo(() => centralizedBorderCrossings.map(c => ({
    name: c.name,
    italianSide: c.italianSide,
    avgWaitMorning: c.avgWaitMorning,
    avgWaitEvening: c.avgWaitEvening,
    peak: c.peak,
    hours: c.hours,
    tips: c.tips,
    lat: c.lat,
    lng: c.lng,
    traffic: c.trafficLevel,
  })), []);

  const filteredBorderCrossings = useMemo(() =>
    borderCrossings
      .filter(border => {
        if (border.traffic === 'closed') return false;
        if (borderFilter === 'low-traffic') return border.traffic === 'low';
        if (borderFilter === '24h') return border.hours === '24h';
        if (borderFilter === 'morning') {
          const maxWait = parseInt(border.avgWaitMorning.split('-')[1]);
          return !isNaN(maxWait) && maxWait <= 10;
        }
        if (borderFilter === 'evening') {
          const maxWait = parseInt(border.avgWaitEvening.split('-')[1]);
          return !isNaN(maxWait) && maxWait <= 12;
        }
        return true;
      })
      .sort((a, b) => {
        if (selectedTime === 'morning') {
          const aWait = parseInt(a.avgWaitMorning.split('-')[0]) || 999;
          const bWait = parseInt(b.avgWaitMorning.split('-')[0]) || 999;
          return aWait - bWait;
        } else if (selectedTime === 'evening') {
          const aWait = parseInt(a.avgWaitEvening.split('-')[0]) || 999;
          const bWait = parseInt(b.avgWaitEvening.split('-')[0]) || 999;
          return aWait - bWait;
        }
        return 0;
      }),
    [borderCrossings, borderFilter, selectedTime]
  );

  return (
    <div className="space-y-8 pb-12">
      {/* Content Sections */}
      {activeSection === 'municipalities' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={MapPin} 
            title={t('guide.municipalities.title')} 
            subtitle={t('guide.municipalities.subtitle')}
          />

          {/* Filtri e Ordinamento */}
          <div className="bg-surface rounded-2xl border border-edge p-5">
            <div className="flex flex-wrap gap-4 items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-body">{t('guide.sortBy')}:</span>
                <button
                  onClick={() => setSortBy('distance')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    sortBy === 'distance'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'bg-surface-raised text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  📍 {t('guide.distance')}
                </button>
                <button
                  onClick={() => setSortBy('population')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    sortBy === 'population'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'bg-surface-raised text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  👥 {t('guide.population')}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-body">{t('guide.show')}:</span>
                <button
                  onClick={() => setFilterType('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    filterType === 'all'
                      ? 'bg-purple-600 text-white shadow-md'
                      : 'bg-surface-raised text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {t('guide.all')}
                </button>
                <button
                  onClick={() => setFilterType('new')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    filterType === 'new'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-surface-raised text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {t('guide.newWithin20km')}
                </button>
                <button
                  onClick={() => setFilterType('old')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    filterType === 'old'
                      ? 'bg-orange-600 text-white shadow-md'
                      : 'bg-surface-raised text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {t('guide.oldBeyond20km')}
                </button>
              </div>
            </div>
            {/* Province filter */}
            <div className="flex flex-wrap gap-2 items-center mt-3 pt-3 border-t border-edge">
              <span className="text-sm font-bold text-body">{t('guide.province')}:</span>
              {['all', 'CO', 'VA', 'VB', 'SO', 'LC'].map(p => (
                <button
                  key={p}
                  onClick={() => setFilterProvince(p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    filterProvince === p
                      ? 'bg-emerald-600 text-white shadow-md'
                      : 'bg-surface-raised text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {p === 'all' ? t('guide.all') : PROVINCE_NAMES[p]}
                </button>
              ))}
            </div>
          </div>

          {/* Lista Comuni */}
          <div className="grid md:grid-cols-2 gap-4">
            {filteredMunicipalities.map((m, idx) => {
              const isSelected = selectedMunicipality?.name === m.name;
              return (
                <React.Fragment key={idx}>
                  <div
                    onClick={() => handleMunicipalityClick(m)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleMunicipalityClick(m); } }}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isSelected}
                    className={`bg-gradient-to-br ${m.type === 'new' ? 'from-blue-50 to-blue-100 dark:from-blue-950/30 dark:to-blue-900/30 border-blue-200 dark:border-blue-800' : 'from-orange-50 to-red-50 dark:from-orange-950/30 dark:to-red-950/30 border-orange-200 dark:border-orange-800'} rounded-2xl border-2 p-5 hover:shadow-lg transition-[color,background-color,border-color,box-shadow] cursor-pointer select-none ${isSelected ? 'ring-2 ring-blue-500 ring-offset-2 shadow-lg' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                          <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{m.name}</h3>
                          {m.type === 'both' ? (
                            <>
                              <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-600 text-white">
                                {t('guide.new')}
                              </span>
                              <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-orange-600 text-white">
                                {t('guide.old')}
                              </span>
                            </>
                          ) : (
                            <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${m.type === 'new' ? 'bg-blue-600 text-white' : 'bg-orange-600 text-white'}`}>
                              {m.type === 'new' ? t('guide.new') : t('guide.old')}
                            </span>
                          )}
                          <span className="ml-auto text-xs text-indigo-600 dark:text-indigo-400 font-medium">
                            {isSelected ? '▲' : '▼'} {t('guide.municipalities.detail.clickHint')}
                          </span>
                        </div>
                        <div className="grid sm:grid-cols-2 gap-3 text-sm">
                          <div className="flex items-center gap-2 text-body">
                            <MapPin size={16} className="text-indigo-600" />
                            <span><strong>{t('guide.province')}:</strong> {m.province}</span>
                          </div>
                          <div className="flex items-center gap-2 text-body">
                            <Navigation size={16} className="text-emerald-700" />
                            <span><strong>{t('guide.distance')}:</strong> {m.distance} {t('guide.kmFromBorder')}</span>
                          </div>
                          <div className="flex items-center gap-2 text-body">
                            <Car size={16} className="text-orange-600" />
                            <span><strong>{t('guide.borderCrossing')}:</strong> {m.borderCrossing}</span>
                          </div>
                          <div className="flex items-center gap-2 text-body">
                            <Users size={16} className="text-purple-600" />
                            <span><strong>{t('guide.population')}:</strong> {m.population.toLocaleString('it-IT')}</span>
                          </div>
                        </div>
                      </div>
                      <CheckCircle2 size={24} className={`flex-shrink-0 ${isSelected ? 'text-indigo-600' : m.type === 'new' ? 'text-blue-600' : 'text-orange-600'}`} />
                    </div>
                  </div>
                  {isSelected && (
                    <div className="md:hidden">
                      <MunicipalityDetailPanel municipality={m} t={t} onClose={() => setSelectedMunicipality(null)} />
                    </div>
                  )}
                  {selectedMunicipality && idx === desktopDetailInsertIndex && (
                    <div className="hidden md:block md:col-span-2">
                      <MunicipalityDetailPanel municipality={selectedMunicipality} t={t} onClose={() => setSelectedMunicipality(null)} />
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Mappa Interattiva */}
          <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-6 overflow-hidden">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-xl">
                <MapPin className="text-white" size={20} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{t('guide.municipalities.mapTitle')}</h3>
            </div>
            {/* Legenda */}
            <div className="flex gap-4 mb-4 flex-wrap text-sm">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-blue-600"></div>
                <span className="text-body">{t('guide.legendNewOnly')}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-orange-600"></div>
                <span className="text-body">{t('guide.legendOldOnly')}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-purple-600"></div>
                <span className="text-body">{t('guide.legendBoth')}</span>
              </div>
            </div>
            <Suspense fallback={<div className="flex items-center justify-center h-[500px]"><span className="text-muted text-sm">Loading map…</span></div>}>
              <LazyLeafletMap>
                {({ MapContainer, TileLayer, Marker, Popup, L }) => (
                  <div className="h-[500px] rounded-xl overflow-hidden border-2 border-edge">
                    <MapContainer
                      center={[46.0, 9.2]}
                      zoom={8}
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
                          icon={createCustomIcon(L, m.type)}
                        >
                          <Popup>
                            <div className="text-sm">
                              <h4 className="font-bold text-base mb-1">{m.name}</h4>
                              <div className="space-y-1 text-xs">
                                <p><strong>{t('guide.province')}:</strong> {m.province}</p>
                                <p><strong>{t('guide.distance')}:</strong> {m.distance} km</p>
                                <p><strong>{t('guide.population')}:</strong> {m.population.toLocaleString('it-IT')}</p>
                                <p><strong>{t('guide.borderCrossing')}:</strong> {m.borderCrossing}</p>
                                <div className="flex gap-1 mt-2">
                                  {m.type === 'both' ? (
                                    <>
                                      <span className="px-2 py-0.5 rounded bg-blue-600 text-white text-xs font-bold">{t('guide.new')}</span>
                                      <span className="px-2 py-0.5 rounded bg-orange-600 text-white text-xs font-bold">{t('guide.old')}</span>
                                    </>
                                  ) : (
                                    <span className={`px-2 py-0.5 rounded ${m.type === 'new' ? 'bg-blue-600' : 'bg-orange-600'} text-white text-xs font-bold`}>
                                      {m.type === 'new' ? t('guide.new') : t('guide.old')}
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
                )}
              </LazyLeafletMap>
            </Suspense>
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-200 dark:border-amber-800 rounded-2xl p-6">
            <div className="flex items-start gap-3">
              <AlertCircle size={24} className="text-amber-700 flex-shrink-0" />
              <div className="text-sm text-amber-800 dark:text-amber-200 space-y-2">
                <p className="font-bold">⚠️ {t('guide.municipalities.importantNote')}</p>
                <ul className="space-y-1 text-xs">
                  <li>• {t('guide.municipalities.note1')}</li>
                  <li>• {t('guide.municipalities.note2')}</li>
                  <li>• {t('guide.municipalities.note3')}</li>
                  <li>• {t('guide.municipalities.note4')} <a href="https://www.ti.ch/fonte" target="_blank" rel="noopener noreferrer" className="underline font-semibold">www.ti.ch/fonte</a></li>
                  <li>• {t('guide.municipalities.note5')}</li>
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
            title={t('guide.border.title')} 
            subtitle={t('guide.border.subtitle')}
          />

          {/* Smart Filters */}
          <div className="bg-surface rounded-2xl border border-edge p-5 shadow-sm">
            <h3 className="text-base font-semibold text-body mb-4 flex items-center gap-2">
              <BarChart3 size={16} className="text-indigo-600" />
              {t('guide.border.smartFilters')}
            </h3>
            
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <button
                onClick={() => {
                  setBorderFilter('all');
                  const count = borderCrossings.filter(b => b.traffic !== 'closed').length;
                  Analytics.trackBorderFilter('all', count);
                }}
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${borderFilter === 'all' ? 'bg-indigo-500 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
              >
                🔍 {t('guide.all')} ({borderCrossings.filter(b => b.traffic !== 'closed').length})
              </button>
              <button
                onClick={() => {
                  setBorderFilter('low-traffic');
                  const count = borderCrossings.filter(b => b.traffic === 'low').length;
                  Analytics.trackBorderFilter('low-traffic', count);
                }}
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${borderFilter === 'low-traffic' ? 'bg-emerald-700 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
              >
                ✅ {t('guide.border.lowTraffic')} ({borderCrossings.filter(b => b.traffic === 'low').length})
              </button>
              <button
                onClick={() => {
                  setBorderFilter('24h');
                  const count = borderCrossings.filter(b => b.hours === '24h').length;
                  Analytics.trackBorderFilter('24h', count);
                }}
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${borderFilter === '24h' ? 'bg-blue-500 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
              >
                ⏰ {t('guide.border.open24h')} ({borderCrossings.filter(b => b.hours === '24h').length})
              </button>
              <button
                onClick={() => {
                  setBorderFilter('morning');
                  const count = borderCrossings.filter(b => {
                    const maxWait = parseInt(b.avgWaitMorning.split('-')[1]);
                    return !isNaN(maxWait) && maxWait <= 10;
                  }).length;
                  Analytics.trackBorderFilter('morning', count);
                }}
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${borderFilter === 'morning' ? 'bg-orange-500 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
              >
                🌅 {t('guide.border.fastMorning')}
              </button>
              <button
                onClick={() => {
                  setBorderFilter('evening');
                  const count = borderCrossings.filter(b => {
                    const maxWait = parseInt(b.avgWaitEvening.split('-')[1]);
                    return !isNaN(maxWait) && maxWait <= 12;
                  }).length;
                  Analytics.trackBorderFilter('evening', count);
                }}
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${borderFilter === 'evening' ? 'bg-purple-500 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
              >
                🌆 {t('guide.border.fastEvening')}
              </button>
            </div>

            {/* Time selector */}
            <div className="mt-4 p-4 bg-gradient-to-r from-teal-50 to-emerald-50 dark:from-teal-900/20 dark:to-emerald-900/20 rounded-xl border border-teal-200 dark:border-teal-800">
              <div className="text-sm font-bold text-body mb-2">
                💡 {t('guide.border.timeAdvice')}:
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setSelectedTime('morning');
                    const count = borderCrossings.filter(b => {
                      const maxWait = parseInt(b.avgWaitMorning.split('-')[1]);
                      return !isNaN(maxWait) && maxWait <= 8;
                    }).length;
                    Analytics.trackBorderTimeSelection('morning', count);
                  }}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${selectedTime === 'morning' ? 'bg-orange-500 text-white' : 'bg-surface text-slate-600 dark:text-slate-300'}`}
                >
                  🌅 {t('guide.border.morning')} (7-9)
                </button>
                <button
                  onClick={() => {
                    setSelectedTime('evening');
                    const count = borderCrossings.filter(b => {
                      const maxWait = parseInt(b.avgWaitEvening.split('-')[1]);
                      return !isNaN(maxWait) && maxWait <= 12;
                    }).length;
                    Analytics.trackBorderTimeSelection('evening', count);
                  }}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${selectedTime === 'evening' ? 'bg-purple-500 text-white' : 'bg-surface text-slate-600 dark:text-slate-300'}`}
                >
                  🌆 {t('guide.border.evening')} (17-19)
                </button>
                <button
                  onClick={() => {
                    setSelectedTime('night');
                    const count = borderCrossings.filter(b => b.hours === '24h' && b.traffic === 'low').length;
                    Analytics.trackBorderTimeSelection('night', count);
                  }}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${selectedTime === 'night' ? 'bg-indigo-500 text-white' : 'bg-surface text-slate-600 dark:text-slate-300'}`}
                >
                  🌙 {t('guide.border.night')}
                </button>
              </div>
            </div>
          </div>

          {/* Interactive Map */}
          <div className="bg-surface rounded-2xl border border-edge p-5 shadow-sm">
            <h3 className="text-base font-semibold text-body mb-4 flex items-center gap-2">
              <MapPin size={16} className="text-red-500" />
              {t('guide.border.interactiveMap')}
            </h3>
            <Suspense fallback={<div className="flex items-center justify-center h-[500px]"><span className="text-muted text-sm">Loading map…</span></div>}>
              <LazyLeafletMap>
                {({ MapContainer, TileLayer, Marker, Popup, L }) => (
                  <div className="h-[500px] rounded-xl overflow-hidden border-2 border-edge">
                    <MapContainer center={[45.87, 8.95]} zoom={10} style={{ height: '100%', width: '100%' }}>
                      <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                      />
                      {borderCrossings
                        .filter(border => {
                          if (border.traffic === 'closed') return false;
                          if (borderFilter === 'low-traffic') return border.traffic === 'low';
                          if (borderFilter === '24h') return border.hours === '24h';
                          if (borderFilter === 'morning') {
                            const maxWait = parseInt(border.avgWaitMorning.split('-')[1]);
                            return !isNaN(maxWait) && maxWait <= 10;
                          }
                          if (borderFilter === 'evening') {
                            const maxWait = parseInt(border.avgWaitEvening.split('-')[1]);
                            return !isNaN(maxWait) && maxWait <= 12;
                          }
                          return true;
                        })
                        .map((border, idx) => {
                          const trafficColor = border.traffic === 'high' ? '#ef4444' : border.traffic === 'medium' ? '#f59e0b' : '#10b981';
                          const customIcon = L.divIcon({
                            className: 'custom-border-marker',
                            html: `<div style="background-color: ${trafficColor}; width: 24px; height: 24px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3);"></div>`,
                            iconSize: [24, 24],
                            iconAnchor: [12, 12],
                          });
                          return (
                            <Marker key={idx} position={[border.lat, border.lng]} icon={customIcon}>
                              <Popup>
                                <div className="text-sm min-w-[200px]">
                                  <div className="font-bold text-slate-800 dark:text-slate-100 mb-1">{border.name}</div>
                                  <div className="text-sm text-subtle mb-2">📍 {border.italianSide}</div>
                                  <div className="text-xs space-y-1">
                                    <div><strong>🌅 {t('guide.border.morning')}:</strong> {border.avgWaitMorning}</div>
                                    <div><strong>🌆 {t('guide.border.evening')}:</strong> {border.avgWaitEvening}</div>
                                    <div><strong>⏰ {t('guide.border.hours')}:</strong> {t(border.hours)}</div>
                                    <div className="pt-2 border-t border-edge">
                                      <strong>💡</strong> {t(border.tips)}
                                    </div>
                                  </div>
                                </div>
                              </Popup>
                            </Marker>
                          );
                        })}
                    </MapContainer>
                  </div>
                )}
              </LazyLeafletMap>
            </Suspense>
            <div className="mt-3 flex items-center justify-center gap-6 text-xs">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500 border-2 border-white"></div>
                <span className="text-slate-600 dark:text-slate-300">{t('guide.border.highTraffic')}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-orange-500 border-2 border-white"></div>
                <span className="text-slate-600 dark:text-slate-300">{t('guide.border.mediumTraffic')}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-emerald-700 border-2 border-white"></div>
                <span className="text-slate-600 dark:text-slate-300">{t('guide.border.lowTrafficLabel')}</span>
              </div>
            </div>
          </div>

          {/* Border Crossings Grid */}
          <div className="grid md:grid-cols-2 gap-4">
            {filteredBorderCrossings.map((border, idx) => {
                const isRecommended = 
                  (selectedTime === 'morning' && parseInt(border.avgWaitMorning.split('-')[1]) <= 8) ||
                  (selectedTime === 'evening' && parseInt(border.avgWaitEvening.split('-')[1]) <= 12) ||
                  (selectedTime === 'night' && border.hours === '24h' && border.traffic === 'low');

                return (
                  <div 
                    key={idx} 
                    className={`bg-surface rounded-2xl border-2 p-5 hover:shadow-lg transition-[color,background-color,border-color,box-shadow] ${isRecommended ? 'border-emerald-500 ring-2 ring-emerald-500/20' : 'border-edge'}`}
                  >
                    {isRecommended && (
                      <div className="mb-3 px-3 py-1.5 bg-emerald-700 text-white text-xs font-bold rounded-full inline-flex items-center gap-1.5">
                        ⭐ {t('guide.border.recommendedFor')} {selectedTime === 'morning' ? t('guide.border.morning') : selectedTime === 'evening' ? t('guide.border.evening') : t('guide.border.night')}
                      </div>
                    )}
                    
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`p-2 rounded-lg ${border.traffic === 'high' ? 'bg-red-500' : border.traffic === 'medium' ? 'bg-orange-500' : 'bg-emerald-700'}`}>
                        <Navigation className="text-white" size={18} />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{border.name}</h3>
                        <p className="text-sm text-muted">📍 {border.italianSide}</p>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-600 dark:text-slate-300">{t('guide.border.waitMorning')} (🌅 7-9)</span>
                        <span className={`text-sm font-bold ${selectedTime === 'morning' ? 'text-orange-600' : 'text-subtle'}`}>{border.avgWaitMorning}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-600 dark:text-slate-300">{t('guide.border.waitEvening')} (🌆 17-19)</span>
                        <span className={`text-sm font-bold ${selectedTime === 'evening' ? 'text-purple-600' : 'text-subtle'}`}>{border.avgWaitEvening}</span>
                      </div>
                      <div className="pt-2 border-t border-edge">
                        <div className="text-sm text-muted mb-1">⏰ {t('guide.border.openingHours')}</div>
                        <div className={`text-sm font-semibold ${border.hours === '24h' ? 'text-emerald-700' : 'text-orange-600'}`}>{t(border.hours)}</div>
                      </div>
                      <div className="pt-2 border-t border-edge">
                        <div className="text-sm text-muted mb-1">🔴 {t('guide.border.peakHours')}</div>
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">{t(border.peak)}</div>
                      </div>
                      <div className="p-2.5 bg-warm-50 dark:bg-warm-950 rounded-lg border border-warm-200 dark:border-warm-800">
                        <div className="text-xs text-warm-700 dark:text-warm-300">
                          <strong>💡 {t('guide.border.tip')}:</strong> {t(border.tips)}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>

          <InfoCard icon={Clock} title={t('guide.border.travelTimes')} color="blue">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="p-3 bg-surface-alt rounded-lg">
                <div className="text-sm text-muted mb-1">Como → Lugano</div>
                <div className="text-lg font-bold text-blue-600">25-40 min</div>
              </div>
              <div className="p-3 bg-surface-alt rounded-lg">
                <div className="text-sm text-muted mb-1">Varese → Mendrisio</div>
                <div className="text-lg font-bold text-blue-600">20-35 min</div>
              </div>
              <div className="p-3 bg-surface-alt rounded-lg">
                <div className="text-sm text-muted mb-1">Varese → Lugano</div>
                <div className="text-lg font-bold text-blue-600">30-45 min</div>
              </div>
              <div className="p-3 bg-surface-alt rounded-lg">
                <div className="text-sm text-muted mb-1">Milano → Lugano</div>
                <div className="text-lg font-bold text-blue-600">60-90 min</div>
              </div>
            </div>
            <p className="text-sm text-muted mt-3">
              * {t('guide.border.travelTimesNote')}
            </p>
          </InfoCard>

          <InfoCard icon={Car} title={t('guide.border.commutingTips')} color="purple">
            <ul className="space-y-2">
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>{t('guide.border.tip1Title')}:</strong> {t('guide.border.tip1')}</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>{t('guide.border.tip2Title')}:</strong> {t('guide.border.tip2')}</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>{t('guide.border.tip3Title')}:</strong> {t('guide.border.tip3')}</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>{t('guide.border.tip4Title')}:</strong> {t('guide.border.tip4')}</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                <span><strong>{t('guide.border.tip5Title')}:</strong> {t('guide.border.tip5')}</span>
              </li>
            </ul>
          </InfoCard>
        </div>
      )}

      {activeSection === 'living-ch' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={Home} 
            title={t('guide.livingCH.title')} 
            subtitle={t('guide.livingCH.subtitle')}
          />

          <div className="grid md:grid-cols-2 gap-6">
            <InfoCard icon={FileText} title={t('guide.livingCH.documentsTitle')} color="blue">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.doc1Title')}:</strong> {t('guide.livingCH.doc1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.doc2Title')}:</strong> {t('guide.livingCH.doc2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.doc3Title')}:</strong> {t('guide.livingCH.doc3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.doc4Title')}:</strong> {t('guide.livingCH.doc4')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.doc5Title')}:</strong> {t('guide.livingCH.doc5')}</span>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={Shield} title={t('guide.livingCH.insuranceTitle')} color="purple">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>{t('guide.livingCH.ins1Title')}:</strong>
                    <div className="text-xs mt-1">{t('guide.livingCH.ins1')}</div>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>{t('guide.livingCH.ins2Title')}:</strong>
                    <div className="text-xs mt-1">{t('guide.livingCH.ins2')}</div>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-purple-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>{t('guide.livingCH.ins3Title')}:</strong>
                    <div className="text-xs mt-1">{t('guide.livingCH.ins3')}</div>
                  </div>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={Briefcase} title={t('guide.livingCH.prosTitle')} color="green">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro1Title')}:</strong> {t('guide.livingCH.pro1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro2Title')}:</strong> {t('guide.livingCH.pro2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro3Title')}:</strong> {t('guide.livingCH.pro3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro4Title')}:</strong> {t('guide.livingCH.pro4')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro5Title')}:</strong> {t('guide.livingCH.pro5')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro6Title')}:</strong> {t('guide.livingCH.pro6')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro7Title')}:</strong> {t('guide.livingCH.pro7')}</span>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={AlertCircle} title={t('guide.livingCH.consTitle')} color="orange">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.con1Title')}:</strong> {t('guide.livingCH.con1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.con2Title')}:</strong> {t('guide.livingCH.con2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.con3Title')}:</strong> {t('guide.livingCH.con3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.con4Title')}:</strong> {t('guide.livingCH.con4')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.con5Title')}:</strong> {t('guide.livingCH.con5')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.con6Title')}:</strong> {t('guide.livingCH.con6')}</span>
                </li>
              </ul>
            </InfoCard>
          </div>

          <div className="grid md:grid-cols-1 gap-6">
            <InfoCard icon={Euro} title={t('guide.livingCH.investTitle')} color="teal">
              <div className="space-y-4">
                <div className="p-4 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl border-2 border-emerald-200 dark:border-emerald-800">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 size={18} className="text-emerald-700" />
                    <strong className="text-emerald-700 dark:text-emerald-300">✅ {t('guide.livingCH.capitalGainTitle')}</strong>
                  </div>
                  <p className="text-sm text-body mb-2">
                    {t('guide.livingCH.capitalGainDesc')}
                  </p>
                  <p className="text-sm text-slate-600 dark:text-slate-300">
                    💡 {t('guide.livingCH.capitalGainNote')}
                  </p>
                </div>

                <div className="p-4 bg-orange-50 dark:bg-orange-900/20 rounded-xl border-2 border-orange-200 dark:border-orange-800">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle size={18} className="text-orange-600" />
                    <strong className="text-orange-700 dark:text-orange-300">⚠️ {t('guide.livingCH.wealthTaxTitle')}</strong>
                  </div>
                  <p className="text-sm text-body mb-2">
                    {t('guide.livingCH.wealthTaxDesc')}
                  </p>
                  <div className="text-xs space-y-1 text-slate-600 dark:text-slate-300 mb-3">
                    <div className="flex items-start gap-2">
                      <span>📊</span>
                      <span><strong>{t('guide.livingCH.wealthTaxRate')}:</strong> {t('guide.livingCH.wealthTaxRateDesc')}</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>💼</span>
                      <span><strong>{t('guide.livingCH.wealthTaxExemption')}:</strong> {t('guide.livingCH.wealthTaxExemptionDesc')}</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>🧮</span>
                      <span><strong>{t('guide.livingCH.wealthTaxExample')}:</strong> {t('guide.livingCH.wealthTaxExampleDesc')}</span>
                    </div>
                  </div>
                  
                  {/* Ticino progressive brackets table */}
                  <div className="mt-3 p-3 bg-surface/50 rounded-lg border border-orange-100 dark:border-orange-900">
                    <p className="text-xs font-bold text-orange-700 dark:text-orange-300 mb-2">{t('guide.livingCH.wealthTaxBrackets')}</p>
                    <div className="grid grid-cols-2 gap-1 text-xs">
                      <span className="font-semibold text-body">{t('guide.livingCH.wealthBracketRange')}</span>
                      <span className="font-semibold text-body">{t('guide.livingCH.wealthBracketRate')}</span>
                      <span className="text-slate-600 dark:text-slate-300">CHF 0 – 200.000</span>
                      <span className="text-emerald-700 dark:text-emerald-400">0‰ ({t('guide.livingCH.wealthExempt')})</span>
                      <span className="text-slate-600 dark:text-slate-300">CHF 200.001 – 300.000</span>
                      <span className="text-slate-600 dark:text-slate-300">~1,5‰</span>
                      <span className="text-slate-600 dark:text-slate-300">CHF 300.001 – 500.000</span>
                      <span className="text-slate-600 dark:text-slate-300">~2,0‰</span>
                      <span className="text-slate-600 dark:text-slate-300">CHF 500.001 – 1.000.000</span>
                      <span className="text-slate-600 dark:text-slate-300">~2,5‰</span>
                      <span className="text-slate-600 dark:text-slate-300">CHF 1.000.001+</span>
                      <span className="text-slate-600 dark:text-slate-300">~3,0‰</span>
                    </div>
                  </div>

                  <div className="mt-3 text-sm text-muted space-y-1">
                    <p>🏠 <strong>{t('guide.livingCH.wealthTaxableAssets')}:</strong> {t('guide.livingCH.wealthTaxableAssetsDesc')}</p>
                    <p>🪪 <strong>{t('guide.livingCH.wealthPermitB')}:</strong> {t('guide.livingCH.wealthPermitBDesc')}</p>
                  </div>
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={ShoppingCart} title={t('guide.livingCH.taxFreeTitle')} color="purple">
              <div className="space-y-4">
                <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-xl border-2 border-purple-200 dark:border-purple-800">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 size={18} className="text-purple-600" />
                    <strong className="text-purple-700 dark:text-purple-300">✨ {t('guide.livingCH.taxFreeRight')}</strong>
                  </div>
                  <p className="text-sm text-body mb-3">
                    {t('guide.livingCH.taxFreeDesc')}
                  </p>
                  <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
                    <div className="flex items-start gap-2">
                      <span>🏷️</span>
                      <div>
                        <strong>{t('guide.livingCH.taxFreeMin')}:</strong> {t('guide.livingCH.taxFreeMinDesc')}
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>📄</span>
                      <div>
                        <strong>{t('guide.livingCH.taxFreeProcedure')}:</strong> {t('guide.livingCH.taxFreeProcedureDesc')}
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>💵</span>
                      <div>
                        <strong>{t('guide.livingCH.taxFreeRefund')}:</strong> {t('guide.livingCH.taxFreeRefundDesc')}
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>⏱️</span>
                      <div>
                        <strong>{t('guide.livingCH.taxFreeTiming')}:</strong> {t('guide.livingCH.taxFreeTimingDesc')}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
                  <div className="text-xs space-y-2 text-blue-700 dark:text-blue-300">
                    <p><strong>💡 {t('guide.livingCH.taxFreeTipsTitle')}:</strong></p>
                    <ul className="space-y-1 ml-4">
                      <li>• {t('guide.livingCH.taxFreeTip1')}</li>
                      <li>• {t('guide.livingCH.taxFreeTip2')}</li>
                      <li>• {t('guide.livingCH.taxFreeTip3')}</li>
                      <li>• {t('guide.livingCH.taxFreeTip4')}</li>
                      <li>• {t('guide.livingCH.taxFreeTip5')}</li>
                    </ul>
                  </div>
                </div>
              </div>
            </InfoCard>
          </div>

          {/* Religious Places in Ticino */}
          <InfoCard icon={Landmark} title={t('guide.livingCH.religiousTitle')} color="purple">
            <div className="space-y-4">
              <p className="text-sm text-body">{t('guide.livingCH.religiousIntro')}</p>

              {/* Catholic */}
              <div>
                <h4 className="font-bold text-sm text-purple-700 dark:text-purple-300 mb-2">⛪ {t('guide.livingCH.catholicTitle')}</h4>
                <ul className="space-y-2">
                  {(['catholic1', 'catholic2', 'catholic3', 'catholic4', 'catholic5', 'catholic6'] as const).map((k) => (
                    <li key={k} className="flex items-start gap-2">
                      <CheckCircle2 size={14} className="text-purple-600 flex-shrink-0 mt-0.5" />
                      <span className="text-sm"><strong>{t(`guide.livingCH.${k}Name`)}:</strong> {t(`guide.livingCH.${k}Desc`)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Protestant / Reformed */}
              <div>
                <h4 className="font-bold text-sm text-blue-700 dark:text-blue-300 mb-2">✝️ {t('guide.livingCH.protestantTitle')}</h4>
                <ul className="space-y-2">
                  {(['protestant1', 'protestant2', 'protestant3'] as const).map((k) => (
                    <li key={k} className="flex items-start gap-2">
                      <CheckCircle2 size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                      <span className="text-sm"><strong>{t(`guide.livingCH.${k}Name`)}:</strong> {t(`guide.livingCH.${k}Desc`)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Other religions */}
              <div>
                <h4 className="font-bold text-sm text-emerald-700 dark:text-emerald-300 mb-2">🕌 {t('guide.livingCH.otherReligionsTitle')}</h4>
                <ul className="space-y-2">
                  {(['otherRel1', 'otherRel2', 'otherRel3'] as const).map((k) => (
                    <li key={k} className="flex items-start gap-2">
                      <CheckCircle2 size={14} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                      <span className="text-sm"><strong>{t(`guide.livingCH.${k}Name`)}:</strong> {t(`guide.livingCH.${k}Desc`)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* SEO content */}
              <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-xl border border-purple-200 dark:border-purple-800">
                <p className="text-xs text-purple-700 dark:text-purple-300 leading-relaxed">
                  {t('guide.livingCH.religiousSeo')}
                </p>
              </div>
            </div>
          </InfoCard>
        </div>
      )}

      {activeSection === 'living-it' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={Users} 
            title={t('guide.livingIT.title')} 
            subtitle={t('guide.livingIT.subtitle')}
          />

          <div className="grid md:grid-cols-2 gap-6">
            <InfoCard icon={FileText} title={t('guide.livingIT.documentsTitle')} color="blue">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.doc1Title')}:</strong> {t('guide.livingIT.doc1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.doc2Title')}:</strong> {t('guide.livingIT.doc2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.doc3Title')}:</strong> {t('guide.livingIT.doc3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.doc4Title')}:</strong> {t('guide.livingIT.doc4')}</span>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={Heart} title={t('guide.livingIT.healthTitle')} color="purple">
              <div className="space-y-3">
                <div>
                  <strong className="text-purple-600">{t('guide.livingIT.healthOpt1')}</strong>
                  <div className="text-xs mt-1">{t('guide.livingIT.healthOpt1Desc')}</div>
                </div>
                <div>
                  <strong className="text-emerald-700">{t('guide.livingIT.healthOpt2')}</strong>
                  <div className="text-xs mt-1">{t('guide.livingIT.healthOpt2Desc')}</div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-sm text-blue-700 dark:text-blue-300">
                  💡 {t('guide.livingIT.healthTip')}
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={Briefcase} title={t('guide.livingIT.prosTitle')} color="green">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.pro1Title')}:</strong> {t('guide.livingIT.pro1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.pro2Title')}:</strong> {t('guide.livingIT.pro2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.pro3Title')}:</strong> {t('guide.livingIT.pro3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.pro4Title')}:</strong> {t('guide.livingIT.pro4')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.pro5Title')}:</strong> {t('guide.livingIT.pro5')}</span>
                </li>
              </ul>
            </InfoCard>

            <InfoCard icon={AlertCircle} title={t('guide.livingIT.consTitle')} color="orange">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.con1Title')}:</strong> {t('guide.livingIT.con1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.con2Title')}:</strong> {t('guide.livingIT.con2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.con3Title')}:</strong> {t('guide.livingIT.con3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.con4Title')}:</strong> {t('guide.livingIT.con4')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.con5Title')}:</strong> {t('guide.livingIT.con5')}</span>
                </li>
              </ul>
            </InfoCard>
          </div>

          <div className="bg-gradient-to-br from-teal-50 to-emerald-50 dark:from-teal-950/30 dark:to-emerald-950/30 rounded-2xl border-2 border-teal-200 dark:border-teal-800 p-6">
            <div className="flex items-start gap-3">
              <Info size={24} className="text-teal-600 flex-shrink-0" />
              <div className="space-y-3 text-sm text-teal-800 dark:text-teal-200">
                <p className="font-bold">📋 {t('guide.livingIT.checklistTitle')}</p>
                <div className="grid sm:grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-teal-600" />
                    <span>{t('guide.livingIT.check1')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-teal-600" />
                    <span>{t('guide.livingIT.check2')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-teal-600" />
                    <span>{t('guide.livingIT.check3')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-teal-600" />
                    <span>{t('guide.livingIT.check4')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-teal-600" />
                    <span>{t('guide.livingIT.check5')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-teal-600" />
                    <span>{t('guide.livingIT.check6')}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Religious Places in Italian border region */}
          <InfoCard icon={Landmark} title={t('guide.livingIT.religiousTitle')} color="purple">
            <div className="space-y-4">
              <p className="text-sm text-body">{t('guide.livingIT.religiousIntro')}</p>

              {/* Catholic */}
              <div>
                <h4 className="font-bold text-sm text-purple-700 dark:text-purple-300 mb-2">⛪ {t('guide.livingIT.catholicTitle')}</h4>
                <ul className="space-y-2">
                  {(['catholic1', 'catholic2', 'catholic3', 'catholic4', 'catholic5', 'catholic6'] as const).map((k) => (
                    <li key={k} className="flex items-start gap-2">
                      <CheckCircle2 size={14} className="text-purple-600 flex-shrink-0 mt-0.5" />
                      <span className="text-sm"><strong>{t(`guide.livingIT.${k}Name`)}:</strong> {t(`guide.livingIT.${k}Desc`)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Protestant / Evangelical */}
              <div>
                <h4 className="font-bold text-sm text-blue-700 dark:text-blue-300 mb-2">✝️ {t('guide.livingIT.protestantTitle')}</h4>
                <ul className="space-y-2">
                  {(['protestant1', 'protestant2'] as const).map((k) => (
                    <li key={k} className="flex items-start gap-2">
                      <CheckCircle2 size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                      <span className="text-sm"><strong>{t(`guide.livingIT.${k}Name`)}:</strong> {t(`guide.livingIT.${k}Desc`)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Other religions */}
              <div>
                <h4 className="font-bold text-sm text-emerald-700 dark:text-emerald-300 mb-2">🕌 {t('guide.livingIT.otherReligionsTitle')}</h4>
                <ul className="space-y-2">
                  {(['otherRel1', 'otherRel2', 'otherRel3'] as const).map((k) => (
                    <li key={k} className="flex items-start gap-2">
                      <CheckCircle2 size={14} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                      <span className="text-sm"><strong>{t(`guide.livingIT.${k}Name`)}:</strong> {t(`guide.livingIT.${k}Desc`)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* SEO content */}
              <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-xl border border-purple-200 dark:border-purple-800">
                <p className="text-xs text-purple-700 dark:text-purple-300 leading-relaxed">
                  {t('guide.livingIT.religiousSeo')}
                </p>
              </div>
            </div>
          </InfoCard>
        </div>
      )}

      {activeSection === 'calendar' && (
        <div className="animate-fade-in">
          <Suspense fallback={<div className="flex items-center justify-center min-h-[600px]"><div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-2 border-blue-500 border-t-transparent" /></div>}>
            <TaxCalendar initialTab="fiscal" />
          </Suspense>
        </div>
      )}

      {activeSection === 'holidays' && (
        <div className="animate-fade-in">
          <Suspense fallback={<div className="flex items-center justify-center min-h-[600px]"><div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-2 border-blue-500 border-t-transparent" /></div>}>
            <TaxCalendar initialTab="holidays" />
          </Suspense>
        </div>
      )}

      {activeSection === 'permits' && (
        <div className="animate-fade-in">
          <Suspense fallback={<div className="flex items-center justify-center min-h-[600px]"><div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-2 border-blue-500 border-t-transparent" /></div>}>
            <WorkPermitsGuide />
          </Suspense>
        </div>
      )}

      {activeSection === 'companies' && (
        <div className="animate-fade-in">
          <Suspense fallback={<div className="flex items-center justify-center min-h-[400px]"><div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-2 border-blue-500 border-t-transparent" /></div>}>
            <TicinoCompanies />
          </Suspense>
        </div>
      )}

      {activeSection === 'places' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={Mountain} 
            title={t('guide.places.title')} 
            subtitle={t('guide.places.subtitle')}
          />

          {/* Natura e Montagne */}
          <div className="grid md:grid-cols-2 gap-6">
            <InfoCard icon={Mountain} title={t('guide.places.natureTitle')} color="green">
              <div className="space-y-4">
                <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                  <img src="/images/places/monte-san-salvatore.webp" alt="Monte San Salvatore" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-emerald-700 dark:text-emerald-300 mb-1">🏔️ Monte San Salvatore</div>
                  <p className="text-xs">{t('guide.places.sanSalvatore')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <MapPin size={12} /> Lugano · <Clock size={12} /> {t('guide.places.funicular')}: 12 min
                  </div>
                </div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                  <img src="/images/places/monte-bre.webp" alt="Monte Brè" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-emerald-700 dark:text-emerald-300 mb-1">🏔️ Monte Brè</div>
                  <p className="text-xs">{t('guide.places.monteBreDesc')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <MapPin size={12} /> Lugano · <Clock size={12} /> {t('guide.places.funicular')}: 15 min
                  </div>
                </div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                  <img src="/images/places/monte-generoso.webp" alt="Monte Generoso" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-emerald-700 dark:text-emerald-300 mb-1">🏔️ Monte Generoso</div>
                  <p className="text-xs">{t('guide.places.monteGeneroso')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <MapPin size={12} /> Capolago · <Clock size={12} /> {t('guide.places.cograil')}: 40 min
                  </div>
                </div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                  <img src="/images/places/gandria.webp" alt="Sentiero dell'Olivo" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-emerald-700 dark:text-emerald-300 mb-1">🥾 Sentiero dell'Olivo</div>
                  <p className="text-xs">{t('guide.places.sentieroOlivo')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <MapPin size={12} /> Gandria-Castagnola · <Clock size={12} /> ~2h
                  </div>
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={Heart} title={t('guide.places.lakesTitle')} color="blue">
              <div className="space-y-4">
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <img src="/images/places/lago-lugano.webp" alt="Lago di Lugano" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🌊 Lago di Lugano (Ceresio)</div>
                  <p className="text-xs">{t('guide.places.lagoCeresio')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <Navigation size={12} /> {t('guide.places.lakeActivities')}
                  </div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <img src="/images/places/ascona.webp" alt="Lago Maggiore" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🌊 Lago Maggiore</div>
                  <p className="text-xs">{t('guide.places.lagoMaggiore')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <Navigation size={12} /> Locarno, Ascona, Brissago
                  </div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <img src="/images/places/foroglio.webp" alt="Cascata di Foroglio" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">💧 Cascata di Foroglio</div>
                  <p className="text-xs">{t('guide.places.foroglio')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <MapPin size={12} /> Val Bavona · <Clock size={12} /> ~1.5h {t('guide.places.fromLugano')}
                  </div>
                </div>
              </div>
            </InfoCard>
          </div>

          {/* Città e Cultura */}
          <div className="grid md:grid-cols-2 gap-6">
            <InfoCard icon={Building2} title={t('guide.places.citiesTitle')} color="purple">
              <div className="space-y-4">
                <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-xl">
                  <img src="/images/places/lugano-view.webp" alt="Lugano" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-purple-700 dark:text-purple-300 mb-1">🏙️ Lugano</div>
                  <p className="text-xs">{t('guide.places.luganoDesc')}</p>
                </div>
                <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-xl">
                  <img src="/images/places/locarno.webp" alt="Locarno & Ascona" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-purple-700 dark:text-purple-300 mb-1">🌴 Locarno & Ascona</div>
                  <p className="text-xs">{t('guide.places.locarnoDesc')}</p>
                </div>
                <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-xl">
                  <img src="/images/places/bellinzona.webp" alt="Bellinzona" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-purple-700 dark:text-purple-300 mb-1">🏰 Bellinzona</div>
                  <p className="text-xs">{t('guide.places.bellinzonaDesc')}</p>
                </div>
                <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-xl">
                  <img src="/images/places/mendrisio.webp" alt="Mendrisio" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-purple-700 dark:text-purple-300 mb-1">🏘️ Mendrisio</div>
                  <p className="text-xs">{t('guide.places.mendrisioDesc')}</p>
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={Landmark} title={t('guide.places.cultureTitle')} color="orange">
              <div className="space-y-4">
                <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-xl">
                  <img src="/images/places/film-festival.webp" alt="Film Festival Locarno" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-orange-700 dark:text-orange-300 mb-1">🎬 Film Festival Locarno</div>
                  <p className="text-xs">{t('guide.places.filmFestival')}</p>
                  <div className="mt-1 text-xs text-muted">📅 {t('guide.places.august')}</div>
                </div>
                <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-xl">
                  <img src="/images/places/lac-lugano.webp" alt="LAC Lugano Arte e Cultura" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-orange-700 dark:text-orange-300 mb-1">🎨 LAC Lugano Arte e Cultura</div>
                  <p className="text-xs">{t('guide.places.lacDesc')}</p>
                </div>
                <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-xl">
                  <img src="/images/places/castelgrande.webp" alt="Castelli di Bellinzona" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-orange-700 dark:text-orange-300 mb-1">🏰 Castelli di Bellinzona</div>
                  <p className="text-xs">{t('guide.places.castelliDesc')}</p>
                </div>
                <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-xl">
                  <div className="font-bold text-orange-700 dark:text-orange-300 mb-1">🍷 Grotti ticinesi</div>
                  <p className="text-xs">{t('guide.places.grottiDesc')}</p>
                </div>
              </div>
            </InfoCard>
          </div>

          {/* Attività e Famiglie */}
          <div className="grid md:grid-cols-2 gap-6">
            <InfoCard icon={Users} title={t('guide.places.familyTitle')} color="teal">
              <div className="space-y-4">
                <div className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-xl">
                  <img src="/images/places/swissminiatur.webp" alt="Swissminiatur" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-teal-700 dark:text-teal-300 mb-1">🌿 Swissminiatur</div>
                  <p className="text-xs">{t('guide.places.swissminiatur')}</p>
                  <div className="mt-1 text-xs text-muted"><MapPin size={12} className="inline" /> Melide · 💰 CHF 19/adulto</div>
                </div>
                <div className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-xl">
                  <div className="font-bold text-teal-700 dark:text-teal-300 mb-1">🦁 Parco Civico Lugano</div>
                  <p className="text-xs">{t('guide.places.parcoCivico')}</p>
                  <div className="mt-1 text-xs text-muted"><MapPin size={12} className="inline" /> Lugano · 💰 {t('guide.places.free')}</div>
                </div>
                <div className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-xl">
                  <div className="font-bold text-teal-700 dark:text-teal-300 mb-1">🏊 Lido di Lugano</div>
                  <p className="text-xs">{t('guide.places.lidoLugano')}</p>
                  <div className="mt-1 text-xs text-muted"><MapPin size={12} className="inline" /> Lugano · 💰 CHF 10/adulto</div>
                </div>
                <div className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-xl">
                  <div className="font-bold text-teal-700 dark:text-teal-300 mb-1">🚂 Ferrovia Monte Generoso</div>
                  <p className="text-xs">{t('guide.places.ferroviaGeneroso')}</p>
                  <div className="mt-1 text-xs text-muted"><MapPin size={12} className="inline" /> Capolago · 💰 CHF 70/A-R</div>
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={ShoppingCart} title={t('guide.places.shoppingTitle')} color="blue">
              <div className="space-y-4">
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <img src="/images/places/foxtown.webp" alt="FoxTown Factory Stores" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" width={400} height={128} />
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🛍️ FoxTown Factory Stores</div>
                  <p className="text-xs">{t('guide.places.foxtown')}</p>
                  <div className="mt-1 text-xs text-muted"><MapPin size={12} className="inline" /> Mendrisio · <Navigation size={12} className="inline" /> 5 min {t('guide.places.fromBorder')}</div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🛒 Centro Commerciale Lugano Sud</div>
                  <p className="text-xs">{t('guide.places.luganoSud')}</p>
                  <div className="mt-1 text-xs text-muted"><MapPin size={12} className="inline" /> Grancia</div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🏬 Manor Lugano</div>
                  <p className="text-xs">{t('guide.places.manorDesc')}</p>
                  <div className="mt-1 text-xs text-muted"><MapPin size={12} className="inline" /> Lugano centro</div>
                </div>
              </div>
            </InfoCard>
          </div>

          {/* Consiglio per frontalieri */}
          <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 p-6">
            <div className="flex items-start gap-3">
              <Info size={24} className="text-emerald-700 flex-shrink-0" />
              <div className="space-y-3 text-sm text-emerald-800 dark:text-emerald-200">
                <p className="font-bold">💡 {t('guide.places.tipTitle')}</p>
                <ul className="space-y-1 text-xs">
                  <li>• {t('guide.places.tip1')}</li>
                  <li>• {t('guide.places.tip2')}</li>
                  <li>• {t('guide.places.tip3')}</li>
                  <li>• {t('guide.places.tip4')}</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeSection === 'schools' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={GraduationCap} 
            title={t('guide.schools.title')} 
            subtitle={t('guide.schools.subtitle')}
          />

          {/* Panoramica sistema scolastico */}
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 rounded-2xl border-2 border-amber-200 dark:border-amber-800 p-6">
            <div className="flex items-start gap-3">
              <Info size={24} className="text-amber-700 flex-shrink-0" />
              <div className="text-sm text-amber-800 dark:text-amber-200">
                <p className="font-bold mb-2">📋 {t('guide.schools.overviewTitle')}</p>
                <p className="text-xs">{t('guide.schools.overviewDesc')}</p>
              </div>
            </div>
          </div>

          {/* Nido (0-3 anni) */}
          <InfoCard icon={Baby} title={t('guide.schools.nidoTitle')} color="purple">
            <div className="space-y-4">
              <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-xl border border-purple-200 dark:border-purple-800">
                <div className="grid sm:grid-cols-3 gap-3 mb-3">
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.age')}</div>
                    <div className="font-bold text-purple-600">0-3 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-purple-600">CHF 1'200-2'500/{t('guide.schools.month')}</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-purple-600">7:00-18:30</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.nidoDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-body">📍 {t('guide.schools.nearBorderTitle')}:</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-purple-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Chiasso/Mendrisio:</strong> {t('guide.schools.nidoChiasso')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-purple-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Stabio/Ligornetto:</strong> {t('guide.schools.nidoStabio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-purple-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Ponte Tresa/Agno:</strong> {t('guide.schools.nidoPonteTresa')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-purple-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Lugano centro:</strong> {t('guide.schools.nidoLugano')}</span>
                  </div>
                </div>
              </div>
            </div>
          </InfoCard>

          {/* Scuola dell'infanzia (3-6 anni) */}
          <InfoCard icon={Heart} title={t('guide.schools.kindergartenTitle')} color="green">
            <div className="space-y-4">
              <div className="p-4 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl border border-emerald-200 dark:border-emerald-800">
                <div className="grid sm:grid-cols-3 gap-3 mb-3">
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.age')}</div>
                    <div className="font-bold text-emerald-700">3-6 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-emerald-700">{t('guide.schools.free')} (pubblica)</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-emerald-700">8:30-15:30</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.kindergartenDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-body">📍 {t('guide.schools.nearBorderTitle')}:</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                    <span><strong>Chiasso:</strong> {t('guide.schools.kindergartenChiasso')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                    <span><strong>Mendrisio:</strong> {t('guide.schools.kindergartenMendrisio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                    <span><strong>Stabio:</strong> {t('guide.schools.kindergartenStabio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                    <span><strong>Balerna:</strong> {t('guide.schools.kindergartenBalerna')}</span>
                  </div>
                </div>
              </div>
            </div>
          </InfoCard>

          {/* Scuola elementare (6-11 anni) */}
          <InfoCard icon={BookOpen} title={t('guide.schools.primaryTitle')} color="blue">
            <div className="space-y-4">
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
                <div className="grid sm:grid-cols-3 gap-3 mb-3">
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.age')}</div>
                    <div className="font-bold text-blue-600">6-11 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-blue-600">{t('guide.schools.free')} (pubblica)</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-blue-600">8:15-15:45</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.primaryDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-body">📍 {t('guide.schools.nearBorderTitle')}:</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Chiasso:</strong> {t('guide.schools.primaryChiasso')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Mendrisio:</strong> {t('guide.schools.primaryMendrisio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Stabio/Ligornetto:</strong> {t('guide.schools.primaryStabio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Balerna/Novazzano:</strong> {t('guide.schools.primaryBalerna')}</span>
                  </div>
                </div>
              </div>
            </div>
          </InfoCard>

          {/* Scuola media (11-15 anni) */}
          <InfoCard icon={GraduationCap} title={t('guide.schools.middleTitle')} color="orange">
            <div className="space-y-4">
              <div className="p-4 bg-orange-50 dark:bg-orange-900/20 rounded-xl border border-orange-200 dark:border-orange-800">
                <div className="grid sm:grid-cols-3 gap-3 mb-3">
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.age')}</div>
                    <div className="font-bold text-orange-600">11-15 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-orange-600">{t('guide.schools.free')} (pubblica)</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-orange-600">8:00-16:00</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.middleDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-body">📍 {t('guide.schools.nearBorderTitle')}:</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-orange-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Chiasso:</strong> {t('guide.schools.middleChiasso')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-orange-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Mendrisio:</strong> {t('guide.schools.middleMendrisio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-orange-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Stabio:</strong> {t('guide.schools.middleStabio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-orange-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Balerna:</strong> {t('guide.schools.middleBalerna')}</span>
                  </div>
                </div>
              </div>
            </div>
          </InfoCard>

          {/* Liceo / Scuole superiori (15-19 anni) */}
          <InfoCard icon={Landmark} title={t('guide.schools.highSchoolTitle')} color="teal">
            <div className="space-y-4">
              <div className="p-4 bg-teal-50 dark:bg-teal-900/20 rounded-xl border border-teal-200 dark:border-teal-800">
                <div className="grid sm:grid-cols-3 gap-3 mb-3">
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.age')}</div>
                    <div className="font-bold text-teal-600">15-19 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-teal-600">{t('guide.schools.free')} / CHF 500-1'500</div>
                  </div>
                  <div className="text-center p-2 bg-surface rounded-lg">
                    <div className="text-sm text-muted">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-teal-600">8:00-16:30</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.highSchoolDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-body">🏫 {t('guide.schools.highSchoolTypes')}:</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-teal-600 flex-shrink-0 mt-0.5" />
                    <span><strong>{t('guide.schools.liceoTitle')}:</strong> {t('guide.schools.liceoDesc')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-teal-600 flex-shrink-0 mt-0.5" />
                    <span><strong>{t('guide.schools.smsTitle')}:</strong> {t('guide.schools.smsDesc')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-teal-600 flex-shrink-0 mt-0.5" />
                    <span><strong>{t('guide.schools.scTitle')}:</strong> {t('guide.schools.scDesc')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-teal-600 flex-shrink-0 mt-0.5" />
                    <span><strong>{t('guide.schools.spcTitle')}:</strong> {t('guide.schools.spcDesc')}</span>
                  </div>
                </div>
              </div>
              <div className="text-xs space-y-2 mt-3">
                <p className="font-bold text-body">📍 {t('guide.schools.mainHighSchools')}:</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="flex items-start gap-2">
                    <MapPin size={14} className="text-teal-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Mendrisio:</strong> {t('guide.schools.highSchoolMendrisio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <MapPin size={14} className="text-teal-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Lugano:</strong> {t('guide.schools.highSchoolLugano')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <MapPin size={14} className="text-teal-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Bellinzona:</strong> {t('guide.schools.highSchoolBellinzona')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <MapPin size={14} className="text-teal-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Locarno:</strong> {t('guide.schools.highSchoolLocarno')}</span>
                  </div>
                </div>
              </div>
            </div>
          </InfoCard>

          {/* ══════════ ELENCO SCUOLE FILTRABILI ══════════ */}
          <SchoolDirectory t={t} />

          {/* Servizi complementari */}
          <div className="grid md:grid-cols-2 gap-6">
            <InfoCard icon={Clock} title={t('guide.schools.servicesTitle')} color="blue">
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>{t('guide.schools.mensa')}:</strong>
                    <div className="text-xs mt-1">{t('guide.schools.mensaDesc')}</div>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>{t('guide.schools.dopoScuola')}:</strong>
                    <div className="text-xs mt-1">{t('guide.schools.dopoScuolaDesc')}</div>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>{t('guide.schools.trasporto')}:</strong>
                    <div className="text-xs mt-1">{t('guide.schools.trasportoDesc')}</div>
                  </div>
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={Euro} title={t('guide.schools.costsTitle')} color="orange">
              <div className="space-y-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-edge">
                        <th className="text-left py-2 font-bold">{t('guide.schools.schoolType')}</th>
                        <th className="text-right py-2 font-bold">{t('guide.schools.annualCost')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      <tr>
                        <td className="py-2">{t('guide.schools.nidoShort')}</td>
                        <td className="py-2 text-right font-bold text-orange-600">CHF 14'400-30'000</td>
                      </tr>
                      <tr>
                        <td className="py-2">{t('guide.schools.kindergartenShort')}</td>
                        <td className="py-2 text-right font-bold text-emerald-700">{t('guide.schools.free')}</td>
                      </tr>
                      <tr>
                        <td className="py-2">{t('guide.schools.primaryShort')}</td>
                        <td className="py-2 text-right font-bold text-emerald-700">{t('guide.schools.free')}</td>
                      </tr>
                      <tr>
                        <td className="py-2">{t('guide.schools.middleShort')}</td>
                        <td className="py-2 text-right font-bold text-emerald-700">{t('guide.schools.free')}</td>
                      </tr>
                      <tr>
                        <td className="py-2">{t('guide.schools.highSchoolShort')}</td>
                        <td className="py-2 text-right font-bold text-blue-600">{t('guide.schools.free')} / CHF 500-1'500</td>
                      </tr>
                      <tr>
                        <td className="py-2">{t('guide.schools.mensaShort')}</td>
                        <td className="py-2 text-right font-bold text-orange-600">CHF 8-15/{t('guide.schools.perDay')}</td>
                      </tr>
                      <tr>
                        <td className="py-2">{t('guide.schools.dopoScuolaShort')}</td>
                        <td className="py-2 text-right font-bold text-orange-600">CHF 15-30/{t('guide.schools.perDay')}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </InfoCard>
          </div>

          {/* Consigli per frontalieri */}
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 rounded-2xl border-2 border-amber-200 dark:border-amber-800 p-6">
            <div className="flex items-start gap-3">
              <AlertCircle size={24} className="text-amber-700 flex-shrink-0" />
              <div className="space-y-3 text-sm text-amber-800 dark:text-amber-200">
                <p className="font-bold">⚠️ {t('guide.schools.importantTitle')}</p>
                <ul className="space-y-1 text-xs">
                  <li>• {t('guide.schools.important1')}</li>
                  <li>• {t('guide.schools.important2')}</li>
                  <li>• {t('guide.schools.important3')}</li>
                  <li>• {t('guide.schools.important4')}</li>
                  <li>• {t('guide.schools.important5')}</li>
                </ul>
                <div className="mt-3 p-3 bg-white/50 dark:bg-slate-800/50 rounded-xl text-xs">
                  <strong>🔗 {t('guide.schools.usefulLinks')}:</strong>
                  <div className="mt-2 space-y-1">
                    <div>• <a href="https://www4.ti.ch/decs/ds/cosa-offre-la-scuola" target="_blank" rel="noopener noreferrer" className="underline font-semibold">DECS - {t('guide.schools.linkDecs')}</a></div>
                    <div>• <a href="https://www.ti.ch/pre-scuola" target="_blank" rel="noopener noreferrer" className="underline font-semibold">{t('guide.schools.linkPreScuola')}</a></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeSection === 'unemployment' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={LifeBuoy}
            title={t('guide.unemployment.title')}
            subtitle={t('guide.unemployment.description')}
          />

          {/* Introduction */}
          <InfoCard icon={AlertCircle} title={t('guide.unemployment.intro.title')} color="orange">
            <p className="text-slate-600 dark:text-slate-300 text-sm leading-relaxed mb-3">{t('guide.unemployment.intro.text')}</p>
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3 text-sm">
              <strong className="text-amber-800 dark:text-amber-300">⚠️ {t('guide.unemployment.intro.important')}</strong>
            </div>
          </InfoCard>

          {/* Switzerland Unemployment */}
          <InfoCard icon={Shield} title={t('guide.unemployment.ch.title')} color="orange">
            <div className="space-y-4">
              {/* Who is entitled */}
              <div className="bg-surface rounded-xl p-5 border border-edge">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Users size={16} className="text-red-500" /> {t('guide.unemployment.ch.whoTitle')}
                </h4>
                <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5">
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="text-green-500 mt-0.5 shrink-0" /> {t('guide.unemployment.ch.who1')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="text-green-500 mt-0.5 shrink-0" /> {t('guide.unemployment.ch.who2')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="text-green-500 mt-0.5 shrink-0" /> {t('guide.unemployment.ch.who3')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="text-green-500 mt-0.5 shrink-0" /> {t('guide.unemployment.ch.who4')}</li>
                </ul>
              </div>

              {/* Amounts */}
              <div className="bg-surface rounded-xl p-5 border border-edge">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Euro size={16} className="text-red-500" /> {t('guide.unemployment.ch.amountsTitle')}
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
                    <div className="text-2xl font-bold text-red-700 dark:text-red-300">70%</div>
                    <div className="text-sm text-muted">{t('guide.unemployment.ch.amount70')}</div>
                  </div>
                  <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
                    <div className="text-2xl font-bold text-red-700 dark:text-red-300">80%</div>
                    <div className="text-sm text-muted">{t('guide.unemployment.ch.amount80')}</div>
                  </div>
                </div>
                <p className="text-sm text-muted mt-2">{t('guide.unemployment.ch.maxInsured')}</p>
              </div>

              {/* Duration */}
              <div className="bg-surface rounded-xl p-5 border border-edge">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Clock size={16} className="text-red-500" /> {t('guide.unemployment.ch.durationTitle')}
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="bg-surface-raised">
                      <th className="p-2 text-left rounded-tl-lg">{t('guide.unemployment.ch.contributionPeriod')}</th>
                      <th className="p-2 text-left">{t('guide.unemployment.ch.age')}</th>
                      <th className="p-2 text-left rounded-tr-lg">{t('guide.unemployment.ch.maxDays')}</th>
                    </tr></thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-600">
                      <tr><td className="p-2">12 {t('guide.unemployment.ch.months')}</td><td className="p-2">&lt; 25</td><td className="p-2 font-bold">200</td></tr>
                      <tr><td className="p-2">12 {t('guide.unemployment.ch.months')}</td><td className="p-2">25+</td><td className="p-2 font-bold">260</td></tr>
                      <tr><td className="p-2">18 {t('guide.unemployment.ch.months')}</td><td className="p-2">25–54</td><td className="p-2 font-bold">400</td></tr>
                      <tr><td className="p-2">22 {t('guide.unemployment.ch.months')}</td><td className="p-2">55+</td><td className="p-2 font-bold">520</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Procedure */}
              <div className="bg-surface rounded-xl p-5 border border-edge">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <FileText size={16} className="text-red-500" /> {t('guide.unemployment.ch.procedureTitle')}
                </h4>
                <ol className="text-sm text-slate-600 dark:text-slate-300 space-y-2">
                  <li className="flex items-start gap-2"><span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">1</span> {t('guide.unemployment.ch.step1')}</li>
                  <li className="flex items-start gap-2"><span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">2</span> {t('guide.unemployment.ch.step2')}</li>
                  <li className="flex items-start gap-2"><span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">3</span> {t('guide.unemployment.ch.step3')}</li>
                  <li className="flex items-start gap-2"><span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">4</span> {t('guide.unemployment.ch.step4')}</li>
                  <li className="flex items-start gap-2"><span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">5</span> {t('guide.unemployment.ch.step5')}</li>
                </ol>
              </div>

              {/* Frontalieri specifics */}
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-5">
                <h4 className="font-bold text-amber-800 dark:text-amber-300 mb-2 flex items-center gap-2">
                  <AlertCircle size={16} /> {t('guide.unemployment.ch.frontalieriTitle')}
                </h4>
                <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5">
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="text-amber-500 mt-0.5 shrink-0" /> {t('guide.unemployment.ch.frontalieri1')}</li>
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="text-amber-500 mt-0.5 shrink-0" /> {t('guide.unemployment.ch.frontalieri2')}</li>
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="text-amber-500 mt-0.5 shrink-0" /> {t('guide.unemployment.ch.frontalieri3')}</li>
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="text-amber-500 mt-0.5 shrink-0" /> {t('guide.unemployment.ch.frontalieri4')}</li>
                </ul>
              </div>
            </div>
          </InfoCard>

          {/* Italy Unemployment (NASpI) */}
          <InfoCard icon={Landmark} title={t('guide.unemployment.it.title')} color="green">
            <div className="space-y-4">
              {/* Who is entitled */}
              <div className="bg-surface rounded-xl p-5 border border-edge">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Users size={16} className="text-green-600" /> {t('guide.unemployment.it.whoTitle')}
                </h4>
                <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5">
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="text-green-500 mt-0.5 shrink-0" /> {t('guide.unemployment.it.who1')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="text-green-500 mt-0.5 shrink-0" /> {t('guide.unemployment.it.who2')}</li>
                  <li className="flex items-start gap-2"><CheckCircle2 size={14} className="text-green-500 mt-0.5 shrink-0" /> {t('guide.unemployment.it.who3')}</li>
                </ul>
              </div>

              {/* Amounts */}
              <div className="bg-surface rounded-xl p-5 border border-edge">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Euro size={16} className="text-green-600" /> {t('guide.unemployment.it.amountsTitle')}
                </h4>
                <div className="text-sm text-slate-600 dark:text-slate-300 space-y-2">
                  <p>{t('guide.unemployment.it.amount1')}</p>
                  <p>{t('guide.unemployment.it.amount2')}</p>
                  <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 mt-2">
                    <div className="text-lg font-bold text-green-700 dark:text-green-300">€ 1.550,42</div>
                    <div className="text-sm text-muted">{t('guide.unemployment.it.maxMonthly')} (2025)</div>
                  </div>
                </div>
              </div>

              {/* Duration */}
              <div className="bg-surface rounded-xl p-5 border border-edge">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Clock size={16} className="text-green-600" /> {t('guide.unemployment.it.durationTitle')}
                </h4>
                <p className="text-sm text-slate-600 dark:text-slate-300">{t('guide.unemployment.it.duration1')}</p>
                <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">{t('guide.unemployment.it.duration2')}</p>
              </div>

              {/* Procedure */}
              <div className="bg-surface rounded-xl p-5 border border-edge">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <FileText size={16} className="text-green-600" /> {t('guide.unemployment.it.procedureTitle')}
                </h4>
                <ol className="text-sm text-slate-600 dark:text-slate-300 space-y-2">
                  <li className="flex items-start gap-2"><span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">1</span> {t('guide.unemployment.it.step1')}</li>
                  <li className="flex items-start gap-2"><span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">2</span> {t('guide.unemployment.it.step2')}</li>
                  <li className="flex items-start gap-2"><span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">3</span> {t('guide.unemployment.it.step3')}</li>
                  <li className="flex items-start gap-2"><span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">4</span> {t('guide.unemployment.it.step4')}</li>
                  <li className="flex items-start gap-2"><span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">5</span> {t('guide.unemployment.it.step5')}</li>
                </ol>
              </div>

              {/* Frontalieri specifics */}
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-5">
                <h4 className="font-bold text-blue-800 dark:text-blue-300 mb-2 flex items-center gap-2">
                  <Info size={16} /> {t('guide.unemployment.it.frontalieriTitle')}
                </h4>
                <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5">
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="text-blue-500 mt-0.5 shrink-0" /> {t('guide.unemployment.it.frontalieri1')}</li>
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="text-blue-500 mt-0.5 shrink-0" /> {t('guide.unemployment.it.frontalieri2')}</li>
                  <li className="flex items-start gap-2"><ArrowRight size={14} className="text-blue-500 mt-0.5 shrink-0" /> {t('guide.unemployment.it.frontalieri3')}</li>
                </ul>
              </div>
            </div>
          </InfoCard>

          {/* Comparison Table */}
          <InfoCard icon={BarChart3} title={t('guide.unemployment.comparison.title')} color="purple">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-raised">
                    <th className="p-3 text-left rounded-tl-lg"></th>
                    <th className="p-3 text-center text-red-600 dark:text-red-400 font-bold">🇨🇭 {t('guide.unemployment.comparison.switzerland')}</th>
                    <th className="p-3 text-center text-green-600 dark:text-green-400 font-bold rounded-tr-lg">🇮🇹 {t('guide.unemployment.comparison.italy')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-600">
                  <tr><td className="p-3 font-medium">{t('guide.unemployment.comparison.name')}</td><td className="p-3 text-center">AD / ALV</td><td className="p-3 text-center">NASpI</td></tr>
                  <tr><td className="p-3 font-medium">{t('guide.unemployment.comparison.amount')}</td><td className="p-3 text-center">70-80%</td><td className="p-3 text-center">75% → 25%</td></tr>
                  <tr><td className="p-3 font-medium">{t('guide.unemployment.comparison.maxDuration')}</td><td className="p-3 text-center">520 {t('guide.unemployment.ch.days')}</td><td className="p-3 text-center">24 {t('guide.unemployment.ch.months')}</td></tr>
                  <tr><td className="p-3 font-medium">{t('guide.unemployment.comparison.deadline')}</td><td className="p-3 text-center">{t('guide.unemployment.comparison.chDeadline')}</td><td className="p-3 text-center">68 {t('guide.unemployment.ch.days')}</td></tr>
                  <tr><td className="p-3 font-medium">{t('guide.unemployment.comparison.body')}</td><td className="p-3 text-center">SECO / URC</td><td className="p-3 text-center">INPS</td></tr>
                  <tr><td className="p-3 font-medium">{t('guide.unemployment.comparison.waitingPeriod')}</td><td className="p-3 text-center">5 {t('guide.unemployment.ch.days')}</td><td className="p-3 text-center">8 {t('guide.unemployment.ch.days')}</td></tr>
                </tbody>
              </table>
            </div>
          </InfoCard>

          {/* NASPI Calculator */}
          <NaspiCalculator />

          {/* Useful Links */}
          <InfoCard icon={Info} title={t('guide.unemployment.links.title')} color="blue">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <a href="https://www.arbeit.swiss" target="_blank" rel="noopener noreferrer" className="bg-surface border border-edge rounded-xl p-3 hover:border-red-400 transition-colors group">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 group-hover:text-red-600">🇨🇭 arbeit.swiss</div>
                <div className="text-sm text-muted">{t('guide.unemployment.links.arbeit')}</div>
              </a>
              <a href="https://www.seco.admin.ch/seco/it/home/Arbeit/Arbeitslosenversicherung.html" target="_blank" rel="noopener noreferrer" className="bg-surface border border-edge rounded-xl p-3 hover:border-red-400 transition-colors group">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 group-hover:text-red-600">🇨🇭 SECO</div>
                <div className="text-sm text-muted">{t('guide.unemployment.links.seco')}</div>
              </a>
              <a href="https://www.inps.it/it/it/dettaglio-scheda.schede-servizio-strumento.schede-servizi.naspi-indennita-mensile-di-disoccupazione-51039.naspi-indennita-mensile-di-disoccupazione.html" target="_blank" rel="noopener noreferrer" className="bg-surface border border-edge rounded-xl p-3 hover:border-green-400 transition-colors group">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 group-hover:text-green-600">🇮🇹 INPS - NASpI</div>
                <div className="text-sm text-muted">{t('guide.unemployment.links.inps')}</div>
              </a>
              <a href="https://www.ti.ch/lav" target="_blank" rel="noopener noreferrer" className="bg-surface border border-edge rounded-xl p-3 hover:border-red-400 transition-colors group">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 group-hover:text-red-600">🇨🇭 URC Ticino</div>
                <div className="text-sm text-muted">{t('guide.unemployment.links.urc')}</div>
              </a>
            </div>
          </InfoCard>
        </div>
      )}

      {activeSection === 'first-day' && (
        <div className="animate-fade-in">
          <Suspense fallback={<div className="flex items-center justify-center min-h-[600px]"><div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-2 border-blue-500 border-t-transparent" /></div>}>
            <FirstDayGuide />
          </Suspense>
        </div>
      )}

      {activeSection === 'car-transfer' && (
        <div className="animate-fade-in">
          <Suspense fallback={<div className="flex items-center justify-center min-h-[600px]"><div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-2 border-indigo-500 border-t-transparent" /></div>}>
            <CarTransferGuide />
          </Suspense>
        </div>
      )}

      {activeSection === 'quiz' && (
        <div className="animate-fade-in">
          <Suspense fallback={<div className="flex items-center justify-center min-h-[400px]"><div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-2 border-indigo-500 border-t-transparent" /></div>}>
            <WeeklyQuiz />
          </Suspense>
        </div>
      )}

      {activeSection === 'glossary' && (
        <div className="animate-fade-in">
          <Suspense fallback={<div className="flex items-center justify-center min-h-[400px]"><div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-2 border-indigo-500 border-t-transparent" /></div>}>
            <Glossary />
          </Suspense>
        </div>
      )}

      {activeSection === 'faq' && (
        <div className="animate-fade-in">
          <Suspense fallback={<div className="flex items-center justify-center min-h-[400px]"><div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-2 border-indigo-500 border-t-transparent" /></div>}>
            <FaqSection />
          </Suspense>
        </div>
      )}



      {/* Welcome banner — shown once, auto-dismisses after 15s */}
      {showBanner && bannerQueueActive && (
        <div
          className={`fixed bottom-20 md:bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:max-w-md z-[55] transition-[opacity,transform] duration-500 ${
            bannerVisible ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
          }`}
        >
          <div className="bg-gradient-to-br from-teal-600 to-emerald-700 text-white rounded-2xl shadow-2xl p-4 sm:p-5 border border-teal-400/30">
            <button
              onClick={dismissBanner}
              className="absolute top-2 right-2 p-2 text-white/70 hover:text-white hover:bg-white/20 rounded-full transition-colors"
              aria-label={t('guide.closeBanner')}
            >
              <X size={16} />
            </button>
            <div className="flex items-start gap-3 pr-6">
              <div className="shrink-0 p-2 bg-white/20 rounded-xl">
                <MapPin size={24} className="text-white" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm sm:text-base font-bold leading-tight">
                  {t('guide.title')}
                </h3>
                <p className="text-xs sm:text-sm text-teal-100 leading-relaxed">
                  {t('guide.subtitle')}
                </p>
              </div>
            </div>
            {/* 15s countdown progress bar — duration is intentional */}
            <div className="mt-3 h-1 bg-white/20 rounded-full overflow-hidden">
              <div className="h-full bg-white/60 rounded-full animate-[shrink_15s_linear_0.5s_forwards]" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FrontierGuide;
