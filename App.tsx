import React, { useState, useEffect } from 'react';
import { InputCard } from '@/components/InputCard';
import { ResultsView } from '@/components/ResultsView';
import { FeedbackSection } from '@/components/FeedbackSection';
import { StatsView } from '@/components/StatsView';
import PensionPlanner from '@/components/PensionPlanner';
import FrontierGuide from '@/components/FrontierGuide';
import { PrivacyPolicy } from '@/components/PrivacyPolicy';
import { DataDeletion } from '@/components/DataDeletion';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { calculateSimulation } from '@/services/calculationService';
import { Analytics } from '@/services/analytics';
import { DEFAULT_INPUTS } from '@/constants';
import { SimulationInputs, SimulationResult } from '@/types';
import { Moon, Sun, Maximize2, Minimize2, Calculator, HelpCircle, BarChart2, PiggyBank, BookOpen, Facebook } from 'lucide-react';

const App: React.FC = () => {
  const [inputs, setInputs] = useState<SimulationInputs>(DEFAULT_INPUTS);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [activeTab, setActiveTab] = useState<'calculator' | 'feedback' | 'stats' | 'pension' | 'guide' | 'privacy' | 'data-deletion'>('calculator');

  // Initialize theme and Analytics
  useEffect(() => {
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
    Analytics.trackEvent('UX', 'Toggle Theme', newMode ? 'Dark' : 'Light');
    
    if (newMode) {
      document.documentElement.classList.add('dark');
      localStorage.theme = 'dark';
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.theme = 'light';
    }
  };

  const handleTabChange = (tab: 'calculator' | 'feedback' | 'stats' | 'pension' | 'guide') => {
    setActiveTab(tab);
    Analytics.trackPageView(`/${tab}`);
  };

  const handleCalculate = () => {
    const res = calculateSimulation(inputs);
    setResult(res);
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
                    Frontaliere Si o No?
                  </h1>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest mt-0.5">Analisi Fiscale 2026</p>
                </div>
              </div>
              
              {/* Navigation Links */}
              <div className="flex items-center gap-1 sm:gap-4 mx-4">
                <button 
                  onClick={() => handleTabChange('calculator')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'calculator' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <Calculator size={16} />
                  <span className="hidden lg:inline">Simulatore</span>
                  {activeTab === 'calculator' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-600 dark:bg-blue-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('guide')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'guide' ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <BookOpen size={16} />
                  <span className="hidden lg:inline">Guida</span>
                  {activeTab === 'guide' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 dark:bg-indigo-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('pension')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'pension' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <PiggyBank size={16} />
                  <span className="hidden lg:inline">Pensione</span>
                  {activeTab === 'pension' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-emerald-600 dark:bg-emerald-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('stats')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'stats' ? 'text-purple-600 dark:text-purple-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <BarChart2 size={16} />
                  <span className="hidden lg:inline">Statistiche</span>
                  {activeTab === 'stats' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-purple-600 dark:bg-purple-400 rounded-full animate-fade-in" />
                  )}
                </button>

                <button 
                  onClick={() => handleTabChange('feedback')}
                  className={`relative px-3 py-2 text-sm font-bold transition-colors flex items-center gap-2 group ${activeTab === 'feedback' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                >
                  <HelpCircle size={16} />
                  <span className="hidden lg:inline">Supporto</span>
                  {activeTab === 'feedback' && (
                    <span className="absolute bottom-0 left-0 w-full h-0.5 bg-amber-600 dark:bg-amber-400 rounded-full animate-fade-in" />
                  )}
                </button>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pl-4 border-l border-slate-200 dark:border-slate-800">
                {activeTab === 'calculator' && (
                  <button 
                    onClick={() => {
                      const newFocus = !isFocusMode;
                      setIsFocusMode(newFocus);
                      Analytics.trackEvent('UX', 'Focus Mode', newFocus ? 'Enabled' : 'Disabled');
                    }}
                    className={`p-2 rounded-xl transition-all ${isFocusMode ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                    title={isFocusMode ? "Esci da Fullscreen" : "Fullscreen"}
                  >
                    {isFocusMode ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
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

        {/* Main Content */}
        <main className="flex-grow max-w-[1800px] w-[95%] mx-auto px-2 sm:px-4 py-6 transition-all duration-500 relative z-10">
          {activeTab === 'calculator' ? (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 h-full">
              <div className={`transition-all duration-500 ease-in-out ${isFocusMode ? 'hidden md:hidden' : 'md:col-span-4 lg:col-span-4 xl:col-span-3'} h-full`}>
                <InputCard 
                  inputs={inputs} 
                  setInputs={setInputs} 
                  onCalculate={handleCalculate}
                  isFocusMode={isFocusMode}
                />
              </div>
              <div className={`transition-all duration-500 ease-in-out ${isFocusMode ? 'md:col-span-12' : 'md:col-span-8 lg:col-span-8 xl:col-span-9'} h-full`}>
                {result && <ResultsView result={result} inputs={inputs} isDarkMode={isDarkMode} isFocusMode={isFocusMode} />}
              </div>
            </div>
          ) : activeTab === 'guide' ? (
            <div className="max-w-7xl mx-auto animate-fade-in">
              <FrontierGuide />
            </div>
          ) : activeTab === 'pension' ? (
            <div className="max-w-7xl mx-auto animate-fade-in">
              <PensionPlanner />
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
          ) : (
            <div className="max-w-4xl mx-auto animate-fade-in">
              <FeedbackSection />
            </div>
          )}
        </main>
        
        <footer className="border-t border-slate-200/60 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm py-8 mt-auto relative z-10">
          <div className="max-w-7xl mx-auto px-4 text-center text-slate-500 dark:text-slate-400 text-sm space-y-3">
            <p className="font-medium">
              © 2026 Frontaliere Si o No? 
              <span className="text-slate-300 dark:text-slate-600 mx-2">|</span> 
              Simulatore a scopo puramente indicativo.
            </p>
            <div className="flex items-center justify-center gap-3 text-xs flex-wrap">
              <button
                onClick={() => setActiveTab('privacy')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 rounded-md transition-all duration-200 border border-slate-200/50 dark:border-slate-700/50 hover:border-indigo-300 dark:hover:border-indigo-700"
              >
                Privacy Policy
              </button>
              <span className="text-slate-300 dark:text-slate-600">•</span>
              <span className="text-slate-400 dark:text-slate-500">Seguici su</span>
              <a 
                href="https://www.facebook.com/profile.php?id=61588174947294" 
                target="_blank" 
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded-md transition-all duration-200 border border-slate-200/50 dark:border-slate-700/50 hover:border-blue-300 dark:hover:border-blue-700"
                aria-label="Seguici su Facebook"
              >
                <Facebook className="w-3.5 h-3.5" />
                <span>Facebook</span>
              </a>
            </div>
          </div>
        </footer>
      </div>
    </ErrorBoundary>
  );
};

export default App;