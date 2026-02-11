import React, { useState, useEffect } from 'react';
import { InputCard } from './components/InputCard';
import { ResultsView } from './components/ResultsView';
import { calculateSimulation } from './services/calculationService';
import { DEFAULT_INPUTS } from './constants';
import { SimulationInputs, SimulationResult } from './types';
import { Rocket, Moon, Sun } from 'lucide-react';

const App: React.FC = () => {
  const [inputs, setInputs] = useState<SimulationInputs>(DEFAULT_INPUTS);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Initialize theme from localStorage (defaulting to Light if not set)
  useEffect(() => {
    if (localStorage.theme === 'dark') {
      setIsDarkMode(true);
      document.documentElement.classList.add('dark');
    } else {
      setIsDarkMode(false);
      document.documentElement.classList.remove('dark');
    }
  }, []);

  const toggleTheme = () => {
    if (isDarkMode) {
      document.documentElement.classList.remove('dark');
      localStorage.theme = 'light';
      setIsDarkMode(false);
    } else {
      document.documentElement.classList.add('dark');
      localStorage.theme = 'dark';
      setIsDarkMode(true);
    }
  };

  const handleCalculate = () => {
    const res = calculateSimulation(inputs);
    setResult(res);
  };

  // Live calculation whenever inputs change
  React.useEffect(() => {
    handleCalculate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 flex flex-col font-sans text-slate-800 dark:text-slate-100 transition-colors duration-300">
      {/* Navbar with Glassmorphism */}
      <nav className="sticky top-0 z-50 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-white/20 dark:border-slate-800/50 shadow-sm transition-all duration-300">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center gap-3 group cursor-default">
              <div className="bg-gradient-to-br from-blue-600 to-indigo-600 p-2.5 rounded-xl text-white shadow-lg shadow-blue-500/30 transform group-hover:scale-110 transition-transform duration-300">
                <Rocket size={24} />
              </div>
              <div>
                <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-800 to-slate-600 dark:from-slate-100 dark:to-slate-400 leading-none">
                  Frontaliere Si o No?
                </h1>
                <p className="text-xs text-blue-500 dark:text-blue-400 font-semibold tracking-wide mt-0.5">Analisi Fiscale 2026</p>
              </div>
            </div>
            
            <button 
              onClick={toggleTheme}
              className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
              aria-label="Toggle Dark Mode"
            >
              {isDarkMode ? <Sun size={20} className="text-yellow-400" /> : <Moon size={20} className="text-slate-600" />}
            </button>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-full">
          
          {/* Input Section - Slight delay animation */}
          <div className="lg:col-span-4 h-full animate-fade-in-up">
             <InputCard 
               inputs={inputs} 
               setInputs={setInputs} 
               onCalculate={handleCalculate} 
             />
          </div>

          {/* Output Section - Staggered animation */}
          <div className="lg:col-span-8 h-full animate-fade-in-up delay-100">
            {result ? (
              <ResultsView result={result} isDarkMode={isDarkMode} />
            ) : (
              <div className="h-full min-h-[400px] flex items-center justify-center bg-white/60 dark:bg-slate-900/60 backdrop-blur-sm rounded-3xl shadow-sm border border-white/50 dark:border-slate-800 text-slate-400 dark:text-slate-600">
                <div className="text-center animate-pulse">
                   <div className="mx-auto bg-slate-100 dark:bg-slate-800 w-16 h-16 rounded-full flex items-center justify-center mb-4 text-slate-300 dark:text-slate-600">
                      <Rocket size={32} />
                   </div>
                   <p className="font-medium">Caricamento calcolatore...</p>
                </div>
              </div>
            )}
          </div>

        </div>
      </main>
      
      {/* Footer */}
      <footer className="border-t border-slate-200/60 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm py-8 mt-auto">
        <div className="max-w-7xl mx-auto px-4 text-center text-slate-500 dark:text-slate-400 text-sm">
          <p className="font-medium">© 2026 Frontaliere Si o No? <span className="text-slate-300 dark:text-slate-600 mx-2">|</span> Simulatore a scopo puramente indicativo.</p>
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">Le aliquote fiscali e i tassi di cambio possono variare. Consultare un commercialista per decisioni ufficiali.</p>
        </div>
      </footer>
    </div>
  );
};

export default App;