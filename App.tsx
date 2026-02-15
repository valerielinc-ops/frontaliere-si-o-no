import React, { useState, useEffect, lazy, Suspense } from 'react';
import { InputCard } from '@/components/InputCard';
const ResultsView = lazy(() => import('@/components/ResultsView').then(m => ({ default: m.ResultsView })));
import { ErrorBoundary } from '@/components/ErrorBoundary';
import PwaInstallBanner from '@/components/PwaInstallBanner';
import PwaUpdateBanner from '@/components/PwaUpdateBanner';
import GamificationWidget, { unlockAchievement } from '@/components/GamificationWidget';
import Newsletter from '@/components/Newsletter';
import LanguageSelector from '@/components/LanguageSelector';
import SiteSearch from '@/components/SiteSearch';

// Lazy-loaded components — only loaded when their tab is active
const FeedbackSection = lazy(() => import('@/components/FeedbackSection').then(m => ({ default: m.FeedbackSection })));
const StatsView = lazy(() => import('@/components/StatsView').then(m => ({ default: m.StatsView })));
const PensionPlanner = lazy(() => import('@/components/PensionPlanner'));
const Pillar3Simulator = lazy(() => import('@/components/Pillar3Simulator'));
const FrontierGuide = lazy(() => import('@/components/FrontierGuide'));
const CurrencyExchange = lazy(() => import('@/components/CurrencyExchange'));
const MobileOperators = lazy(() => import('@/components/MobileOperators'));
const TransportCalculator = lazy(() => import('@/components/TransportCalculator'));
const HealthInsurance = lazy(() => import('@/components/HealthInsurance'));
const BankComparison = lazy(() => import('@/components/BankComparison'));
const TrafficAlerts = lazy(() => import('@/components/TrafficAlerts'));
const JobComparator = lazy(() => import('@/components/JobComparator'));
const ShoppingCalculator = lazy(() => import('@/components/ShoppingCalculator'));
const CostOfLiving = lazy(() => import('@/components/CostOfLiving'));
const WhatIfSimulator = lazy(() => import('@/components/WhatIfSimulator'));
const ApiStatus = lazy(() => import('@/components/ApiStatus'));
const PrivacyPolicy = lazy(() => import('@/components/PrivacyPolicy').then(m => ({ default: m.PrivacyPolicy })));
const DataDeletion = lazy(() => import('@/components/DataDeletion').then(m => ({ default: m.DataDeletion })));
const GamificationPage = lazy(() => import('@/components/GamificationPage'));
const RalComparator = lazy(() => import('@/components/RalComparator'));
const ParentalLeaveCalculator = lazy(() => import('@/components/ParentalLeaveCalculator'));
const BorderMunicipalitiesMap = lazy(() => import('@/components/BorderMunicipalitiesMap'));
const ResidencySimulator = lazy(() => import('@/components/ResidencySimulator'));
const PersonalDashboard = lazy(() => import('@/components/PersonalDashboard'));
const CommunityForum = lazy(() => import('@/components/CommunityForum'));
import { calculateSimulation } from '@/services/calculationService';
import { Analytics } from '@/services/analytics';
import { updateMetaTags, trackSectionView } from '@/services/seoService';
import { useTranslation, initLocale, setLocale, onLocaleChange } from '@/services/i18n';
import { parsePath, parseHashToPath, pushRoute, replaceRoute, buildPath, getSeoSection, updatePathForLocale, AppRoute } from '@/services/router';
import { DEFAULT_INPUTS } from '@/constants';
import { SimulationInputs, SimulationResult } from '@/types';
import { Moon, Sun, Maximize2, Minimize2, Calculator, HelpCircle, BarChart2, PiggyBank, BookOpen, Facebook, ArrowRightLeft, Phone, Car, Heart, Building2, AlertTriangle, Layers, Briefcase, Sparkles, TrendingUp, MapPin, ShoppingCart, Euro, ClipboardList, Baby, Map, Home, MessageSquare } from 'lucide-react';

const LazyFallback = () => (
  <div className="flex items-center justify-center py-24">
    <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent" />
  </div>
);

const App: React.FC = () => {
  const { t } = useTranslation();
  const [inputs, setInputs] = useState<SimulationInputs>(DEFAULT_INPUTS);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  // Read initial route from URL path (or migrate legacy hash)
  const [initialRoute] = useState(() => {
    const parsed = parsePath(window.location.pathname);
    // Defer locale side-effect to useEffect to avoid setState-during-render
    return { route: parsed.route, locale: parsed.locale };
  });
  const [activeTab, setActiveTab] = useState<'calculator' | 'feedback' | 'stats' | 'pension' | 'guide' | 'comparatori' | 'privacy' | 'data-deletion' | 'api-status' | 'gamification' | 'dashboard' | 'forum'>(initialRoute.route.activeTab);
  const [comparatoriSubTab, setComparatoriSubTab] = useState<'exchange' | 'mobile' | 'transport' | 'health' | 'banks' | 'traffic' | 'jobs' | 'shopping' | 'cost-of-living' | 'ral' | 'parental-leave' | 'border-map' | 'residency'>(initialRoute.route.comparatoriSubTab || 'exchange');
  const [simulatorSubTab, setSimulatorSubTab] = useState<'calculator' | 'whatif'>(initialRoute.route.simulatorSubTab || 'calculator');
  const [pensionSubTab, setPensionSubTab] = useState<'planner' | 'pillar3'>(initialRoute.route.pensionSubTab || 'planner');
  const [guideSection, setGuideSection] = useState<string>(initialRoute.route.guideSection || 'municipalities');
  const [showApiStatus, setShowApiStatus] = useState(false);

  // Check for hidden API status page via URL parameter
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === 'api' || urlParams.get('status') === 'api') {
      setShowApiStatus(true);
      setActiveTab('api-status');
    }
  }, []);

  // Listen for browser back/forward navigation
  useEffect(() => {
    const onPopState = () => {
      const { route, locale: urlLocale } = parsePath(window.location.pathname);
      setActiveTab(route.activeTab);
      if (route.comparatoriSubTab) setComparatoriSubTab(route.comparatoriSubTab);
      if (route.simulatorSubTab) setSimulatorSubTab(route.simulatorSubTab);
      if (route.pensionSubTab) setPensionSubTab(route.pensionSubTab);
      if (route.guideSection) setGuideSection(route.guideSection);
      // Sync locale from URL
      setLocale(urlLocale);
      // Update SEO meta tags
      const seoKey = getSeoSection(route);
      updateMetaTags(seoKey);
      trackSectionView(seoKey);
    };
    window.addEventListener('popstate', onPopState);
    // When locale changes, rewrite current URL with new locale slugs
    const unsubLocale = onLocaleChange((newLocale) => {
      updatePathForLocale(newLocale);
    });
    return () => {
      window.removeEventListener('popstate', onPopState);
      unsubLocale();
    };
  }, []);

  // Migrate legacy hash-based URLs to clean paths
  useEffect(() => {
    if (window.location.hash && window.location.hash !== '#' && window.location.hash !== '#/') {
      const newPath = parseHashToPath(window.location.hash);
      if (newPath) {
        history.replaceState(null, '', newPath);
      }
    }
  }, []);

  // Initialize theme and Analytics
  useEffect(() => {
    // i18n Init
    initLocale();

    // Analytics Init
    Analytics.init();
    Analytics.trackPageView('/');

    // Theme Init
    if (localStorage.theme === 'dark') {
      setIsDarkMode(true);
      document.documentElement.classList.add('dark');
    } else {
      setIsDarkMode(false);
      document.documentElement.classList.remove('dark');
    }
  }, []);

  const toggleTheme = () => {
    const newMode = !isDarkMode;
    setIsDarkMode(newMode);
    Analytics.trackSettingsChange('theme', newMode ? 'dark' : 'light');
    if (newMode) unlockAchievement('dark_mode_fan');
    
    if (newMode) {
      document.documentElement.classList.add('dark');
      localStorage.theme = 'dark';
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.theme = 'light';
    }
  };

  const handleTabChange = (tab: 'calculator' | 'feedback' | 'stats' | 'pension' | 'guide' | 'comparatori' | 'dashboard' | 'forum') => {
    const previousTab = activeTab;
    setActiveTab(tab);
    Analytics.trackTabNavigation(previousTab, tab);

    // Gamification tracking
    if (tab === 'guide') unlockAchievement('guide_reader');
    if (tab === 'feedback') unlockAchievement('feedback_giver');
    if (tab === 'stats') unlockAchievement('stats_checker');
    if (tab === 'pension') unlockAchievement('pension_planner');

    // Build route and push to history
    const route: AppRoute = { activeTab: tab };
    if (tab === 'comparatori') route.comparatoriSubTab = comparatoriSubTab;
    if (tab === 'calculator') route.simulatorSubTab = simulatorSubTab;
    if (tab === 'pension') route.pensionSubTab = pensionSubTab;
    if (tab === 'guide') route.guideSection = guideSection as any;
    pushRoute(route);

    // Update SEO meta tags for the new section
    const seoKey = getSeoSection(route);
    updateMetaTags(seoKey);
    trackSectionView(seoKey);
  };

  const handleCalculate = () => {
    const res = calculateSimulation(inputs);
    setResult(res);
    unlockAchievement('first_simulation');
    unlockAchievement('simulation_pro');
    Analytics.trackCalculation(
      inputs.workerType,
      inputs.grossSalary,
      inputs.hasChildren
    );
  };

  // Update SEO tags when comparatori sub-tab changes
  useEffect(() => {
    if (activeTab === 'comparatori') {
      const route: AppRoute = { activeTab: 'comparatori', comparatoriSubTab };
      const seoKey = getSeoSection(route);
      updateMetaTags(seoKey);
      trackSectionView(seoKey);
      pushRoute(route);

      // Gamification: track comparator exploration
      unlockAchievement('comparator_curious');
      unlockAchievement('comparator_master');
      if (comparatoriSubTab === 'exchange') unlockAchievement('currency_watcher');
      if (comparatoriSubTab === 'transport') unlockAchievement('transport_planner');
      if (comparatoriSubTab === 'health') unlockAchievement('health_researcher');
    }
  }, [comparatoriSubTab]);

  // Update SEO tags when active tab changes
  useEffect(() => {
    if (activeTab !== 'comparatori') {
      const route: AppRoute = { activeTab };
      if (activeTab === 'calculator') route.simulatorSubTab = simulatorSubTab;
      if (activeTab === 'pension') route.pensionSubTab = pensionSubTab;
      if (activeTab === 'guide') route.guideSection = guideSection as any;
      const seoKey = getSeoSection(route);
      updateMetaTags(seoKey);
      trackSectionView(seoKey);
    }
  }, [activeTab]);

  // Gamification: track guide section visits
  useEffect(() => {
    if (activeTab === 'guide') {
      if (guideSection === 'schools') unlockAchievement('school_finder');
      if (guideSection === 'places') unlockAchievement('map_explorer');
      if (guideSection === 'calendar') unlockAchievement('tax_calendar_user');
    }
  }, [activeTab, guideSection]);

  // Handle search navigation (supports guide sub-sections)
  const handleSearchNavigate = (tab: string, subTab?: string, guideSec?: string) => {
    setActiveTab(tab as any);
    if (tab === 'comparatori' && subTab) {
      setComparatoriSubTab(subTab as any);
    } else if (tab === 'calculator' && subTab === 'whatif') {
      setSimulatorSubTab('whatif');
    } else if (tab === 'pension' && subTab) {
      setPensionSubTab(subTab as any);
    } else if (tab === 'guide' && guideSec) {
      setGuideSection(guideSec);
    }
    const route: AppRoute = { activeTab: tab as any };
    if (tab === 'comparatori' && subTab) route.comparatoriSubTab = subTab as any;
    if (tab === 'calculator') route.simulatorSubTab = (subTab || 'calculator') as any;
    if (tab === 'pension') route.pensionSubTab = (subTab || 'planner') as any;
    if (tab === 'guide') route.guideSection = (guideSec || guideSection) as any;
    pushRoute(route);
    const seoKey = getSeoSection(route);
    updateMetaTags(seoKey);
    trackSectionView(seoKey);
  };

  useEffect(() => {
    handleCalculate();
  }, [inputs]);

  return (
    <ErrorBoundary>
      <div className={`min-h-screen relative flex flex-col font-sans text-slate-800 dark:text-slate-100 transition-colors duration-300 overflow-hidden`}>
        {/* Fun & Modern Background Blobs */}
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 via-slate-50 to-purple-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 -z-20"></div>
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 opacity-60 dark:opacity-30 pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-300 dark:bg-purple-900 rounded-full mix-blend-multiply filter blur-3xl opacity-70 animate-blob"></div>
          <div className="absolute top-0 right-1/4 w-96 h-96 bg-indigo-300 dark:bg-indigo-900 rounded-full mix-blend-multiply filter blur-3xl opacity-70 animate-blob animation-delay-2000"></div>
          <div className="absolute -bottom-32 left-1/3 w-96 h-96 bg-pink-300 dark:bg-pink-900 rounded-full mix-blend-multiply filter blur-3xl opacity-70 animate-blob animation-delay-4000"></div>
        </div>

        {/* Navbar */}
        <nav className="sticky top-0 z-50 bg-white/70 dark:bg-slate-900/70 backdrop-blur-lg border-b border-slate-200/50 dark:border-slate-800/50 shadow-sm transition-all duration-300">
          <div className="max-w-[1800px] w-[95%] mx-auto px-4 sm:px-6">
            <div className="flex justify-between h-16 items-center">
              {/* Logo Section */}
              <div className="flex items-center gap-3 cursor-pointer" onClick={() => handleTabChange('calculator')}>
                <div className="relative group">
                  <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-200"></div>
                  <div className="relative bg-white dark:bg-slate-900 p-2 rounded-xl text-blue-600 dark:text-blue-500 ring-1 ring-slate-200 dark:ring-slate-800">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" className="w-[22px] h-[22px] transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 transition-transform">
                      <rect x="10" y="10" width="80" height="80" rx="16" fill="#1e293b" />
                      <rect x="22" y="22" width="56" height="20" rx="4" fill="#94a3b8" />
                      {/* CH Button */}
                      <rect x="22" y="52" width="24" height="24" rx="6" fill="#dc2626" />
                      <path d="M34 58v12M28 64h12" stroke="white" strokeWidth="3" strokeLinecap="round" />
                      {/* IT Button */}
                      <mask id="m-logo">
                        <rect x="54" y="52" width="24" height="24" rx="6" fill="white" />
                      </mask>
                      <g mask="url(#m-logo)">
                        <rect x="54" y="52" width="8" height="24" fill="#16a34a" />
                        <rect x="62" y="52" width="8" height="24" fill="white" />
                        <rect x="70" y="52" width="8" height="24" fill="#dc2626" />
                      </g>
                    </svg>
                  </div>
                </div>
                <div className="hidden sm:block">
                  <h1 className="text-lg font-bold text-slate-800 dark:text-slate-100 leading-none tracking-tight">
                    {t('app.title')}
                  </h1>
                  <p className="text-[10px] text-slate-500 dark:text-slate-500 font-bold uppercase tracking-widest mt-0.5">{t('nav.subtitle')}</p>
                </div>
              </div>
              
              {/* Navigation Links — hidden on mobile, shown on md+ */}
              <div className="hidden md:flex items-center gap-1 sm:gap-4 mx-4">
                <button 
                  onClick={() => handleTabChange('calculator')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'calculator' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <Calculator size={16} />
                  <span className="hidden lg:inline">{t('nav.simulator')}</span>
                  {activeTab === 'calculator' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-600 dark:bg-blue-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('comparatori')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'comparatori' ? 'text-violet-600 dark:text-violet-400' : 'text-slate-500 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <Layers size={16} />
                  <span className="hidden lg:inline">{t('nav.comparators')}</span>
                  {activeTab === 'comparatori' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-violet-600 dark:bg-violet-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('pension')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'pension' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <PiggyBank size={16} />
                  <span className="hidden lg:inline">{t('nav.pension')}</span>
                  {activeTab === 'pension' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-emerald-600 dark:bg-emerald-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('guide')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'guide' ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <BookOpen size={16} />
                  <span className="hidden lg:inline">{t('nav.guide')}</span>
                  {activeTab === 'guide' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 dark:bg-indigo-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('stats')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'stats' ? 'text-purple-600 dark:text-purple-400' : 'text-slate-500 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <BarChart2 size={16} />
                  <span className="hidden lg:inline">{t('nav.stats')}</span>
                  {activeTab === 'stats' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-purple-600 dark:bg-purple-400 rounded-full animate-fade-in" />
                  )}
                </button>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pl-4 border-l border-slate-200 dark:border-slate-800">
                <SiteSearch onNavigate={handleSearchNavigate} />
                <GamificationWidget onNavigateToPage={() => { setActiveTab('gamification'); }} />
                <LanguageSelector />

                {activeTab === 'calculator' && (
                  <button 
                    onClick={() => {
                      const newFocus = !isFocusMode;
                      setIsFocusMode(newFocus);
                      Analytics.trackFocusMode(newFocus);
                    }}
                    className={`p-2 rounded-xl transition-all ${isFocusMode ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                    title={isFocusMode ? t('app.exitFullscreen') : t('app.fullscreen')}
                    aria-label={isFocusMode ? t('app.exitFullscreen') : t('app.fullscreen')}
                  >
                    {isFocusMode ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
                  </button>
                )}

                <button 
                  onClick={toggleTheme}
                  className="p-2 rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  aria-label={isDarkMode ? t('app.lightMode') : t('app.darkMode')}
                >
                  {isDarkMode ? <Sun size={18} className="text-amber-400" /> : <Moon size={18} className="text-slate-600" />}
                </button>
              </div>
            </div>
          </div>
        </nav>

        {/* Sub-navigation for Comparatori */}
        {activeTab === 'comparatori' && (
          <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
              <div className="grid grid-cols-5 sm:grid-cols-5 md:grid-cols-13 gap-1.5">
                {([
                  { key: 'exchange' as const, icon: ArrowRightLeft, label: t('comparators.exchange') },
                  { key: 'traffic' as const, icon: AlertTriangle, label: t('comparators.traffic') },
                  { key: 'mobile' as const, icon: Phone, label: t('comparators.mobile') },
                  { key: 'banks' as const, icon: Building2, label: t('comparators.banks') },
                  { key: 'health' as const, icon: Heart, label: t('comparators.health') },
                  { key: 'transport' as const, icon: Car, label: t('comparators.transport') },
                  { key: 'jobs' as const, icon: Briefcase, label: t('comparators.jobs') },
                  { key: 'shopping' as const, icon: ShoppingCart, label: t('comparators.shopping') },
                  { key: 'cost-of-living' as const, icon: Euro, label: t('comparators.costOfLiving') },
                  { key: 'ral' as const, icon: ClipboardList, label: t('comparators.ral') },
                  { key: 'parental-leave' as const, icon: Baby, label: t('comparators.parentalLeave') },
                  { key: 'border-map' as const, icon: Map, label: t('comparators.borderMap') },
                  { key: 'residency' as const, icon: Home, label: t('comparators.residency') },
                ] as const).map(({ key, icon: Icon, label }) => (
                  <button
                    key={key}
                    onClick={() => {
                      setComparatoriSubTab(key);
                      Analytics.trackComparatorView(key as any);
                    }}
                    className={`flex flex-col items-center gap-1 px-1 py-2 rounded-xl text-[11px] sm:text-xs font-semibold transition-all ${
                      comparatoriSubTab === key
                        ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 ring-1 ring-violet-300 dark:ring-violet-700'
                        : 'text-slate-500 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon size={18} />
                    <span className="leading-tight text-center w-full line-clamp-2">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Main Content */}
        <main className="flex-grow max-w-[1800px] w-[95%] mx-auto px-2 sm:px-4 py-6 transition-all duration-500 relative z-10">
         <Suspense fallback={<LazyFallback />}>
          {activeTab === 'calculator' ? (
            <div className="space-y-6">
              {/* Simulator sub-tabs */}
              <div className="flex gap-2 bg-white dark:bg-slate-800 rounded-xl p-1.5 border border-slate-200 dark:border-slate-700 max-w-md">
                <button
                  onClick={() => { setSimulatorSubTab('calculator'); pushRoute({ activeTab: 'calculator', simulatorSubTab: 'calculator' }); }}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-bold rounded-lg transition-colors ${
                    simulatorSubTab === 'calculator'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <Calculator size={16} />
                  {t('simulator.calculator')}
                </button>
                <button
                  onClick={() => { setSimulatorSubTab('whatif'); pushRoute({ activeTab: 'calculator', simulatorSubTab: 'whatif' }); unlockAchievement('what_if_dreamer'); }}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-bold rounded-lg transition-colors ${
                    simulatorSubTab === 'whatif'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <Sparkles size={16} />
                  {t('simulator.whatif')}
                </button>
              </div>

              {simulatorSubTab === 'calculator' ? (
                <div className="grid grid-cols-1 md:grid-cols-12 gap-6 h-full">
                  <div className={`transition-all duration-500 ease-in-out md:col-span-4 lg:col-span-4 xl:col-span-3 h-full`}>
                    <InputCard 
                      inputs={inputs} 
                      setInputs={setInputs} 
                      onCalculate={handleCalculate}
                      isFocusMode={false}
                    />
                  </div>
                  <div className={`transition-all duration-500 ease-in-out md:col-span-8 lg:col-span-8 xl:col-span-9 h-full`}>
                    {result && <Suspense fallback={<LazyFallback />}><ResultsView result={result} inputs={inputs} isDarkMode={isDarkMode} isFocusMode={isFocusMode} /></Suspense>}
                  </div>
                </div>
              ) : (
                <div className="max-w-7xl mx-auto">
                  {result && <WhatIfSimulator baseInputs={inputs} baseResult={result} />}
                </div>
              )}
            </div>
          ) : activeTab === 'guide' ? (
            <div className="max-w-7xl mx-auto animate-fade-in">
              <FrontierGuide activeSection={guideSection} />
            </div>
          ) : activeTab === 'pension' ? (
            <div className="max-w-7xl mx-auto animate-fade-in space-y-6">
              {/* Pension sub-tabs */}
              <div className="flex gap-2 bg-white dark:bg-slate-800 rounded-xl p-1.5 border border-slate-200 dark:border-slate-700 max-w-md">
                <button
                  onClick={() => { setPensionSubTab('planner'); pushRoute({ activeTab: 'pension', pensionSubTab: 'planner' }); }}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-bold rounded-lg transition-colors ${
                    pensionSubTab === 'planner'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <PiggyBank size={16} />
                  {t('pension.planner')}
                </button>
                <button
                  onClick={() => { setPensionSubTab('pillar3'); pushRoute({ activeTab: 'pension', pensionSubTab: 'pillar3' }); unlockAchievement('pillar3_saver'); }}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-bold rounded-lg transition-colors ${
                    pensionSubTab === 'pillar3'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <TrendingUp size={16} />
                  {t('pension.pillar3')}
                </button>
              </div>

              {pensionSubTab === 'planner' ? (
                <PensionPlanner />
              ) : (
                <Pillar3Simulator />
              )}
            </div>
          ) : activeTab === 'comparatori' ? (
            <div className="max-w-7xl mx-auto animate-fade-in">
              {comparatoriSubTab === 'exchange' ? (
                <CurrencyExchange />
              ) : comparatoriSubTab === 'mobile' ? (
                <MobileOperators />
              ) : comparatoriSubTab === 'transport' ? (
                <TransportCalculator />
              ) : comparatoriSubTab === 'health' ? (
                <HealthInsurance />
              ) : comparatoriSubTab === 'banks' ? (
                <BankComparison />
              ) : comparatoriSubTab === 'jobs' ? (
                <JobComparator />
              ) : comparatoriSubTab === 'shopping' ? (
                <ShoppingCalculator />
              ) : comparatoriSubTab === 'cost-of-living' ? (
                <CostOfLiving />
              ) : comparatoriSubTab === 'ral' ? (
                <RalComparator />
              ) : comparatoriSubTab === 'parental-leave' ? (
                <ParentalLeaveCalculator />
              ) : comparatoriSubTab === 'border-map' ? (
                <BorderMunicipalitiesMap />
              ) : comparatoriSubTab === 'residency' ? (
                <ResidencySimulator />
              ) : (
                <TrafficAlerts />
              )}
            </div>
          ) : activeTab === 'stats' ? (
            <div className="max-w-5xl mx-auto">
              <StatsView />
            </div>
          ) : activeTab === 'privacy' ? (
            <div className="animate-fade-in">
              <PrivacyPolicy onBack={() => setActiveTab('calculator')} />
            </div>
          ) : activeTab === 'data-deletion' ? (
            <div className="animate-fade-in">
              <DataDeletion />
            </div>
          ) : activeTab === 'gamification' ? (
            <div className="max-w-5xl mx-auto animate-fade-in">
              <GamificationPage />
            </div>
          ) : activeTab === 'dashboard' ? (
            <div className="max-w-7xl mx-auto animate-fade-in">
              <PersonalDashboard currentResult={result} currentInputs={inputs} />
            </div>
          ) : activeTab === 'forum' ? (
            <div className="max-w-4xl mx-auto animate-fade-in">
              <CommunityForum />
            </div>
          ) : activeTab === 'api-status' ? (
            <div className="max-w-5xl mx-auto animate-fade-in">
              <ApiStatus />
            </div>
          ) : (
            <div className="max-w-4xl mx-auto animate-fade-in">
              <FeedbackSection />
            </div>
          )}
         </Suspense>
        </main>

        <footer className="border-t border-slate-200/60 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm py-8 pb-20 md:pb-8 mt-auto relative z-10">
          <div className="max-w-7xl mx-auto px-4 space-y-6">
            {/* Newsletter compact */}
            <div className="max-w-xl mx-auto">
              <Newsletter compact />
            </div>

            <div className="text-center text-slate-500 dark:text-slate-500 text-sm space-y-3">
            <p className="font-medium">
              {t('footer.copyright')}
              <span className="text-slate-300 dark:text-slate-600 mx-2">|</span> 
              {t('footer.disclaimer')}
            </p>
            <div className="flex items-center justify-center gap-3 text-xs flex-wrap">
              <button
                onClick={() => { setActiveTab('feedback'); pushRoute({ activeTab: 'feedback' }); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-amber-50 dark:hover:bg-amber-950/30 rounded-md transition-all duration-200 border border-slate-200/50 dark:border-slate-700/50 hover:border-amber-300 dark:hover:border-amber-700"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>{t('nav.support')}</span>
              </button>
              <span className="text-slate-300 dark:text-slate-600">•</span>
              <button
                onClick={() => { setActiveTab('privacy'); pushRoute({ activeTab: 'privacy' }); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 rounded-md transition-all duration-200 border border-slate-200/50 dark:border-slate-700/50 hover:border-indigo-300 dark:hover:border-indigo-700"
              >
                {t('footer.privacy')}
              </button>
              <span className="text-slate-300 dark:text-slate-600">•</span>
              <button
                onClick={() => {
                  setActiveTab('api-status');
                  pushRoute({ activeTab: 'api-status' });
                  Analytics.trackApiDiagnostics('view');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 rounded-md transition-all duration-200 border border-slate-200/50 dark:border-slate-700/50"
              >
                {t('footer.apiStatus')}
              </button>
              <span className="text-slate-300 dark:text-slate-600">•</span>
              <span className="text-slate-500 dark:text-slate-500">{t('footer.followUs')}</span>
              <a 
                href="https://www.facebook.com/profile.php?id=61588174947294" 
                target="_blank" 
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded-md transition-all duration-200 border border-slate-200/50 dark:border-slate-700/50 hover:border-blue-300 dark:hover:border-blue-700"
                aria-label={t('footer.followFacebook')}
              >
                <Facebook className="w-3.5 h-3.5" />
                <span>Facebook</span>
              </a>
            </div>
            </div>
          </div>
        </footer>
        {/* Mobile Bottom Navigation Bar */}
        <nav className="fixed bottom-0 inset-x-0 z-50 md:hidden bg-white/80 dark:bg-slate-900/80 backdrop-blur-lg border-t border-slate-200/50 dark:border-slate-800/50 pb-[env(safe-area-inset-bottom)]">
          <div className="grid grid-cols-5 h-14">
            {([
              { tab: 'calculator' as const, icon: Calculator, label: t('nav.simulator'), activeClass: 'text-blue-600 dark:text-blue-400', barClass: 'bg-blue-600 dark:bg-blue-400' },
              { tab: 'comparatori' as const, icon: Layers, label: t('nav.comparators'), activeClass: 'text-violet-600 dark:text-violet-400', barClass: 'bg-violet-600 dark:bg-violet-400' },
              { tab: 'pension' as const, icon: PiggyBank, label: t('nav.pension'), activeClass: 'text-emerald-600 dark:text-emerald-400', barClass: 'bg-emerald-600 dark:bg-emerald-400' },
              { tab: 'guide' as const, icon: BookOpen, label: t('nav.guide'), activeClass: 'text-indigo-600 dark:text-indigo-400', barClass: 'bg-indigo-600 dark:bg-indigo-400' },
              { tab: 'stats' as const, icon: BarChart2, label: t('nav.stats'), activeClass: 'text-purple-600 dark:text-purple-400', barClass: 'bg-purple-600 dark:bg-purple-400' },
            ] as const).map(({ tab, icon: Icon, label, activeClass, barClass }) => {
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => handleTabChange(tab)}
                  className={`relative flex flex-col items-center justify-center gap-0.5 transition-colors ${
                    isActive ? activeClass : 'text-slate-500 dark:text-slate-500'
                  }`}
                >
                  <Icon size={20} />
                  <span className="text-[10px] font-semibold leading-none truncate max-w-[56px]">{label}</span>
                  {isActive && (
                    <span className={`absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 ${barClass} rounded-full`} />
                  )}
                </button>
              );
            })}
          </div>
        </nav>

        <PwaInstallBanner />
        <PwaUpdateBanner />
      </div>
    </ErrorBoundary>
  );
};

export default App;