import React, { useState, useEffect } from 'react';
import { useTranslation } from '../services/i18n';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Clock, TrendingUp, Home, Car, ShoppingCart, FileText, AlertCircle, CheckCircle2, Info, ArrowRight, Building2, Landmark, Shield, Users, Navigation, Timer, BarChart3, Euro, Heart, Briefcase, Calendar } from 'lucide-react';
import { Analytics } from '../services/analytics';
import { updateMetaTags, trackSectionView } from '../services/seoService';
import { pushRoute } from '../services/router';
import TaxCalendar from './TaxCalendar';
import WorkPermitsGuide from './WorkPermitsGuide';
import TicinoCompanies from './TicinoCompanies';
import ShoppingCalculator from './ShoppingCalculator';
import CostOfLiving from './CostOfLiving';
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

type GuideSection = 'municipalities' | 'living-ch' | 'living-it' | 'border' | 'costs' | 'calendar' | 'permits' | 'companies' | 'shopping' | 'cost-of-living';

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
      'shopping': 'shopping',
      'cost-of-living': 'costOfLiving',
      'calendar': 'calendar',
      'permits': 'permits',
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

  const costComparison = [
    { category: t('guide.costs.rent'), switzerland: "1800-2500 CHF", italy: "700-1200 €", note: t('guide.costs.rentNote') },
    { category: t('guide.costs.groceries'), switzerland: "600-800 CHF", italy: "350-500 €", note: t('guide.costs.groceriesNote') },
    { category: t('guide.costs.fuel'), switzerland: "1.85 CHF", italy: "1.75 €", note: t('guide.costs.fuelNote') },
    { category: t('guide.costs.restaurant'), switzerland: "25-40 CHF", italy: "15-25 €", note: t('guide.costs.restaurantNote') },
    { category: t('guide.costs.carInsurance'), switzerland: "800-1200 CHF/anno", italy: "600-1000 €/anno", note: t('guide.costs.carInsuranceNote') },
    { category: t('guide.costs.electricity'), switzerland: "0.20 CHF", italy: "0.25 €", note: t('guide.costs.electricityNote') },
    { category: t('guide.costs.internet'), switzerland: "50-80 CHF", italy: "25-40 €", note: t('guide.costs.internetNote') }
  ];

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
          onClick={() => handleSectionChange('costs')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'costs'
              ? 'bg-emerald-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <Euro size={16} />
          {t('guide.tabs.costs')}
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
          onClick={() => handleSectionChange('shopping')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'shopping'
              ? 'bg-orange-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <ShoppingCart size={16} />
          {t('guide.tabs.shopping')}
        </button>
        <button
          onClick={() => handleSectionChange('cost-of-living')}
          className={`px-4 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
            activeSection === 'cost-of-living'
              ? 'bg-violet-600 text-white shadow-lg scale-105'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
          }`}
        >
          <BarChart3 size={16} />
          {t('guide.tabs.costOfLiving')}
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

      {activeSection === 'costs' && (
        <div className="space-y-6 animate-fade-in">
          <SectionHeader 
            icon={BarChart3} 
            title={t('guide.costs.title')} 
            subtitle={t('guide.costs.subtitle')}
          />

          <div className="overflow-x-auto">
            <table className="w-full bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <thead className="bg-gradient-to-r from-emerald-500 to-teal-600 text-white">
                <tr>
                  <th className="px-6 py-4 text-left font-bold">{t('guide.costs.category')}</th>
                  <th className="px-6 py-4 text-left font-bold">🇨🇭 {t('guide.costs.switzerland')}</th>
                  <th className="px-6 py-4 text-left font-bold">🇮🇹 {t('guide.costs.italy')}</th>
                  <th className="px-6 py-4 text-left font-bold">{t('guide.costs.notes')}</th>
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
            <InfoCard icon={ShoppingCart} title={t('guide.costs.foodTitle')} color="green">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span>{t('guide.costs.bread')}</span>
                  <div className="text-right">
                    <div className="text-sm font-bold text-red-600">CHF 5-6</div>
                    <div className="text-xs text-emerald-600">€ 2-3</div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span>{t('guide.costs.milk')}</span>
                  <div className="text-right">
                    <div className="text-sm font-bold text-red-600">CHF 1.5-2</div>
                    <div className="text-xs text-emerald-600">€ 1.2-1.5</div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span>{t('guide.costs.pasta')}</span>
                  <div className="text-right">
                    <div className="text-sm font-bold text-red-600">CHF 2-3</div>
                    <div className="text-xs text-emerald-600">€ 0.8-1.5</div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span>{t('guide.costs.meat')}</span>
                  <div className="text-right">
                    <div className="text-sm font-bold text-red-600">CHF 25-35</div>
                    <div className="text-xs text-emerald-600">€ 12-18</div>
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                💡 <strong>{t('guide.border.tip')}:</strong> {t('guide.costs.foodTip')}
              </p>
            </InfoCard>

            <InfoCard icon={Home} title={t('guide.costs.housingTitle')} color="orange">
              <div className="space-y-3">
                <div>
                  <div className="font-semibold text-slate-800 dark:text-slate-100 mb-2">{t('guide.costs.monthlyRent')}</div>
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
                  <div className="font-semibold text-slate-800 dark:text-slate-100 mb-2">{t('guide.costs.housePurchase')}</div>
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
          <TaxCalendar />
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

      {activeSection === 'shopping' && (
        <div className="animate-fade-in">
          <ShoppingCalculator />
        </div>
      )}

      {activeSection === 'cost-of-living' && (
        <div className="animate-fade-in">
          <CostOfLiving />
        </div>
      )}
    </div>
  );
};

export default FrontierGuide;
