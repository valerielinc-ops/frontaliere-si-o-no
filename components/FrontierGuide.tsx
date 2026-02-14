import React, { useState, useEffect } from 'react';
import { useTranslation } from '../services/i18n';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Clock, TrendingUp, Home, Car, ShoppingCart, FileText, AlertCircle, CheckCircle2, Info, ArrowRight, Building2, Landmark, Shield, Users, Navigation, Timer, BarChart3, Euro, Heart, Briefcase, Calendar, Mountain, GraduationCap, Baby, BookOpen, LifeBuoy } from 'lucide-react';
import { Analytics } from '../services/analytics';
import { updateMetaTags, trackSectionView } from '../services/seoService';
import { pushRoute } from '../services/router';
import TaxCalendar from './TaxCalendar';
import WorkPermitsGuide from './WorkPermitsGuide';
import TicinoCompanies from './TicinoCompanies';

import { borderCrossings as centralizedBorderCrossings } from '../data/borderCrossings';

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

interface FrontierGuideProps {
  activeSection?: string;
}

type GuideSection = 'municipalities' | 'living-ch' | 'living-it' | 'border' | 'calendar' | 'holidays' | 'permits' | 'companies' | 'places' | 'schools' | 'unemployment';

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
  const [sortBy, setSortBy] = useState<'distance' | 'population'>('population');
  const [filterType, setFilterType] = useState<'all' | 'new' | 'old'>('all');
  const [borderFilter, setBorderFilter] = useState<'all' | 'low-traffic' | '24h' | 'morning' | 'evening'>('all');
  const [selectedTime, setSelectedTime] = useState<'morning' | 'evening' | 'night'>('morning');

  // Track section navigation
  const handleSectionChange = (section: GuideSection) => {
    setInternalSection(section);
    Analytics.trackUIInteraction('guida', 'navigazione', 'tab_sezione', 'cambio', section);

    // Update SEO meta tags for sections with dedicated SEO entries
    const seoMap: Record<string, string> = {
      'calendar': 'calendar',
      'holidays': 'holidays',
      'permits': 'permits',
      'places': 'places',
      'schools': 'schools',
      'unemployment': 'unemployment',
    };
    const seoKey = seoMap[section];
    if (seoKey) {
      updateMetaTags(seoKey);
      trackSectionView(seoKey);
    } else {
      // Reset to guide-level SEO for other sub-sections
      updateMetaTags('guide');
    }

    // Push route to browser history
    pushRoute({ activeTab: 'guide', guideSection: section });
  };

  // Track municipality view
  const handleMunicipalityClick = (municipality: Municipality) => {
    Analytics.trackMunicipalityView(municipality.name, municipality.type);
  };

  // Track map marker click
  const handleMapMarkerClick = (location: string, type: string) => {
    Analytics.trackMapInteraction(type === 'border' ? 'Border Crossings' : 'Municipalities', 'Click Marker', location);
  };

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

  // Dogane Canton Ticino - Italia (fonte centralizzata: data/borderCrossings.ts)
  const borderCrossings = centralizedBorderCrossings.map(c => ({
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
  }));


  return (
    <div className="space-y-8 pb-12">
      {/* Header */}
      <div className="text-center space-y-3 mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl shadow-lg mb-4">
          <MapPin size={32} className="text-white" />
        </div>
        <h1 className="text-4xl font-extrabold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
          {t('guide.title')}
        </h1>
        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
          {t('guide.subtitle')}
        </p>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap gap-2 justify-center mb-8">
        <button
          onClick={() => handleSectionChange('municipalities')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'municipalities'
              ? 'bg-indigo-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <MapPin size={16} />
          {t('guide.tabs.municipalities')}
        </button>
        <button
          onClick={() => handleSectionChange('border')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'border'
              ? 'bg-orange-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Timer size={16} />
          {t('guide.tabs.border')}
        </button>

        <button
          onClick={() => handleSectionChange('living-ch')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'living-ch'
              ? 'bg-red-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Home size={16} />
          {t('guide.tabs.livingCH')}
        </button>
        <button
          onClick={() => handleSectionChange('living-it')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'living-it'
              ? 'bg-green-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Users size={16} />
          {t('guide.tabs.livingIT')}
        </button>
        <button
          onClick={() => handleSectionChange('calendar')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'calendar'
              ? 'bg-purple-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Calendar size={16} />
          {t('guide.tabs.calendar')}
        </button>
        <button
          onClick={() => handleSectionChange('holidays')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'holidays'
              ? 'bg-pink-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Heart size={16} />
          {t('guide.tabs.holidays')}
        </button>
        <button
          onClick={() => handleSectionChange('permits')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'permits'
              ? 'bg-cyan-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Shield size={16} />
          {t('guide.tabs.permits')}
        </button>
        <button
          onClick={() => handleSectionChange('companies')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'companies'
              ? 'bg-teal-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Building2 size={16} />
          {t('guide.tabs.companies')}
        </button>


        <button
          onClick={() => handleSectionChange('places')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'places'
              ? 'bg-emerald-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Mountain size={16} />
          {t('guide.tabs.places')}
        </button>
        <button
          onClick={() => handleSectionChange('schools')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'schools'
              ? 'bg-amber-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <GraduationCap size={16} />
          {t('guide.tabs.schools')}
        </button>
        <button
          onClick={() => handleSectionChange('unemployment')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'unemployment'
              ? 'bg-rose-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <LifeBuoy size={16} />
          {t('guide.tabs.unemployment')}
        </button>
      </div>

      {/* Content Sections */}
      {activeSection === 'municipalities' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={MapPin} 
            title={t('guide.municipalities.title')} 
            subtitle={t('guide.municipalities.subtitle')}
          />

          {/* Filtri e Ordinamento */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
            <div className="flex flex-wrap gap-4 items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300">{t('guide.sortBy')}:</span>
                <button
                  onClick={() => setSortBy('distance')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    sortBy === 'distance'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  📍 {t('guide.distance')}
                </button>
                <button
                  onClick={() => setSortBy('population')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    sortBy === 'population'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  👥 {t('guide.population')}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300">{t('guide.show')}:</span>
                <button
                  onClick={() => setFilterType('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    filterType === 'all'
                      ? 'bg-purple-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {t('guide.all')}
                </button>
                <button
                  onClick={() => setFilterType('new')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    filterType === 'new'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {t('guide.newWithin20km')}
                </button>
                <button
                  onClick={() => setFilterType('old')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    filterType === 'old'
                      ? 'bg-orange-600 text-white shadow-md'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {t('guide.oldBeyond20km')}
                </button>
              </div>
            </div>
          </div>

          {/* Lista Comuni */}
          <div className="grid md:grid-cols-2 gap-4">
            {filteredMunicipalities.map((m, idx) => (
              <div key={idx} className={`bg-gradient-to-br ${m.type === 'new' ? 'from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border-blue-200 dark:border-blue-800' : 'from-orange-50 to-red-50 dark:from-orange-950/30 dark:to-red-950/30 border-orange-200 dark:border-orange-800'} rounded-2xl border-2 p-5 hover:shadow-lg transition-all`}>
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
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3 text-sm">
                      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                        <MapPin size={16} className="text-indigo-600" />
                        <span><strong>{t('guide.province')}:</strong> {m.province}</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                        <Navigation size={16} className="text-emerald-600" />
                        <span><strong>{t('guide.distance')}:</strong> {m.distance} {t('guide.kmFromBorder')}</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                        <Car size={16} className="text-orange-600" />
                        <span><strong>{t('guide.borderCrossing')}:</strong> {m.borderCrossing}</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                        <Users size={16} className="text-purple-600" />
                        <span><strong>{t('guide.population')}:</strong> {m.population.toLocaleString('it-IT')}</span>
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
              <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{t('guide.municipalities.mapTitle')}</h3>
            </div>
            
            {/* Legenda */}
            <div className="flex gap-4 mb-4 flex-wrap text-sm">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-blue-600"></div>
                <span className="text-slate-700 dark:text-slate-300">{t('guide.legendNewOnly')}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-orange-600"></div>
                <span className="text-slate-700 dark:text-slate-300">{t('guide.legendOldOnly')}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-purple-600"></div>
                <span className="text-slate-700 dark:text-slate-300">{t('guide.legendBoth')}</span>
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
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-200 dark:border-amber-800 rounded-2xl p-6">
            <div className="flex items-start gap-3">
              <AlertCircle size={24} className="text-amber-600 flex-shrink-0" />
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
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-4 flex items-center gap-2">
              <BarChart3 size={16} className="text-indigo-500" />
              {t('guide.border.smartFilters')}
            </h3>
            
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <button
                onClick={() => {
                  setBorderFilter('all');
                  const count = borderCrossings.filter(b => b.traffic !== 'closed').length;
                  Analytics.trackBorderFilter('all', count);
                }}
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${borderFilter === 'all' ? 'bg-indigo-500 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
              >
                🔍 {t('guide.all')} ({borderCrossings.filter(b => b.traffic !== 'closed').length})
              </button>
              <button
                onClick={() => {
                  setBorderFilter('low-traffic');
                  const count = borderCrossings.filter(b => b.traffic === 'low').length;
                  Analytics.trackBorderFilter('low-traffic', count);
                }}
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${borderFilter === 'low-traffic' ? 'bg-emerald-500 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
              >
                ✅ {t('guide.border.lowTraffic')} ({borderCrossings.filter(b => b.traffic === 'low').length})
              </button>
              <button
                onClick={() => {
                  setBorderFilter('24h');
                  const count = borderCrossings.filter(b => b.hours === '24h').length;
                  Analytics.trackBorderFilter('24h', count);
                }}
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${borderFilter === '24h' ? 'bg-blue-500 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
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
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${borderFilter === 'morning' ? 'bg-orange-500 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
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
                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${borderFilter === 'evening' ? 'bg-purple-500 text-white shadow-lg' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'}`}
              >
                🌆 {t('guide.border.fastEvening')}
              </button>
            </div>

            {/* Time selector */}
            <div className="mt-4 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
              <div className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
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
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${selectedTime === 'morning' ? 'bg-orange-500 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}
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
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${selectedTime === 'evening' ? 'bg-purple-500 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}
                >
                  🌆 {t('guide.border.evening')} (17-19)
                </button>
                <button
                  onClick={() => {
                    setSelectedTime('night');
                    const count = borderCrossings.filter(b => b.hours === '24h' && b.traffic === 'low').length;
                    Analytics.trackBorderTimeSelection('night', count);
                  }}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${selectedTime === 'night' ? 'bg-indigo-500 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}
                >
                  🌙 {t('guide.border.night')}
                </button>
              </div>
            </div>
          </div>

          {/* Interactive Map */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-4 flex items-center gap-2">
              <MapPin size={16} className="text-red-500" />
              {t('guide.border.interactiveMap')}
            </h3>
            <div className="h-[500px] rounded-xl overflow-hidden border-2 border-slate-200 dark:border-slate-700">
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
                            <div className="font-bold text-slate-800 mb-1">{border.name}</div>
                            <div className="text-xs text-slate-600 mb-2">📍 {border.italianSide}</div>
                            <div className="text-xs space-y-1">
                              <div><strong>🌅 {t('guide.border.morning')}:</strong> {border.avgWaitMorning}</div>
                              <div><strong>🌆 {t('guide.border.evening')}:</strong> {border.avgWaitEvening}</div>
                              <div><strong>⏰ {t('guide.border.hours')}:</strong> {t(border.hours)}</div>
                              <div className="pt-2 border-t border-slate-200">
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
            <div className="mt-3 flex items-center justify-center gap-6 text-xs">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500 border-2 border-white"></div>
                <span className="text-slate-600 dark:text-slate-400">{t('guide.border.highTraffic')}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-orange-500 border-2 border-white"></div>
                <span className="text-slate-600 dark:text-slate-400">{t('guide.border.mediumTraffic')}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-white"></div>
                <span className="text-slate-600 dark:text-slate-400">{t('guide.border.lowTrafficLabel')}</span>
              </div>
            </div>
          </div>

          {/* Border Crossings Grid */}
          <div className="grid md:grid-cols-2 gap-4">
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
              })
              .map((border, idx) => {
                const isRecommended = 
                  (selectedTime === 'morning' && parseInt(border.avgWaitMorning.split('-')[1]) <= 8) ||
                  (selectedTime === 'evening' && parseInt(border.avgWaitEvening.split('-')[1]) <= 12) ||
                  (selectedTime === 'night' && border.hours === '24h' && border.traffic === 'low');

                return (
                  <div 
                    key={idx} 
                    className={`bg-white dark:bg-slate-800 rounded-2xl border-2 p-5 hover:shadow-lg transition-all ${isRecommended ? 'border-emerald-500 ring-2 ring-emerald-500/20' : 'border-slate-200 dark:border-slate-700'}`}
                  >
                    {isRecommended && (
                      <div className="mb-3 px-3 py-1.5 bg-emerald-500 text-white text-xs font-bold rounded-full inline-flex items-center gap-1.5">
                        ⭐ {t('guide.border.recommendedFor')} {selectedTime === 'morning' ? t('guide.border.morning') : selectedTime === 'evening' ? t('guide.border.evening') : t('guide.border.night')}
                      </div>
                    )}
                    
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`p-2 rounded-lg ${border.traffic === 'high' ? 'bg-red-500' : border.traffic === 'medium' ? 'bg-orange-500' : 'bg-emerald-500'}`}>
                        <Navigation className="text-white" size={18} />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{border.name}</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400">📍 {border.italianSide}</p>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-600 dark:text-slate-400">{t('guide.border.waitMorning')} (🌅 7-9)</span>
                        <span className={`text-sm font-bold ${selectedTime === 'morning' ? 'text-orange-600' : 'text-slate-600'}`}>{border.avgWaitMorning}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-600 dark:text-slate-400">{t('guide.border.waitEvening')} (🌆 17-19)</span>
                        <span className={`text-sm font-bold ${selectedTime === 'evening' ? 'text-purple-600' : 'text-slate-600'}`}>{border.avgWaitEvening}</span>
                      </div>
                      <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                        <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">⏰ {t('guide.border.openingHours')}</div>
                        <div className={`text-sm font-semibold ${border.hours === '24h' ? 'text-emerald-600' : 'text-orange-600'}`}>{t(border.hours)}</div>
                      </div>
                      <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                        <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">🔴 {t('guide.border.peakHours')}</div>
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">{t(border.peak)}</div>
                      </div>
                      <div className="p-2.5 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                        <div className="text-xs text-blue-700 dark:text-blue-300">
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
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro1Title')}:</strong> {t('guide.livingCH.pro1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro2Title')}:</strong> {t('guide.livingCH.pro2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro3Title')}:</strong> {t('guide.livingCH.pro3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro4Title')}:</strong> {t('guide.livingCH.pro4')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro5Title')}:</strong> {t('guide.livingCH.pro5')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingCH.pro6Title')}:</strong> {t('guide.livingCH.pro6')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
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
                    <CheckCircle2 size={18} className="text-emerald-600" />
                    <strong className="text-emerald-700 dark:text-emerald-300">✅ {t('guide.livingCH.capitalGainTitle')}</strong>
                  </div>
                  <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">
                    {t('guide.livingCH.capitalGainDesc')}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    💡 {t('guide.livingCH.capitalGainNote')}
                  </p>
                </div>

                <div className="p-4 bg-orange-50 dark:bg-orange-900/20 rounded-xl border-2 border-orange-200 dark:border-orange-800">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle size={18} className="text-orange-600" />
                    <strong className="text-orange-700 dark:text-orange-300">⚠️ {t('guide.livingCH.wealthTaxTitle')}</strong>
                  </div>
                  <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">
                    {t('guide.livingCH.wealthTaxDesc')}
                  </p>
                  <div className="text-xs space-y-1 text-slate-600 dark:text-slate-400">
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
                  <p className="text-sm text-slate-700 dark:text-slate-300 mb-3">
                    {t('guide.livingCH.taxFreeDesc')}
                  </p>
                  <div className="space-y-2 text-xs text-slate-600 dark:text-slate-400">
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
                  <strong className="text-emerald-600">{t('guide.livingIT.healthOpt2')}</strong>
                  <div className="text-xs mt-1">{t('guide.livingIT.healthOpt2Desc')}</div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-xs text-blue-700 dark:text-blue-300">
                  💡 {t('guide.livingIT.healthTip')}
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={Briefcase} title={t('guide.livingIT.prosTitle')} color="green">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.pro1Title')}:</strong> {t('guide.livingIT.pro1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.pro2Title')}:</strong> {t('guide.livingIT.pro2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.pro3Title')}:</strong> {t('guide.livingIT.pro3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  <span><strong>{t('guide.livingIT.pro4Title')}:</strong> {t('guide.livingIT.pro4')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
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

          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30 rounded-2xl border-2 border-indigo-200 dark:border-indigo-800 p-6">
            <div className="flex items-start gap-3">
              <Info size={24} className="text-indigo-600 flex-shrink-0" />
              <div className="space-y-3 text-sm text-indigo-800 dark:text-indigo-200">
                <p className="font-bold">📋 {t('guide.livingIT.checklistTitle')}</p>
                <div className="grid sm:grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>{t('guide.livingIT.check1')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>{t('guide.livingIT.check2')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>{t('guide.livingIT.check3')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>{t('guide.livingIT.check4')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>{t('guide.livingIT.check5')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-indigo-600" />
                    <span>{t('guide.livingIT.check6')}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeSection === 'calendar' && (
        <div className="animate-fade-in">
          <TaxCalendar initialTab="fiscal" />
        </div>
      )}

      {activeSection === 'holidays' && (
        <div className="animate-fade-in">
          <TaxCalendar initialTab="holidays" />
        </div>
      )}

      {activeSection === 'permits' && (
        <div className="animate-fade-in">
          <WorkPermitsGuide />
        </div>
      )}

      {activeSection === 'companies' && (
        <div className="animate-fade-in">
          <TicinoCompanies />
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
                  <img src="/images/places/monte-san-salvatore.jpg" alt="Monte San Salvatore" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-emerald-700 dark:text-emerald-300 mb-1">🏔️ Monte San Salvatore</div>
                  <p className="text-xs">{t('guide.places.sanSalvatore')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    <MapPin size={12} /> Lugano · <Clock size={12} /> {t('guide.places.funicular')}: 12 min
                  </div>
                </div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                  <img src="/images/places/monte-bre.jpg" alt="Monte Brè" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-emerald-700 dark:text-emerald-300 mb-1">🏔️ Monte Brè</div>
                  <p className="text-xs">{t('guide.places.monteBreDesc')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    <MapPin size={12} /> Lugano · <Clock size={12} /> {t('guide.places.funicular')}: 15 min
                  </div>
                </div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                  <img src="/images/places/monte-generoso.jpg" alt="Monte Generoso" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-emerald-700 dark:text-emerald-300 mb-1">🏔️ Monte Generoso</div>
                  <p className="text-xs">{t('guide.places.monteGeneroso')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    <MapPin size={12} /> Capolago · <Clock size={12} /> {t('guide.places.cograil')}: 40 min
                  </div>
                </div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                  <img src="/images/places/gandria.jpg" alt="Sentiero dell'Olivo" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-emerald-700 dark:text-emerald-300 mb-1">🥾 Sentiero dell'Olivo</div>
                  <p className="text-xs">{t('guide.places.sentieroOlivo')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    <MapPin size={12} /> Gandria-Castagnola · <Clock size={12} /> ~2h
                  </div>
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={Heart} title={t('guide.places.lakesTitle')} color="blue">
              <div className="space-y-4">
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <img src="/images/places/lago-lugano.jpg" alt="Lago di Lugano" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🌊 Lago di Lugano (Ceresio)</div>
                  <p className="text-xs">{t('guide.places.lagoCeresio')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    <Navigation size={12} /> {t('guide.places.lakeActivities')}
                  </div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <img src="/images/places/ascona.jpg" alt="Lago Maggiore" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🌊 Lago Maggiore</div>
                  <p className="text-xs">{t('guide.places.lagoMaggiore')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    <Navigation size={12} /> Locarno, Ascona, Brissago
                  </div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <img src="/images/places/foroglio.jpg" alt="Cascata di Foroglio" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">💧 Cascata di Foroglio</div>
                  <p className="text-xs">{t('guide.places.foroglio')}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
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
                  <img src="/images/places/lugano-view.jpg" alt="Lugano" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-purple-700 dark:text-purple-300 mb-1">🏙️ Lugano</div>
                  <p className="text-xs">{t('guide.places.luganoDesc')}</p>
                </div>
                <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-xl">
                  <img src="/images/places/locarno.jpg" alt="Locarno & Ascona" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-purple-700 dark:text-purple-300 mb-1">🌴 Locarno & Ascona</div>
                  <p className="text-xs">{t('guide.places.locarnoDesc')}</p>
                </div>
                <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-xl">
                  <img src="/images/places/bellinzona.jpg" alt="Bellinzona" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-purple-700 dark:text-purple-300 mb-1">🏰 Bellinzona</div>
                  <p className="text-xs">{t('guide.places.bellinzonaDesc')}</p>
                </div>
                <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-xl">
                  <img src="/images/places/mendrisio.jpg" alt="Mendrisio" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-purple-700 dark:text-purple-300 mb-1">🏘️ Mendrisio</div>
                  <p className="text-xs">{t('guide.places.mendrisioDesc')}</p>
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={Landmark} title={t('guide.places.cultureTitle')} color="orange">
              <div className="space-y-4">
                <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-xl">
                  <img src="/images/places/film-festival.jpg" alt="Film Festival Locarno" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-orange-700 dark:text-orange-300 mb-1">🎬 Film Festival Locarno</div>
                  <p className="text-xs">{t('guide.places.filmFestival')}</p>
                  <div className="mt-1 text-xs text-slate-500">📅 {t('guide.places.august')}</div>
                </div>
                <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-xl">
                  <img src="/images/places/lac-lugano.jpg" alt="LAC Lugano Arte e Cultura" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-orange-700 dark:text-orange-300 mb-1">🎨 LAC Lugano Arte e Cultura</div>
                  <p className="text-xs">{t('guide.places.lacDesc')}</p>
                </div>
                <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-xl">
                  <img src="/images/places/castelgrande.jpg" alt="Castelli di Bellinzona" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
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
                  <img src="/images/places/swissminiatur.jpg" alt="Swissminiatur" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-teal-700 dark:text-teal-300 mb-1">🌿 Swissminiatur</div>
                  <p className="text-xs">{t('guide.places.swissminiatur')}</p>
                  <div className="mt-1 text-xs text-slate-500"><MapPin size={12} className="inline" /> Melide · 💰 CHF 19/adulto</div>
                </div>
                <div className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-xl">
                  <div className="font-bold text-teal-700 dark:text-teal-300 mb-1">🦁 Parco Civico Lugano</div>
                  <p className="text-xs">{t('guide.places.parcoCivico')}</p>
                  <div className="mt-1 text-xs text-slate-500"><MapPin size={12} className="inline" /> Lugano · 💰 {t('guide.places.free')}</div>
                </div>
                <div className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-xl">
                  <div className="font-bold text-teal-700 dark:text-teal-300 mb-1">🏊 Lido di Lugano</div>
                  <p className="text-xs">{t('guide.places.lidoLugano')}</p>
                  <div className="mt-1 text-xs text-slate-500"><MapPin size={12} className="inline" /> Lugano · 💰 CHF 10/adulto</div>
                </div>
                <div className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-xl">
                  <div className="font-bold text-teal-700 dark:text-teal-300 mb-1">🚂 Ferrovia Monte Generoso</div>
                  <p className="text-xs">{t('guide.places.ferroviaGeneroso')}</p>
                  <div className="mt-1 text-xs text-slate-500"><MapPin size={12} className="inline" /> Capolago · 💰 CHF 70/A-R</div>
                </div>
              </div>
            </InfoCard>

            <InfoCard icon={ShoppingCart} title={t('guide.places.shoppingTitle')} color="blue">
              <div className="space-y-4">
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <img src="/images/places/foxtown.jpg" alt="FoxTown Factory Stores" className="w-full h-32 object-cover rounded-lg mb-2" loading="lazy" />
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🛍️ FoxTown Factory Stores</div>
                  <p className="text-xs">{t('guide.places.foxtown')}</p>
                  <div className="mt-1 text-xs text-slate-500"><MapPin size={12} className="inline" /> Mendrisio · <Navigation size={12} className="inline" /> 5 min {t('guide.places.fromBorder')}</div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🛒 Centro Commerciale Lugano Sud</div>
                  <p className="text-xs">{t('guide.places.luganoSud')}</p>
                  <div className="mt-1 text-xs text-slate-500"><MapPin size={12} className="inline" /> Grancia</div>
                </div>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
                  <div className="font-bold text-blue-700 dark:text-blue-300 mb-1">🏬 Manor Lugano</div>
                  <p className="text-xs">{t('guide.places.manorDesc')}</p>
                  <div className="mt-1 text-xs text-slate-500"><MapPin size={12} className="inline" /> Lugano centro</div>
                </div>
              </div>
            </InfoCard>
          </div>

          {/* Consiglio per frontalieri */}
          <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 p-6">
            <div className="flex items-start gap-3">
              <Info size={24} className="text-emerald-600 flex-shrink-0" />
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
              <Info size={24} className="text-amber-600 flex-shrink-0" />
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
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.age')}</div>
                    <div className="font-bold text-purple-600">0-3 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-purple-600">CHF 1'200-2'500/{t('guide.schools.month')}</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-purple-600">7:00-18:30</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.nidoDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-slate-700 dark:text-slate-300">📍 {t('guide.schools.nearBorderTitle')}:</p>
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
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.age')}</div>
                    <div className="font-bold text-emerald-600">3-6 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-emerald-600">{t('guide.schools.free')} (pubblica)</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-emerald-600">8:30-15:30</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.kindergartenDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-slate-700 dark:text-slate-300">📍 {t('guide.schools.nearBorderTitle')}:</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Chiasso:</strong> {t('guide.schools.kindergartenChiasso')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Mendrisio:</strong> {t('guide.schools.kindergartenMendrisio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                    <span><strong>Stabio:</strong> {t('guide.schools.kindergartenStabio')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-emerald-600 flex-shrink-0 mt-0.5" />
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
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.age')}</div>
                    <div className="font-bold text-blue-600">6-11 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-blue-600">{t('guide.schools.free')} (pubblica)</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-blue-600">8:15-15:45</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.primaryDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-slate-700 dark:text-slate-300">📍 {t('guide.schools.nearBorderTitle')}:</p>
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
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.age')}</div>
                    <div className="font-bold text-orange-600">11-15 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-orange-600">{t('guide.schools.free')} (pubblica)</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-orange-600">8:00-16:00</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.middleDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-slate-700 dark:text-slate-300">📍 {t('guide.schools.nearBorderTitle')}:</p>
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
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.age')}</div>
                    <div className="font-bold text-teal-600">15-19 {t('guide.schools.years')}</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.cost')}</div>
                    <div className="font-bold text-teal-600">{t('guide.schools.free')} / CHF 500-1'500</div>
                  </div>
                  <div className="text-center p-2 bg-white dark:bg-slate-800 rounded-lg">
                    <div className="text-xs text-slate-500">{t('guide.schools.hours')}</div>
                    <div className="font-bold text-teal-600">8:00-16:30</div>
                  </div>
                </div>
                <p className="text-xs">{t('guide.schools.highSchoolDesc')}</p>
              </div>
              <div className="text-xs space-y-2">
                <p className="font-bold text-slate-700 dark:text-slate-300">🏫 {t('guide.schools.highSchoolTypes')}:</p>
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
                <p className="font-bold text-slate-700 dark:text-slate-300">📍 {t('guide.schools.mainHighSchools')}:</p>
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
                      <tr className="border-b border-slate-200 dark:border-slate-700">
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
                        <td className="py-2 text-right font-bold text-emerald-600">{t('guide.schools.free')}</td>
                      </tr>
                      <tr>
                        <td className="py-2">{t('guide.schools.primaryShort')}</td>
                        <td className="py-2 text-right font-bold text-emerald-600">{t('guide.schools.free')}</td>
                      </tr>
                      <tr>
                        <td className="py-2">{t('guide.schools.middleShort')}</td>
                        <td className="py-2 text-right font-bold text-emerald-600">{t('guide.schools.free')}</td>
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
              <AlertCircle size={24} className="text-amber-600 flex-shrink-0" />
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
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
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
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Euro size={16} className="text-red-500" /> {t('guide.unemployment.ch.amountsTitle')}
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
                    <div className="text-2xl font-extrabold text-red-700 dark:text-red-300">70%</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{t('guide.unemployment.ch.amount70')}</div>
                  </div>
                  <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
                    <div className="text-2xl font-extrabold text-red-700 dark:text-red-300">80%</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{t('guide.unemployment.ch.amount80')}</div>
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">{t('guide.unemployment.ch.maxInsured')}</p>
              </div>

              {/* Duration */}
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Clock size={16} className="text-red-500" /> {t('guide.unemployment.ch.durationTitle')}
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="bg-slate-100 dark:bg-slate-700">
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
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
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
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
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
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
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
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Euro size={16} className="text-green-600" /> {t('guide.unemployment.it.amountsTitle')}
                </h4>
                <div className="text-sm text-slate-600 dark:text-slate-300 space-y-2">
                  <p>{t('guide.unemployment.it.amount1')}</p>
                  <p>{t('guide.unemployment.it.amount2')}</p>
                  <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 mt-2">
                    <div className="text-lg font-extrabold text-green-700 dark:text-green-300">€ 1.550,42</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{t('guide.unemployment.it.maxMonthly')} (2025)</div>
                  </div>
                </div>
              </div>

              {/* Duration */}
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <Clock size={16} className="text-green-600" /> {t('guide.unemployment.it.durationTitle')}
                </h4>
                <p className="text-sm text-slate-600 dark:text-slate-300">{t('guide.unemployment.it.duration1')}</p>
                <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">{t('guide.unemployment.it.duration2')}</p>
              </div>

              {/* Procedure */}
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
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
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
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
                  <tr className="bg-slate-100 dark:bg-slate-700">
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

          {/* Useful Links */}
          <InfoCard icon={Info} title={t('guide.unemployment.links.title')} color="blue">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <a href="https://www.arbeit.swiss" target="_blank" rel="noopener noreferrer" className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 hover:border-red-400 transition-colors group">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 group-hover:text-red-600">🇨🇭 arbeit.swiss</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('guide.unemployment.links.arbeit')}</div>
              </a>
              <a href="https://www.seco.admin.ch/seco/it/home/Arbeit/Arbeitslosenversicherung.html" target="_blank" rel="noopener noreferrer" className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 hover:border-red-400 transition-colors group">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 group-hover:text-red-600">🇨🇭 SECO</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('guide.unemployment.links.seco')}</div>
              </a>
              <a href="https://www.inps.it/it/it/dettaglio-scheda.schede-servizio-strumento.schede-servizi.naspi-indennita-mensile-di-disoccupazione-51039.naspi-indennita-mensile-di-disoccupazione.html" target="_blank" rel="noopener noreferrer" className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 hover:border-green-400 transition-colors group">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 group-hover:text-green-600">🇮🇹 INPS - NASpI</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('guide.unemployment.links.inps')}</div>
              </a>
              <a href="https://www.ti.ch/lav" target="_blank" rel="noopener noreferrer" className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 hover:border-red-400 transition-colors group">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 group-hover:text-red-600">🇨🇭 URC Ticino</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('guide.unemployment.links.urc')}</div>
              </a>
            </div>
          </InfoCard>
        </div>
      )}
    </div>
  );
};

export default FrontierGuide;
