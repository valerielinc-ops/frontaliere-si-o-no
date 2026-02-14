import React, { useState, useEffect } from 'react';
import { InputCard } from '@/components/InputCard';
import { ResultsView } from '@/components/ResultsView';
import { FeedbackSection } from '@/components/FeedbackSection';
import { StatsView } from '@/components/StatsView';
import PensionPlanner from '@/components/PensionPlanner';
import Pillar3Simulator from '@/components/Pillar3Simulator';
import FrontierGuide from '@/components/FrontierGuide';
import CurrencyExchange from '@/components/CurrencyExchange';
import MobileOperators from '@/components/MobileOperators';
import TransportCalculator from '@/components/TransportCalculator';
import HealthInsurance from '@/components/HealthInsurance';
import BankComparison from '@/components/BankComparison';
import TrafficAlerts from '@/components/TrafficAlerts';
import JobComparator from '@/components/JobComparator';
import WhatIfSimulator from '@/components/WhatIfSimulator';
import Newsletter from '@/components/Newsletter';
import LanguageSelector from '@/components/LanguageSelector';
import ApiStatus from '@/components/ApiStatus';
import { PrivacyPolicy } from '@/components/PrivacyPolicy';
import { DataDeletion } from '@/components/DataDeletion';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import PwaInstallBanner from '@/components/PwaInstallBanner';
import { calculateSimulation } from '@/services/calculationService';
import { Analytics } from '@/services/analytics';
import { updateMetaTags, trackSectionView } from '@/services/seoService';
import { useTranslation, initLocale } from '@/services/i18n';
import { parsePath, parseHashToPath, pushRoute, replaceRoute, buildPath, getSeoSection, AppRoute } from '@/services/router';
import { DEFAULT_INPUTS } from '@/constants';
import { SimulationInputs, SimulationResult } from '@/types';
import { Moon, Sun, Maximize2, Minimize2, Calculator, HelpCircle, BarChart2, PiggyBank, BookOpen, Facebook, ArrowRightLeft, Phone, Car, Heart, Building2, AlertTriangle, Layers, Briefcase, Sparkles, TrendingUp, MapPin } from 'lucide-react';

const App: React.FC = () => {
  const { t } = useTranslation();
  const [inputs, setInputs] = useState<SimulationInputs>(DEFAULT_INPUTS);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  // Read initial route from URL path (or migrate legacy hash)
  const initialRoute = parsePath(window.location.pathname);
  const [activeTab, setActiveTab] = useState<'calculator' | 'feedback' | 'stats' | 'pension' | 'guide' | 'comparatori' | 'privacy' | 'data-deletion' | 'api-status'>(initialRoute.activeTab);
  const [comparatoriSubTab, setComparatoriSubTab] = useState<'exchange' | 'mobile' | 'transport' | 'health' | 'banks' | 'traffic' | 'jobs'>(initialRoute.comparatoriSubTab || 'exchange');
  const [simulatorSubTab, setSimulatorSubTab] = useState<'calculator' | 'whatif'>(initialRoute.simulatorSubTab || 'calculator');
  const [pensionSubTab, setPensionSubTab] = useState<'planner' | 'pillar3'>(initialRoute.pensionSubTab || 'planner');
  const [guideSection, setGuideSection] = useState<string>(initialRoute.guideSection || 'municipalities');
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
      const route = parsePath(window.location.pathname);
      setActiveTab(route.activeTab);
      if (route.comparatoriSubTab) setComparatoriSubTab(route.comparatoriSubTab);
      if (route.simulatorSubTab) setSimulatorSubTab(route.simulatorSubTab);
      if (route.pensionSubTab) setPensionSubTab(route.pensionSubTab);
      if (route.guideSection) setGuideSection(route.guideSection);
      // Update SEO meta tags
      const seoKey = getSeoSection(route);
      updateMetaTags(seoKey);
      trackSectionView(seoKey);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
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
    
    if (newMode) {
      document.documentElement.classList.add('dark');
      localStorage.theme = 'dark';
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.theme = 'light';
    }
  };

  const handleTabChange = (tab: 'calculator' | 'feedback' | 'stats' | 'pension' | 'guide' | 'comparatori') => {
    const previousTab = activeTab;
    setActiveTab(tab);
    Analytics.trackTabNavigation(previousTab, tab);

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
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest mt-0.5">{t('nav.subtitle')}</p>
                </div>
              </div>
              
              {/* Navigation Links */}
              <div className="flex items-center gap-1 sm:gap-4 mx-4">
                <button 
                  onClick={() => handleTabChange('calculator')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'calculator' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <Calculator size={16} />
                  <span className="hidden lg:inline">{t('nav.simulator')}</span>
                  {activeTab === 'calculator' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-600 dark:bg-blue-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('comparatori')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'comparatori' ? 'text-violet-600 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <Layers size={16} />
                  <span className="hidden lg:inline">{t('nav.comparators')}</span>
                  {activeTab === 'comparatori' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-violet-600 dark:bg-violet-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('pension')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'pension' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <PiggyBank size={16} />
                  <span className="hidden lg:inline">{t('nav.pension')}</span>
                  {activeTab === 'pension' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-emerald-600 dark:bg-emerald-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('guide')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'guide' ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <BookOpen size={16} />
                  <span className="hidden lg:inline">{t('nav.guide')}</span>
                  {activeTab === 'guide' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 dark:bg-indigo-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('stats')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'stats' ? 'text-purple-600 dark:text-purple-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <BarChart2 size={16} />
                  <span className="hidden lg:inline">{t('nav.stats')}</span>
                  {activeTab === 'stats' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-purple-600 dark:bg-purple-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('feedback')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'feedback' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <HelpCircle size={16} />
                  <span className="hidden lg:inline">{t('nav.support')}</span>
                  {activeTab === 'feedback' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-amber-600 dark:bg-amber-400 rounded-full animate-fade-in" />
                  )}
                </button>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pl-4 border-l border-slate-200 dark:border-slate-800">
                <LanguageSelector />

                {activeTab === 'calculator' && (
                  <button 
                    onClick={() => {
                      const newFocus = !isFocusMode;
                      setIsFocusMode(newFocus);
                      Analytics.trackFocusMode(newFocus);
                    }}
                    className={`p-2 rounded-xl transition-all ${isFocusMode ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                    title={isFocusMode ? t('app.exitFullscreen') : t('app.fullscreen')}
                  >
                    {isFocusMode ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
                  </button>
                )}

                <button 
                  onClick={toggleTheme}
                  className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
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
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex gap-2 py-3 overflow-x-auto">
                <button
                  onClick={() => {
                    setComparatoriSubTab('exchange');
                    Analytics.trackComparatorView('exchange');
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-2 ${comparatoriSubTab === 'exchange' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <ArrowRightLeft size={16} />
                  {t('comparators.exchange')}
                </button>
                <button
                  onClick={() => {
                    setComparatoriSubTab('traffic');
                    Analytics.trackComparatorView('traffic');
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-2 ${comparatoriSubTab === 'traffic' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <AlertTriangle size={16} />
                  {t('comparators.traffic')}
                </button>
                <button
                  onClick={() => {
                    setComparatoriSubTab('mobile');
                    Analytics.trackComparatorView('mobile');
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-2 ${comparatoriSubTab === 'mobile' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <Phone size={16} />
                  {t('comparators.mobile')}
                </button>
                <button
                  onClick={() => {
                    setComparatoriSubTab('banks');
                    Analytics.trackComparatorView('banks');
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-2 ${comparatoriSubTab === 'banks' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <Building2 size={16} />
                  {t('comparators.banks')}
                </button>
                <button
                  onClick={() => {
                    setComparatoriSubTab('health');
                    Analytics.trackComparatorView('health');
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-2 ${comparatoriSubTab === 'health' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <Heart size={16} />
                  {t('comparators.health')}
                </button>
                <button
                  onClick={() => {
                    setComparatoriSubTab('transport');
                    Analytics.trackComparatorView('transport');
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-2 ${comparatoriSubTab === 'transport' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <Car size={16} />
                  {t('comparators.transport')}
                </button>
                <button
                  onClick={() => {
                    setComparatoriSubTab('jobs');
                    Analytics.trackComparatorView('jobs' as any);
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-2 ${comparatoriSubTab === 'jobs' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <Briefcase size={16} />
                  {t('comparators.jobs')}
                </button>

              </div>
            </div>
          </div>
        )}

        {/* Main Content */}
        <main className="flex-grow max-w-[1800px] w-[95%] mx-auto px-2 sm:px-4 py-6 transition-all duration-500 relative z-10">
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
                  onClick={() => { setSimulatorSubTab('whatif'); pushRoute({ activeTab: 'calculator', simulatorSubTab: 'whatif' }); }}
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
                    {result && <ResultsView result={result} inputs={inputs} isDarkMode={isDarkMode} isFocusMode={isFocusMode} />}
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
                  onClick={() => { setPensionSubTab('pillar3'); pushRoute({ activeTab: 'pension', pensionSubTab: 'pillar3' }); }}
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
          ) : activeTab === 'api-status' ? (
            <div className="max-w-5xl mx-auto animate-fade-in">
              <ApiStatus />
            </div>
          ) : (
            <div className="max-w-4xl mx-auto animate-fade-in">
              <FeedbackSection />
            </div>
          )}
        </main>
        
        <footer className="border-t border-slate-200/60 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm py-8 mt-auto relative z-10">
          <div className="max-w-7xl mx-auto px-4 space-y-6">
            {/* Newsletter compact */}
            <div className="max-w-xl mx-auto">
              <Newsletter compact />
            </div>

            <div className="text-center text-slate-500 dark:text-slate-400 text-sm space-y-3">
            <p className="font-medium">
              {t('footer.copyright')}
              <span className="text-slate-300 dark:text-slate-600 mx-2">|</span> 
              {t('footer.disclaimer')}
            </p>
            <div className="flex items-center justify-center gap-3 text-xs flex-wrap">
              <button
                onClick={() => { setActiveTab('privacy'); pushRoute({ activeTab: 'privacy' }); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 rounded-md transition-all duration-200 border border-slate-200/50 dark:border-slate-700/50 hover:border-indigo-300 dark:hover:border-indigo-700"
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
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 rounded-md transition-all duration-200 border border-slate-200/50 dark:border-slate-700/50"
              >
                {t('footer.apiStatus')}
              </button>
              <span className="text-slate-300 dark:text-slate-600">•</span>
              <span className="text-slate-400 dark:text-slate-500">{t('footer.followUs')}</span>
              <a 
                href="https://www.facebook.com/profile.php?id=61588174947294" 
                target="_blank" 
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded-md transition-all duration-200 border border-slate-200/50 dark:border-slate-700/50 hover:border-blue-300 dark:hover:border-blue-700"
                aria-label={t('footer.followFacebook')}
              >
                <Facebook className="w-3.5 h-3.5" />
                <span>Facebook</span>
              </a>
            </div>
            </div>
          </div>
        </footer>
        <PwaInstallBanner />
      </div>
    </ErrorBoundary>
  );
};

export default App;